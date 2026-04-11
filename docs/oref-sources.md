# Oref API Data Sources

All endpoints under `www.oref.org.il` require these headers:
- `Referer: https://www.oref.org.il/`
- `X-Requested-With: XMLHttpRequest`

All endpoints are **geo-blocked** — non-Israeli IPs receive HTTP 403.

## www.oref.org.il

| URL | Purpose |
|---|---|
| `/warningMessages/alert/Alerts.json` | **Live alerts** — current active alert snapshot, polled every ~1s. Returns JSON or BOM-only empty body when no alert. |
| `/warningMessages/alert/History/AlertsHistory.json` | **History** — ~1 hour of recent alerts. Reliable source for state transitions (including all-clears). |
| `/alerts/alertHistoryCount.json` | Summary alert count |
| `/alerts/alertCategories.json` | Alert category definitions |
| `/alerts/alertsTranslation.json` | Localized alert text |
| `/alerts/RemainderConfig_{lang}.json` | Shelter duration per area (e.g. how long to stay in shelter) |
| `/districts/districts_{lang}.json` | Districts/areas list. Contains ~1,492 entries. Excludes ~34 legacy "old alert zones" (`אזור התרעה ישן`) that still appear in `GetDistricts.aspx`. Includes a `rashut` (municipality) field not present in `GetDistricts.aspx`. |
| `/districts/cities_{lang}.json` | Cities list with metadata |
| `/districts/citiesNotes_{lang}.json` | Per-city notes |
| `/translations/dictionary.{lang}.json` | General UI translation dictionary |

## City name character encoding

City names containing apostrophes use ASCII characters: single quote `'` (U+0027) and double quote `''` for gershayim. Examples: `ג'לג'וליה`, `ייט''ב`.

In late March 2026, the oref API briefly switched to Hebrew typographic characters: geresh `׳` (U+05F3) and gershayim `״` (U+05F4). This broke city lookups in both the backfill script (`city_0` filter) and the client's geocoding (names didn't match `cities_geo.json`). The change was reverted within days — the API returned to ASCII apostrophes.

**Defensive code**: `normalizeGeresh()` in `web/index.html` converts Hebrew geresh/gershayim back to ASCII at all ingestion points. Currently a no-op, but protects against a future recurrence. The backfill script queries both ASCII and Hebrew character variants for cities with apostrophes.

## alerts-history.oref.org.il

| URL | Purpose |
|---|---|
| `/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1` | **Extended history** — up to 3,000 recent alert entries. Supports `mode=0` (all), `mode=1` (24h), `mode=2` (7d), `mode=3` (month). The 3,000 entry cap can truncate the time window during heavy activity (e.g. mode=1 may cover only a few hours). Optional `city_0=<name>` filter. Used by ingestion worker only, not the client UI. |
| `/Shared/Ajax/GetCities.aspx?lang=he` | Cities list for autocomplete search |
| `/Shared/Ajax/GetDistricts.aspx?lang=he` | District/area data. Contains ~1,526 entries — a superset of `districts_heb.json`, including ~34 legacy "old alert zones" (`אזור התרעה ישן`) that have been merged into other locations. Does **not** include the `rashut` (municipality) field. |
| `/Shared/Ajax/GetCitiesMix.aspx?lang=he` | Mixed city+area list (used when "area mode" is enabled in the autocomplete) |
