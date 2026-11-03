// The featured carousel's maths (site/assets/featured.js). The file is a browser script, so it runs here in a
// small sandbox with no document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const box = {};
box.globalThis = box;
vm.runInNewContext(readFileSync(new URL('../site/assets/featured.js', import.meta.url), 'utf8'), box);
const { spot, frontAngle, drift, CRUISE } = box.Featured;

test('the front item is centred, biggest, on top and lowest; the one opposite is smallest and highest', () => {
  const N = 6, all = Array.from({ length: N }, (_, i) => spot(i, N, 0, 300, 40));
  assert.ok(Math.abs(all[0].x) < 1e-9);
  assert.ok(Math.abs(all[0].y) < 1e-9);
  for (const p of all.slice(1)) { assert.ok(all[0].scale > p.scale); assert.ok(all[0].zIndex > p.zIndex); }
  assert.ok(Math.abs(all[3].y + 40) < 1e-9);
  // neighbours sit either side, the same distance out
  assert.ok(Math.abs(all[1].x + all[5].x) < 1e-9);
});

test('turning the ring to frontAngle brings that item to the front, the short way round', () => {
  const N = 8;
  for (let i = 0; i < N; i++) {
    const a = frontAngle(i, N, 1000);
    assert.ok(Math.abs(a - 1000) <= 180);
    assert.ok(spot(i, N, a, 300, 40).f > 0.999);
  }
});

test('a fast spin drifts back toward cruise within about ten seconds, never past it', () => {
  let w = 800;
  for (let k = 0; k < 600; k++) { w = drift(w, CRUISE, 1 / 60); assert.ok(w >= CRUISE); }
  assert.ok(w < CRUISE + 2);
  assert.equal(drift(CRUISE, CRUISE, 1 / 60), CRUISE);
});

test('one or two picks are repeated round the ring so it still turns; three or more stand once each', () => {
  const two = box.Featured.ringOf([{ id: 'a' }, { id: 'b' }]);
  assert.equal(two.length, 6);
  assert.equal(two.map((s) => s.it.id).join(''), 'ababab');
  assert.equal(JSON.stringify(two.map((s) => s.copy)), '[false,false,true,true,true,true]');
  assert.equal(box.Featured.ringOf([{ id: 'a' }]).length, 6);
  const three = box.Featured.ringOf([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  assert.equal(three.length, 3);
  assert.ok(three.every((s) => !s.copy));
});
