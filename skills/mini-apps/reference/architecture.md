# Reference architecture

The shape both example apps share: a newsfeed ("Thoughtstream") and a couple's meal planner
("Two Pans"). Everything here is running in production unless marked otherwise.

## The picture

```
 Phone (installed PWA)                    Google Cloud project
 ┌──────────────────────┐   HTTPS   ┌─────────────────────────────────────────────┐
 │ React + Vite + TW    │ ────────▶ │ App Engine Standard service (nodejs22, F1)  │
 │ access-code gate     │  Bearer   │  Express: /api/* (auth) + client/dist       │
 │ service worker       │           │   ├─ db.js ───────────▶ Firestore           │
 └──────────────────────┘           │   └─ llm/*  ──────────▶ OpenAI / Vertex AI  │
                                    └─────────────────────────────────────────────┘
 Optional scheduled job ── GET /api/<context>, POST /api/ingest (same bearer) ──┘
 (Claude Code cloud routine, or Cloud Scheduler → Cloud Function)
```

One process serves both the API and the built SPA, so there is one URL, one deploy, no CORS,
and no separate static host.

## Folder layout

```
<app>/
  SPEC.md            the contract (data model, API table, AI behaviour, UX)
  CLAUDE.md          orientation + gotchas for future sessions
  README.md          human setup notes
  package.json       root: server deps + build/deploy scripts
  app.yaml.example   committed template; app.yaml is gitignored (secrets)
  .gcloudignore  .gitignore  .env (gitignored)
  server/
    index.js         express app, /api mount, static client, SPA fallback, error handler
    auth.js          bearer auth → req.uid
    db.js            ALL Firestore access (prefix + uid scoping)
    http.js          HttpError, validators, redaction
    llm/openai.js    provider wrapper (or llm/gemini.js)
    llm/context.js   shared context block for every AI call
    llm/style.js     (optional) the "house style" rules shared by every prompt
    services/*.js    AI features, chat agent, reflection, deterministic logic
    routes/*.js      thin: validate, call services/db with req.uid
  client/
    package.json     own deps (Vite/Tailwind/PostCSS are devDependencies)
    index.html  vite.config.js  tailwind.config.js  postcss.config.js
    public/manifest.webmanifest  public/sw.js  public/icons/*.png
    src/main.jsx  src/App.jsx  src/services/api.js  src/components/...
    src/context/DataContext.jsx   (optional) shared data so a chat mutation refreshes every tab
  scripts/
    api-test.js      non-LLM API smoke test (refuses to run against prod)
```

Templates for most of these live in [`../templates/`](../templates/).

## Layers and rules

**Server (CommonJS, Express 5).** Express 5 forwards errors thrown in async handlers to the error
handler, so routes can simply `throw badRequest(...)`. (The newsfeed runs Express 4 with try/catch
in each route; if you use Express 4, the SPA wildcard is `'*'` instead of `'/{*splat}'`.)

- `/api/health` is the only unauthenticated route; everything else goes through `requireAuth`.
- Unknown `/api/*` → JSON 404 (never the SPA HTML).
- Errors → `{ error }`; 5xx messages are generic, stacks are logged with secrets redacted.
- Refuse to start without `COLLECTION_PREFIX`.
- Seed data idempotently at startup (in a transaction), and lazily on first read as a fallback,
  without crash-looping on a transient Firestore error.

**Data (Firestore Native, `@google-cloud/firestore`, ADC).**

- **User-ready by default:** all app data lives under one owner scope,
  `<prefix>users/{uid}/<collection>/{id}`. Every accessor takes a required uid; there are no
  global accessors. The shared token maps to the fixed uid `owner` (a household shares it). Adding
  invite tokens or Firebase Auth later only changes how `req.uid` is resolved. See
  [users-and-auth.md](users-and-auth.md).
- **Prefix every root collection** with `COLLECTION_PREFIX` when the `(default)` database is shared
  with other apps in the project (`<service>_` in prod, `<service>dev_` locally). The prefix is the
  only guard against collisions: there is no schema-level protection.
- **No composite indexes.** Personal data volumes are tiny: one equality filter or one single-field
  `orderBy` per query, then filter/sort in memory. (The newsfeed does use one composite index,
  status + createdAt, created by its setup script; the meals app avoided them entirely, which is
  simpler: nothing to create before the first deploy.)
- ISO-string timestamps sort correctly as strings and serialize cleanly to the client.
- Free-text "preferences" docs (markdown bullets) plus a `preferencesHistory` snapshot on every
  change (`updatedBy: seed|user|chat|reflection`). Humans and the AI edit the same text.
- Batched deletes in chunks of 400 (Firestore caps a batch at 500 writes).
- Transactions for counters and "claim" operations (e.g. start a reflection run exactly once).

**Legacy shape (honest note).** The meals app predates the user-ready rule: it uses flat prefixed
collections (`meals_recipes`, `meals_config/preferences`, ...). It works fine for one household.
To migrate such an app: write a one-off script that copies each `<prefix><name>` collection to
`<prefix>users/owner/<name>`, back everything up to a gitignored `backups/` folder first, keep the
old collections untouched as a rollback, switch `db.js` to uid-scoped accessors, then delete the
old data only after a verified deploy. The newsfeed did exactly this when it went multi-user
(copy to `users/owner/...`, originals left as a frozen backup).

**LLM layer.** A thin wrapper per provider (retry once on 5xx/timeouts, safe user-facing errors as
HTTP 502, key redaction, token-usage logging), a shared context builder that every AI call uses,
strict structured outputs for anything stored. See [ai-patterns.md](ai-patterns.md).

**Client (React 18, Vite 5, Tailwind 3).** Mobile-first, fixed bottom tab bar, bottom sheets for
detail views, one axios client with a 15 s default timeout and 120 s for AI calls, a shared data
context so a mutation anywhere (including from chat) refreshes the other tabs. See [pwa.md](pwa.md).

**Deploy.** App Engine Standard, one named service per app, `min_instances: 0`,
`max_instances: 1` (meals) or 2 (newsfeed), `instance_class: F1`. The buildpack runs the root
`npm install` and root `build` script only. See [gcp-setup.md](gcp-setup.md).

## The two example apps side by side

| | Two Pans (meals) | Thoughtstream (newsfeed) |
|---|---|---|
| Users | a couple, one shared token | owner + invited friends (invite tokens) |
| Data shape | flat prefixed collections (legacy) | `users/{uid}/...` |
| LLM | OpenAI Responses API, `gpt-5.4` + `gpt-5.4-mini` | Vertex Gemini 2.5 Flash via ADC |
| AI features | batch generation, edit one item, ask about one item, autonomous chat agent, reflection | ask about an item (Google Search grounding), plain-language edits of 3 config docs |
| Scheduled job | none | Claude Code cloud routine (primary) + Cloud Function fallback, both POST to `/api/ingest` |
| App Engine service | named service (`meals`) next to `default` | `default` (first app in the project) |
| Express | 5 | 4 |

## What "done" looks like

- `SPEC.md` matches the code.
- `npm run test:api` passes against a local dev server with a dev prefix.
- Deployed; `curl -I https://<url>/` shows `cache-control: no-store`; `/api/health` is 200;
  `/api/me` without a token is 401.
- Other App Engine services in the project untouched (`gcloud app services list`).
- The user has a `/?code=` link (sent privately, never committed) and installed the PWA.
- `CLAUDE.md` lists the architecture, commands, prod URL and every gotcha found.
