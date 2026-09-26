/**
 * bat-detector.ts — POSE-ANCHORED bat detection (Phase 3 front-end). PURE + testable.
 *
 * Footage finding (docs/research/19): a free-floating "elongated bright blob" detector
 * fails — motion lights up the whole hitter, and the bright bat merges with the bare
 * forearm. The fix: anchor at the HANDS (the wrist joints we already get from the pose
 * pass) and look for the bright ridge extending OUTWARD, away from the body. The forearm
 * runs from the wrist back toward the elbow/body, so excluding the body-ward directions
 * drops it; the bat is the longest bright run heading away.
 *
 *   hands (wrist midpoint) + bodyCenter (shoulder/root midpoint) + a luma frame
 *     → cast rays from the hands, skip those pointing back at the body
 *     → the ray with the longest continuous bright run = the bat axis
 *     → knob = hands, tip = far end of that run; confidence from length × brightness
 *
 * Feeds bat-tracker.ts (knob/tip per frame). The audio crack (contact-sync) says WHICH
 * frame is contact. Scale comes from the ball self-scale at contact (the ball is a sphere;
 * the bat is not — docs/research/19).
 */

export type Pt = { x: number; y: number };

export type BatDetectorConfig = {
  width: number;
  height: number;
  brightThresh?: number; // legacy bright cue (kept for back-compat; ridge cue is primary)
  ridgeThresh?: number; // a bat is a high-contrast LINE: |2·center − flank⁺ − flank⁻| ≥ this (default 40)
  ridgeOffsetPx?: number; // perpendicular flank distance ≈ half the bat width + margin (default 6)
  maxLenPx?: number; // search radius from the hands (default min(w,h) * 0.6)
  angleStepDeg?: number; // ray sampling step (default 3°)
  gapTolPx?: number; // allowed off-ridge gap along a ray before the run ends (default 4)
  minLenPx?: number; // shorter than this → no bat (default 20)
  minBrightFrac?: number; // on-ridge fraction along the axis to accept (default 0.5)
  maxWidthPx?: number; // (legacy; the ridge cue makes this implicit)
};

export type BatDetection = {
  knobX: number; knobY: number; // the hands end
  tipX: number; tipY: number; // the barrel end
  lenPx: number;
  brightFrac: number; // fraction of the axis that was bright
  conf: number; // 0..1
};

/**
 * Detect the bat as the longest bright ridge extending outward from the hands.
 * `hands` and `bodyCenter` are in luma-grid pixel coords (the caller maps the pose
 * joints in: hands = wrist midpoint, bodyCenter = shoulder/root midpoint).
 */
export function detectBat(
  luma: Uint8Array | number[],
  hands: Pt,
  bodyCenter: Pt,
  cfg: BatDetectorConfig,
): BatDetection | null {
  const W = cfg.width, H = cfg.height;
  const maxLen = cfg.maxLenPx ?? Math.round(Math.min(W, H) * 0.6);
  const step = ((cfg.angleStepDeg ?? 3) * Math.PI) / 180;
  const gapTol = cfg.gapTolPx ?? 4;
  const minLen = cfg.minLenPx ?? 20;
  const minBrightFrac = cfg.minBrightFrac ?? 0.5;
  const ridgeThresh = cfg.ridgeThresh ?? 40;
  const off = cfg.ridgeOffsetPx ?? 6;

  const at = (x: number, y: number) => (x < 0 || x >= W || y < 0 || y >= H ? 0 : luma[(y | 0) * W + (x | 0)]);

  // unit vector pointing FROM the body TO the hands (the outward baseline)
  let ox = hands.x - bodyCenter.x, oy = hands.y - bodyCenter.y;
  const on = Math.hypot(ox, oy) || 1;
  ox /= on; oy /= on;

  let best: { dx: number; dy: number; runEnd: number; onCount: number } | null = null;

  for (let a = 0; a < Math.PI * 2; a += step) {
    const dx = Math.cos(a), dy = Math.sin(a);
    // skip rays pointing back toward the body (would ride the forearm/torso)
    if (dx * -ox + dy * -oy > 0.5) continue;

    const px = -dy, py = dx; // perpendicular to the ray
    let gap = 0, runEnd = 0, onCount = 0, sign = 0;
    for (let t = 1; t <= maxLen; t++) {
      const x = hands.x + t * dx, y = hands.y + t * dy;
      // bat = a high-contrast LINE: the center stands out from its perpendicular flanks
      // (bright bat → +ridge; dark bat → −ridge). Consistent polarity along the bat. This
      // also stops the run inside a wide bright wall (flanks == center → ridge ≈ 0).
      const r = 2 * at(x, y) - at(x + off * px, y + off * py) - at(x - off * px, y - off * py);
      let onBat = false;
      if (Math.abs(r) >= ridgeThresh) {
        const s = Math.sign(r);
        if (sign === 0) sign = s;
        if (s === sign) onBat = true;
      }
      if (onBat) { runEnd = t; onCount++; gap = 0; }
      else if (++gap > gapTol) break;
    }
    if (!best || runEnd > best.runEnd || (runEnd === best.runEnd && onCount > best.onCount)) {
      best = { dx, dy, runEnd, onCount };
    }
  }

  if (!best || best.runEnd < minLen) return null;
  const brightFrac = best.onCount / best.runEnd;
  if (brightFrac < minBrightFrac) return null;

  const tipX = hands.x + best.runEnd * best.dx;
  const tipY = hands.y + best.runEnd * best.dy;
  // confidence: length toward a plausible bat (~half the search radius) × cleanliness
  const lenScore = Math.min(1, best.runEnd / (maxLen * 0.5));
  const conf = Math.max(0, Math.min(1, lenScore * brightFrac));

  return { knobX: hands.x, knobY: hands.y, tipX, tipY, lenPx: best.runEnd, brightFrac, conf };
}
