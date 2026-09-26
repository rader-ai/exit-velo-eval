/**
 * tracker.ts — the measurement engine's front half: turn per-frame ball
 * observations into EXIT VELOCITY and LAUNCH ANGLE.
 *
 * This implements the pipeline validated in
 * docs/research/07-measurement-calculation-engine.md §3 and the Monte-Carlo in
 * docs/research/sims/measurement_error_mc.py:
 *
 *   observations (cx, cy, dPx, t, conf)
 *     → rolling-shutter timestamp correction
 *     → PER-FRAME SELF-SCALING  s(t) = dPx(t)/dReal   (the parallax fix)
 *     → weighted least-squares projectile fit (constant v + gravity)
 *     → EV = |v|,  LA = elevation angle
 *     → yaw cosine correction
 *     → out-of-plane (depth) detection via diameter trend
 *     → plausibility gates + honest confidence/±band
 *
 * The DETECTION front-end (camera frame → observation) is the only remaining
 * native piece; `synthSwing()` produces physically-grounded observations so the
 * whole estimator runs and is unit-tested today, and so the app can demo real
 * measurement math while the camera detector is built.
 */

import { SEM_MEAS_MPH, type Ball, type Swing, projectedDistance } from './session.ts';

const G = 9.81; // m/s²
const MS_TO_MPH = 2.236936;

// Flight-frame gate — validated on real park footage (docs/research/18). The
// across-frame velocity is only stable once the ball is tracked through enough
// in-flight frames: a reference hitter's spread collapsed from ±8.6 to ±4.5 mph once we
// required ≥8 frames, and short 3–4 frame tracks produced the wild 9 / 82 mph
// outliers. So: below MIN we don't report at all; below TRUSTED we never grade
// above 'medium'.
const MIN_FLIGHT_FRAMES = 5;
const TRUSTED_FLIGHT_FRAMES = 8;

/** One detected ball position in one video frame. */
export type BallObs = {
  t: number; // frame presentation time (s) — from real timestamps, not assumed 1/fps
  cx: number; // centroid x (px)
  cy: number; // centroid y (px), image coords (y increases downward)
  dPx: number; // apparent ball diameter (px) — the per-frame depth ruler
  conf: number; // detection confidence 0..1 (down-weights blur/occlusion)
};

export type Calibration = {
  ballDiamM: number; // real ball diameter (m) — baseball 0.073, softball 0.097
  imageHeightPx: number; // for the rolling-shutter row fraction
  cxPrincipalPx: number; // lens principal point x (≈ image center) — from intrinsics
  cyPrincipalPx: number; // lens principal point y
  yawDeg: number; // camera yaw off perpendicular (gyro estimate)
  readoutMs: number; // rolling-shutter readout time (~3 ms binned slo-mo)
  calScalePxPerM?: number; // px/m measured at the flight plane during setup (fixed-scale foil only)
};

import type { Confidence } from './engine-types.ts';
export type { Confidence };

export type TrackResult = {
  ok: boolean;
  evMph: number;
  laDeg: number;
  nFrames: number;
  offPlane: boolean;
  confidence: Confidence;
  semMph: number; // estimated 1σ measurement error
  reason?: string; // populated when ok === false
};

/* ----------------------------------------------------------- math helpers */

/** Weighted least-squares fit of  value = a + b·t.  Returns {a, b}. */
function wlsLinear(t: number[], v: number[], w: number[]): { a: number; b: number } {
  let sw = 0, swt = 0, swv = 0, swtt = 0, swtv = 0;
  for (let i = 0; i < t.length; i++) {
    const wi = w[i];
    sw += wi;
    swt += wi * t[i];
    swv += wi * v[i];
    swtt += wi * t[i] * t[i];
    swtv += wi * t[i] * v[i];
  }
  const denom = sw * swtt - swt * swt;
  if (Math.abs(denom) < 1e-12) return { a: v[0] ?? 0, b: 0 };
  const b = (sw * swtv - swt * swv) / denom;
  const a = (swv - b * swt) / sw;
  return { a, b };
}

/* ------------------------------------------------------------- estimator */

export type EstimateOpts = {
  scale?: 'self' | 'fixed'; // 'fixed' is a baseline foil; ship 'self'
  applyRollingShutter?: boolean;
  applyYaw?: boolean;
  minConf?: number; // drop frames below this detection confidence
  maxFrames?: number; // cap the fit window after first contact
  diamModel?: 'raw' | 'robust'; // 'robust' (default): denoise the self-scale ruler; 'raw' = legacy per-frame
  evMaxMph?: number; // gate ceiling override (session.evCeilingForCohort) — default stays the youth cap
};

/**
 * Estimate EV + LA from a sequence of in-flight ball observations
 * (oldest → newest, starting at/after contact).
 */
export function estimateSwing(obs: BallObs[], cal: Calibration, opts: EstimateOpts = {}): TrackResult {
  const scale = opts.scale ?? 'self';
  const applyRS = opts.applyRollingShutter ?? true;
  const applyYaw = opts.applyYaw ?? true;
  const minConf = opts.minConf ?? 0.35;
  const maxFrames = opts.maxFrames ?? 8;

  // 1. keep confident frames, take the first contact + up to maxFrames
  const kept = obs.filter((o) => o.conf >= minConf && o.dPx > 1).slice(0, maxFrames);
  if (kept.length < MIN_FLIGHT_FRAMES) {
    return fail('Too few clean flight frames to measure — re-film side-on.', kept.length);
  }

  // 2. scale (px/m). self-scale: each frame's own apparent diameter is the depth
  //    ruler. On real footage the blob area spikes for a few low-confidence
  //    frames (halos/merges), so we read the ruler off a CONFIDENCE-WEIGHTED, robust
  //    fit of dPx(t) instead of the raw per-frame value — keeping the smooth depth
  //    trend while rejecting noise (see robustDiameter). fixed-scale foil: the single
  //    px/m measured at the calibration plane.
  const t0 = kept[0].t;
  const diam = robustDiameter(kept, t0, opts.diamModel ?? 'robust');
  const calScale = cal.calScalePxPerM ?? median(kept.map((o) => o.dPx)) / cal.ballDiamM;
  const scaleOf = (i: number) => (scale === 'self' ? diam.dHat[i] / cal.ballDiamM : calScale); // px per m

  // 3. corrected times + real-world positions. Subtract the principal point
  //    BEFORE pixel→meters (a constant pixel offset would otherwise become a
  //    spurious velocity once scaled per-frame), and flip y so up is positive.
  const ts: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  const w: number[] = [];
  for (let i = 0; i < kept.length; i++) {
    const o = kept[i];
    const sPxPerM = scaleOf(i);
    const tRS = applyRS ? o.t + (cal.readoutMs / 1000) * (o.cy / cal.imageHeightPx) : o.t;
    ts.push(tRS - t0);
    xs.push((o.cx - cal.cxPrincipalPx) / sPxPerM);
    ys.push(-(o.cy - cal.cyPrincipalPx) / sPxPerM);
    w.push(o.conf);
  }

  // 4. weighted LSQ.  x: x = x0 + vx·t.  y: (y + ½g t²) = y0 + vy·t.
  const fx = wlsLinear(ts, xs, w);
  const yLin = ys.map((y, i) => y + 0.5 * G * ts[i] * ts[i]);
  const fy = wlsLinear(ts, yLin, w);
  const vx = fx.b;
  const vy = fy.b;

  // 5. yaw cosine correction on the ACROSS-IMAGE component only — foreshortening
  //    shrinks vx, not vy, so correcting |v| would over-read the vertical part and
  //    leave the launch angle uncorrected (audit 2026-07-02).
  let vxc = vx;
  if (applyYaw) {
    const c = Math.cos((cal.yawDeg * Math.PI) / 180);
    if (c > 0.2) vxc = vx / c;
  }

  // 6. EV + LA  (launch angle = elevation above horizontal travel)
  const horiz = Math.abs(vxc);
  const evMs = Math.hypot(vxc, vy);
  let laDeg = (Math.atan2(vy, horiz) * 180) / Math.PI;
  let evMph = evMs * MS_TO_MPH;

  // 7. out-of-plane detection: a ball moving toward/away grows/shrinks in diameter.
  //    Read the trend off the same robust (de-noised) diameter fit so a few spiky
  //    frames can't fake — or mask — a depth move.
  const offPlane = Math.abs(diam.trend) > 0.08; // >8% monotonic change across the window

  // 8. plausibility gates
  if (evMph < 15 || evMph > 115) {
    return fail(`Implausible exit velo (${evMph.toFixed(0)} mph) — likely a tracking error.`, kept.length);
  }
  if (laDeg < -20 || laDeg > 50) {
    return fail(`Implausible launch angle (${laDeg.toFixed(0)}°) — likely a tracking error.`, kept.length);
  }

  // 9. honest confidence + ±band
  const { confidence, semMph } = grade({ n: kept.length, offPlane, yawDeg: cal.yawDeg, evMph });

  return {
    ok: true,
    evMph: Math.round(evMph * 10) / 10,
    laDeg: Math.round(laDeg * 10) / 10,
    nFrames: kept.length,
    offPlane,
    confidence,
    semMph,
  };
}

function fail(reason: string, n: number): TrackResult {
  return { ok: false, evMph: 0, laDeg: 0, nFrames: n, offPlane: false, confidence: 'low', semMph: 0, reason };
}

/** Relative diameter change across the window (signed): + growing (approaching). */
function diameterTrend(obs: BallObs[]): number {
  const ds = obs.map((o) => o.dPx);
  const idx = obs.map((_, i) => i);
  const fit = wlsLinear(idx, ds, obs.map((o) => o.conf));
  const meanD = ds.reduce((a, b) => a + b, 0) / ds.length;
  return (fit.b * (obs.length - 1)) / meanD; // total fitted change / mean
}

/**
 * The self-scale ruler, de-noised. Apparent ball diameter varies SMOOTHLY with
 * depth, but the detector's raw blob diameter spikes for a handful of low-confidence
 * frames (a halo or a neighbouring blob merging in). Those spikes corrupt the
 * per-frame scale (so velocity wobbles) and trip the off-plane flag.
 *
 * Fix: fit  dPx ≈ a + b·(t−t0)  weighted by detection confidence, with ONE robust
 * (IRLS) reweight that down-weights frames whose diameter fights the trend — so a
 * sustained low-confidence bump can't drag the ruler. Read both the per-frame ruler
 * and the off-plane trend off that smooth fit. 'raw' restores the legacy per-frame
 * value (the MC parallax foil + back-compat).
 *
 * No-op on clean data: a noise-free, equal-confidence, on-plane flight has a
 * straight dPx(t), so the fit reproduces it exactly.
 */
function robustDiameter(kept: BallObs[], t0: number, model: 'raw' | 'robust'): { dHat: number[]; trend: number } {
  const ds = kept.map((o) => o.dPx);
  if (model === 'raw') return { dHat: ds, trend: diameterTrend(kept) };
  const ts = kept.map((o) => o.t - t0);
  const w = kept.map((o) => Math.max(o.conf, 0.05));
  let fit = wlsLinear(ts, ds, w);
  // robust reweight (Cauchy): frames far from the trend lose influence.
  const resid = ds.map((d, i) => Math.abs(d - (fit.a + fit.b * ts[i])));
  const mad = median(resid) || 1e-6;
  const w2 = w.map((wi, i) => wi / (1 + (resid[i] / (1.5 * mad)) ** 2));
  fit = wlsLinear(ts, ds, w2);
  const med = median(ds);
  const dHat = ts.map((t) => {
    const d = fit.a + fit.b * t;
    return d > 0.3 * med ? d : med; // guard a degenerate (near-zero/negative) fit
  });
  const meanD = dHat.reduce((a, b) => a + b, 0) / dHat.length;
  const trend = meanD > 0 ? (fit.b * (ts[ts.length - 1] - ts[0])) / meanD : 0;
  return { dHat, trend };
}

/** Map conditions to a confidence label + an estimated 1σ (mph). */
function grade(p: { n: number; offPlane: boolean; yawDeg: number; evMph: number }): {
  confidence: Confidence;
  semMph: number;
} {
  // Base SEM is the (flagged) ESTIMATE from session.ts, widened by what degrades a read.
  let sem = SEM_MEAS_MPH;
  let conf: Confidence = 'high';
  // Flight-frame count is the dominant driver of stability — a short track can't
  // be trusted no matter how clean each point looks (see docs/research/18).
  if (p.n < TRUSTED_FLIGHT_FRAMES) { sem += 2.5; conf = 'medium'; }
  if (p.evMph > 80) { sem += 0.8; if (conf === 'high') conf = 'medium'; } // fast = blurrier, fewer frames
  if (Math.abs(p.yawDeg) > 10) { sem += 1.5; conf = 'low'; }
  if (p.offPlane) { sem *= 2.5; conf = 'low'; } // foreshortening self-scaling can't remove
  return { confidence: conf, semMph: Math.round(sem * 10) / 10 };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* ------------------------------------------------- gate core */

import { gateEv } from './ev-confidence.ts';

export type FlightStats = { n: number; straightnessPx: number; dPxMean: number; dPxStd: number };

/** Flight-quality stats from the raw 480x270 grid centroids, using the SAME kept-frame
 *  selection estimateSwing uses. straightnessPx = RMS perpendicular distance of the kept
 *  centroids from their total-least-squares best-fit line; dPx* = per-frame step length. */
export function flightStats(obs: BallObs[], opts: EstimateOpts = {}): FlightStats {
  const minConf = opts.minConf ?? 0.35;
  const maxFrames = opts.maxFrames ?? 8;
  const kept = obs.filter((o) => o.conf >= minConf && o.dPx > 1).slice(0, maxFrames);
  const n = kept.length;
  if (n < 2) return { n, straightnessPx: 0, dPxMean: 0, dPxStd: 0 };

  // per-frame step length (px on the grid)
  const steps: number[] = [];
  for (let i = 1; i < n; i++) steps.push(Math.hypot(kept[i].cx - kept[i - 1].cx, kept[i].cy - kept[i - 1].cy));
  const dPxMean = steps.reduce((a, b) => a + b, 0) / steps.length;
  const dPxVar = steps.reduce((a, b) => a + (b - dPxMean) * (b - dPxMean), 0) / steps.length;
  const dPxStd = Math.sqrt(dPxVar);

  // RMS perpendicular deviation from the TLS best-fit line (smaller eigenvalue of the
  // centered covariance / n).
  const mx = kept.reduce((a, o) => a + o.cx, 0) / n;
  const my = kept.reduce((a, o) => a + o.cy, 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const o of kept) { const dx = o.cx - mx, dy = o.cy - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const lambdaMin = ((sxx + syy) - Math.sqrt((sxx - syy) * (sxx - syy) + 4 * sxy * sxy)) / 2;
  const straightnessPx = Math.sqrt(Math.max(0, lambdaMin) / n);

  return { n, straightnessPx, dPxMean, dPxStd };
}

/** Apply the gateEv trust policy to an estimator result. Only ever turns a trusted read into
 *  an honest no-read; never alters evMph/laDeg, never resurrects a failed read.
 *
 *  The gate also grades a trusted flight 'high' vs 'medium' on its own margins (frame
 *  count, velocity stability, straightness). The swing carries the LOWER of the two
 *  confidences: a read the estimator called 'high' (enough frames, on-plane, no yaw) but
 *  the gate only rates 'medium' (jittery px/frame, marginal straightness) must not be
 *  presented as a solid read. Previously the gate's grade was discarded here. */
export function gateResult(r: TrackResult, fs: FlightStats & { evMph?: number }, opts: EstimateOpts = {}): TrackResult {
  if (!r.ok) return r;
  const g = gateEv(
    { n: fs.n, straightnessPx: fs.straightnessPx, dPxMean: fs.dPxMean, dPxStd: fs.dPxStd, evMph: r.evMph },
    { evMaxMph: opts.evMaxMph },
  );
  if (!g.trust) return { ...r, ok: false, reason: g.reason };
  if (g.confidence === 'medium' && r.confidence === 'high') return { ...r, confidence: 'medium' };
  return r;
}

export function estimateSwingGated(obs: BallObs[], cal: Calibration, opts: EstimateOpts = {}): TrackResult {
  return gateResult(estimateSwing(obs, cal, opts), flightStats(obs, opts), opts);
}

/* ------------------------------------------------- synthetic camera (test) */

export type SynthOpts = {
  ball?: Ball;
  fps?: number;
  distanceM?: number; // camera→flight-plane distance (calibration depth)
  depthOffsetM?: number; // ball plane offset from calibration (parallax stress)
  azimuthDeg?: number; // horizontal angle of flight vs image plane (pull/oppo)
  yawDeg?: number; // camera not perpendicular
  focalPx?: number; // pinhole focal length (px)
  centroidNoisePx?: number;
  readoutMs?: number;
  nFrames?: number;
  rand?: () => number; // injectable RNG (deterministic tests)
};

const BALL_DIAM: Record<Ball, number> = { baseball: 0.073, softball: 0.097 };

/**
 * Project a known (EV, LA) trajectory through a pinhole side-camera into
 * per-frame observations. Faithful to measurement_error_mc.py — used by tests
 * and as a "simulated capture" so the app runs the REAL estimator on grounded
 * data while the native detector is built.
 */
export function synthSwing(
  trueEvMph: number,
  trueLaDeg: number,
  o: SynthOpts = {},
): { obs: BallObs[]; cal: Calibration } {
  const ball = o.ball ?? 'baseball';
  const fps = o.fps ?? 240;
  const D0 = o.distanceM ?? 3.0;
  const dz = o.depthOffsetM ?? 0;
  const az = ((o.azimuthDeg ?? 0) * Math.PI) / 180;
  const f = o.focalPx ?? 1400;
  const noise = o.centroidNoisePx ?? 0;
  const readoutMs = o.readoutMs ?? 3;
  const N = o.nFrames ?? 6;
  const rand = o.rand ?? Math.random;
  const dBall = BALL_DIAM[ball];

  const ev = trueEvMph / MS_TO_MPH; // m/s
  const la = (trueLaDeg * Math.PI) / 180;
  const vHoriz = ev * Math.cos(la);
  const vX = vHoriz * Math.cos(az); // across image
  const vZ = vHoriz * Math.sin(az); // into/out of depth (pull/oppo)
  const vY = ev * Math.sin(la); // up

  const Z0 = D0 + dz; // ball plane depth (calibration done at D0)
  const X0 = 0;
  const Y0 = 0; // camera framed at tee height
  const H = 1080;
  const cxP = 540, cyP = H / 2; // principal point (lens center) for a 1080-tall sensor

  const gn = () => (rand() + rand() + rand() + rand() - 2) * 0.7071; // ~N(0,1)

  // Camera yaw is GEOMETRIC: rotate world→camera about the vertical axis through
  // the calibration point (0, ·, D0), so the tee stays centered/framed while the
  // camera sits off-square. (It used to only stamp cal.yawDeg without yawing the
  // projection, so the estimator's cos-correction was never actually exercised.)
  const psi = ((o.yawDeg ?? 0) * Math.PI) / 180;
  const cPsi = Math.cos(psi), sPsi = Math.sin(psi);
  const camZ = (X: number, Z: number) => D0 + sPsi * X + cPsi * (Z - D0);
  const camX = (X: number, Z: number) => cPsi * X - sPsi * (Z - D0);

  const obs: BallObs[] = [];
  for (let i = 0; i < N; i++) {
    // Rolling shutter: a row's true capture time lags by readout·(row/H). The
    // ball's row depends on its own position, so solve one fixed-point step.
    const tFrame = i / fps;
    let t = tFrame;
    for (let it = 0; it < 2; it++) {
      const Yr = Y0 + vY * t - 0.5 * G * t * t;
      const Zr = camZ(X0 + vX * t, Z0 + vZ * t);
      const row = cyP - (f * Yr) / Zr;
      t = tFrame + (readoutMs / 1000) * (row / H);
    }
    const Xw = X0 + vX * t;
    const Y = Y0 + vY * t - 0.5 * G * t * t;
    const Zw = Z0 + vZ * t;
    const X = camX(Xw, Zw);
    const Z = camZ(Xw, Zw);
    const cx = cxP + (f * X) / Z + noise * gn();
    const cy = cyP - (f * Y) / Z + noise * gn();
    const dPx = (f * dBall) / Z; // apparent diameter — the depth ruler
    obs.push({ t: tFrame, cx, cy, dPx, conf: 1 }); // app sees the frame stamp, not the per-row time
  }

  // calibration scale is measured at the flight-plane distance D0 (NOT the
  // offset plane) — so depthOffset/azimuth exercise the parallax self-scaling fixes.
  return {
    obs,
    cal: {
      ballDiamM: dBall,
      imageHeightPx: H,
      cxPrincipalPx: cxP,
      cyPrincipalPx: cyP,
      yawDeg: o.yawDeg ?? 0,
      readoutMs,
      calScalePxPerM: (f * dBall) / D0 / dBall, // = f/D0 (px per m at calibration plane)
    },
  };
}

/**
 * One simulated measured swing for the app demo: physically plausible (EV, LA)
 * → synthetic capture → REAL estimator → Swing. Replaces the old pure-random
 * mock so demo numbers now flow through the actual measurement pipeline.
 */
export function measuredRandomSwing(ball: Ball = 'baseball'): Swing {
  const trueEv = 48 + Math.random() * 34; // 48–82
  const trueLa = 12 + Math.random() * 22; // 12–34°
  const { obs, cal } = synthSwing(trueEv, trueLa, {
    ball,
    azimuthDeg: (Math.random() * 2 - 1) * 8, // tee-grade depth spread
    yawDeg: (Math.random() * 2 - 1) * 5,
    centroidNoisePx: 0.6,
  });
  // NOT gated: this is our own physically-clean synthetic data, not a real camera read — there are
  // no decoys to catch, and gating would spuriously downgrade clean demo swings (e.g. 81-82 mph).
  const r = estimateSwing(obs, cal);
  if (!r.ok) return { mph: Math.round(trueEv), angle: Math.round(trueLa), distance: projectedDistance(trueEv, trueLa, ball), conf: 'low' };
  return { mph: Math.round(r.evMph), angle: Math.round(r.laDeg), distance: projectedDistance(r.evMph, r.laDeg, ball), conf: r.confidence };
}
