/**
 * swing-segmenter.ts — turn a continuous observation stream into discrete,
 * measured swings, ignoring the reload/reset dead time.
 *
 * This is the "track only the swings" + "measure-and-discard" logic in pure,
 * testable form. It runs downstream of the detector: each frame yields an
 * observation (or null when no ball is in view), and the segmenter decides when
 * a swing's flight has started, collected enough, and ended — then hands the
 * window to estimateSwing() and emits a finished measurement.
 *
 * MEMORY DISCIPLINE:
 *  - The active-flight buffer is a SINGLE fixed-capacity array, allocated once
 *    and reused. It never grows; if a flight exceeds capacity it finalizes early.
 *  - Between swings the segmenter holds nothing but small counters.
 *  - No history of past swings or frames is retained here (the store owns saved
 *    results); memory is O(maxFlightFrames), not O(session length).
 */

import { estimateSwingGated, type BallObs, type Calibration, type TrackResult } from './tracker.ts';

export type SegmenterConfig = {
  minFlightFrames: number; // need at least this many to measure
  maxFlightFrames: number; // hard cap on the active buffer (finalize if exceeded)
  gapFramesToEnd: number; // this many consecutive empty frames ends a flight
  refractoryFrames: number; // ignore everything this long after a swing (reload/reset)
  evMaxMph?: number; // gate ceiling for the hitter's cohort (session.evCeilingForCohort)
};

export const DEFAULT_SEGMENTER: SegmenterConfig = {
  minFlightFrames: 4,
  maxFlightFrames: 24, // ~100 ms @240fps — well past the measurable window
  gapFramesToEnd: 3,
  refractoryFrames: 480, // ~2 s @240fps — covers re-tee/reset
};

type State = 'idle' | 'tracking' | 'refractory';

export class SwingSegmenter {
  private readonly cfg: SegmenterConfig;
  private readonly cal: Calibration;
  private readonly buf: BallObs[]; // fixed-capacity, reused
  private count = 0;
  private gap = 0;
  private refractory = 0;
  private state: State = 'idle';

  /** Stats for the live UI / debugging — all bounded counters, no buffers. */
  swingsMeasured = 0;
  swingsRejected = 0;

  constructor(cal: Calibration, cfg: Partial<SegmenterConfig> = {}) {
    this.cfg = { ...DEFAULT_SEGMENTER, ...cfg };
    this.cal = cal;
    this.buf = new Array(this.cfg.maxFlightFrames);
  }

  /** Drop all transient state (e.g. on session start/stop). */
  reset() {
    this.count = 0;
    this.gap = 0;
    this.refractory = 0;
    this.state = 'idle';
  }

  /**
   * Feed one frame's observation (or null). Returns a finished measurement on
   * the frame a swing completes, else null. Allocation-free except for the
   * occasional result object on completion.
   */
  push(obs: BallObs | null): TrackResult | null {
    if (this.state === 'refractory') {
      if (--this.refractory <= 0) this.state = 'idle';
      return null;
    }

    if (this.state === 'idle') {
      if (obs) {
        // a ball appeared — start a flight
        this.count = 0;
        this.gap = 0;
        this.buf[this.count++] = obs;
        this.state = 'tracking';
      }
      return null;
    }

    // state === 'tracking'
    if (obs) {
      this.gap = 0;
      if (this.count < this.cfg.maxFlightFrames) {
        this.buf[this.count++] = obs;
      } else {
        return this.finalize(); // buffer full → measure what we have
      }
    } else {
      // ball not seen this frame
      if (++this.gap >= this.cfg.gapFramesToEnd) {
        return this.finalize();
      }
    }
    return null;
  }

  private finalize(): TrackResult | null {
    const n = this.count;
    this.count = 0;
    this.gap = 0;
    this.state = 'refractory';
    this.refractory = this.cfg.refractoryFrames;

    if (n < this.cfg.minFlightFrames) {
      this.swingsRejected++;
      return null;
    }
    // copy the active window out (small, bounded) and measure
    const window = this.buf.slice(0, n);
    const r = estimateSwingGated(window, this.cal, { evMaxMph: this.cfg.evMaxMph });
    if (r.ok) this.swingsMeasured++;
    else this.swingsRejected++;
    return r;
  }
}
