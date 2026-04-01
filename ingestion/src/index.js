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
// Returns { windowStartMs, windowEndMs, timeslot, isAlertCheck } or null (dead zone).
//
// Cron runs every 2 min at odd minutes (:01, :03, ..., :59).
// Each 15-min window gets ~6 fetch attempts plus a final alert-check.
//
//   :01–:11 → [XX:45, XX+1:00)  alert-check at :13
//   :15     → dead zone
//   :17–:25 → [XX:00, XX:15)    alert-check at :27
//   :29,:31 → dead zone
//   :33–:41 → [XX:15, XX:30)    alert-check at :43
//   :45     → dead zone
//   :47–:55 → [XX:30, XX:45)    alert-check at :57
//   :59     → dead zone
function computeWindow(nowMs) {
  const israelStr = toIsraelTimeStr(nowMs);
  const minute = parseInt(israelStr.slice(14, 16));

  let windowEndMinute;
  let isAlertCheck = false;

  if (minute >= 1 && minute <= 13) {
    windowEndMinute = 0;       // [XX:45, XX+1:00)
    isAlertCheck = minute === 13;
  } else if (minute >= 17 && minute <= 27) {
    windowEndMinute = 15;      // [XX:00, XX:15)
    isAlertCheck = minute === 27;
  } else if (minute >= 33 && minute <= 43) {
    windowEndMinute = 30;      // [XX:15, XX:30)
    isAlertCheck = minute === 43;
  } else if (minute >= 47 && minute <= 57) {
    windowEndMinute = 45;      // [XX:30, XX:45)
    isAlertCheck = minute === 57;
  } else {
    return null; // dead zone
  }

  const seconds = parseInt(israelStr.slice(17, 19));
  const offsetMinutes = windowEndMinute === 0 ? minute : minute - windowEndMinute;
  const windowEndMs = nowMs - offsetMinutes * 60000 - seconds * 1000;
  const windowStartMs = windowEndMs - 15 * 60000;

  // timeslot = window start in Israel time, truncated to minute (e.g. "2026-03-28T14:15")
  const timeslot = toIsraelTimeStr(windowStartMs).slice(0, 16);

  return { windowStartMs, windowEndMs, timeslot, isAlertCheck };
}

async function cleanupOldMarkers(env) {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  const cutoff = toIsraelTimeStr(twoHoursAgo).slice(0, 16);

  const listed = await env.HISTORY_BUCKET.list({ prefix: 'meta/' });
  let deleted = 0;
  for (const obj of listed.objects) {
    // key = "meta/2026-03-28T14:15"
    const timeslot = obj.key.slice(5);
    if (timeslot < cutoff) {
      await env.HISTORY_BUCKET.delete(obj.key);
      deleted++;
    }
  }
  console.log(`Cleanup: deleted ${deleted} old markers`);
}

export default {
  async scheduled(event, env, ctx) {
    const window = computeWindow(event.scheduledTime);
    if (!window) {
      console.log('Dead zone — skipping');
      return;
    }
    const { windowStartMs, windowEndMs, timeslot, isAlertCheck } = window;

    const windowStartStr = toIsraelTimeStr(windowStartMs);
    const windowEndStr = toIsraelTimeStr(windowEndMs);

    console.log(`Timeslot: ${timeslot}, window: [${windowStartStr}, ${windowEndStr}), alertCheck: ${isAlertCheck}`);

    // Check if this timeslot was already processed
    const marker = await env.HISTORY_BUCKET.head(`meta/${timeslot}`);

    // Alert-check run: notify if missed, always clean up old markers
    if (isAlertCheck) {
      if (!marker) {
        console.log(`Alert check: timeslot ${timeslot} was NOT processed after all attempts`);
        ctx.waitUntil(sendPushover(
          env,
          'oref-map ingestion: missed window',
          `Window ${timeslot} [${windowStartStr}, ${windowEndStr}) was not processed after all attempts.`
        ));
      } else {
        console.log(`Alert check: timeslot ${timeslot} OK`);
      }
      ctx.waitUntil(cleanupOldMarkers(env));
      return;
    }

    if (marker) {
      console.log(`Timeslot ${timeslot} already processed`);
      return;
    }

    // Fetch from proxy (single attempt, cron cadence provides retries)
    let entries;
    try {
      const resp = await fetch(
        `${env.HISTORY_PROXY_URL}/api2/alarms-history`,
        {}
      );
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        console.error(`Fetch failed: HTTP ${resp.status}: ${body.slice(0, 200)}`);
        return;
      }
      const text = (await resp.text()).replace(/^\ufeff/, '');
      entries = JSON.parse(text);
      const dates = entries.map(e => e.alertDate).filter(Boolean).sort();
      console.log(`Fetched ${entries.length} entries, API range: ${dates[0] || 'n/a'} – ${dates[dates.length - 1] || 'n/a'}`);
    } catch (e) {
      console.error(`Fetch failed: ${e.message}`);
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

    // Write timeslot marker
    await env.HISTORY_BUCKET.put(`meta/${timeslot}`, `${filtered.length}`, {
      httpMetadata: { contentType: 'text/plain' },
    });
    console.log(`Marker written: meta/${timeslot} (${filtered.length} entries)`);
  },
};
