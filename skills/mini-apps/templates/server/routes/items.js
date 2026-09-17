const express = require('express');
const store = require('../db');
const { badRequest, notFound, requiredString, optionalString } = require('../http');
const { recordFeedbackEvents } = require('../services/reflect');

// CRUD for the app's main entity. Thin: validate, then call db.js with req.uid.

const router = express.Router();
const STATUSES = ['active', 'archived'];
const FEEDBACK = ['up', 'down', null];

router.get('/', async (req, res) => {
  const status = req.query.status;
  if (status && !STATUSES.includes(status)) throw badRequest(`status must be one of ${STATUSES.join(', ')}`);
  res.json({ items: await store.listItems(req.uid, { status }) });
});

router.get('/:id', async (req, res) => {
  const item = await store.getItem(req.uid, req.params.id);
  if (!item) throw notFound('Item not found');
  res.json({ item });
});

router.post('/', async (req, res) => {
  const body = req.body || {};
  const item = await store.createItem(req.uid, {
    title: requiredString(body, 'title', { max: 200 }),
    notes: optionalString(body, 'notes', { max: 4000 }) || null,
  });
  res.status(201).json({ item });
});

router.patch('/:id', async (req, res) => {
  const existing = await store.getItem(req.uid, req.params.id);
  if (!existing) throw notFound('Item not found');
  const body = req.body || {};
  const patch = {};
  if ('title' in body) patch.title = requiredString(body, 'title', { max: 200 });
  if ('notes' in body) patch.notes = optionalString(body, 'notes', { max: 4000 });
  if ('status' in body) {
    if (!STATUSES.includes(body.status)) throw badRequest(`status must be one of ${STATUSES.join(', ')}`);
    patch.status = body.status;
  }
  if ('feedback' in body) {
    if (!FEEDBACK.includes(body.feedback)) throw badRequest('feedback must be up, down or null');
    patch.feedback = body.feedback;
  }
  if ('feedbackNote' in body) patch.feedbackNote = optionalString(body, 'feedbackNote', { max: 1000 });
  if (Object.keys(patch).length === 0) throw badRequest('Nothing to update');

  const item = await store.updateItem(req.uid, req.params.id, patch);
  // Thumbs up/down feed the learning loop (non-blocking, never throws).
  if ('feedback' in patch && patch.feedback && patch.feedback !== existing.feedback) {
    recordFeedbackEvents(req.uid, 1);
  }
  res.json({ item });
});

router.delete('/:id', async (req, res) => {
  const existing = await store.getItem(req.uid, req.params.id);
  if (!existing) throw notFound('Item not found');
  await store.deleteItem(req.uid, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
