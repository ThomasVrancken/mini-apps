const express = require('express');
const store = require('../db');
const { badRequest } = require('../http');

const router = express.Router();
const MAX_FIELD_LENGTH = 10000;

router.get('/', async (req, res) => {
  res.json({ preferences: await store.getPreferences(req.uid) });
});

router.put('/', async (req, res) => {
  const body = req.body || {};
  const changes = {};
  for (const field of store.PREFERENCE_FIELDS) {
    if (!(field in body)) continue;
    if (typeof body[field] !== 'string') throw badRequest(`${field} must be a string`);
    if (body[field].length > MAX_FIELD_LENGTH) throw badRequest(`${field} is too long (max ${MAX_FIELD_LENGTH} chars)`);
    changes[field] = body[field];
  }
  if (Object.keys(changes).length === 0) {
    throw badRequest(`Body must contain at least one of: ${store.PREFERENCE_FIELDS.join(', ')}`);
  }
  const { preferences } = await store.updatePreferences(req.uid, changes, {
    updatedBy: 'user',
    summary: `Edited in Prefs: ${Object.keys(changes).join(', ')}`,
  });
  res.json({ preferences });
});

router.get('/history', async (req, res) => {
  res.json({ changes: await store.listPreferenceChanges(req.uid, 20) });
});

module.exports = router;
