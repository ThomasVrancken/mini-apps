# APP_NAME (spec)

<!--
The contract every agent builds against. Backend and frontend subagents work
in parallel from THIS file, so be concrete: field names, response shapes,
status codes. Keep it updated when behaviour changes.
-->

One paragraph: what this app is, who uses it (e.g. "me and my partner, sharing the same data"),
from where (installed PWA on our phones). **Core loop:** step → step → step → the app learns.

## Stack & layout

- Node 22, Express 5 API (CommonJS) + React 18 / Vite 5 / Tailwind 3 PWA client (own
  `package.json` in `client/`, built to `client/dist`, served by Express).
- One App Engine Standard service **`SERVICE_NAME`** in GCP project `PROJECT_ID`, region
  `REGION` (must match the existing Firestore location). URL:
  `https://SERVICE_NAME-dot-PROJECT_ID.REGION_ID.r.appspot.com`.
  Never touch other services in the project.
- Firestore `(default)` database. **All data is per user:** `COLLECTION_PREFIXusers/{uid}/...`.
  `COLLECTION_PREFIX` = `SERVICE_NAME_` in prod, `SERVICE_NAMEdev_` locally.
  **No queries that need composite indexes**: fetch and filter/sort in memory.
- Auth tier: **shared token** (`APP_TOKEN` → uid `owner`) | invite tokens | Firebase Auth.
  Every route reads data only via `req.uid`.
- LLM: OpenAI Responses API (`OPENAI_MODEL` main, `OPENAI_MODEL_FAST` background) |
  Vertex Gemini via ADC. Structured outputs (strict JSON schema) for anything the app stores.
- Secrets: `.env` locally, `app.yaml` in prod (both gitignored; `app.yaml.example` committed).

```
SERVICE_NAME/
  SPEC.md README.md CLAUDE.md package.json app.yaml.example .gcloudignore .gitignore
  server/
    index.js  auth.js  db.js  http.js
    llm/openai.js  llm/context.js
    services/chatAgent.js  services/reflect.js  services/<feature>.js
    routes/*.js
  client/   (Vite app)
  scripts/api-test.js
```

## Data model (Firestore, under `COLLECTION_PREFIXusers/{uid}`)

`users/{uid}`: `{ role: 'owner'|'member', displayName, disabled, createdAt }`

`users/{uid}/config/preferences`:
```
{ about: string, likes: string, dislikes: string, learned: string,
  updatedAt, updatedBy: 'seed'|'user'|'chat'|'reflection' }
```
Free-text markdown bullets. Every change appends a snapshot to `users/{uid}/preferencesHistory`
`{ fields, changedFields, summary, updatedBy, createdAt }`.

Seed values (written once per uid if missing):
- **about**: - ...
- **likes**: - ...
- **dislikes**: - ...
- **learned**: `""` (maintained by the app)

`users/{uid}/items/{id}`:
```
{ id, title, notes|null, status: 'active'|'archived',
  feedback: 'up'|'down'|null, feedbackNote: string|null, createdAt, updatedAt }
```

`users/{uid}/chat/{id}`: `{ id, role: 'user'|'assistant', text, actions: [{ type, label, itemId? }], createdAt }`

`users/{uid}/meta/counters`: `{ feedbackSinceReflection: number, lastReflectionAt }`

## HTTP API

JSON. All `/api/*` need `Authorization: Bearer <token>` except `/api/health`.
Errors: `{ error: string }` with a sensible status. LLM calls may take 10–60 s.

| Method & path | Body | Returns |
|---|---|---|
| GET `/api/health` | | `{status:'ok'}` |
| GET `/api/me` | | `{ok:true, uid, role}` |
| GET `/api/items?status=active\|archived` | | `{items}` newest first |
| GET `/api/items/:id` | | `{item}` |
| POST `/api/items` | `{title, notes?}` | `{item}` (201) |
| PATCH `/api/items/:id` | any of `title, notes, status, feedback, feedbackNote` | `{item}` |
| DELETE `/api/items/:id` | | `{ok:true}` |
| GET `/api/preferences` | | `{preferences}` |
| PUT `/api/preferences` | subset of the fields | `{preferences}` |
| GET `/api/preferences/history` | | `{changes}` last 20 |
| GET `/api/chat` | | `{messages}` last 60, oldest first |
| POST `/api/chat` | `{message}` | `{messages:[user, assistant], changed:{items, preferences}}` |
| DELETE `/api/chat` | | `{ok:true}` |

## AI behaviour

### Shared context (`llm/context.js`)
Every AI call gets: today's date (time zone), all preference fields (labelled with their field key),
recent items, liked/disliked items with notes.

### <Feature> (`services/<feature>.js`)
What it produces, the rules, the output schema, validation (drop invalid items rather than fail the batch).

### Chat agent (`services/chatAgent.js`)
Tool-using loop (max 8 rounds), **autonomous** (acts, then briefly says what it did; never "shall I?").
Tools: `list_items`, `create_item`, `update_item`, `set_feedback`, `update_preferences` (full
replacement text, minimal targeted edit, refused if a field shrinks below 40%), ...
Each successful mutation adds an action chip and flips a `changed` flag.

### Learning (`services/reflect.js`)
Feedback events increment a per-user counter; at ≥ 3, rewrite `learned` in the background with the
fast model (max 15 bullets). Never touches the other fields.

## UX (mobile-first PWA)

App name **APP_NAME**, emoji icon (PNG icons 32/180/192/512). Look & feel: ...
Respect safe-area insets. Fixed bottom tab bar:

1. **Tab 1** (default): ...
2. **Chat**: conversation with the agent, quick-prompt chips when empty, action chips under replies,
   typing indicator, refresh affected data from `changed`, "New conversation".
3. **Prefs**: the preference fields as textareas, Save, "or just tell the chat", recent changes list.

Auth: access-code gate (token in localStorage). `/?code=<APP_TOKEN>` logs in and strips the param.
Client HTTP timeout ≥ 120 s for AI calls. Service worker: navigations network-first, hashed assets
cache-first, API GETs network-first with cache fallback, never cache mutating calls.
`index.html`, `sw.js`, `manifest.webmanifest` served `Cache-Control: no-store`.
