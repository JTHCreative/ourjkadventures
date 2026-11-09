// j+k adventures: "did this come from one of our own pages?" The shop answers at ourjkadventures.com and at
// www.ourjkadventures.com, and the two count as the same house: the www is just the side door. A request from
// another website (another house) is turned away, so it can't make its visitors vote or sign up.
// Browsers send an Origin line with every POST from a page; no Origin at all (curl, a mail app's stop button) is fine.

function house(hostname) { return String(hostname || '').toLowerCase().replace(/^www\./, ''); }

export function fromOurSite(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  let from;
  try { from = new URL(origin); } catch (e) { return false; }
  const here = new URL(request.url);
  return from.protocol === here.protocol && house(from.hostname) === house(here.hostname) && from.port === here.port;
}
