/**
 * detector-bench.ts — per-frame cost of the ball detector vs the 240fps budget.
 *
 * The ONLY hard real-time constraint in the capture path is the detector holding
 * its frame budget: at 240fps that's 1000/240 ≈ 4.17 ms/frame. Miss it and you
 * drop frames (fewer obs per swing → lower confidence), you never freeze the UI.
 *
 * This times the REAL TS detector (src/detector.ts — the same algorithm the
 * Swift BallDetector mirrors) over a pool of realistic synthetic frames (noisy
 * background + a bright moving ball + a couple of decoy blobs), with frame
 * generation EXCLUDED from the timing.
 *
 * HONEST SCOPE: this is JS on a dev machine — an ALGORITHMIC reference, not the
 * on-device number. Native Swift is faster per op, but a low-end phone CPU is
 * slower than a laptop, so the two roughly bracket reality. The real low-end-device
 * figure comes from an on-device XCTest harness (not part of this repo).
 *
 * Usage:  npm run bench
 */
import { BallDetector, type DetectorConfig } from '../src/detector.ts';

const W = 480, H = 270, N = W * H;
const BUDGET_MS = 1000 / 240; // 4.17 ms/frame at 240fps
const POOL = 240;             // distinct pre-generated frames (cycled)
const ITER = 4000;            // timed detect() calls

function disc(buf: Uint8Array, cx: number, cy: number, r: number, val: number) {
  for (let y = -r; y <= r; y++)
    for (let x = -r; x <= r; x++)
      if (x * x + y * y <= r * r) {
        const px = (cx + x) | 0, py = (cy + y) | 0;
        if (px >= 0 && px < W && py >= 0 && py < H) buf[py * W + px] = val;
      }
}

/** A realistic frame: dim noisy field (below brightThresh, so not candidates) + a
 *  bright moving ball + two decoy bright blobs (bat tip / net glint) also moving. */
function makeFrame(into: Uint8Array, f: number) {
  for (let i = 0; i < N; i++) into[i] = 70 + ((Math.random() * 30) | 0);
  disc(into, 40 + ((f * 4) % (W - 80)), H / 2, 9, 235);        // the ball
  disc(into, 60 + ((f * 3) % (W - 120)), H * 0.4, 6, 200);     // decoy
  disc(into, 120 + ((f * 2) % (W - 160)), H * 0.6, 7, 190);    // decoy
}

const frames: Uint8Array[] = [];
for (let f = 0; f < POOL; f++) { const u = new Uint8Array(N); makeFrame(u, f); frames.push(u); }

function bench(cfg: Partial<DetectorConfig>, label: string) {
  const det = new BallDetector({ width: W, height: H, ...cfg });
  det.reset();
  for (let f = 0; f < 120; f++) det.detect(frames[f % POOL], f / 240); // warm up JIT + ref frame
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < ITER; i++) det.detect(frames[i % POOL], i / 240);
  const t1 = process.hrtime.bigint();
  const msPer = Number(t1 - t0) / 1e6 / ITER;
  const fps = Math.round(1000 / msPer);
  const headroom = BUDGET_MS / msPer;
  console.log(
    `  ${label.padEnd(22)} ${msPer.toFixed(3)} ms/frame   ~${String(fps).padStart(6)} fps cap   ${headroom.toFixed(1)}× under 240fps budget`,
  );
}

console.log(`\nDetector per-frame cost @ ${W}×${H}  (budget ${BUDGET_MS.toFixed(2)} ms/frame for 240fps)\n`);
bench({}, 'default (legacy)');
bench({ dilate: true }, 'default + dilate');
bench({ track: true, dilate: true, expectDiamPx: 18, dirX: 1 }, 'track + dilate');
console.log(`\n  Note: JS on this machine — an algorithmic reference, not the on-device number.`);
console.log(`  Benchmark natively on your oldest target device for the real figure.\n`);
