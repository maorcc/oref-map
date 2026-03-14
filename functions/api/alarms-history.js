import { orefProxy } from './_proxy.js';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const fromDate = url.searchParams.get('fromDate');
  const toDate = url.searchParams.get('toDate');
  
  // let targetUrl = 'http://127.0.0.1:5000/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=0';
  let targetUrl = 'https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=0';

  if (fromDate && toDate) {
    targetUrl += `&fromDate=${fromDate}&toDate=${toDate}`;
  }

  return orefProxy(context, {
    target: targetUrl,
    redirectPath: '/api2/alarms-history' + url.search,
    kind: 'alarms-history',
  });
}
