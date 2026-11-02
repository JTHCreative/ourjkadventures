// The reel door's maths (site/assets/reel-door.js), checked against docs/reel-door-spec.md.
// The file is a browser script, so it runs here in a small sandbox with no document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const box = { globalThis: {} };
box.globalThis = box;
vm.runInNewContext(readFileSync(new URL('../site/assets/reel-door.js', import.meta.url), 'utf8'), box);
const { place, reach, settleAngle, DEFAULTS, PLACEHOLDER_REELS } = box.ReelDoor;

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
