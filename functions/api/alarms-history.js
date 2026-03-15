import { orefProxy } from './_proxy.js';

export async function onRequestGet(context) {
  return orefProxy(context, {
    target: 'https://alerts-history.oref.org.il//Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1',
    redirectPath: 'https://proxy1.oref-proxy.workers.dev/api2/alarms-history',
    kind: 'alarms-history',
  });
}
