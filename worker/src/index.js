const OREF_HEADERS = {
  'Referer': 'https://www.oref.org.il/',
  'X-Requested-With': 'XMLHttpRequest',
};

const ROUTES = {
  '/api2/alerts': 'https://www.oref.org.il/warningMessages/alert/Alerts.json',
  '/api2/history': 'https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json',
  '/api2/alarms-history': 'https://alerts-history.oref.org.il//Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const target = ROUTES[url.pathname];
    if (!target) return new Response('Not found', {
      status: 404,
      headers: { 'Access-Control-Allow-Origin': 'https://oref-map.org' },
    });

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': 'https://oref-map.org',
          'Access-Control-Expose-Headers': 'X-CF-Colo, X-Served-By',
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const colo = request.cf?.colo || '';
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: 'GET' });

    // Check Cache API (edge-local, 1s TTL)
    const cached = await cache.match(cacheKey);
    if (cached) {
      const resp = new Response(cached.body, cached);
      resp.headers.set('X-CF-Colo', colo);
      resp.headers.set('Access-Control-Allow-Origin', 'https://oref-map.org');
      resp.headers.set('Access-Control-Expose-Headers', 'X-CF-Colo, X-Served-By');
      return resp;
    }

    // Fetch from Oref
    const resp = await fetch(target, { headers: OREF_HEADERS });
    const body = await resp.arrayBuffer();

    const response = new Response(body, {
      status: resp.status,
      headers: {
        'Content-Type': resp.ok ? 'application/json; charset=utf-8' : (resp.headers.get('Content-Type') || 'text/plain'),
        'Cache-Control': 's-maxage=4, max-age=3',
        'Access-Control-Allow-Origin': 'https://oref-map.org',
        'Access-Control-Expose-Headers': 'X-CF-Colo, X-Served-By',
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
