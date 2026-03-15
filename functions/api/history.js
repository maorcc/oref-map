import { orefProxy } from './_proxy.js';

export async function onRequestGet(context) {
  return orefProxy(context, {
    target: 'https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json',
    redirectPath: 'https://proxy1.oref-proxy.workers.dev/api2/history',
    kind: 'history',
  });
}
