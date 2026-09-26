import test from 'node:test';
import assert from 'node:assert/strict';

import { detectBat, type BatDetectorConfig } from './bat-detector.ts';

const W = 200, H = 200;
const cfg: BatDetectorConfig = { width: W, height: H, brightThresh: 150, minLenPx: 20 };

/** Rasterize a bright segment (thickness ~3px) into a luma grid. */
function frameWith(segments: [number, number, number, number][]): Uint8Array {
  const luma = new Uint8Array(W * H);
  for (const [x0, y0, x1, y1] of segments) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(x0 + ((x1 - x0) * s) / steps), y = Math.round(y0 + ((y1 - y0) * s) / steps);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < W && yy >= 0 && yy < H) luma[yy * W + xx] = 255;
      }
    }
  }
  return luma;
}

test('finds the bat extending OUTWARD from the hands — ignores the bright forearm', () => {
  // hands at (100,120); body BELOW (larger y). Bat goes up-right; forearm goes down (toward body).
  const luma = frameWith([
    [100, 120, 150, 60], // the bat (outward / up-right)
    [100, 120, 100, 165], // a bright forearm toward the body (down)
  ]);
  const d = detectBat(luma, { x: 100, y: 120 }, { x: 100, y: 180 }, cfg);
  assert.ok(d, 'a bat is detected');
  assert.ok(Math.hypot(d!.knobX - 100, d!.knobY - 120) < 6, 'knob at the hands');
  assert.ok(Math.hypot(d!.tipX - 150, d!.tipY - 60) < 12, `tip at the barrel end, got ${d!.tipX},${d!.tipY}`);
  assert.ok(d!.lenPx > 60, `bat length recovered (~78px), got ${d!.lenPx}`);
});

test('returns null on a blank frame', () => {
  assert.equal(detectBat(new Uint8Array(W * H), { x: 100, y: 120 }, { x: 100, y: 180 }, cfg), null);
});

test('returns null when the only bright structure points back at the body (forearm, no bat)', () => {
  const luma = frameWith([[100, 120, 100, 170]]); // only a forearm toward the body
  assert.equal(detectBat(luma, { x: 100, y: 120 }, { x: 100, y: 180 }, cfg), null);
});

test('picks the LONGER outward bright run when several exist', () => {
  const luma = frameWith([
    [100, 120, 120, 100], // a short bright stub (~28px)
    [100, 120, 40, 40], // the real bat, longer (~100px), up-left
  ]);
  const d = detectBat(luma, { x: 100, y: 120 }, { x: 100, y: 185 }, cfg);
  assert.ok(d, 'detected');
  assert.ok(Math.hypot(d!.tipX - 40, d!.tipY - 40) < 14, `tip at the long bat end, got ${d!.tipX},${d!.tipY}`);
});

test('stops at the bat tip — does not run into a wide bright wall beyond it', () => {
  // a thin bat (hands→up), then a WIDE bright wall above its tip (the backyard window/wall)
  const luma = new Uint8Array(W * H);
  for (let y = 60; y <= 120; y++) for (let dx = -1; dx <= 1; dx++) luma[y * W + (100 + dx)] = 255; // thin bat, tip at y≈60
  for (let y = 0; y <= 58; y++) for (let x = 60; x <= 140; x++) luma[y * W + x] = 255; // wide wall above
  const d = detectBat(luma, { x: 100, y: 120 }, { x: 100, y: 185 }, { ...cfg, maxWidthPx: 12 });
  assert.ok(d, 'detected');
  assert.ok(d!.tipY > 50 && d!.tipY < 72, `tip stops at the bat end (~60), not the wall edge; got y=${d!.tipY}`);
  assert.ok(d!.lenPx < 80, `length not inflated by the wall (~60), got ${d!.lenPx}`);
});

test('confidence rises with a longer, cleaner bat', () => {
  const longClean = detectBat(frameWith([[100, 120, 40, 40]]), { x: 100, y: 120 }, { x: 100, y: 185 }, cfg);
  const shortBat = detectBat(frameWith([[100, 120, 118, 98]]), { x: 100, y: 120 }, { x: 100, y: 185 }, cfg);
  assert.ok(longClean && shortBat, 'both detected');
  assert.ok(longClean!.conf > shortBat!.conf, 'longer bat → higher confidence');
});
