import { orefProxy } from './_proxy.js';

export async function onRequestGet(context) {
  return orefProxy(context, {
    target: 'https://www.oref.org.il/warningMessages/alert/Alerts.json',
    redirectPath: 'https://proxy1.oref-proxy.workers.dev/api2/alerts',
    kind: 'alerts',
  });
}
