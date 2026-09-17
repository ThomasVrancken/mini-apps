const { initializeApp, applicationDefault, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const store = require('./db');

// Tier 3 login: Firebase Authentication (people sign up themselves).
// NOT YET BATTLE-TESTED in the example apps; see reference/firebase-auth.md.
//
// Drop-in replacement for auth.js: same exports, same req.uid contract.
//   server/index.js: require('./auth.firebase') instead of require('./auth')
//   root package.json: add "firebase-admin" (needs Node >= 22)
//
// The client sends `Authorization: Bearer <Firebase ID token>` (fresh from
// user.getIdToken() on every request). We verify it with the Admin SDK using
// Application Default Credentials: no service-account key file. On App Engine
// the default service account can verify tokens for its own project.
//
// Optional gate: ALLOWED_EMAILS="a@example.com,b@example.com" limits who can
// use the app even though anyone can create a Firebase account.

if (getApps().length === 0) {
  initializeApp({ credential: applicationDefault(), projectId: process.env.GOOGLE_CLOUD_PROJECT });
}

const OWNER_UID = null; // there is no fixed owner in this tier

const allowedEmails = () =>
  (process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

// uid -> expiry; avoids a Firestore read per request once the user doc exists.
const knownUsers = new Map();
const KNOWN_TTL_MS = 10 * 60 * 1000;

async function ensureUserOnce(decoded) {
  const cached = knownUsers.get(decoded.uid);
  if (cached && cached > Date.now()) return;
  const user = await store.ensureUser(decoded.uid, {
    role: 'member',
    email: decoded.email || null,
    displayName: decoded.name || '',
  });
  if (user.disabled) {
    const err = new Error('Account disabled');
    err.status = 403;
    throw err;
  }
  await store.ensurePreferencesSeeded(decoded.uid); // per-user seed data
  knownUsers.set(decoded.uid, Date.now() + KNOWN_TTL_MS);
}

async function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const idToken = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!idToken) return res.status(401).json({ error: 'Unauthorized' });

  let decoded;
  try {
    // Pass `true` as second argument to also reject revoked sessions
    // (costs an extra Auth API call per request).
    decoded = await getAuth().verifyIdToken(idToken);
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const allow = allowedEmails();
  if (allow.length) {
    const email = (decoded.email || '').toLowerCase();
    if (!email || !decoded.email_verified || !allow.includes(email)) {
      return res.status(403).json({ error: 'This account is not invited', code: 'not_allowed' });
    }
  }

  try {
    await ensureUserOnce(decoded);
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message, code: 'account_disabled' });
    return next(err);
  }

  req.uid = decoded.uid;
  req.user = { uid: decoded.uid, role: 'member', email: decoded.email || null, via: 'firebase' };
  return next();
}

/** Nothing to seed globally: users are created on first login. */
async function initAuth() {}

/**
 * Delete the signed-in user's data and Firebase account. Mount as
 *   app.delete('/api/me', deleteAccount)
 * behind requireAuth. Irreversible: the client should confirm first.
 */
async function deleteAccount(req, res) {
  await store.deleteUserData(req.uid);
  await getAuth().deleteUser(req.uid);
  knownUsers.delete(req.uid);
  res.json({ ok: true });
}

module.exports = { requireAuth, initAuth, deleteAccount, OWNER_UID };
