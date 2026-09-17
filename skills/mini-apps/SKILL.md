---
name: mini-apps
description: >-
  Build, deploy and iterate on a personal "mini app": a single-purpose, mobile-first PWA
  (React + Vite + Tailwind) with a small Node/Express API on Google Cloud App Engine, Firestore,
  a shared-token login (user-ready for invites or Firebase Auth), and an LLM layer with an
  autonomous chat agent that learns from feedback. Use when the user asks to build, create,
  scaffold or deploy a "mini app", a personal app, a private/household app, a PWA for their
  phone, an AI-powered tool just for them (or their partner/friends), or says "use the
  mini-apps skill".
---

# Mini apps

A mini app is personal software someone uses every day: one job, one small codebase, installed on
their phone, costing about $0–5/month. This playbook is distilled from two production apps (a
learning newsfeed and a couple's meal planner). Follow it; deviate only with a reason.

Supporting files (read when you reach that step):

- [reference/architecture.md](reference/architecture.md): the reference architecture and layout
- [reference/gcp-setup.md](reference/gcp-setup.md): one-time GCP setup, deploy, verify, budgets, Cloud Run alternative
- [reference/ai-patterns.md](reference/ai-patterns.md): structured outputs, chat agent loop, preference editing guards, reflection
- [reference/pwa.md](reference/pwa.md): manifest, icons, iOS meta, service worker, login UX
- [reference/users-and-auth.md](reference/users-and-auth.md): the three login tiers, migrating flat data
- [reference/firebase-auth.md](reference/firebase-auth.md): tier 3, self sign-up (not yet battle-tested)
- [reference/scheduled-jobs.md](reference/scheduled-jobs.md): daily generation via Claude routines or Cloud Functions
- [templates/](templates/): copy-ready starter files (placeholders `PROJECT_ID`, `SERVICE_NAME`, `APP_NAME`, `REGION`, `REGION_ID`)

## 1. Intake (keep it short)

Ask these in one message. If the user wants you to run autonomously, or already answered in their
brain-dump, use the defaults and state them in the SPEC instead of asking.

| Question | Default |
|---|---|
| What problem does it solve? What's the **core loop** (the thing they'll do every day)? | Derive from their description |
| **Who will use it?** Just me / me + household → shared token. A few invited friends → invite tokens. Anyone who signs up → Firebase Auth. | Shared token, always user-ready |
| What data does it keep? What should it remember and learn? | One main entity + free-text preferences + feedback |
| What should the AI do? (generate, edit, answer questions, chat that changes things, learn) | Chat agent + one generation feature + reflection |
| Anything scheduled (daily digest, weekly plan)? | None |
| Which GCP project? Existing App Engine app / Firestore in it? | Inspect with gcloud (read-only) and report |
| LLM provider and where the key lives? | OpenAI, key in a local `.env` the user points you to; Vertex Gemini if they want no keys |
| App name, emoji, look & feel? | Pick a friendly name + emoji, light warm theme |
| GitHub: repo name, private? | Private repo under the user's `gh` account |

Never ask the user to paste a key into chat. Ask for the **path** of the file that holds it and
read it only into files that are gitignored.

## 2. Reference architecture

```
Phone PWA ──HTTPS, Bearer token──▶ App Engine Standard service (nodejs22, F1, scale to zero)
(React+Vite+Tailwind,               Express: /api/* + serves client/dist
 access-code gate, SW)                ├─ db.js ─▶ Firestore  <prefix>users/{uid}/...
                                      └─ llm/  ─▶ OpenAI Responses API | Vertex Gemini (ADC)
Optional: scheduled job ─▶ GET /api/<context>, POST /api/ingest (same token)
```

Core rules:

1. **One service serves API + SPA.** `/api/health` is the only public route.
2. **User-ready by default.** All data under `<prefix>users/{uid}/<collection>`; every `db.js`
   accessor takes a required `uid`; `requireAuth` sets `req.uid`; routes never read data without it.
   The shared `APP_TOKEN` maps to the fixed uid `owner` (a household shares it). Preferences and
   seeding are per uid.
3. **Prefix every root collection** (`COLLECTION_PREFIX`, `<service>_` prod, `<service>dev_` local);
   the server refuses to start without it.
4. **No composite indexes.** One equality filter or one single-field `orderBy`, then filter in memory.
5. **Preferences are free-text docs** (markdown bullets) that the user, the chat agent and the
   reflection pass all edit, with a history snapshot on every change.
6. **Structured outputs** for anything stored; validate again in code; drop invalid batch items.
7. **Secrets** only in gitignored `.env` / `app.yaml`; commit `app.yaml.example`.
8. **SPEC.md is the contract**; **CLAUDE.md holds the gotchas**; `scripts/api-test.js` guards the API.

Layout (details in [architecture.md](reference/architecture.md)):

```
<app>/  SPEC.md CLAUDE.md README.md package.json app.yaml.example .gcloudignore .gitignore .env.example
  server/  index.js auth.js db.js http.js quota.js  llm/{openai,gemini,context}.js
           services/{chatAgent,reflect,<feature>}.js  routes/*.js
  client/  package.json index.html vite/tailwind/postcss configs  public/{manifest.webmanifest,sw.js,icons/}
           src/{main.jsx,App.jsx,index.css,services/api.js,components/,context/}
  scripts/ api-test.js make-icons.py
```

## 3. Build process

### 3.0 Prepare

- For long autonomous runs on macOS, keep the Mac awake for the session:
  `caffeinate -dims -t 14400 &` (4 h; kill it when done).
- If the target folder is an existing repo: `git fetch` and check `git status` for "behind" first.
- Check tools: `node -v` (22+), `gh auth status`, `gcloud auth list`,
  `gcloud auth application-default print-access-token >/dev/null && echo ADC ok`.

### 3.1 Inspect GCP (read-only)

Run the inspection block in [gcp-setup.md §0](reference/gcp-setup.md#0-inspect-always-before-creating-anything).
Record: Firestore location, App Engine region (or none), existing services. Decide the service name
(`default` if no App Engine app exists yet, else a new name) and the prefix. Enable missing APIs and
create missing resources only for this app (§1–4). Never modify other services.

### 3.2 Write SPEC.md first

Start from [templates/SPEC.template.md](templates/SPEC.template.md). Fill in: purpose and core loop,
users and auth tier, stack and URL, data model with exact field names and seed preference text
(write real, specific seed bullets from the user's brain-dump), the full HTTP API table with bodies
and response shapes, AI behaviour per feature (rules, schema, validation), the chat agent's tools and
playbook, the learning loop, and the UX per tab. Be concrete: two agents will build against it
without talking to each other. In an interactive session, show a short summary and proceed unless
the user objects.

### 3.3 Create the repo

```bash
mkdir <app> && cd <app> && git init -b main
cp -R <this skill>/templates/. .        # then rename SPEC.template.md → SPEC.md, CLAUDE.template.md → CLAUDE.md
# replace PROJECT_ID / SERVICE_NAME / APP_NAME / REGION / REGION_ID everywhere
cp .env.example .env                    # fill in; generate APP_TOKEN with openssl rand -hex 32
git add -A && git commit -m "Add spec and scaffold"
gh repo create <app> --private --source . --remote origin --push
```

Provider choice: with OpenAI, delete `server/llm/gemini.js`; with Vertex Gemini, `npm install
google-auth-library`, remove `openai`, and port `chatAgent.js`/`reflect.js` to `callGeminiJSON`
(the tool-calling agent is only proven on OpenAI). Delete `auth.firebase.js` and `client/src/auth/`
unless you use tier 3.

Check `git status` before every commit: `.env`, `app.yaml`, `backups/` must never appear.

### 3.4 Build in parallel (you coordinate, subagents implement)

Launch two subagents **in the same message** (use an orchestrator skill if available). Give each
the SPEC path, its folder, the templates it starts from, and these instructions:

- **Backend** (`server/`, `scripts/api-test.js`, root `package.json`): implement every route and
  service in SPEC.md on top of the templates; all data via `db.js` with `req.uid`; strict schemas
  for every LLM output; chat agent with the SPEC's tools; reflection; extend `api-test.js` to cover
  every non-LLM endpoint; run the server against the **dev prefix** and make `npm run test:api` pass.
  Don't touch `client/`. Report the exact request/response shapes it implemented.
- **Frontend** (`client/`): implement the UX in SPEC.md on the client templates; mobile-first,
  bottom tab bar, sheets, loading states for AI calls, shared data context with `applyChanged`,
  PWA files, icons via `scripts/make-icons.py`; build a throwaway mock server (`client/dev/`) from
  the SPEC's API table to develop against; `npm run build` must pass. Don't touch `server/`.

Meanwhile you: prepare `app.yaml` from the example (never echo secrets), and review both reports.

### 3.5 Integrate

Run the real server (`npm run build && npm run dev:server`, dev prefix) and walk the entire core
loop through the API and, if possible, the UI. The seam most likely to drift is
`client/src/services/api.js` vs `server/routes/*.js`: diff call shapes, field names, status codes.
Make real LLM calls for each AI feature at least once and read the outputs critically against the
house style. Fix, re-run `npm run test:api`, commit.

A third subagent can own integration + deploy if context is getting large; give it this section and
§3.6.

### 3.6 Deploy and verify live

`npm run deploy`, then run the verification block in
[gcp-setup.md §7](reference/gcp-setup.md#7-verify-every-deploy): health 200, `/api/me` 401 without
a token, `no-store` on `/` and `/sw.js`, authenticated calls work, other services untouched, logs
clean. Generate a first batch of real content in prod so the app doesn't open empty.

### 3.7 Document and hand over

- Update `CLAUDE.md` (architecture, commands, prod URL, other services to never touch, every gotcha
  you hit with its symptom) and `README.md` (local dev + deploy). Commit and push.
- Give the user the URL and the install steps (Safari → Share → Add to Home Screen). For the magic
  link, don't print the token in chat; let them copy it locally:
  `printf '%s/?code=%s\n' "$URL" "$(grep '^APP_TOKEN=' .env | cut -d= -f2-)" | pbcopy`
- Summarize: what was built, what's verified, what isn't (e.g. logged-in browser flow), cost
  expectations, and 3 suggested next iterations.

### 3.8 Iterate

Users give feedback in small rounds ("add a shopping list sorted by my supermarket's aisle order").
For each round: update SPEC.md → implement (subagents only if it's big) → test → deploy → verify →
update CLAUDE.md → commit. Prefer changing prompts/house style over code when the complaint is about
AI output. Back up prod data before any migration (§ gotchas).

## 4. Gotchas (all hit for real)

**App Engine**
- The first service ever deployed to a new App Engine app must be `default`; a custom `service:`
  fails. Later apps are named services at `https://<service>-dot-<project>.<region-id>.r.appspot.com`.
- The App Engine region is permanent and must match the existing Firestore location
  (`eur3` ↔ `europe-west`, `nam5` ↔ `us-central`).
- Right after Firestore provisioning, `gcloud app describe` can 404 while `gcloud app create` says
  the app already exists. Trust `create`.
- The buildpack runs only the root `npm install` / `npm run build`. The root build must be
  `cd client && npm install --include=dev && npm run build` (Cloud Build sets `NODE_ENV=production`
  and Vite/Tailwind/PostCSS are devDependencies).
- `runtime: nodejs22` (nodejs20 is past end of support). No `resources:` block on Standard (Flex
  only); use `instance_class: F1`.
- `gcloud app deploy` uploads only the directory with `app.yaml` (minus `.gcloudignore`). Anything
  the server reads (seed/config files) must live inside it; files one level up are silently missing.
- Deploying is required for changes to be live; scheduled jobs always hit the deployed version.
- LLM requests of 20–65 s ran fine on automatic scaling; set client timeouts to 120 s.
- **Never deploy to, stop, or delete other services**, and never touch their Firestore collections.
  After every deploy, `gcloud app services list` must show them unchanged.

**Frontend / PWA**
- `client/postcss.config.js` must exist. Without it the build succeeds and the app is unstyled.
  Keep Tailwind on v3 (v4 needs a different setup).
- Serve `index.html`, `sw.js`, `manifest.webmanifest` with `Cache-Control: no-store` (static
  middleware **and** SPA fallback); the service worker must be network-first for navigations.
  Otherwise returning users get a blank app after a redeploy ("text/html is not a valid JavaScript
  MIME type"). `curl` may not reveal it; a real browser does.
- Missing files with an extension must 404, not fall through to the SPA HTML.
- Express 5 SPA wildcard is `'/{*splat}'` (Express 4: `'*'`).
- Clear the service worker's API cache on token change / sign-out.
- `/?code=` must be stripped from the URL immediately after reading it.

**Data**
- Always go through `db.js` (`userCol(uid, name)`); never `db().collection()` elsewhere.
- Seeding writes only missing docs/fields; Firestore is the live source of truth. Editing seed text
  in code does not change prod.
- Before any script that writes prod data: triple-check the prefix, back up to gitignored `backups/`,
  support `--dry-run`, and require an explicit flag (e.g. `--yes-prod`) for the prod prefix.
- Read-time normalization of old enum values keeps unmigrated docs from crashing the app.
- Dedup of LLM-ingested items: canonical URL **and** normalized title (URL alone collapses distinct
  stories that share a digest page).
- The Firestore emulator needs a Java runtime (`brew install openjdk`).

**Security & process**
- Never print, log or commit secrets. `app.yaml` and `.env` are gitignored; redact `sk-…` in logs;
  generic 5xx messages to clients.
- Agent-driven browser tests that log in with the shared token may be blocked by the sandbox as
  credential use. Verify via API + build, and ask the user to click through on their phone.
- Shell: `TOKEN=x cmd "$TOKEN"` does not expand `$TOKEN` in the same command. Assign first.
- Be concrete in prompts: vague rules ("regular supermarket items") drift; name examples/brands and
  say what to substitute.
- After parallel builds, the client/server contract is the seam to check first.

## 5. Cost guardrails

- `min_instances: 0`, `max_instances: 1` (2 at most), `instance_class: F1`: App Engine and Firestore
  free tiers cover personal use.
- Main model only for user-visible quality; fast model + low reasoning effort for background work;
  log token usage on every call; no LLM calls in automated tests (`REFLECTION_ENABLED=false`).
- Reflection only every N feedback events (3), never per request.
- Per-user daily quotas on LLM routes as soon as anyone besides the owner uses the app
  ([templates/server/quota.js](templates/server/quota.js)).
- A project budget with alerts (e.g. €5/month at 50/100/150%) and a monthly limit on the LLM
  provider account. See [gcp-setup.md §8](reference/gcp-setup.md#8-cost-guardrails).
- Scheduled jobs: prefer a Claude Code routine on the existing subscription; a Cloud Function
  fallback should skip itself when fresh content already exists.

## 6. Upgrading logins later

Tier 2 (invite links, per-user hashed tokens, kill switch, quotas) and tier 3 (Firebase Auth) only
replace `server/auth.js` and add a client screen, because the data is already uid-scoped. Follow
[users-and-auth.md](reference/users-and-auth.md) and
[firebase-auth.md](reference/firebase-auth.md) (tier 3 is not yet battle-tested: verify every step
and record findings in the app's CLAUDE.md).

Cloud Run is a possible alternative host (containers, long requests, WebSockets) but is not yet
battle-tested in these apps; App Engine Standard is the default. See
[gcp-setup.md](reference/gcp-setup.md#alternative-cloud-run-not-yet-battle-tested-in-these-apps).
