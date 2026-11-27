# Oref API Data Sources

## Access rules (as of 2026-11-27)

`www.oref.org.il` is served through **AWS CloudFront** (it was on Akamai until late
November 2026; the old Akamai edges now answer 503 to everything). CloudFront's WAF
decides by **network type**, not by country:

- Requests from datacenter / cloud IPs get **403 "Request blocked"**, even from inside
  Israel. Verified blocked: Cloudflare Pages Functions and placement-pinned Workers at
  colo TLV, and an Oracle Cloud VM in Jerusalem.
- Requests from a residential Israeli connection get 200.
- Non-Israeli IPs are blocked as before (403).

On top of that, some paths also require a **full browser `User-Agent`** string. Node's
default (`node`), curl's default and a bare `Mozilla/5.0` all get 403:

| Path | Browser UA needed? |
|---|---|
| `/warningMessages/alert/Alerts.json`, `/warningMessages/alert/History/AlertsHistory.json` | No |
| `/api/v1/*` (alert history, CMS content) | **Yes** |
| Static JSON (`/alerts/*.json`, `/districts/*.json`, `/alertsCount.json`) | **Yes** |
| HTML pages (e.g. `/heb/alerts-history`) | **Yes**. HeadlessChrome is blocked too. |

The live endpoints are still called with these headers, as the site itself does:
- `Referer: https://www.oref.org.il/`
- `X-Requested-With: XMLHttpRequest`

## www.oref.org.il

The main Pikud Haoref website is a Single Page Application based on Angular. Its runtime
config (in a `chunk-*.js` bundle) holds `baseUrl: "https://www.oref.org.il/api/v1"`.

| URL | Purpose |
|---|---|
| [`/warningMessages/alert/Alerts.json`](https://www.oref.org.il/warningMessages/alert/Alerts.json) | **Live alerts**: current active alert snapshot, polled every ~1s. Returns JSON or BOM-only empty body when no alert. |
| [`/warningMessages/alert/History/AlertsHistory.json`](https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json) | **History**: ~1 hour of recent alerts. Reliable source for state transitions (including all-clears). |
| [`/api/v1/AlertHistory/heb`](https://www.oref.org.il/api/v1/AlertHistory/heb?period=1&cities=) | **Alert archive** (replaces `GetAlarmsHistory.aspx`). See [below](#alert-archive-apiv1alerthistory). |
| [`/alerts/alertCategories.json`](https://www.oref.org.il/alerts/alertCategories.json) | Alert category definitions |
| [`/alerts/alertsTranslation.json`](https://www.oref.org.il/alerts/alertsTranslation.json) | Localized alert text |
| [`/alerts/RemainderConfig_heb.json`](https://www.oref.org.il/alerts/RemainderConfig_heb.json) | Shelter duration per area (e.g. how long to stay in shelter). `{lang}`: `heb`, `eng`, `arb`, `rus`. |
| [`/districts/districts_heb.json`](https://www.oref.org.il/districts/districts_heb.json) | Districts/areas list. Contains ~1,492 entries. Excludes ~34 legacy "old alert zones" (`אזור התרעה ישן`) that still appear in `GetDistricts.aspx`. Includes a `rashut` (municipality) field not present in `GetDistricts.aspx`. |
| [`/districts/cities_heb.json`](https://www.oref.org.il/districts/cities_heb.json) | Cities list with metadata |
| [`/districts/citiesNotes_heb.json`](https://www.oref.org.il/districts/citiesNotes_heb.json) | Per-city notes |
| [`/translations/dictionary.heb.json`](https://www.oref.org.il/translations/dictionary.heb.json) | General UI translation dictionary |

## Alert archive (`/api/v1/AlertHistory`)

Used by the site's own history page (`/heb/alerts-history`). Verified 2026-11-27. It has
the same `rid`, city and title for each entry as the old `GetAlarmsHistory.aspx`, which
makes it a drop-in source for the R2 day-history.

| URL | Purpose |
|---|---|
| `/api/v1/AlertHistory/heb?from=YYYY-MM-DD&to=YYYY-MM-DD&cities=` | Entries in a date range. **`to` is exclusive** (`from=D&to=D` returns nothing). |
| `/api/v1/AlertHistory/heb?period=N&cities=` | Entries for a preset period (the site's "last day / week / month" filter). |
| `/api/v1/AlertHistory/count/heb?from=…&to=…&cities=` (or `?period=N`) | Totals per category: `{alarmsByCategory: [{categoryId, categoryDesc, alarmsCount}], totalAlarms}` |
| `/api/v1/AlertHistory/districts/heb` | Districts list for the city filter (~460 KB) |
| `/api/v1/AlertHistory/content/heb` | Page text |

Optional query params on the list endpoint: `cities=<names>` and `categoryIds=<ids>`.

**Response shape**:

```json
{
  "lastRetrievedAlarm": { "...": "same fields as an entry; the oldest entry in this page" },
  "alarmsGroupedByDate": [
    { "key": "23.11.2026",
      "value": [ { "data": "שתולה", "date": "23.11.2026", "time": "07:34:34",
                   "dateTime": "2026-11-23T07:34:00", "category": 1,
                   "category_Desc": "ירי רקטות וטילים", "matrixId": 0, "rid": 706624 } ] }
  ]
}
```

- An empty range returns `{"alarmsGroupedByDate": []}`, with no `lastRetrievedAlarm`.
- **Paging**: 200 entries per page, newest first. For the next page, pass the
  `lastRetrievedAlarm` values as `lastCreatedOn=<dateTime>&lastTitle=<category_Desc>&lastCityName=<data>`.
  Pages don't overlap.
- **Timestamps** are Israel local time. `dateTime` is **truncated** to the minute, and the
  exact seconds are in `time`. The old `GetAlarmsHistory.aspx` `alertDate` was **rounded** to
  the nearest minute, so for the same `rid` it can be one minute later than the new `dateTime`.
- Field names differ from the old API: `category_Desc` (capital D) instead of `category_desc`.
- Coverage reaches back at least to 2026-03 (the 2026-03-01 range returned the full day).

## City name character encoding

City names containing apostrophes use ASCII characters: single quote `'` (U+0027) and double quote `''` for gershayim. Examples: `ג'לג'וליה`, `ייט''ב`.

In late March 2026, the oref API briefly switched to Hebrew typographic characters: geresh `׳` (U+05F3) and gershayim `״` (U+05F4). This broke city lookups in both the backfill script (`city_0` filter) and the client's geocoding (names didn't match `cities_geo.json`). The change was reverted within days, and the API returned to ASCII apostrophes.

**Defensive code**: `normalizeGeresh()` in `web/index.html` converts Hebrew geresh/gershayim back to ASCII at all ingestion points. Currently a no-op, but protects against a future recurrence.

## alerts-history.oref.org.il (defunct)

**The hostname no longer resolves (NXDOMAIN).** It went away between 2026-10-19 and
2026-11-08 (the last R2 day-history entries fetched through it are from 2026-10-19). The
site config now points the old archive iframe at `alerts-history.scepia-sites.co.il`, but
`GetAlarmsHistory.aspx` there returns HTTP 500. Use [`/api/v1/AlertHistory`](#alert-archive-apiv1alerthistory) instead.

Kept for reference: it was an ASP.NET WebForms site (2014-2015) with these AJAX endpoints:

| URL | Purpose |
|---|---|
| `/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1` | **Extended history**: up to 3,000 recent entries. `mode=0` (all), `mode=1` (24h), `mode=2` (7d), `mode=3` (month); optional `city_0=<name>`. Date-filter params were ignored. Shape: `{data, alertDate: "YYYY-MM-DDTHH:MM:SS", category_desc, rid, ...}`. |
| `/Shared/Ajax/GetCities.aspx?lang=he` | Cities list for autocomplete search |
| `/Shared/Ajax/GetDistricts.aspx?lang=he` | District/area data. ~1,526 entries, a superset of `districts_heb.json` including ~34 legacy "old alert zones" (`אזור התרעה ישן`). No `rashut` field. |
| `/Shared/Ajax/GetCitiesMix.aspx?lang=he` | Mixed city+area list (used when "area mode" is enabled in the autocomplete) |
| `/Shared/Ajax/GetAlertCategories.aspx` | Active alert categories. Returned `[]` when no events are active. |

## CMS / content API (`/api/v1/*`)

Not used by oref-map; documented here for reference. These power the site's content pages (articles, FAQs, emergency guidelines, etc.) rather than live alert data.

They used to be served from `api.oref.org.il`, which **no longer resolves (NXDOMAIN)**.
They now live under **`https://www.oref.org.il/api/v1/`** and need a browser `User-Agent`.
Verified 2026-11-27: `global`, `CountryState/heb`, `home/heb`, `news/heb`. The other paths
below are carried over from the 2026-04-18 survey on the old host and were not re-checked.

### Lang-parameter endpoints

`{lang}` is a language code: `heb`, `eng`, `arb`, `rus`. Links below use `heb`.

| URL | Purpose |
|---|---|
| [`/api/v1/CountryState/heb`](https://www.oref.org.il/api/v1/CountryState/heb) | Country alert-state summary |
| [`/api/v1/home/heb`](https://www.oref.org.il/api/v1/home/heb) | Home page content |
| [`/api/v1/news/heb`](https://www.oref.org.il/api/v1/news/heb) | News / newsflash updates |
| [`/api/v1/contactPage/heb`](https://www.oref.org.il/api/v1/contactPage/heb) | Contact page |
| [`/api/v1/shared/heb/header`](https://www.oref.org.il/api/v1/shared/heb/header) | Site header content |
| [`/api/v1/shared/heb/footer`](https://www.oref.org.il/api/v1/shared/heb/footer) | Site footer content |
| [`/api/v1/global`](https://www.oref.org.il/api/v1/global) | Global app configuration (no lang param) |

### Full-path endpoints

These take the **full site path** of the page being viewed. Passing just `heb` returned HTTP 400 (`"The value 'heb' is not valid."`). Note the double slash after the endpoint name; this is how the site itself constructs the URLs.

| URL | Example link |
|---|---|
| `/api/v1/articles/{full-path}` | [`//heb/articles/info/iron-swords/1100`](https://www.oref.org.il/api/v1/articles//heb/articles/info/iron-swords/1100) |
| `/api/v1/QuestionsAnswers/{full-path}` | [`//heb/questions-answers/faq`](https://www.oref.org.il/api/v1/QuestionsAnswers//heb/questions-answers/faq) |
| `/api/v1/Recommendations/{full-path}` | [`//heb/recommendations/gov`](https://www.oref.org.il/api/v1/Recommendations//heb/recommendations/gov) |
| `/api/v1/emergencies/{full-path}` | [`//heb/emergencies/life-saving-guidelines`](https://www.oref.org.il/api/v1/emergencies//heb/emergencies/life-saving-guidelines) |
| `/api/v1/EventManagement/{full-path}` | [`//heb/events-management/iron-swords`](https://www.oref.org.il/api/v1/EventManagement//heb/events-management/iron-swords) |
