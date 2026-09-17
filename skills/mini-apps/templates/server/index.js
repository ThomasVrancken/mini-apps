const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const express = require('express');
// Swap './auth' for './auth.firebase' to use Firebase Authentication (tier 3).
const { requireAuth, initAuth } = require('./auth');
const store = require('./db');
const { redact } = require('./http');

// APP_NAME server: JSON API under /api (bearer-token protected) + the built
// React PWA from client/dist. Express 5: async handlers that throw are routed
// to the error handler automatically (Express 4 needs a wrapper for that).

const app = express();
const PORT = process.env.PORT || 3002;
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');
const INDEX_HTML = path.join(CLIENT_DIST, 'index.html');

app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// --- API --------------------------------------------------------------------

// The only unauthenticated route (App Engine health checks).
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api', requireAuth);
// Every route below reads data ONLY through req.uid (set by requireAuth).
app.get('/api/me', (req, res) => res.json({ ok: true, uid: req.uid, role: req.user && req.user.role }));
app.use('/api/items', require('./routes/items'));
app.use('/api/preferences', require('./routes/preferences'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api', (req, res) => res.status(404).json({ error: `No API route for ${req.method} ${req.path}` }));

// --- Static client (PWA) ----------------------------------------------------
// index.html (and sw.js / the manifest) must never be cached: index.html
// references the current build's hashed asset filenames, which change on
// every deploy. A stale index.html points at assets that no longer exist and
// the whole app fails to load. Hashed assets are safe to cache forever.

app.use(
  express.static(CLIENT_DIST, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html') || filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) {
        res.setHeader('Cache-Control', 'no-store');
      } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  })
);

// SPA fallback for navigations (Express 5 wildcard syntax; Express 4 uses '*').
// Missing files with an extension 404 instead of returning HTML, which would
// otherwise surface as "text/html is not a valid JavaScript MIME type".
app.get('/{*splat}', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (path.extname(req.path)) return res.status(404).send('Not found');
  if (!fs.existsSync(INDEX_HTML)) {
    return res.status(503).type('text').send('Client not built yet. Run `npm run build` (or `npm run dev:client`).');
  }
  return res.sendFile(INDEX_HTML);
});

// --- Errors -----------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(`[error] ${req.method} ${req.path}: ${redact(err.stack || err.message)}`);
  const message = status === 500 ? 'Internal server error' : redact(err.message);
  return res.status(status).json({ error: message });
});

async function start() {
  if (!process.env.COLLECTION_PREFIX) {
    console.error('COLLECTION_PREFIX is not set; refusing to start (the Firestore database may be shared).');
    process.exit(1);
  }
  try {
    await initAuth(store); // shared token: ensure users/owner + its seed preferences
  } catch (err) {
    // Don't crash-loop on a transient Firestore error; getPreferences() seeds lazily too.
    console.error(`Could not initialise user data at startup: ${err.message}`);
  }
  app.listen(PORT, (err) => {
    if (err) {
      console.error(`Could not listen on port ${PORT}: ${err.message}`);
      process.exit(1);
    }
    console.log(`APP_NAME server on http://localhost:${PORT} (prefix ${process.env.COLLECTION_PREFIX})`);
    if (!fs.existsSync(INDEX_HTML)) console.log('client/dist not found: API only until the client is built');
  });
}

if (require.main === module) start();

module.exports = app;
