import {orefProxy} from './_proxy.js';
import {PROVIDERS, normalizeProvider, buildRange, fetchTzevaAdomHistory} from '../../shared/tzeva-adom.js';

const OFFICIAL_TARGET = 'https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx';
const TZEVA_ADOM_CACHE_CONTROL = 's-maxage=60, max-age=30';

function jsonResponse(body, status, extraHeaders) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  };
  return new Response(JSON.stringify(body), {status, headers});
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const providerRaw = url.searchParams.get('provider') || url.searchParams.get('service') || PROVIDERS.OFFICIAL;
  const provider = normalizeProvider(providerRaw);
  if (!provider) {
    return jsonResponse({error: 'Invalid provider. Supported values: Official, Tzeva Adom'}, 400);
  }

  const fromDate = url.searchParams.get('fromDate');
  const toDate = url.searchParams.get('toDate');
  const mode = url.searchParams.get('mode') || '1'; // Default to last 24h

  if (provider === PROVIDERS.OFFICIAL) {
    const targetUrl = new URL(OFFICIAL_TARGET);
    targetUrl.searchParams.set('lang', 'he');
    targetUrl.searchParams.set('mode', mode);
    if (fromDate && toDate) {
      targetUrl.searchParams.set('fromDate', fromDate);
      targetUrl.searchParams.set('toDate', toDate);
      targetUrl.searchParams.set('mode', '0');
    }

    return orefProxy(context, {
      target: targetUrl.toString(),
      redirectSuffix: '/api2/alarms-history' + url.search,
      kind: 'alarms-history',
    });
  }

  const range = buildRange(mode, fromDate, toDate);
  if (!range.ok) {
    return jsonResponse({error: range.error}, range.status || 400);
  }

  try {
    const results = await fetchTzevaAdomHistory(range);
    return jsonResponse(results, 200, {
      'Cache-Control': TZEVA_ADOM_CACHE_CONTROL,
      'X-CF-Colo': context.request.cf?.colo || '',
      'X-Served-By': 'pages-function',
    });
  } catch (error) {
    return jsonResponse({
      error: error && error.message ? error.message : 'Failed to fetch from Tzeva Adom',
    }, 502);
  }
}

