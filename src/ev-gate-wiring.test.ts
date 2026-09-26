import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flightStats, gateResult, type FlightStats } from './tracker.ts';
import type { BallObs } from './tracker.ts';
import type { TrackResult } from './tracker.ts';

function obs(pts: [number, number][], dPx = 12, conf = 0.9): BallObs[] {
  return pts.map(([cx, cy], i) => ({ t: i / 240, cx, cy, dPx, conf }));
}
const okResult: TrackResult = { ok: true, evMph: 45, laDeg: 18, nFrames: 6, offPlane: false, confidence: 'high', semMph: 2 };

test('flightStats: a straight, evenly spaced flight reads ~0 straightness and low jitter', () => {
  const fs = flightStats(obs([[10, 250], [20, 230], [30, 210], [40, 190], [50, 170], [60, 150]]));
  assert.equal(fs.n, 6);
  assert.ok(fs.straightnessPx < 0.5, `straightnessPx ${fs.straightnessPx}`);
  assert.ok(fs.dPxStd / fs.dPxMean < 0.1, `cv ${fs.dPxStd / fs.dPxMean}`);
});

test('flightStats: a wandering flight reads high straightness', () => {
  const fs = flightStats(obs([[10, 250], [30, 232], [22, 210], [44, 188], [33, 168], [60, 150]]));
  assert.ok(fs.straightnessPx > 3.5, `straightnessPx ${fs.straightnessPx}`);
});

test('gateResult: passes a clean read through unchanged', () => {
  // 8+ frames, steady step, straight: the gate grades this 'high' too, so nothing moves
  const fs: FlightStats = { n: 8, straightnessPx: 1.0, dPxMean: 22, dPxStd: 4, evMph: 45 } as FlightStats;
  const out = gateResult({ ...okResult, nFrames: 8 }, fs);
  assert.equal(out.ok, true);
  assert.equal(out.evMph, 45);
  assert.equal(out.confidence, 'high');
});

test('gateResult: a trusted-but-marginal flight carries the gate\'s medium confidence', () => {
  // short track (6 < GOOD_FRAMES) — trusted, but the swing must not read as a solid 'high'
  const fs: FlightStats = { n: 6, straightnessPx: 1.0, dPxMean: 22, dPxStd: 4, evMph: 45 } as FlightStats;
  const out = gateResult(okResult, fs);
  assert.equal(out.ok, true);
  assert.equal(out.evMph, 45, 'never alters the number');
  assert.equal(out.confidence, 'medium');
  // and a read the estimator already rated 'low' is never promoted
  const low = gateResult({ ...okResult, confidence: 'low' }, fs);
  assert.equal(low.confidence, 'low');
});

test('gateResult: distrusted flight becomes an honest no-read with a reason', () => {
  const wander: FlightStats = { n: 6, straightnessPx: 9, dPxMean: 22, dPxStd: 4 } as FlightStats;
  const out = gateResult(okResult, wander);
  assert.equal(out.ok, false);
  assert.match(out.reason ?? '', /straight/);
  const decoy = gateResult({ ...okResult, evMph: 95 }, { n: 6, straightnessPx: 1, dPxMean: 22, dPxStd: 4 } as FlightStats);
  assert.equal(decoy.ok, false);
});

test('gateResult: never resurrects an already-failed read', () => {
  const failed: TrackResult = { ok: false, evMph: 0, laDeg: 0, nFrames: 2, offPlane: false, confidence: 'low', semMph: 0, reason: 'too few' };
  const out = gateResult(failed, { n: 2, straightnessPx: 0, dPxMean: 0, dPxStd: 0 } as FlightStats);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'too few');
});
