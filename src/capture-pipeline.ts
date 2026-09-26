/**
 * capture-pipeline.ts — the boundary between the camera and the measurement engine.
 *
 * The native frame source (a VisionCamera frame processor, see
 * docs/research/10-camera-detector-native.md) hands us ONE small downscaled
 * luma plane per frame via `onFrame(luma, t)`. We detect the ball, segment
 * swings, measure, and emit finished results — then the frame is gone.
 *
 * THE CONTRACT (privacy + memory — non-negotiable):
 *  1. `onFrame` receives a transient, downscaled luma buffer owned by the
 *     caller. We read it and DO NOT retain it. The full-res frame never reaches
 *     JS and is recycled by the OS capture pool.
 *  2. No frame, clip, or image is ever stored, copied to a growing structure,
 *     or sent over the network. Only the numbers (a measured Swing) leave here.
 *  3. All buffers are pre-allocated and fixed-size (see BallDetector /
 *     SwingSegmenter). Steady-state per-frame allocation is ~zero, so there is
 *     no leak vector and no unbounded RAM growth, regardless of session length.
 */

import { BallDetector, type DetectorConfig } from './detector.ts';
import { projectedDistance, type Ball, type Swing } from './session.ts';
import { SwingSegmenter, type SegmenterConfig } from './swing-segmenter.ts';
import { type Calibration, type TrackResult } from './tracker.ts';

export type CaptureCallbacks = {
  /** Fired when a swing is measured and passed the gates — the only output. */
  onSwing: (swing: Swing, result: TrackResult) => void;
  /** Optional: a swing was detected but rejected (too few frames / implausible). */
  onRejected?: (result: TrackResult | null) => void;
};

export class CapturePipeline {
  private readonly detector: BallDetector;
  private readonly segmenter: SwingSegmenter;
  private readonly ball: Ball;
  private readonly cb: CaptureCallbacks;

  constructor(opts: {
    ball: Ball;
    cal: Calibration;
    width: number;
    height: number;
    detector?: Partial<DetectorConfig>;
    segmenter?: Partial<SegmenterConfig>;
    callbacks: CaptureCallbacks;
  }) {
    this.ball = opts.ball;
    this.cb = opts.callbacks;
    this.detector = new BallDetector({ width: opts.width, height: opts.height, ...opts.detector });
    this.segmenter = new SwingSegmenter(opts.cal, opts.segmenter);
  }

  /** Start/restart a session (drops all transient state). */
  start() {
    this.detector.reset();
    this.segmenter.reset();
  }

  /**
   * Process one downscaled luma frame. `t` = presentation time (s). The buffer
   * is NOT retained past this call. Returns the measured swing if one completed
   * on this frame (also delivered via the onSwing callback), else null.
   */
  onFrame(luma: Uint8Array, t: number): Swing | null {
    const obs = this.detector.detect(luma, t);
    const result = this.segmenter.push(obs);
    if (!result) return null;
    if (!result.ok) {
      this.cb.onRejected?.(result);
      return null;
    }
    const swing: Swing = {
      mph: Math.round(result.evMph),
      angle: Math.round(result.laDeg),
      distance: projectedDistance(result.evMph, result.laDeg, this.ball),
      conf: result.confidence,
    };
    this.cb.onSwing(swing, result);
    return swing;
  }

  /** Live counters for the session UI (bounded — no buffers). */
  get stats() {
    return { measured: this.segmenter.swingsMeasured, rejected: this.segmenter.swingsRejected };
  }
}
