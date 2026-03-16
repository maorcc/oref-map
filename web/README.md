## Frontend Structure

This app was refactored out of a single `index.html` into static assets:

- `css/main.css`
  - Global styles, panel layout, responsive rules, and component styles.
- `js/app-core.js`
  - Core runtime: config, map setup, state, rendering helpers, fetch/history processing.
- `js/app-panels.js`
  - Panel features: stats + timeline modules.
- `js/app-bootstrap.js`
  - App bootstrap and UI event wiring (about, sound panel, global listeners, `init()`).
- `js/sw-register.js`
  - Service worker registration only.

## Entry Points

- `index.html` loads:
  - `https://unpkg.com/leaflet@1.9.4/dist/leaflet.css`
  - `https://unpkg.com/leaflet@1.9.4/dist/leaflet.js`
  - `/assets/css/main.css`
  - `/assets/js/app-core.js`
  - `/assets/js/app-panels.js`
  - `/assets/js/app-bootstrap.js`
  - `/assets/js/sw-register.js`

## Maintenance Guidelines

- Keep structure/layout styles in `main.css`; avoid inline `style=""` in HTML.
- Keep files loaded in dependency order:
  1. `app-core.js`
  2. `app-panels.js`
  3. `app-bootstrap.js`
- If modules grow further, split by concern (for example `app-sound.js`, `app-map.js`) and keep load order explicit.
