const RETRY_DELAYS_MS = [5000, 15000, 45000];

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
  for (let i = 0; i < 3; i++) {
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

export default {
  async scheduled(event, env, ctx) {
    // Snap to nearest cron point (minutes 3, 18, 33, 48) — scheduledTime can drift by seconds
    const rawMinutes = Math.floor(event.scheduledTime / 60000);
    const scheduledTime = (Math.floor((rawMinutes - 3) / 15) * 15 + 3) * 60000;

    const windowEndMs = scheduledTime - 15 * 60 * 1000;
    const windowStartMs = scheduledTime - 30 * 60 * 1000;

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
        `Failed to fetch oref history after 3 retries. Window: ${windowStartStr} – ${windowEndStr}\nError: ${e.message}`
      ));
      return;
    }

    const filtered = entries
      .filter(e => e.alertDate >= windowStartStr && e.alertDate < windowEndStr)
      .map(e => ({ data: e.data, alertDate: e.alertDate, category_desc: e.category_desc, rid: e.rid }));

    filtered.sort((a, b) => a.alertDate < b.alertDate ? -1 : a.alertDate > b.alertDate ? 1 : 0);

    // Group by date
    const byDate = {};
    for (const e of filtered) {
      const d = e.alertDate.slice(0, 10);
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

    // Midnight: write .complete marker for previous day when window crosses midnight
    const startDate = windowStartStr.slice(0, 10);
    const endDate = windowEndStr.slice(0, 10);
    if (startDate < endDate) {
      const completeKey = `${startDate}.complete`;
      const existing = await env.HISTORY_BUCKET.head(completeKey);
      if (!existing) {
        await env.HISTORY_BUCKET.put(completeKey, '', {
          httpMetadata: { contentType: 'text/plain' },
        });
        console.log(`Wrote ${completeKey}`);
      }
    }
  },
};
