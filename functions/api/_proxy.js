const OREF_HEADERS = {
  'Referer': 'https://www.oref.org.il/',
  'X-Requested-With': 'XMLHttpRequest',
};

const PROXY_HOSTS = [
  'https://orefproxy5.oref-map.org',
  'https://orefproxy7.oref-map.org',
  'https://proxy1.oref-proxy1.workers.dev',
];

const PROXY_HOST_PATTERNS = [
  /^orefproxy\d+\.oref-map\.org$/,
  /^proxy\d+\.oref-proxy\d+\.workers\.dev$/,
];

function randomProxy() {
  return PROXY_HOSTS[Math.floor(Math.random() * PROXY_HOSTS.length)];
}

// --- Known title classification (mirrors client-side classifyTitle) ---

function isKnownTitle(title) {
  title = title.replace(/\s+/g, ' ').trim();

  // Green — all-clear / event over
  if (title.includes('האירוע הסתיים') ||
      title.includes('ניתן לצאת') ||
      title.includes('החשש הוסר') ||
      title.includes('יכולים לצאת') ||
      title.includes('אינם צריכים לשהות') ||
      title.includes('סיום שהייה בסמיכות') ||
      title === 'עדכון') {
    return true;
  }

  // Yellow — early warning / preparedness
  if (title === 'בדקות הקרובות צפויות להתקבל התרעות באזורך' ||
      title.includes('לשפר את המיקום למיגון המיטבי') ||
      title === 'יש לשהות בסמיכות למרחב המוגן') {
    return true;
  }

  // Purple — drone infiltration
  if (title === 'חדירת כלי טיס עוין') {
    return true;
  }

  // Red — active danger
  if (title === 'ירי רקטות וטילים' ||
      title === 'נשק לא קונבנציונלי' ||
      title === 'חדירת מחבלים' ||
      title === 'היכנסו מייד למרחב המוגן' ||
      title === 'היכנסו למרחב המוגן') {
    return true;
  }

  return false;
}

// --- Title extraction per API kind ---

function extractTitles(bodyText, kind) {
  try {
    const text = bodyText.replace(/^\ufeff/, '').trim();
    if (!text) return [];
    const parsed = JSON.parse(text);

    if (kind === 'alerts') {
      // Live API: single object with .title
      if (parsed && parsed.title) {
        return [parsed.title.replace(/\s+/g, ' ').trim()];
      }
      return [];
    }

    if (kind === 'history') {
      // History API: array of {title, ...}
      if (!Array.isArray(parsed)) return [];
      return [...new Set(
        parsed
          .map(e => e.title)
          .filter(Boolean)
          .map(t => t.replace(/\s+/g, ' ').trim())
      )];
    }

    if (kind === 'alarms-history') {
      // Extended history API: array of {category_desc, ...}
      if (!Array.isArray(parsed)) return [];
      return [...new Set(
        parsed
          .map(e => e.category_desc)
          .filter(Boolean)
          .map(t => t.replace(/\s+/g, ' ').trim())
      )];
    }

    return [];
  } catch {
    return [];
  }
}

// --- Unknown title detection & Pushover notification ---

async function checkAndNotifyUnknownTitles(bodyText, kind, context) {
  const titles = extractTitles(bodyText, kind);
  const unknown = titles.filter(t => !isKnownTitle(t));
  if (unknown.length === 0) return;

  const userKey = context.env.PUSHOVER_USER;
  const appToken = context.env.PUSHOVER_TOKEN;
  if (!userKey || !appToken) return;

  const cache = caches.default;

  for (const title of unknown) {
    const cacheKey = new Request(
      `https://oref-map.org/_internal/unknown-title/${encodeURIComponent(title)}`
    );
    const cached = await cache.match(cacheKey);
    if (cached) continue; // already notified recently

    // Store in cache with 1-hour TTL to deduplicate
    await cache.put(cacheKey, new Response('1', {
      headers: { 'Cache-Control': 's-maxage=3600' },
    }));

    // Send Pushover notification
    try {
      await fetch('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: appToken,
          user: userKey,
          title: 'oref-map: unknown alert title',
          message: `Kind: ${kind}\nTitle: ${title}`,
          priority: 1, // high priority
        }),
      });
    } catch {
      // Notification failure must not affect proxy behavior
    }
  }
}

// --- Shared proxy logic ---

export async function orefProxy(context, { target, redirectSuffix, kind }) {
  const colo = context.request.cf?.colo || '';
  const url = new URL(context.request.url);
  const debugApi = url.searchParams.get('debugapi');

  // ?debugapi=<hostname> forces redirect to that proxy (if whitelisted), even from TLV
  if (debugApi) {
    const proxyHost = PROXY_HOST_PATTERNS.some(p => p.test(debugApi)) ? 'https://' + debugApi : null;
    if (proxyHost) {
      return new Response(null, {
        status: 303,
        headers: { 'Location': proxyHost + redirectSuffix, 'X-CF-Colo': colo },
      });
    }
  }

  // Non-TLV requests redirect to the Worker; title detection only runs on the
  // TLV path since all Israeli traffic goes through it — same titles are seen.
  if (colo !== 'TLV') {
    return new Response(null, {
      status: 303,
      headers: { 'Location': randomProxy() + redirectSuffix, 'X-CF-Colo': colo },
    });
  }

  const cache = caches.default;
  const cacheKey = new Request(context.request.url, { method: 'GET' });

  const cached = await cache.match(cacheKey);
  if (cached) {
    const resp = new Response(cached.body, cached);
    resp.headers.set('X-CF-Colo', colo);
    return resp;
  }

  const resp = await fetch(target, { headers: OREF_HEADERS });
  const body = await resp.arrayBuffer();

  const response = new Response(body, {
    status: resp.status,
    headers: {
      'Content-Type': resp.ok ? 'application/json; charset=utf-8' : (resp.headers.get('Content-Type') || 'text/plain'),
      'Cache-Control': 's-maxage=1, max-age=2',
      'X-CF-Colo': colo,
      'X-Served-By': 'pages-function',
    },
  });

  if (resp.ok) {
    context.waitUntil(cache.put(cacheKey, response.clone()));

    // Check for unknown titles in the background
    const bodyText = new TextDecoder().decode(body);
    context.waitUntil(checkAndNotifyUnknownTitles(bodyText, kind, context));
  }

  return response;
}
