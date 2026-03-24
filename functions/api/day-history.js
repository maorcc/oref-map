export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const date = url.searchParams.get('date');

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return new Response('Bad Request: ?date=YYYY-MM-DD required', { status: 400 });
  }

  // Local dev: proxy to production
  if (!context.env.HISTORY_BUCKET) {
    return fetch(`https://oref-map.org/api/day-history?date=${date}`);
  }

  const todayIsrael = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jerusalem' }).format(new Date());

  const obj = await context.env.HISTORY_BUCKET.get(`${date}.jsonl`);
  if (!obj) {
    if (date === todayIsrael) {
      return new Response('[]', {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
      });
    }
    return new Response('Not Found', { status: 404 });
  }

  const text = await obj.text();
  const json = '[' + text.trimEnd().slice(0, -1) + ']';

  // Past days are immutable — cache for 1 hour. Today changes every 15 min.
  const cacheControl = date < todayIsrael ? 'public, max-age=3600' : 'public, max-age=60';

  return new Response(json, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
    },
  });
}
