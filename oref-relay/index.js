import express from 'express';
import { readFileSync } from 'fs';
import { appendFile } from 'fs/promises';

const PORT = 3001;
const DEBUG       = process.argv.includes('--debug');
const LOG_HISTORY = process.argv.includes('--log-history');
const DEFAULT_ALLOWED_ORIGINS = [
  'https://oref-map.org',
  'http://localhost:8788',
  'http://127.0.0.1:8788',
  'http://dev.local:8788',
];
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const OREF_HEADERS = {
  'Referer': 'https://www.oref.org.il/',
  'X-Requested-With': 'XMLHttpRequest',
  // Oref's CloudFront WAF answers /api/v1/* with 403 unless the User-Agent looks like
  // a full browser string (Node's default "node" and a bare "Mozilla/5.0" are both blocked).
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
};

const ALERTS_URL   = 'https://www.oref.org.il/warningMessages/alert/Alerts.json';
const HISTORY_URL  = 'https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json';
// Replaces GetAlarmsHistory.aspx on alerts-history.oref.org.il, which no longer resolves.
// Query: from=YYYY-MM-DD&to=YYYY-MM-DD (exclusive)&cities=; 200 entries per page, newest
// first, paged with lastCreatedOn/lastTitle/lastCityName taken from lastRetrievedAlarm.
const EXTENDED_URL = 'https://www.oref.org.il/api/v1/AlertHistory/heb';

const LIVE_POLL_MS    = 1000;   // every 1s — mirrors production
const HISTORY_POLL_MS = 10000;  // every 10s — mirrors production
const EXTENDED_TTL_MS = 60000;  // cache extended history for 60s
const EXTENDED_PAGE_SIZE   = 200;                // fixed by the API
// Ingestion reads back to its window start, ~26 min before its last attempt. The cutoff is
// set from the relay's clock, so 60 min leaves ~30 min of slack for a late cron run. The
// busiest hour of the 2026 war had ~5,400 entries (28 pages); the page cap is only a safety stop.
const EXTENDED_LOOKBACK_MS = 60 * 60 * 1000;
const EXTENDED_MAX_PAGES   = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

// --- Debug mode: load interesting-map.json ---

const DEBUG_TIMESTAMP = '2026-03-14T16:38';

function loadDebugData() {
  const raw = readFileSync(new URL('./interesting-map.json', import.meta.url), 'utf8');
  const entries = JSON.parse(raw); // alarms-history format

  // Convert to history format: alertDate ISO → "YYYY-MM-DD HH:MM:SS", category_desc → title
  const historyEntries = entries.map(e => ({
    alertDate: e.alertDate.replace('T', ' '),
    title: e.category_desc,
    data: e.data,
    category: e.category,
  }));

  // Build alerts response from entries active at DEBUG_TIMESTAMP
  // Group locations by title; take the first (highest priority) title group
  const atTime = entries.filter(e => e.alertDate.startsWith(DEBUG_TIMESTAMP));
  const byTitle = {};
  for (const e of atTime) {
    if (!byTitle[e.category_desc]) byTitle[e.category_desc] = { cat: e.category, rid: e.rid, locations: [] };
    byTitle[e.category_desc].locations.push(e.data);
  }
  const firstTitle = Object.keys(byTitle)[0];
  const alertsBody = firstTitle
    ? JSON.stringify({
        id:    String(byTitle[firstTitle].rid),
        cat:   byTitle[firstTitle].cat,
        title: firstTitle,
        desc:  firstTitle,
        data:  byTitle[firstTitle].locations,
      })
    : '[]';

  return {
    extended: raw,
    history: JSON.stringify(historyEntries),
    alerts: alertsBody,
  };
}

const USAGE_LOG   = new URL('./usage.log',    import.meta.url).pathname;
const HISTORY_LOG = new URL('./history.jsonl', import.meta.url).pathname;
const ERROR_LOG   = new URL('./error.log',    import.meta.url).pathname;

// --- History JSONL log ---

const historySeen = new Set(); // keyed by "alertDate|data"

function historyKey(e) { return `${e.alertDate}|${e.data}`; }

if (LOG_HISTORY) {
  try {
    const lines = readFileSync(HISTORY_LOG, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try { historySeen.add(historyKey(JSON.parse(line))); } catch { /* skip malformed */ }
    }
    console.log(`[history-log] loaded ${historySeen.size} entries from history.jsonl`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function storeNewHistory(entries) {
  const newLines = [];
  for (const e of entries) {
    const k = historyKey(e);
    if (!historySeen.has(k)) {
      historySeen.add(k);
      newLines.push(JSON.stringify(e));
    }
  }
  if (newLines.length)
    appendFile(HISTORY_LOG, newLines.join('\n') + '\n')
      .catch(err => console.error('[history-log] write error:', err.message));
}

// --- In-memory cache ---

const cache = {
  alerts:  { body: '[]', updatedAt: null },
  history: { body: '[]',     updatedAt: null },
  extended: { body: '[]',    updatedAt: null, fetchedAt: null },
};

// --- Fetch helpers ---

function normalizeOrefBody(body) {
  const text = String(body)
    .replace(/\ufeff/g, '')
    .replace(/\u0000/g, '')
    .trim();
  return text || '[]';
}

function logInvalidPayload(url, body, err) {
  const timestamp = new Date().toISOString();
  const message = String(err?.message ?? err);
  const entry =
    `[${timestamp}] invalid upstream payload from ${url}\n` +
    `error: ${message}\n` +
    `body:\n${body}\n\n---\n`;
  return appendFile(ERROR_LOG, entry)
    .catch(logErr => console.error('[error-log] write error:', logErr.message));
}

function appendErrorLog(entry) {
  return appendFile(ERROR_LOG, entry)
    .catch(logErr => console.error('[error-log] write error:', logErr.message));
}

async function fetchOref(url) {
  const resp = await fetch(url, { headers: OREF_HEADERS });
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status} from ${url}`);
    err.code = String(resp.status);
    throw err;
  }
  const body = normalizeOrefBody(await resp.text());
  try {
    JSON.parse(body);
  } catch (err) {
    await logInvalidPayload(url, body, err);
    throw err;
  }
  return body;
}

function logError(prefix, err) {
  const timestamp = new Date().toISOString();
  const code = err?.code ?? 'UNKNOWN';
  const message = String(err?.message ?? err);
  const line = `[${timestamp}] ${prefix}, code=${code}, error="${message}"`;
  console.error(line);
  void appendErrorLog(`${line}\n`);
}

// --- Polling ---

let alertsInFlight = null;

async function pollAlerts() {
  if (alertsInFlight) return alertsInFlight;
  alertsInFlight = fetchOref(ALERTS_URL).then(body => {
    cache.alerts.body = body;
    cache.alerts.updatedAt = Date.now();
  }).catch(err => {
    logError('[alerts] poll error:', err);
  }).finally(() => {
    alertsInFlight = null;
  });
  return alertsInFlight;
}

let historyInFlight = null;

async function pollHistory() {
  if (historyInFlight) return historyInFlight;
  historyInFlight = fetchOref(HISTORY_URL).then(body => {
    cache.history.body = body;
    cache.history.updatedAt = Date.now();
    if (LOG_HISTORY) {
      try { storeNewHistory(JSON.parse(body)); } catch { /* malformed response, skip */ }
    }
  }).catch(err => {
    logError('[history] poll error:', err);
  }).finally(() => {
    historyInFlight = null;
  });
  return historyInFlight;
}

// --- Extended history (new /api/v1/AlertHistory, served in the old GetAlarmsHistory shape) ---

function israelTimeStr(ms) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(ms)).replace(' ', 'T');
}

// The ingestion worker reads data, alertDate, category_desc and rid. The new API truncates
// `dateTime` to the minute and carries the exact seconds in `time`; alertDate keeps them.
function toLegacyEntry(item) {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(item.dateTime) || !/^\d{2}:\d{2}:\d{2}$/.test(item.time)) {
    throw new Error(`unexpected dateTime/time "${item.dateTime}"/"${item.time}" for rid ${item.rid}`);
  }
  return {
    data: item.data,
    alertDate: `${item.dateTime.slice(0, 10)}T${item.time}`,
    category: item.category,
    category_desc: item.category_Desc,
    rid: item.rid,
  };
}

async function fetchExtendedEntries() {
  const now = Date.now();
  const cutoff = israelTimeStr(now - EXTENDED_LOOKBACK_MS);
  const params = new URLSearchParams({
    from: cutoff.slice(0, 10),
    to: israelTimeStr(now + DAY_MS).slice(0, 10),
    cities: '',
  });
  const byRid = new Map();

  for (let page = 1; ; page++) {
    const parsed = JSON.parse(await fetchOref(`${EXTENDED_URL}?${params}`));
    if (!Array.isArray(parsed.alarmsGroupedByDate)) {
      throw new Error('unexpected AlertHistory payload: no alarmsGroupedByDate array');
    }
    const items = parsed.alarmsGroupedByDate.flatMap(group => group.value);
    for (const item of items) byRid.set(item.rid, toLegacyEntry(item));

    const last = parsed.lastRetrievedAlarm;
    if (items.length < EXTENDED_PAGE_SIZE || !last || toLegacyEntry(last).alertDate < cutoff) break;
    if (page === EXTENDED_MAX_PAGES) {
      // A partial list would let ingestion mark a window done with entries missing.
      throw new Error(`stopped at ${page} pages before reaching ${cutoff}`);
    }
    params.set('lastCreatedOn', last.dateTime);
    params.set('lastTitle', last.category_Desc);
    params.set('lastCityName', last.data);
  }

  return [...byRid.values()].sort((a, b) => b.alertDate.localeCompare(a.alertDate));
}

let extendedInFlight = null;

async function fetchExtended() {
  if (extendedInFlight) return extendedInFlight;
  extendedInFlight = fetchExtendedEntries().then(entries => {
    cache.extended.body = JSON.stringify(entries);
    cache.extended.fetchedAt = Date.now();
    cache.extended.updatedAt = Date.now();
  }).finally(() => {
    extendedInFlight = null;
  });
  return extendedInFlight;
}

// --- Express app ---

const app = express();

function isAllowedOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin);
}

// Allow cross-origin requests from production and explicitly allowed local dev origins.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Count incoming requests for usage log
let requestCount = 0;
app.use((req, res, next) => { requestCount++; next(); });

let currentMinute = null;

setInterval(() => {
  const now = new Date();
  const minute = now.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
  let line = '';
  if (minute !== currentMinute) {
    const prefix = currentMinute === null ? '' : '\n';
    line += `${prefix}${minute} `;
    currentMinute = minute;
  }
  line += `${requestCount}, `;
  requestCount = 0;
  appendFile(USAGE_LOG, line).catch(err => console.error('[usage] log error:', err.message));
}, 2000);

app.get(['/api/alerts', '/api2/alerts'], (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=1, max-age=2');
  res.send(cache.alerts.body);
});

app.get(['/api/history', '/api2/history'], (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=1, max-age=2');
  res.send(cache.history.body);
});

app.get(['/api/alarms-history', '/api2/alarms-history'], async (req, res) => {
  const age = cache.extended.fetchedAt ? Date.now() - cache.extended.fetchedAt : Infinity;
  if (age > EXTENDED_TTL_MS) {
    try {
      await fetchExtended();
    } catch (err) {
      logError('[alarms-history] fetch error:', err);
      // Fail loudly: a 200 with stale or empty data made the ingestion worker record
      // empty windows, so a dead upstream went unnoticed for weeks.
      return res.status(502).json({ error: 'extended history fetch failed' });
    }
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=1, max-age=2');
  res.send(cache.extended.body);
});

// Health check — shows last update times
app.get('/status', (req, res) => {
  res.json({
    alerts:  { updatedAt: cache.alerts.updatedAt },
    history: { updatedAt: cache.history.updatedAt },
    extended: { updatedAt: cache.extended.updatedAt, fetchedAt: cache.extended.fetchedAt },
  });
});

// --- Start ---

app.listen(PORT, () => {
  if (DEBUG) {
    console.log(`Status server listening on http://localhost:${PORT} [DEBUG MODE]`);
    const data = loadDebugData();
    cache.extended.body = data.extended;
    cache.extended.fetchedAt = Date.now();
    cache.extended.updatedAt = Date.now();
    cache.history.body = data.history;
    cache.history.updatedAt = Date.now();
    cache.alerts.body = data.alerts;
    cache.alerts.updatedAt = Date.now();
    console.log('Loaded interesting-map.json — no live polling.');
  } else {
    console.log(`Status server listening on http://localhost:${PORT}`);
    console.log('Starting polls...');
    pollAlerts();
    pollHistory();
    setInterval(pollAlerts,  LIVE_POLL_MS);
    setInterval(pollHistory, HISTORY_POLL_MS);
  }
});
