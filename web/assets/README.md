## Frontend Structure

This app was refactored out of a single `index.html` into static assets:

- `css/main.css`
  - Global styles, panel layout, responsive rules, and component styles.
- `js/app.js`
  - Main client runtime (map rendering, API polling, sound, stats, timeline).
- `js/sw-register.js`
  - Service worker registration only.

## Entry Points

- `index.html` loads:
  - `https://unpkg.com/leaflet@1.9.4/dist/leaflet.css`
  - `https://unpkg.com/leaflet@1.9.4/dist/leaflet.js`
  - `/assets/css/main.css`
  - `/assets/js/app.js`
  - `/assets/js/sw-register.js`

## Maintenance Guidelines

- Keep structure/layout styles in `main.css`; avoid inline `style=""` in HTML.
- Keep UI text and DOM wiring in `app.js`.
- If `app.js` grows further, split by concern into:
  - `api.js`, `map.js`, `live.js`, `sound.js`, `stats.js`, `timeline.js`.
  - Keep one shared `appState` object to avoid implicit globals.
