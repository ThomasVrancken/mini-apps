#!/usr/bin/env node
/* eslint-disable no-console */
// Smoke test for the non-LLM API endpoints against a RUNNING LOCAL server.
//
//   REFLECTION_ENABLED=false npm run dev:server   # terminal 1 (dev prefix!)
//   npm run test:api                              # terminal 2
//   API_BASE=http://localhost:3012 npm run test:api
//
// Uses APP_TOKEN from .env. Creates its own data (titles prefixed "[api-test]")
// and deletes it afterwards. Refuses to run against production.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const BASE = process.env.API_BASE || `http://localhost:${process.env.PORT || 3002}`;
const TOKEN = process.env.APP_TOKEN;
const TAG = '[api-test]';

if (!TOKEN) {
  console.error('APP_TOKEN missing (.env)');
  process.exit(1);
}
if (/appspot\.com|\.run\.app/.test(BASE)) {
  console.error(`Refusing to run against what looks like production: ${BASE}`);
  process.exit(1);
}
if (process.env.COLLECTION_PREFIX && !process.env.COLLECTION_PREFIX.includes('dev')) {
  console.error(`Refusing to run: COLLECTION_PREFIX "${process.env.COLLECTION_PREFIX}" does not look like a dev prefix`);
  process.exit(1);
}

let passed = 0;
let failed = 0;
const createdIds = [];

async function api(method, url, body, { token = TOKEN } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail !== undefined ? `\n       ${JSON.stringify(detail).slice(0, 500)}` : ''}`);
  }
}

async function main() {
  console.log(`API smoke test against ${BASE}\n`);

  console.log('auth');
  let r = await api('GET', '/api/health', undefined, { token: null });
  check('health is public', r.status === 200 && r.data.status === 'ok', r);
  r = await api('GET', '/api/me', undefined, { token: null });
  check('no token -> 401', r.status === 401, r);
  r = await api('GET', '/api/me', undefined, { token: 'wrong' });
  check('wrong token -> 401', r.status === 401, r);
  r = await api('GET', '/api/me');
  check('right token -> 200 with uid', r.status === 200 && typeof r.data.uid === 'string', r);
  r = await api('GET', '/api/nope');
  check('unknown API route -> 404 JSON', r.status === 404 && r.data.error, r);
  r = await api('POST', '/api/items', '{bad json');
  check('invalid JSON -> 400', r.status === 400, r);

  console.log('items');
  r = await api('POST', '/api/items', { title: `${TAG} first`, notes: 'hello' });
  check('create -> 201', r.status === 201 && r.data.item.id, r);
  const id = r.data && r.data.item && r.data.item.id;
  if (id) createdIds.push(id);
  r = await api('POST', '/api/items', {});
  check('create without title -> 400', r.status === 400, r);
  r = await api('GET', '/api/items');
  check('list includes it', r.status === 200 && r.data.items.some((i) => i.id === id), r);
  r = await api('PATCH', `/api/items/${id}`, { feedback: 'up', feedbackNote: 'nice' });
  check('patch feedback', r.status === 200 && r.data.item.feedback === 'up', r);
  r = await api('PATCH', `/api/items/${id}`, { feedback: 'sideways' });
  check('invalid feedback -> 400', r.status === 400, r);
  r = await api('GET', '/api/items/does-not-exist');
  check('missing item -> 404', r.status === 404, r);

  console.log('preferences');
  r = await api('GET', '/api/preferences');
  check('get preferences', r.status === 200 && typeof r.data.preferences === 'object', r);
  const original = r.data && r.data.preferences;
  r = await api('PUT', '/api/preferences', { likes: 42 });
  check('non-string field -> 400', r.status === 400, r);
  if (original) {
    r = await api('PUT', '/api/preferences', { likes: `${original.likes}\n- ${TAG} temp` });
    check('put preferences', r.status === 200 && r.data.preferences.likes.includes(TAG), r);
    r = await api('PUT', '/api/preferences', { likes: original.likes }); // restore
    check('restore preferences', r.status === 200 && r.data.preferences.likes === original.likes, r);
    r = await api('GET', '/api/preferences/history');
    check('preferences history', r.status === 200 && Array.isArray(r.data.changes), r);
  }

  console.log('static');
  r = await api('GET', '/', undefined, { token: null });
  check('index.html is no-store', /no-store/.test(r.headers.get('cache-control') || ''), r.headers.get('cache-control'));
  r = await api('GET', '/assets/missing.js', undefined, { token: null });
  check('missing asset -> 404 (not HTML)', r.status === 404, r.status);
}

main()
  .catch((err) => {
    failed++;
    console.error(err);
  })
  .finally(async () => {
    for (const id of createdIds) await api('DELETE', `/api/items/${id}`).catch(() => {});
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
