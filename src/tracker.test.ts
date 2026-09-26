import test from 'node:test';
import assert from 'node:assert/strict';

import { estimateSwing, synthSwing } from './tracker.ts';

// Deterministic, noise-free synthetic camera so the only thing under test is the
// flight-frame gate (no centroid noise, perpendicular camera, on-plane flight).
function track(nFrames: number) {
  return synthSwing(40, 18, { nFrames, centroidNoisePx: 0, yawDeg: 0, azimuthDeg: 0, rand: () => 0.5 });
}

test('flight-frame gate: a too-short track does not report a number', () => {
  const { obs, cal } = track(4); // below MIN_FLIGHT_FRAMES (5)
  const r = estimateSwing(obs, cal);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /flight frames/i);
});

test('flight-frame gate: a borderline track reports, but never above medium', () => {
  const { obs, cal } = track(6); // 5..7 → trusted-but-short
  const r = estimateSwing(obs, cal);
  assert.equal(r.ok, true);
  assert.notEqual(r.confidence, 'high'); // capped at medium by frame count
});

test('flight-frame gate: a full track is eligible for high confidence', () => {
  const { obs, cal } = track(12); // capped to maxFrames (8) → >= TRUSTED
  const r = estimateSwing(obs, cal);
  assert.equal(r.ok, true);
  assert.equal(r.nFrames, 8);
  assert.equal(r.confidence, 'high');
  // and the clean synthetic track recovers ~the true EV
  assert.ok(Math.abs(r.evMph - 40) < 5, `evMph ${r.evMph} should be ~40`);
});

test('camera yaw is modeled geometrically and the yaw correction recovers EV + LA', () => {
  // synthSwing used to only STAMP yawDeg into the calibration without yawing the
  // projection — so the estimator's ÷cos(yaw) "correction" was validated against
  // nothing and injected error on clean data. With real yawed geometry the
  // corrected estimate must land near truth.
  const { obs, cal } = synthSwing(60, 25, { yawDeg: 12, nFrames: 8, centroidNoisePx: 0, rand: () => 0.5 });
  const r = estimateSwing(obs, cal);
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.evMph - 60) < 0.5, `EV ${r.evMph} should be ~60`);
  assert.ok(Math.abs(r.laDeg - 25) < 0.7, `LA ${r.laDeg} should be ~25`);
});
