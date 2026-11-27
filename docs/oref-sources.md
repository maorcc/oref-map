# Oref API Data Sources

All endpoints under `www.oref.org.il` require these headers:
- `Referer: https://www.oref.org.il/`
- `X-Requested-With: XMLHttpRequest`

All endpoints are **geo-blocked** — non-Israeli IPs receive HTTP 403.

## www.oref.org.il

The main Pikud Haoref website is a Single Page Application based on Angular 15. Built 2022-2023.

| URL | Purpose |
|---|---|
| [`/warningMessages/alert/Alerts.json`](https://www.oref.org.il/warningMessages/alert/Alerts.json) | **Live alerts** — current active alert snapshot, polled every ~1s. Returns JSON or BOM-only empty body when no alert. |
| [`/warningMessages/alert/History/AlertsHistory.json`](https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json) | **History** — ~1 hour of recent alerts. Reliable source for state transitions (including all-clears). |
| [`/alerts/alertCategories.json`](https://www.oref.org.il/alerts/alertCategories.json) | Alert category definitions |
| [`/alerts/alertsTranslation.json`](https://www.oref.org.il/alerts/alertsTranslation.json) | Localized alert text |
| [`/alerts/RemainderConfig_heb.json`](https://www.oref.org.il/alerts/RemainderConfig_heb.json) | Shelter duration per area (e.g. how long to stay in shelter). `{lang}`: `heb`, `eng`, `arb`, `rus`. |
| [`/districts/districts_heb.json`](https://www.oref.org.il/districts/districts_heb.json) | Districts/areas list. Contains ~1,492 entries. Excludes ~34 legacy "old alert zones" (`אזור התרעה ישן`) that still appear in `GetDistricts.aspx`. Includes a `rashut` (municipality) field not present in `GetDistricts.aspx`. |
| [`/districts/cities_heb.json`](https://www.oref.org.il/districts/cities_heb.json) | Cities list with metadata |
| [`/districts/citiesNotes_heb.json`](https://www.oref.org.il/districts/citiesNotes_heb.json) | Per-city notes |
| [`/translations/dictionary.heb.json`](https://www.oref.org.il/translations/dictionary.heb.json) | General UI translation dictionary |

## City name character encoding

City names containing apostrophes use ASCII characters: single quote `'` (U+0027) and double quote `''` for gershayim. Examples: `ג'לג'וליה`, `ייט''ב`.

In late March 2026, the oref API briefly switched to Hebrew typographic characters: geresh `׳` (U+05F3) and gershayim `״` (U+05F4). This broke city lookups in both the backfill script (`city_0` filter) and the client's geocoding (names didn't match `cities_geo.json`). The change was reverted within days — the API returned to ASCII apostrophes.

**Defensive code**: `normalizeGeresh()` in `web/index.html` converts Hebrew geresh/gershayim back to ASCII at all ingestion points. Currently a no-op, but protects against a future recurrence. The backfill script queries both ASCII and Hebrew character variants for cities with apostrophes.

## alerts-history.oref.org.il

https://alerts-history.oref.org.il/12481-he/Pakar.aspx?pagemode=iframe - Standalone older alerts archive website UI (not a JSON endpoint), embedded as an iframe in the main Pikud Haoref website. An ASP.NET WebForms site developed in 2014-2015. Uses the following ajax endpoints:

| URL | Purpose |
|---|---|
| [`/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1`](https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1) | **Extended history** — up to 3,000 recent alert entries. Supports `mode=0` (all), `mode=1` (24h), `mode=2` (7d), `mode=3` (month). The 3,000 entry cap can truncate the time window during heavy activity (e.g. mode=1 may cover only a few hours). Optional `city_0=<name>` filter. Used by ingestion worker only, not the client UI. |
| [`/Shared/Ajax/GetCities.aspx?lang=he`](https://alerts-history.oref.org.il/Shared/Ajax/GetCities.aspx?lang=he) | Cities list for autocomplete search |
| [`/Shared/Ajax/GetDistricts.aspx?lang=he`](https://alerts-history.oref.org.il/Shared/Ajax/GetDistricts.aspx?lang=he) | District/area data. Contains ~1,526 entries — a superset of `districts_heb.json`, including ~34 legacy "old alert zones" (`אזור התרעה ישן`) that have been merged into other locations. Does **not** include the `rashut` (municipality) field. |
| [`/Shared/Ajax/GetCitiesMix.aspx?lang=he`](https://alerts-history.oref.org.il/Shared/Ajax/GetCitiesMix.aspx?lang=he) | Mixed city+area list (used when "area mode" is enabled in the autocomplete) |
| [`/Shared/Ajax/GetAlertCategories.aspx`](https://alerts-history.oref.org.il/Shared/Ajax/GetAlertCategories.aspx) | Active alert categories. Returns `[]` when no events are active. |

Subdomain root (`https://alerts-history.oref.org.il/`) now returns a 301 redirect to `https://www.oref.org.il/heb/alerts-history`. The AJAX endpoints above still respond directly; only the site UI was folded into the main domain.

## api.oref.org.il `/api/v1/*` (CMS / content API)

Not used by oref-map — documented here for reference. These power the oref.org.il site's content pages (articles, FAQs, emergency guidelines, etc.) rather than live alert data. Served from a separate `api.oref.org.il` subdomain; the same paths on `www.oref.org.il` return 404.

Verified 2026-04-18 via live network monitoring of the oref.org.il site.

### Lang-parameter endpoints

`{lang}` is a language code: `heb`, `eng`, `arb`, `rus`. Links below use `heb`.

| URL | Purpose |
|---|---|
| [`/api/v1/CountryState/heb`](https://api.oref.org.il/api/v1/CountryState/heb) | Country alert-state summary |
| [`/api/v1/home/heb`](https://api.oref.org.il/api/v1/home/heb) | Home page content |
| [`/api/v1/AlertHistory/heb`](https://api.oref.org.il/api/v1/AlertHistory/heb) | Alert history (CMS view — not the same as `/warningMessages/alert/History/AlertsHistory.json`) |
| [`/api/v1/news/heb`](https://api.oref.org.il/api/v1/news/heb) | News / newsflash updates (previously `/api/v1/{lang}/updates-and-newsflash/update-page`) |
| [`/api/v1/contactPage/heb`](https://api.oref.org.il/api/v1/contactPage/heb) | Contact page (previously `/api/v1/{lang}/contact-page`) |
| [`/api/v1/shared/heb/header`](https://api.oref.org.il/api/v1/shared/heb/header) | Site header content |
| [`/api/v1/shared/heb/footer`](https://api.oref.org.il/api/v1/shared/heb/footer) | Site footer content |
| [`/api/v1/global`](https://api.oref.org.il/api/v1/global) | Global app configuration (no lang param) |

### Full-path endpoints

These endpoints previously accepted `{lang}` alone but now require the **full site path** of the page being viewed. Passing just `heb` returns HTTP 400 (`"The value 'heb' is not valid."` — parameter is now typed as an ID, not a string). Note the double slash after the endpoint name — this is how the site itself constructs the URLs.

| URL | Example link |
|---|---|
| `/api/v1/articles/{full-path}` | [`//heb/articles/info/iron-swords/1100`](https://api.oref.org.il/api/v1/articles//heb/articles/info/iron-swords/1100) |
| `/api/v1/QuestionsAnswers/{full-path}` | [`//heb/questions-answers/faq`](https://api.oref.org.il/api/v1/QuestionsAnswers//heb/questions-answers/faq) |
| `/api/v1/Recommendations/{full-path}` | [`//heb/recommendations/gov`](https://api.oref.org.il/api/v1/Recommendations//heb/recommendations/gov) |
| `/api/v1/emergencies/{full-path}` | [`//heb/emergencies/life-saving-guidelines`](https://api.oref.org.il/api/v1/emergencies//heb/emergencies/life-saving-guidelines) |
| `/api/v1/EventManagement/{full-path}` | [`//heb/events-management/iron-swords`](https://api.oref.org.il/api/v1/EventManagement//heb/events-management/iron-swords) |
