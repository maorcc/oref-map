const OREF_HEADERS = {
  'Referer': 'https://www.oref.org.il/',
  'X-Requested-With': 'XMLHttpRequest',
};

const PROVIDERS = {
  OFFICIAL: 'official',
  TZEVA_ADOM: 'tzeva-adom',
};

const OFFICIAL_ALARMS_HISTORY_TARGET = 'https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx';
const TZEVA_ADOM_TARGET = 'https://tzevadom.com/api/alerts-history/summary/custom';

const TZEVA_ADOM_TO_OFFICIAL_API = {
  0: 1,
  2: 4,
  5: 2,
  11: 14,
};

const OFFICIAL_CATEGORY_MAP = {
  1: "ירי רקטות וטילים",
  2: "חדירת כלי טיס עוין",
  3: "חדירת מחבלים",
  4: "רעידת אדמה",
  5: "חשש לצונאמי",
  6: "אירוע חומרים מסוכנים",
  7: "אירוע רדיולוגי",
  10: "חשש לאירוע ביולוגי",
  13: "האירוע הסתיים",
  14: "התרעה מוקדמת"
};

const ROUTES = {
  '/api2/alerts': 'https://www.oref.org.il/warningMessages/alert/Alerts.json',
  '/api2/history': 'https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json',
  '/api2/alarms-history': OFFICIAL_ALARMS_HISTORY_TARGET,
};

function jsonResponse(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

function normalizeProvider(rawValue) {
  const value = String(rawValue || PROVIDERS.OFFICIAL)
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/\s+/g, '-');

  if (!value || value === PROVIDERS.OFFICIAL) return PROVIDERS.OFFICIAL;
  if (value === PROVIDERS.TZEVA_ADOM || value === 'tzevaadom') return PROVIDERS.TZEVA_ADOM;
  return null;
}

function formatYmd(dateObj) {
  const yyyy = dateObj.getFullYear();
  const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
  const dd = String(dateObj.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatIsoSeconds(dateObj) {
  return dateObj.toISOString().slice(0, 19);
}

function parseDdMmYyyy(dateStr, endOfDay) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(dateStr || ''));
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1;
  const year = parseInt(match[3], 10);
  const hours = endOfDay ? 23 : 0;
  const minutes = endOfDay ? 59 : 0;
  const seconds = endOfDay ? 59 : 0;
  const millis = endOfDay ? 999 : 0;

  const parsed = new Date(year, month, day, hours, minutes, seconds, millis);
  if (isNaN(parsed.getTime())) return null;
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month || parsed.getDate() !== day) return null;
  return parsed;
}

function buildRange(modeRaw, fromDateStr, toDateStr) {
  let mode = String(modeRaw || '1');
  if (fromDateStr && toDateStr) mode = '0';

  const now = new Date();
  const nowTs = Math.floor(now.getTime() / 1000);

  if (mode === '1' || mode === '2' || mode === '3') {
    const days = mode === '1' ? 1 : (mode === '2' ? 7 : 30);
    const startTs = nowTs - (days * 86400);
    const endTs = nowTs;
    return {
      ok: true,
      startTs: startTs,
      endTs: endTs,
      tFrom: formatYmd(new Date(startTs * 1000)),
      tTo: formatYmd(new Date(endTs * 1000)),
    };
  }

  if (mode === '0' && fromDateStr && toDateStr) {
    const startDate = parseDdMmYyyy(fromDateStr, false);
    const endDate = parseDdMmYyyy(toDateStr, true);
    if (!startDate || !endDate) {
      return { ok: false, status: 400, error: 'Invalid date format. Please use DD.MM.YYYY' };
    }
    if (startDate.getTime() > endDate.getTime()) {
      return { ok: false, status: 400, error: 'Invalid date range. fromDate must be earlier than or equal to toDate.' };
    }
    return {
      ok: true,
      startTs: Math.floor(startDate.getTime() / 1000),
      endTs: Math.floor(endDate.getTime() / 1000),
      tFrom: formatYmd(startDate),
      tTo: formatYmd(endDate),
    };
  }

  return { ok: false, status: 400, error: 'Missing or invalid parameters' };
}

function mapTzevaTypeToOfficialCategory(typeValue) {
  const normalized = Number(typeValue);
  if (Number.isFinite(normalized) && Object.prototype.hasOwnProperty.call(TZEVA_ADOM_TO_OFFICIAL_API, normalized)) {
    return TZEVA_ADOM_TO_OFFICIAL_API[normalized];
  }
  const asString = String(typeValue);
  if (Object.prototype.hasOwnProperty.call(TZEVA_ADOM_TO_OFFICIAL_API, asString)) {
    return TZEVA_ADOM_TO_OFFICIAL_API[asString];
  }
  return 8;
}

function transformTzevaPayload(payload, startTs, endTs) {
  const alerts = Array.isArray(payload && payload.alerts) ? payload.alerts : [];
  if (alerts.length === 0) return [];

  const transformed = [];

  for (let i = 0; i < alerts.length; i++) {
    const alert = alerts[i] || {};
    const startTime = Number(alert.startTime);
    if (!Number.isFinite(startTime)) continue;
    if (startTime < startTs || startTime > endTs) continue;

    const cities = Array.isArray(alert.cities) ? alert.cities : [];
    if (cities.length === 0) continue;

    const category = mapTzevaTypeToOfficialCategory(alert.type);
    const categoryDesc = OFFICIAL_CATEGORY_MAP[category] || OFFICIAL_CATEGORY_MAP[8];
    const alertDate = formatIsoSeconds(new Date(startTime * 1000));

    for (let c = 0; c < cities.length; c++) {
      const city = cities[c];
      if (city === null || city === undefined) continue;
      const cityName = String(city).trim();
      if (!cityName) continue;

      transformed.push({
        data: cityName,
        alertDate: alertDate,
        category_desc: categoryDesc,
        category: category,
        rid: 0,
        __startTime: startTime,
      });
    }
  }

  transformed.sort(function(a, b) {
    return b.__startTime - a.__startTime;
  });

  return transformed.map(function(entry) {
    return {
      data: entry.data,
      alertDate: entry.alertDate,
      category_desc: entry.category_desc,
      category: entry.category,
      rid: entry.rid,
    };
  });
}

async function fetchTzevaAdomHistory(range) {
  const target = `${TZEVA_ADOM_TARGET}/${range.tFrom}/${range.tTo}`;
  let response;
  try {
    response = await fetch(target);
  } catch (error) {
    throw new Error(`Failed to fetch from Tzeva Adom: ${error && error.message ? error.message : String(error)}`);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch from Tzeva Adom: HTTP ${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Failed to parse Tzeva Adom response JSON');
  }

  return transformTzevaPayload(payload, range.startTs, range.endTs);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api2/alarms-history') {
      const providerRaw = url.searchParams.get('provider') || url.searchParams.get('service') || PROVIDERS.OFFICIAL;
      const provider = normalizeProvider(providerRaw);
      if (!provider) {
        return jsonResponse({ error: 'Invalid provider. Supported values: Official, Tzeva Adom' }, 400);
      }

      const mode = url.searchParams.get('mode') || '1';
      const fromDate = url.searchParams.get('fromDate');
      const toDate = url.searchParams.get('toDate');

      if (provider === PROVIDERS.TZEVA_ADOM) {
        const range = buildRange(mode, fromDate, toDate);
        if (!range.ok) {
          return jsonResponse({ error: range.error }, range.status || 400);
        }

        try {
          const results = await fetchTzevaAdomHistory(range);
          return jsonResponse(results, 200, {
            'Cache-Control': 'no-store',
            'X-CF-Colo': request.cf?.colo || '',
            'X-Served-By': 'worker',
          });
        } catch (error) {
          return jsonResponse({
            error: error && error.message ? error.message : 'Failed to fetch from Tzeva Adom',
          }, 502);
        }
      }

      const targetUrl = new URL(OFFICIAL_ALARMS_HISTORY_TARGET);
      targetUrl.searchParams.set('lang', 'he');
      if (fromDate && toDate) {
        targetUrl.searchParams.set('mode', '0');
        targetUrl.searchParams.set('fromDate', fromDate);
        targetUrl.searchParams.set('toDate', toDate);
      } else {
        targetUrl.searchParams.set('mode', mode);
      }

      const target = targetUrl.toString();
      const colo = request.cf?.colo || '';
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), { method: 'GET' });

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
          'X-Served-By': 'worker',
        },
      });

      if (resp.ok) {
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }

      return response;
    }

    let target = ROUTES[url.pathname];
    if (!target) return new Response('Not found', { status: 404 });

    const colo = request.cf?.colo || '';
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: 'GET' });

    // Check Cache API (edge-local, 1s TTL)
    const cached = await cache.match(cacheKey);
    if (cached) {
      const resp = new Response(cached.body, cached);
      resp.headers.set('X-CF-Colo', colo);
      return resp;
    }

    // Fetch from Oref
    const resp = await fetch(target, { headers: OREF_HEADERS });
    const body = await resp.arrayBuffer();

    const response = new Response(body, {
      status: resp.status,
      headers: {
        'Content-Type': resp.ok ? 'application/json; charset=utf-8' : (resp.headers.get('Content-Type') || 'text/plain'),
        'Cache-Control': 's-maxage=1, max-age=2',
        'X-CF-Colo': colo,
        'X-Served-By': 'worker',
      },
    });

    // Cache successful responses
    if (resp.ok) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

    return response;
  },
};
