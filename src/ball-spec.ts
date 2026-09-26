/**
 * ball-spec.ts — the ball PRIOR for detection + measurement. Because we ask the hitter's
 * sport (baseball/softball) at onboarding and know their cohort, we KNOW the ball — its
 * real diameter and its color — before we ever go looking for it. That collapses the
 * disambiguation problem (docs/research/13/20/21): expected size fences out wrong-sized
 * blobs, and color fences out the dirt/trees/net for the optic-yellow softball.
 *
 * Softball changes size by division (quoted by circumference):
 *   - 11" softball (≤10U): diameter 11/π in ≈ 0.089 m
 *   - 12" softball (12U+): diameter 12/π in ≈ 0.097 m   ← the existing default
 * Baseball is ~9" circumference ≈ 0.073 m at every youth age.
 *
 * The diameter feeds Calibration.ballDiamM (self-scaling): measuring an 11" ball with a
 * 12" assumption mis-scales EVERY frame → ~9% EV error. The colorMode feeds the detector
 * (luma-only for a sunlit white baseball; an optic-yellow chroma gate for softball).
 */

import type { Sport } from './engine-types.ts';

const IN_TO_M = 0.0254;
const circToDiamM = (circIn: number) => (circIn / Math.PI) * IN_TO_M;

export type BallColor = 'white' | 'optic-yellow';
export type BallKind = 'baseball' | 'softball-11' | 'softball-12';
export type ColorMode = 'luma' | 'optic-yellow';

export type BallSpec = {
  kind: BallKind;
  sport: Sport;
  diameterM: number;
  circumferenceIn: number;
  color: BallColor;
  label: string;
  detect: { colorMode: ColorMode };
};

const BASEBALL: BallSpec = {
  kind: 'baseball', sport: 'baseball', diameterM: 0.073, circumferenceIn: 9,
  color: 'white', label: 'baseball (9")', detect: { colorMode: 'luma' },
};
const SOFTBALL_11: BallSpec = {
  kind: 'softball-11', sport: 'softball', diameterM: circToDiamM(11), circumferenceIn: 11,
  color: 'optic-yellow', label: '11" softball (≤10U)', detect: { colorMode: 'optic-yellow' },
};
const SOFTBALL_12: BallSpec = {
  kind: 'softball-12', sport: 'softball', diameterM: circToDiamM(12), circumferenceIn: 12,
  color: 'optic-yellow', label: '12" softball (12U+)', detect: { colorMode: 'optic-yellow' },
};

/** ≤10U softball cohorts use the 11" ball; everything older uses the 12". */
function softballIsSmall(cohort: string): boolean {
  return cohort === '8-9' || cohort === 'teeball' || /(^|[^0-9])(6|8|10)u/i.test(cohort);
}

/** The ball spec for a hitter's sport + normative cohort (Hitter.sport / Hitter.cohort). */
export function ballSpec(sport: Sport, cohort: string): BallSpec {
  if (sport === 'softball') return softballIsSmall(cohort) ? SOFTBALL_11 : SOFTBALL_12;
  return BASEBALL;
}

/** Spec by kind — for a hitter whose ball was fixed at setup (Hitter.ballKind). */
export function ballSpecForKind(kind: BallKind): BallSpec {
  return kind === 'softball-11' ? SOFTBALL_11 : kind === 'softball-12' ? SOFTBALL_12 : BASEBALL;
}

/** Age-based variant (when you have an age rather than a cohort key). */
export function ballSpecForAge(sport: Sport, age: number): BallSpec {
  if (sport === 'softball') return age <= 10 ? SOFTBALL_11 : SOFTBALL_12;
  return BASEBALL;
}

/** Convenience for Calibration.ballDiamM (the self-scale ruler). */
export function ballDiameterM(sport: Sport, cohort: string): number {
  return ballSpec(sport, cohort).diameterM;
}

/**
 * Is this RGB pixel optic-yellow (a softball)? A SATURATED yellow-green: blue is the
 * smallest channel and low, R+G high. The saturation requirement is what separates the
 * ball from desaturated tan dirt (docs/research/22 — naive RGB-yellow floods on dirt).
 * The native softball path computes the color mask with the same rule from the chroma plane.
 */
export function isOpticYellow(r: number, g: number, b: number): boolean {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const sat = mx > 0 ? (mx - mn) / mx : 0;
  return b === mn && sat >= 0.5 && b <= 95 && g >= 120 && r >= 80;
}
