# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project

`oref-map` is a live alert map of Israel ("מפת העורף") showing colored area polygons for alert statuses per location. It uses MapLibre GL JS + self-hosted PMTiles (Protomaps, Cloudflare R2). Polygons are pre-computed GeoJSON (`locations_polygons.json`). Static assets on Cloudflare Pages; API proxy uses a two-tier architecture: Pages Functions serve TLV users directly, non-TLV users are redirected to a placement-pinned Worker.

**Public URL**: https://oref-map.org

## Product principles

- **Complete history is non-negotiable.** Users rely on this system during active rocket attacks. If a missile hit 10 minutes ago and that event doesn't appear on the map or timeline, users lose trust in the system. Never accept gaps or missing events in displayed history — always ensure recent events are visible even if it requires redundant data sources.

## Commands

```bash
./web-dev                          # start dev server at http://localhost:8788 (wrangler pages dev)
./deploy                           # deploy static assets to Cloudflare Pages
cd worker && npx wrangler deploy   # deploy API proxy Worker
```

## Structure

- `web/index.html` — Single-file map page (all JS/CSS inline)
- `web/cities_geo.json` — Location → [lat, lng] lookup
- `functions/api/` — Pages Functions: proxy for TLV users, 303 redirect for non-TLV
- `worker/src/index.js` — Cloudflare Worker: fallback proxy for non-TLV users (placement: `azure:israelcentral`)
- `worker/wrangler.toml` — Worker configuration with placement and `/api2/*` route
- `ingestion/src/index.js` — Cloudflare Worker cron: ingests extended history API into R2 day-history files
- `tools/backfill_history.py` — One-off script to rebuild R2 day-history files from the oref API (mode=3, city by city)
- `tools/poll-coderabbit.sh` — Polls CodeRabbit review status on a PR via GitHub commit status API
- `docs/map-requirements.md` — Feature requirements doc

## Docs — when to read which file

Read the relevant doc before making changes in that area:

| Task | Read |
|------|------|
| Map rendering, basemap tiles, polygon source, API proxy architecture, Cloudflare setup | `docs/architecture.md` |
| Changing map bounds, replacing or extending PMTiles on R2, understanding tile coverage | `docs/architecture.md` § "Basemap Tiles (PMTiles on R2)" |
| Ellipse mode behavior, geometry math, cluster algorithm | `docs/ellipse-feature.md` |
| Alg-C ellipse service (Python backend), request/response format | `docs/ellipse-alg-C.md` |
| Ellipse probability window metric | `docs/ellipse-probability-window.md` |
| Feature requirements, UX decisions | `docs/map-requirements.md` |
| Oref API endpoints, response shapes, geo-blocking | `docs/oref-sources.md` (and this file) |

## Replacing the basemap tiles (one-time)

When the user asks to change or extend the PMTiles coverage:

1. **Download a new PMTiles file** using the `pmtiles` CLI (install: `brew install protomaps/homebrew-go-pmtiles/go-pmtiles`). It extracts only the needed bbox via HTTP range requests — no full 120 GB download:
   ```bash
   pmtiles extract https://build.protomaps.com/20260409.pmtiles middle-east.pmtiles \
     --bbox=22,3,73,50 --maxzoom=10 --download-threads=4
   ```
   Replace `20260404` with a recent date from https://maps.protomaps.com/builds/.
   The bbox format is `MIN_LON,MIN_LAT,MAX_LON,MAX_LAT`.

2. **Upload to R2** with:
   ```bash
   wrangler r2 object put <bucket-name>/middle-east.pmtiles \
     --file=<path-to-downloaded-file>.pmtiles \
     --content-type=application/vnd.mapbox-vector-tile
   ```
   The bucket name is visible in Cloudflare dashboard → R2. The public URL does not change.

3. **Update `maxBounds` in `web/index.html`** (search for `maxBounds`) to match the new bounding box.

4. **Verify** by running `npx pmtiles show <url>` to confirm the new bounds.

## Feature flags

Beta/debug features are gated behind URL parameters with an `f-` prefix (e.g. `?f-log`). On page load, a single block of JS parses all `f-*` params and:

1. Populates `window.FF` — a global dict keyed by flag name (e.g. `FF.ellipse`). Boolean flags store `true`; value-carrying flags (e.g. `?f-debugapi=host`) store the string value.
2. Adds a CSS class `f-<name>` to `<body>` — enabling pure-CSS gating.

**To gate a new feature:**
- **CSS-only** (e.g. hiding a menu item): add `class="f-gated"` to the element, then add a CSS rule `body.f-<name> #element.f-gated { display: block !important; }`.
- **JS-only**: check `if (FF.myfeature) { ... }`.

**Current flags:** `f-log` (on-screen console overlay), `f-debugapi` (force API proxy host), `f-predict` (launch source prediction lines, experimental).

## Oref API details

### Live Alerts API
- **URL**: `https://www.oref.org.il/warningMessages/alert/Alerts.json`
- Returns current active alert as JSON, or a BOM-only (`\ufeff`) empty body when no alert is active.
- Required headers: `Referer: https://www.oref.org.il/` and `X-Requested-With: XMLHttpRequest`
- Shape: `{"id", "cat", "title", "data": ["location", ...], "desc"}`
- `data` is an **array** of location strings.
- Snapshot of what's active *right now*. Short-lived alerts (including all-clears) may only last a few seconds and can be missed between polls.

### History API
- **URL**: `https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json`
- Returns ~1 hour of recent alerts (entries expire by age, not by count).
- Shape: `[{"alertDate", "title", "data": "location", "category"}, ...]`
- `data` is a **string** (single location), unlike the live API.
- `alertDate` format: `"YYYY-MM-DD HH:MM:SS"`
- Reliable record of all alerts including all-clears. Use this to reconstruct current state on page load.
- Also feeds into the timeline's `extendedHistory` to fill the R2 day-history lag (~3-18 min).

### Category numbers are unreliable
Do **not** use `cat`/`category` for classification — the same number is reused for different alert types across the two APIs. Always classify by **title text**.

### Known alert titles (as of March 2026)

| Title | Meaning | Map state |
|---|---|---|
| `ירי רקטות וטילים` | Rocket/missile fire | 🔴 Red |
| `חדירת כלי טיס עוין` | Hostile drone/aircraft | 🟣 Purple |
| `נשק לא קונבנציונלי` | Non-conventional weapon | 🔴 Red |
| `חדירת מחבלים` | Terrorist infiltration | 🔴 Red |
| `היכנסו מייד למרחב המוגן` | Enter shelter immediately | 🔴 Red |
| `היכנסו למרחב המוגן` | Enter the shelter | 🔴 Red |
| `בדקות הקרובות צפויות להתקבל התרעות באזורך` | Early warning — Iran launch, sirens expected in ~10 min | 🟡 Yellow |
| `על תושבי האזורים הבאים לשפר את המיקום למיגון המיטבי בקרבתך...` | Preparedness notice — improve shelter position, enter shelter if alert received | 🟡 Yellow |
| `יש לשהות בסמיכות למרחב המוגן` | Stay near the shelter | 🟡 Yellow |
| `ירי רקטות וטילים - האירוע הסתיים` | Rocket event over | 🟢 Green (fades) |
| `חדירת כלי טיס עוין - האירוע הסתיים` | Aircraft event over | 🟢 Green (fades) |
| `ניתן לצאת מהמרחב המוגן` | Can leave shelter | 🟢 Green (fades) |
| `ניתן לצאת מהמרחב המוגן אך יש להישאר בקרבתו` | Can leave shelter but stay near it | 🟡 Yellow |
| `חדירת מחבלים - החשש הוסר` | Terrorist threat removed | 🟢 Green (fades) |
| `השוהים במרחב המוגן יכולים לצאת...` | Shelter occupants can exit | 🟢 Green (fades) |
| `תושבי האזורים הבאים אינם צריכים לשהות יותר בסמיכות למרחב המוגן.` | No longer need to stay near shelter | 🟢 Green (fades) |
| `סיום שהייה בסמיכות למרחב המוגן` | End of stay near shelter | 🟢 Green (fades) |

- Green titles are matched by substring (`האירוע הסתיים`, `ניתן לצאת` (excluding titles that also contain `להישאר בקרבתו`), `החשש הוסר`, `יכולים לצאת`, `אינם צריכים לשהות`, `סיום שהייה בסמיכות`) to catch variants.
- Yellow titles are matched by exact string or substring: `לשפר את המיקום למיגון המיטבי`, `להישאר בקרבתו`.
- API sometimes uses double spaces in titles — normalize with `.replace(/\s+/g, ' ')` before matching.
- Unknown titles default to Red and log a console warning.

### Extended History API
- **URL**: `https://alerts-history.oref.org.il//Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1`
- Returns up to 3,000 recent alert entries (covering ~1-2 hours during active days).
- Shape: `{"data": "location", "alertDate": "YYYY-MM-DDTHH:MM:SS", "category_desc": "title", "rid": number, ...}`
- `category_desc` is the alert title. Classify the same way.
- `rid` is a unique ID per entry — used for deduplication.
- Date filtering params are ignored — always returns latest entries.
- **Not used by the client UI** — only consumed by the ingestion worker to populate R2 day-history. The regular history API (~50-60 min coverage) fills the R2 lag for the timeline.

### Dual polling rationale
The live API is polled every 1s for immediate danger display. The history API is polled every 10s because all-clear events are short-lived in the live API and would be missed — the history API is the reliable source for state transitions to green.

### Other available endpoints (not currently used)
- `https://www.oref.org.il/alerts/alertCategories.json` — alert category definitions
- `https://www.oref.org.il/alerts/alertsTranslation.json` — localized alert text
- `https://www.oref.org.il/alerts/RemainderConfig_heb.json` — shelter duration per area
- `https://www.oref.org.il/alerts/alertHistoryCount.json` — summary alert count
- `https://www.oref.org.il/districts/districts_heb.json` — districts/areas list
- `https://www.oref.org.il/districts/cities_heb.json` — cities list with metadata
- `https://www.oref.org.il/districts/citiesNotes_heb.json` — per-city notes

### Geo-blocking
The Oref APIs geo-block non-Israeli IPs with **HTTP 403**. Pages Functions at `/api/*` check the colo — TLV users are proxied directly, non-TLV users get a 303 redirect to `/api2/*` which is handled by the placement-pinned Worker. See `docs/architecture.md` for details.

**Cloudflare Worker cron triggers do not obey placement** — a cron worker always runs from a non-Israeli colo. Only fetch-triggered workers (including the placement-pinned Worker at `/api2/*`) reliably run from TLV.

# currentDate
Today's date is 2026-03-04.
