# How exit-velo-eval came to be

Our first three real test sessions measured zero swings. Later, a park test read one swing at 82
mph because the detector had locked onto the bat.

This is the engine behind Swing Dino's speed number, and the story of how it got built: what we
tried, what broke, and what we still haven't proven. We're telling it because the failures are
the most useful part.

## The itch

Swing Dino started with Chris Rader, who has coached youth baseball and softball for years, and a
problem every family at a backyard tee runs into. The tools that measure a swing either cost real
money (a Pocket Radar is $299 to $399, a HitTrax rig $8,000 to $19,000) or live in a facility, and
at least one phone app was reading 8 to 10 mph high against a lab system. A number that feels good
isn't the same as a number that's true.

The first design spec, dated June 3, 2026, set the rule this whole repo still follows: **optimize
for repeatability over absolute accuracy, and never claim radar precision.** A number that reads
high to feel good is worse than no number. A kid's progress over a month matters more than any one
swing, and that only works if the number is honest every time.

## Chapter 1: The ball is its own ruler

*June 2026, before we had any real footage*

One camera from the side has a problem: it can't see depth. If the ball flies 30 cm closer to the
lens than where you calibrated, the speed reads 9 to 14% wrong. A meter off, it can be 25 to 67% wrong.

The fix came from staring at that problem long enough: **a ball looks smaller when it's farther
away, at exactly the same rate its speed looks slower.** Scale every frame by the ball's own size
and the depth error cancels out. No second camera. No depth sensor. We already know how big a
baseball is.

Before touching real video, we simulated 200,000 swings. Using the ball as a ruler cut the depth
error from 3.7 mph to 0.9 and wiped out calibration error completely. Best case, everything
combined: about 1.8 mph off.

The same write-up warned us not to believe that number:

> "But 1.77 mph is a best-case bench number, not a population spec."

In dim light the simulated error doubled. In the dark it quadrupled. The line we kept coming back
to: *"Lighting is the dominant real-world variable, not the phone model."*

The sims taught us two more things that shaped the code. A carry-distance model landed within
2.6% of pro ball tracking on a 100 mph fly ball, but it over-predicts low line drives by 50 to 62
feet, so distance never became the hero number. And a naive "best swing ever" made fake records:
the average player would see 1.7 false personal records a season. A statistical guard cut that to
0.4.

## Chapter 2: The math was right. The honesty was getting thrown away.

*June 12, 2026*

Our first audit put the engine in front of 57 AI reviewers across five areas. Every finding went
to an independent checker told to try to disprove it; 47 held up.

The verdict:

> "The core math is *right* … The real risk is not the formulas: it's that the **honesty machinery
> is computed and then thrown away**."

It found slow balls getting half-erased by the frame differencing, inflating speed. A phone mounted
upside down would silently flip every launch angle. And a camera setting could quietly halve the
frame rate: *"Wrong-by-2× timestamps would halve every velocity."*

It also caught us. Our website said early testing put the number "within a few mph of a pro radar
reading." There was no radar testing. We rewrote that line the next day to say where the number really came
from: modeling.

## Chapter 3: Real footage

*June 15, 2026*

The first three real test sessions measured zero swings.

The detector saw the ball as a 3-pixel fragment, when a real ball in frame is 16 to 22 pixels.
There were about 650 candidate blobs in every frame, and the detector kept locking onto the
hitter's bright hands and bat. Color didn't help: in sunlight, an aluminum bat is the whitest thing
in the picture.

> "Detection here is a disambiguation problem, not a detection problem."

We went back to one clean backyard clip of a young hitter and checked it by hand: 74 pixels of
travel per frame, scaled by the ball's known size and the frame timing, works out to 36.3 mph. Four
different detection approaches landed between 36 and 38. The pipeline *could* work.

Then a harder lesson: once the detector worked, how the shot was framed limited the number more
than the code did.

> "The dominant remaining limit on EV quality is the capture setup, not the code."

## Chapter 4: 67 clips, and the case for saying nothing

*June 15 to 29, 2026*

We ran 67 casual clips from a park. The results were bad: a median of 17 mph, reads as low as 4
mph, and one believable 82 mph from locking onto the bat.

> "EV accuracy is **not trustworthy yet**."

The fix wasn't a smarter estimate. It was a gate. If the flight isn't straight, the ball's size
jumps around, or the number falls outside what a youth hitter can physically do, the engine says
"no clean read" instead of guessing. On the same 67 clips, 37 gave trusted reads and 30 were
honestly silent.

> "Gating 30/67 here is the point (honest silence on bad clips)."

Then we found out the gate had been built, tested, and *never called* in the shipped app. We wired
it in at the end of June with one rule: the gate can only ever remove a number, never invent or change one.

We also caught ourselves scoring a softball with a baseball's ruler. That read 25% slow. The engine
now knows the ball.

## Chapter 5: The second audit

*September 5, 2026*

The math still held up. The biggest errors in the shipped numbers weren't in the math at all.

- **The crescent.** Comparing each frame to the one right before it makes a slow ball look like a
  crescent. At 15 mph that read 45% fast. The June audit had flagged it; it had sat open for three
  months. Fixed in code by comparing against a frame further
  back; it still needs a check on a real phone.
- **The ring.** A one-pixel mask-growing step made the ball look two pixels wider, which read a
  typical ball about 10% slow.
- **Noise called progress.** The trend arrow said "up" on pure noise a quarter to a third of the
  time. A proper statistical test held that to 8% or less.

And the line that matters most:

> "Nothing in this pass replaces the radar validation."

## The honest failure: bat speed

We tried to do for the bat what we did for the ball. The math works on simulated swings, within
about 2 mph. On real video the bat blurred into the forearms, merged with window frames, and locked
onto the tee. Following the hands with body tracking got closer, but confidence stayed low.

> "A single static frame can't reliably disambiguate the bat."

So `bat-tracker` is here, and it's experimental. The app doesn't show a bat speed number, and won't
until it's checked against a real bat sensor.

## Where it stands today

- **No reading has been checked against a radar. Not one.** Every audit says so. The engine's own
  measurement-error figure (2 mph) is a placeholder, and the personal-record guard runs on it.
- **What we trust:** the ball-as-ruler math, the confidence gate, the consistency stats, and the
  rule that a missed read is a no-read, never a guess.
- **What we don't claim:** radar-level accuracy, or a distance that's anything but projected.

## Why we opened it

Up until September, the header of `tracker.ts` called this "the core IP." Keeping it secret would
have been the normal move.

We went the other way. A parent can't check a number they can't see the math behind. Opening it
means anyone can find our mistakes, and every chapter above is a mistake someone found.

## Help us close the gap

The single most useful contribution is **radar-paired swings.** If you have a radar gun and a tee,
record the radar reading and what this engine says for the same swing, with your setup (distance,
angle, light, ball). Share the numbers and the setup in an issue; you don't need to share any video.

If you just want the number on your kid's swings this weekend, that's Swing Dino. Join the beta at
[swingdino.com/beta](https://swingdino.com/beta).
