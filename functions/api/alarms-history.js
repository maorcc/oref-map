import { orefProxy } from './_proxy.js';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const fromDate = url.searchParams.get('fromDate');
  const toDate = url.searchParams.get('toDate');
  // let target = 'http://127.0.0.1:5000/Shared/Ajax/GetAlarmsHistory.aspx';
  let target = 'https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx'
  const targetUrl = new URL(target)
  targetUrl.searchParams.set('lang', 'he');
  targetUrl.searchParams.set('mode', '0');
  if (fromDate && toDate) {
    targetUrl.searchParams.set('fromDate', fromDate);
    targetUrl.searchParams.set('toDate', toDate);
  }

  return orefProxy(context, {
    target: targetUrl.toString(),
      redirectSuffix: '/api2/alarms-history',
    kind: 'alarms-history',
  });
}
