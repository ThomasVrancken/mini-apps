# Gotchas worth knowing

Concrete traps hit while building and deploying real mini apps, kept here because they're easy
to lose an hour to. Only the ones relevant to your stack apply — skip the rest.

## Google Cloud App Engine Standard

- The first service ever deployed to a new App Engine app must be named `default`; a custom
  `service:` name fails until `default` exists. Anything deployed after that becomes a named
  service, reachable at its own subdomain.
- The App Engine region is permanent once set, and must match the region/multi-region of any
  existing Firestore database in the project (check before creating either).
- Right after Firestore is first provisioned, `gcloud app describe` can 404 for a bit even though
  the app exists — don't treat that as failure.
- The platform's build step only runs the root install/build command. If the client lives in a
  subfolder, the root build must explicitly `cd` into it and install + build there, or the
  deployed app serves stale or missing assets.
- A deploy uploads only the directory containing the app's config file (minus anything
  ignored). Anything the server reads at runtime needs to live inside that directory.
- Redeploying is the only way changes go live — a scheduled job or another service always hits
  whatever was last deployed, not your working tree.
- Never deploy, stop, or delete another service in a shared project by accident; check the list
  of services before and after you touch anything.

## PWA / static front ends

- Serve the HTML entry point (and the service worker file, if any) with `Cache-Control:
  no-store`. Without it, returning users can get stuck on a stale version after a redeploy — the
  new JS bundle loads under an old, cached HTML shell and fails oddly.
- A missing static asset should 404, not silently fall through to the app's HTML shell (a common
  side effect of naive SPA-fallback routing).
- Strip any one-time login token or code out of the URL immediately after reading it, so it
  doesn't linger in browser history or get shared accidentally.

## Data

- Route all reads/writes through one data-access module rather than touching the database client
  directly from routes — it's the one place to enforce per-user scoping and catch mistakes.
- Seed data on startup should only fill in what's missing; the live database is always the
  source of truth, so editing seed values in code later does nothing to existing data.
- Before running any script that writes to production data: back it up first, support a dry-run
  mode, and require an explicit flag to target production.

## Security & process

- Never print, log, or commit secrets — check `git status` before every commit while a `.env` or
  credentials file is in the working tree.
- Automated browser tests that log in with a real credential may get blocked as credential
  misuse by sandboxed tooling; verify login flows through the API or by asking the human to
  click through once on their own device.
- Vague instructions to an AI feature ("common items", "reasonable defaults") drift over time —
  name concrete examples and say explicitly what to substitute.
