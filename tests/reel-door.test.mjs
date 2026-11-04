// The reel door's maths (site/assets/reel-door.js), checked against docs/reel-door-spec.md.
// The file is a browser script, so it runs here in a small sandbox with no document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const box = { globalThis: {} };
box.globalThis = box;
vm.runInNewContext(readFileSync(new URL('../site/assets/reel-door.js', import.meta.url), 'utf8'), box);
const { place, reach, settleAngle, cardShadow, CARD_W, CARD_H, instagramLink, DEFAULTS, PLACEHOLDER_REELS } = box.ReelDoor;

const N = 8, s = 360 / N, W = 208;
const Rx = reach(N, W, DEFAULTS.spread);
const at = (i, angle) => place(i, N, angle, Rx, DEFAULTS);

test('at rest every reel faces forward, the front one is biggest and on top', () => {
  const all = Array.from({ length: N }, (_, i) => at(i, 0));
  for (const p of all) assert.ok(Math.abs(p.rotY) < 1e-9);
  for (const p of all.slice(1)) {
    assert.ok(all[0].scale > p.scale);
    assert.ok(all[0].zIndex > p.zIndex);
  }
  assert.equal(all[0].x, 0);
  assert.equal(all[0].haze, 0);
  // neighbours sit either side, the same distance away, and rear reels rise
  assert.ok(Math.abs(all[1].x + all[N - 1].x) < 1e-9);
  assert.ok(all[4].y < 0);
});

test('the front reel covers about a fifth of each neighbour', () => {
  const f = at(0, 0), n = at(1, 0);
  const overlap = (W * f.scale) / 2 + (W * n.scale) / 2 - n.x;
  const share = overlap / (W * n.scale);
  assert.ok(share > 0.15 && share < 0.32, 'overlap share ' + share.toFixed(3));
});

test('mid-swap the two reels swing out, pop forward and turn away, mirrored both ways', () => {
  const half = s / 2;
  const a = at(0, half), b = at(1, half);           // reel 0 leaving to the left, reel 1 arriving from the right
  assert.ok(a.x < 0 && b.x > 0, 'they pass on opposite sides');
  assert.ok(a.rotY < 0 && b.rotY > 0, 'each turns away from the centre');
  assert.ok(Math.abs(a.rotY) === DEFAULTS.swing && Math.abs(b.rotY) === DEFAULTS.swing, 'swing peaks halfway');
  const gap = (b.x - (W * b.scale) / 2) - (a.x + (W * a.scale) / 2);
  assert.ok(gap > -W * 0.3, 'not stacked on top of each other');
  // the other direction is the mirror image
  const c = at(0, -half), d = at(N - 1, -half);
  assert.ok(Math.abs(c.x + a.x) < 1e-9 && Math.abs(c.rotY + a.rotY) < 1e-9);
  assert.ok(Math.abs(d.x + b.x) < 1e-9);
});

test('stacking follows distance from the front, closest on top', () => {
  for (let angle = 0; angle < 360; angle += 7.5) {
    const ps = Array.from({ length: N }, (_, i) => at(i, angle)).sort((p, q) => Math.abs(p.d) - Math.abs(q.d));
    for (let k = 1; k < N; k++) assert.ok(ps[k - 1].zIndex >= ps[k].zIndex);
  }
});

test('the ring loops: one full turn puts everything back', () => {
  for (let i = 0; i < N; i++) {
    const p = at(i, 30), q = at(i, 390);
    assert.ok(Math.abs(p.x - q.x) < 1e-9 && Math.abs(p.scale - q.scale) < 1e-9);
  }
});

test('a release snaps to a reel, coasts on speed, and never goes more than 3 reels', () => {
  assert.equal(settleAngle(10, 0, s), 0);
  assert.equal(settleAngle(30, 0, s), 45);
  assert.equal(settleAngle(0, 200, s), 45);           // 200°/s × 0.22 s = 44°, the next reel
  assert.equal(settleAngle(0, 100000, s), 3 * s);     // a huge fling is capped
  assert.equal(settleAngle(0, -100000, s), -3 * s);
  assert.equal(settleAngle(90, 100000, s), 90 + 3 * s);
});

test('eight placeholder reels in the spec shape, lowercase, no exclamation marks', () => {
  assert.equal(PLACEHOLDER_REELS.length, 8);
  for (const r of PLACEHOLDER_REELS) {
    assert.ok(r.id && r.thumbnailUrl && r.permalink);
    assert.equal(r.caption, r.caption.toLowerCase());
    assert.ok(!r.caption.includes('!'));
  }
});

test('"watch on instagram" only ever links to a real instagram reel or post', () => {
  assert.equal(instagramLink('https://www.instagram.com/reel/C9xYz_12-ab/'), 'https://www.instagram.com/reel/C9xYz_12-ab/');
  assert.equal(instagramLink('https://instagram.com/reels/C9xYz_12-ab'), 'https://www.instagram.com/reel/C9xYz_12-ab/');
  assert.equal(instagramLink('https://www.instagram.com/p/C9xYz_12-ab/?igsh=abc'), 'https://www.instagram.com/p/C9xYz_12-ab/');
  for (const bad of ['https://www.instagram.com/ourjkadventures/', 'https://evil.example/reel/C9xYz/', 'http://www.instagram.com/reel/C9xYz_12-ab/',
    'javascript:alert(1)', 'https://www.instagram.com/reel/../../x/', 'https://www.instagram.com.evil.example/reel/C9xYz_12-ab/', undefined]) {
    assert.equal(instagramLink(bad), '', String(bad));
  }
});

test('the backing card is the printed 212 x 436', () => {
  assert.equal(CARD_W, 212);
  assert.equal(CARD_H, 436);
});

test('the shadow is warm brown, grows as a card lifts or swaps, fades at the back and falls to the right', () => {
  const rgba = /rgba\(58,53,50,/g;
  const frontS = cardShadow(at(0, 0)), side = cardShadow(at(1, 0)), back = cardShadow(at(4, 0));
  const mid = cardShadow(at(0, s / 2));
  assert.equal((frontS.css.match(rgba) || []).length, 2, 'two layers, both in the ink brown');
  assert.ok(frontS.k > side.k, 'the lifted front card casts more shadow than a neighbour');
  assert.ok(mid.k > side.k, 'a card mid-swap casts more than one at rest beside it');
  assert.ok(back.fade < side.fade && back.fade < frontS.fade, 'the shadow fades toward the back');
  assert.ok(frontS.sx > 0, 'the light is up and to the left, so the shadow falls right');
  assert.ok(frontS.k <= 1.4 && mid.k <= 1.4);
});

test('counts are written the way instagram writes them', () => {
  const { shortCount } = box.ReelDoor;
  assert.deepEqual([0, 7, 999, 1000, 1234, 9999, 12345, 999999, 1000000, 1450000, 23000000].map(shortCount),
    ['0', '7', '999', '1k', '1.2k', '9.9k', '12k', '999k', '1m', '1.4m', '23m']);
});
