import { orefProxy } from './_proxy.js';

export async function onRequestGet(context) {
  return orefProxy(context, {
    target: 'https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json',
    redirectSuffix: '/api2/history',
    kind: 'history',
  });
}
