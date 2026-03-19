import {PROVIDERS, normalizeProvider, buildRange, fetchTzevaAdomHistory} from '../../shared/tzeva-adom.js';

const OREF_HEADERS = {
  'Referer': 'https://www.oref.org.il/',
  'X-Requested-With': 'XMLHttpRequest',
};

const CORS_ALLOW_ORIGIN = 'https://oref-map.org';
const CORS_EXPOSE_HEADERS = 'X-CF-Colo, X-Served-By';

const OFFICIAL_ALARMS_HISTORY_TARGET = 'https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx';
const TZEVA_ADOM_CACHE_CONTROL = 's-maxage=60, max-age=30';

const ROUTES = {
  '/api2/alerts': 'https://www.oref.org.il/warningMessages/alert/Alerts.json',
  '/api2/history': 'https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json',
};

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
        return jsonResponse({error: 'Invalid provider. Supported values: Official, Tzeva Adom'}, 400);
      }

      const mode = url.searchParams.get('mode') || '1';
      const fromDate = url.searchParams.get('fromDate');
      const toDate = url.searchParams.get('toDate');

      if (provider === PROVIDERS.TZEVA_ADOM) {
        const range = buildRange(mode, fromDate, toDate);
        if (!range.ok) {
          return jsonResponse({error: range.error}, range.status || 400);
        }

        const colo = request.cf?.colo || '';
        const cache = caches.default;
        const cacheKey = new Request(url.toString(), {method: 'GET'});

        const cached = await cache.match(cacheKey);
        if (cached) {
          const resp = new Response(cached.body, cached);
          resp.headers.set('X-CF-Colo', colo);
          resp.headers.set('Access-Control-Allow-Origin', CORS_ALLOW_ORIGIN);
          resp.headers.set('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS);
          return resp;
        }

        try {
          const results = await fetchTzevaAdomHistory(range);
          const response = jsonResponse(results, 200, {
            'Cache-Control': TZEVA_ADOM_CACHE_CONTROL,
            'X-CF-Colo': colo,
            'X-Served-By': 'worker',
          });
          ctx.waitUntil(cache.put(cacheKey, response.clone()));
          return response;
        } catch (error) {
          return jsonResponse({
            error: error && error.message ? error.message : 'Failed to fetch from Tzeva Adom',
          }, 502);
        }
      }

      // Official provider logic
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
      const cacheKey = new Request(url.toString(), {method: 'GET'});

      const cached = await cache.match(cacheKey);
      if (cached) {
        const resp = new Response(cached.body, cached);
        resp.headers.set('X-CF-Colo', colo);
        resp.headers.set('Access-Control-Allow-Origin', CORS_ALLOW_ORIGIN);
        resp.headers.set('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS);
        return resp;
      }

      let resp;
      let body;
      try {
        resp = await fetch(target, {headers: OREF_HEADERS});
        body = await resp.arrayBuffer();
      } catch (error) {
        return jsonResponse(
          {error: 'Official provider upstream fetch failed'},
          502,
          {
            'Cache-Control': 'no-store',
            'X-CF-Colo': colo,
            'X-Served-By': 'worker',
          }
        );
      }

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
      headers: {'Access-Control-Allow-Origin': CORS_ALLOW_ORIGIN},
    });

    const colo = request.cf?.colo || '';
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), {method: 'GET'});

    const cached = await cache.match(cacheKey);
    if (cached) {
      const resp = new Response(cached.body, cached);
      resp.headers.set('X-CF-Colo', colo);
      resp.headers.set('Access-Control-Allow-Origin', CORS_ALLOW_ORIGIN);
      resp.headers.set('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS);
      return resp;
    }

    let resp;
    let body;
    try {
      resp = await fetch(target, {headers: OREF_HEADERS});
      body = await resp.arrayBuffer();
    } catch (error) {
      return new Response('Upstream fetch failed', {
        status: 502,
        headers: {
          'Access-Control-Allow-Origin': CORS_ALLOW_ORIGIN,
          'Access-Control-Expose-Headers': CORS_EXPOSE_HEADERS,
          'Cache-Control': 'no-store',
          'X-CF-Colo': colo,
          'X-Served-By': 'worker',
        },
      });
    }

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



