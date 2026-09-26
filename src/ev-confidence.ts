/**
 * ev-confidence.ts — the EV confidence GATE. Turns the raw estimator output into either a
 * trustworthy exit-velocity number OR an honest "couldn't get a clean read", from flight-quality
 * + physics signals, with NO new data. Built because the field test (docs/research/18) showed the
 * pipeline emits believable mph on clean side-on flights but garbage on the rest (single digits
 * when it loses the ball, an 82 mph decoy when it locks onto the bat/background).
 *
 * The estimator's own confidence (tracker.ts:grade) only widens the error bar; it still shows the
 * number. This gate adds the two signals that actually separate a real flight from a decoy —
 * STRAIGHTNESS (a ball flies near-linear over a few ms) and VELOCITY STABILITY (its px/frame is
 * steady) — plus a plausible-EV band, and returns trust=false so the UI shows no number instead
 * of a wrong one.
 */
export type EvGateInput = {
  n: number; // flight-run detection count (contiguous, forward-moving)
  straightnessPx: number; // RMS of flight centroids off their best-fit line, on the 480x270 grid (lower = straighter)
  dPxMean: number; // mean per-frame px displacement along flight
  dPxStd: number; // std of per-frame px displacement (jitter)
  evMph: number; // the estimator's exit velocity
};
export type EvGate = {
  trust: boolean;
  confidence: 'high' | 'medium' | 'low' | 'none';
  ev: number | null; // the mph to SHOW (null = honest no-read)
  reason: string; // why gated (for logs / the "couldn't read" copy)
};

// Tunable thresholds (calibrated on the 67-clip park set).
export const EV_GATE = {
  MIN_FRAMES: 5, // a few-point track can't be trusted no matter how clean (docs/research/18)
  GOOD_FRAMES: 8,
  MAX_STRAIGHT_PX: 3.5, // real flight is near-linear; a decoy wanders
  MAX_CV: 0.45, // velocity stability = dPxStd/dPxMean; steady flight is low, noise is high
  GOOD_CV: 0.3,
  EV_MIN: 12, // below this is almost always a lost ball / no real flight, not a soft hit
  EV_MAX: 80, // youth tee ceiling; even strong HS hitters top out ~70-78 off a tee, so >80 is a decoy
};

export function gateEv(s: EvGateInput, opts: { evMaxMph?: number } = {}): EvGate {
  const cv = s.dPxMean > 1e-6 ? s.dPxStd / s.dPxMean : 99;
  // The ceiling defaults to the field-validated youth cap, but MUST be raised for
  // older cohorts (session.evCeilingForCohort) — a 17-18/college hitter's real 84-95
  // mph swing is not a decoy, and their cohort bands run above 80.
  const evMax = opts.evMaxMph ?? EV_GATE.EV_MAX;
  const noRead = (reason: string): EvGate => ({ trust: false, confidence: 'none', ev: null, reason });

  if (s.n < EV_GATE.MIN_FRAMES) return noRead(`too few flight frames (${s.n})`);
  if (s.evMph < EV_GATE.EV_MIN) return noRead(`implausibly low (${Math.round(s.evMph)} mph) — likely lost the ball`);
  if (s.evMph > evMax) return noRead(`implausibly high (${Math.round(s.evMph)} mph) — likely a decoy`);
  if (s.straightnessPx > EV_GATE.MAX_STRAIGHT_PX) return noRead(`flight not straight (${s.straightnessPx.toFixed(1)}px off line) — not a ball`);
  if (cv > EV_GATE.MAX_CV) return noRead(`velocity unstable (cv ${cv.toFixed(2)})`);

  // trusted — grade high vs medium on margin
  const strong = s.n >= EV_GATE.GOOD_FRAMES && cv <= EV_GATE.GOOD_CV && s.straightnessPx <= EV_GATE.MAX_STRAIGHT_PX * 0.6;
  return { trust: true, confidence: strong ? 'high' : 'medium', ev: Math.round(s.evMph), reason: 'clean flight' };
}
