import test from 'node:test';
import assert from 'node:assert/strict';

import { estimateBatSwing, synthBatSwing } from './bat-tracker.ts';

/* The synth is a faithful forward pinhole projector (geometry only); the estimator
 * inverts a projection it did not author, so recovery is a real test. */

test('recovers a clean swing: bat speed, attack angle, and bat angle', () => {
  const { obs, cal, contactIdx } = synthBatSwing(68, 10, 35);
  const r = estimateBatSwing(obs, cal, contactIdx);
  assert.ok(r.ok, r.reason);
  assert.ok(Math.abs(r.batSpeedMph - 68) < 2.5, `bat speed ${r.batSpeedMph}`);
  assert.ok(Math.abs(r.attackAngleDeg - 10) < 2.5, `attack ${r.attackAngleDeg}`);
  assert.ok(Math.abs(r.batAngleDeg - 35) < 3, `bat angle ${r.batAngleDeg}`);
  assert.equal(r.confidence, 'high');
});

test('a curved (accelerating) swing path still recovers the contact velocity', () => {
  // The local fit must read the velocity AT contact, not an average over the arc.
  const curved = synthBatSwing(55, 5, 40, { curveAccelMs2: 800 });
  const r = estimateBatSwing(curved.obs, curved.cal, curved.contactIdx);
  assert.ok(r.ok, r.reason);
  assert.ok(Math.abs(r.batSpeedMph - 55) < 3, `curved speed ${r.batSpeedMph}`);
  assert.ok(Math.abs(r.attackAngleDeg - 5) < 3, `curved attack ${r.attackAngleDeg}`);
});

test('a downward attack (chopping) reads as a negative attack angle', () => {
  const { obs, cal, contactIdx } = synthBatSwing(60, -8, 30);
  const r = estimateBatSwing(obs, cal, contactIdx);
  assert.ok(r.ok, r.reason);
  assert.ok(r.attackAngleDeg < 0, `attack should be negative, got ${r.attackAngleDeg}`);
  assert.ok(Math.abs(r.attackAngleDeg + 8) < 3, `attack ${r.attackAngleDeg}`);
});

test('a foreshortened (yawed) swing plane is cosine-corrected toward truth', () => {
  const tilted = synthBatSwing(70, 10, 35, { azimuthDeg: 20 }); // cal.yawDeg = 20
  const r = estimateBatSwing(tilted.obs, tilted.cal, tilted.contactIdx);
  assert.ok(r.ok, r.reason);
  assert.ok(Math.abs(r.batSpeedMph - 70) < 5, `corrected speed ${r.batSpeedMph}`);
});

test('a heavily foreshortened swing is flagged low confidence', () => {
  // bat pointing toward the camera collapses its apparent length → in-plane assumption breaks
  const { obs, cal, contactIdx } = synthBatSwing(65, 8, 35, { batForeshortenAtContact: 0.4 });
  const r = estimateBatSwing(obs, cal, contactIdx);
  assert.equal(r.confidence, 'low');
});

test('too few frames near contact → not ok', () => {
  const { obs, cal } = synthBatSwing(60, 8, 35);
  const r = estimateBatSwing(obs.slice(0, 2), cal, 1);
  assert.equal(r.ok, false);
});

test('an implausible bat speed is gated out', () => {
  const { obs, cal, contactIdx } = synthBatSwing(300, 10, 35); // physically impossible
  const r = estimateBatSwing(obs, cal, contactIdx);
  assert.equal(r.ok, false);
});

test('contactIdx = -1 falls back to the middle frame and still measures', () => {
  const { obs, cal } = synthBatSwing(64, 9, 35);
  const r = estimateBatSwing(obs, cal, -1);
  assert.ok(r.ok, r.reason);
  assert.ok(Math.abs(r.batSpeedMph - 64) < 4, `speed ${r.batSpeedMph}`);
});
