/**
 * detector-track.test.ts — the v2 acquire + forward-lock selection.
 *
 * Validates the disambiguation behaviour proven offline on a real 240fps
 * swing (docs/research/13): the detector must follow the round ball moving in
 * the flight direction, and must NOT lock onto an elongated decoy (the bat) even
 * when it is brighter/bigger. Synthetic frames so the assertions are exact.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { BallDetector } from './detector.ts';

const W = 120;
const H = 60;

function blank(): Uint8Array {
  return new Uint8Array(W * H);
}
function disc(buf: Uint8Array, cx: number, cy: number, r: number, val: number) {
  for (let y = -r; y <= r; y++)
    for (let x = -r; x <= r; x++)
      if (x * x + y * y <= r * r) {
        const px = cx + x, py = cy + y;
        if (px >= 0 && px < W && py >= 0 && py < H) buf[py * W + px] = val;
      }
}
function rect(buf: Uint8Array, x0: number, y0: number, x1: number, y1: number, val: number) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (y >= 0 && y < H && x >= 0 && x < W) buf[y * W + x] = val;
}

test('track mode follows a round ball moving in the flight direction', () => {
  const det = new BallDetector({
    width: W, height: H, motionThresh: 30, brightThresh: 120,
    minArea: 4, maxArea: 2000, minCircularity: 0.3, minConfidence: 0.2,
    track: true, dirX: 1, expectDiamPx: 12, acquireZone: { x0: 10, y0: 20, x1: 50, y1: 40 },
    refLag: 1, // legacy previous-frame differencing: these tests pin the SELECTION logic, not the ruler
  });
  det.reset();

  const xs = [20, 30, 40, 50, 60, 70, 80]; // ball moves right +10/frame at y=30
  const got: { ballX: number; cx: number }[] = [];
  xs.forEach((bx, i) => {
    const f = blank();
    disc(f, bx, 30, 6, 255);
    const o = det.detect(f, i / 240);
    if (o) got.push({ ballX: bx, cx: o.cx });
  });

  // frame 0 seeds the reference (no detection); the rest should track the ball
  assert.ok(got.length >= 5, `expected to track most frames, got ${got.length}`);
  for (const g of got) {
    assert.ok(Math.abs(g.cx - g.ballX) < 3, `locked cx ${g.cx.toFixed(1)} should sit on the ball at ${g.ballX}`);
  }
});

test('acquisition prefers the round ball over an elongated (bat-like) decoy', () => {
  const det = new BallDetector({
    width: W, height: H, motionThresh: 30, brightThresh: 120,
    minArea: 4, maxArea: 2000, minCircularity: 0.3, minConfidence: 0.2,
    track: true, dirX: 1, expectDiamPx: 12, acquireZone: { x0: 10, y0: 20, x1: 100, y1: 40 },
    refLag: 1,
  });
  det.reset();

  // frame 0 (reference): ball + an elongated bright bar
  const f0 = blank();
  disc(f0, 28, 30, 6, 255);
  rect(f0, 60, 28, 84, 32, 255);
  det.detect(f0, 0);

  // frame 1: both move (so both are motion candidates); the bar is brighter-area
  const f1 = blank();
  disc(f1, 36, 30, 6, 255); // round ball
  rect(f1, 64, 28, 88, 32, 255); // elongated decoy (aspect ~0.2)
  const o = det.detect(f1, 1 / 240);

  assert.ok(o, 'should acquire something');
  assert.ok(Math.abs(o!.cx - 36) < 4, `should acquire the ROUND ball at ~36, not the bar at ~76 (got ${o!.cx.toFixed(1)})`);
});

test('legacy mode (track off) is unchanged — best round blob, no lock state', () => {
  const det = new BallDetector({
    width: W, height: H, motionThresh: 30, brightThresh: 120,
    minArea: 4, maxArea: 2000, minCircularity: 0.3, minConfidence: 0.2,
    refLag: 1,
  });
  det.reset();
  det.detect(blank(), 0); // reference
  const f = blank();
  disc(f, 50, 30, 6, 255);
  const o = det.detect(f, 1 / 240);
  assert.ok(o && Math.abs(o.cx - 50) < 3, 'legacy still finds the single round blob');
});
