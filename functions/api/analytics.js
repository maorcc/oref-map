const SITE_TAG = 'ce9e2bf7c82c46b1b66eb9019a526873';

export async function onRequestGet({ env }) {
  const { CF_ACCOUNT_TAG, CF_API_TOKEN } = env;
  if (!CF_ACCOUNT_TAG || !CF_API_TOKEN) {
    return new Response(JSON.stringify({ error: 'Analytics is not configured' }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': 'https://oref-map.org',
      },
    });
  }

  let result;
  try {
    result = await fetchVisitorCounts(CF_ACCOUNT_TAG, CF_API_TOKEN);
  } catch (err) {
    console.error('analytics fetch failed', err);
    return new Response(JSON.stringify({ error: 'Failed to fetch analytics' }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': 'https://oref-map.org',
      },
    });
  }

  return new Response(JSON.stringify(result), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=30',
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
        ) { sum { visits } }
        last24h: rumPageloadEventsAdaptiveGroups(
          filter: { siteTag: "${SITE_TAG}", datetime_geq: "${minus24h}" }
          limit: 1
        ) { sum { visits } }
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

  const account = json.data?.viewer?.accounts?.[0];
  if (!account) {
    throw new Error('No account data returned — check CF_ACCOUNT_TAG');
  }
  return {
    visitors_1h: account.last1h[0]?.sum?.visits ?? 0,
    visitors_24h: account.last24h[0]?.sum?.visits ?? 0,
  };
}
