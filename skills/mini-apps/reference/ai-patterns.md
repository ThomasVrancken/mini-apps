# AI patterns

What the example apps actually do with LLMs, and the guards that made it reliable. Templates:
[`llm/openai.js`](../templates/server/llm/openai.js), [`llm/gemini.js`](../templates/server/llm/gemini.js),
[`llm/context.js`](../templates/server/llm/context.js),
[`services/chatAgent.js`](../templates/server/services/chatAgent.js),
[`services/reflect.js`](../templates/server/services/reflect.js).

## Provider choice

| | OpenAI (Responses API) | Vertex AI Gemini |
|---|---|---|
| Auth | API key in `.env` / `app.yaml` | ADC, no key; service account needs `roles/aiplatform.user` |
| Used in | Two Pans: generation, edits, ask, chat agent, reflection | Thoughtstream: ask-about-item with Google Search grounding, config rewrite agent, fallback generation job |
| Client | official `openai` npm package | plain `fetch` to the REST endpoint + `google-auth-library` for the token |
| Tool-calling agent | yes, proven | not implemented in these apps (Gemini supports function calling, but it's untested here) |

Default: OpenAI if the user has a key (strongest proven path for the chat agent); Vertex Gemini if
they want no keys at all or need Google Search grounding. Two model tiers from env: a main model for
user-facing generation and the agent, a fast one for background/classification work
(`OPENAI_MODEL=gpt-5.4`, `OPENAI_MODEL_FAST=gpt-5.4-mini` in Two Pans; check what's current).
`reasoning: { effort: 'low' }` unless quality demands more.

## The wrapper

- One retry on 5xx, timeouts and connection errors; SDK retries disabled so the policy lives in one
  place and total latency is bounded (150 s request timeout).
- Failures become `LLMError` with `status = 502` and a message safe for the UI
  ("the AI service is rate limited or out of credits"), never the raw provider body.
- `redact()` strips anything shaped like a key from logs and error messages.
- Log `label model ms in=… out=…` for every call: that's your cost dashboard.
- `response.status === 'incomplete'` (cut off) and refusals become explicit errors.

## Structured outputs (anything you store)

OpenAI strict JSON schema (`text.format: { type: 'json_schema', name, schema, strict: true }`):

- every object has `additionalProperties: false`;
- **every** property is listed in `required`; optional values are `type: ['string', 'null']`;
- enums are enforced by the schema, but validate again server-side anyway.

Gemini: `generationConfig.responseMimeType = 'application/json'` + `responseSchema` with upper-case
types (`OBJECT`, `STRING`, ...). Gemini 2.5 "thinking" tokens count against `maxOutputTokens`: give
document-rewriting calls a large budget (the newsfeed uses 32768).

Then **validate and normalize** in code: required fields, enums, limits, business rules (Two Pans
rejects recipes with more than 2 pans and strips seasoning filler like salt/oil/water). For batches,
**drop invalid items instead of failing the whole batch**.

## Shared context block

One function (`llm/context.js`) renders what every AI call needs: today's date and weekday in the
user's time zone (so "yesterday" resolves correctly), all preference fields labelled with their
field keys, recent history with ratings/notes, liked and disliked items with notes, and the current
items with ids (so the agent can reference them). Cap every list. Every feature (generation, edit,
ask, chat, reflection) gets the same block, so they never disagree about the facts.

## House style

Keep the domain rules the model must follow in one constant (`llm/style.js`, `HOUSE_STYLE` in Two
Pans) and include it in every prompt that produces content. When output feels off-brand, that is the
one file to edit. Give a compact example object of the target format. Be concrete: Two Pans
initially said "only things stocked at a regular supermarket" and still got specialty items until the
rule named mainstream brands explicitly and said to substitute anything exotic.

## Feature shapes that worked

- **Generate a batch** (`POST /generate {count, hint}`): context + house style + variety rules
  (spread formats/cuisines, avoid what was done in the last ~10 days and near-duplicates of current
  items) + the user's hint, which takes priority. One structured call returning an array.
- **Edit one item** (`POST /:id/ai-edit {instruction, asVariation}`): returns the full updated object
  + a one-sentence summary. The server preserves id, status, feedback and counters; the model only
  rewrites content. `asVariation` creates a new linked item instead of editing in place.
- **Ask about one item** (`POST /:id/ask {question, history}`): plain text answer, never mutates.
  The client keeps the Q&A thread in component state and resends prior turns as `history`. A small
  "apply this as a change" link can hand the answer to the edit flow.
- **Tiny classifier** (e.g. which supermarket aisle an item belongs to): fast model, strict enum
  schema, and **always fall back to a default** (`misc`) on any error so the user action never fails.
- **Grounded Q&A** (Gemini `tools: [{ googleSearch: {} }]`): grounding chunks come back as opaque
  `vertexaisearch.cloud.google.com` redirect links. Fine for showing citations; resolve the redirect
  before storing a URL as canonical.

## Autonomous chat agent (tool loop)

The feature that makes these apps feel magic: "we don't like mushrooms", "we cooked the curry with
coconut cream, it was great", "add milk to the list" just happen.

- Responses API function calling; tools are `strict: true` with the schema rules above.
- Loop: call → execute every `function_call` → send `function_call_output`s with
  `previous_response_id` → repeat, max **8 rounds**; on the last round set `tool_choice: 'none'` to
  force a text answer.
- Input: instructions + shared context + last ~20 chat messages (assistant turns annotated with
  `[actions taken: …]`) + the new message.
- Instructions: **be autonomous** (act, then say what you did in 1–3 sentences; never "shall I?";
  pick the sensible interpretation and mention the assumption), **only claim changes a tool actually
  made**, answer pure questions without mutating, reply in the user's language, plus a playbook
  mapping typical phrasings to tools (e.g. meal reports: find the item → optionally edit it → log it
  with a rating derived from sentiment and a date resolved from "last night").
- Tools call the **same service functions as the HTTP routes**, so behaviour is identical.
- Tool errors are returned to the model as `{ error }` (so it can fix arguments and retry), not thrown.
- Every successful mutation pushes an action chip `{ type, label, itemId? }` and flips a
  `changed.<area>` flag; the client refreshes exactly those views and shows the chips under the reply.
- If the loop fails after partial progress, return the chips with an apology instead of a 502, so the
  user sees what did happen. If it fails before any change, throw (nothing is stored; user can resend).
- Store the user message and assistant reply only after the run succeeds.

## Editing free-text preference docs safely

Both apps let an AI rewrite the user's own preference text. Guards that proved necessary:

- The model returns the **full replacement text** per field, instructed to copy verbatim and make a
  minimal targeted edit (add/adjust/remove one bullet; edit a contradicting bullet instead of adding a
  conflicting one; match the strength of the wish: "less X" is a soft bullet, "never X" a hard one).
- **Shrink guard:** refuse if a field would drop below 40% (Two Pans) / 50% (newsfeed) of its length.
  Models sometimes return only the new bullet; the refusal message tells the agent to resend the full
  text, and it does.
- **URL preservation guard** (newsfeed): every URL in the original must appear byte-for-byte in the
  result (observed: a nearby edit silently changed `theverge.com` to `verge.com`).
- Max length per field; empty/missing fields rejected.
- Snapshot every change to history with `updatedBy` and a short summary; the newsfeed also offers
  one-step undo from that history.
- The agent leaves the `learned` field alone unless explicitly asked.

## Learning loop (feedback → reflection)

- Feedback events: thumbs up/down (with optional note), "cooked/done" with a rating, things logged via
  chat. Each increments `meta/counters.feedbackSinceReflection` in a transaction.
- At ≥ 3, a transactional "claim" resets the counter (so concurrent requests can't both start a
  run) and a background pass runs with the fast model. It never blocks the response and never throws.
- Reflection rewrites **only** the `learned` field: max ~15 one-line bullets of patterns actually
  supported by the data (a thumbs-down with a note is a strong signal, one silent dismissal isn't);
  keep still-valid bullets, drop contradicted ones, don't restate other fields. Enforce the bullet
  format and length in code.
- `REFLECTION_ENABLED=false` switches it off for tests.

## Content pushed in by an agent (ingest)

When a scheduled LLM job writes into the app (newsfeed `POST /api/ingest`), assume a confused run,
not an attacker: cap batch size (50), field lengths, URLs per item, URL length, require
`http(s)://` (and `https://` for images). Do **authoritative dedup server-side**. Dedup key lesson:
canonical URL **and** normalized title together; URL-only keying collapsed 9 of 16 distinct stories
that shared one newsletter-digest URL. Return `{ acceptedCount, rejectedCount, rejected: [{reason}] }`.

## Cost control

- Fast model + low effort for background work; main model only where quality is visible.
- Per-user daily quotas once other people use the app (newsfeed members: 40 asks/day, 20 config
  edits/day; owner unlimited), counted in a transaction **before** the LLM call
  ([`quota.js`](../templates/server/quota.js)).
- Client timeouts ≥ 120 s on AI calls; show a friendly loading state (generation takes 20–40 s).
- Tests (`scripts/api-test.js`) only hit non-LLM endpoints and run with reflection off.
