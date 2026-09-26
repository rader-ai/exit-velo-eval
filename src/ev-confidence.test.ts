import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { gateEv } from './ev-confidence.ts';

const clean = { n: 15, straightnessPx: 1.5, dPxMean: 20, dPxStd: 3, evMph: 40 };

test('a clean side-on flight is trusted (high)', () => {
  const g = gateEv(clean);
  assert.equal(g.trust, true);
  assert.equal(g.confidence, 'high');
  assert.equal(g.ev, 40);
});

test('too few flight frames → no read, not a number', () => {
  const g = gateEv({ ...clean, n: 3 });
  assert.equal(g.trust, false);
  assert.equal(g.ev, null);
  assert.match(g.reason, /few flight frames/);
});

test('implausibly low EV (lost the ball → single digits) → no read', () => {
  const g = gateEv({ ...clean, evMph: 5 });
  assert.equal(g.ev, null);
  assert.match(g.reason, /low/);
});

test('the 82mph decoy → no read', () => {
  const g = gateEv({ ...clean, evMph: 82 });
  assert.equal(g.ev, null);
  assert.match(g.reason, /high|decoy/);
});

test('a non-straight track (bat/limb decoy) → no read', () => {
  const g = gateEv({ ...clean, straightnessPx: 8 });
  assert.equal(g.ev, null);
  assert.match(g.reason, /straight|ball/);
});

test('erratic velocity (noise) → no read', () => {
  const g = gateEv({ ...clean, dPxMean: 20, dPxStd: 15 }); // cv 0.75
  assert.equal(g.ev, null);
  assert.match(g.reason, /unstable/);
});

test('a borderline-but-real flight is trusted as medium', () => {
  const g = gateEv({ n: 6, straightnessPx: 2.0, dPxMean: 20, dPxStd: 7, evMph: 33 }); // cv 0.35
  assert.equal(g.trust, true);
  assert.equal(g.confidence, 'medium');
  assert.equal(g.ev, 33);
});

test('gateEv EV ceiling is overridable for older cohorts (default still holds)', () => {
  // A real 17yo/college swing at 84-95 mph must be trustable when the caller
  // raises the ceiling from the hitter's cohort; the youth default stays 80.
  const strong = { ...clean, n: 9, evMph: 88 };
  assert.equal(gateEv(strong).trust, false); // default youth cap
  const raised = gateEv(strong, { evMaxMph: 100 });
  assert.equal(raised.trust, true);
  assert.equal(raised.ev, 88);
  assert.equal(gateEv({ ...clean, evMph: 105 }, { evMaxMph: 100 }).trust, false);
});
