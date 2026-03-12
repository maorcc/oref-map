// Proxies locations_polygons.json from the private oref-polygons Pages project.
// Uses Cache API for 24h edge caching (polygons change only when pipeline re-runs).
// In local dev, web/locations_polygons.json (static file) takes precedence — function not invoked.
export async function onRequestGet(context) {
  const cache = caches.default;
  const upstream = 'https://oref-polygons.pages.dev/locations_polygons.json';
  const cacheKey = new Request(upstream);

  let response = await cache.match(cacheKey);
  if (response) return response;

  response = await fetch(upstream);
  if (!response.ok) {
    return new Response('Failed to load polygons', { status: 502 });
  }

  const toCache = new Response(response.body, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=86400',
    },
  });

  context.waitUntil(cache.put(cacheKey, toCache.clone()));
  return toCache;
}
