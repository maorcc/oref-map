export async function onRequest(context) {
  const { request, env, params } = context;
  
  const referer = request.headers.get('Referer') || '';
  const origin = request.headers.get('Origin') || '';
  
  // Updated to check for your new testing domain
  if (!referer.includes('test.alprazolam.cfd') && !origin.includes('test.alprazolam.cfd')) {
      return new Response('Forbidden', { status: 403 });
  }

  const mapTilerPath = params.path.join('/');
  const targetUrl = `https://api.maptiler.com/${mapTilerPath}?key=${env.MAPTILER_KEY}`;

  const response = await fetch(targetUrl, {
      method: request.method,
      headers: {
          'Accept': request.headers.get('Accept')
      }
  });

  const newResponse = new Response(response.body, response);
  newResponse.headers.set('Cache-Control', 'public, max-age=86400');
  
  return newResponse;
}
