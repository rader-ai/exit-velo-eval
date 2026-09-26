import test from 'node:test';
import assert from 'node:assert/strict';

import { ballSpec, ballDiameterM, ballSpecForAge, ballSpecForKind } from './ball-spec.ts';

test('baseball is ~73mm, white, luma-detected at every age', () => {
  for (const c of ['teeball', '8-10', '10-12', '13-15']) {
    const s = ballSpec('baseball', c);
    assert.equal(s.kind, 'baseball');
    assert.ok(Math.abs(s.diameterM - 0.073) < 0.002, `${c}: ${s.diameterM}`);
    assert.equal(s.color, 'white');
    assert.equal(s.detect.colorMode, 'luma'); // a sunlit white baseball isn't color-separable (docs/research/13)
  }
});

test('softball GROWS with division: 11" for ≤10U, 12" for 12U+', () => {
  const young = ballSpec('softball', '8-9');
  assert.equal(young.kind, 'softball-11');
  assert.ok(Math.abs(young.diameterM - 0.0889) < 0.002, `11": ${young.diameterM}`);

  const older = ballSpec('softball', '10-12');
  assert.equal(older.kind, 'softball-12');
  assert.ok(Math.abs(older.diameterM - 0.097) < 0.002, `12": ${older.diameterM}`);
});

test('softball is optic-yellow → color-gated detection (the prior that fences out dirt/clutter)', () => {
  const s = ballSpec('softball', '10-12');
  assert.equal(s.color, 'optic-yellow');
  assert.equal(s.detect.colorMode, 'optic-yellow');
});

test('the 11" vs 12" gap is big enough to matter for EV via self-scale (~9%)', () => {
  // measuring an 11" ball with a 12" assumption mis-scales every frame → ~9% EV error
  const r = ballSpec('softball', '10-12').diameterM / ballSpec('softball', '8-9').diameterM;
  assert.ok(r > 1.07 && r < 1.12, `12"/11" ≈ 1.09, got ${r}`);
});

test('age helper: softball ≤10U → 11", ≥12U → 12"', () => {
  assert.equal(ballSpecForAge('softball', 8).kind, 'softball-11');
  assert.equal(ballSpecForAge('softball', 10).kind, 'softball-11');
  assert.equal(ballSpecForAge('softball', 12).kind, 'softball-12');
  assert.equal(ballSpecForAge('baseball', 8).kind, 'baseball');
});

test('ballSpecForKind round-trips every kind (the Hitter.ballKind path)', () => {
  for (const k of ['baseball', 'softball-11', 'softball-12'] as const) assert.equal(ballSpecForKind(k).kind, k);
  // the case the cohort key cannot resolve: a 10-year-old sits in '10-12' (12") but 10U plays the 11"
  assert.equal(ballSpec('softball', '10-12').kind, 'softball-12');
  assert.equal(ballSpecForAge('softball', 10).kind, 'softball-11');
  assert.ok(Math.abs(ballSpecForKind('softball-11').diameterM / ballSpecForKind('softball-12').diameterM - 11 / 12) < 1e-9);
});

test('ballDiameterM convenience matches ballSpec (feeds Calibration.ballDiamM)', () => {
  assert.equal(ballDiameterM('softball', '8-9'), ballSpec('softball', '8-9').diameterM);
  assert.equal(ballDiameterM('baseball', '10-12'), 0.073);
});
