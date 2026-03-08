# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project

`oref-map` is a live alert map of Israel ("מפת העורף") showing colored Voronoi area polygons for alert statuses per location. It uses Leaflet + OpenStreetMap + d3-delaunay + polygon-clipping. Static assets on Cloudflare Pages; API proxy is a Cloudflare Worker with placement pinned to Israel.

**Public URL**: https://oref-map.org

## Commands

```bash
./web-dev                          # start dev server at http://localhost:8787 (wrangler pages dev)
./deploy                           # deploy static assets to Cloudflare Pages
cd worker && npx wrangler deploy   # deploy API proxy Worker
```

## Structure

- `web/index.html` — Single-file map page (all JS/CSS inline)
- `web/cities_geo.json` — Location → [lat, lng] lookup
- `worker/src/index.js` — Cloudflare Worker: proxies all Oref APIs (placement: `azure:israelcentral`)
- `worker/wrangler.toml` — Worker configuration with placement and route
- `docs/map-requirements.md` — Feature requirements doc

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
- Returns array of recent alerts: `{"alertDate", "title", "data": "location", "category"}`
- `data` is a **string** (single location), unlike the live API.
- `alertDate` format: `"YYYY-MM-DD HH:MM:SS"`
- Reliable record of all alerts including all-clears. Use this to reconstruct current state on page load.

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
| `ירי רקטות וטילים - האירוע הסתיים` | Rocket event over | 🟢 Green (fades) |
| `חדירת כלי טיס עוין - האירוע הסתיים` | Aircraft event over | 🟢 Green (fades) |
| `ניתן לצאת מהמרחב המוגן` | Can leave shelter | 🟢 Green (fades) |
| `ניתן לצאת מהמרחב המוגן אך יש להישאר בקרבתו` | Can leave but stay close (wartime baseline) | 🟢 Green (fades) |
| `חדירת מחבלים - החשש הוסר` | Terrorist threat removed | 🟢 Green (fades) |
| `השוהים במרחב המוגן יכולים לצאת...` | Shelter occupants can exit | 🟢 Green (fades) |

- Green titles are matched by substring (`האירוע הסתיים`, `ניתן לצאת`, `החשש הוסר`, `יכולים לצאת`) to catch variants.
- Yellow preparedness notice is matched by substring `לשפר את המיקום למיגון המיטבי`.
- API sometimes uses double spaces in titles — normalize with `.replace(/\s+/g, ' ')` before matching.
- Unknown titles default to Red and log a console warning.

### Extended History API
- **URL**: `https://alerts-history.oref.org.il//Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1`
- Returns up to 3,000 recent alert entries (covering ~1-2 hours during active days).
- Shape: `{"data": "location", "alertDate": "YYYY-MM-DDTHH:MM:SS", "category_desc": "title", "rid": number, ...}`
- `category_desc` is the alert title. Classify the same way.
- `rid` is a unique ID per entry — used for deduplication.
- Date filtering params are ignored — always returns latest entries.
- Used by the timeline slider to reconstruct map state at any point in the past ~1-2 hours.

### Dual polling rationale
The live API is polled every 1s for immediate danger display. The history API is polled every 10s because all-clear events are short-lived in the live API and would be missed — the history API is the reliable source for state transitions to green.

### Geo-blocking
The Oref APIs geo-block non-Israeli IPs. Our proxy works because Israeli users route through Cloudflare's TLV edge. Users routed through non-Israeli edges will get 403 errors. See `docs/architecture.md` for details.

# currentDate
Today's date is 2026-03-04.
