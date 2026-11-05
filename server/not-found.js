// j+k adventures: the friendly "page not found" page (site/404.html, "this page wandered off.") for any address
// we don't have, still answered as a 404 so search engines drop dead links.
//
// The worker does this itself instead of Cloudflare's not_found_handling setting: with that setting on, Cloudflare
// answers a browser's visit to /pup-club/corgi with "not found" before the worker can build the pup's page.

export async function staticOrNotFound(request, env) {
  const res = await env.ASSETS.fetch(request);
  if (res.status !== 404 || !['GET', 'HEAD'].includes(request.method)) return res;
  const page = await env.ASSETS.fetch(new Request(new URL('/404', request.url)));
  if (!page.ok) return res;
  return new Response(request.method === 'HEAD' ? null : page.body, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }
  });
}
