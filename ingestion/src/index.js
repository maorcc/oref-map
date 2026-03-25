const RETRY_DELAYS_MS = [5000, 15000, 30000, 60000, 120000, 180000, 240000];

function toIsraelTimeStr(timestampMs) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestampMs)).replace(' ', 'T');
}

async function fetchWithRetry(url, headers) {
  let lastError;
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    if (i > 0) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[i - 1]));
    }
    try {
      const resp = await fetch(url, { headers });
      if (resp.ok) return resp;
      const body = await resp.text().catch(() => '');
      lastError = new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

async function sendPushover(env, title, message) {
  if (!env.PUSHOVER_USER || !env.PUSHOVER_TOKEN) return;
  await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: env.PUSHOVER_TOKEN,
      user: env.PUSHOVER_USER,
      title,
      message,
    }),
  });
}

// Map alertDate to R2 file date key. Events from 23:xx belong to next day's file.
// Each day file covers (D-1)T23:00 to DT22:59.
function r2DateKey(alertDateStr) {
  const d = new Date(alertDateStr.slice(0, 10) + 'T12:00:00Z');
  if (parseInt(alertDateStr.slice(11, 13)) >= 23)
    d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Determine the 15-minute ingestion window from wall time.
// Returns { windowStartMs, windowEndMs } or null if in a dead zone.
// Cron runs at :03, :18, :33, :48 but actual execution may drift.
//   :01–:13 → [XX:45, XX+1:00)    :17–:28 → [XX:00, XX:15)
//   :32–:43 → [XX:15, XX:30)      :47–:58 → [XX:30, XX:45)
//   Dead zones: :14–:16, :29–:31, :44–:46, :59–:00
function computeWindow(nowMs) {
  const israelStr = toIsraelTimeStr(nowMs);
  const minute = parseInt(israelStr.slice(14, 16));

  // Map minute to window-end offset (minutes after the hour, Israel time)
  let windowEndMinute;
  if (minute >= 1 && minute <= 13) windowEndMinute = 0;       // [XX:45, XX+1:00)
  else if (minute >= 17 && minute <= 28) windowEndMinute = 15; // [XX:00, XX:15)
  else if (minute >= 32 && minute <= 43) windowEndMinute = 30; // [XX:15, XX:30)
  else if (minute >= 47 && minute <= 58) windowEndMinute = 45; // [XX:30, XX:45)
  else return null; // dead zone

  // Compute window end by subtracting the offset from nowMs to reach :00/:15/:30/:45
  // For windowEndMinute=0, subtract the full minute+seconds to reach the top of the hour
  const seconds = parseInt(israelStr.slice(17, 19));
  const offsetMinutes = windowEndMinute === 0 ? minute : minute - windowEndMinute;
  const windowEndMs = nowMs - offsetMinutes * 60000 - seconds * 1000;
  const windowStartMs = windowEndMs - 15 * 60000;

  return { windowStartMs, windowEndMs };
}

export default {
  async scheduled(event, env, ctx) {
    const window = computeWindow(Date.now());
    if (!window) {
      console.log('Dead zone — skipping execution');
      return;
    }
    const { windowStartMs, windowEndMs } = window;

    const windowStartStr = toIsraelTimeStr(windowStartMs);
    const windowEndStr = toIsraelTimeStr(windowEndMs);

    console.log(`Window: [${windowStartStr}, ${windowEndStr})`);

    let entries;
    try {
      const resp = await fetchWithRetry(
        `${env.HISTORY_PROXY_URL}/api2/alarms-history`,
        {}
      );
      const text = (await resp.text()).replace(/^\ufeff/, '');
      entries = JSON.parse(text);
      console.log(`Fetched ${entries.length} entries from API`);
    } catch (e) {
      console.error(`Fetch failed: ${e.message}`);
      ctx.waitUntil(sendPushover(
        env,
        'oref-map ingestion failure',
        `Failed to fetch oref history after ${RETRY_DELAYS_MS.length} retries (~${Math.round(RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) / 60000)} min). Window: ${windowStartStr} – ${windowEndStr}\nError: ${e.message}`
      ));
      return;
    }

    const filtered = entries
      .filter(e => e.alertDate >= windowStartStr && e.alertDate < windowEndStr)
      .map(e => ({ data: e.data, alertDate: e.alertDate, category_desc: e.category_desc, rid: e.rid }));

    filtered.sort((a, b) => a.alertDate < b.alertDate ? -1 : a.alertDate > b.alertDate ? 1 : 0);

    // Group by R2 date key (events 23:xx go to next day's file)
    const byDate = {};
    for (const e of filtered) {
      const d = r2DateKey(e.alertDate);
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(e);
    }

    console.log(`Filtered: ${filtered.length} entries, dates: ${Object.keys(byDate).join(', ') || 'none'}`);

    // Append to each date's JSONL file
    for (const [d, dateEntries] of Object.entries(byDate)) {
      const existing = await env.HISTORY_BUCKET.get(`${d}.jsonl`);
      const existingText = existing ? await existing.text() : '';
      const newLines = dateEntries.map(e => JSON.stringify(e) + ',\n').join('');
      await env.HISTORY_BUCKET.put(`${d}.jsonl`, existingText + newLines, {
        httpMetadata: { contentType: 'application/jsonl' },
      });
      console.log(`Wrote ${d}.jsonl: ${dateEntries.length} new + ${existingText.length} bytes existing`);
    }
  },
};
