# exit-velo-eval

### Hit it off the tee. Get the number. Check the math.

Your kid ropes one off the tee and three people at the fence call three different numbers.
**exit-velo-eval** gets you a real read from a phone video: exit velo, launch angle, projected distance,
and bat speed.

It's the open-source speed engine inside the [Swing Dino](https://swingdino.com) app. Pure
TypeScript. Zero dependencies. No ML model, no cloud call. Every number it makes, you can read the
code that made it.

```js
import { synthSwing, estimateSwingGated } from 'exit-velo-eval/tracker';
import { projectedDistance } from 'exit-velo-eval/session';

const { obs, cal } = synthSwing(62, 18);   // a synthetic 62 mph swing at 18 degrees
const read = estimateSwingGated(obs, cal);
// { ok: true, evMph: 62.0, laDeg: 18.0, confidence: 'medium', ... }
projectedDistance(read.evMph, read.laDeg); // 164 ft
```

Looking for the mechanics side (head, posture, balance, a plain-English report)? That's
[baseball-swing-analysis](https://github.com/rader-ai/baseball-swing-analysis).

---

## Why this exists

**A number you can't check is just a louder guess.**

The tools that settle the fence argument cost real money. A HitTrax runs $8,000 to $19,000 and
lives bolted into a cage. A Pocket Radar is $299 to $399 and needs someone standing there aiming it.
Both are great at what they do. Neither is the phone already in your pocket.

A phone camera sees enough to measure a ball coming off a tee. We wrote that math for Swing Dino,
and then we made a call: **open it.** When a number is going to follow a 10-year-old around a
travel-ball season, the parents and coaches reading it deserve to see exactly how it was made. And
exactly when it wasn't.

So here it is. Read it and argue with it. Then build on it.

## Honest on purpose

This engine would rather tell you nothing than tell you something wrong.

- **"No clean read" is a real answer.** In field testing, a lost ball produced single-digit mph and
  locking onto the bat or background produced a believable 82. The confidence gate
  (`ev-confidence`) throws those out instead of showing them.
- **Trend tracker, not a radar gun.** The target is within a few mph of a radar, off a tee, in good
  light. One huge reading on a Tuesday tells you less than a month of steady ones, so the stats
  are built around consistency and guarded personal records. Some of those thresholds are still
  estimates waiting on radar-paired data; the code says which.
- **Distance is projected, and says so.** It's a physics model on the measured exit velo and launch angle
  (sea-level air, no wind), not a tape measure.
- **Age-aware norms, as ranges.** "Good for a 12-year-old" comes back as a coarse band, flagged
  when it's an estimate (every baseball band is), and tee-ball ages get no band at all, because there's no credible data to build one on.

## How it works, in plain terms

1. **Find the ball.** Each video frame is shrunk to a small grayscale grid. The detector looks for
   a bright round thing moving the right way, and works to reject the bat and the net. When it
   can't, the check in step 4 catches it. No neural net, just fast classic image math, built to
   finish each frame in about 4 ms.
2. **Use the ball as a ruler.** A ball looks bigger when it's closer. Since we know how big a
   baseball or softball really is, its size in each frame tells us how far away it is. That turns
   pixels into feet.
3. **Fit the flight.** Positions over real camera timestamps give speed and angle, with fixes for
   camera angle and the way phone sensors read each frame top to bottom.
4. **Check the read.** Too few frames, a crooked path, or physics that don't add up means no number.

## What's inside

| Area | Modules | Does |
|---|---|---|
| Ball detection | `detector` | One small frame in, at most one ball out |
| Flight to exit velo and launch angle | `tracker`, `camera-format`, `ball-spec` | The ball-as-ruler fit, lens and camera-angle correction |
| Trust gate | `ev-confidence` | Real number or honest "no read" |
| Distance and stats | `session` | Projected carry, consistency, PR guard, age-band norms |
| Live capture | `capture-pipeline`, `swing-segmenter` | Frame stream to per-swing results |
| Bat | `bat-detector`, `bat-tracker` | Bat speed estimate |

Import any module by path: `exit-velo-eval/<module>`.

## Build something with it

- A team tool for ranking a lineup off one phone on a stand
- A progress tracker that shows a kid's month, not just their best day
- Sports-science projects that need an auditable measurement pipeline
- A backyard setup on an old phone and a tripod

You bring the camera frames. The engine brings the math.

## Develop

Needs Node 22.18 or newer (it runs TypeScript directly).

```bash
npm ci
npm test          # 72 tests on synthetic swings, no footage needed
npm run typecheck
npm run build     # dist/ with JS and type definitions
npm run bench     # detector speed per frame
```

Issues and pull requests welcome. Bug reports with a clear setup description (distance, angle,
light, ball type) are the most useful kind.

## What's not in here

- **No footage.** Every test builds its swings in code. No real kids, no real video.
- **No capture code.** The camera side is platform work you plug in.
- **No remote tuning.** The defaults match what the app ships today. The app can adjust some of
  them remotely, so its values may drift from these over time.

Code comments cite `docs/research/NN`. Those are our internal validation notes and aren't
published; the comment always states the finding it relies on.

## Want it without writing code?

That's [Swing Dino](https://swingdino.com): this engine in an iPhone app, with a dino that loses
its mind over a new PR. Get a number on every swing this weekend. Join the beta at
[swingdino.com/beta](https://swingdino.com/beta).

## License

MIT. Use it and ship it.
