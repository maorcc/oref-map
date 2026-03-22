# oref-map — Technical Design

## Overview

A static single-page web app showing live Pikud HaOref (Home Front Command) alerts as colored area polygons on a map of Israel. No build step — all JS/CSS is inline in `web/index.html`. Static assets deployed on Cloudflare Pages; API proxy uses a two-tier architecture: Pages Functions handle TLV-routed users directly, non-TLV users are redirected to a placement-pinned Worker.

## Stack

- **Map**: Leaflet.js (v1.9.4) + OpenStreetMap tiles
- **Voronoi**: d3-delaunay (v6) for polygon computation, polygon-clipping (v0.15) for clipping to Israel border
- **API proxy (tier 1)**: Cloudflare Pages Functions (`functions/api/`) — serves TLV users directly, redirects others
- **API proxy (tier 2)**: Cloudflare Worker (`worker/`) with placement `region = "azure:israelcentral"` — fallback for non-TLV users
- **History storage**: Cloudflare R2 bucket (`oref-history`) with per-day JSONL files
- **Ingestion**: Cloudflare Worker with cron trigger (`ingestion/`) — appends to R2 every 15 minutes
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
- Returns ~1 hour of recent alerts (entries expire by age, not by count).
- Reliable record of all alerts including all-clears. Used on page load to reconstruct initial state, and polled to catch all-clear events that would be missed in the live API. Also feeds into the timeline's `extendedHistory` to fill the R2 day-history lag.

### Extended History API
- **URL**: `https://alerts-history.oref.org.il//Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1`
- Returns up to ~3,000 entries covering ~1–2 hours.
- **Shape**: `{"data": "location", "alertDate": "YYYY-MM-DDTHH:MM:SS", "category_desc": "title", "rid": number, ...}`
- `rid` is a unique ID per entry — used for deduplication.
- **Modes**: `mode=0` (all), `mode=1` (24h), `mode=2` (7d), `mode=3` (month). City filter: `city_0=<name>`. Date filtering params are broken — always returns latest entries regardless.
- Not used by the client UI. The regular history API covers ~50-60 min, which fills the R2 lag for the timeline. The proxy endpoint (`/api/alarms-history`) is only used by the ingestion worker to populate R2.

### Why Dual Polling?

The live API is a snapshot — all-clear alerts may only last a few seconds and can be missed. The history API is the reliable source for state transitions to green. Polling it every 10s guarantees all-clears are caught.

### CORS

The Oref APIs don't include `Access-Control-Allow-Origin`. Both the Pages Functions (`/api/*`) and the Worker (`/api2/*`) run on the same domain (`oref-map.org`), so no CORS headers are needed.

### Geo-blocking / Israeli IP requirement

The Oref APIs geo-block non-Israeli IPs with **HTTP 403**. This was confirmed while building the `oref-logger` project: a Cloudflare Worker cron running from Zurich (`colo=ZRH`) got HTTP 403, while the same code triggered from Israel (`colo=TLV`) succeeded.

Previously, Pages Functions ran at the user's nearest Cloudflare edge. Users routed through non-Israeli edges (e.g., `FRA`, `ZRH`) got 403 errors because the proxy egressed from a non-Israeli IP.

**Important**: Cloudflare Worker **cron triggers do not obey placement** — a cron-triggered worker always runs from a non-Israeli colo, regardless of `[placement]` configuration. Only fetch-triggered workers reliably run from the placed region.

**Solution**: A two-tier proxy architecture:

1. **Pages Functions (`/api/*`)**: Check `request.cf.colo`. If TLV, proxy directly to Oref (free, no Worker invocation). If not TLV, return 303 redirect to `/api2/*`.
2. **Worker (`/api2/*`)**: Runs with placement `region = "azure:israelcentral"`, forcing execution at TLV regardless of the user's edge location.

The client detects the redirect via `resp.url` and permanently switches to `/api2/` for the rest of the session. This way the Worker only serves the small minority of non-TLV users.

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

Both the Pages Functions and the Worker use the Cloudflare Cache API (`caches.default`) with `s-maxage=1` to cache Oref responses at each edge for 1 second. This reduces redundant fetches when many clients poll simultaneously. The browser cache uses `max-age=2` (matching the previous behavior).

### Unknown title detection

The Pages Functions proxy (`functions/api/_proxy.js`) monitors all alert responses passing through the TLV path for unrecognized alert titles. When an unknown title is detected:

1. Check a 1-hour dedup cache (via Cloudflare Cache API) to avoid repeat notifications
2. Send a Pushover notification with the unknown title and API kind
3. Notification failures are silently swallowed — must not affect proxy behavior

This runs only on the TLV path since all Israeli traffic flows through it — the same titles are seen regardless of the user's colo.

## Alert Classification

Alerts are classified by **title text** only — category numbers are unreliable (same number reused for different types across APIs). Titles are normalized with `.replace(/\s+/g, ' ')` before matching (API sometimes uses double spaces).

| State | Color | Title match |
|-------|-------|-------------|
| Danger | Red | `ירי רקטות וטילים`, `נשק לא קונבנציונלי`, `חדירת מחבלים`, `היכנסו מייד למרחב המוגן`, `היכנסו למרחב המוגן` |
| Danger | Purple | `חדירת כלי טיס עוין` |
| Caution | Yellow | `בדקות הקרובות צפויות להתקבל התרעות באזורך`; substring: `לשפר את המיקום למיגון המיטבי`, `יש לשהות בסמיכות למרחב המוגן` |
| All-clear | Green | Substring: `האירוע הסתיים`, `ניתן לצאת` (excluding `להישאר בקרבתו`), `החשש הוסר`, `יכולים לצאת`, `אינם צריכים לשהות`, `סיום שהייה בסמיכות` |
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
- **Timeline panel**: Bottom-center — date navigation + slider to scrub through any day's history
- **About modal**: Triggered by ⓘ button or title click. Closes on backdrop click or Escape.
- **Popups**: Click a polygon to see alert history for that location (newest first).

All overlays use `position: fixed`, `z-index: 1000`, semi-transparent white backgrounds with `border-radius` and `box-shadow`. RTL layout throughout.

## Timeline

The timeline panel lets users scrub through alert history for any date since the war started (2026-02-28).

### Date navigation

Prev/next day buttons navigate between dates. Constrained to `DAY_HISTORY_MIN_DATE` (2026-02-28) through today. When viewing a past date, live polling is paused; switching back to today resumes it.

### Data source

The timeline fetches from `/api/day-history?date=YYYY-MM-DD` (backed by R2 storage), replacing the previous approach of fetching directly from the extended history API (which only covers the latest ~1–2 hours).

### State reconstruction

`reconstructStateAt(targetTime)` replays all history entries up to the target timestamp, applying the same priority-based state logic as live mode. The slider maps 0–999 to the day's time range. Transport buttons (prev/next event, play) navigate between event peaks.

### Previous design

The original timeline fetched the extended history API (`/api/alarms-history`) on each panel open. This limited the timeline to ~1–2 hours of recent data. The R2-backed approach gives access to the full history of the war. The regular history API (~1 hour coverage, polled every 10s) fills the R2 lag for the most recent events.

## History Storage

The Oref extended history API only exposes the latest ~3,000 entries (~1–2 hours during active days). To preserve the full record, alerts are ingested into R2 every 15 minutes and served by date.

### Architecture

```
  every 15 min (cron)
  [Ingestion Worker] ──fetch──> [proxy1 Worker] ──fetch──> [oref API]
                                (placement: israelcentral,
                                 different CF account)
         │
         └──append──> [R2: oref-history]   (comma-per-line JSONL per day)

  [Pages Function: /api/day-history] ──read──> [R2: oref-history] ──> client

  [Backfill script] ──fetch directly──> [oref API]  (runs locally from Israel)
         └──upload via wrangler CLI──> [R2: oref-history]
```

### Storage format

Each day is stored as two R2 objects:

- **`YYYY-MM-DD.jsonl`** — the data file, comma-per-line JSONL
- **`YYYY-MM-DD.complete`** — empty marker; presence means the day is fully ingested

Each entry occupies one line ending with `,\n`:

```
{"data":"חיפה","alertDate":"2026-03-15T14:23:00","category_desc":"ירי רקטות וטילים","rid":495134},
{"data":"תל אביב","alertDate":"2026-03-15T14:23:01","category_desc":"ירי רקטות וטילים","rid":495135},
```

**Why comma-per-line**: The serving endpoint converts to a JSON array with no JSON parsing:

```js
'[' + text.trimEnd().slice(0, -1) + ']'
```

For an empty file this produces `'[]'` — valid JSON.

### Ingestion worker (`ingestion/`)

A Cloudflare Worker with a cron trigger every 15 minutes (at `:03`, `:18`, `:33`, `:48`).

**Time window logic**: Each run is responsible for a fixed, non-overlapping 15-minute window derived from `event.scheduledTime` (not wall clock):

```
window = [scheduledTime - 30min,  scheduledTime - 15min)
```

Windows are contiguous — the next run's window starts exactly where the previous ended. Using `event.scheduledTime` means retries or delayed execution don't corrupt window boundaries.

**`scheduledTime` has non-zero seconds**: Despite being a cron trigger, `event.scheduledTime` can include seconds (e.g., `:03:39` instead of `:03:00`). Since oref `alertDate` values always have `:00` seconds, the string comparison `>=`/`<` would misalign window boundaries. The code snaps `scheduledTime` to the nearest cron schedule point (minutes 3, 18, 33, 48) to ensure clean `:00` second boundaries.

**Israel time conversion**: `alertDate` values from the API are in Israel time. Window bounds (UTC timestamps) are converted using `Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jerusalem' })` for string comparison.

**Processing**:
1. Fetch from proxy1 Worker (`/api2/alarms-history`) — see [why proxy1](#why-proxy1-not-history-proxy) below
2. Strip BOM, parse JSON (~3,000 entries, ~50KB)
3. Filter to entries within the time window
4. Map to 4 fields: `{ data, alertDate, category_desc, rid }`
5. Sort by `alertDate`, group by date
6. For each date: read existing `.jsonl` from R2, append new entries, write back
7. At midnight crossing (`startDate < endDate`): write `.complete` marker for the completed day

**Observability**: `[observability] enabled = true` in wrangler.toml persists logs to the Cloudflare dashboard. Console logs include window boundaries, entry counts, and R2 write details for each cron run.

**Error handling**: On fetch failure after 3 retries (delays: 5s, 15s, 45s), sends a Pushover notification and aborts. R2 write failures and CPU limit crashes are **not** notified — check dashboard logs.

### Day-history API (`functions/api/day-history.js`)

Pages Function serving R2 data as JSON.

- **Endpoint**: `GET /api/day-history?date=YYYY-MM-DD`
- Validates date format, returns 400 if invalid
- Reads `YYYY-MM-DD.jsonl` from R2, returns 404 if not found
- Converts comma-per-line JSONL to JSON array
- **Caching**: completed days (`.complete` exists) → `max-age=3600` (1 hour); ongoing days → `max-age=60` (1 minute)
- **Local dev**: If `HISTORY_BUCKET` binding is absent, proxies to production

### Backfill script (`tools/backfill_history.py`)

Python script for manually filling historical data. Fetches all ~1,450 cities from the Oref API (`mode=3`, month of data per city), deduplicates by `rid`, groups by date.

**Usage**:
```bash
uv run tools/backfill_history.py            # WAR_START..yesterday, interactive
uv run tools/backfill_history.py --today    # merge today first (no prompt), then interactive
```

**Interactive mode** (past dates): Downloads the existing R2 file for each date, compares `rid` sets, shows a diff summary, saves both versions to `tmp/backfill-compare/`, and prompts per date.

**`--today` mode**: Merges backfill data with the existing R2 file for today (union by `rid`). Uses a **cron-aware cutoff** — only includes backfill entries before the last completed cron window boundary (`:03`, `:18`, `:33`, `:48`) to avoid creating duplicates when the next cron run appends. Prints a timing summary with margin to next cron. Does not write `.complete` (day is ongoing).

### Why proxy1, not history-proxy

The ingestion worker was originally designed to fetch from a dedicated `history-proxy` worker on the same Cloudflare account. This failed with **Cloudflare error 1042** — workers on the same account cannot call each other via HTTP fetch.

Additionally, **cron triggers do not obey worker placement** — the ingestion cron always runs from a non-Israeli colo, so it cannot call the Oref API directly (would get 403).

The solution: the ingestion worker calls `proxy1.oref-proxy1.workers.dev` — a proxy worker on a **different** Cloudflare account with placement `region = "azure:israelcentral"`. Cross-account HTTP calls work fine, and the proxy1 worker runs from TLV when fetch-triggered.

The `history-proxy/` directory still exists in the repo but is not deployed via CI. It was useful for manual testing with its `X-Ingest-Key` auth.

### Design alternatives considered

| Approach | Why rejected |
|----------|-------------|
| **history-proxy on same account** | Cloudflare error 1042 — same-account workers can't call each other |
| **Ingestion calls Oref API directly** | Cron triggers ignore placement — runs from non-Israeli colo, gets 403 |
| **Move ingestion to proxy1 account** | R2 bucket is on the Pages account; R2 bindings are per-account, can't cross |
| **Chunk-based writes** (write each 15-min window as separate R2 object, merge at midnight) | Would eliminate the read+append+write CPU cost, but complicates serving for the current day — rejected in favor of upgrading to a paid plan |

### CPU considerations

The ingestion worker's read+append+write pattern means CPU usage grows throughout the day as the `.jsonl` file gets larger. On the free plan (10ms CPU limit for cron), this caused the cron to be silently disabled after repeated CPU limit violations. Upgrading to a paid Cloudflare plan (15 min CPU limit) resolved this.

## Deployment

```sh
./web-dev                          # npx wrangler pages dev web/ — local dev server
./deploy                           # npx wrangler pages deploy web/ — deploy static assets
cd worker && npx wrangler deploy   # deploy API proxy Worker
cd ingestion && npx wrangler deploy  # deploy ingestion Worker
```

GitHub Actions (`.github/workflows/deploy.yml`) deploys on push to `main`:

| Job | What it deploys | Account |
|-----|----------------|---------|
| `deploy-pages` | Static assets + Pages Functions | Pages account |
| `deploy-workers` | proxy1, proxy2, proxy3 Workers | Per-proxy accounts |
| `deploy-ingestion` | Ingestion cron Worker | Pages account |

The Pages project serves static assets and Pages Functions (`/api/*`). The proxy Workers handle `/api2/*` via Workers routes on `oref-map.org`, serving as fallback for non-TLV users.

### Cloudflare accounts

Multiple Cloudflare accounts are used to work around platform limitations:

- **Pages account** — hosts the Pages project, Pages Functions, R2 bucket, and ingestion worker
- **proxy1/proxy2/proxy3 accounts** — host the placement-pinned proxy Workers. Separate accounts avoid error 1042 and distribute request volume across free-plan limits

### Secrets

| Worker | Secrets |
|--------|---------|
| Ingestion | `PUSHOVER_USER`, `PUSHOVER_TOKEN` (error notifications) |
| history-proxy | `INGEST_SECRET` (API key for manual access) |
| Pages Functions | `PUSHOVER_USER`, `PUSHOVER_TOKEN` (unknown title notifications) |
