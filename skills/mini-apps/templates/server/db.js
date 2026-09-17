const { Firestore } = require('@google-cloud/firestore');

// All Firestore access goes through this file.
//
// USER-READY BY DEFAULT: every piece of app data lives under one owner scope,
//   <prefix>users/{uid}/<collection>/{docId}
// and every accessor takes a REQUIRED uid (there are no global accessors).
// With the shared-token login every request resolves to the fixed uid
// `owner` (a household shares it); adding invite tokens or Firebase Auth later
// only changes how req.uid is resolved, not the data layer.
//
// The project's (default) database may be shared with other apps, so the root
// collection is prefixed with COLLECTION_PREFIX (`SERVICE_NAME_` in prod,
// `SERVICE_NAMEdev_` locally). Never call db().collection() elsewhere.
//
// Data volume is tiny, so avoid composite indexes: at most one equality
// filter OR one single-field orderBy per query, then filter/sort in memory.
// Timestamps are ISO strings.

let firestore;
function db() {
  if (!firestore) {
    firestore = new Firestore({
      projectId: process.env.GOOGLE_CLOUD_PROJECT,
      ignoreUndefinedProperties: true,
    });
  }
  return firestore;
}

function prefix() {
  const p = process.env.COLLECTION_PREFIX;
  if (!p) throw new Error('COLLECTION_PREFIX is not set; refusing to touch Firestore');
  return p;
}

const nowIso = () => new Date().toISOString();
const withId = (snap) => ({ ...snap.data(), id: snap.id });
const validId = (id) => typeof id === 'string' && id.length > 0 && !id.includes('/');
const byCreatedDesc = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt));

function userDoc(uid) {
  if (!validId(uid)) throw new Error('A valid uid is required for every data access');
  return db().collection(`${prefix()}users`).doc(uid);
}

/** A per-user subcollection: <prefix>users/{uid}/{name} */
const userCol = (uid, name) => userDoc(uid).collection(name);

/**
 * Create users/{uid} on first use (idempotent). With the shared token this is
 * called once for `owner` at startup; with invite tokens / Firebase Auth it is
 * called on first login.
 */
async function ensureUser(uid, fields = {}) {
  const ref = userDoc(uid);
  const snap = await ref.get();
  if (snap.exists) return withId(snap);
  const data = { role: 'member', displayName: '', disabled: false, ...fields, createdAt: nowIso() };
  await ref.set(data, { merge: true });
  return { ...data, id: uid };
}

async function getUser(uid) {
  const snap = await userDoc(uid).get();
  return snap.exists ? withId(snap) : null;
}

/** Delete a user and ALL their data (subcollections included). Irreversible. */
async function deleteUserData(uid) {
  await db().recursiveDelete(userDoc(uid));
}

// ---------------------------------------------------------------------------
// Preferences: a few free-text (markdown bullet) fields that every AI call
// reads. The user edits them in the Prefs tab, the chat agent edits them with
// targeted changes, and reflection rewrites only `learned`.
// Every change appends a full snapshot to preferencesHistory.

const PREFERENCE_FIELDS = ['about', 'likes', 'dislikes', 'learned'];

const SEED_PREFERENCES = {
  about: '- TODO: who uses this app and what for (seed from SPEC.md)',
  likes: '- TODO',
  dislikes: '- TODO',
  learned: '', // maintained by services/reflect.js
};

const preferencesRef = (uid) => userCol(uid, 'config').doc('preferences');

function pickPreferenceFields(data) {
  const out = {};
  for (const f of PREFERENCE_FIELDS) out[f] = typeof data[f] === 'string' ? data[f] : SEED_PREFERENCES[f];
  return out;
}

/** Write the seed preferences for this uid once if missing (idempotent). */
async function ensurePreferencesSeeded(uid) {
  const ref = preferencesRef(uid);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return;
    const now = nowIso();
    tx.set(ref, { ...SEED_PREFERENCES, updatedAt: now, updatedBy: 'seed' });
    tx.set(userCol(uid, 'preferencesHistory').doc(), {
      fields: { ...SEED_PREFERENCES },
      changedFields: [...PREFERENCE_FIELDS],
      summary: 'Seeded default preferences',
      updatedBy: 'seed',
      createdAt: now,
    });
  });
}

async function getPreferences(uid) {
  const snap = await preferencesRef(uid).get();
  if (!snap.exists) {
    await ensurePreferencesSeeded(uid);
    return { ...SEED_PREFERENCES, updatedAt: null, updatedBy: 'seed' };
  }
  const data = snap.data();
  return { ...pickPreferenceFields(data), updatedAt: data.updatedAt || null, updatedBy: data.updatedBy || 'seed' };
}

/**
 * Apply a subset of preference fields and snapshot the result. Only fields
 * whose text actually changed are recorded. Returns `{ preferences, changedFields }`.
 * @param {string} uid
 * @param {object} changes  field -> full new text
 * @param {{updatedBy: 'user'|'chat'|'reflection', summary?: string}} meta
 */
async function updatePreferences(uid, changes, { updatedBy, summary }) {
  const ref = preferencesRef(uid);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? pickPreferenceFields(snap.data()) : { ...SEED_PREFERENCES };
    const base = snap.exists ? snap.data() : { updatedAt: null, updatedBy: 'seed' };
    const changedFields = PREFERENCE_FIELDS.filter((f) => typeof changes[f] === 'string' && changes[f] !== current[f]);
    if (changedFields.length === 0) {
      return { preferences: { ...current, updatedAt: base.updatedAt, updatedBy: base.updatedBy }, changedFields };
    }
    const next = { ...current };
    for (const f of changedFields) next[f] = changes[f];
    const now = nowIso();
    tx.set(ref, { ...next, updatedAt: now, updatedBy });
    tx.set(userCol(uid, 'preferencesHistory').doc(), {
      fields: { ...next },
      changedFields,
      summary: summary || `Updated ${changedFields.join(', ')}`,
      updatedBy,
      createdAt: now,
    });
    return { preferences: { ...next, updatedAt: now, updatedBy }, changedFields };
  });
}

async function listPreferenceChanges(uid, limit = 20) {
  const snap = await userCol(uid, 'preferencesHistory').orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map(withId);
}

// ---------------------------------------------------------------------------
// Items: the app's main entity. Rename to whatever the SPEC calls it
// (recipes, workouts, plants, books...).

async function listItems(uid, { status } = {}) {
  const base = userCol(uid, 'items');
  const snap = await (status ? base.where('status', '==', status) : base).get();
  return snap.docs.map(withId).sort(byCreatedDesc); // sort in memory: no composite index
}

async function getItem(uid, id) {
  if (!validId(id)) return null;
  const snap = await userCol(uid, 'items').doc(id).get();
  return snap.exists ? withId(snap) : null;
}

async function createItem(uid, fields) {
  const ref = userCol(uid, 'items').doc();
  const now = nowIso();
  const data = { status: 'active', feedback: null, feedbackNote: null, ...fields, id: ref.id, createdAt: now, updatedAt: now };
  await ref.set(data);
  return data;
}

async function updateItem(uid, id, patch) {
  const ref = userCol(uid, 'items').doc(id);
  const data = { ...patch, updatedAt: nowIso() };
  delete data.id;
  delete data.createdAt;
  await ref.update(data);
  return withId(await ref.get());
}

async function deleteItem(uid, id) {
  await userCol(uid, 'items').doc(id).delete();
}

// ---------------------------------------------------------------------------
// Chat history (per uid; a household sharing one uid shares the thread)

async function listChat(uid, limit = 60) {
  const snap = await userCol(uid, 'chat').orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map(withId).reverse();
}

async function addChatMessage(uid, { role, text, actions = [], createdAt }) {
  const ref = userCol(uid, 'chat').doc();
  const data = { id: ref.id, role, text, actions, createdAt: createdAt || nowIso() };
  await ref.set(data);
  return data;
}

async function clearChat(uid) {
  const snap = await userCol(uid, 'chat').get();
  // Batches are capped at 500 writes.
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = db().batch();
    snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  return snap.size;
}

// ---------------------------------------------------------------------------
// Feedback counter for the reflection loop (services/reflect.js)

const countersRef = (uid) => userCol(uid, 'meta').doc('counters');

/** Atomically add `n` to feedbackSinceReflection and return the new value. */
async function incrementFeedbackCounter(uid, n = 1) {
  const ref = countersRef(uid);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const next = ((snap.exists && snap.data().feedbackSinceReflection) || 0) + n;
    tx.set(ref, { feedbackSinceReflection: next }, { merge: true });
    return next;
  });
}

/**
 * Reset the counter only if it is still >= threshold. Returns true when this
 * caller "claimed" the reflection run, so two concurrent requests can't both
 * start one.
 */
async function claimReflection(uid, threshold) {
  const ref = countersRef(uid);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = (snap.exists && snap.data().feedbackSinceReflection) || 0;
    if (current < threshold) return false;
    tx.set(ref, { feedbackSinceReflection: 0, lastReflectionAt: nowIso() }, { merge: true });
    return true;
  });
}

module.exports = {
  db,
  userDoc,
  userCol,
  ensureUser,
  getUser,
  deleteUserData,
  PREFERENCE_FIELDS,
  SEED_PREFERENCES,
  ensurePreferencesSeeded,
  getPreferences,
  updatePreferences,
  listPreferenceChanges,
  listItems,
  getItem,
  createItem,
  updateItem,
  deleteItem,
  listChat,
  addChatMessage,
  clearChat,
  incrementFeedbackCounter,
  claimReflection,
};
