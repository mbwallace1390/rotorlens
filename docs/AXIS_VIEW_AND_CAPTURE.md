# The axis view and capture briefs

How RotorLens gets from "the engine measured something" to "a pilot learned
something about his helicopter", and where the line is that it will not cross.

Implementation: `src/analysis/axis-report.mjs` (pure, platform-neutral) and the
Axis and Tune evidence panels in `ui/`.

## The problem this solves

Every conclusion the tune evidence can reach is gated behind a manoeuvre. Stop
evidence needs a command released cleanly to centre; hold evidence needs a steady
segment. Most flights contain neither, and the reference flight —
a scale Bell 222UT, 133.5 s, 134,429 samples, decoded with zero errors — contains
**no qualifying stop on roll or pitch at all**, because the largest roll command
in it is 56 °/s and the largest pitch command is 32 °/s against an 80 °/s
threshold.

Before this, that produced a table of zeros, two em-dashes and two shouted enum
codes. The most likely reading of that screen is "the app failed to parse my
log", which is the exact opposite of what happened.

## What always renders

The Axis panel needs only a time column, a setpoint and a gyro, which every
Blackbox log carries on all three axes. It renders on every flight, before
anything is analysed, and never shows a manoeuvre-gated number:

| Measurement | What it is |
| --- | --- |
| Peak commanded / peak measured | Largest magnitude of each over the session |
| Tracking error | RMS of `setpoint − gyro` over the samples where a rate above 10 °/s was actually commanded, and separately over the whole flight |
| Gyro above 50 Hz | RMS of what a centred 10 ms box average removes, reported for the filtered gyro and — when the log carries one — for the unfiltered gyro beside it |
| Headspeed | Median while the rotor is turning, i.e. ignoring the spool-up |
| Commands over threshold | How many command excursions the stop detector had anything to look at, and how many seconds they total |

Plus a commanded-versus-measured trace on a shared °/s scale, decimated to one
column per backing-store pixel, zoomable and draggable, with the stop detector's
accepted and refused candidates marked on it.

### Two notes on the numbers

**The unfiltered gyro is resolved from a deliberately narrow list** —
`gyroUnfilt[N]`, `gyroADCunfilt[N]`, `gyroRAW[N]` — and never from `debug[N]`.
`debug[N]` is whatever the flight controller's current debug mode emits. On the
reference log `debug[0]` carried headspeed, values from 1710 to 1830, so
differencing it against the gyro would have reported a ~1700 °/s noise floor with
a straight face. A log with none of the three is told it has none.

**The high-frequency metric skips the first and last half-window.** A partial
window is a different filter, and near an edge it leaves a residual that belongs
to the edge rather than the signal. `test/axis-report.test.mjs` asserts the
metric against the closed form for a box average — a straight ramp must report
zero, iid noise of σ must report σ·√(1 − 1/w), and a 5 Hz 300 °/s manoeuvre must
leak under a degree per second.

## The five capture states

`describeStopCapture` reads the detector's diagnostics and returns one of five
states. Collapsing any two of them is what makes the app look broken.

| State | Means | The reference flight |
| --- | --- | --- |
| `captured` | Enough stops in both directions | — |
| `partial` | At least one stop, but short in a direction | yaw: one each way |
| `rejected` | Commands were large enough, and every release was refused | — |
| `absent` | No command in the flight was large enough for a stop to exist in | roll, pitch |
| `unavailable` | The question could not be asked: the axis is not in the log | — |

`absent` and `rejected` are different problems with the same empty table, and
they call for opposite responses — a different flight, or a different threshold.
`partial` is a pilot who nearly has it; the old code reported it identically to
one who never tried. `unavailable` gets no manoeuvre brief at all: flying again
will not add a field that was never enabled, and a brief that implies otherwise
wastes a flight.

The state comes from `detectStopEvents(...).diagnosis.outcome` — the detector's
own answer — in preference to anything derivable from its counters. A path
derived from counters survives as a fallback so that losing the field costs a
sentence rather than the screen. Refusal counts come from `diagnosis.rejections`,
which is uncapped, rather than from `candidates`, which stops at
`maximumEvents * 8`.

`describeHoldCapture` does the same for hold evidence, from
`rejectedHoldCounts`.

Every refusal code becomes a sentence about the signal —
`RELEASE_DWELL` reads "the command paused part-way back to centre instead of
returning in one motion" — and an unrecognised code degrades to a humanised form
of itself rather than to a shouted enum. The codes are still shown, behind a
disclosure, so they can be quoted in a bug report.

## Where the numbers in a brief come from

Every threshold quoted in a capture brief is read at run time from
`STOP_DETECTION_DEFAULTS` and `EVIDENCE_LIMITS`, never written into the copy. A
brief that drifts from the detector is worse than no brief: it sends someone up
to fly a manoeuvre that will be refused for the same reason again.
`test/axis-report.test.mjs` asserts the brief still quotes those constants, so
retuning a threshold cannot leave the guidance behind.

## The line, and where the owner moved it on 12 August 2026

This section used to read *"The analysis reports MEASUREMENTS, never
instructions"*, and that was the whole product's rule. **The owner reversed it,
deliberately**, on 12 August 2026:

> i would like the app to analize the flight log the end user selects and
> recommend what to adjust, thats always been my plan for the app because a lot
> of people have no clue what they are looking at when they see all the info and
> graphs.

The reversal, what survived it, and the resolution of the three-way conflict it
settles are recorded in
[architecture and provenance](ARCHITECTURE_AND_PROVENANCE.md) and
[CLAUDE.md](../CLAUDE.md). The short version: RotorLens now recommends what to
adjust; a recommendation must be earned by evidence; mechanical faults outrank
gains; one change at a time with the basis shown; confident and wrong is still
worse than silent; and **RotorLens never writes to a flight controller.**

### What that means for THIS screen

The line did not disappear. It moved from *the product does not advise* to
**advice comes from one place, and this is not that place.**

The Axis panel and the capture briefs are a **measurement surface**. They are
where a pilot goes to find the raw number behind whatever the recommendation
panel claims, which is only useful if these panels are not themselves arguing
for a conclusion. So on this screen the old distinction still holds exactly:

**Telling a pilot what to fly is not telling him what to change.** "Put in a
definite roll command of at least 80 °/s, hold it a second, release it cleanly,
repeat twice each way" is an instruction for capturing data, and it is what a
blocked gate owes the pilot. "Reduce your I term" is an instruction for changing
an aircraft, and it belongs in `src/analysis/recommendations.mjs`, behind the
five gates in `src/analysis/advisor/recommendation-gates.mjs`, or nowhere.

Consequences, all enforced by tests:

- **The viewer does not render `interpretHoldEvidence`'s direction.** That
  function returns `increase` / `decrease`, and the panel used to render those as
  "suggests more I" and "suggests less I" twelve lines above a sentence reading
  "This is a measurement, not an instruction". Both could not be true. On the
  reference flight the badge was also wrong: an aircraft with 1.47 °/s of steady
  error was told at medium confidence to reduce its I term, on the strength of
  least-squares slopes fitted over holds of 0.52 s and 0.74 s. **The reversal
  does not resurrect that badge.** It was not wrong because advice is forbidden;
  it was wrong because it was ungated, uncited, and, on the only real flight this
  project holds, false. The panel renders steady error, drift, ripple, crossing
  rate and noise, and lets the pilot read them.
- **A repointed copy guard runs in CI.** `test/axis-report.test.mjs` sweeps every
  sentence this module can assemble at run time, including the ones built from
  thresholds, and then reads every string literal in every module under `src/` —
  gluing concatenated fragments back together first, because our copy is
  hard-wrapped and `'…lower the ' + 'D gain.'` is invisible to a rule that reads
  half a sentence. A module that tells a pilot to change a setting fails the
  build unless it is the declared recommendation surface *and* consults the
  gates. The rule set is self-tested from both sides: fourteen sentences it must
  catch, and eight measurement sentences it must not, so it cannot be loosened
  into uselessness or tightened until someone deletes a true sentence to get the
  build green.
- **The gates default to no.** Handed nothing, `evaluateGainRecommendationGates`
  blocks on all five and returns the sentences that say what to fly instead.
  Handed nothing, `buildRecommendations` says nothing advisory. Both are asserted
  on empty and near-empty inputs rather than on inputs constructed to pass.
- **No write path exists.** No module under `src/` references a serial, USB,
  Bluetooth or HID transport, and every `directSettingWrites` declaration in the
  engine is `false`.

## What P, I and D are pointed at

Selecting P and selecting D used to render byte-identical output, which teaches a
pilot that the controls do nothing on the one screen that has to earn his trust.
They now differ by which measured quantity is put in front:

| Term | Measured in | Quantity |
| --- | --- | --- |
| P | The stop, while the command was held | Tracking error RMS |
| I | A steady hold | Steady-state error, drift, ripple |
| D | The stop, straight after the release | Fast ringing RMS, 20–250 ms |

This is a statement about where a term is *visible*, which is a property of the
control loop. Nothing in it says whether a number is high or low.

## Directional observations

Directions are never pooled — a single-rotor tail works with main-rotor torque
one way and against it the other. Where each direction has at least one stop, the
per-metric difference is reported with its stop count attached, as an observation
rather than a result: on the reference flight, yaw fast ringing is 4.9× higher
one way than the other, from one stop each way. The viewer used to display both
numbers and then print "This log does not contain enough stops in both directions
to compare them", which states less than the screen already shows.

## What this module does not do

Scoped to `src/analysis/axis-report.mjs` and the panels it feeds. The product as
a whole does recommend what to adjust — from `src/analysis/recommendations.mjs`,
and only where the gates pass.

- It does not suggest a gain, a direction, or a magnitude. Its numbers are the
  evidence a recommendation elsewhere has to cite, and evidence that argues for
  its own conclusion is not evidence.
- It does not conclude anything from `partial` evidence; it says what is missing.
  Neither does the recommendation path: `partial` is excluded from the states
  that may carry a gain recommendation, on arithmetic rather than on taste — with
  one stop per direction there is no within-direction spread to compare the
  between-direction gap against, so a single noisy release *is* the result.
- It does not write to a flight controller. Nothing else does either: there is no
  write path anywhere in the product, and the Android shell declares no
  permissions at all, so it could not if it tried.

### The pending copy fix on this panel

Every brief still renders *"…RotorLens does not tell you what to change, and
never writes to a flight controller."* The second clause is permanent. **The
first clause is now false as a statement about the product** and has to become a
statement about this panel — something to the effect that the numbers above are
measurements, and that what to change, when the evidence supports saying so,
appears in the recommendation panel with its basis attached. The same sentence
exists twice in `src/analysis/axis-report.mjs` (stop and hold briefs) and twice
in `ui/app.mjs`. The test asserts the never-writes half and the panel-scoping
half, and deliberately does not pin the stale clause, so fixing it will not fail
the build.
