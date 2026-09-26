/**
 * detector-diameter.test.ts — the ball-diameter RULER must not depend on ball speed.
 *
 * dPx is the estimator's per-frame depth ruler (tracker.ts self-scaling): a diameter
 * read x% small inflates EV by ~x%. Previous-frame differencing only sees the LEADING
 * CRESCENT of a slow ball (the overlap with its old footprint is bright in both frames,
 * so it is not "motion"), which under-reads the diameter exactly when the ball is slow:
 * the tee-ball / 8U regime. Differencing against a frame `refLag` frames back lets the
 * ball clear its old footprint first. (docs/research/12 critical #1; audit doc 34.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { BallDetector } from './detector.ts';

const W = 200;
const H = 80;
const R = 10; // rasterized disc, area ≈ 317 px → area-equivalent diameter ≈ 20.1 px

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
const TRUE_D = (() => {
  const b = blank();
  disc(b, 60, 40, R, 255);
  let area = 0;
  for (const v of b) if (v) area++;
  return 2 * Math.sqrt(area / Math.PI);
})();

function detector(refLag: number) {
  return new BallDetector({
    width: W, height: H, motionThresh: 30, brightThresh: 120,
    minArea: 4, maxArea: 5000, minCircularity: 0.2, minConfidence: 0.1,
    refLag,
  });
}

/** Run a ball moving `step` px/frame from x0 for `frames` frames; return the dPx reads. */
function run(det: BallDetector, x0: number, step: number, frames: number, staticFrames = 0): number[] {
  const out: number[] = [];
  let t = 0;
  for (let i = 0; i < staticFrames; i++) {
    const f = blank();
    disc(f, x0, 40, R, 255);
    det.detect(f, t++ / 240);
  }
  for (let i = 0; i < frames; i++) {
    const f = blank();
    disc(f, x0 + (i + 1) * step, 40, R, 255);
    const o = det.detect(f, t++ / 240);
    if (o) out.push(o.dPx);
  }
  return out;
}

test('previous-frame differencing (refLag 1) under-reads a slow ball — the crescent bias', () => {
  // 10 px/frame at a 20 px ball ≈ 20 mph at 240fps. The lens-overlap math says the leading
  // crescent has ~62% of the disc area → dPx ≈ 15.8 → EV would inflate ×1.27.
  const reads = run(detector(1), 30, 10, 8);
  assert.ok(reads.length >= 6, `expected reads, got ${reads.length}`);
  const steady = reads.slice(2);
  const med = [...steady].sort((a, b) => a - b)[steady.length >> 1];
  assert.ok(med < 0.85 * TRUE_D, `legacy dPx ${med.toFixed(1)} should be well under the true ${TRUE_D.toFixed(1)} (documents the bias)`);
});

test('a 4-frame reference lag reads the full disc at 20 mph (10 px/frame)', () => {
  const reads = run(detector(4), 30, 10, 10);
  assert.ok(reads.length >= 5, `expected reads after the 4-frame warm-up, got ${reads.length}`);
  const steady = reads.slice(2); // the ring fills from moving frames here; allow it to settle
  for (const d of steady) assert.ok(Math.abs(d - TRUE_D) < 0.06 * TRUE_D, `dPx ${d.toFixed(1)} vs true ${TRUE_D.toFixed(1)}`);
});

test('a 4-frame reference lag reads the full disc down to ~12 mph (6 px/frame)', () => {
  // 6 px/frame ≈ 12 mph — the EV gate floor. 4 frames × 6 px = 24 px > 20 px diameter.
  const reads = run(detector(4), 30, 6, 12);
  assert.ok(reads.length >= 6);
  const steady = reads.slice(4);
  for (const d of steady) assert.ok(Math.abs(d - TRUE_D) < 0.06 * TRUE_D, `dPx ${d.toFixed(1)} vs true ${TRUE_D.toFixed(1)}`);
});

test('launch off the tee: only the first frame after launch is a crescent, the rest are clean', () => {
  // The ball sits still on the tee (invisible: no motion), then leaves at 10 px/frame.
  // Frame 1 after launch still overlaps the tee footprint held in the lagged reference;
  // frame 2 (offset 20 px) has cleared it. The estimator's robust ruler fit absorbs one
  // low frame; it could not absorb every frame being low (the legacy behaviour).
  const reads = run(detector(4), 30, 10, 8, 20);
  assert.ok(reads.length >= 7, `expected a read per moving frame, got ${reads.length}`);
  assert.ok(reads[0] < 0.9 * TRUE_D, `first post-launch read is a crescent (${reads[0].toFixed(1)})`);
  for (const d of reads.slice(1)) assert.ok(Math.abs(d - TRUE_D) < 0.06 * TRUE_D, `dPx ${d.toFixed(1)} vs true ${TRUE_D.toFixed(1)}`);
});

test('refLag 1 is exactly the legacy behaviour (one reference frame, detect from frame 2)', () => {
  const det = detector(1);
  det.detect(blank(), 0);
  const f = blank();
  disc(f, 60, 40, R, 255);
  const o = det.detect(f, 1 / 240);
  assert.ok(o && Math.abs(o.cx - 60) < 1 && Math.abs(o.dPx - TRUE_D) < 0.5);
});

/* ------------------------------------------------ blur + dilation (the ruler itself) */

import { blobDiameterPx } from './detector.ts';

/** A motion-blurred disc: the union of discs swept `blurPx` along (ux, uy). */
function capsule(buf: Uint8Array, cx: number, cy: number, r: number, blurPx: number, ux = 1, uy = 0) {
  const steps = Math.max(1, Math.ceil(blurPx * 2));
  for (let i = 0; i <= steps; i++) {
    const f = blurPx * (i / steps);
    disc(buf, Math.round(cx + f * ux), Math.round(cy + f * uy), r, 255);
  }
}
function areaOf(buf: Uint8Array): number { let a = 0; for (const v of buf) if (v) a++; return a; }

test('blobDiameterPx: no-op on a clean undilated disc (reproduces the legacy area-equivalent value)', () => {
  const b = blank();
  disc(b, 60, 40, R, 255);
  const A = areaOf(b);
  assert.equal(blobDiameterPx(A, 2 * R + 1, 2 * R + 1, false), 2 * Math.sqrt(A / Math.PI));
});

test('blobDiameterPx: removes the blur term — a 10 px smear no longer inflates the ruler', () => {
  const b = blank();
  capsule(b, 60, 40, R, 10);
  const A = areaOf(b);
  const legacy = 2 * Math.sqrt(A / Math.PI);
  const fixed = blobDiameterPx(A, 2 * R + 1 + 10, 2 * R + 1, false);
  assert.ok(legacy > 1.2 * TRUE_D, `legacy area ruler over-reads a blurred ball (${legacy.toFixed(1)} vs ${TRUE_D.toFixed(1)})`);
  assert.ok(Math.abs(fixed - TRUE_D) < 0.05 * TRUE_D, `blur-corrected ${fixed.toFixed(1)} vs true ${TRUE_D.toFixed(1)}`);
});

test('blobDiameterPx: removes the dilation ring (+1 px radius = ~10% EV under-read on a 20 px ball)', () => {
  const b = blank();
  disc(b, 60, 40, R + 1, 255); // what a 1 px dilation makes of the disc
  const A = areaOf(b);
  const legacy = 2 * Math.sqrt(A / Math.PI);
  assert.ok(legacy > TRUE_D + 1.5, `dilated ruler reads ${legacy.toFixed(1)}`);
  const fixed = blobDiameterPx(A, 2 * R + 3, 2 * R + 3, true);
  assert.ok(Math.abs(fixed - TRUE_D) < 0.05 * TRUE_D, `dilation-corrected ${fixed.toFixed(1)} vs true ${TRUE_D.toFixed(1)}`);
});

function detectorOpts(refLag: number, dilate: boolean, track = false) {
  return new BallDetector({
    width: W, height: H, motionThresh: 30, brightThresh: 120,
    minArea: 4, maxArea: 5000, minCircularity: 0.2, minConfidence: 0.1,
    refLag, dilate, track, dirX: 1, expectDiamPx: 20, acquireZone: { x0: 0, y0: 0, x1: W, y1: H },
  });
}

test('detector: a horizontally blurred ball reads its true diameter (legacy mode, dilate on and off)', () => {
  for (const dilate of [false, true]) {
    const det = detectorOpts(4, dilate);
    const reads: number[] = [];
    for (let i = 0; i < 12; i++) {
      const f = blank();
      capsule(f, 30 + i * 12, 40, R, 8); // 12 px/frame, 8 px of smear (dim-light exposure)
      const o = det.detect(f, i / 240);
      if (o) reads.push(o.dPx);
    }
    assert.ok(reads.length >= 5, `dilate=${dilate}: reads ${reads.length}`);
    for (const d of reads.slice(2)) assert.ok(Math.abs(d - TRUE_D) < 0.07 * TRUE_D, `dilate=${dilate}: dPx ${d.toFixed(1)} vs ${TRUE_D.toFixed(1)}`);
  }
});

test('detector: a ball blurred along a 20° flight reads its true diameter once locked (track mode)', () => {
  const det = detectorOpts(4, false, true);
  const th = (20 * Math.PI) / 180;
  const ux = Math.cos(th), uy = -Math.sin(th); // up-and-right in image coords (y down)
  const reads: number[] = [];
  for (let i = 0; i < 12; i++) {
    const f = blank();
    const s = i * 11;
    capsule(f, 30 + s * ux, 60 + s * uy, R, 9, ux, uy);
    const o = det.detect(f, i / 240);
    if (o) reads.push(o.dPx);
  }
  assert.ok(reads.length >= 5, `reads ${reads.length}`);
  // first locked frame has no velocity yet (horizontal axis assumed) — judge from the second
  for (const d of reads.slice(2)) assert.ok(Math.abs(d - TRUE_D) < 0.08 * TRUE_D, `dPx ${d.toFixed(1)} vs ${TRUE_D.toFixed(1)}`);
});
