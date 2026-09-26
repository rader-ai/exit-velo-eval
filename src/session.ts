/**
 * Session model + the measurement/calculation engine.
 *
 * The formulas here are the SHIP versions validated in
 * docs/research/07-measurement-calculation-engine.md (and the Monte-Carlo sims
 * in docs/research/sims/). The camera/CV front-end is still mocked — these are
 * the calculations that turn an (exit velo, launch angle) reading into the
 * distance, consistency, PR, and "good/bad" numbers we present.
 *
 * Honesty rails baked in:
 *  - Consistency uses an ABSOLUTE robust SD (never CV — CV unfairly brands
 *    young/slow hitters), surfaced only as coarse Tight/Steady/Loose bands.
 *  - Personal records are gated by MDC95 so measurement noise can't fake them.
 *  - Distance is a projected estimate with a low-confidence flag at low launch.
 */

export type Ball = 'baseball' | 'softball';

export type SwingConfidence = 'high' | 'medium' | 'low';
export type Swing = { mph: number; angle: number; distance: number; conf?: SwingConfidence };

/**
 * How to present a swing's EV given its measurement confidence — the UI half of
 * the app's "honest coach, never a silent bad number" rule. Legacy/seed swings
 * predate the flag, so an absent `conf` is treated as a solid (high) read.
 *   rough — show it qualified ("~", wider band): a short/medium-quality track
 *   weak  — de-emphasize; don't let it crown a best or headline a recap
 */
export function evReadout(s: Swing): { mph: number; rough: boolean; weak: boolean } {
  const conf = s.conf ?? 'high';
  return { mph: s.mph, rough: conf !== 'high', weak: conf === 'low' };
}

/** Session best from confident swings only — a noisy low-conf read shouldn't crown
 *  a PR or headline a recap. Falls back to all swings if none are confident. */
export function confidentBest(swings: Swing[]): number {
  const solid = swings.filter((s) => (s.conf ?? 'high') !== 'low');
  const pool = solid.length ? solid : swings;
  return pool.reduce((m, s) => Math.max(m, s.mph), 0);
}

/** Turn an estimator failure reason into one short, fixable coaching line — what
 *  to DO next, not a stack trace. Keyed off the reasons in tracker.estimateSwing. */
export function noReadCoach(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes('flight frames') || r.includes('too few')) return 'Give the ball more room to fly — and good, even light.';
  if (r.includes('exit velo') || r.includes('launch angle') || r.includes('tracking')) return 'Looked like a tracking glitch — take another cut.';
  return 'Stand square to the side so the ball flies across the screen.';
}

export type TightnessBand = 'green' | 'yellow' | 'red' | 'low';

export type SessionStats = {
  count: number;
  best: number; // ungated session best (fun) — the trophy PR is gated separately
  avg: number;
  consistency: number; // 0–100 Tightness score (display only as a band)
  spreadMph: number; // H = robust SD σ_R, "swings clustered within ±H mph"
  tightnessBand: TightnessBand;
  topDistance: number;
  avgAngle: number;
  contact: string; // MODAL contact bucket (per-swing), not the descriptor of the mean angle
  excludedCount: number; // swings dropped by the one-sided mishit filter
  needsRefilm: boolean; // >30% excluded — too contaminated to read; prompt a re-film
};

/* ----------------------------------------------------- physical constants */

const BALLS: Record<Ball, { d: number; m: number; spinCap: number }> = {
  // diameter (m), mass (kg), assumed-backspin cap (rpm)
  baseball: { d: 0.073, m: 0.145, spinCap: 2600 },
  softball: { d: 0.097, m: 0.19, spinCap: 1600 },
};

const G = 9.81;
const RHO = 1.225; // sea-level standard air density (kg/m³)
const MPH_TO_MS = 0.44704;
const M_TO_FT = 3.28084;

/**
 * Projected carry distance (ft) via the validated RK4 drag + Magnus integrator
 * (spec §4.1). Backspin is ASSUMED from launch angle (never measured) and
 * suppressed for tee-ball-speed contact. Works across the full age range,
 * unlike the adult-only quadratic surrogate.
 */
export function projectedDistance(evMph: number, laDeg: number, ball: Ball = 'baseball'): number {
  if (evMph <= 0) return 0;
  const { d, m, spinCap } = BALLS[ball];
  const R = d / 2;
  const A = Math.PI * R * R;
  const K = (0.5 * RHO * A) / m;
  const Cd0 = 0.315;
  const cD = 0.3;
  const h0 = 0.9; // contact height (m)
  const dt = 0.002;

  // assumed backspin (rad/s); lift fades in across 40–50 mph (near-vacuum tee regime
  // below) so distance stays CONTINUOUS in EV — a hard step at 45 put a ~10 ft cliff
  // right in the 8–12yo range and could flip a home-run call on noise.
  const spinRamp = Math.min(Math.max((evMph - 40) / 10, 0), 1);
  const omegaRpm = spinRamp * Math.min(Math.max(800 + 55 * laDeg, 500), spinCap);
  const omega = (omegaRpm * 2 * Math.PI) / 60;

  const v0 = evMph * MPH_TO_MS;
  const la = (laDeg * Math.PI) / 180;

  // deriv of state [x, y, vx, vy]
  const deriv = (s: number[]): number[] => {
    const vx = s[2];
    const vy = s[3];
    const v = Math.hypot(vx, vy) || 1e-6;
    const S = (R * omega) / v; // spin parameter
    const CdEff = Cd0 + cD * S;
    const Cl = omegaRpm === 0 ? 0 : S < 0.1 ? 1.5 * S : 0.09 + 0.6 * S;
    const aDragX = -K * CdEff * v * vx;
    const aDragY = -K * CdEff * v * vy;
    const aLift = K * Cl * v * v; // perpendicular to velocity, up-and-back for backspin
    const lx = -vy / v;
    const ly = vx / v;
    return [vx, vy, aDragX + aLift * lx, aDragY + aLift * ly - G];
  };

  let s = [0, h0, v0 * Math.cos(la), v0 * Math.sin(la)];
  for (let i = 0; i < 6000 && s[1] > 0; i++) {
    const k1 = deriv(s);
    const k2 = deriv(s.map((v, j) => v + (dt / 2) * k1[j]));
    const k3 = deriv(s.map((v, j) => v + (dt / 2) * k2[j]));
    const k4 = deriv(s.map((v, j) => v + dt * k3[j]));
    const next = s.map((v, j) => v + (dt / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
    if (next[1] <= 0) {
      const frac = s[1] / (s[1] - next[1]); // interpolate to ground (y=0)
      return Math.max(0, Math.round((s[0] + (next[0] - s[0]) * frac) * M_TO_FT));
    }
    s = next;
  }
  return Math.max(0, Math.round(s[0] * M_TO_FT));
}

/** Is the projected distance trustworthy enough to feature? Low launch over-predicts.
 *  (Distance is de-emphasized in the product — kept for optional/backlog use.) */
export function distanceConfidence(laDeg: number): 'ok' | 'low' {
  return laDeg < 8 || laDeg > 40 ? 'low' : 'ok';
}

/** Reframe launch angle as CONTACT feedback (the product axis), not distance. */
export function launchDescriptor(laDeg: number): string {
  if (laDeg < 8) return 'Grounders';
  if (laDeg < 22) return 'Line drives';
  if (laDeg < 38) return 'Fly balls';
  return 'Pop-ups';
}

/* ------------------------------------------------------- swing generation */

/** Playful, clamped mock swing — distance via the real integrator. */
export function randomSwing(): Swing {
  const mph = Math.round(48 + Math.random() * 34); // 48–82
  const angle = Math.round(8 + Math.random() * 28); // 8–36°
  return { mph, angle, distance: projectedDistance(mph, angle) };
}

/* ------------------------------------------------------- robust statistics */

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Intra-session robust SD (σ_R = 1.4826·MAD) — resistant to mishits. */
export function robustSD(mphs: number[]): number {
  if (mphs.length < 2) return 0;
  const M = median(mphs);
  const devs = mphs.map((x) => Math.abs(x - M));
  const MAD = median(devs);
  if (MAD > 0) return 1.4826 * MAD;
  // MAD = 0 means ≥half the readings equal the median — common with integer mph
  // and a few real outliers. Fall back to the mean-absolute-deviation scale
  // (1.2533·mean|dev|, consistent with σ for normal data) so genuine spread in
  // the tails still registers instead of reading as a falsely-perfect "±0".
  return 1.2533 * mean(devs);
}

const TIGHTNESS_K = 6; // ESTIMATE — tune on real data (spec §5.3)
const MIN_CLEAN_SWINGS = 8; // need ≥8 clean swings for any consistency read

/** 0–100 Tightness score from robust SD. Show only as a band, never precise. */
export function tightnessScore(sigmaR: number): number {
  return Math.round(100 * Math.exp(-sigmaR / TIGHTNESS_K));
}

export function tightnessBand(score: number, nClean: number): TightnessBand {
  if (nClean < MIN_CLEAN_SWINGS) return 'low';
  if (score >= 67) return 'green';
  if (score >= 34) return 'yellow';
  return 'red';
}

/** Coarse, honest consistency label for the UI. */
export function consistencyLabel(band: TightnessBand): string {
  return band === 'green' ? 'Tight' : band === 'yellow' ? 'Steady' : band === 'red' ? 'Loose' : '—';
}

/** Sample SD (n−1). 0 for fewer than 2 values. */
function sampleSD(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
}

/** One-sided 95% Student-t critical value by degrees of freedom (small-sample honest). */
function tCrit95(df: number): number {
  const table: [number, number][] = [
    [1, 6.31], [2, 2.92], [3, 2.35], [4, 2.13], [5, 2.02], [6, 1.94], [7, 1.89], [8, 1.86],
    [9, 1.83], [10, 1.81], [12, 1.78], [15, 1.75], [20, 1.72], [30, 1.70],
  ];
  for (const [d, t] of table) if (df <= d) return t;
  return 1.645;
}

/**
 * Honest recent-form trend (spec §8.3). Compares the MEAN of the earlier half
 * of the recent swings to the MEAN of the later half, and only calls it "up"
 * when the gain clears the noise — never one swing vs one swing (which reads as
 * progress >50% of the time on pure noise). `mphs` must be oldest→newest.
 *
 * The noise is the HITTER'S OWN swing-to-swing spread (a two-sample t-test on the
 * pooled within-half SD), floored at the measurement SEM. The earlier version used
 * the 2 mph measurement SEM alone, which ignores the far larger swing-to-swing
 * variability of a real hitter: with a typical youth spread of 6 mph it called
 * "up" on pure noise ~25% of the time (audit 2026-09-05, docs/research/34).
 */
export function swingTrend(mphs: number[]): 'up' | 'steady' {
  if (mphs.length < 6) return 'steady'; // need ≥3 per half to mean anything
  const mid = Math.floor(mphs.length / 2);
  const first = mphs.slice(0, mid);
  const second = mphs.slice(mphs.length - mid);
  const n1 = first.length, n2 = second.length;
  const df = n1 + n2 - 2;
  // pooled within-half spread — the hitter's own repeatability, which already
  // contains the measurement noise; the SEM is only a floor for degenerate spreads
  const s1 = sampleSD(first), s2 = sampleSD(second);
  const pooled = Math.sqrt(((n1 - 1) * s1 * s1 + (n2 - 1) * s2 * s2) / df);
  const spread = Math.max(pooled, SEM_MEAS_MPH);
  const se = spread * Math.sqrt(1 / n1 + 1 / n2);
  const threshold = Math.max(1, tCrit95(df) * se); // one-sided 95%, SWC floor 1 mph
  return mean(second) - mean(first) > threshold ? 'up' : 'steady';
}

/* ----------------------------------------------------- personal-record guard */

/**
 * Measurement SEM in mph. ESTIMATE — MUST be replaced with a value measured
 * against a reference radar before any public accuracy claim (spec Appendix B).
 * It is condition/speed dependent in reality; this constant is a placeholder.
 */
export const SEM_MEAS_MPH = 2;

/** A record only counts if it clears measurement noise (MDC95 = 2.77·SEM). */
export function isVerifiedPR(newBest: number, oldPR: number): boolean {
  const MDC95 = 2.77 * SEM_MEAS_MPH;
  return oldPR <= 0 ? newBest > 0 : newBest >= oldPR + MDC95;
}

/* ------------------------------------------------------- normative bands */

// Encouraging, no-ceiling labels — never a deficiency verdict ('Below') or a
// "where you should be" schedule ('On-Track'). Rendered only as a hedged rough guide.
export type NormativeBand = 'Building' | 'Solid' | 'Strong' | 'Crushing';

/**
 * Tee-work exit-velo bands (mph) by cohort — coarse buckets only.
 * { onTrack, good, elite }: <onTrack=Building, [onTrack,good)=Solid, [good,elite)=Strong, >=elite=Crushing.
 *
 * GROUNDED, not invented (see docs/research/youth-exit-velo-norms.md):
 *  - SOFTBALL is the firm ground — Rapsodo/NFCA (20M+ batted balls) publishes
 *    primary, tee-native, cohort-AVERAGE exit velo: the exact metric we band on.
 *    HS/college are 'solid'; 10-12U is softened ('estimated') because its 10U floor
 *    extrapolates below Rapsodo's youngest credible 11-12U cohort.
 *  - BASEBALL has no primary tee-average dataset. Bands anchor to Driveline's measured
 *    front-toss/machine averages MINUS a conservative ~6–8 mph tee haircut (justified by
 *    Nathan's collision model EV = 0.2·pitch + 1.2·bat — a tee carries no pitch energy),
 *    held below the bat-speed→EV ceiling and set on session-AVERAGE, not a best rep. All
 *    baseball bands are 'estimated' and intentionally under-claimed (better to under-claim
 *    than tell a normal kid they're "Below"). The popular online "tee-work" youth charts
 *    are inflated MAX values and were deliberately NOT used at face value.
 *  - Ages 4–7 have ZERO credible exit-velo data anywhere, so there is deliberately NO
 *    cohort for them — normativeBand returns null and the card shows no comparison.
 */
export type BandConfidence = 'estimated' | 'solid';
type CohortNorm = { onTrack: number; good: number; elite: number; confidence: BandConfidence };

const COHORTS: Record<Ball, Record<string, CohortNorm>> = {
  baseball: {
    '8-10': { onTrack: 30, good: 38, elite: 45, confidence: 'estimated' },
    '11-12': { onTrack: 39, good: 47, elite: 54, confidence: 'estimated' },
    '13-14': { onTrack: 46, good: 55, elite: 63, confidence: 'estimated' },
    '15-16': { onTrack: 57, good: 67, elite: 75, confidence: 'estimated' },
    '17-18': { onTrack: 65, good: 76, elite: 84, confidence: 'estimated' },
    college: { onTrack: 74, good: 84, elite: 92, confidence: 'estimated' },
  },
  softball: {
    '10-12': { onTrack: 50, good: 55, elite: 60, confidence: 'estimated' },
    '13-14': { onTrack: 55, good: 60, elite: 64, confidence: 'solid' },
    '15-16': { onTrack: 58, good: 63, elite: 67, confidence: 'solid' },
    '17-18': { onTrack: 60, good: 65, elite: 69, confidence: 'solid' },
    college: { onTrack: 61, good: 66, elite: 70, confidence: 'solid' },
  },
};

/** Bucket a SESSION-AVERAGE exit velo (never a single swing) into a coarse band.
 *  Returns null for cohorts we have no credible data for (e.g. tee-ball 4–7). */
export function normativeBand(avgEv: number, ball: Ball, cohort: string): NormativeBand | null {
  const t = COHORTS[ball]?.[cohort];
  if (!t) return null;
  if (avgEv >= t.elite) return 'Crushing';
  if (avgEv >= t.good) return 'Strong';
  if (avgEv >= t.onTrack) return 'Solid';
  return 'Building';
}

/** Whether a cohort's band is a conservative ESTIMATE (UI shows an "estimated" qualifier)
 *  vs. solid primary data. Unknown cohorts count as estimated. */
export function cohortIsEstimated(ball: Ball, cohort: string): boolean {
  return COHORTS[ball]?.[cohort]?.confidence !== 'solid';
}

/** Trust ceiling (mph) for the EV gate, by cohort: the field-validated youth cap
 *  unless the cohort's elite band exceeds it — then elite + headroom, so a real
 *  17-18/college swing can't be branded a "decoy" by its own cohort's norms.
 *  `caps` is remote-tunable (lib/tuning.ts); defaults are the shipped values. */
export function evCeilingForCohort(
  ball: Ball,
  cohort: string,
  caps: { youthCapMph: number; eliteHeadroomMph: number } = { youthCapMph: 80, eliteHeadroomMph: 10 },
): number {
  const t = COHORTS[ball]?.[cohort];
  return t ? Math.max(caps.youthCapMph, t.elite + caps.eliteHeadroomMph) : caps.youthCapMph;
}

/** The cohort's exit-velo reference band (onTrack/good/elite mph), or null for cohorts
 *  we have no credible data for (tee-ball 4–7). Single source of truth for anything
 *  age-scaled — e.g. an age-appropriate home-run fence reads `good` off this. */
export function cohortNorm(ball: Ball, cohort: string): { onTrack: number; good: number; elite: number } | null {
  const t = COHORTS[ball]?.[cohort];
  return t ? { onTrack: t.onTrack, good: t.good, elite: t.elite } : null;
}

/* --------------------------------------------------------- session stats */

export function computeStats(swings: Swing[]): SessionStats {
  if (swings.length === 0) {
    return { count: 0, best: 0, avg: 0, consistency: 100, spreadMph: 0, tightnessBand: 'low', topDistance: 0, avgAngle: 0, contact: 'Line drives', excludedCount: 0, needsRefilm: false };
  }
  const mphs = swings.map((s) => s.mph);
  const best = Math.max(...mphs);
  const avg = Math.round(mean(mphs));

  // one-sided mishit filter for consistency: drop the low tail only, never the high side
  const M = median(mphs);
  const sigmaAll = robustSD(mphs);
  const clean = sigmaAll > 0 ? mphs.filter((x) => x >= M - 2.5 * sigmaAll) : mphs;
  const sigmaR = robustSD(clean);
  const score = tightnessScore(sigmaR);

  // re-film guard (spec §5.2): if the mishit filter drops more than ~30% of the
  // swings, the session is too contaminated to read — suppress the band.
  const excludedCount = mphs.length - clean.length;
  const needsRefilm = mphs.length >= 4 && excludedCount / mphs.length > 0.3;
  const band = needsRefilm ? 'low' : tightnessBand(score, clean.length);

  // MODAL contact bucket from per-swing launch — NOT launchDescriptor(meanAngle),
  // which averages a grounders+pop-ups session into a false "Line drives".
  const counts = new Map<string, number>();
  for (const s of swings) counts.set(launchDescriptor(s.angle), (counts.get(launchDescriptor(s.angle)) ?? 0) + 1);
  let contact = 'Line drives';
  let bestN = -1;
  for (const [bucket, n] of counts) if (n > bestN) { bestN = n; contact = bucket; }

  return {
    count: swings.length,
    best,
    avg,
    consistency: score,
    spreadMph: Math.round(sigmaR * 10) / 10,
    tightnessBand: band,
    topDistance: Math.max(...swings.map((s) => s.distance)),
    avgAngle: Math.round(mean(swings.map((s) => s.angle))),
    contact,
    excludedCount,
    needsRefilm,
  };
}

/* ------------------------------------ the quiet "Scouting Report" insights */

/**
 * The coach's read on the session — warm, plain-language, honest-coach voice,
 * ending in ONE thing to work on. Speaks in CONTACT TYPE (grounder/line-drive/
 * fly/pop), never raw launch-angle degrees, and only about what we actually
 * measured (speed spread, ceiling-vs-typical, contact type). No fabricated
 * biomechanics — that's the whole point vs the "pro lab" data-dump.
 */
export function scoutingReport(stats: SessionStats): { reads: string[]; focus: string } {
  const reads: string[] = [];
  const gap = stats.best - stats.avg;
  const contact = stats.contact; // MODAL contact bucket (per-swing), not the mean angle

  // too-noisy session: lead with an honest re-film nudge instead of a false read
  if (stats.needsRefilm) {
    return {
      reads: [`That set had a lot of off-contact swings — the numbers got noisy. Re-film a clean round in good light and we'll read it right.`],
      focus: `Re-film. Good light, square contact — then we'll call your trends.`,
    };
  }

  // 1) consistency, in plain talk
  reads.push(
    stats.tightnessBand === 'low'
      ? `Give me a few more cuts — ${stats.count} swing${stats.count === 1 ? '' : 's'} isn't enough to call your consistency yet.`
      : stats.tightnessBand === 'green'
        ? `Locked in today — your swings stayed within about ±${stats.spreadMph} mph of each other. That's the good stuff.`
        : stats.tightnessBand === 'yellow'
          ? `Pretty steady — speeds sat within roughly ±${stats.spreadMph} mph. A few more reps and that tightens right up.`
          : `A little all over the map — speeds bounced around ±${stats.spreadMph} mph. Same load, same timing, every rep.`,
  );

  // 2) ceiling vs typical
  reads.push(
    gap >= 12
      ? `The pop is in there: you topped out at ${stats.best} but most sat near ${stats.avg}. Let's make that best one your normal one.`
      : `Your hardest swings sit right next to your typical (${stats.best} vs ${stats.avg}) — you're repeating the good ones.`,
  );

  // 3) contact type — NO raw degrees
  reads.push(
    contact === 'Grounders'
      ? `Lots of grounders — you're getting on top of it. Get a hair under the ball and watch it start to carry.`
      : contact === 'Pop-ups'
        ? `Catching a lot of air (pop-ups) — stay through the ball and those turn into hard line drives.`
        : contact === 'Fly balls'
          ? `Good air under it — nice fly balls. Just keep an eye out for the lazy pop-up.`
          : `Squaring up line drives — that's the best contact there is. Keep doing exactly that.`,
  );

  // ONE thing to work on
  const focus =
    stats.tightnessBand === 'red'
      ? 'Tempo. Same load, same timing, every single rep — repeatable before powerful.'
      : contact === 'Grounders'
        ? 'Contact. Get a hair under it and turn those grounders into line drives.'
        : contact === 'Pop-ups'
          ? 'Stay through it. Trade the pop-ups for hard line drives.'
          : gap >= 14
            ? 'Repeatability. Make your best swing your every swing.'
            : "Go chase a new best — you're dialed in.";

  return { reads, focus };
}

/* ---------------------------------------- a pre-baked session for demo/screens */

export function mockSession(): Swing[] {
  // A believable focused session: clustered high-70s/low-80s (reads "Steady"),
  // a clear 82 best for the PR, and one 68 mishit to exercise the one-sided filter.
  return [
    76, 79, 74, 81, 77, 80, 68, 82, 78, 75, 79, 73, 80, 76, 81, 77, 74, 80, 78, 82, 75, 79, 77, 80,
  ].map((mph) => {
    const angle = Math.round(20 + Math.random() * 12); // ~20–32° solid contact
    return { mph, angle, distance: projectedDistance(mph, angle) };
  });
}
