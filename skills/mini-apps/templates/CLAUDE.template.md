# APP_NAME

<!-- Orientation + gotchas for future Claude Code sessions. Keep it short and true.
     Add every non-obvious thing you had to discover, with the symptom. -->

A private PWA for <who>. See `SPEC.md` for the data model, API contract and AI behaviour, and
`README.md` for local dev. This file is quick orientation + gotchas.

## Architecture

- `server/` Express 5 API (CommonJS), Firestore via ADC (no key file), <LLM provider>.
  - `server/auth.js`: bearer auth on every `/api/*` except `/api/health`; sets `req.uid`
    (shared `APP_TOKEN` → `owner`).
  - `server/db.js`: ALL Firestore access. Data lives under `COLLECTION_PREFIXusers/{uid}/...`;
    every accessor requires a uid.
  - `server/llm/*`: provider wrapper (retry once, safe errors, key redaction) and the shared
    context block.
  - `server/services/*`: AI features, chat agent, reflection. `server/routes/*`: thin.
- `client/` React 18 + Vite 5 + Tailwind 3 PWA, own `package.json`, built to `client/dist`.

One App Engine Standard service **`SERVICE_NAME`** in project `PROJECT_ID` (region `REGION`).
Other services in this project: <list them> — **never deploy to, stop or delete them**, and never
touch their Firestore collections.

## Commands

```bash
npm install                        # root deps only
npm run build                      # cd client && npm install --include=dev && npm run build
npm run dev:server                 # API + built client on :3002
npm run dev:client                 # Vite dev server, proxies /api to :3002
REFLECTION_ENABLED=false npm run dev:server
npm run test:api                   # non-LLM API smoke test (dev prefix only)
npm run deploy                     # gcloud app deploy app.yaml --project PROJECT_ID --quiet
```

Local `.env` (gitignored): `GOOGLE_CLOUD_PROJECT`, `COLLECTION_PREFIX=SERVICE_NAMEdev_`, `APP_TOKEN`,
LLM key/model vars, `PORT=3002`. Needs `gcloud auth application-default login` once.

## Deploy

Prod URL: **https://SERVICE_NAME-dot-PROJECT_ID.REGION_ID.r.appspot.com**

`app.yaml` is gitignored (real secrets); `app.yaml.example` is the template. After deploying:
`gcloud app services list` (other services untouched), `curl -I` on `/` shows `no-store`,
and `gcloud app logs read --service=SERVICE_NAME --project PROJECT_ID` is clean.

## Gotchas

- Root `build` must `cd client && npm install --include=dev` (Cloud Build sets
  `NODE_ENV=production`; Vite/Tailwind/PostCSS are devDependencies).
- `client/postcss.config.js` must exist, or the app deploys fine but renders unstyled.
- `index.html` must be served `no-store` and the service worker must be network-first for
  navigations, or returning users get a stale shell pointing at deleted asset files.
- Never call `db().collection()` directly; go through `db.js` (prefix + uid scoping).
- <add what you learn here, with the symptom>

## Production data

Prod prefix is `SERVICE_NAME_`. Triple-check the prefix before running any script that writes.
Back up (to gitignored `backups/`) before any migration.
