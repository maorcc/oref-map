const TARGET = 'https://alerts-history.oref.org.il//Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1';
const OREF_HEADERS = {
  'Referer': 'https://www.oref.org.il/',
  'X-Requested-With': 'XMLHttpRequest',
};

export async function onRequestGet(context) {
  const colo = context.request.cf?.colo || '';

  if (colo !== 'TLV') {
    return new Response(null, {
      status: 303,
      headers: { 'Location': '/api2/alarms-history', 'X-CF-Colo': colo },
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

  const resp = await fetch(TARGET, { headers: OREF_HEADERS });
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

  if (resp.ok) context.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
}
