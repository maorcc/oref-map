# oref-map — Technical Design

## Overview

A static single-page web app showing live Pikud HaOref (Home Front Command) alerts as colored area polygons on a map of Israel. No build step — all JS/CSS is inline in `web/index.html`. Static assets deployed on Cloudflare Pages; API proxy runs as a separate Cloudflare Worker with placement pinned to Israel.

## Stack

- **Map**: Leaflet.js (v1.9.4) + OpenStreetMap tiles
- **Voronoi**: d3-delaunay (v6) for polygon computation, polygon-clipping (v0.15) for clipping to Israel border
- **API proxy**: Cloudflare Worker (`worker/`) with placement `region = "azure:israelcentral"`
- **No frameworks**: Vanilla JS, CSS

## Data Sources

### Live Alerts API
- **Proxy**: `/api/alerts` → `https://www.oref.org.il/warningMessages/alert/Alerts.json`
- **Poll interval**: 1 second
- **Shape**: `{"id", "cat", "title", "data": ["location", ...], "desc"}`
- `data` is an **array** of location strings.
- Returns a BOM-only (`\ufeff`) body when no alert is active.
- Snapshot of what's active *right now* — short-lived alerts can be missed between polls.

### History API
- **Proxy**: `/api/history` → `https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json`
- **Poll interval**: 10 seconds
- **Shape**: `[{"alertDate": "YYYY-MM-DD HH:MM:SS", "title", "data": "location", "category"}, ...]`
- `data` is a **string** (single location), unlike the live API.
- Reliable record of all alerts including all-clears. Used on page load to reconstruct initial state, and polled to catch all-clear events that would be missed in the live API.

### Extended History API
- **Proxy**: `/api/alarms-history` → `https://alerts-history.oref.org.il//Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1`
- Returns up to ~3,000 entries covering ~1–2 hours.
- **Shape**: `{"data": "location", "alertDate": "YYYY-MM-DDTHH:MM:SS", "category_desc": "title", "rid": number, ...}`
- `rid` is a unique ID per entry — used for deduplication.
- Used by the timeline slider to reconstruct map state at a past point in time.

### Why Dual Polling?

The live API is a snapshot — all-clear alerts may only last a few seconds and can be missed. The history API is the reliable source for state transitions to green. Polling it every 10s guarantees all-clears are caught.

### CORS

The Oref APIs don't include `Access-Control-Allow-Origin`. The Worker proxy runs on the same domain (`oref-map.org/api/*` via Workers route), so no CORS headers are needed.

### Geo-blocking / Israeli IP requirement

The Oref APIs geo-block non-Israeli IPs. This was confirmed while building the `oref-logger` project: a Cloudflare Worker cron running from Zurich (`colo=ZRH`) got HTTP 403, while the same code triggered from Israel (`colo=TLV`) succeeded.

Previously, Pages Functions ran at the user's nearest Cloudflare edge. Users routed through non-Israeli edges (e.g., `FRA`, `ZRH`) got 403 errors because the proxy egressed from a non-Israeli IP.

**Solution**: The API proxy now runs as a standalone Worker with explicit placement (`region = "azure:israelcentral"`). This forces the Worker to execute at Cloudflare's TLV data center regardless of where the user's request arrives. The `cf-placement` response header confirms the execution location (e.g., `remote-TLV`).

#### Placement investigation notes

Several placement strategies were tested before finding a working solution:

| Strategy | Result |
|----------|--------|
| Smart Placement (Pages) | Unreliable — sometimes ran locally at non-Israeli colos |
| `hostname = "www.oref.org.il"` | Placed Worker in Seattle (SEA) — Oref uses Akamai CDN with anycast IPs, so the probe found a non-Israeli edge |
| `region = "aws:il-central-1"` | Placed Worker at ZDM, not TLV — still got 403 |
| `host = "<Israeli IP>:443"` | Worked from Israel but not consistently from other locations |
| `region = "azure:israelcentral"` | Reliably places Worker at TLV — confirmed working from FRA, TLV, and other colos |

### Edge caching

The Worker uses the Cloudflare Cache API (`caches.default`) with `s-maxage=1` to cache Oref responses at each edge for 1 second. This reduces redundant fetches when many clients poll simultaneously. The browser cache uses `max-age=2` (matching the previous behavior).

## Alert Classification

Alerts are classified by **title text** only — category numbers are unreliable (same number reused for different types across APIs). Titles are normalized with `.replace(/\s+/g, ' ')` before matching (API sometimes uses double spaces).

| State | Color | Title match |
|-------|-------|-------------|
| Danger | Red | `ירי רקטות וטילים`, `נשק לא קונבנציונלי`, `חדירת מחבלים` |
| Danger | Purple | `חדירת כלי טיס עוין` |
| Caution | Yellow | `בדקות הקרובות צפויות להתקבל התרעות באזורך` |
| All-clear | Green | Substring: `האירוע הסתיים`, `ניתן לצאת`, `החשש הוסר` |
| Normal | — | No alert |

Unknown titles default to red and log a console warning.

### State Transitions & Priority

- **Priority**: `red > purple > yellow` — a lower-priority color cannot overwrite a higher one. Green (all-clear) always overrides any active state.
- **Green fade**: After receiving an all-clear, the polygon fades out over `GREEN_FADE_MS` (60 seconds) then returns to normal.
- **Page load**: History API is fetched to reconstruct current state before polling begins.

## Map Rendering

### Voronoi Polygons

All ~1,430 location coordinates from `cities_geo.json` are tessellated at startup using d3-delaunay into Voronoi cells. Cells are clipped to Israel's border polygon using polygon-clipping. Each location owns one polygon cell.

- Computed once at startup, not on every alert update.
- Only fill color and opacity change per alert event.
- Adjacent polygons of the same color visually merge into contiguous threat zones (shared borders become invisible due to matching stroke color).

### Geocoding

`web/cities_geo.json` maps ~1,430 Oref location names to `[lat, lng]`. Locations without coordinates are silently skipped.

**Known gap**: Locations south of ~30.6°N (Eilat, Arava valley) are missing from the geocoding data.

## UI

- **Page title**: Centered top — "מפת העורף" (clickable — opens About modal)
- **Status indicator**: Top-right — green/red dot + "Live"/"Error"
- **Mute toggle**: Top-right — 🔇/🔊 button, state persisted in `localStorage`
- **Legend**: Bottom-right — color key
- **Timeline slider**: Bottom-center — scrub through the last ~1–2 hours of history
- **About modal**: Triggered by ⓘ button or title click. Closes on backdrop click or Escape.
- **Popups**: Click a polygon to see alert history for that location (newest first).

All overlays use `position: fixed`, `z-index: 1000`, semi-transparent white backgrounds with `border-radius` and `box-shadow`. RTL layout throughout.

## Timeline Slider

- Fetches the extended history API once when first opened.
- Reconstructs map state at any selected past timestamp from the fetched entries.
- While scrubbing, live polling continues in the background but doesn't affect the displayed map.
- Dragging back to the rightmost position ("now") resumes live view.

## Alert Sounds

Web Audio API oscillator-based sounds (no external files). Muted by default. Two distinct tones: one for danger alerts (red/purple), one for all-clears (green). Sounds only play after initialization (initial history reconstruction) is complete.

## Deployment

```sh
./web-dev                    # npx wrangler pages dev web/ — serves static files locally
./deploy                     # npx wrangler pages deploy web/ — deploy static assets
cd worker && npx wrangler deploy  # deploy API proxy Worker
```

The Pages project serves static assets. The Worker handles `/api/*` via a Workers route on `oref-map.org`. The `oref-map.pages.dev` → `oref-map.org` redirect is configured as a Cloudflare Redirect Rule (dashboard).
