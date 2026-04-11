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
};

const ALERTS_URL   = 'https://www.oref.org.il/warningMessages/alert/Alerts.json';
const HISTORY_URL  = 'https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json';
const EXTENDED_URL = 'https://alerts-history.oref.org.il//Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1';

const LIVE_POLL_MS    = 1000;   // every 1s — mirrors production
const HISTORY_POLL_MS = 10000;  // every 10s — mirrors production
const EXTENDED_TTL_MS = 60000;  // cache extended history for 60s

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

let extendedInFlight = null;

async function fetchExtended() {
  if (extendedInFlight) return extendedInFlight;
  extendedInFlight = fetchOref(EXTENDED_URL).then(body => {
    cache.extended.body = body;
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
      // Return stale data if available, empty array otherwise
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
