const TARGET = 'https://www.oref.org.il/warningMessages/alert/Alerts.json';

const OREF_HEADERS = {
  'Referer': 'https://www.oref.org.il/',
  'X-Requested-With': 'XMLHttpRequest',
};

export async function onRequestGet(context) {
  const colo = context.request.cf?.colo || '';
  const resp = await fetch(TARGET, { headers: OREF_HEADERS });
  const body = await resp.arrayBuffer();
  return new Response(body, {
    status: resp.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': resp.headers.get('Cache-Control') || 'public, max-age=2',
      'X-CF-Colo': colo,
    },
  });
}