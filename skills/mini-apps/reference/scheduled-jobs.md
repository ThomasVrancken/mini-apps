# Scheduled generation jobs (optional)

For apps that should have fresh content waiting (a daily digest, weekly plan, morning briefing).
Thoughtstream runs this in production; Two Pans has no scheduled job.

## The contract: two endpoints, same bearer token

```
GET  /api/generation-context   → everything the job needs: preference docs + a bounded recent window
                                  (e.g. last 14 days of headlines/URLs) + mostRecentItemAt
POST /api/ingest               → { items: [...] } → server validates, dedups, writes
                                  → { acceptedCount, rejectedCount, accepted, rejected: [{reason}] }
```

- The job reads **live** preferences from the app on every run, so editing preferences (in the app
  or via its chat) changes tomorrow's output without touching the job.
- The context returns a **bounded** window for the job's own self-filtering; the all-time dedup
  guarantee lives server-side in `/api/ingest`.
- Ingest is defensive (batch ≤ 50, field and URL limits, `http(s)` only) and dedups on canonical URL
  **plus** normalized title. See [ai-patterns.md](ai-patterns.md#content-pushed-in-by-an-agent-ingest).
- Keep the job's policy (what to research, how to write) in a markdown file in the repo that any
  agent can read, and let the app's live "guidelines" preference override style details.

## Option A: Claude Code cloud routine (Thoughtstream's primary path)

A scheduled Claude Code routine (claude.ai/code/routines) runs daily in the cloud, independent of
your laptop, on your existing Claude subscription:

1. `curl` the context endpoint with the bearer token.
2. Research the web according to the policy file and the live guidelines.
3. `curl -X POST` the items to `/api/ingest`.

Give the routine the app URL and token through its configuration, never in a public repo. When you
substantially change the policy file, update the routine's prompt too, or the change won't take
effect. Deploy app changes before relying on them: the routine talks to the deployed version.
Use the Claude Code `/schedule` skill (or the routines page) to create and inspect it.

## Option B: Cloud Scheduler → Cloud Function (Thoughtstream's fallback)

A Node 22 Cloud Function (gen2) calling Vertex Gemini with Google Search grounding, in two steps:
a grounded research call, then a structured-JSON synthesis call constrained to only the URLs the
research call actually resolved (grounding returns opaque redirect links; resolve each to its real
destination first). This prevents hallucinated URLs.

Deploy (from the function's folder, which has its own `package.json` with
`@google-cloud/functions-framework` and `google-auth-library`):

```bash
gcloud functions deploy SERVICE_NAME-daily-generation --gen2 --runtime=nodejs22 \
  --region=us-central1 --source=. --entry-point=generate --trigger-http \
  --no-allow-unauthenticated --memory=512Mi --timeout=900s \
  --set-env-vars=GOOGLE_CLOUD_PROJECT=PROJECT_ID,VERTEX_LOCATION=us-central1,APP_URL=https://APP_URL \
  --set-secrets=APP_TOKEN=SERVICE_NAME-app-token:latest
```

(Thoughtstream passes `APP_TOKEN` via `--set-env-vars`; Secret Manager, as above, keeps it out of
the function's visible config. The function's service account needs
`roles/secretmanager.secretAccessor` on that secret, and `roles/aiplatform.user` for Vertex.)

Schedule it with an OIDC-authenticated Scheduler job (sketch; the invoking service account needs
`roles/run.invoker` on the gen2 function):

```bash
gcloud scheduler jobs create http SERVICE_NAME-daily-generation \
  --location=us-central1 --schedule="30 5 * * *" --time-zone=UTC \
  --uri="https://FUNCTION_URL" --http-method=POST \
  --oidc-service-account-email=SCHEDULER_SA@PROJECT_ID.iam.gserviceaccount.com \
  --oidc-token-audience="https://FUNCTION_URL"
```

**Make a fallback a true fallback:** Thoughtstream's function first reads
`recentWindow.mostRecentItemAt` and exits if anything landed in the last 20 hours, so it can stay
scheduled 90 minutes after the primary routine without doubling the queue.

## Other users

With tier-2 users, the owner-token job can act for members with `?userId=<uid>` on both endpoints
(owner token only; target must be an enabled member). Run members' generation as a **separate** job
so a slow or failing member run can never affect the owner's.

## Local testing

Point the job at `http://localhost:<port>` with a dev prefix (or the Firestore emulator). The
Gemini helper falls back to `gcloud auth print-access-token` locally when ADC isn't set up.
