const crypto = require('crypto');

// Tier 1 login: one shared secret. Every device (and any scheduled job)
// presents APP_TOKEN as `Authorization: Bearer <token>`, and the request is
// resolved to the fixed uid OWNER_UID. A couple / household shares that uid
// and therefore all data.
//
// Routes must only ever read `req.uid` (never assume `owner`), so upgrading
// later is a change to THIS file only:
//   - Tier 2 (a few invited friends): also accept per-user tokens stored
//     hashed in Firestore, see reference/users-and-auth.md.
//   - Tier 3 (self sign-up): swap this file for auth.firebase.js.
//
// Applied to every /api/* route except /api/health, which is mounted first.

const OWNER_UID = 'owner';

function constantTimeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch; compare against itself to keep timing flat.
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAuth(req, res, next) {
  const configured = process.env.APP_TOKEN;
  if (!configured) {
    console.error('APP_TOKEN is not set; refusing all API requests');
    return res.status(503).json({ error: 'Server not configured' });
  }
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !constantTimeEqual(token, configured)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.uid = OWNER_UID;
  req.user = { uid: OWNER_UID, role: 'owner', via: 'app-token' };
  return next();
}

/** Run once at startup: make sure the owner's user doc and seed data exist. */
async function initAuth(store) {
  await store.ensureUser(OWNER_UID, { role: 'owner' });
  await store.ensurePreferencesSeeded(OWNER_UID);
}

module.exports = { requireAuth, initAuth, OWNER_UID };
