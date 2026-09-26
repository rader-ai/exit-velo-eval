/**
 * session.test.ts — coverage for the measurement/stat engine that the 2026-06-12
 * audit (docs/research/12-measurement-audit-2026-06-12.md) touched: the robust
 * SD's MAD=0 fallback and the MDC95-gated PR guard. Pure logic, runs under
 * `node --test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { robustSD, isVerifiedPR, tightnessScore, computeStats, scoutingReport, swingTrend, SEM_MEAS_MPH, evReadout, confidentBest, type Swing } from './session.ts';

const sw = (mph: number, angle: number): Swing => ({ mph, angle, distance: 0 });

// ── robustSD ──
test('robustSD is 0 for fewer than two swings', () => {
  assert.equal(robustSD([]), 0);
  assert.equal(robustSD([72]), 0);
});

test('robustSD = 0 only when every reading is identical (genuine zero spread)', () => {
  assert.equal(robustSD([70, 70, 70, 70]), 0);
});

test('robustSD uses 1.4826·MAD on a normal spread', () => {
  // devs from median 70: [2,1,0,1,2] → MAD = 1 → 1.4826
  const sd = robustSD([68, 69, 70, 71, 72]);
  assert.ok(Math.abs(sd - 1.4826) < 1e-9, `got ${sd}`);
});

test('MAD=0 fallback: identical median + real outliers no longer reads as a perfect ±0', () => {
  // 5 of 7 readings are 70 → MAD (median of |dev|) = 0, but two 80s are real spread.
  const mphs = [70, 70, 70, 70, 70, 80, 80];
  const sd = robustSD(mphs);
  assert.ok(sd > 0, `MAD=0 with outliers must not read 0 (got ${sd})`);
  // fallback = 1.2533 · mean|dev|; mean|dev| = (0*5 + 10*2)/7 = 2.857...
  assert.ok(Math.abs(sd - 1.2533 * (20 / 7)) < 1e-9, `got ${sd}`);
});

test('the MAD=0 fallback makes a noisy session read less tight than a truly tight one', () => {
  const tightAllSame = tightnessScore(robustSD([70, 70, 70, 70, 70, 70])); // 100
  const noisyMad0 = tightnessScore(robustSD([70, 70, 70, 70, 85, 85])); // MAD=0 but spread
  assert.equal(tightAllSame, 100);
  assert.ok(noisyMad0 < tightAllSame, `noisy ${noisyMad0} should be < tight ${tightAllSame}`);
});

// ── isVerifiedPR (MDC95 gate) ──
test('the first record counts once there is any positive swing', () => {
  assert.ok(isVerifiedPR(55, 0));
  assert.ok(!isVerifiedPR(0, 0));
});

test('a new best must clear MDC95 (2.77·SEM) over the old PR — noise does not count', () => {
  const mdc95 = 2.77 * SEM_MEAS_MPH; // 5.54 mph
  assert.ok(!isVerifiedPR(72 + mdc95 - 0.1, 72), 'within noise is not a PR');
  assert.ok(isVerifiedPR(72 + mdc95, 72), 'clearing MDC95 is a PR');
  assert.ok(isVerifiedPR(72 + mdc95 + 3, 72));
});

// ── computeStats: modal contact + re-film guard ──
test('contact is the MODAL bucket, not the descriptor of the mean angle', () => {
  // 6 grounders (4°) + 4 pop-ups (42°): mean angle ≈ 19° → the OLD code read
  // "Line drives"; the modal bucket is correctly "Grounders".
  const swings = [...Array(6)].map(() => sw(70, 4)).concat([...Array(4)].map(() => sw(70, 42)));
  const stats = computeStats(swings);
  assert.equal(stats.contact, 'Grounders');
  assert.notEqual(stats.contact, 'Line drives');
});

test('a clean session does not flag a re-film; a heavily-contaminated one does', () => {
  const clean = [70, 71, 70, 69, 70, 71, 70, 69].map((m) => sw(m, 15));
  assert.equal(computeStats(clean).needsRefilm, false);
  // 6 tight swings + 4 deep mishits → >30% dropped by the one-sided filter
  const noisy = [70, 71, 70, 69, 70, 71].map((m) => sw(m, 15)).concat([20, 20, 20, 20].map((m) => sw(m, 15)));
  const stats = computeStats(noisy);
  assert.ok(stats.excludedCount >= 4, `dropped ${stats.excludedCount}`);
  assert.equal(stats.needsRefilm, true);
  assert.equal(stats.tightnessBand, 'low', 'a re-film session suppresses the consistency band');
});

test('the Scouting Report leads with an honest re-film nudge when the session is too noisy', () => {
  const noisy = [70, 71, 70, 69, 70, 71].map((m) => sw(m, 15)).concat([20, 20, 20, 20].map((m) => sw(m, 15)));
  const report = scoutingReport(computeStats(noisy));
  assert.match(report.reads[0], /[Rr]e-film/);
  assert.match(report.focus, /[Rr]e-film/);
});

// ── swingTrend (significance-gated, never one-swing-vs-one-swing) ──
test('swingTrend needs enough swings and ignores within-noise drift', () => {
  assert.equal(swingTrend([70, 75]), 'steady'); // too few
  assert.equal(swingTrend([70, 71, 69, 70, 71, 69]), 'steady'); // flat
  assert.equal(swingTrend([68, 69, 70, 71, 72, 71]), 'steady'); // ~2 mph drift is within noise
});

test('swingTrend calls a real, noise-clearing gain "up"', () => {
  assert.equal(swingTrend([60, 60, 60, 75, 75, 75]), 'up');
});

test('swingTrend would NOT fire on the old one-swing-vs-one-swing case', () => {
  // last ≥ first but the halves are identical — the old code said "up", we say steady
  assert.equal(swingTrend([70, 60, 60, 60, 60, 71]), 'steady');
});

test('swingTrend false-positive rate on pure noise stays near the 5% it claims (audit doc 34)', () => {
  // A real hitter's swing-to-swing spread is 4-9 mph, far above the 2 mph measurement SEM.
  // Gating on the SEM alone called "up" ~25% of the time at a 6 mph spread. Deterministic
  // LCG so the test is reproducible; Box-Muller for ~N(0,1).
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const gauss = () => { let u = 0; while (u === 0) u = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()); };
  for (const sigma of [3, 6, 9]) for (const n of [6, 8, 12]) {
    let up = 0;
    const trials = 4000;
    for (let k = 0; k < trials; k++) {
      const xs = Array.from({ length: n }, () => Math.round(55 + sigma * gauss()));
      if (swingTrend(xs) === 'up') up++;
    }
    const rate = up / trials;
    assert.ok(rate <= 0.08, `sigma=${sigma} n=${n}: ${(rate * 100).toFixed(1)}% of pure-noise sets called "up"`);
  }
});

test('swingTrend still calls a real gain that clears the hitter\'s own spread', () => {
  // ~6 mph spread, then a genuine +10 mph step: the later half clearly beats the earlier one
  assert.equal(swingTrend([50, 56, 47, 53, 49, 55, 60, 66, 57, 63, 59, 65]), 'up');
});

test('evReadout: legacy swings (no conf) read solid; medium/low qualify', () => {
  assert.deepEqual(evReadout({ mph: 60, angle: 20, distance: 100 }), { mph: 60, rough: false, weak: false });
  assert.deepEqual(evReadout({ mph: 60, angle: 20, distance: 100, conf: 'high' }), { mph: 60, rough: false, weak: false });
  assert.deepEqual(evReadout({ mph: 60, angle: 20, distance: 100, conf: 'medium' }), { mph: 60, rough: true, weak: false });
  assert.deepEqual(evReadout({ mph: 60, angle: 20, distance: 100, conf: 'low' }), { mph: 60, rough: true, weak: true });
});

test('confidentBest: a noisy low-conf read cannot crown the best', () => {
  const swings = [
    { mph: 58, angle: 20, distance: 100, conf: 'high' as const },
    { mph: 91, angle: 20, distance: 100, conf: 'low' as const }, // outlier, must not win
    { mph: 62, angle: 20, distance: 100, conf: 'medium' as const },
  ];
  assert.equal(confidentBest(swings), 62);
  // but if every read is low-conf, fall back rather than show nothing
  assert.equal(confidentBest([{ mph: 40, angle: 20, distance: 100, conf: 'low' as const }]), 40);
});

/* ------------------------------------- 2026-07-02 audit fixes ------- */

import { projectedDistance, evCeilingForCohort } from './session.ts';

test('projected distance has no cliff at the spin turn-on (~45 mph)', () => {
  // The assumed backspin used to switch on as a step at 45 mph, jumping the
  // distance ~10 ft for a 0.4 mph EV change — right in the 8-12yo range that
  // feeds a home-run fence. It must ramp in smoothly.
  for (const la of [12, 20, 28]) {
    const below = projectedDistance(44.8, la);
    const above = projectedDistance(45.2, la);
    assert.ok(
      Math.abs(above - below) <= 3,
      `LA ${la}°: ${below}ft -> ${above}ft jumps ${Math.abs(above - below)}ft across 45mph`,
    );
  }
});

test('projected distance is monotonic in EV through the spin ramp', () => {
  for (const la of [12, 20, 28]) {
    let prev = 0;
    for (let ev = 35; ev <= 55; ev += 1) {
      const d = projectedDistance(ev, la);
      assert.ok(d >= prev, `LA ${la}°: distance fell ${prev}->${d} at ${ev}mph`);
      prev = d;
    }
  }
});

test('evCeilingForCohort scales the trust ceiling with the cohort', () => {
  // Youth default stays at the field-validated 80; older cohorts must not have
  // their real swings branded "decoys" (17-18 elite is 84, college 92).
  assert.equal(evCeilingForCohort('baseball', 'teeball'), 80);
  assert.equal(evCeilingForCohort('baseball', 'unknown-cohort'), 80);
  assert.ok(evCeilingForCohort('baseball', '17-18') >= 92);
  assert.ok(evCeilingForCohort('baseball', 'college') >= 100);
  assert.ok(evCeilingForCohort('softball', 'college') >= 78);
});
