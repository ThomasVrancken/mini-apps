# Tier 3: Firebase Authentication

> **Not yet battle-tested in the example apps.** The code follows the current `firebase` (v12) and
> `firebase-admin` (v14, Node ≥ 22) APIs and the templates build, but no mini app has run this in
> production yet. Verify each step live and write what you learn into the app's `CLAUDE.md`.

Use this when people you don't know personally should be able to sign up. It keeps the same
architecture: the client sends `Authorization: Bearer <Firebase ID token>`, the server verifies it
and sets `req.uid`, and everything else (uid-scoped data, routes) stays the same.

## 1. Add Firebase to the existing GCP project

```bash
npm install -g firebase-tools     # or: npx firebase-tools ...
firebase login
firebase projects:addfirebase PROJECT_ID          # or Firebase console → Add project → pick the GCP project
firebase apps:create WEB "APP_NAME" --project PROJECT_ID
firebase apps:sdkconfig WEB <appId> --project PROJECT_ID   # prints the web config
```

Adding Firebase does not change your App Engine app or Firestore database.

## 2. Enable sign-in providers (console)

Firebase console → **Authentication** → Get started → **Sign-in method**:

- **Email/Password**: enable.
- **Google**: enable, pick a support email.

**Settings → Authorized domains**: add the app's domain, e.g.
`SERVICE_NAME-dot-PROJECT_ID.<region-id>.r.appspot.com` (`localhost` is there by default). Without
it, sign-in fails with `auth/unauthorized-domain`.

Optional: Settings → User actions → decide whether sign-up is open. Templates for password-reset
emails live under Templates.

## 3. Client

```bash
cd client && npm install firebase
```

The web config is **public** (it identifies the project; it is not a secret). Put it in
`client/.env.production` and `client/.env.local` as Vite variables (these can be committed, but
keeping them out of a public repo avoids confusion):

```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=PROJECT_ID.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=PROJECT_ID
VITE_FIREBASE_APP_ID=...
```

Vite reads these at build time, and the build runs in Cloud Build, so `client/.env.production`
must be uploaded. The template `.gcloudignore` excludes `.env.*` at every level, so add the line
`!client/.env.production` after it.

Templates:

- [`client/src/auth/firebase.js`](../templates/client/src/auth/firebase.js): `initializeApp`,
  `getAuth`, Google popup, email sign-in/up, password reset, sign-out (clears the API cache), and
  `api.setTokenProvider(() => auth.currentUser?.getIdToken())`. `getIdToken()` returns the cached
  token and refreshes it automatically before it expires (1 hour), so call it per request instead of
  storing the token.
- [`client/src/auth/SignIn.jsx`](../templates/client/src/auth/SignIn.jsx): `AccountGate` (waits
  for `onAuthStateChanged`, then calls `GET /api/me` so the server creates the user doc) and the
  sign-in screen. In `App.jsx`, replace the access-code `AuthGate` with
  `<AccountGate>{(user) => <Home user={user} />}</AccountGate>` and drop the `?code=` logic.

Popup sign-in works in installed PWAs on most platforms; if a platform blocks popups, fall back to
`signInWithRedirect` (and read the Firebase docs on redirect best practices for your domain).

## 4. Server

```bash
npm install firebase-admin
```

[`server/auth.firebase.js`](../templates/server/auth.firebase.js) is a drop-in replacement for
`auth.js` (same exports): in `server/index.js`, `require('./auth.firebase')`.

- `initializeApp({ credential: applicationDefault(), projectId })` uses ADC: the App Engine default
  service account in production, your `gcloud auth application-default login` locally. No key file.
- `getAuth().verifyIdToken(idToken)` → `decoded.uid`, `decoded.email`, `decoded.email_verified`.
  Pass `true` as the second argument to also reject revoked sessions (one extra API call).
- First login: `store.ensureUser(uid, { email, displayName })` + per-user seed data, cached in memory
  for 10 minutes to avoid a Firestore read per request.
- `users/{uid}.disabled` → `403 code: account_disabled`.
- Optional allowlist: `ALLOWED_EMAILS=a@x.com,b@y.com` → only verified emails in the list get in
  (`403 code: not_allowed`). A simple way to run a private beta while sign-up is technically open.
  For invite-code gating instead, combine with tier 2's `invites/` collection: require a valid invite
  on the first `/api/me` call before creating the user doc.
- `deleteAccount` handler (`app.delete('/api/me', deleteAccount)`): `recursiveDelete` of
  `users/{uid}` then `getAuth().deleteUser(uid)`. Confirm in the UI first; it is irreversible.

## 5. Cost and abuse control

- Per-user daily quotas on every LLM route ([`quota.js`](../templates/server/quota.js)); consider a
  lower quota until `email_verified` is true.
- Firebase Authentication's email/password and Google sign-in are free at personal scale; check the
  current pricing page if the app grows (some features require the Identity Platform upgrade).
- Keep `max_instances` low; watch the budget alert.

## 6. Tests

Local testing is easiest against the Firebase Auth emulator (`firebase emulators:start --only auth`,
then `connectAuthEmulator` in the client and `FIREBASE_AUTH_EMULATOR_HOST` for the Admin SDK), or
with a dedicated test user. Keep `scripts/api-test.js` on the shared-token path for the non-auth
endpoints, or teach it to obtain an ID token from the emulator.
