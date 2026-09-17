# Google Cloud setup

One-time project setup, deploy, verification, and cost guardrails. Replace `PROJECT_ID`,
`SERVICE_NAME`, `REGION` (App Engine region, e.g. `europe-west`) and `LOCATION` (Firestore location,
e.g. `eur3`). Read before you write: **inspect first, create only what is missing, never modify or
delete resources that belong to other apps in the project.**

## 0. Inspect (always, before creating anything)

```bash
gcloud auth list                                   # which account is active
gcloud config get-value project
gcloud projects describe PROJECT_ID --format="value(projectId,projectNumber)"
gcloud billing projects describe PROJECT_ID --format="value(billingEnabled)"
gcloud services list --enabled --project PROJECT_ID
gcloud firestore databases list --project PROJECT_ID   # existing DB + its location
gcloud app describe --project PROJECT_ID                # existing App Engine app + region
gcloud app services list --project PROJECT_ID           # existing services: never touch them
```

Decide from this:

- **Firestore exists?** Reuse the `(default)` database with a `COLLECTION_PREFIX`.
- **App Engine app exists?** Its region is fixed forever. Deploy as a new named service.
- **No App Engine app yet?** Your first service must be named `default`.
- **App Engine region must match the Firestore location** when both exist. The pairs are
  multi-region equivalents: Firestore `eur3` ↔ App Engine `europe-west`, Firestore `nam5` ↔
  App Engine `us-central`. (Both example apps: `eur3` + `europe-west`.)

## 1. Enable APIs

```bash
gcloud services enable \
  appengine.googleapis.com \
  firestore.googleapis.com \
  cloudbuild.googleapis.com \
  --project PROJECT_ID

# Only if you use Vertex AI Gemini:
gcloud services enable aiplatform.googleapis.com --project PROJECT_ID
# Only for scheduled jobs:
gcloud services enable cloudfunctions.googleapis.com run.googleapis.com cloudscheduler.googleapis.com --project PROJECT_ID
# Only for budgets from the CLI:
gcloud services enable billingbudgets.googleapis.com --project PROJECT_ID
```

## 2. App Engine app (skip if it exists)

```bash
gcloud app create --region=REGION --project PROJECT_ID     # PERMANENT region choice
```

Gotcha: right after Firestore Native mode is provisioned, a project can have a hidden App Engine
application that `gcloud app describe` reports as missing (404) while `gcloud app create` says
"already contains an App Engine application". Trust `create`: treat that message as success.

## 3. Firestore (skip if it exists)

```bash
gcloud firestore databases create --location=LOCATION --type=firestore-native --project PROJECT_ID
```

No indexes needed if you follow the no-composite-index rule.

## 4. IAM

App Engine runs as `PROJECT_ID@appspot.gserviceaccount.com` and uses it via ADC.

```bash
SA="serviceAccount:PROJECT_ID@appspot.gserviceaccount.com"

# Vertex AI (Gemini) calls:
gcloud projects add-iam-policy-binding PROJECT_ID --member="$SA" --role="roles/aiplatform.user"

# Only if Firestore calls fail in prod with PERMISSION_DENIED (newer projects may not give the
# default service account a broad role automatically):
gcloud projects add-iam-policy-binding PROJECT_ID --member="$SA" --role="roles/datastore.user"
```

Locally, run `gcloud auth application-default login` once; your own account needs the same access.
If a deploy fails with a permissions error on a brand-new project, read the error: it names the
service account and the missing role.

## 5. Secrets

- Locally: `.env` in the repo root (gitignored).
- Prod: `app.yaml` `env_variables` (gitignored), generated from `app.yaml.example`.
  Generate the token with `openssl rand -hex 32` and write it straight into the files; don't echo it
  into logs or chat.
- Upgrade path if you want it: Secret Manager, read at startup. The example apps use gitignored
  `app.yaml` and it has been fine for personal use; anyone with Viewer access on the project can
  see App Engine env vars, so keep the project to yourself.

## 6. Build and deploy

The root `package.json` must contain:

```json
"build": "cd client && npm install --include=dev && npm run build",
"deploy": "gcloud app deploy app.yaml --project PROJECT_ID --quiet"
```

```bash
cp app.yaml.example app.yaml   # fill in secrets
npm run build                  # local sanity check (Cloud Build runs it again)
npm run deploy
```

Why the build script looks like that: the App Engine Node.js buildpack only runs `npm install` and
`npm run build` at the root; it never enters `client/`. Cloud Build sets `NODE_ENV=production`, so a
plain `npm install` skips devDependencies, and Vite, Tailwind and PostCSS are all devDependencies.

`app.yaml` essentials (see [`../templates/app.yaml.example`](../templates/app.yaml.example)):
`runtime: nodejs22` (nodejs20 is past end of support), `service: SERVICE_NAME` (or `default` for the
very first service), `instance_class: F1`, `automatic_scaling` with `min_instances: 0` and a low
`max_instances`. **No `resources:` block**: that is App Engine Flex only; Standard rejects it.

Long requests are fine: App Engine Standard automatic scaling served 20–65 s LLM requests in the
meals app without hitting a platform timeout.

## 7. Verify (every deploy)

```bash
URL=$(gcloud app browse --service=SERVICE_NAME --no-launch-browser --project PROJECT_ID)
echo "$URL"          # https://SERVICE_NAME-dot-PROJECT_ID.<region-id>.r.appspot.com
curl -s "$URL/api/health"                         # {"status":"ok"}
curl -s -o /dev/null -w "%{http_code}\n" "$URL/api/me"   # 401
curl -sI "$URL/" | grep -i cache-control          # no-store
curl -sI "$URL/sw.js" | grep -i cache-control     # no-store
gcloud app services list --project PROJECT_ID     # other services still there, untouched
gcloud app logs read --service=SERVICE_NAME --project PROJECT_ID --limit=50
```

The URL of a named service is `https://SERVICE-dot-PROJECT_ID.<region-id>.r.appspot.com`
(`<region-id>` is a short code, `ew` for europe-west); the `default` service is
`https://PROJECT_ID.<region-id>.r.appspot.com`.

Then test with an authenticated call (read the token from `.env` inside the command, never print
it), and ideally load the real UI in a browser. Browser automation that logs in with the shared
token may be blocked by the agent sandbox, which treats it as a credential; if so, ask the user to
do the click-through, and verify via the API and a production build meanwhile.

Shell gotcha: `TOKEN=x cmd "...$TOKEN..."` does **not** expand `$TOKEN` inside the same command's
arguments. Set it in a separate statement first: `TOKEN=$(...); curl -H "Authorization: Bearer $TOKEN" ...`.

Old versions accumulate per service (`gcloud app versions list --service=SERVICE_NAME`). With
automatic scaling they don't serve traffic; prune occasionally, only for your own service.

## 8. Cost guardrails

- `min_instances: 0` (scale to zero), `max_instances: 1` or 2, `instance_class: F1`.
  App Engine and Firestore free tiers cover personal traffic.
- LLM spend is the real cost. Use a fast/cheap model for background work, low reasoning effort,
  log token usage per call, add per-user daily quotas once other people use the app.
- A dedicated budget with alerts on the project (the newsfeed uses €5/month with 50/100/150%):

```bash
gcloud billing budgets create \
  --billing-account=BILLING_ACCOUNT_ID \
  --display-name="SERVICE_NAME budget" \
  --budget-amount=5EUR \
  --threshold-rule=percent=0.5 --threshold-rule=percent=1.0 --threshold-rule=percent=1.5 \
  --filter-projects=projects/PROJECT_ID
```

(`gcloud billing accounts list` shows the account id; the currency must match the billing
account's. Budgets alert, they don't cap spend. Set a hard monthly limit on the LLM provider's side
too.)

## Alternative: Cloud Run (not yet battle-tested in these apps)

Both example apps run on App Engine Standard, which is the proven default. Consider Cloud Run when
you need a custom container (system packages, other runtimes), requests longer than App Engine
allows, WebSockets / streaming, or you have no App Engine app and don't want its permanent region
choice. Sketch, unverified in these apps:

```bash
gcloud run deploy SERVICE_NAME --source . --region REGION_NAME --project PROJECT_ID \
  --allow-unauthenticated --min-instances 0 --max-instances 1 \
  --set-env-vars GOOGLE_CLOUD_PROJECT=PROJECT_ID,COLLECTION_PREFIX=SERVICE_NAME_ \
  --set-secrets APP_TOKEN=app-token:latest,OPENAI_API_KEY=openai-key:latest
```

Differences to plan for: `--source .` builds with Google Cloud buildpacks (or your Dockerfile), so
confirm that the client build actually runs (add a Dockerfile if unsure); the server must listen on
`process.env.PORT`; the runtime service account (Compute Engine default unless you set one) needs
`roles/datastore.user` (+ `roles/aiplatform.user` for Vertex) and `roles/secretmanager.secretAccessor`
for the secrets; by default CPU is throttled outside requests, so fire-and-forget background work
(like the reflection pass) may never finish: await it or use instance-based billing; URLs are
`*.run.app`. Region names are Cloud Run regions (e.g. `europe-west1`), not App Engine ones.
