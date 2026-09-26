/**
 * bat-tracker.ts — Phase 3 measurement engine: turn per-frame BAT observations
 * (knob + barrel-tip positions) into BAT SPEED, ATTACK ANGLE, and bat tilt at the
 * moment of contact. The bat analog of tracker.ts (the ball EV engine), and built
 * the same way: a faithful pinhole synth + an inverse estimator, node-tested today,
 * so the math is proven BEFORE the native bat detector exists (exactly how the ball
 * tracker was de-risked ahead of detection — see docs/research/19-bat-tracking.md).
 *
 * Pipeline:
 *   bat obs (knob, tip, t, conf) + a CONTACT frame index (from the audio crack /
 *     contact-sync.anchorContact — Phase 2 feeds Phase 3)
 *     → sweet-spot pixel path  (a point ~`sweetSpotFracFromTip` of the way from the
 *        barrel toward the knob)
 *     → rolling-shutter time correction + pixel→meters via the swing-plane scale
 *     → LOCAL quadratic fit around contact (the bat accelerates through the zone, so
 *        we read the velocity AT contact, not a straight-line average)
 *     → bat speed = |v_contact|, yaw cosine-corrected
 *     → attack angle = velocity angle above horizontal
 *     → bat tilt = knob→tip angle at contact
 *     → plausibility gates + honest confidence
 *
 * HONESTY (the bat is harder than the ball — it is NOT a sphere):
 *  - The bat's apparent LENGTH changes with orientation (foreshortening), so it can't
 *    self-scale the way the ball's diameter does. Scale comes from the swing-plane
 *    px/m (`calScalePxPerM`) — best taken from the ball's self-scale at contact (the
 *    ball is visible then) or a setup calibration. A bat pointing toward the camera
 *    (collapsed apparent length) breaks the in-plane assumption → flagged low.
 *  - Attack angle + bat speed are in-plane reads from a square side-on camera; off-axis
 *    they degrade (cosine-corrected, then flagged). Everything here is an ESTIMATE
 *    until validated on real footage vs a bat sensor (Blast/Rapsodo) — same bar as EV.
 */

const MS_TO_MPH = 2.236936;

/** One detected bat in one frame: the handle (knob) and barrel-end (tip) in pixels. */
export type BatObs = {
  t: number; // frame presentation time (s)
  knobX: number;
  knobY: number; // image coords, y increases downward
  tipX: number; // barrel end
  tipY: number;
  conf: number; // 0..1 detection confidence
};

export type BatCalibration = {
  batLengthM: number; // real knob→barrel-end length (e.g. 33" bat ≈ 0.84 m)
  sweetSpotFracFromTip: number; // fraction of the length from the tip toward the knob (~0.18)
  calScalePxPerM: number; // swing-plane scale — from the ball self-scale at contact / setup cal
  imageHeightPx: number; // for the rolling-shutter row fraction
  cxPrincipalPx: number; // lens principal point
  cyPrincipalPx: number;
  yawDeg: number; // swing plane vs image plane (foreshortening of the in-plane speed)
  readoutMs: number; // rolling-shutter readout time
};

export type BatConfidence = 'high' | 'medium' | 'low';

export type BatResult = {
  ok: boolean;
  batSpeedMph: number; // sweet-spot speed at contact
  attackAngleDeg: number; // bat path angle at contact (+ = swinging up)
  batAngleDeg: number; // bat shaft tilt from horizontal at contact (descriptive)
  nFrames: number; // frames used in the local fit
  foreshortened: boolean; // bat apparent length collapsed → in-plane read unreliable
  confidence: BatConfidence;
  reason?: string;
};

export type BatEstimateOpts = {
  minConf?: number; // drop frames below this detection confidence
  windowRadius?: number; // frames each side of contact for the local fit
  applyRollingShutter?: boolean;
  applyYaw?: boolean;
};

/* ----------------------------------------------------------- math helpers */

/** Gaussian elimination for a 3×3 system A·x = b. Returns x, or null if singular. */
function solve3(A: number[][], b: number[]): number[] | null {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let c = col; c < 4; c++) M[col][c] /= d;
    for (let r = 0; r < 3; r++) {
      if (r !== col) {
        const f = M[r][col];
        for (let c = col; c < 4; c++) M[r][c] -= f * M[col][c];
      }
    }
  }
  return [M[0][3], M[1][3], M[2][3]];
}

/** Weighted quadratic fit v = a + b·τ + c·τ²; returns the derivative at τ=0 (= b).
 *  Exact through 3 points, so a short accelerating arc still yields the contact slope. */
function slopeAtZero(taus: number[], vs: number[], w: number[]): number {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < taus.length; i++) {
    const wi = w[i], t = taus[i], v = vs[i];
    const t2i = t * t;
    s0 += wi; s1 += wi * t; s2 += wi * t2i; s3 += wi * t2i * t; s4 += wi * t2i * t2i;
    t0 += wi * v; t1 += wi * t * v; t2 += wi * t2i * v;
  }
  const x = solve3([[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]], [t0, t1, t2]);
  if (x) return x[1];
  // singular (e.g. all τ equal) → fall back to a weighted linear slope
  const denom = s0 * s2 - s1 * s1;
  return Math.abs(denom) < 1e-12 ? 0 : (s0 * t1 - s1 * t0) / denom;
}

/* ------------------------------------------------------------- estimator */

/**
 * Estimate bat speed / attack angle / bat tilt at contact. `contactIdx` is the frame
 * of contact (from the audio crack via contact-sync; pass -1 to use the middle frame).
 */
export function estimateBatSwing(
  obs: BatObs[],
  cal: BatCalibration,
  contactIdx: number,
  opts: BatEstimateOpts = {},
): BatResult {
  const minConf = opts.minConf ?? 0.3;
  const W = opts.windowRadius ?? 3;
  const applyRS = opts.applyRollingShutter ?? true;
  const applyYaw = opts.applyYaw ?? true;
  const n = obs.length;
  const fail = (reason: string, nf = 0): BatResult => ({
    ok: false, batSpeedMph: 0, attackAngleDeg: 0, batAngleDeg: 0, nFrames: nf, foreshortened: false, confidence: 'low', reason,
  });

  if (n < 3) return fail('Too few bat frames to measure.', n);
  const ci = contactIdx < 0 ? Math.floor(n / 2) : Math.min(n - 1, contactIdx);

  const scale = cal.calScalePxPerM;
  const frac = cal.sweetSpotFracFromTip;
  // sweet-spot pixel = a point `frac` of the way from the barrel tip toward the knob.
  const sweetPx = (o: BatObs) => ({ x: o.tipX + frac * (o.knobX - o.tipX), y: o.tipY + frac * (o.knobY - o.tipY) });
  const rsTime = (o: BatObs, cy: number) => (applyRS ? o.t + (cal.readoutMs / 1000) * (cy / cal.imageHeightPx) : o.t);

  // local window around contact (confident frames only)
  const lo = Math.max(0, ci - W);
  const hi = Math.min(n - 1, ci + W);
  const tau: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  const w: number[] = [];
  const cs = sweetPx(obs[ci]);
  const tC = rsTime(obs[ci], cs.y);
  for (let i = lo; i <= hi; i++) {
    const o = obs[i];
    if (o.conf < minConf) continue;
    const sp = sweetPx(o);
    tau.push(rsTime(o, sp.y) - tC);
    xs.push((sp.x - cal.cxPrincipalPx) / scale);
    ys.push(-(sp.y - cal.cyPrincipalPx) / scale);
    w.push(o.conf);
  }
  if (tau.length < 3) return fail('Too few clean frames around contact to measure.', tau.length);

  // velocity at contact (τ = 0)
  const vx = slopeAtZero(tau, xs, w);
  const vy = slopeAtZero(tau, ys, w);
  let speedMs = Math.hypot(vx, vy);
  if (applyYaw) {
    const c = Math.cos((cal.yawDeg * Math.PI) / 180);
    if (c > 0.2) speedMs /= c;
  }
  const batSpeedMph = speedMs * MS_TO_MPH;
  const attackAngleDeg = (Math.atan2(vy, Math.abs(vx)) * 180) / Math.PI;

  // bat shaft tilt at contact (knob→tip), y-up
  const bxm = (obs[ci].tipX - obs[ci].knobX) / scale;
  const bym = -(obs[ci].tipY - obs[ci].knobY) / scale;
  const batAngleDeg = (Math.atan2(bym, bxm) * 180) / Math.PI;

  // foreshortening: the bat's apparent length vs its real length. Collapsed → the bat
  // points toward/away from the camera and the in-plane speed/angle can't be trusted.
  const obsLenM = Math.hypot(bxm, bym);
  const foreshortened = obsLenM < 0.6 * cal.batLengthM;

  // plausibility gates
  if (batSpeedMph < 10 || batSpeedMph > 120) {
    return fail(`Implausible bat speed (${batSpeedMph.toFixed(0)} mph) — likely a tracking error.`, tau.length);
  }
  if (attackAngleDeg < -30 || attackAngleDeg > 45) {
    return fail(`Implausible attack angle (${attackAngleDeg.toFixed(0)}°) — likely a tracking error.`, tau.length);
  }

  // honest confidence
  let confidence: BatConfidence = 'high';
  if (tau.length < 5) confidence = 'medium';
  if (batSpeedMph > 85 && confidence === 'high') confidence = 'medium'; // fast = blurrier, fewer clean frames
  if (Math.abs(cal.yawDeg) > 15) confidence = 'medium';
  if (Math.abs(cal.yawDeg) > 25) confidence = 'low';
  if (foreshortened) confidence = 'low';

  return {
    ok: true,
    batSpeedMph: Math.round(batSpeedMph * 10) / 10,
    attackAngleDeg: Math.round(attackAngleDeg * 10) / 10,
    batAngleDeg: Math.round(batAngleDeg * 10) / 10,
    nFrames: tau.length,
    foreshortened,
    confidence,
  };
}

/* ------------------------------------------------- synthetic camera (test) */

export type BatSynthOpts = {
  fps?: number;
  nFrames?: number;
  distanceM?: number; // camera→swing-plane depth
  focalPx?: number;
  azimuthDeg?: number; // swing plane tilt vs image plane (sets cal.yawDeg)
  batLengthM?: number;
  sweetSpotFracFromTip?: number;
  centroidNoisePx?: number;
  readoutMs?: number;
  curveAccelMs2?: number; // perpendicular acceleration (curves the sweet-spot path)
  batSweepDegPerS?: number; // bat axis rotation rate through the window
  batForeshortenAtContact?: number; // <1 shrinks apparent bat length (points at camera)
};

/**
 * Project a known (bat speed, attack angle, bat tilt) swing through a pinhole
 * side-camera into per-frame knob/tip observations — the faithful forward model the
 * estimator inverts. Contact is the middle frame, framed at the principal point.
 */
export function synthBatSwing(
  trueSpeedMph: number,
  trueAttackDeg: number,
  trueBatAngleDeg: number,
  o: BatSynthOpts = {},
): { obs: BatObs[]; cal: BatCalibration; contactIdx: number } {
  const fps = o.fps ?? 240;
  const N = o.nFrames ?? 13;
  const Z0 = o.distanceM ?? 3.0;
  const f = o.focalPx ?? 1400;
  const az = ((o.azimuthDeg ?? 0) * Math.PI) / 180;
  const L = o.batLengthM ?? 0.84;
  const frac = o.sweetSpotFracFromTip ?? 0.18;
  const noise = o.centroidNoisePx ?? 0;
  const readoutMs = o.readoutMs ?? 3;
  const accel = o.curveAccelMs2 ?? 0;
  const sweepRate = ((o.batSweepDegPerS ?? 0) * Math.PI) / 180;
  const fs = o.batForeshortenAtContact ?? 1;
  const H = 1080;
  const cxP = 960, cyP = 540;
  const rand = Math.random;
  const gn = () => (rand() + rand() + rand() + rand() - 2) * 0.7071;

  const speedMs = trueSpeedMph / MS_TO_MPH;
  const a = (trueAttackDeg * Math.PI) / 180;
  const vx = speedMs * Math.cos(a); // plane x (across image)
  const vy = speedMs * Math.sin(a); // plane y (up)
  const ax = accel * -Math.sin(a); // perpendicular accel (curves the arc)
  const ay = accel * Math.cos(a);

  const ic = Math.floor(N / 2);
  const tc = ic / fps;

  // project a swing-plane point (Xp,Yp) at tilt az → pixels
  const project = (Xp: number, Yp: number) => {
    const wX = Xp * Math.cos(az);
    const wZ = Z0 + Xp * Math.sin(az);
    return { px: cxP + (f * wX) / wZ, py: cyP - (f * Yp) / wZ };
  };
  const sweetAt = (tau: number) => ({ X: vx * tau + 0.5 * ax * tau * tau, Y: vy * tau + 0.5 * ay * tau * tau });

  const obs: BatObs[] = [];
  for (let i = 0; i < N; i++) {
    const tFrame = i / fps;
    // rolling shutter: one frame time, set by the sweet spot's row
    let tRS = tFrame;
    for (let it = 0; it < 2; it++) {
      const s = sweetAt(tRS - tc);
      const sp = project(s.X, s.Y);
      tRS = tFrame + (readoutMs / 1000) * (sp.py / H);
    }
    const tau = tRS - tc;
    const s = sweetAt(tau);
    const beta = (trueBatAngleDeg * Math.PI) / 180 + sweepRate * tau;
    const ux = Math.cos(beta), uy = Math.sin(beta); // knob→tip unit (plane, y-up)
    const knob = { X: s.X - (1 - frac) * L * fs * ux, Y: s.Y - (1 - frac) * L * fs * uy };
    const tip = { X: s.X + frac * L * fs * ux, Y: s.Y + frac * L * fs * uy };
    const kp = project(knob.X, knob.Y);
    const tp = project(tip.X, tip.Y);
    obs.push({
      t: tFrame,
      knobX: kp.px + noise * gn(), knobY: kp.py + noise * gn(),
      tipX: tp.px + noise * gn(), tipY: tp.py + noise * gn(),
      conf: 1,
    });
  }

  const cal: BatCalibration = {
    batLengthM: L,
    sweetSpotFracFromTip: frac,
    calScalePxPerM: f / Z0,
    imageHeightPx: H,
    cxPrincipalPx: cxP,
    cyPrincipalPx: cyP,
    yawDeg: o.azimuthDeg ?? 0,
    readoutMs,
  };
  return { obs, cal, contactIdx: ic };
}
