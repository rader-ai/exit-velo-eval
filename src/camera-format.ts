/**
 * camera-format.ts — bind the physical camera to the measurement engine.
 *
 * Picks the capture format (1080p, highest fps ≤240) and builds the
 * `Calibration` the estimator needs (principal point, focal scale, etc.) for the
 * downscaled detection resolution. See docs/research/10-camera-detector-native.md.
 */

import { type Ball } from './session.ts';
import { type Calibration } from './tracker.ts';

/** Detection runs on a downscale of the 1080p frame (the detector's tested size). */
export const DETECT_WIDTH = 480;
export const DETECT_HEIGHT = 270;

/** Filter list for VisionCamera's useCameraFormat — prefer 1080p @ high fps. */
export const FORMAT_FILTER = [
  { videoResolution: { width: 1920, height: 1080 } },
  { fps: 240 },
] as const;

const BALL_DIAM_M: Record<Ball, number> = { baseball: 0.073, softball: 0.097 };

/**
 * Build the estimator calibration for the chosen format. `fovHorizontalDeg` is
 * the camera's horizontal field of view (from the VisionCamera format / device
 * intrinsics); `distanceFt` is the guided "set your spot" distance.
 *
 * NOTE: a precise focal length needs real camera intrinsics per device/lens
 * (an on-device step). The FOV estimate here is a reasonable default for the
 * 1× wide lens (~70°) and is overridden once intrinsics are read.
 */
export function buildCalibration(opts: {
  ball: Ball;
  diameterM?: number; // exact ball diameter (e.g. ballSpec for 11" vs 12" softball); overrides the coarse Ball default
  fovHorizontalDeg?: number;
  distanceFt?: number;
  yawDeg?: number;
  readoutMs?: number;
}): Calibration {
  const fov = ((opts.fovHorizontalDeg ?? 70) * Math.PI) / 180;
  // focal length in DOWNSCALED px: f = (W/2) / tan(HFOV/2)
  const fPx = DETECT_WIDTH / 2 / Math.tan(fov / 2);
  // The exact diameter matters: an 11" softball measured as a 12" mis-scales every frame
  // (~9% EV error). Pass `diameterM` from ball-spec (sport + cohort); else the coarse default.
  const ballDiamM = opts.diameterM ?? BALL_DIAM_M[opts.ball];
  const D0 = (opts.distanceFt ?? 5) * 0.3048; // ft → m
  return {
    ballDiamM,
    imageHeightPx: DETECT_HEIGHT,
    cxPrincipalPx: DETECT_WIDTH / 2,
    cyPrincipalPx: DETECT_HEIGHT / 2,
    yawDeg: opts.yawDeg ?? 0,
    readoutMs: opts.readoutMs ?? 3,
    calScalePxPerM: fPx / D0, // px per m at the calibration plane (fixed-scale foil)
  };
}

/** The expected ball diameter in detector px at the calibration plane — the SIZE prior the
 *  detector uses to reject wrong-sized blobs (the strongest narrowing cue alongside color). */
export function expectedBallDiameterPx(cal: Calibration): number {
  return cal.ballDiamM * (cal.calScalePxPerM ?? 0);
}
