const SITE_TAG = '8ef04aca8dff4804be044bbbd8f2da66';

export async function onRequestGet({ env }) {
  const { CF_ACCOUNT_TAG, CF_API_TOKEN } = env;
  if (!CF_ACCOUNT_TAG || !CF_API_TOKEN) {
    return new Response('Missing CF_ACCOUNT_TAG or CF_API_TOKEN', { status: 500 });
  }

  let result;
  try {
    result = await fetchVisitorCounts(CF_ACCOUNT_TAG, CF_API_TOKEN);
  } catch (err) {
    return new Response(err.message, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }

  return new Response(JSON.stringify(result), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
      'Access-Control-Allow-Origin': 'https://oref-map.org',
    },
  });
}

async function fetchVisitorCounts(accountTag, apiToken) {
  if (!/^[0-9a-f]{32}$/i.test(accountTag)) {
    throw new Error('Invalid CF_ACCOUNT_TAG format');
  }

  const now = new Date();
  const minus1h = new Date(now - 60 * 60 * 1000).toISOString();
  const minus24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        last1h: rumPageloadEventsAdaptiveGroups(
          filter: { siteTag: "${SITE_TAG}", datetime_geq: "${minus1h}" }
          limit: 1
        ) { count }
        last24h: rumPageloadEventsAdaptiveGroups(
          filter: { siteTag: "${SITE_TAG}", datetime_geq: "${minus24h}" }
          limit: 1
        ) { count }
      }
    }
  }`;

  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    throw new Error(`GraphQL API returned HTTP ${res.status}`);
  }

  const json = await res.json();

  if (json.errors?.length) {
    throw new Error(json.errors.map(e => e.message).join('; '));
  }

  const account = json.data.viewer.accounts[0];
  return {
    visitors_1h: account.last1h[0]?.count ?? 0,
    visitors_24h: account.last24h[0]?.count ?? 0,
  };
}
