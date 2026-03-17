const OREF_HEADERS = {
  'Referer': 'https://www.oref.org.il/',
  'X-Requested-With': 'XMLHttpRequest',
};

const CORS_ALLOW_ORIGIN = 'https://oref-map.org';
const CORS_EXPOSE_HEADERS = 'X-CF-Colo, X-Served-By';

const PROVIDERS = {
  OFFICIAL: 'official',
  TZEVA_ADOM: 'tzeva-adom',
};

const OFFICIAL_ALARMS_HISTORY_TARGET = 'https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx';
const TZEVA_ADOM_TARGET = 'https://tzevadom.com/api/alerts-history/summary/custom';

const TZEVA_ADOM_TO_OFFICIAL_API = {
  0: 1,
  2: 3,
  3: 2, // an old alert type used only on2 26/10/2024 04:02 for Drone from Lebanon
  5: 2,
  11: 14
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
  14: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
  99: "ללא שיוך"
};

const ROUTES = {
  '/api2/alerts': 'https://www.oref.org.il/warningMessages/alert/Alerts.json',
  '/api2/history': 'https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json',
  '/api2/alarms-history': OFFICIAL_ALARMS_HISTORY_TARGET,
};

function resolveOfficialTarget(env) {
  return (env && env.ALARMS_HISTORY_TARGET) ? env.ALARMS_HISTORY_TARGET : OFFICIAL_ALARMS_HISTORY_TARGET;
}

function jsonResponse(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': CORS_ALLOW_ORIGIN,
      'Access-Control-Expose-Headers': CORS_EXPOSE_HEADERS,
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

// Updated formatIsoSeconds from functions/api/alarms-history.js
function formatIsoSeconds(dateObj) {
    const options = {
        timeZone: 'Asia/Jerusalem',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    };
    // The 'sv' locale (Swedish) is commonly used to get an ISO-like format.
    // It produces 'YYYY-MM-DD HH:mm:ss'. We just need to replace the space with a 'T'.
    return new Intl.DateTimeFormat('sv', options).format(dateObj).replace(' ', 'T');
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

// Updated buildRange from functions/api/alarms-history.js
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
      mode: mode,
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
      mode: mode,
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
  return 99 // Fallback category
}

// Updated transformTzevaPayload from functions/api/alarms-history.js
function transformTzevaPayload(payload, startTs, endTs) {
  const alerts = Array.isArray(payload && payload.alerts) ? payload.alerts : [];
  if (alerts.length === 0) return [];

  const transformed = [];

  for (let i = 0; i < alerts.length; i++) {
    const alert = alerts[i] || {};
    const cities = Array.isArray(alert.cities) ? alert.cities : [];
    if (cities.length === 0) continue;

    // Create "start" event
    const startTime = Number(alert.startTime);
    if (Number.isFinite(startTime) && startTime >= startTs && startTime <= endTs) {
      const startCategory = mapTzevaTypeToOfficialCategory(alert.type);
      const startCategoryDesc = OFFICIAL_CATEGORY_MAP[startCategory] || OFFICIAL_CATEGORY_MAP[99];
      const startAlertDate = formatIsoSeconds(new Date(startTime * 1000));
      if (startCategory === 99) {
        console.error(`Unknown Tzeva Adom type: ${alert.type}, at time: ${startAlertDate}`);
      }

      for (let c = 0; c < cities.length; c++) {
        const city = cities[c];
        if (city === null || city === undefined) continue;
        const cityName = String(city).trim();
        if (!cityName) continue;

        transformed.push({
          data: cityName,
          alertDate: startAlertDate,
          category_desc: startCategoryDesc,
          category: startCategory,
          rid: 0,
          __timestamp: startTime,
        });
      }
    }

    // Create "end" event
    const endTime = Number(alert.endTime);
    if (Number.isFinite(endTime) && endTime > 0 && endTime >= startTs && endTime <= endTs) {
      const endCategory = 13;
      const endCategoryDesc = OFFICIAL_CATEGORY_MAP[endCategory];
      const endAlertDate = formatIsoSeconds(new Date(endTime * 1000));

      for (let c = 0; c < cities.length; c++) {
        const city = cities[c];
        if (city === null || city === undefined) continue;
        const cityName = String(city).trim();
        if (!cityName) continue;

        transformed.push({
          data: cityName,
          alertDate: endAlertDate,
          category_desc: endCategoryDesc,
          category: endCategory,
          rid: 0,
          __timestamp: endTime,
        });
      }
    }
  }

  transformed.sort(function(a, b) {
    return b.__timestamp - a.__timestamp;
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

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': CORS_ALLOW_ORIGIN,
          'Access-Control-Expose-Headers': CORS_EXPOSE_HEADERS,
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

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

      // Official provider logic
      const targetUrl = new URL(resolveOfficialTarget(env));
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
        resp.headers.set('Access-Control-Allow-Origin', CORS_ALLOW_ORIGIN);
        resp.headers.set('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS);
        return resp;
      }

      const resp = await fetch(target, { headers: OREF_HEADERS });
      const body = await resp.arrayBuffer();

      const response = new Response(body, {
        status: resp.status,
        headers: {
          'Content-Type': resp.ok ? 'application/json; charset=utf-8' : (resp.headers.get('Content-Type') || 'text/plain'),
          'Cache-Control': 's-maxage=4, max-age=3',
          'Access-Control-Allow-Origin': CORS_ALLOW_ORIGIN,
          'Access-Control-Expose-Headers': CORS_EXPOSE_HEADERS,
          'X-CF-Colo': colo,
          'X-Served-By': 'worker',
        },
      });

      if (resp.ok) {
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }

      return response;
    }

    // Keep existing logic for other routes
    let target = ROUTES[url.pathname];
    if (!target) return new Response('Not found', {
      status: 404,
      headers: { 'Access-Control-Allow-Origin': CORS_ALLOW_ORIGIN },
    });

    const colo = request.cf?.colo || '';
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: 'GET' });

    const cached = await cache.match(cacheKey);
    if (cached) {
      const resp = new Response(cached.body, cached);
      resp.headers.set('X-CF-Colo', colo);
      resp.headers.set('Access-Control-Allow-Origin', CORS_ALLOW_ORIGIN);
      resp.headers.set('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS);
      return resp;
    }

    const resp = await fetch(target, { headers: OREF_HEADERS });
    const body = await resp.arrayBuffer();

    const response = new Response(body, {
      status: resp.status,
      headers: {
        'Content-Type': resp.ok ? 'application/json; charset=utf-8' : (resp.headers.get('Content-Type') || 'text/plain'),
        'Cache-Control': 's-maxage=4, max-age=3',
        'Access-Control-Allow-Origin': CORS_ALLOW_ORIGIN,
        'Access-Control-Expose-Headers': CORS_EXPOSE_HEADERS,
        'X-CF-Colo': colo,
        'X-Served-By': 'worker',
      },
    });

    if (resp.ok) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

    return response;
  },
};
