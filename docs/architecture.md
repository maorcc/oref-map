# oref-map — Technical Design

## Overview

A static single-page web app showing live Pikud HaOref (Home Front Command) alerts as colored area polygons on a map of Israel. No build step — all JS/CSS is inline in `web/index.html`. Static assets are deployed on Cloudflare Pages. All Oref traffic goes through a **relay** (`oref-relay/`) that runs on a residential Israeli connection and is exposed through a Cloudflare Tunnel, because Oref blocks datacenter and cloud IPs (see [Access to Oref](#access-to-oref-geo-blocking-and-cloudfront)).

Note: the displayed visitor count comes from the Pages Function at `/api/analytics`,
which queries Cloudflare analytics and returns aggregated visit counts for the last
hour and last 24 hours. The client polls this endpoint once per minute.

## Stack

- **Map**: MapLibre GL JS + PMTiles (self-hosted Middle East extract on Cloudflare R2, Protomaps basemap with Hebrew labels)
- **Polygons**: Pre-computed GeoJSON in `web/locations_polygons.json` loaded at startup into a MapLibre `alerts-source`
- **API entry point**: Cloudflare Pages Functions (`functions/api/`): 303-redirect every `/api/*` alert request to the relay
- **Relay**: Node/Express (`oref-relay/index.js`) on a residential Israeli connection, behind a Cloudflare Tunnel; polls Oref and serves `/api2/*` from memory
- **History storage**: Cloudflare R2 bucket (`oref-history`) with per-day JSONL files
- **Ingestion**: Cloudflare Worker with cron trigger (`ingestion/`): fetches the relay's `/api2/alarms-history` and appends to R2 every 2 minutes, with multiple attempts per 15-min window
- **No frameworks**: Vanilla JS, CSS

## Data Sources

### Live Alerts API
- **Proxy**: `/api/alerts` → relay `/api2/alerts` → `https://www.oref.org.il/warningMessages/alert/Alerts.json`
- **Poll interval**: 1 second (both the client and the relay)
- **Shape**: `{"id", "cat", "title", "data": ["location", ...], "desc"}`
- `data` is an **array** of location strings.
- Returns a BOM-only (`\ufeff`) body when no alert is active.
- Snapshot of what's active *right now* — short-lived alerts can be missed between polls.

### History API
- **Proxy**: `/api/history` → relay `/api2/history` → `https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json`
- **Poll interval**: 10 seconds (both the client and the relay)
- **Shape**: `[{"alertDate": "YYYY-MM-DD HH:MM:SS", "title", "data": "location", "category"}, ...]`
- `data` is a **string** (single location), unlike the live API.
- Returns ~1 hour of recent alerts (entries expire by age, not by count).
- Reliable record of all alerts including all-clears. Used on page load to reconstruct initial state, and polled to catch all-clear events that would be missed in the live API. Also feeds into the timeline's `extendedHistory` to fill the R2 day-history lag.

### Extended History API
- **Proxy**: relay `/api2/alarms-history` → `https://www.oref.org.il/api/v1/AlertHistory/heb?from=…&to=…&cities=`
- The relay fetches the **last 60 minutes**, following the API's paging (200 per page). Ingestion needs about 26 minutes back (its window start, at its last retry), but the cutoff is set from the relay's clock, so the extra 30 minutes cover a late cron run; a list that starts after the window began would be marked done with entries missing. The busiest hour of the 2026 war had about 5,400 entries (28 pages); a safety cap of 50 pages makes the relay answer 502 rather than return a partial list. It converts each entry to the shape of the retired `GetAlarmsHistory.aspx`: `{"data", "alertDate": "YYYY-MM-DDTHH:MM:SS", "category", "category_desc", "rid"}`. Results are sorted newest first.
- `alertDate` has **exact seconds** (the new API's `time` field). Entries ingested before 2026-11 have seconds rounded to `:00`, because the old API rounded to the nearest minute.
- `rid` is a unique ID per entry — used for deduplication.
- Until late 2026 the source was `alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx`, which no longer resolves. Details of both APIs are in [`oref-sources.md`](oref-sources.md).
- Not used by the client UI. Only the ingestion worker calls it, to populate R2. The regular history API (~50-60 min coverage) fills the R2 lag for the timeline.

### Why Dual Polling?

The live API is a snapshot — all-clear alerts may only last a few seconds and can be missed. The history API is the reliable source for state transitions to green. Polling it every 10s guarantees all-clears are caught.

### CORS

`/api/*` on `oref-map.org` answers with a 303 to the relay's own hostname, so the browser's follow-up request is cross-origin. The relay sends `Access-Control-Allow-Origin` only for an allowlist: `https://oref-map.org` plus local dev origins (`DEFAULT_ALLOWED_ORIGINS` in `oref-relay/index.js`, overridable with the `CORS_ALLOWED_ORIGINS` env var). This is why the dev server must be browsed as `http://localhost:8788` (see `CLAUDE.md`).

### Access to Oref: geo-blocking and CloudFront

**Current state (since late November 2026).** `www.oref.org.il` moved from Akamai to **AWS CloudFront**. CloudFront's WAF returns **403** to datacenter and cloud IPs **even inside Israel**: Cloudflare Pages Functions and placement-pinned Workers at colo TLV, and an Oracle Cloud VM in Jerusalem, were all verified blocked. Only residential connections get through. `/api/v1/*` and the static JSON files additionally require a full browser `User-Agent`, which the relay sends on every call. Details in [`oref-sources.md`](oref-sources.md#access-rules-as-of-2026-11-27).

So no Cloudflare-hosted code can talk to Oref anymore, and every path goes through the relay:

```text
Browser ──/api/{alerts,history}──> Pages Function ──303──> relay (Cloudflare Tunnel) ──> www.oref.org.il
Ingestion cron ──/api2/alarms-history──────────────────────> relay ──> www.oref.org.il/api/v1/AlertHistory
```

The relay is a **single point of failure**: if it or its connection goes down, the live map and ingestion stop, while `oref-map.org` itself keeps answering 200. The earliest warning is the ingestion worker's "missed window" Pushover alert.

**Before late 2026 (Akamai era).** Oref blocked only non-Israeli IPs, so a Cloudflare Worker running in Israel was enough. The design then was a two-tier proxy: Pages Functions fetched Oref directly when `request.cf.colo` was TLV, and redirected everyone else to `/api2/*` Workers pinned to Israel with placement. That code still exists (`fetchOrefDirect` in `functions/api/_proxy.js`, reachable only with `?debugapi=oref-direct`, and `worker/`) but gets 403 now.

**Cloudflare Worker cron triggers do not obey placement**: a cron-triggered worker always runs from a non-Israeli colo, regardless of `[placement]`. This is why ingestion always had to go through a proxy.

#### Placement investigation notes (Akamai era, historical)

Several placement strategies were tested before finding one that worked:

| Strategy | Result |
|----------|--------|
| Smart Placement (Pages) | Unreliable — sometimes ran locally at non-Israeli colos |
| `hostname = "www.oref.org.il"` | Placed Worker in Seattle (SEA) — Oref used Akamai with anycast IPs, so the probe found a non-Israeli edge |
| `region = "aws:il-central-1"` | Placed Worker at ZDM, not TLV — still got 403 |
| `host = "<Israeli IP>:443"` | Worked from Israel but not consistently from other locations |
| `region = "azure:israelcentral"` | Reliably placed Worker at TLV — confirmed working from FRA, TLV, and other colos |

### Caching

The relay polls `Alerts.json` every 1s and `AlertsHistory.json` every 10s and serves both from memory, so client load never reaches Oref. Extended history is fetched on demand and cached for 60s. Responses carry `Cache-Control: s-maxage=1, max-age=2`.

**Failure behavior** (`/status` on the relay shows `updatedAt` for each cache):
- `/api2/alarms-history` returns **502** when the upstream fetch fails. This lets the ingestion worker retry and, if every attempt in a window fails, send its Pushover alert. Before 2026-11 it returned the last cache (or `[]`) with 200, which hid a dead upstream for weeks.
- `/api2/alerts` and `/api2/history` return **503** once their last successful poll is older than 15 s (alerts) or 60 s (history), and before the first one. The map then shows its connection-error status after a few failed polls, instead of a blocked relay looking like a quiet day. Until 2026-11 they kept serving the last cached body with 200. Each Oref request times out after 10 s, so a hung fetch can't stall a poll loop.
- On every alert-check run (every 15 min), the ingestion worker reads the relay's `/status` and sends a Pushover alert ("oref-map relay: live data stale") if alerts or history weren't updated for over 2 minutes, or if `/status` can't be read.

### Unknown title detection

`checkAndNotifyUnknownTitles` in `functions/api/_proxy.js` sends a Pushover notification (deduplicated for 1 hour via the Cache API) when a response contains an alert title that `isKnownTitle` doesn't recognize.

**It is effectively inactive**: it runs only inside `fetchOrefDirect`, the Pages Function's direct-fetch path, which no longer serves traffic (everything is redirected to the relay) and gets 403 from Oref. Its title list is also behind the client's `classifyTitle`.

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

### Polygons

Location polygons are pre-computed offline and shipped as `web/locations_polygons.json`. On startup the page fetches this file and loads all ~1,450 features into the MapLibre `alerts-source` GeoJSON source. Each feature's `fillColor`, `fillOpacity`, `lineColor`, and `lineOpacity` properties are updated in place via `setData()` whenever alert state changes — no layer recreation needed.

- Adjacent polygons of the same color visually merge into contiguous threat zones (shared borders become invisible due to matching stroke color).
- Per-feature state is driven by data properties, not Leaflet `setStyle`.
- The `featureMap` lookup (`name → GeoJSON Feature`) is exposed on `AppState` for use by extensions (e.g. ellipse mode).

### Basemap Tiles (PMTiles on R2)

The basemap is a self-hosted Protomaps vector tile file stored on Cloudflare R2 and served via the R2 public bucket URL:

```text
https://pub-0cb002f302e94002b76aa0bc30eb8763.r2.dev/middle-east.pmtiles
```

**Current file coverage:**

| Property | Value |
|----------|-------|
| File | `middle-east.pmtiles` |
| Bounds (lng) | 22.0 – 73.0 |
| Bounds (lat) | 3.0 – 50.0 |
| Zoom | 0 – 10 |
| Built | 2026-04-11 (pmtiles extract, OSM data 2026-04-09) |

This covers Israel, Lebanon, Syria, Jordan, Iraq, Iran, Saudi Arabia, Egypt, Libya (east), the Gulf states, Yemen, Horn of Africa, Turkey, the Caucasus, and Pakistan border.

#### Inspecting the current file

```bash
npx pmtiles show https://pub-0cb002f302e94002b76aa0bc30eb8763.r2.dev/middle-east.pmtiles
```

#### Regenerating with a larger bounding box

The current file was generated with **Planetiler** (v0.10.1, run locally). For future updates the recommended approach is the `pmtiles` CLI, which uses HTTP range requests to extract only the needed tiles from Protomaps' hosted planet — no 120 GB download required.

**Option A — `pmtiles extract` CLI (recommended for one-off changes):**

Install: `brew install protomaps/homebrew-go-pmtiles/go-pmtiles`

Find a recent build date at https://maps.protomaps.com/builds/, then run:
```bash
pmtiles extract https://build.protomaps.com/20260409.pmtiles middle-east.pmtiles \
  --bbox=22,3,73,50 --maxzoom=10 --download-threads=4
```
bbox format: `MIN_LON,MIN_LAT,MAX_LON,MAX_LAT`. Replace the date with the one from the builds index. The command fetches only the tiles in the bbox via HTTP range requests (a few GB, not 120 GB).

> **Do not use `slice.openstreetmap.us`** — that site downloads raw `.osm.pbf` data (OSM XML/binary), not `.pmtiles`.

**Option B — Planetiler (best for full control or custom schemas):**
```bash
java -jar planetiler.jar \
  --download \
  --area=middle-east \
  --bounds=22,3,73,50 \
  --output=middle-east-extended.pmtiles
```

Both produce the same `protomaps` basemap schema — the map code works identically with either output.

2. **Upload to R2** using Wrangler (bucket name visible in Cloudflare dashboard → R2):
   ```bash
   wrangler r2 object put <bucket-name>/middle-east.pmtiles \
     --file=middle-east.pmtiles \
     --content-type=application/vnd.mapbox-vector-tile
   ```
   The public URL (`pub-0cb002...r2.dev`) does not change after upload.

3. **Update `maxBounds` in `web/index.html`** to match the new lat extent (e.g. `[[32.0, 10.0], [65.0, 42.0]]` for Yemen coverage).

#### R2 bucket info

- **Public URL**: `https://pub-0cb002f302e94002b76aa0bc30eb8763.r2.dev/`
- **Public access**: enabled — the client fetches tiles directly from R2 at runtime via the `pmtiles://` protocol, no Worker involved.
- Bucket name is visible in Cloudflare dashboard → R2.

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
- **Location panel**: Click a polygon to open a slide-in panel with alert history for that location (bottom-sheet on mobile, sidebar on desktop).

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

The relay exposes only the last 60 minutes of the archive (the retired endpoint exposed the latest ~3,000 entries). To preserve the full record, alerts are ingested into R2 every 2 minutes (with multi-attempt per 15-minute window) and served by date.

### Architecture

```text
  every 2 min (cron, multi-attempt per 15-min window)
  [Ingestion Worker] ──fetch──> [relay /api2/alarms-history] ──fetch──> [oref /api/v1/AlertHistory]
                                (residential Israeli IP,
                                 Cloudflare Tunnel)
         │
         └──append──> [R2: oref-history]   (comma-per-line JSONL per day)

  [Pages Function: /api/day-history] ──read──> [R2: oref-history] ──> client

  [Backfill script] ──fetch directly──> [oref API]  (runs locally from Israel)
         └──upload via wrangler CLI──> [R2: oref-history]
```

### Storage format

Each day is stored as a single R2 object:

- **`YYYY-MM-DD.jsonl`** — comma-per-line JSONL

Each day file covers events from `(D-1)T23:00` to `DT22:59` (Israel time). Events with `alertDate` hour ≥ 23 are stored in the **next** day's file. This ensures that just after midnight, today's R2 file already contains yesterday's late-night events.

Each entry occupies one line ending with `,\n`:

```json
{"data":"חיפה","alertDate":"2026-03-15T14:23:00","category_desc":"ירי רקטות וטילים","rid":495134},
{"data":"תל אביב","alertDate":"2026-03-15T14:23:01","category_desc":"ירי רקטות וטילים","rid":495135},
```

**Why comma-per-line**: The serving endpoint converts to a JSON array with no JSON parsing:

```js
'[' + text.trimEnd().slice(0, -1) + ']'
```

For an empty file this produces `'[]'` — valid JSON.

### Ingestion worker (`ingestion/`)

A Cloudflare Worker with a cron trigger every 2 minutes (`1/2 * * * *`, odd minutes: :01, :03, ..., :59).

**Multi-attempt design**: Each 15-minute window gets ~6 fetch attempts (one every 2 min) plus a final alert-check. This replaced the previous single-shot-per-window design, which silently missed entries during heavy salvos (March 28-30 incident).

**Timeslot markers**: An R2 object `meta/<timeslot>` (e.g., `meta/2026-03-28T14:15`) tracks whether a window has been processed. Once a timeslot is marked, subsequent cron runs skip it immediately (single `head()` call). Markers older than 2 hours are cleaned up on alert-check runs.

**Time window logic**: Each run ingests a fixed 15-minute quarter-hour block, determined by `event.scheduledTime` (Israel time):

| Scheduled minute (Israel) | Window ingested | Role |
|---|---|---|
| :01–:11 | [XX:45, XX+1:00) | Fetch attempts |
| :13 | [XX:45, XX+1:00) | **Alert check** |
| :15 | Dead zone | — |
| :17–:25 | [XX:00, XX:15) | Fetch attempts |
| :27 | [XX:00, XX:15) | **Alert check** |
| :29, :31 | Dead zone | — |
| :33–:41 | [XX:15, XX:30) | Fetch attempts |
| :43 | [XX:15, XX:30) | **Alert check** |
| :45 | Dead zone | — |
| :47–:55 | [XX:30, XX:45) | Fetch attempts |
| :57 | [XX:30, XX:45) | **Alert check** |
| :59 | Dead zone | — |

**Alert-check runs** (at :13, :27, :43, :57) do NOT fetch — they only check if the marker exists. If not, a Pushover notification is sent ("missed window"). This separation ensures notifications fire even if the fetch path is broken (CPU/memory crash, proxy down). Alert-check runs also clean up old markers.

**Israel time conversion**: `alertDate` values from the API are in Israel time. Window bounds are converted using `Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jerusalem' })` for string comparison.

**R2 date key**: Events are grouped by `r2DateKey(alertDate)` — events with hour ≥ 23 go to the next day's file (see [Storage format](#storage-format)).

**Processing** (fetch attempts only):
1. Check R2 marker — if exists, skip (already processed)
2. Single `fetch()` to `${HISTORY_PROXY_URL}/api2/alarms-history` (the relay) — no in-process retries; cron cadence provides retries
3. Strip BOM, parse JSON (the last 60 minutes)
4. Filter to entries within the time window
5. Map to 4 fields: `{ data, alertDate, category_desc, rid }`
6. Sort by `alertDate`, group by R2 date key (events 23:xx → next day's file)
7. For each date: read existing `.jsonl` from R2, append new entries, write back
8. Write timeslot marker to R2

**Observability**: `[observability] enabled = true` in wrangler.toml persists logs to the Cloudflare dashboard. Console logs include timeslot, window boundaries, entry counts, R2 write details, marker status, and cleanup counts.

**Error handling**: On fetch failure (any non-2xx, including the relay's 502 when Oref can't be reached), the run exits without writing a marker — the next cron fires 2 minutes later. If all attempts fail, the alert-check sends a Pushover notification, so an outage must last about 10 minutes to trigger it. R2 write failures and CPU limit crashes are **not** notified — check dashboard logs.

**Silent-gap incident (2026-10/11)**: the old upstream hostname stopped resolving sometime between 2026-10-19 and 2026-11-08. The relay kept answering `200 []`, so every window was marked processed with 0 entries and no alert fired. R2 has no data for that period until it is backfilled. The relay now returns 502 on upstream failure; markers hold the entry count, so a run of `0` markers during known alerts is the tell-tale sign.

### Day-history API (`functions/api/day-history.js`)

Pages Function serving R2 data as JSON.

- **Endpoint**: `GET /api/day-history?date=YYYY-MM-DD`
- Validates date format, returns 400 if invalid
- Reads `YYYY-MM-DD.jsonl` from R2, returns 404 if not found
- Converts comma-per-line JSONL to JSON array
- **Caching**: past days (`date < today`) → `max-age=3600` (1 hour); today → `max-age=60` (1 minute)
- **Local dev**: If `HISTORY_BUCKET` binding is absent, proxies to production

### Backfill script (`tools/backfill_history.py`)

Python script for manually filling historical data. Fetches all ~1,450 cities from the Oref API (`mode=3`, month of data per city), deduplicates by `rid`, groups by date.

**Usage**:
```bash
uv run tools/backfill_history.py            # WAR_START..yesterday, interactive
uv run tools/backfill_history.py --today    # merge today first (no prompt), then interactive
```

**Interactive mode** (past dates): Downloads the existing R2 file for each date, compares `rid` sets, shows a diff summary, saves both versions to `tmp/backfill-compare/`, and prompts per date.

**`--today` mode**: Merges backfill data with the existing R2 file for today (union by `rid`). Uses a **cron-aware cutoff** — only includes backfill entries before the last completed quarter-hour boundary (`:00`, `:15`, `:30`, `:45`, available 3 min after each) to avoid creating duplicates when the next cron run appends. Prints a timing summary with margin to next cron.

Both modes use `r2_date_key()` to group events — entries with `alertDate` hour ≥ 23 go to the next day's file, matching the ingestion worker's partitioning.

### Why ingestion goes through the relay

**Cron triggers do not obey worker placement**: the ingestion cron always runs from a non-Israeli colo, so it could never call Oref directly. Since late 2026 CloudFront also blocks every Cloudflare egress IP, so no Worker can reach Oref at all. The ingestion worker therefore fetches from the relay (`HISTORY_PROXY_URL` in `ingestion/wrangler.toml`).

History of earlier attempts:
- A dedicated `history-proxy` worker on the same account failed with **Cloudflare error 1042**: workers on the same account cannot call each other via HTTP fetch. The `history-proxy/` directory is still in the repo but is not deployed.
- The ingestion worker then called `proxy1`, a placement-pinned Worker on a **different** Cloudflare account. It has called the relay instead since 2026-08 (the deployed version from 2026-08-01 already does). `proxy1` could not work today: CloudFront blocks it.

### Design alternatives considered

| Approach | Why rejected |
|----------|-------------|
| **history-proxy on same account** | Cloudflare error 1042 — same-account workers can't call each other |
| **Ingestion calls Oref API directly** | Cron triggers ignore placement (non-Israeli colo), and CloudFront blocks Cloudflare IPs anyway — 403 |
| **Move ingestion to proxy1 account** | R2 bucket is on the Pages account; R2 bindings are per-account, can't cross |
| **Chunk-based writes** (write each 15-min window as separate R2 object, merge at midnight) | Would eliminate the read+append+write CPU cost, but complicates serving for the current day — rejected in favor of upgrading to a paid plan |

### CPU considerations

The ingestion worker's read+append+write pattern means CPU usage grows throughout the day as the `.jsonl` file gets larger. On the free plan (10ms CPU limit for cron), this caused the cron to be silently disabled after repeated CPU limit violations. Upgrading to a paid Cloudflare plan (15 min CPU limit) resolved this.

## Deployment

```sh
./web-dev                            # npx wrangler pages dev web/ — local dev server
./deploy                             # npx wrangler pages deploy web/ — deploy static assets
cd ingestion && npx wrangler deploy  # deploy ingestion Worker
```

GitHub Actions (`.github/workflows/deploy.yml`) deploys on push to `main`:

| Job | What it deploys | Account |
|-----|----------------|---------|
| `deploy-pages` | Static assets + Pages Functions | Pages account |
| `deploy-workers` | proxy1, proxy2, proxy3 Workers (legacy, see below) | Per-proxy accounts |
| `deploy-ingestion` | Ingestion cron Worker | Pages account |

The Pages project serves static assets and Pages Functions (`/api/*`). The proxy Workers (`worker/`) are still deployed by CI but carry no traffic: the Pages Functions redirect to the relay, and CloudFront blocks the Workers' egress IPs anyway.

**The relay is not deployed by CI.** It runs as a long-lived Node process plus `cloudflared` on its host and is updated by hand: copy `oref-relay/index.js`, restart the service, then check `/status` (all three `updatedAt` values should be recent once `/api2/alarms-history` has been requested). Setup notes are in `oref-relay/README.txt`. Its host must have a residential Israeli IP (see [Access to Oref](#access-to-oref-geo-blocking-and-cloudfront)).

### Cloudflare accounts

Multiple Cloudflare accounts are used to work around platform limitations:

- **Pages account** — hosts the Pages project, Pages Functions, R2 bucket, ingestion worker, and the relay's Cloudflare Tunnel
- **proxy1/proxy2/proxy3 accounts** — host the legacy placement-pinned proxy Workers. Separate accounts avoided error 1042 and spread request volume across free-plan limits

### Secrets

| Worker | Secrets |
|--------|---------|
| Ingestion | `PUSHOVER_USER`, `PUSHOVER_TOKEN` (error notifications) |
| history-proxy | `INGEST_SECRET` (API key for manual access) |
| Pages Functions | `PUSHOVER_USER`, `PUSHOVER_TOKEN` (unknown title notifications) |
