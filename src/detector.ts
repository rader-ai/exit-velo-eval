/**
 * detector.ts — per-frame ball detection (the camera front-end's inner loop).
 *
 * Turns one downscaled luma frame into at most ONE ball observation
 * `{cx, cy, dPx, conf}` for the estimator (tracker.ts). Classical CV
 * (motion + brightness + circular-blob), no ML — it must run inside a 240fps
 * frame processor (~4 ms/frame budget).
 *
 * MEMORY DISCIPLINE (the whole point):
 *  - ALL scratch buffers are pre-allocated ONCE in the constructor and reused
 *    in place. There is ZERO per-frame allocation, so no GC churn and no leak
 *    vector from this module.
 *  - It holds a SHORT RING of reference frames (`refLag` downscaled luma planes,
 *    default 4 ≈ 0.5 MB at 480x270) for motion differencing — never the stream.
 *    Why not just the previous frame: differencing against the frame 1/240 s ago
 *    only sees the LEADING CRESCENT of a slow ball (the region it still overlaps
 *    with its previous position is bright in both frames, so it isn't "motion").
 *    The crescent's area under-measures the diameter — the self-scale ruler — so
 *    EV inflates: x1.07 at 30 mph, x1.15 at 25, x1.27 at 20, x1.45 at 15 (a 20 px
 *    ball; audit 2026-09-05, docs/research/34). Differencing against the frame
 *    `refLag` frames back means the ball has cleared its old footprint at any
 *    speed ≥ ~12 mph, so the whole disc is seen. (docs/research/12 critical #1.)
 *  - It never stores, copies, or returns the frame itself. A frame is read,
 *    reduced to a ~40-byte observation, and dropped. (Privacy + memory.)
 *
 * The full-resolution camera frame is NEVER held here; the native frame
 * processor hands us a small downscaled luma plane and recycles the original.
 */

import type { BallObs } from './tracker.ts';

export type ROI = { x0: number; y0: number; x1: number; y1: number };

export type DetectorConfig = {
  width: number; // downscaled luma width (e.g. 240)
  height: number; // downscaled luma height (e.g. 135)
  motionThresh: number; // min |cur-ref| to count as moving (0-255)
  brightThresh: number; // min luma to count as ball-bright (0-255)
  minArea: number; // min blob area (px) at this scale
  maxArea: number; // max blob area (px)
  minCircularity: number; // 0-1; a disc fills ~0.785 of its bbox
  minConfidence: number; // reject below this
  // launch-corridor ROI (grid coords). When set, only pixels inside it can be
  // ball candidates — the reticle aims this at the clean lane so the net/batter
  // outside it stop generating false detections. Undefined = whole frame.
  roi?: ROI;
  // grow the candidate mask 1px so the ball's fragmented motion edges merge into
  // one blob (a real session caught the ball as ~3px specks). Default off.
  dilate?: boolean;
  // frames between the motion-reference frame and the current one. 1 = legacy
  // previous-frame differencing (crescent bias on slow balls, see header). Default 4:
  // a 20 px ball at 12 mph steps ~6 px/frame, so 4 frames clears its old footprint.
  refLag?: number;
  // --- v2 single-object ACQUIRE + FORWARD-LOCK tracking (opt-in) -------------
  // The investigation (docs/research/13) showed detection here is a DISAMBIGUATION
  // problem: many bright/round/white decoys per frame (bat, wall, net). The ball
  // wins not by appearance alone but because it's the round thing that launches
  // and flies toward the net. When `track` is on, the detector acquires the
  // ball-like blob in `acquireZone`, then follows it frame-to-frame, preferring
  // the candidate near the predicted position and moving in `dirX` (the flight
  // direction). Off (default) = legacy single-best-by-circularity behaviour.
  track?: boolean;
  dirX?: number; // expected flight direction along x: +1 righty (flies right), -1 lefty. default +1
  expectDiamPx?: number; // expected ball diameter on this grid (size prior). default 20 (≈ ball at the 480x270 scale)
  acquireZone?: ROI; // where the ball launches (≈ the reticle/tee). default = roi (or whole frame)
  maxMisses?: number; // drop the lock after this many consecutive frames with no gated candidate. default 4
  // HARD ball-size band as [lo, hi] fractions of expectDiamPx. A candidate is only
  // ball-eligible when lo*exp <= dPx <= hi*exp. This kills the tiny body/tee specks
  // (the offline sweep showed the default ROI false-locking ~4px sub-blobs) and the
  // oversized net blobs (~28px, conf ~0.1), so acquisition lands on the real ball
  // even from the wide default ROI. Per-frame + relative to exp → still self-scales
  // with zoom. default [0.55, 1.6].
  diamBand?: [number, number];
  // When tracking with a color gate, drop the color requirement once LOCKED and
  // gate on luma-brightness instead — the motion-blurred ball desaturates in flight
  // and the predicted-position/velocity/size gates do the disambiguation while
  // locked. Acquire on color, follow on luma. No effect without a colorMask. Off = legacy.
  followLuma?: boolean;
};

/**
 * The ball-diameter RULER from one blob's pixel statistics — the estimator's per-frame
 * depth scale (tracker.ts self-scaling), so any bias here is a bias in EV.
 *
 * Two things elongate or inflate the thresholded blob without changing the ball:
 *  - MOTION BLUR smears the disc along its motion by b px (exposure × speed). A blurred
 *    disc is a capsule: area = π·r² + 2·r·b, so the area-equivalent diameter over-reads
 *    (EV under-reads) and does so MORE in dim light (longer exposure) and on harder hits.
 *    b is measured directly: the blob's extent along the motion axis minus its extent
 *    across it (a disc has none). Solve the capsule for r.
 *  - DILATION (cfg.dilate) grows the mask by a 1 px ring on every side: +1 px radius.
 *    A 20 px ball read as 22 → EV 10% low. Subtract the ring.
 * Both corrections are no-ops on a clean undilated disc (along == across → b = 0), so
 * the legacy value is reproduced exactly there. (audit 2026-09-05, docs/research/34 §4.)
 *
 * The remaining known bias is the threshold's partial-coverage edge (a fraction of a
 * pixel, contrast-dependent) — sub-pixel refinement territory, not fixed here.
 */
export function blobDiameterPx(area: number, alongPx: number, acrossPx: number, dilated: boolean): number {
  const b = Math.max(0, alongPx - acrossPx); // blur length along the motion axis
  const r = (-b + Math.sqrt(b * b + Math.PI * area)) / Math.PI; // π r² + 2 r b = area
  const d = 2 * (r - (dilated ? 1 : 0));
  return Math.max(1, d);
}

/** One candidate blob's appearance features (reused selection scratch). */
type Cand = { cx: number; cy: number; dPx: number; area: number; fill: number; aspect: number };

export const DEFAULT_DETECTOR: Omit<DetectorConfig, 'width' | 'height'> = {
  motionThresh: 28,
  brightThresh: 150,
  minArea: 6,
  maxArea: 1200,
  minCircularity: 0.55,
  minConfidence: 0.4,
};

export class BallDetector {
  readonly cfg: DetectorConfig;
  private readonly n: number;
  // pre-allocated scratch — reused every frame, never reallocated
  private readonly lag: number; // reference lag in frames (>= 1)
  private readonly ring: Uint8Array[]; // the last `lag` luma frames; ring[ringIdx] is the oldest
  private ringIdx = 0;
  private filled = 0; // frames stored so far (detection starts once the ring is full)
  private readonly label: Int32Array; // connected-component labels
  private readonly stack: Int32Array; // flood-fill stack
  // v2 forward-lock state: the currently tracked ball, or null when unacquired.
  private trk: { cx: number; cy: number; vx: number; vy: number; misses: number } | null = null;
  // reused candidate scratch (no per-frame growth once it reaches steady size)
  private readonly cands: Cand[] = [];

  constructor(opts: Partial<DetectorConfig> & { width: number; height: number }) {
    this.cfg = { ...DEFAULT_DETECTOR, ...opts };
    this.n = this.cfg.width * this.cfg.height;
    this.lag = Math.max(1, Math.floor(this.cfg.refLag ?? 4));
    this.ring = Array.from({ length: this.lag }, () => new Uint8Array(this.n));
    this.label = new Int32Array(this.n);
    this.stack = new Int32Array(this.n);
  }

  /** Reset between sessions (drop the reference frames + any track lock). */
  reset() {
    this.filled = 0;
    this.ringIdx = 0;
    this.trk = null;
  }

  /**
   * Detect the ball in one luma frame. `t` is the frame's presentation time (s).
   * Returns an observation or null. The `luma` array is read-only here and is
   * NOT retained after this call.
   *
   * `colorMask` (optional, 1 byte/px, 1 = passes the ball's COLOR gate) is the
   * per-ball-type appearance prior: for an optic-yellow softball the native side
   * computes it from the chroma plane and a candidate pixel must be moving AND
   * color-on (replaces the brightness test — color is the softball discriminator,
   * docs/research/22). Omitted ⇒ luma-only (the white-baseball path; white isn't
   * color-separable, docs/research/13).
   */
  detect(luma: Uint8Array, t: number, colorMask?: Uint8Array): BallObs | null {
    const { width: w, height: h, motionThresh, brightThresh } = this.cfg;
    const n = this.n;
    const label = this.label;

    if (this.filled < this.lag) {
      // warm-up: fill the ring (lag frames ≈ 17 ms at 240fps); no detection yet
      this.ring[this.ringIdx].set(luma);
      this.ringIdx = (this.ringIdx + 1) % this.lag;
      this.filled++;
      return null;
    }
    const ref = this.ring[this.ringIdx]; // the frame `lag` frames ago

    // foreground mask: label[i] = -1 candidate, 0 background. Restricted to the
    // launch-corridor ROI (kills net/body noise outside the lane); whole frame
    // when no ROI is set. Mirrors BallDetector.swift.
    label.fill(0);
    const roi = this.cfg.roi;
    const rx0 = Math.max(0, roi?.x0 ?? 0);
    const ry0 = Math.max(0, roi?.y0 ?? 0);
    const rx1 = Math.min(w, roi?.x1 ?? w);
    const ry1 = Math.min(h, roi?.y1 ?? h);
    // PHASE-AWARE appearance gate (offline finding, IMG_2185-2201): the optic-yellow
    // ball is cleanly saturated while it sits on the tee (great for ACQUIRE, kills the
    // body/dirt decoys), but motion-blur DESATURATES it in flight — only a tiny core
    // survives sat>=0.4 and it falls below the ball-size band, so the color gate drops
    // the ball mid-flight on hard hits. While LOCKED, the predicted-position + velocity
    // + size gates already disambiguate, so we can relax appearance to luma-brightness
    // and keep the ball through the blur. Acquire on color, follow on luma.
    const following = !!this.cfg.track && this.trk != null;
    const useColor = !!colorMask && !(following && this.cfg.followLuma);
    for (let ry = ry0; ry < ry1; ry++) {
      const rowBase = ry * w;
      for (let rx = rx0; rx < rx1; rx++) {
        const i = rowBase + rx;
        const cur = luma[i];
        // appearance gate: color (softball) when a mask is supplied, else brightness (baseball).
        // Once locked with followLuma, ignore the color mask and use brightness (blur path).
        const appearanceOk = useColor ? colorMask![i] === 1 : cur >= brightThresh;
        if (Math.abs(cur - ref[i]) >= motionThresh && appearanceOk) label[i] = -1;
      }
    }

    // dilate 1px so the ball's fragmented motion edges merge into one blob. Mark
    // neighbours -2 then promote, so growth doesn't cascade within one pass.
    if (this.cfg.dilate) {
      for (let ry = ry0; ry < ry1; ry++) {
        const rowBase = ry * w;
        for (let rx = rx0; rx < rx1; rx++) {
          if (label[rowBase + rx] === -1) {
            if (rx > rx0 && label[rowBase + rx - 1] === 0) label[rowBase + rx - 1] = -2;
            if (rx < rx1 - 1 && label[rowBase + rx + 1] === 0) label[rowBase + rx + 1] = -2;
            if (ry > ry0 && label[rowBase + rx - w] === 0) label[rowBase + rx - w] = -2;
            if (ry < ry1 - 1 && label[rowBase + rx + w] === 0) label[rowBase + rx + w] = -2;
          }
        }
      }
      for (let i = 0; i < n; i++) if (label[i] === -2) label[i] = -1;
    }

    // Motion axis for the ruler's blur measurement: the lock's velocity when we have one
    // (a ball in flight), else horizontal — the side-on flight direction. Extents are
    // projected onto (ux, uy) [along] and its perpendicular [across].
    let ux = 1, uy = 0;
    if (this.trk && Math.hypot(this.trk.vx, this.trk.vy) > 2) {
      const vlen = Math.hypot(this.trk.vx, this.trk.vy);
      ux = this.trk.vx / vlen;
      uy = this.trk.vy / vlen;
    }
    const dil = !!this.cfg.dilate;

    // connected components (4-conn) over candidate pixels.
    const stack = this.stack;
    let best: { cx: number; cy: number; area: number; conf: number; dPx: number } | null = null;
    const cands = this.cands;
    if (this.cfg.track) cands.length = 0;
    let comp = 0;
    for (let p = 0; p < n; p++) {
      if (label[p] !== -1) continue;
      comp++;
      // flood fill this component, accumulating moments
      let sp = 0;
      stack[sp++] = p;
      label[p] = comp;
      let area = 0, sumX = 0, sumY = 0, minX = w, maxX = 0, minY = h, maxY = 0;
      let minA = Infinity, maxA = -Infinity, minC = Infinity, maxC = -Infinity; // extents along / across the motion axis
      while (sp > 0) {
        const q = stack[--sp];
        const qx = q % w;
        const qy = (q / w) | 0;
        area++;
        sumX += qx;
        sumY += qy;
        if (qx < minX) minX = qx;
        if (qx > maxX) maxX = qx;
        if (qy < minY) minY = qy;
        if (qy > maxY) maxY = qy;
        const pa = qx * ux + qy * uy, pc = -qx * uy + qy * ux;
        if (pa < minA) minA = pa;
        if (pa > maxA) maxA = pa;
        if (pc < minC) minC = pc;
        if (pc > maxC) maxC = pc;
        // 4-connected neighbours
        if (qx > 0 && label[q - 1] === -1) { label[q - 1] = comp; stack[sp++] = q - 1; }
        if (qx < w - 1 && label[q + 1] === -1) { label[q + 1] = comp; stack[sp++] = q + 1; }
        if (qy > 0 && label[q - w] === -1) { label[q - w] = comp; stack[sp++] = q - w; }
        if (qy < h - 1 && label[q + w] === -1) { label[q + w] = comp; stack[sp++] = q + w; }
      }

      if (this.cfg.track) {
        // v2: gather every size-valid, loosely-round blob for the forward-lock selector
        if (area >= this.cfg.minArea && area <= this.cfg.maxArea) {
          const bw = maxX - minX + 1, bh = maxY - minY + 1;
          const fill = area / (bw * bh);
          if (fill >= 0.35) {
            const dPx = blobDiameterPx(area, maxA - minA + 1, maxC - minC + 1, dil);
            cands.push({ cx: sumX / area, cy: sumY / area, dPx, area, fill, aspect: Math.min(bw, bh) / Math.max(bw, bh) });
          }
        }
      } else {
        const cand = this.score(area, minX, maxX, minY, maxY, sumX, sumY);
        if (cand && (!best || cand.conf > best.conf)) best = { ...cand, dPx: blobDiameterPx(area, maxA - minA + 1, maxC - minC + 1, dil) };
      }
    }

    // recycle the oldest slot as the newest frame (in place — no allocation) and
    // advance, so next frame's reference is again exactly `lag` frames back
    ref.set(luma);
    this.ringIdx = (this.ringIdx + 1) % this.lag;

    if (this.cfg.track) return this.selectTracked(cands, t);

    if (!best || best.conf < this.cfg.minConfidence) return null;
    return { t, cx: best.cx, cy: best.cy, dPx: best.dPx, conf: best.conf };
  }

  /**
   * v2 selection: acquire the ball-like blob in the acquire zone, then follow it
   * frame-to-frame — preferring the candidate near the predicted position and
   * moving in the flight direction. This is what beats the bat/wall/net decoys:
   * the ball is the round thing that launches and keeps moving toward the net.
   */
  private selectTracked(cands: Cand[], t: number): BallObs | null {
    const dir = this.cfg.dirX ?? 1;
    const exp = this.cfg.expectDiamPx ?? 20;
    const maxMisses = this.cfg.maxMisses ?? 4;
    const [loF, hiF] = this.cfg.diamBand ?? [0.55, 1.6];
    const diamLo = exp * loF, diamHi = exp * hiF; // hard ball-size band (kills body specks + net blobs)
    let chosen: Cand | null = null;

    if (this.trk) {
      // FOLLOW: predict, then pick the best gated candidate.
      const px = this.trk.cx + this.trk.vx;
      const py = this.trk.cy + this.trk.vy;
      const gate = Math.max(2.5 * exp, 2.2 * Math.abs(this.trk.vx) + 1.5 * exp);
      const runVx = this.trk.vx;
      let bestS = -Infinity;
      for (const c of cands) {
        if (c.dPx < diamLo || c.dPx > diamHi) continue; // ball-size band
        if ((c.cx - this.trk.cx) * dir < -0.5 * exp) continue; // ball never moves backward
        // velocity consistency: once we have a running velocity, reject a sudden
        // near-stop (the ball parking in the net) or a teleport onto a new blob.
        if (Math.abs(runVx) > 1) {
          const step = (c.cx - this.trk.cx) * Math.sign(runVx);
          if (step < 0.2 * Math.abs(runVx)) continue; // decel to ~0 = net park
          if (step > 2.5 * Math.abs(runVx) + exp) continue; // jump ahead to a new blob
        }
        const dist = Math.hypot(c.cx - px, c.cy - py);
        if (dist > gate) continue;
        const prox = 1 - dist / gate;
        const round = c.fill * c.aspect;
        const sizeP = Math.max(0, 1 - Math.abs(c.dPx - exp) / exp);
        const s = 2.0 * prox + 1.0 * round + 0.8 * sizeP;
        if (s > bestS) { bestS = s; chosen = c; }
      }
      if (chosen) {
        this.trk = { cx: chosen.cx, cy: chosen.cy, vx: chosen.cx - this.trk.cx, vy: chosen.cy - this.trk.cy, misses: 0 };
      } else {
        this.trk.misses++;
        if (this.trk.misses > maxMisses) this.trk = null;
        return null;
      }
    } else {
      // ACQUIRE: the roundest, most ball-sized blob inside the launch zone.
      const z = this.cfg.acquireZone ?? this.cfg.roi;
      const minRound = this.cfg.minCircularity ?? 0.4;
      const edgePad = 0.5 * exp; // the body/tee pile sits at the zone's BACK edge (where the ball launches FROM)
      let bestS = -Infinity;
      for (const c of cands) {
        if (z && (c.cx < z.x0 || c.cx > z.x1 || c.cy < z.y0 || c.cy > z.y1)) continue;
        if (c.dPx < diamLo || c.dPx > diamHi) continue; // ball-size band — reject body specks + net blobs
        if (z && dir > 0 && c.cx < z.x0 + edgePad) continue; // righty: reject the back (left) edge pile
        if (z && dir < 0 && c.cx > z.x1 - edgePad) continue; // lefty: reject the back (right) edge pile
        const round = c.fill * c.aspect;
        if (round < minRound) continue;
        const sizeP = Math.max(0, 1 - Math.abs(c.dPx - exp) / exp);
        const s = round + sizeP;
        if (s > bestS) { bestS = s; chosen = c; }
      }
      if (chosen) this.trk = { cx: chosen.cx, cy: chosen.cy, vx: 0, vy: 0, misses: 0 };
    }

    if (!chosen) return null;
    const conf = Math.max(0, Math.min(1, chosen.fill * chosen.aspect));
    return { t, cx: chosen.cx, cy: chosen.cy, dPx: chosen.dPx, conf };
  }

  /** Score a blob by size-in-range × circularity × fill; return centroid or null. */
  private score(
    area: number,
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
    sumX: number,
    sumY: number,
  ): { cx: number; cy: number; area: number; conf: number } | null {
    const { minArea, maxArea, minCircularity } = this.cfg;
    if (area < minArea || area > maxArea) return null;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const bboxArea = bw * bh;
    const fill = area / bboxArea; // disc ≈ 0.785
    const aspect = Math.min(bw, bh) / Math.max(bw, bh); // disc ≈ 1
    const circ = fill * aspect; // combined roundness proxy
    if (circ < minCircularity) return null;
    // confidence: roundness, softly penalized far from a disc's ideal fill
    const conf = Math.max(0, Math.min(1, circ));
    return { cx: sumX / area, cy: sumY / area, area, conf };
  }
}
