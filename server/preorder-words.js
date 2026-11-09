// j+k adventures: the words for when a pre-order ships. Each pin on pre-order can have a date, set on /admin, when
// it's expected in stock and ready to ship ("2026-12-15"). With no date, or one that has passed, the shop works one
// out: N weeks from today (preorder_weeks in products.json). Buyers only ever see a date ("around december 15"), never
// a count of weeks. A bag with several pre-orders ships when the last one arrives.
// site/assets/app.js has a twin of prettyDate for the browser; keep the two saying the same thing.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// today in the shop's own time zone (California), as "2026-11-09"
export function shopToday(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

// the date, if it's a real one that hasn't passed yet; otherwise null
export function preorderDateFor(date, today = shopToday()) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return date >= today ? date : null;
}

// "december 15", or "january 8, 2028" when it's not this year
export function prettyDate(date, today = shopToday()) {
  const [y, m, d] = date.split('-').map(Number);
  return MONTHS[m - 1] + ' ' + d + (String(y) !== today.slice(0, 4) ? ', ' + y : '');
}

// N weeks from today, as "2026-12-07": the stand-in date for a pin on pre-order without one
export function fallbackDate(weeks, today = shopToday()) {
  return new Date(Date.parse(today + 'T00:00:00Z') + weeks * 7 * 86400000).toISOString().slice(0, 10);
}

// the date a pin on pre-order shows: its own, or the stand-in when it has none (or its own has passed)
export function shipDateFor(date, weeks, today = shopToday()) {
  return preorderDateFor(date, today) || fallbackDate(weeks, today);
}

// "around december 15"
export function whenWords(date, today = shopToday()) {
  return 'around ' + prettyDate(date, today);
}
