# Users and logins: three tiers

Pick the lightest tier that fits, but always build **user-ready**: data under
`<prefix>users/{uid}/...`, uid-required accessors in `db.js`, and routes that only use `req.uid`.
Then moving up a tier is a change to `auth.js` (plus a small client screen), not a data migration.

| Who uses it | Tier | Status in the example apps |
|---|---|---|
| Just me, or me + household/partner (shared data) | 1. Shared token → uid `owner` | Proven (Two Pans, Thoughtstream owner) |
| Me + a few invited friends, each with their own data | 2. Invite links + hashed per-user tokens | Proven (Thoughtstream) |
| Anyone who signs up | 3. Firebase Authentication | **Not yet battle-tested**, see [firebase-auth.md](firebase-auth.md) |

## Tier 1: shared token (default)

Template: [`server/auth.js`](../templates/server/auth.js).

- One random `APP_TOKEN` (`openssl rand -hex 32`) in `.env` / `app.yaml`.
- `requireAuth` compares `Authorization: Bearer <token>` in constant time; `503` if the server has no
  token configured, `401` otherwise. On success: `req.uid = 'owner'`.
- Startup ensures `users/owner` and its seed data exist.
- Client: access-code gate + `/?code=` magic link ([pwa.md](pwa.md)).
- The same token authenticates scheduled jobs.

**Security model and limits.** Whoever has the token (or the magic link) has full access: treat it
like a password, share it only privately, rotate it by changing `APP_TOKEN` and redeploying (every
device then re-enters the code). It lives in the browser's `localStorage`, so anyone with the
unlocked phone can use the app. There is no per-person audit trail or revocation. HTTPS is enforced
(`secure: always`). Fine for personal data you'd be mildly embarrassed about, not for anything
sensitive.

## Tier 2: invite links (the "light" multi-user option)

How Thoughtstream does it (no passwords, no Firebase):

- `APP_TOKEN` still always means the owner (`uid: 'owner'`, `role: 'owner'`). Owner-only routes use a
  `requireOwner` middleware (`403 { error: 'Owner only' }`).
- **Invites:** the owner creates one (`code = randomBytes(18).toString('base64url')`, 14-day expiry,
  single use), stored at `invites/{sha256(code)}`; the link is `/?invite=<code>`.
- **Join:** public, rate-limited (in memory per IP, 20 requests / 10 min; needs
  `app.set('trust proxy', true)`) `GET /api/auth/invite/:code` and `POST /api/auth/redeem
  { code, displayName }`. Redeem runs in a transaction: invite unused and unexpired → create
  `users/{autoId}` (role `member`), mark invite used, mint the first user token, seed starter data.
- **User tokens:** `'nfu_' + randomBytes(32).toString('base64url')`; only the SHA-256 hex hash is
  stored, at `authTokens/{hash}` → `{ uid, label, createdAt }`. Resolution is cached in memory for
  ≤ 60 s. "Link another device" mints another token, delivered as `/?login=<token>`; logout deletes
  the presented token and drops it from the cache.
- **Kill switches:** `users/{uid}.disabled` → `403 code: account_disabled`; env
  `MEMBERS_ENABLED=false` → every non-owner request gets `403 code: members_paused`. The client signs
  out only on those two codes (a plain 403 must not log anyone out).
- **Cost control:** per-member daily quotas on LLM routes, counted in a transaction before the call,
  `429 code: quota_exceeded` ([`quota.js`](../templates/server/quota.js)). Owner unlimited.
- **Acting for another user** (scheduled generation only): `?userId=<uid>` accepted only with the
  owner token, target must be an enabled member.
- Clear the service worker API cache on sign-out/token change so a shared device never shows the
  previous user's data.

Sketch of the resolution step to add to `requireAuth` after the owner check:

```js
const hash = crypto.createHash('sha256').update(token).digest('hex');
const tokenSnap = await store.db().collection(`${prefix}authTokens`).doc(hash).get();
if (!tokenSnap.exists) return res.status(401).json({ error: 'Unauthorized' });
const user = await store.getUser(tokenSnap.data().uid);
if (!user) return res.status(401).json({ error: 'Unauthorized' });
if (process.env.MEMBERS_ENABLED === 'false') return res.status(403).json({ error: 'Accounts are paused', code: 'members_paused' });
if (user.disabled) return res.status(403).json({ error: 'Account disabled', code: 'account_disabled' });
req.uid = user.id;
req.user = { uid: user.id, role: user.role, via: 'user-token' };
```

Write it into `SPEC.md` first (the newsfeed kept a separate design doc) and extend the smoke test with
cross-user isolation checks: member A must get 404 for member B's item ids.

## Tier 3: Firebase Authentication

Self sign-up with email/password or Google. See [firebase-auth.md](firebase-auth.md) and the
templates [`server/auth.firebase.js`](../templates/server/auth.firebase.js),
[`client/src/auth/firebase.js`](../templates/client/src/auth/firebase.js),
[`client/src/auth/SignIn.jsx`](../templates/client/src/auth/SignIn.jsx).

## Migrating a flat (legacy) app to the user-ready shape

Two Pans still uses flat prefixed collections (`meals_recipes`, ...). To migrate an app like that:

1. Script (dry run by default, `--yes` to write): back up every collection to a gitignored
   `backups/` folder, copy `<prefix><name>/*` → `<prefix>users/owner/<name>/*` with the same ids,
   verify counts. Refuse to run if the destination already has ids the source doesn't (post-cutover).
2. Switch `db.js` to uid-required accessors and routes to `req.uid`; run the smoke test on a dev prefix.
3. Deploy with `--no-promote`, verify on the version URL, re-run the copy to catch last writes, then
   promote. Rollback = route traffic back to the previous version (old collections untouched).
4. Delete the old collections only much later, deliberately.

This is how Thoughtstream moved from top-level `items/` to `users/owner/items/`.
