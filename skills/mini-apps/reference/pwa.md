# PWA essentials

Templates: [`client/`](../templates/client/) (index.html, manifest, sw.js, main.jsx, api.js,
AuthGate.jsx, App.jsx) and [`scripts/make-icons.py`](../templates/scripts/make-icons.py).

## Checklist

- `client/public/manifest.webmanifest`: `name`, `short_name`, `start_url: "/"`, `scope: "/"`,
  `display: "standalone"`, `background_color`/`theme_color` matching the app, `orientation: "portrait"`,
  icons 192 and 512 (`purpose: "any"`), plus 512 as `"maskable"`.
- `client/public/icons/icon-{32,180,192,512}.png`. On macOS, generate them from an emoji:
  `python3 -m venv .venv && .venv/bin/pip install pillow && .venv/bin/python scripts/make-icons.py "🍳" "#FFF8F0" client/public/icons`.
- `index.html` head: `<link rel="manifest">`, `<link rel="apple-touch-icon" href="/icons/icon-180.png">`,
  favicon, `viewport` with `viewport-fit=cover`, `theme-color`, `mobile-web-app-capable`,
  `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style` (`default` for light apps,
  `black-translucent` for dark), `apple-mobile-web-app-title`.
- Layout: `h-[100dvh]` app shell, `env(safe-area-inset-*)` padding utilities (`safe-top`,
  `safe-bottom`) on the top bar and the fixed bottom tab bar, `touch-action: manipulation`,
  `overscroll-behavior-y: none`, 16px+ inputs (smaller fonts make iOS zoom on focus).
- Register the service worker in `main.jsx` on `load`.

## Caching: the bug that breaks everything

Vite emits content-hashed asset names that change on every deploy; `index.html` references them.

1. **Server:** serve `index.html` (static middleware *and* SPA fallback), `sw.js` and
   `manifest.webmanifest` with `Cache-Control: no-store`; `/assets/*` with
   `public, max-age=31536000, immutable`. Missing files with an extension return 404, not the SPA
   HTML.
2. **Service worker:** navigations **network-first** (cache only as offline fallback); hashed assets
   cache-first; `/api/*` GETs network-first with cache fallback; never touch non-GET requests.

Symptom when this is wrong: after a redeploy, a returning client loads a stale `index.html` pointing
at deleted assets, the request falls through to the SPA fallback, and the browser refuses to run
HTML as a module script ("text/html is not a valid JavaScript MIME type"): a blank app. `curl` alone
may not catch it; the newsfeed caught it with a real browser against production. If a bad shell was
ever cached, bump `CACHE_NAME` in `sw.js`.

The API cache name in `sw.js` must match the one `api.js` clears: wipe it on token change and sign-out
so one user's cached responses never show for the next.

## Login UX (shared-token tier)

- Access-code screen (password input, autocapitalize/autocorrect off). The token goes to
  `localStorage`; verify with `GET /api/me` before unlocking.
- **Magic link:** `https://<url>/?code=<APP_TOKEN>` stores the token, strips the param with
  `history.replaceState` immediately, verifies, unlocks. This is how you get a partner onto the app
  with one message. Send it privately; it is the whole key.
- A 401 anywhere clears the token and API cache and dispatches an `unauthorized` event; the shell
  shows the gate again with a message.

## Installing on the phone

- iPhone (Safari): open the link → Share → **Add to Home Screen**.
- Android (Chrome): open the link → menu → **Install app** / Add to Home screen.
- `localStorage` in an installed iOS PWA can be separate from Safari's, so open the magic link and
  then add to home screen; if the installed app asks for the code, type it once.

## Client structure that scales

- One `api.js` (axios) with 15 s default timeout and 120 s for AI calls, error messages from the
  server's `{ error }` surfaced as `err.message`, and `err.status` kept.
- A `DataContext` holding the main lists with `refresh*` functions and an `applyChanged(changed)`
  helper, so a chat reply with `changed: { items: true }` refreshes every tab that shows items.
- Fixed bottom tab bar (4–5 tabs), bottom sheets for details/forms, optimistic toggles for cheap
  actions, friendly loading states for AI calls, empty states with a clear first action.
- For frontend-only work before the API exists, a throwaway in-memory mock server (Two Pans had
  `client/dev/mock-server.mjs`) lets the frontend subagent run the UI.

## Testing the UI

`npm run build` must pass (it catches most JSX mistakes). For a visual check, run Vite and load it
in a browser. Agent-driven browser flows that authenticate with the shared token may be blocked by
the sandbox's credential protections: if so, verify via the API and ask the user to do the logged-in
click-through on their phone. To test on a phone against a local server, `npx vite --host` exposes
the dev server on the LAN (service workers need HTTPS except on localhost, so offline behaviour is
best checked on the deployed URL).
