import { orefProxy } from './_proxy.js';

export async function onRequestGet(context) {
  return orefProxy(context, {
    target: 'https://www.oref.org.il/warningMessages/alert/Alerts.json',
    redirectSuffix: '/api2/alerts',
    kind: 'alerts',
  });
}
