export async function onRequestGet({ env }) {
  const result = await fetchVisitorCounts(env.CF_ACCOUNT_TAG, env.CF_API_TOKEN);

  return new Response(JSON.stringify(result), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
      'Access-Control-Allow-Origin': 'https://oref-map.org',
    },
  });
}

async function fetchVisitorCounts(accountTag, apiToken) {
  const now = new Date();
  const minus1h = new Date(now - 60 * 60 * 1000).toISOString();
  const minus24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        last1h: rumPageloadEventsAdaptiveGroups(
          filter: { siteTag: "oref-map.org", datetime_geq: "${minus1h}" }
          limit: 1
        ) { count }
        last24h: rumPageloadEventsAdaptiveGroups(
          filter: { siteTag: "oref-map.org", datetime_geq: "${minus24h}" }
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

  const json = await res.json();
  const account = json?.data?.viewer?.accounts?.[0];
  return {
    visitors_1h: account?.last1h?.[0]?.count ?? 0,
    visitors_24h: account?.last24h?.[0]?.count ?? 0,
  };
}
