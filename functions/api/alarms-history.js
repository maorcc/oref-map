import { orefProxy } from './_proxy.js';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const fromDate = url.searchParams.get('fromDate');
  const toDate = url.searchParams.get('toDate');
  const mode = url.searchParams.get('mode') || '1'; // Default to last 24h

  // let target = 'http://127.0.0.1:5000/Shared/Ajax/GetAlarmsHistory.aspx';
  let target = 'https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx'

  const targetUrl = new URL(target)
  targetUrl.searchParams.set('lang', 'he');
  targetUrl.searchParams.set('mode', mode);
  if (fromDate && toDate) {
    targetUrl.searchParams.set('fromDate', fromDate);
    targetUrl.searchParams.set('toDate', toDate);
    targetUrl.searchParams.set('mode', '0');
  }

  return orefProxy(context, {
    target: targetUrl.toString(),
    redirectPath: '/api2/alarms-history' + url.search,
    kind: 'alarms-history',
  });
}
