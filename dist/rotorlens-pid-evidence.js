/**
 * RotorLensPidEvidence — generated build. Do not edit.
 *
 * Source:    src/analysis/pid-evidence.mjs (RotorLens)
 * Generated: tools/build-advisor-bundle.mjs
 * License:   MPL-2.0
 * Copyright: Copyright (c) 2026 Michael Wallace
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/.
 *
 * MPL-2.0 Section 3.3 permits this covered file to be additionally distributed
 * under GPL-3.0 as part of that Larger Work. The RotorLens source remains
 * available under MPL-2.0. Edit the source and regenerate; edits here are lost.
 */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module && module.exports) {
    module.exports = factory();
  } else {
    root.RotorLensPidEvidence = factory();
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /**
   * Directional stop evidence and steady-state hold evidence for PID tuning.
   *
   * This module closes the two gaps that made "tune P, I and D on roll, pitch and
   * yaw" untrue:
   *
   * **Yaw.** Stop-event evidence pooled both command directions together. That is
   * defensible on roll and pitch, which are close to symmetric, and wrong on yaw:
   * a single-rotor helicopter's tail works with main-rotor torque in one direction
   * and against it in the other, so a left stop and a right stop are not the same
   * measurement. Pooling them averages an asymmetry into a number that describes
   * neither direction. This module keeps directions separate end to end, and
   * reports the asymmetry itself as a finding — because a tail that is running out
   * of authority in one direction looks like a gain problem and is not one.
   *
   * **I term.** Stop events measure what happens after a command is released,
   * which is where P and D live. The I term's job is eliminating *sustained*
   * error, so it is invisible in that window. This module measures holds instead:
   * segments where the command is steady long enough for steady-state error, drift,
   * and low-frequency hunting to be observable.
   *
   * Pure and dependency-free by design: no I/O, no log parser, no UI, no globals.
   * Everything it needs arrives in the record contract below, which is what lets
   * the same analysis run inside RotorLens and inside the web viewer.
   *
   * ## Record contract
   *
   * Each record is one logged sample:
   *
   *   timeUs      integer microseconds, monotonically increasing
   *   setpoint    [roll, pitch, yaw] commanded rate, deg/s
   *   gyro        [roll, pitch, yaw] filtered measured rate, deg/s
   *   raw         [roll, pitch, yaw] unfiltered measured rate, deg/s
   *   terms       [P, I, D] controller contributions for the axis under test
   *   headspeed   main rotor RPM
   *   collective  collective input
   *   vbat        pack voltage
   *
   * Analysis is only as good as the flight it is given; every function here
   * reports why it could not conclude rather than guessing.
   */

  const PID_EVIDENCE_SCHEMA_VERSION = 1;

  const AXES = Object.freeze(['roll', 'pitch', 'yaw']);
  const TERMS = Object.freeze(['P', 'I', 'D']);
  const DIRECTIONS = Object.freeze(['positive', 'negative']);

  const DIRECTIONAL_EVIDENCE_KIND = 'rotorlens-directional-stop-evidence';
  const HOLD_EVIDENCE_KIND = 'rotorlens-hold-evidence';

  /**
   * The frequency band an I term can plausibly hunt in.
   *
   * This is the one physical claim the whole hold analysis rests on, and every
   * other timing constant below is derived from it rather than chosen. That is
   * deliberate: when the band and the filter that measures it were picked
   * independently, the *filter length* decided whether a hold counted as in-band.
   * On the reference flight, pitch read "hunting" at a 100 ms smoothing window and
   * "not hunting" at 50 ms — the same aircraft, the same log, opposite findings,
   * separated only by a constant nobody had derived.
   *
   * Lower edge: below 0.3 Hz an oscillation is slower than any integrator wind-up
   * cycle a helicopter's rate loop produces, and is indistinguishable from the
   * pilot, the wind, or the airframe settling.
   * Upper edge: above 3 Hz the loop is in P/D territory — frame and tail resonance
   * — and lowering the I term does not touch it.
   */
  const HUNTING_BAND_HZ = Object.freeze([0.3, 3.0]);

  /**
   * Box-average length whose −3 dB corner sits at the top of the hunting band.
   *
   * A running mean of length L has its −3 dB point at about 0.443/L. Setting
   * L = 0.443 / bandTop makes the smoother pass everything the band admits and
   * start rejecting immediately above it, so the crossing count that follows is
   * counting in-band content and not the filter's own choice of cutoff. 148 ms.
   */
  const HUNTING_SMOOTHING_US = Math.round((0.443 / HUNTING_BAND_HZ[1]) * 1_000_000);

  /**
   * Shortest measurable span a hold may contribute, derived from the band's floor.
   *
   * 1.2 full cycles of the slowest in-band oscillation: 1.2 / 0.3 Hz = 4.0 s.
   *
   * Below one full cycle, a least-squares line fitted across the window returns
   * the local tangent of a signal that has not yet turned around — it cannot tell
   * a drift from the rising side of a hunt, because within that window the two are
   * the same picture. That is not a subtle effect. On the reference flight a
   * 1.36 s pitch window fitted a −15.45 deg/s² "drift" against a 1.84 deg/s
   * standing error, implying the error moved 21 deg/s inside a window where it
   * never left ±3; a 0.41 s roll window fitted +27.5 deg/s² and, on its own,
   * carried the whole axis to "increase I". The 1.2 rather than 1.0 is margin:
   * at exactly one period the fit only vanishes for a perfectly phase-aligned
   * cycle.
   *
   * It is also 27× the smoothing window above, which is the second requirement —
   * a window a few filter lengths long is all filter transient, and its crossing
   * count and ripple describe the box average rather than the aircraft.
   */
  const MINIMUM_HOLD_MEASURE_US = Math.round((1.2 / HUNTING_BAND_HZ[0]) * 1_000_000);

  /** One second of settling plus a full measurable span. */
  const HOLD_SETTLE_US = 1_000_000;

  /**
   * Thresholds. Exported so a caller can align its own gating with ours rather
   * than duplicating constants that then drift apart.
   */
  const EVIDENCE_LIMITS = Object.freeze({
    /** Stops needed *per direction*, not in total. */
    minimumStopsPerDirection: 2,

    /** Above this, the two directions are not describing the same aircraft behavior. */
    directionalAsymmetryWarnRatio: 0.30,

    /**
     * A hold's command must stay inside this band around the command at the
     * hold's FIRST sample. Not around its median: `detectHoldSegments` anchors
     * the band on the sample a segment opens at and ends the segment at the first
     * sample outside it (corrected 4 October 2026; this said "median", which the
     * code has never done).
     */
    holdSetpointBandDps: 15,

    /**
     * Below this, a hold is the pause between two inputs rather than a hold.
     *
     * Settle window plus a full measurable span, so a hold that survives detection
     * is a hold that can actually be measured. When these two were chosen
     * independently the detector admitted 1.4 s segments that every one of them
     * was then rejected for being too short, and the manoeuvre brief told the
     * pilot to hold for 1.4 s to obtain 0.4 s of steady state — a sentence whose
     * own arithmetic no longer worked once the measurable span moved.
     */
    minimumHoldDurationUs: HOLD_SETTLE_US + MINIMUM_HOLD_MEASURE_US,

    /**
     * Discarded at the start of a hold so the P/D transient is not measured as I.
     *
     * One second, matching how long the post-stop response is treated as lasting
     * elsewhere. A shorter settle lets stop-event ringing — the thing P and D are
     * judged on — leak into the steady-state numbers and read as an I-term fault.
     */
    holdSettleUs: HOLD_SETTLE_US,

    /** Measurable span left after settling. Derived: see MINIMUM_HOLD_MEASURE_US. */
    minimumHoldMeasureUs: MINIMUM_HOLD_MEASURE_US,

    /** Holds needed before hold evidence is conclusive. */
    minimumHolds: 2,

    /**
     * Holds needed before a STANDING error is read as one (2 October 2026, round
     * three of the review). JUDGEMENT, chosen as the smallest count that can
     * show a side being kept rather than met by chance.
     *
     * A standing error the I term should close stays on one side of the command
     * from hold to hold; a slow wander does not. Two holds cannot tell them
     * apart: half a cycle of a wander puts both on one side as often as not, and
     * on the review's closed loop a healthy integrator pushed by a 0.06-0.10 Hz
     * torque, flown as ordinary 5.5-8 s holds, was told "Raise I" in up to 54 of
     * 90 flights. Three is the least that can show the side being KEPT, and on
     * the round-three sweep (0.03-0.30 Hz, 3-8 holds 6.5-12 s apart, all three
     * axes) no healthy integrator kept it, while an aircraft with no integrator
     * kept it in three holds of 5.5 s. The pilot guide asks for five.
     */
    minimumHoldsForStandingError: 3,

    /** |median setpoint| under this makes it a hold at zero — heading/attitude hold. */
    zeroHoldThresholdDps: 10,

    /** Off-axis command above this means the pilot was not holding one axis. */
    offAxisCommandLimitDps: 30,

    /**
     * Whether an input on another axis over `offAxisCommandLimitDps` ENDS a hold
     * (true, since Stage 5b, 4 October 2026) — see `detectHoldSegments`. False
     * restores the detector as it was before: the segment ran on through the
     * input and `measureHold` refused the whole of it as HOLD_OFF_AXIS_INPUT. Kept
     * only so figures measured that way — the per-axis floors quoted in
     * src/analysis/flight-history.mjs — can still be reproduced
     * (`createCorpusScan` in tools/corpus/measure.mjs); nothing in the app sets it.
     */
    offAxisInputEndsHold: true,

    /** Headspeed span over median above this makes governor effects masquerade as tune. */
    maximumHeadspeedVariationRatio: 0.05,

    /** Battery sag this large changes available authority mid-measurement. */
    maximumBatteryVariationRatio: 0.10,

    minimumPlausibleHeadspeedRpm: 300,
    maximumPlausibleHeadspeedRpm: 10_000,

    /**
     * Largest gap allowed inside a measured hold.
     *
     * Hold duration is elapsed time, so without this guard two samples several
     * seconds apart look like seconds of evidence. 100 ms still admits logs down
     * to 10 Hz while refusing a gap too large to describe continuous control-loop
     * behaviour.
     */
    maximumHoldSampleGapUs: 100_000,

    /** Gain comparisons inside this ratio are noise, not a result. */
    comparisonToleranceRatio: 0.10,

    /**
     * THE FLIGHT-TO-FLIGHT NOISE FLOOR for hold steady-state error, in deg/s.
     *
     * A relative tolerance on its own is meaningless here, and the corpus proves
     * it rather than suggests it. Across 109 real flights the shipped comparison
     * was run over every pair of same-aircraft flights whose header PID lines were
     * byte-identical — pairs where, by construction, the pilot changed nothing. It
     * returned "unchanged" ZERO times out of six: three "improved", three
     * "worsened". A pilot who re-flew having adjusted nothing would have been told,
     * confidently, that something had happened, with a coin deciding which.
     *
     * The reason is that the metric is near zero in absolute terms — median
     * 0.222 deg/s overall and 0.03–0.09 deg/s on yaw — so a 78% "significant"
     * relative move is 0.023 deg/s of yaw error, which is weather. This number is
     * the p90 of |Δ| over those identical-gain pairs (n=47: median 0.044, p90
     * 0.309, p95 0.354, max 1.390), rounded up to 0.39 to cover the same figure
     * measured segment-to-segment WITHIN one flight (n=130, p90 0.3863) — same
     * aircraft, same gains, same battery, minutes apart, which is the tightest
     * nominally-identical pair that can exist.
     *
     * Conditioning on hold kind, headspeed within 5% and duration within 40%
     * barely moves it (median 0.0556 → 0.0479, p90 unchanged), so the residual is
     * not headspeed or window length. It is the pilot, the trim and the air.
     *
     * The instrument itself is much finer than this: injecting a known scaling
     * into a real flight's error signal moves the metric 1:1 to three decimals and
     * `compareHoldEvidence` fires at exactly 1.10 and stays silent at 1.05. What
     * this floor measures is the experiment's control, not the sensor.
     */
    holdErrorNoiseFloorDps: 0.39,

    /**
     * Hold segments needed PER SIDE before a before/after comparison may speak.
     *
     * From the measured per-segment spread (n=83, sd 0.41 deg/s) and a two-sample
     * t at alpha 0.05, power 0.80: five segments a side resolve a 0.8 deg/s shift,
     * seventeen resolve 0.4, and 0.1 deg/s would need 264. Five is the smallest
     * count that resolves anything at all, and it is deliberately the floor rather
     * than a target.
     *
     * It matters because 59% of the comparable sides in the corpus (58 of 98) had
     * exactly ONE hold segment, and n=1 against n=1 cannot support any claim.
     *
     * Not applied inside `compareHoldEvidence`, which reports the counts and lets
     * the caller gate: the raw comparison is also used to inspect a single pair by
     * hand, and a function that refused to compute would make that impossible.
     * `src/analysis/flight-history.mjs` is where it is enforced.
     */
    minimumComparisonHolds: 5,

    /**
     * The band an I term can hunt in. One definition, shared.
     *
     * Kept here rather than only as an `interpretHoldEvidence` option so that the
     * smoothing window and the minimum measurable span are derived from the same
     * numbers the interpretation tests against. When they were independent, moving
     * the filter moved the verdict.
     */
    huntingBandHz: HUNTING_BAND_HZ,

    /**
     * Averaging window applied to the error before hunting is measured.
     *
     * Raw gyro error crosses its own mean tens of times a second from sensor noise
     * alone, so counting crossings on the raw signal measures noise and reports it
     * as hunting. On a real flight that produced a confident "reduce I" for an
     * aircraft whose steady-state error was under 1 deg/s.
     *
     * Derived from the band top rather than chosen: see HUNTING_SMOOTHING_US.
     */
    huntingSmoothingUs: HUNTING_SMOOTHING_US,

    /**
     * How far a fitted drift must stand above its own uncertainty to be reported.
     *
     * A least-squares slope is an estimate with a standard error, and over a short
     * window carrying slow correlated content that error is enormous. The roll
     * hold that produced "increase I" fitted 27.5 deg/s² with a standard error of
     * 20.0 — the slope was not distinguishable from zero, and nothing downstream
     * could see that because only the slope was reported.
     *
     * Three rather than the conventional two because the effective sample count
     * behind the standard error is itself an estimate; see `driftSignificance`.
     */
    driftSignificanceRatio: 3,

    maximumHolds: 64,
    maximumReasonCodes: 32
  });

  /**
   * How many holds a sentence asks a pilot to fly (3 October 2026, the re-review
   * of round three): the larger of the two minimums above. Holds are captured from
   * `minimumHolds`, but a standing error is read only from
   * `minimumHoldsForStandingError`, and the copy went on asking for the smaller —
   * "Repeat until you have 2 such holds", "fly two long still holds" — after the
   * second was raised to three. A pilot with too little I who flew what he was
   * told came back to "2 holds are too few to call that a standing error". Every
   * count of holds the copy asks for is this one, so the two cannot drift apart.
   */
  const HOLDS_FOR_A_FULL_READING = Math.max(
    EVIDENCE_LIMITS.minimumHolds, EVIDENCE_LIMITS.minimumHoldsForStandingError);

  // ---------------------------------------------------------------------------
  // Small numeric helpers. Kept local so this module stays dependency-free.
  // ---------------------------------------------------------------------------

  function finiteValues(values) {
    return values.filter(value => Number.isFinite(value));
  }

  function mean(values) {
    const finite = finiteValues(values);
    if (finite.length === 0) {
      return null;
    }
    return finite.reduce((total, value) => total + value, 0) / finite.length;
  }

  /**
   * Largest and smallest finite value, as an explicit loop.
   *
   * `Math.max(...values)` spreads every element into the argument list, and a
   * flight log's window is tens or hundreds of thousands of samples long. A steady
   * two-minute hover — completely normal, and precisely the flight an I-term
   * measurement wants — pushed past the engine's argument limit and threw
   * `RangeError: Maximum call stack size exceeded`, taking the whole I-term
   * analysis down with it. Reproduced at 133 s; fine at 60 s. There is no size at
   * which a loop does that.
   */
  function extremes(values) {
    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    let seen = 0;

    for (const value of values) {
      if (!Number.isFinite(value)) {
        continue;
      }
      seen += 1;
      if (value < lowest) {
        lowest = value;
      }
      if (value > highest) {
        highest = value;
      }
    }

    return seen === 0 ? null : {lowest, highest};
  }

  /**
   * Mean of `values` weighted by `weights`.
   *
   * Holds differ in length by two orders of magnitude, and a plain mean says a
   * 0.41 s glimpse and a 16 s hold are equally good estimates of the same
   * quantity. They are not: the short one is mostly variance. On the reference
   * flight the plain mean let a single 0.41 s hold — one of three — drag the roll
   * axis to "increase I" while the other two read −0.10 and 1.48 deg/s².
   *
   * A pair whose weight is not finite and positive contributes nothing rather than
   * being counted at weight zero, so the divisor stays honest.
   */
  function weightedMean(values, weights) {
    let total = 0;
    let weightTotal = 0;

    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      const weight = weights[index];
      if (!Number.isFinite(value) || !Number.isFinite(weight) || weight <= 0) {
        continue;
      }
      total += value * weight;
      weightTotal += weight;
    }

    return weightTotal === 0 ? null : total / weightTotal;
  }

  function rms(values) {
    const finite = finiteValues(values);
    if (finite.length === 0) {
      return null;
    }
    const total = finite.reduce((sum, value) => sum + value * value, 0);
    return Math.sqrt(total / finite.length);
  }

  function quantile(values, fraction) {
    const finite = finiteValues(values).sort((left, right) => left - right);
    if (finite.length === 0) {
      return null;
    }
    const position = (finite.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) {
      return finite[lower];
    }
    return finite[lower] + (finite[upper] - finite[lower]) * (position - lower);
  }

  /** Span of the values relative to a reference; used for stability gating. */
  function spanRatio(values, reference) {
    const bounds = extremes(values);
    if (bounds === null || !Number.isFinite(reference) || reference === 0) {
      return null;
    }
    return Math.abs((bounds.highest - bounds.lowest) / reference);
  }

  /**
   * Least-squares slope of `values` against `timesUs`, returned per second.
   *
   * This is the drift measurement: a steady-state error that is still moving is a
   * different finding from one that has settled at the wrong value.
   */
  function slopePerSecond(timesUs, values) {
    const points = [];
    for (let index = 0; index < values.length; index += 1) {
      if (Number.isFinite(values[index]) && Number.isFinite(timesUs[index])) {
        points.push([timesUs[index] / 1_000_000, values[index]]);
      }
    }
    if (points.length < 2) {
      return null;
    }

    const timeMean = points.reduce((total, point) => total + point[0], 0) / points.length;
    const valueMean = points.reduce((total, point) => total + point[1], 0) / points.length;

    let covariance = 0;
    let variance = 0;
    for (const [time, value] of points) {
      covariance += (time - timeMean) * (value - valueMean);
      variance += (time - timeMean) ** 2;
    }

    return variance === 0 ? null : covariance / variance;
  }

  /**
   * How many times its own standard error a fitted slope stands at.
   *
   * `slopePerSecond` returns a number with no uncertainty attached, and that
   * omission is what let a fit artefact be reported as a finding. A slope is an
   * estimate; over a short window carrying slow, correlated content its standard
   * error can be larger than the slope itself, and the two are indistinguishable
   * from a straight line through noise.
   *
   * Ordinary least squares gives SE(slope) = sigma / sqrt(Sxx), with
   * Sxx = n · var(t) and var(t) = T²/12 for uniform sampling over a window of
   * length T. That assumes independent residuals, which these are emphatically
   * not: the residual left after removing the line is the aircraft moving, and it
   * stays on one side of the line for something like half an oscillation period at
   * a time. Using `n` there would understate the error by a factor of tens.
   *
   * So `n` is replaced by an effective count T/tau, where tau is the residual's
   * own half-period, read off its zero-crossing rate. tau is floored at the
   * smoothing window — the box average imposes at least that much correlation on
   * its own — and capped at T/2, because a window cannot contain fewer than two
   * independent observations and still support a two-parameter fit.
   *
   * Returns `Infinity` for a residual-free non-zero slope (a perfect line is
   * perfectly determined), zero for a residual-free flat line, and `null` when
   * there is nothing to judge. A zero slope has zero significance; treating its
   * zero standard error as infinite evidence used to mark constant holds as
   * having a measurable drift.
   *
   * @param {number[]} timesUs       sample times, microseconds
   * @param {number[]} slowValues    the *smoothed* signal the drift is claimed in
   * @param {number}   slopePerSec   the fitted slope, per second
   * @param {number}   correlationFloorUs smoothing window applied to `slowValues`
   */
  function driftSignificance(timesUs, slowValues, slopePerSec, correlationFloorUs) {
    if (!Number.isFinite(slopePerSec) || timesUs.length < 2) {
      return null;
    }

    const durationSeconds = (timesUs[timesUs.length - 1] - timesUs[0]) / 1_000_000;
    if (!(durationSeconds > 0)) {
      return null;
    }

    const centre = mean(slowValues);
    const timeCentre = mean(timesUs);
    if (centre === null || timeCentre === null) {
      return null;
    }

    // What the fitted line does not explain.
    const residual = slowValues.map((value, index) => (
      Number.isFinite(value) && Number.isFinite(timesUs[index])
        ? value - centre - slopePerSec * ((timesUs[index] - timeCentre) / 1_000_000)
        : Number.NaN
    ));

    const sigma = rms(residual);
    if (sigma === null) {
      return null;
    }
    if (sigma === 0) {
      return slopePerSec === 0 ? 0 : Number.POSITIVE_INFINITY;
    }

    const crossingRateHz = zeroCrossingRateHz(timesUs, residual);
    const rawTau = Number.isFinite(crossingRateHz) && crossingRateHz > 0
      ? 1 / crossingRateHz
      : durationSeconds;
    const tau = Math.min(
      Math.max(rawTau, (correlationFloorUs ?? 0) / 1_000_000),
      durationSeconds / 2
    );
    if (!(tau > 0)) {
      return null;
    }

    const effectiveCount = durationSeconds / tau;
    const standardError =
      (sigma * Math.sqrt(12)) / (Math.sqrt(effectiveCount) * durationSeconds);

    return standardError === 0 ? Number.POSITIVE_INFINITY : Math.abs(slopePerSec) / standardError;
  }

  /**
   * Sign changes per full cycle of an oscillation.
   *
   * `zeroCrossingRateHz` counts sign changes, and a sine crosses its mean twice
   * per cycle, so its "Hz" is half-cycles per second. Every band in this module
   * is a band of oscillation frequency. A crossing rate is divided by this before
   * it is compared with one; it is reported raw everywhere a pilot reads it.
   */
  const CROSSINGS_PER_CYCLE = 2;

  /**
   * Sign changes per second of a mean-removed signal.
   *
   * Steady offset and slow hunting both raise the average error magnitude, but
   * only hunting keeps crossing zero — which is what separates "not enough I" from
   * "too much I".
   *
   * Not a frequency: a sine of f Hz returns about 2f. Divide by
   * `CROSSINGS_PER_CYCLE` before comparing with a frequency band.
   */
  function zeroCrossingRateHz(timesUs, values) {
    const centre = mean(values);
    if (centre === null || values.length < 2) {
      return null;
    }

    const durationSeconds = (timesUs[timesUs.length - 1] - timesUs[0]) / 1_000_000;
    if (!(durationSeconds > 0)) {
      return null;
    }

    let crossings = 0;
    let previousSign = 0;
    for (const value of values) {
      if (!Number.isFinite(value)) {
        continue;
      }
      const sign = Math.sign(value - centre);
      if (sign !== 0 && previousSign !== 0 && sign !== previousSign) {
        crossings += 1;
      }
      if (sign !== 0) {
        previousSign = sign;
      }
    }

    return crossings / durationSeconds;
  }

  /**
   * Box average over a window of `count` samples, centred.
   *
   * Deliberately the simplest low-pass there is: its behaviour is obvious from the
   * window length, which matters more here than a sharp cutoff.
   */
  function movingAverage(values, count) {
    if (!(count > 1)) {
      return [...values];
    }

    const half = Math.floor(count / 2);
    const smoothed = new Array(values.length);

    for (let index = 0; index < values.length; index += 1) {
      let total = 0;
      let seen = 0;
      for (let offset = -half; offset <= half; offset += 1) {
        const value = values[index + offset];
        if (Number.isFinite(value)) {
          total += value;
          seen += 1;
        }
      }
      smoothed[index] = seen === 0 ? Number.NaN : total / seen;
    }

    return smoothed;
  }

  function round(value, digits) {
    if (!Number.isFinite(value)) {
      return null;
    }
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  function addCode(codes, code) {
    if (!codes.includes(code) && codes.length < EVIDENCE_LIMITS.maximumReasonCodes) {
      codes.push(code);
    }
  }

  function axisIndexOf(axis) {
    return AXES.indexOf(axis);
  }

  function termIndexOf(term) {
    return TERMS.indexOf(term);
  }

  // ---------------------------------------------------------------------------
  // Directional stop evidence
  // ---------------------------------------------------------------------------

  /** Metrics that are meaningful to aggregate across the stops in one direction. */
  const DIRECTIONAL_METRICS = Object.freeze([
    'trackingRmsDps',
    'fastRingingRmsDps',
    'slowOscillationRmsDps',
    'commandAmplitudeDps',
    'headspeedRpm'
  ]);

  function summarizeDirection(events) {
    const summary = {directionEventCount: events.length};

    for (const metric of DIRECTIONAL_METRICS) {
      const values = events.map(event => event[metric]);
      summary[metric] = round(mean(values), 4);
      summary[`${metric}Median`] = round(quantile(values, 0.5), 4);
    }

    return summary;
  }

  /**
   * Relative gap between the two directions, 0 (identical) to 1 (one is zero).
   *
   * Deliberately symmetric and scale-free so it can be compared across metrics
   * whose units differ.
   */
  function asymmetryRatio(positive, negative) {
    if (!Number.isFinite(positive) || !Number.isFinite(negative)) {
      return null;
    }
    const largest = Math.max(Math.abs(positive), Math.abs(negative));
    return largest === 0 ? 0 : Math.abs(positive - negative) / largest;
  }

  /**
   * Groups stop events by command direction and summarizes each independently.
   *
   * Every event needs a `commandSign` of `"positive"` or `"negative"`. Events
   * without one cannot be placed in a direction and are counted, not guessed at.
   *
   * @param {object[]} events stop-event metrics
   * @param {object}   [options]
   * @param {string}   [options.axis] when `"yaw"`, asymmetry is reported as a
   *   first-class finding rather than a diagnostic note
   */
  function buildDirectionalStopEvidence(events, options = {}) {
    const limits = {...EVIDENCE_LIMITS, ...options.limits};
    const codes = [];
    const axis = options.axis ?? null;

    const usable = Array.isArray(events) ? events : [];
    const unsigned = usable.filter(event => !DIRECTIONS.includes(event?.commandSign)).length;
    if (unsigned > 0) {
      addCode(codes, 'DIRECTION_UNKNOWN_EVENTS_DISCARDED');
    }

    const grouped = {
      positive: usable.filter(event => event?.commandSign === 'positive'),
      negative: usable.filter(event => event?.commandSign === 'negative')
    };

    const directions = {};
    for (const direction of DIRECTIONS) {
      const events_ = grouped[direction];
      directions[direction] = events_.length === 0
        ? {directionEventCount: 0}
        : summarizeDirection(events_);

      if (events_.length < limits.minimumStopsPerDirection) {
        addCode(codes, direction === 'positive'
          ? 'INSUFFICIENT_POSITIVE_DIRECTION_STOPS'
          : 'INSUFFICIENT_NEGATIVE_DIRECTION_STOPS');
      }
    }

    const asymmetry = {};
    for (const metric of DIRECTIONAL_METRICS) {
      asymmetry[metric] = round(
        asymmetryRatio(directions.positive[metric], directions.negative[metric]),
        4
      );
    }

    // Tracking asymmetry is the one that matters: it says the aircraft follows the
    // command better one way than the other. On yaw that is usually tail authority
    // or head-speed dependence, and raising a gain will not fix it.
    const trackingAsymmetry = asymmetry.trackingRmsDps;
    const asymmetric = Number.isFinite(trackingAsymmetry)
      && trackingAsymmetry > limits.directionalAsymmetryWarnRatio;

    if (asymmetric) {
      addCode(codes, axis === 'yaw'
        ? 'YAW_DIRECTIONAL_ASYMMETRY_DETECTED'
        : 'DIRECTIONAL_ASYMMETRY_DETECTED');
    }

    const conclusive = DIRECTIONS.every(
      direction => directions[direction].directionEventCount >= limits.minimumStopsPerDirection
    );

    return Object.freeze({
      schemaVersion: PID_EVIDENCE_SCHEMA_VERSION,
      kind: DIRECTIONAL_EVIDENCE_KIND,
      axis,
      status: conclusive ? 'captured' : 'inconclusive',
      codes,
      directions,
      asymmetry,
      // The headline: whether the two directions may be reasoned about together.
      directionsComparable: conclusive && !asymmetric,
      totalEventCount: grouped.positive.length + grouped.negative.length,
      discardedEventCount: unsigned
    });
  }

  /**
   * Whether the two directions may be compared, and why not when they may not.
   *
   * `directionsComparable` is false for two different reasons — the directions
   * genuinely differ, or there were never enough stops to tell — and a viewer that
   * treats it as a boolean states the first when it means the second. A real log
   * with no qualifying stops was reported as "the two directions do not behave
   * alike" while the codes beside it said INSUFFICIENT_POSITIVE_DIRECTION_STOPS.
   *
   * Saying nothing is always available. Saying the wrong thing about a helicopter
   * is not.
   */
  function describeDirectionalComparison(evidence) {
    const trackingAsymmetry = evidence.asymmetry?.trackingRmsDps ?? null;

    if (evidence.status !== 'captured' || !Number.isFinite(trackingAsymmetry)) {
      return Object.freeze({
        comparable: null,
        asymmetryRatio: null,
        sentence: 'This log does not contain enough stops in both directions to compare them.'
      });
    }

    return Object.freeze({
      comparable: evidence.directionsComparable,
      asymmetryRatio: trackingAsymmetry,
      sentence: evidence.directionsComparable
        ? 'The two directions behave alike.'
        : 'The two directions do not behave alike, so a single number would describe neither.'
    });
  }

  /**
   * Compares two directional captures **within each direction**.
   *
   * Comparing a baseline's left stops against a test's right stops would be
   * meaningless, so a direction that is missing on either side is reported as
   * having no result rather than being silently pooled.
   */
  function compareDirectionalStopEvidence(baseline, test, options = {}) {
    const limits = {...EVIDENCE_LIMITS, ...options.limits};
    const codes = [];

    if (!baseline || !test
        || baseline.kind !== DIRECTIONAL_EVIDENCE_KIND
        || test.kind !== DIRECTIONAL_EVIDENCE_KIND) {
      return Object.freeze({
        schemaVersion: PID_EVIDENCE_SCHEMA_VERSION,
        kind: DIRECTIONAL_EVIDENCE_KIND,
        status: 'inconclusive',
        codes: ['EVIDENCE_KIND_MISMATCH'],
        directions: {}
      });
    }

    if (baseline.axis !== test.axis) {
      addCode(codes, 'AXIS_MISMATCH');
      return Object.freeze({
        schemaVersion: PID_EVIDENCE_SCHEMA_VERSION,
        kind: DIRECTIONAL_EVIDENCE_KIND,
        axis: baseline.axis,
        status: 'inconclusive',
        codes,
        directions: {},
        directionsCompared: []
      });
    }

    const directions = {};
    for (const direction of DIRECTIONS) {
      const before = baseline.directions[direction];
      const after = test.directions[direction];

      if (!before?.directionEventCount || !after?.directionEventCount
          || before.directionEventCount < limits.minimumStopsPerDirection
          || after.directionEventCount < limits.minimumStopsPerDirection) {
        directions[direction] = {status: 'inconclusive', codes: ['INSUFFICIENT_DIRECTION_STOPS']};
        continue;
      }

      const changes = {};
      for (const metric of DIRECTIONAL_METRICS) {
        const from = before[metric];
        const to = after[metric];
        if (!Number.isFinite(from) || !Number.isFinite(to)) {
          changes[metric] = null;
          continue;
        }
        const difference = to - from;
        const relative = from === 0 ? null : difference / Math.abs(from);
        changes[metric] = {
          baseline: from,
          test: to,
          difference: round(difference, 4),
          relative: round(relative, 4),
          // A change inside tolerance is not a result, however tidy it looks.
          significant: Number.isFinite(relative)
            ? Math.abs(relative) > limits.comparisonToleranceRatio
            : null
        };
      }

      directions[direction] = {status: 'captured', codes: [], changes};
    }

    const resolved = DIRECTIONS.filter(direction => directions[direction].status === 'captured');
    if (resolved.length === 0) {
      addCode(codes, 'NO_DIRECTION_COMPARABLE');
    } else if (resolved.length < DIRECTIONS.length) {
      addCode(codes, 'PARTIAL_DIRECTION_COVERAGE');
    }

    // A gain change that helps one direction and hurts the other is the signature
    // of a mechanical or authority limit, not a better gain. Say so explicitly.
    let conflicting = false;
    if (resolved.length === DIRECTIONS.length) {
      const positive = directions.positive.changes.trackingRmsDps;
      const negative = directions.negative.changes.trackingRmsDps;
      if (positive?.significant && negative?.significant
          && Math.sign(positive.difference) !== Math.sign(negative.difference)) {
        conflicting = true;
        addCode(codes, 'DIRECTIONAL_RESULT_CONFLICT');
      }
    }

    return Object.freeze({
      schemaVersion: PID_EVIDENCE_SCHEMA_VERSION,
      kind: DIRECTIONAL_EVIDENCE_KIND,
      axis: baseline.axis,
      status: resolved.length > 0 && !conflicting ? 'captured' : 'inconclusive',
      codes,
      directions,
      directionsCompared: resolved
    });
  }

  // ---------------------------------------------------------------------------
  // Hold evidence — the I term
  // ---------------------------------------------------------------------------

  function recordsBetween(records, startUs, endUs) {
    return records.filter(record => record.timeUs >= startUs && record.timeUs <= endUs);
  }

  function offAxisIndexes(axisIndex) {
    return [0, 1, 2].filter(index => index !== axisIndex);
  }

  /**
   * The other axis commanded hardest at one sample, and how hard, read exactly as
   * `measureHold` reads it: a missing command counts as zero and a command that is
   * not a number is skipped. The detector and the measurement must agree on what
   * "an input on another axis" is, or a hold the detector closed in time could
   * still be refused for one it did not see.
   */
  function offAxisCommandAt(record, axisIndex) {
    const others = offAxisIndexes(axisIndex);
    let peak = 0;
    let axis = null;
    for (const other of others) {
      const value = Math.abs(record.setpoint?.[other] ?? 0);
      if (value > peak) {
        peak = value;
        axis = other;
      }
    }
    return {peak, axis};
  }

  /**
   * Finds spans where the command on `axisIndex` is steady long enough to expose
   * steady-state behavior.
   *
   * A hold ends as soon as the command leaves the band around the value it started
   * with — extending it through a command change would blend two different
   * operating points into one average.
   *
   * AN INPUT ON ANOTHER AXIS ENDS A HOLD, TOO (Stage 5b, 4 October 2026). Until
   * then a segment ran on through one, and `measureHold` refused the whole of it
   * as HOLD_OFF_AXIS_INPUT. On the 31 admissible real flights that threw away 37
   * roll, 36 pitch and 15 yaw stretches over the governor span; on roll and pitch
   * most were still hovers ended by a pedal input (median peak 123-129 deg/s), on
   * yaw by a roll input (median 50 deg/s). The steady part BEFORE the input was a
   * hold like any other, so the segment now ends at the sample before the first
   * one over `offAxisCommandLimitDps` — the prefix rule — and is measured if it
   * is still long enough. The limit itself, the band, its first-sample anchor,
   * the settle and the minimum length are all unchanged.
   *
   * AND THE AXIS MUST MOVE BEFORE ANOTHER HOLD OPENS. After that input, no new
   * segment may open until this axis's OWN command has left the band around the
   * value it had at the moment of the input (`holdSetpointBandDps` either side),
   * and no segment opens while another axis is still over the limit. Without the
   * first half, a pedal blip in the middle of one hover would cut it into two
   * holds, and a few blips into three — which is the count a standing error is
   * read from (`minimumHoldsForStandingError`), reached without the pilot ever
   * holding the aircraft a second time, and the hold-to-hold side test that count
   * exists for would be testing one hover against itself. It also keeps the
   * first stretch after the window opens dropped (CLIPPED_BY_WINDOW): a blip
   * there does not turn the rest of that stretch, measured while the integrator
   * is still winding up after liftoff, into a hold. The move may happen while the
   * other input is still held — a coordinated turn — and counts once it has.
   *
   * Two qualifications, from the review of round one (4 October 2026). The
   * segment at the first sample is open from that sample even if another axis is
   * already over the limit there: it began before the records did, so the rules
   * above apply to it as to any open segment, and records that begin during an
   * input cannot slip the rest of the first stretch past CLIPPED_BY_WINDOW. And an
   * input inside an open segment's settle (`holdSettleUs`), which `measureHold`
   * discards, neither ends it nor arms the move — as before Stage 5b.
   *
   * Each segment says how it ended (`endedBy`): `off-axis-input` (with
   * `endedByAxis`, the axis whose input it was), `command-left-band`,
   * `command-not-finite`, or `end-of-records`.
   */
  function detectHoldSegments(records, axisIndex, options = {}) {
    const limits = {...EVIDENCE_LIMITS, ...options.limits};
    const segments = [];

    if (!Array.isArray(records) || records.length === 0) {
      return segments;
    }

    let startIndex = null;
    let reference = null;
    // Set at an input on another axis that ended an open segment: the value this
    // axis had then, which its own command must leave before a hold may open.
    let mustLeave = null;

    const closeSegment = (endIndex, endedBy, endedByAxis = null) => {
      if (startIndex === null || endIndex <= startIndex) {
        return;
      }
      const durationUs = records[endIndex].timeUs - records[startIndex].timeUs;
      if (durationUs >= limits.minimumHoldDurationUs && segments.length < limits.maximumHolds) {
        segments.push({
          startIndex,
          endIndex,
          durationUs,
          // A segment that begins at the first sample it was given, or ends at the
          // last, has an UNKNOWN TRUE EXTENT: the command may have been steady for
          // ten seconds before this array starts, or for ten seconds after it
          // ends, and nothing here can tell. See CLIPPED_BY_WINDOW in
          // `buildHoldEvidence` for why that matters enough to drop the segment.
          clippedAtStart: startIndex === 0,
          clippedAtEnd: endIndex === records.length - 1,
          endedBy,
          endedByAxis: endedByAxis === null ? null : AXES[endedByAxis]
        });
      }
    };

    for (let index = 0; index < records.length; index += 1) {
      const setpoint = records[index].setpoint?.[axisIndex];

      if (!Number.isFinite(setpoint)) {
        closeSegment(index - 1, 'command-not-finite');
        startIndex = null;
        reference = null;
        continue;
      }

      // THE WINDOW START IS AN OPEN SEGMENT (review of round one, 4 October 2026).
      // Whatever the axis was doing at the first sample began before the records
      // did, so a segment is open from there — clipped at its start — even with an
      // input on another axis already under way. Without this, records that began
      // during such an input had nothing open for the input to end, nothing asked
      // this axis to move, and the rest of the first stretch opened after it as an
      // unclipped hold, measured while the integrator may still be winding up
      // after liftoff. The rules below then treat it like any other open segment.
      if (index === 0) {
        startIndex = 0;
        reference = setpoint;
      }

      // The axis has made its own move since the input that ended its last hold.
      if (mustLeave !== null && Math.abs(setpoint - mustLeave) > limits.holdSetpointBandDps) {
        mustLeave = null;
      }

      const offAxis = offAxisCommandAt(records[index], axisIndex);
      if (limits.offAxisInputEndsHold !== false && offAxis.peak > limits.offAxisCommandLimitDps) {
        // AN INPUT INSIDE THE SETTLE IS NOT AN END (review of round one). Every
        // hold's first `holdSettleUs` is discarded by `measureHold`, so an input
        // there touches nothing that is measured — before Stage 5b it was ignored
        // for exactly that reason — and ending the hold on it lost 3 of the 11
        // corpus holds the prefix rule lost. It neither ends the segment nor asks
        // the axis to move. An input still on once the settle is over is inside
        // the measured window and ends the segment below, as any other does.
        const inSettle = startIndex !== null
          && records[index].timeUs - records[startIndex].timeUs < limits.holdSettleUs;
        if (inSettle) {
          if (Math.abs(setpoint - reference) > limits.holdSetpointBandDps) {
            // The axis's own move ends the segment, still too short to be a hold;
            // the next opens once the input is off, from wherever the axis is then,
            // because it has already moved.
            closeSegment(index - 1, 'command-left-band');
            startIndex = null;
            reference = null;
          }
          continue;
        }
        if (startIndex !== null) {
          closeSegment(index - 1, 'off-axis-input', offAxis.axis);
          // Only an input that ENDS a segment arms the rule. One that arrives
          // after the axis has already moved, while nothing is open, does not ask
          // it to move again.
          if (mustLeave === null) {
            mustLeave = setpoint;
          }
        }
        startIndex = null;
        reference = null;
        continue;
      }

      if (mustLeave !== null) {
        // Still inside the band it had when the input came: the same hover.
        continue;
      }

      if (startIndex === null) {
        startIndex = index;
        reference = setpoint;
        continue;
      }

      if (Math.abs(setpoint - reference) > limits.holdSetpointBandDps) {
        closeSegment(index - 1, 'command-left-band');
        startIndex = index;
        reference = setpoint;
      }
    }

    closeSegment(records.length - 1, 'end-of-records');
    return segments;
  }

  /**
   * Measures one hold.
   *
   * Returns a rejection object rather than null when the hold is unusable, so the
   * caller can tell the pilot *why* a hold did not count instead of silently
   * dropping it.
   */
  function measureHold(records, segment, axisIndex, termIndex, limits) {
    const start = records[segment.startIndex];
    const measureStartUs = start.timeUs + limits.holdSettleUs;
    const endUs = records[segment.endIndex].timeUs;

    if (endUs - measureStartUs < limits.minimumHoldMeasureUs) {
      return {rejected: 'HOLD_TOO_SHORT_AFTER_SETTLE'};
    }

    const window = recordsBetween(records, measureStartUs, endUs);
    if (window.length < 2) {
      return {rejected: 'HOLD_WINDOW_EMPTY'};
    }

    // Elapsed endpoints are not evidence coverage. A dropped chunk (or merely two
    // samples several seconds apart) used to satisfy the duration gate and then
    // get weighted as a full hold. Require continuous sampling through the whole
    // measured window before any metric is computed.
    if (window[0].timeUs - measureStartUs > limits.maximumHoldSampleGapUs) {
      return {rejected: 'HOLD_SAMPLE_GAP_TOO_LARGE'};
    }
    for (let index = 1; index < window.length; index += 1) {
      const gapUs = window[index].timeUs - window[index - 1].timeUs;
      if (!(gapUs > 0) || gapUs > limits.maximumHoldSampleGapUs) {
        return {rejected: 'HOLD_SAMPLE_GAP_TOO_LARGE'};
      }
    }

    // Explicit loop, not `Math.max(...window.map(...))`: a two-minute hover is a
    // hundred thousand samples and spreading them threw RangeError. See `extremes`.
    //
    // KEPT AFTER STAGE 5b AS A GUARD, and said plainly how little now reaches it.
    // `detectHoldSegments` ends a segment at the sample before any input on
    // another axis over this same limit, read the same way (`offAxisCommandAt`),
    // so no sample of a detected segment can trip it. The window below is taken
    // by TIME rather than by index, though, and records whose timestamps run
    // backwards can put a sample from outside the segment inside its time range;
    // that is the one path left, a decoded log does not produce it, and a test
    // builds it by hand to show the guard still fires.
    let offAxisPeak = 0;
    for (const record of window) {
      const {peak} = offAxisCommandAt(record, axisIndex);
      if (peak > offAxisPeak) {
        offAxisPeak = peak;
      }
    }
    if (offAxisPeak > limits.offAxisCommandLimitDps) {
      return {rejected: 'HOLD_OFF_AXIS_INPUT'};
    }

    const headspeeds = window.map(record => record.headspeed);
    if (headspeeds.some(value => !Number.isFinite(value)
        || value < limits.minimumPlausibleHeadspeedRpm
        || value > limits.maximumPlausibleHeadspeedRpm)) {
      return {rejected: 'HOLD_HEADSPEED_INVALID'};
    }

    const headspeedMedian = quantile(headspeeds, 0.5);
    const headspeedVariationRatio = spanRatio(headspeeds, headspeedMedian);
    if (Number.isFinite(headspeedVariationRatio)
        && headspeedVariationRatio > limits.maximumHeadspeedVariationRatio) {
      // Governor activity moves the whole airframe's response; it would be read as
      // a tune change that never happened.
      return {rejected: 'HOLD_HEADSPEED_UNSTABLE'};
    }

    const batteries = window.map(record => record.vbat);
    const batteryMedian = quantile(batteries, 0.5);
    const batteryVariationRatio = spanRatio(batteries, batteryMedian);
    if (Number.isFinite(batteryVariationRatio)
        && batteryVariationRatio > limits.maximumBatteryVariationRatio) {
      return {rejected: 'HOLD_BATTERY_UNSTABLE'};
    }

    const times = window.map(record => record.timeUs);
    const errors = window.map(
      record => record.setpoint[axisIndex] - record.gyro[axisIndex]
    );
    const iTerms = window.map(record => record.terms?.[termIndex]);

    const setpointMedian = quantile(
      window.map(record => record.setpoint[axisIndex]),
      0.5
    );
    const steadyStateErrorDps = mean(errors);
    const errorCentre = steadyStateErrorDps ?? 0;

    // Hunting is measured on the smoothed error. On raw gyro error, sensor noise
    // dominates the crossing count and masquerades as an I-term fault.
    const medianIntervalUs = quantile(
      times.slice(1).map((value, index) => value - times[index]),
      0.5
    );
    const smoothingSamples = Number.isFinite(medianIntervalUs) && medianIntervalUs > 0
      ? Math.round(limits.huntingSmoothingUs / medianIntervalUs)
      : 1;
    const smoothed = movingAverage(errors, smoothingSamples);

    const measuredDurationUs = endUs - measureStartUs;
    const measuredSeconds = measuredDurationUs / 1_000_000;

    // The drift, and whether it is a measurement or a fit artefact.
    //
    // The slope alone cannot be reported. A line fitted through a short window of
    // slow, correlated error is steep and meaningless: on the reference flight one
    // fitted a 21 deg/s change across a window whose error never left ±3 deg/s,
    // and another fitted 27.5 deg/s² with a standard error of 20.0. Both were
    // published as findings because nothing beside the number said how well it was
    // determined.
    //
    // Significance is computed against the *smoothed* error rather than the raw:
    // white sensor noise averages out of a slope estimate almost perfectly and
    // would flatter the fit, while the slow content is what actually makes a slope
    // uncertain. The comparison the fault report suggested — implied change versus
    // the error's observed excursion — was tried and does not separate these: on
    // every hold in the reference flight, artefact and genuine alike, the implied
    // change is smaller than the excursion (worst ratio 0.98), because a real
    // aircraft's error swings far wider than its mean. Only the uncertainty of the
    // fit tells them apart.
    const errorDriftDpsPerSecond = slopePerSecond(times, errors);
    const driftRatio = driftSignificance(
      times, smoothed, errorDriftDpsPerSecond, limits.huntingSmoothingUs
    );
    const errorDriftMeasurable = Number.isFinite(driftRatio) || driftRatio === Infinity
      ? driftRatio >= limits.driftSignificanceRatio
      : false;

    return {
      startTimeUs: start.timeUs,
      measureStartTimeUs: measureStartUs,
      endTimeUs: endUs,
      durationUs: segment.durationUs,
      measuredDurationUs,
      sampleCount: window.length,

      /**
       * How the steady stretch ended, from `detectHoldSegments`: an input on
       * another axis (`off-axis-input`, with the axis in `endedByAxis`), the
       * command leaving its band, a command that was not a number, or the end of
       * the records. Reported so a viewer can mark where an input elsewhere cut a
       * hold short rather than leave the pilot guessing why it is shorter than he
       * flew it.
       */
      endedBy: segment.endedBy ?? null,
      endedByAxis: segment.endedByAxis ?? null,

      // A hold at zero command is a heading or attitude hold; a hold at a sustained
      // rate is a constant-rate turn. Both test the I term, in different regimes.
      holdKind: Math.abs(setpointMedian) < limits.zeroHoldThresholdDps ? 'zero' : 'sustained',
      setpointMedianDps: round(setpointMedian, 4),

      /** Signed: the direction of a standing error is itself diagnostic. */
      steadyStateErrorDps: round(steadyStateErrorDps, 4),
      absoluteSteadyStateErrorDps: round(Math.abs(steadyStateErrorDps ?? 0), 4),

      /** Still moving means the loop has not finished converging. */
      errorDriftDpsPerSecond: round(errorDriftDpsPerSecond, 4),

      /**
       * How the drift above was judged, reported so it can be checked.
       *
       * `errorDriftImpliedChangeDps` is what that slope claims the error did
       * across this window; `errorDriftSignificance` is how many standard errors
       * the slope stands at. Only a drift with `errorDriftMeasurable` true reaches
       * the cross-hold summary — the rest are fits, not findings.
       */
      errorDriftImpliedChangeDps:
        round(Math.abs(errorDriftDpsPerSecond ?? 0) * measuredSeconds, 4),
      errorDriftSignificance: driftRatio === Infinity ? Infinity : round(driftRatio, 4),
      errorDriftMeasurable,

      /** Slow error left after removing the offset: the hunting component. */
      errorRippleRmsDps: round(rms(smoothed.map(value => value - errorCentre)), 4),
      errorCrossingRateHz: round(zeroCrossingRateHz(times, smoothed), 4),

      /** Fast content, kept separate so noise is reported as noise. */
      errorNoiseRmsDps: round(rms(errors.map((value, index) => value - smoothed[index])), 4),

      iTermMean: round(mean(iTerms), 4),
      iTermRms: round(rms(iTerms), 4),
      iTermDriftPerSecond: round(slopePerSecond(times, iTerms), 4),

      headspeedRpm: round(headspeedMedian, 2),
      headspeedVariationRatio: round(headspeedVariationRatio, 4),
      batteryMedian: round(batteryMedian, 4),
      batteryVariationRatio: round(batteryVariationRatio, 4)
    };
  }

  /** The two kinds of hold, as `measureHold` names them. */
  const HOLD_KINDS = Object.freeze(['zero', 'sustained']);

  /**
   * The cross-hold summary of `holds`, or null when there are none.
   *
   * Every mean is weighted by measured duration. A hold is a sample of steady
   * state, and a 16 s sample is not one observation of the same worth as a 0.41 s
   * one — it is forty times the evidence. The unweighted mean is how a single
   * 0.41 s window, whose slope was not distinguishable from zero, outvoted two
   * long holds and carried an axis to "increase I".
   *
   * One function for the pooled summary and for each kind's (Stage 5b), so the
   * two cannot be computed two ways.
   */
  function summarizeHolds(holds) {
    if (holds.length === 0) {
      return null;
    }
    const weights = holds.map(hold => hold.measuredDurationUs);
    const across = (field, subset = holds) => round(
      weightedMean(
        subset.map(hold => hold[field]),
        subset.map(hold => hold.measuredDurationUs)
      ),
      4
    );

    // Only holds whose drift stands above its own uncertainty. A slope that is not
    // separable from zero contributes nothing rather than contributing noise.
    const driftHolds = holds.filter(hold => hold.errorDriftMeasurable);
    const worstError = extremes(holds.map(hold => hold.absoluteSteadyStateErrorDps));

    return {
      holdCount: holds.length,
      zeroHoldCount: holds.filter(hold => hold.holdKind === 'zero').length,
      sustainedHoldCount: holds.filter(hold => hold.holdKind === 'sustained').length,
      totalMeasuredDurationUs: weights.reduce((total, weight) => total + weight, 0),

      meanSteadyStateErrorDps: across('steadyStateErrorDps'),
      meanAbsoluteSteadyStateErrorDps: across('absoluteSteadyStateErrorDps'),
      worstAbsoluteSteadyStateErrorDps: worstError === null ? null : round(worstError.highest, 4),

      /**
       * Null when no hold's drift was separable from its own uncertainty.
       *
       * Null is the point. A number here is a claim that the error was going
       * somewhere, and on flights where no window is long enough to support that
       * claim the honest report is that the drift was not measured — not the mean
       * of several slopes that each mean nothing.
       */
      meanErrorDriftDpsPerSecond:
        driftHolds.length === 0 ? null : across('errorDriftDpsPerSecond', driftHolds),
      driftMeasuredHoldCount: driftHolds.length,

      meanErrorRippleRmsDps: across('errorRippleRmsDps'),
      meanErrorCrossingRateHz: across('errorCrossingRateHz'),
      meanErrorNoiseRmsDps: across('errorNoiseRmsDps'),
      meanITermRms: across('iTermRms'),
      meanITermDriftPerSecond: across('iTermDriftPerSecond')
    };
  }

  /**
   * Builds I-term evidence from every usable hold in `records`.
   *
   * @param {object[]} records  record contract described at the top of this file
   * @param {object}   selection `{axis, term}` — `term` selects which controller
   *   contribution is tracked; hold evidence is about the I term but the machinery
   *   is term-agnostic
   */
  function buildHoldEvidence(records, selection, options = {}) {
    const limits = {...EVIDENCE_LIMITS, ...options.limits};
    const codes = [];

    const axisIndex = axisIndexOf(selection?.axis);
    const termIndex = termIndexOf(selection?.term ?? 'I');
    if (axisIndex === -1) {
      return Object.freeze({
        schemaVersion: PID_EVIDENCE_SCHEMA_VERSION,
        kind: HOLD_EVIDENCE_KIND,
        status: 'inconclusive',
        codes: ['AXIS_INVALID'],
        holds: []
      });
    }

    const segments = detectHoldSegments(records, axisIndex, {limits});
    const holds = [];
    const rejections = {};
    // WHERE each refused segment was, not only how many (2 October 2026). Every
    // axis is analysed over the same records, and a still hover is a hold on all
    // three, so a count summed across axes counts one hover three times. The
    // windows let a caller count physical segments instead.
    const rejectedHolds = [];
    let clippedSegmentCount = 0;

    for (const segment of segments) {
      // A HOLD THAT TOUCHES THE EDGE OF THE RECORDS IS NOT A MEASURED HOLD.
      //
      // Added 13 August 2026, when the flight window went live. `ui/app.mjs` now
      // trims the session to a detected takeoff before building records, so the
      // first sample this function sees is wherever that trim landed. Sweeping the
      // trim start across the reference flight, roll's I-term evidence read
      // captured / 2 holds at 18, 20, 22.76 and 24 seconds and inconclusive / 1 at
      // 0 and 26 — non-monotonically, because the edge segment appears or does not
      // depending on where the cut falls. The detected window (22.762337 s) landed
      // inside the captured region, so the flight's second hold was an artefact of
      // the trim, and under the 12 August product decision an artefact of the trim
      // was about to become a recommendation.
      //
      // ONLY THE START. The two edges are not the same problem and treating them
      // alike was the first draft's mistake. A segment that runs to the LAST
      // sample was entered from a command change this array contains, so its
      // settle skip is real and every measurement taken inside it is taken over
      // fully observed samples; all that is unknown is how much longer it went on,
      // and that changes no number. A segment that begins at the FIRST sample has
      // a fictitious start: the command's history is unknown, so the duration is a
      // lower bound rather than a measurement and the settle skip is being applied
      // to an instant that may be the middle of a manoeuvre. Dropped rather than
      // shortened, and counted so the pilot is told a hold was seen and not used.
      if (segment.clippedAtStart) {
        clippedSegmentCount += 1;
        continue;
      }
      const measured = measureHold(records, segment, axisIndex, termIndex, limits);
      if (measured.rejected) {
        rejections[measured.rejected] = (rejections[measured.rejected] ?? 0) + 1;
        rejectedHolds.push(Object.freeze({
          startTimeUs: records[segment.startIndex].timeUs,
          endTimeUs: records[segment.endIndex].timeUs,
          reason: measured.rejected
        }));
        continue;
      }
      holds.push(measured);
    }

    if (clippedSegmentCount > 0) {
      addCode(codes, 'CLIPPED_BY_WINDOW');
    }

    if (holds.length < limits.minimumHolds) {
      addCode(codes, 'INSUFFICIENT_HOLD_SEGMENTS');
    }
    for (const rejection of Object.keys(rejections)) {
      addCode(codes, rejection);
    }

    // Only holds whose drift stands above its own uncertainty. A slope that is not
    // separable from zero contributes nothing rather than contributing noise.
    if (holds.length > 0 && !holds.some(hold => hold.errorDriftMeasurable)) {
      addCode(codes, 'DRIFT_NOT_SEPARABLE_FROM_ERROR');
    }

    const summary = summarizeHolds(holds);

    // EACH KIND OF HOLD SUMMARISED ON ITS OWN (Stage 5b). A hold at zero rate and
    // a hold at a steady rate test the integrator in two different regimes, and
    // `interpretHoldEvidence` and `compareHoldEvidence` now read each kind
    // separately instead of refusing a flight that has both. The pooled `summary`
    // above stays, unchanged, for every reader that takes one.
    const kinds = {};
    for (const holdKind of HOLD_KINDS) {
      const ofKind = holds.filter(hold => hold.holdKind === holdKind);
      kinds[holdKind] = Object.freeze({
        holdCount: ofKind.length,
        status: ofKind.length >= limits.minimumHolds
          ? 'captured'
          : (ofKind.length > 0 ? 'inconclusive' : 'absent'),
        summary: summarizeHolds(ofKind)
      });
    }

    return Object.freeze({
      schemaVersion: PID_EVIDENCE_SCHEMA_VERSION,
      kind: HOLD_EVIDENCE_KIND,
      axis: selection.axis,
      term: selection?.term ?? 'I',
      status: holds.length >= limits.minimumHolds ? 'captured' : 'inconclusive',
      codes,
      holds,
      summary,
      kinds: Object.freeze(kinds),
      /** Holds that ended at an input on another axis rather than on their own. */
      offAxisEndedHoldCount: holds.filter(hold => hold.endedBy === 'off-axis-input').length,
      rejectedHoldCounts: rejections,
      /** Each refused segment's extent and reason, in the order they were found. */
      rejectedHolds: Object.freeze(rejectedHolds),

      /**
       * Steady segments that ran off the start or the end of the records and were
       * therefore not measured. Reported so "there were no holds" and "there were
       * holds and the window cut them" never read the same on a screen.
       */
      clippedSegmentCount,

      /**
       * The settings these numbers were measured through, carried with them.
       *
       * `interpretHoldEvidence` tests the crossing rate against a frequency band,
       * and that rate is a property of the smoothing window used here. When the
       * two were chosen independently a caller could smooth at 222 ms and have the
       * result judged against a band derived for 148 ms — which on the reference
       * flight turned roll's "no conclusion" into a confident "decrease". Stamping
       * them means the interpretation is always measured through the filter it was
       * derived for.
       */
      measurement: Object.freeze({
        huntingBandHz: Object.freeze([...limits.huntingBandHz]),
        huntingSmoothingUs: limits.huntingSmoothingUs,
        minimumHoldMeasureUs: limits.minimumHoldMeasureUs,
        driftSignificanceRatio: limits.driftSignificanceRatio
      })
    });
  }

  /**
   * The sizes `interpretHoldEvidence` reads holds against, by default. Exported so
   * a sentence that quotes one — "under the 2 deg/s that would have been read"
   * — quotes the number actually used rather than a copy of it (round three).
   */
  const HOLD_READING_THRESHOLDS = Object.freeze({
    /** A mean error over the holds above this is a standing error. */
    errorDps: 3,
    /** A measured drift above this, deg/s per second, is still converging. */
    driftDpsPerSecond: 1.5,
    /** The slow part's RMS about its mean above this is movement worth reading. */
    huntingRippleDps: 2
  });

  function holdKindOfSummary(summary) {
    const zero = summary?.zeroHoldCount;
    const sustained = summary?.sustainedHoldCount;
    if (!Number.isFinite(zero) || !Number.isFinite(sustained)) {
      return null;
    }
    if (zero > 0 && sustained === 0) {
      return 'zero';
    }
    if (sustained > 0 && zero === 0) {
      return 'sustained';
    }
    return null;
  }

  /**
   * The evidence for each kind of hold in a capture, as captures of their own:
   * `[{kind, holdCount, evidence}]`, one entry per kind with at least one hold.
   * Null when a capture pools both kinds and carries no per-kind split — one
   * built before Stage 5b — because then nothing can be read per kind.
   */
  function evidenceByKind(evidence) {
    if (evidence.kinds && typeof evidence.kinds === 'object') {
      const out = [];
      for (const holdKind of HOLD_KINDS) {
        const entry = evidence.kinds[holdKind];
        if (!entry || !(entry.holdCount > 0) || !entry.summary) {
          continue;
        }
        out.push({
          kind: holdKind,
          holdCount: entry.holdCount,
          evidence: {
            ...evidence,
            status: entry.status,
            holds: (evidence.holds ?? []).filter(hold => hold.holdKind === holdKind),
            summary: entry.summary
          }
        });
      }
      return out;
    }
    const only = holdKindOfSummary(evidence.summary);
    return only === null
      ? null
      : [{kind: only, holdCount: evidence.summary.holdCount ?? null, evidence}];
  }

  const CONFIDENCE_ORDER = Object.freeze(['none', 'low', 'medium', 'high']);

  function lowerConfidence(left, right) {
    return CONFIDENCE_ORDER.indexOf(left) <= CONFIDENCE_ORDER.indexOf(right) ? left : right;
  }

  /**
   * Interprets hold evidence as an indication about the I term.
   *
   * Field names here deliberately avoid instruction words (`delta`, `direction`,
   * `recommendation`). This is a measurement, and nothing downstream should be
   * able to mistake it for something to write to an aircraft.
   *
   * Deliberately conservative: it reports `hold` unless the evidence separates the
   * two failure modes cleanly. A standing error that never crosses zero is too
   * little I; error that keeps crossing zero at a low rate is too much. Evidence
   * showing both, or neither, is not a recommendation.
   *
   * EACH KIND OF HOLD IS READ ON ITS OWN (Stage 5b, 4 October 2026). Until then a
   * flight with holds at zero rate AND holds at a steady rate was refused whole
   * (HOLD_KIND_MISMATCH): a hover and a turn test the integrator in different
   * regimes, and averaging them describes neither. Each kind with at least
   * `minimumHolds` holds is now read by itself, by the same rules and thresholds
   * as before — a standing error still needs three holds of THAT kind — and:
   *
   *   - one kind readable: its reading is the axis's. A kind with too few holds
   *     to read is set aside and says so (HOLDS_OF_ONE_KIND_TOO_FEW_TO_READ);
   *   - both readable and agreeing: one reading over both, at the lower of the two
   *     confidences, carrying every code either raised;
   *   - both readable and DISAGREEING: refused (I_TERM_HOLDS_KINDS_DISAGREE).
   *     Something differs between hovering and turning that this flight cannot
   *     name, and a caller must not turn it into a mechanical claim either. The
   *     brief asked for this where both kinds have three holds; it is applied
   *     wherever both can be read, because a kind read from two holds can still
   *     say "decrease" (hunting is read from two holds, as before), and an
   *     all-clear over the hovers beside turns that hunt is the
   *     confident-and-wrong answer. The one exception is the completeness rule
   *     itself: a kind whose only objection to the other's standing error is that
   *     it had too few holds for one — on the same side — has contradicted
   *     nothing, and the standing error is read
   *     (OTHER_KIND_TOO_FEW_FOR_A_STANDING_ERROR);
   *   - neither readable (one hold of each): nothing is read
   *     (TOO_FEW_HOLDS_OF_EITHER_KIND).
   *
   * The result names the kind it was read from (`kind`: 'zero', 'sustained',
   * 'both' or null) and carries each kind's own reading in `kinds`. A capture
   * built before Stage 5b, which pools both kinds with no split, is still refused
   * whole with HOLD_KIND_MISMATCH. No real flight in the 31-flight corpus has a
   * steady-rate hold of 5 s or more, so the per-kind paths rest on synthetic
   * wiring tests and add no threshold.
   *
   * The caller owns what to do with this. Nothing here writes to an aircraft.
   */
  function interpretHoldEvidence(evidence, options = {}) {
    if (!evidence || evidence.kind !== HOLD_EVIDENCE_KIND) {
      return Object.freeze({indication: 'hold', confidence: 'none', codes: ['EVIDENCE_KIND_MISMATCH']});
    }
    if (evidence.status !== 'captured' || !evidence.summary) {
      return Object.freeze({
        indication: 'hold',
        confidence: 'none',
        codes: evidence.codes ?? ['EVIDENCE_INCONCLUSIVE']
      });
    }

    const byKind = evidenceByKind(evidence);
    if (byKind === null) {
      return Object.freeze({
        indication: 'hold',
        confidence: 'none',
        codes: Object.freeze([...new Set([...(evidence.codes ?? []), 'HOLD_KIND_MISMATCH'])]),
        kind: null,
        kinds: null
      });
    }

    const readable = byKind.filter(entry => entry.evidence.status === 'captured');
    const kinds = {zero: null, sustained: null};
    for (const entry of readable) {
      kinds[entry.kind] = Object.freeze({
        ...interpretOneKind(entry.evidence, options),
        holdCount: entry.holdCount
      });
    }
    const frozenKinds = Object.freeze(kinds);

    if (readable.length === 0) {
      return Object.freeze({
        indication: 'hold',
        confidence: 'none',
        codes: Object.freeze([...new Set([...(evidence.codes ?? []), 'TOO_FEW_HOLDS_OF_EITHER_KIND'])]),
        kind: null,
        kinds: frozenKinds
      });
    }

    const setAside = byKind.length > readable.length ? ['HOLDS_OF_ONE_KIND_TOO_FEW_TO_READ'] : [];
    if (readable.length === 1) {
      const only = kinds[readable[0].kind];
      return Object.freeze({
        indication: only.indication,
        confidence: only.confidence,
        codes: Object.freeze([...only.codes, ...setAside]),
        kind: readable[0].kind,
        kinds: frozenKinds
      });
    }

    const [first, second] = readable.map(entry => kinds[entry.kind]);
    if (first.indication === second.indication) {
      return Object.freeze({
        indication: first.indication,
        confidence: lowerConfidence(first.confidence, second.confidence),
        codes: Object.freeze([...new Set([...first.codes, ...second.codes])]),
        kind: 'both',
        kinds: frozenKinds
      });
    }
    // ONE EXCEPTION, and it is the completeness rule rather than a new one. A
    // standing error is read only from `minimumHoldsForStandingError` holds of a
    // kind. When one kind reads it and the other's ONLY objection is that it had
    // fewer — its own holds on the same side, each clear of its own movement, as
    // TOO_FEW_HOLDS_FOR_A_STANDING_ERROR certifies — the second kind has not
    // contradicted anything it can measure, and the first kind's reading stands.
    const standing = readable.find(entry => kinds[entry.kind].indication === 'increase');
    const other = readable.find(entry => entry !== standing);
    if (standing && other) {
      const sideOf = entry => Math.sign(entry.evidence.summary?.meanSteadyStateErrorDps ?? 0);
      const otherReading = kinds[other.kind];
      if (otherReading.indication === 'hold'
          && otherReading.codes.includes('TOO_FEW_HOLDS_FOR_A_STANDING_ERROR')
          && sideOf(other) !== 0 && sideOf(other) === sideOf(standing)) {
        const reading = kinds[standing.kind];
        return Object.freeze({
          indication: reading.indication,
          confidence: reading.confidence,
          codes: Object.freeze([...reading.codes, 'OTHER_KIND_TOO_FEW_FOR_A_STANDING_ERROR']),
          kind: standing.kind,
          kinds: frozenKinds
        });
      }
    }
    return Object.freeze({
      indication: 'hold',
      confidence: 'none',
      codes: Object.freeze([...new Set([...(evidence.codes ?? []), 'I_TERM_HOLDS_KINDS_DISAGREE'])]),
      kind: null,
      kinds: frozenKinds
    });
  }

  /**
   * The reading of holds that are all of one kind: what `interpretHoldEvidence`
   * did for every capture until Stage 5b, unchanged.
   */
  function interpretOneKind(evidence, options) {
    const codes = [];

    const {
      errorDpsThreshold = HOLD_READING_THRESHOLDS.errorDps,
      driftDpsPerSecondThreshold = HOLD_READING_THRESHOLDS.driftDpsPerSecond,
      // I-term hunting is slow. A band, not a floor: on a real flight the error
      // crossed at 5 Hz, which is frame or tail resonance, and a floor-only test
      // called it an I-term fault. Anything faster than a few Hz is something the
      // I term did not cause and lowering the I term will not fix.
      //
      // UNITS, corrected 2 October 2026: this band is an oscillation frequency, and
      // a crossing rate is halved before it is tested against it. Whether "crossed
      // at 5 Hz" above was a crossing rate (a 2.5 Hz oscillation, now inside the
      // band) or a frequency was not recorded, and that flight was not re-checked.
      //
      // Defaulted from the capture, not restated here. The smoothing window that
      // produces `meanErrorCrossingRateHz` is derived from this band's top edge; a
      // band redefined only in this signature would silently be measured through a
      // filter tuned for a different one.
      huntingBandHz: declaredBandHz =
        evidence.measurement?.huntingBandHz ?? EVIDENCE_LIMITS.huntingBandHz,
      huntingRippleDps = HOLD_READING_THRESHOLDS.huntingRippleDps
    } = options;

    // The filter caps what may be blamed on the I term. Crossings are counted on a
    // box average whose −3 dB corner sits at 0.443/L; content above that corner is
    // attenuated before it is ever counted, so a rate observed through a long
    // filter cannot be claimed as in-band merely because the band says so. Taking
    // the lower of the two is one-directional on purpose: a shorter filter reveals
    // more, but it must not widen what the I term is held responsible for.
    const smoothingUs =
      evidence.measurement?.huntingSmoothingUs ?? EVIDENCE_LIMITS.huntingSmoothingUs;
    const observableTopHz = smoothingUs > 0
      ? 0.443 / (smoothingUs / 1_000_000)
      : declaredBandHz[1];
    const huntingBandHz = [declaredBandHz[0], Math.min(declaredBandHz[1], observableTopHz)];

    const summary = evidence.summary;
    const standingError = summary.meanAbsoluteSteadyStateErrorDps > errorDpsThreshold;

    // A drift claim needs a drift that was actually measured. `buildHoldEvidence`
    // leaves this null when no hold's fitted slope stood above its own standard
    // error, and null must not fall through to a comparison against zero — the
    // reference flight's "still drifting" verdicts came from slopes that were
    // indistinguishable from no drift at all.
    const driftMeasured = summary.driftMeasuredHoldCount > 0
      && Number.isFinite(summary.meanErrorDriftDpsPerSecond);
    const drifting = driftMeasured
      && Math.abs(summary.meanErrorDriftDpsPerSecond) > driftDpsPerSecondThreshold;
    if (!driftMeasured) {
      addCode(codes, 'DRIFT_NOT_SEPARABLE_FROM_ERROR');
    }

    const crossingRate = summary.meanErrorCrossingRateHz ?? 0;
    const ripple = summary.meanErrorRippleRmsDps ?? 0;
    const noise = summary.meanErrorNoiseRmsDps ?? 0;

    // The band is a band of oscillation FREQUENCY; the crossing rate counts sign
    // changes, two per cycle. Until 2 October 2026 the two were compared directly,
    // which halved the band in effect to about 0.15-1.5 Hz: a 0.2 Hz wander below
    // the floor read as hunting, and a 2 Hz hunt inside the band read as nothing.
    const oscillationHz = crossingRate / CROSSINGS_PER_CYCLE;
    const inHuntingBand = oscillationHz >= huntingBandHz[0] && oscillationHz <= huntingBandHz[1];
    // The slow component must actually stand above what was filtered out, or the
    // "oscillation" is the tail of the noise rather than a signal.
    const hunting = inHuntingBand && ripple > huntingRippleDps && ripple > noise;

    if (!inHuntingBand && oscillationHz > huntingBandHz[1] && ripple > huntingRippleDps) {
      addCode(codes, 'OSCILLATION_ABOVE_I_TERM_BAND');
    }
    // The mirror of the above, added 2 October 2026 with the units correction: the
    // slow part of the error DID move, by more than the ripple threshold and above
    // the noise, but slower than the band's floor — the pilot, the wind, a governor,
    // or a drift. Not an I-term reading either way; recorded so that "within
    // tolerance" is never read as "the error did not move".
    const slowMovement = !inHuntingBand && oscillationHz < huntingBandHz[0]
      && ripple > huntingRippleDps && ripple > noise;
    if (slowMovement) {
      addCode(codes, 'SLOW_MOVEMENT_BELOW_I_TERM_BAND');
    }
    // A SLOW RIPPLE NO LARGER THAN THE NOISE (2 October 2026, round three). At or
    // below the band top the slow part moved by more than the threshold, and was
    // refused as hunting, or as a wander, only because it did not stand above
    // what the filter removed. That is "it could not be told from the noise", not
    // "it did not move" — and it carried no code at all, so the all-clear took it:
    // the review found in-band ripples of 11-24 deg/s RMS cleared that way.
    const rippleWithinNoise = oscillationHz <= huntingBandHz[1]
      && ripple > huntingRippleDps && ripple <= noise;
    if (rippleWithinNoise) {
      addCode(codes, 'SLOW_RIPPLE_NOT_CLEAR_OF_NOISE');
    }

    // A STANDING ERROR MUST STAND CLEAR OF THE SLOW MOVEMENT AROUND IT (2 October
    // 2026, round two of the review of the units correction). A movement slower
    // than the window does not average out of a hold's mean: each hold keeps part
    // of a cycle, up to the movement's own size, so an error with NO standing
    // component reads several deg/s of "standing error". With the band in the
    // right units nothing else stood between that and "increase", and on a closed
    // loop it was "Raise yaw I" on a healthy integrator pushed by a hunting
    // governor, a belt or the wind — a 30 deg/s RMS wander described as an error
    // that "sat off the commanded rate and stayed there".
    //
    // So a mean is read as standing only where it is LARGER than the slow part's
    // own RMS about it: a clean standing error has almost no slow ripple (0.003
    // deg/s on the no-integrator fixture against a 4.65 deg/s mean), and across
    // the 0.06-0.29 Hz sweep that found this, a healthy loop's wander had a ripple
    // from about three to thirty times its mean.
    // A ramp from zero — a loop still converging — has a mean of 1.7 times its
    // ripple and is still read. A wander much slower than the hold is not
    // separable from a slowly varying standing torque by any rule on one window;
    // that is the integrator's own job, and it is still read as one.
    //
    // Exempt above the band: an oscillation at f leaves at most A/(pi f T) in a
    // T-second mean — under 3% of its amplitude at 3 Hz over a 5 s hold — so it
    // cannot manufacture a standing error. It CAN hide a hunt under it, though,
    // which this rule is not about: below, the per-hold rule refuses that where
    // the oscillation moves more than the mean, and STANDING_ERROR_WITH_UNMEASURED_
    // BAND where it moves less.
    const slowEnoughToLeaveAMean = oscillationHz <= huntingBandHz[1];
    const standingClearOfMovement = !slowEnoughToLeaveAMean
      || summary.meanAbsoluteSteadyStateErrorDps > ripple;

    if (standingError) {
      addCode(codes, 'STEADY_STATE_ERROR_PRESENT');
    }
    if (drifting) {
      addCode(codes, 'STEADY_STATE_ERROR_DRIFTING');
    }
    if (hunting) {
      addCode(codes, 'LOW_FREQUENCY_HUNTING');
    }

    // Both signatures at once is not "a bit of each" — it usually means something
    // outside the I term (mechanical bind, tail authority, governor) is moving the
    // aircraft, and raising or lowering a gain would chase it.
    if (hunting && standingError) {
      addCode(codes, 'CONFLICTING_HOLD_SIGNATURES');
      return Object.freeze({indication: 'hold', confidence: 'low', codes});
    }

    if (hunting) {
      return Object.freeze({indication: 'decrease', confidence: 'medium', codes});
    }

    // A standing error or a drift that the slow movement could have left behind
    // is not evidence about the integrator. Not a judgement either way.
    if ((standingError || drifting) && !standingClearOfMovement) {
      addCode(codes, 'STANDING_ERROR_NOT_CLEAR_OF_SLOW_MOVEMENT');
      return Object.freeze({indication: 'hold', confidence: 'low', codes});
    }

    if (standingError || drifting) {
      // ...AND IT MUST STAND IN EVERY HOLD, ON THE SAME SIDE (round three). The
      // rule above compares means over all the holds, and over a short hold a
      // slice of a slow cycle has a mean larger than its own ripple — so a healthy
      // integrator pushed by a 0.06-0.10 Hz torque, flown as ordinary 5.5-8 s
      // holds, was still told "Raise I". See `standingErrorRefusal`.
      const refusal = standingErrorRefusal(evidence.holds ?? [],
        options.minimumHoldsForStandingError ?? EVIDENCE_LIMITS.minimumHoldsForStandingError);
      if (refusal) {
        for (const code of refusal) {
          addCode(codes, code);
        }
        return Object.freeze({indication: 'hold', confidence: 'low', codes});
      }
      // ...AND NOT BESIDE A BAND NOTHING COULD SEE INTO (3 October 2026, the
      // re-review of round three). A standing error with an in-band hunt beside it
      // is the conflicting signature, refused above — but only where the hunt was
      // SEEN. Under an oscillation above the band, which dominates the crossing
      // count, or a slow ripple no larger than the noise, a hunt is neither read
      // nor ruled out; and a cover that moved LESS than the mean in every hold
      // passed every rule above, so "increase" here was reached by elimination. The
      // review laid a 6-15 Hz torque, or 50-400 deg/s of gyro noise, smaller than
      // the standing error, over an aircraft with no integrator AND an in-band
      // wobble, and got "Raise I" in 2 and 10 of 40 flights.
      //
      // A fast oscillation too small to register — its slow part under
      // `huntingRippleDps`, so neither code is set — is a measurement that would
      // have seen a hunt of that size beside the error, and is still read.
      if (rippleWithinNoise || codes.includes('OSCILLATION_ABOVE_I_TERM_BAND')) {
        addCode(codes, 'STANDING_ERROR_WITH_UNMEASURED_BAND');
        return Object.freeze({indication: 'hold', confidence: 'low', codes});
      }
      return Object.freeze({
        indication: 'increase',
        confidence: standingError && drifting ? 'medium' : 'low',
        codes
      });
    }

    // The error moved, slower than the band. Nothing about the I term was read
    // from it, so this is not "within tolerance" either — that code is a
    // positive measurement of an error that did not move, and this one did.
    if (slowMovement) {
      return Object.freeze({indication: 'hold', confidence: 'low', codes});
    }

    // NOR WHERE NOTHING COULD HAVE BEEN SEEN (round three). A slow ripple no larger
    // than the noise was not told from it; and an oscillation above the band
    // dominates the crossing count, so whatever moved more slowly under it — a
    // hunt, a wander — was never measured. Neither is a measurement of an error
    // that did not move, which is the only thing the code below may say.
    if (rippleWithinNoise || codes.includes('OSCILLATION_ABOVE_I_TERM_BAND')) {
      return Object.freeze({indication: 'hold', confidence: 'low', codes});
    }

    // A positive measurement: the error's mean stayed under the standing-error
    // threshold, and its slow part moved by no more than `huntingRippleDps` RMS —
    // a size this measurement would have seen at any frequency the band admits.
    addCode(codes, 'HOLD_EVIDENCE_WITHIN_TOLERANCE');
    return Object.freeze({indication: 'hold', confidence: 'medium', codes});
  }

  /**
   * Why a standing error over these holds is NOT read as one — the codes that say
   * so — or null when it is.
   *
   * Added 2 October 2026, round three of the review. A real shortfall of I is
   * CONSISTENT: the integrator leaves the same error, on the same side of the
   * command, every time the aircraft is held. A slow wander — a governor hunting,
   * a belt, the wind — puts a slice of its cycle in each hold's mean, and the
   * slices change side as the cycle turns: [19.8, -26.0, 25.2, -23.0, 18.6,
   * -13.1] deg/s on the review's healthy loop, against [-4.7] six times over with
   * no integrator. So, in order:
   *
   *   1. Every hold's mean must be larger than the slow part's own movement in
   *      that hold (STANDING_ERROR_NOT_CLEAR_IN_EVERY_HOLD). This includes a
   *      fast oscillation: it cannot manufacture a mean, but it hides a hunt
   *      under it, and a standing error with a hunt is the conflicting signature,
   *      which is refused — "Raise I" was given to an aircraft with no integrator
   *      and an in-band wobble once a 12 Hz vibration was laid over it. This rule
   *      refuses that only where the oscillation moves MORE than the mean; where
   *      it moves less, `interpretHoldEvidence` refuses it after this one
   *      (STANDING_ERROR_WITH_UNMEASURED_BAND, re-review of 3 October 2026).
   *   2. Every hold must sit on the same side of the command
   *      (STANDING_ERROR_CHANGES_SIDE_BETWEEN_HOLDS). The side is the error's own
   *      sign, for holds at zero and at a rate alike. The review suggested
   *      normalising a turn's error to its direction; measured on the closed
   *      loop, that refused 25 of 89 flights with no integrator against a
   *      steady torque — every one of them turns flown both ways — and, of 120
   *      healthy flights whose turns alternated in step with a wander, passed 28
   *      of the 57 the round-two rule had read as "increase". An error that
   *      changes side exactly with the stick is named for what it is
   *      (STANDING_ERROR_FOLLOWS_COMMAND_DIRECTION), with the side it was on in
   *      every turn, in that turn's own direction (re-review of 3 October 2026):
   *      the rate short of the command in every turn — a loop lagging behind
   *      each one — or past it in every turn, which is what a feedforward set too
   *      high does (RATE_SHORT_OF_COMMAND_IN_EVERY_TURN, RATE_PAST_COMMAND_IN_
   *      EVERY_TURN). Either way a wander in step with the turns does the same,
   *      and these holds cannot separate them.
   *   3. At least `minimum` holds (TOO_FEW_HOLDS_FOR_A_STANDING_ERROR); see
   *      `EVIDENCE_LIMITS.minimumHoldsForStandingError`.
   *
   * What it cannot do: an open-loop wander so slow that every hold sits on one
   * side of it is, on these holds, a slowly varying standing torque, and is read
   * as one. On the closed loop the round-three sweep flew (0.03-0.30 Hz, 3-8
   * holds 6.5-12 s apart) rule 1 caught every one of those, because the hold
   * nearest the wander's crossing moves more than it averages.
   */
  function standingErrorRefusal(holds, minimum) {
    const errors = holds.map(hold => hold.steadyStateErrorDps);
    if (holds.some(hold => !(Math.abs(hold.steadyStateErrorDps) > hold.errorRippleRmsDps))) {
      return ['STANDING_ERROR_NOT_CLEAR_IN_EVERY_HOLD'];
    }
    const allAbove = values => values.every(value => value > 0);
    const allBelow = values => values.every(value => value < 0);
    if (!allAbove(errors) && !allBelow(errors)) {
      const directions = holds.map(hold =>
        (hold.holdKind === 'sustained' ? Math.sign(hold.setpointMedianDps) : 0));
      if (directions.includes(1) && directions.includes(-1)) {
        // Setpoint minus gyro, in each turn's own direction: positive is a rate
        // short of the command, negative a rate past it.
        const inTurn = errors.map((error, index) => error * directions[index]);
        if (allAbove(inTurn)) {
          return ['STANDING_ERROR_FOLLOWS_COMMAND_DIRECTION', 'RATE_SHORT_OF_COMMAND_IN_EVERY_TURN'];
        }
        if (allBelow(inTurn)) {
          return ['STANDING_ERROR_FOLLOWS_COMMAND_DIRECTION', 'RATE_PAST_COMMAND_IN_EVERY_TURN'];
        }
      }
      return ['STANDING_ERROR_CHANGES_SIDE_BETWEEN_HOLDS'];
    }
    if (holds.length < minimum) {
      return ['TOO_FEW_HOLDS_FOR_A_STANDING_ERROR'];
    }
    return null;
  }

  const COMPARED_HOLD_METRICS = Object.freeze([
    'meanAbsoluteSteadyStateErrorDps',
    'worstAbsoluteSteadyStateErrorDps',
    'meanErrorDriftDpsPerSecond',
    'meanErrorRippleRmsDps',
    'meanErrorCrossingRateHz',
    'meanITermRms'
  ]);

  /**
   * The change in each compared metric between two hold summaries, and the
   * verdict on the steady-state error when `verdictAllowed`. The tolerance
   * discipline every hold comparison uses, whatever it is comparing.
   */
  function compareSummaries(from, to, limits, verdictAllowed) {
    const codes = [];
    const changes = {};
    for (const metric of COMPARED_HOLD_METRICS) {
      const before = from?.[metric];
      const after = to?.[metric];
      if (!Number.isFinite(before) || !Number.isFinite(after)) {
        changes[metric] = null;
        continue;
      }
      const difference = after - before;
      const relative = before === 0 ? null : difference / Math.abs(before);
      changes[metric] = {
        baseline: before,
        test: after,
        difference: round(difference, 4),
        relative: round(relative, 4),
        significant: Number.isFinite(relative)
          ? Math.abs(relative) > limits.comparisonToleranceRatio
          : null
      };
    }

    const errorChange = changes.meanAbsoluteSteadyStateErrorDps;

    // A RELATIVE TOLERANCE ALONE IS NOT A RESULT.
    //
    // See `holdErrorNoiseFloorDps`. On its own, `significant` fired on six of six
    // real flight pairs where the pilot had changed nothing, because a 78%
    // relative move in a metric whose value is 0.03 deg/s is 0.023 deg/s. The
    // verdict now needs the move to clear the measured flight-to-flight floor as
    // well, and when it does not, the code says so rather than the verdict
    // silently reading like a tolerance miss.
    const floorDps = limits.holdErrorNoiseFloorDps;
    const clearsNoiseFloor = Number.isFinite(errorChange?.difference)
      && Number.isFinite(floorDps)
      && Math.abs(errorChange.difference) > floorDps;

    if (errorChange) {
      // Recorded on the change itself so a caller reading one metric sees the two
      // gates separately rather than a single boolean it has to guess the meaning
      // of. The object is rebuilt rather than mutated: `changes` is handed out.
      changes.meanAbsoluteSteadyStateErrorDps = {...errorChange, clearsNoiseFloor};
    }

    let verdict = 'unchanged';
    if (verdictAllowed && errorChange?.significant && clearsNoiseFloor) {
      verdict = errorChange.difference < 0 ? 'improved' : 'worsened';
    } else if (errorChange?.significant) {
      codes.push('CHANGE_BELOW_MEASURED_NOISE_FLOOR');
    }
    return {changes, verdict, codes};
  }

  /** Compares two hold captures. Same tolerance discipline as the stop comparison. */
  function compareHoldEvidence(baseline, test, options = {}) {
    const limits = {...EVIDENCE_LIMITS, ...options.limits};
    const codes = [];

    if (!baseline || !test
        || baseline.kind !== HOLD_EVIDENCE_KIND || test.kind !== HOLD_EVIDENCE_KIND) {
      return Object.freeze({
        schemaVersion: PID_EVIDENCE_SCHEMA_VERSION,
        kind: HOLD_EVIDENCE_KIND,
        status: 'inconclusive',
        codes: ['EVIDENCE_KIND_MISMATCH'],
        changes: {}
      });
    }

    if (baseline.axis !== test.axis) {
      addCode(codes, 'AXIS_MISMATCH');
    }
    if (baseline.term !== test.term) {
      addCode(codes, 'TERM_MISMATCH');
    }
    if (baseline.status !== 'captured' || test.status !== 'captured') {
      addCode(codes, 'HOLD_EVIDENCE_INCONCLUSIVE');
      return Object.freeze({
        schemaVersion: PID_EVIDENCE_SCHEMA_VERSION,
        kind: HOLD_EVIDENCE_KIND,
        axis: baseline.axis,
        status: 'inconclusive',
        codes,
        changes: {}
      });
    }
    if (codes.includes('AXIS_MISMATCH') || codes.includes('TERM_MISMATCH')) {
      return Object.freeze({
        schemaVersion: PID_EVIDENCE_SCHEMA_VERSION,
        kind: HOLD_EVIDENCE_KIND,
        axis: baseline.axis,
        status: 'inconclusive',
        codes,
        changes: {}
      });
    }

    // WITHIN EACH KIND OF HOLD (Stage 5b, 4 October 2026). Comparing a heading
    // hold against a constant-rate turn would be comparing two different tests and
    // calling the difference a result, so until Stage 5b any capture with both
    // kinds was refused whole. Each kind that BOTH sides captured (two holds or
    // more of it on each) is now compared with itself. One kind compared: its
    // verdict is the comparison's. Both compared and agreeing: that verdict. Both
    // compared and moving opposite ways: no verdict
    // (HOLD_COMPARISON_KINDS_DISAGREE). No kind on both sides, or a capture from
    // before Stage 5b that pools both kinds with no split: HOLD_KIND_MISMATCH, as
    // before. `changes` is over everything compared; each kind's own is in `kinds`.
    const baselineKinds = evidenceByKind(baseline);
    const testKinds = evidenceByKind(test);
    const comparedKinds = baselineKinds === null || testKinds === null
      ? []
      : HOLD_KINDS.filter(holdKind =>
        baselineKinds.some(entry => entry.kind === holdKind && entry.evidence.status === 'captured')
        && testKinds.some(entry => entry.kind === holdKind && entry.evidence.status === 'captured'));
    const kindOf = (list, holdKind) => list.find(entry => entry.kind === holdKind).evidence.summary;

    const kinds = {zero: null, sustained: null};
    for (const holdKind of comparedKinds) {
      const from = kindOf(baselineKinds, holdKind);
      const to = kindOf(testKinds, holdKind);
      const one = compareSummaries(from, to, limits, true);
      kinds[holdKind] = Object.freeze({
        changes: one.changes,
        verdict: one.verdict,
        codes: Object.freeze(one.codes),
        holdCounts: Object.freeze({baseline: from.holdCount, test: to.holdCount})
      });
    }

    // What both sides cover: one kind's summaries, or the whole of each.
    const single = comparedKinds.length === 1;
    const pooled = compareSummaries(
      single ? kindOf(baselineKinds, comparedKinds[0]) : baseline.summary,
      single ? kindOf(testKinds, comparedKinds[0]) : test.summary,
      limits, comparedKinds.length > 0
    );
    const changes = pooled.changes;

    let verdict = 'unchanged';
    if (comparedKinds.length === 0) {
      addCode(codes, 'HOLD_KIND_MISMATCH');
      for (const code of pooled.codes) {
        addCode(codes, code);
      }
    } else {
      const verdicts = comparedKinds.map(holdKind => kinds[holdKind].verdict);
      for (const holdKind of comparedKinds) {
        for (const code of kinds[holdKind].codes) {
          addCode(codes, code);
        }
      }
      if (verdicts.every(value => value === verdicts[0])) {
        verdict = verdicts[0];
      } else {
        addCode(codes, 'HOLD_COMPARISON_KINDS_DISAGREE');
      }
    }
    const status = codes.includes('HOLD_KIND_MISMATCH')
      || codes.includes('HOLD_COMPARISON_KINDS_DISAGREE') ? 'inconclusive' : 'captured';

    const countsOf = side => (single
      ? kindOf(side === 'baseline' ? baselineKinds : testKinds, comparedKinds[0]).holdCount
      : (side === 'baseline' ? baseline : test).summary?.holdCount ?? null);

    return Object.freeze({
      schemaVersion: PID_EVIDENCE_SCHEMA_VERSION,
      kind: HOLD_EVIDENCE_KIND,
      axis: baseline.axis,
      status,
      codes,
      changes,
      verdict,

      /** The kinds of hold compared, each with itself. Empty when none could be. */
      comparedKinds: Object.freeze(comparedKinds),
      kinds: Object.freeze(kinds),

      /**
       * How many hold segments each side's verdict rests on: of the one kind
       * compared, or of the whole capture when both kinds were.
       *
       * Reported rather than gated on here — see `minimumComparisonHolds`. Without
       * this a caller cannot tell a verdict resting on one hold each side from one
       * resting on twenty, and in this corpus the former is the common case.
       */
      holdCounts: Object.freeze({
        baseline: countsOf('baseline'),
        test: countsOf('test')
      }),

      /** The floor the verdict was measured against, carried with the verdict. */
      noiseFloorDps: limits.holdErrorNoiseFloorDps
    });
  }


  return {
    PID_EVIDENCE_SCHEMA_VERSION: PID_EVIDENCE_SCHEMA_VERSION,
    AXES: AXES,
    TERMS: TERMS,
    DIRECTIONS: DIRECTIONS,
    DIRECTIONAL_EVIDENCE_KIND: DIRECTIONAL_EVIDENCE_KIND,
    HOLD_EVIDENCE_KIND: HOLD_EVIDENCE_KIND,
    HUNTING_BAND_HZ: HUNTING_BAND_HZ,
    EVIDENCE_LIMITS: EVIDENCE_LIMITS,
    HOLDS_FOR_A_FULL_READING: HOLDS_FOR_A_FULL_READING,
    mean: mean,
    extremes: extremes,
    weightedMean: weightedMean,
    rms: rms,
    quantile: quantile,
    spanRatio: spanRatio,
    slopePerSecond: slopePerSecond,
    driftSignificance: driftSignificance,
    CROSSINGS_PER_CYCLE: CROSSINGS_PER_CYCLE,
    zeroCrossingRateHz: zeroCrossingRateHz,
    movingAverage: movingAverage,
    axisIndexOf: axisIndexOf,
    termIndexOf: termIndexOf,
    buildDirectionalStopEvidence: buildDirectionalStopEvidence,
    describeDirectionalComparison: describeDirectionalComparison,
    compareDirectionalStopEvidence: compareDirectionalStopEvidence,
    detectHoldSegments: detectHoldSegments,
    HOLD_KINDS: HOLD_KINDS,
    buildHoldEvidence: buildHoldEvidence,
    HOLD_READING_THRESHOLDS: HOLD_READING_THRESHOLDS,
    interpretHoldEvidence: interpretHoldEvidence,
    compareHoldEvidence: compareHoldEvidence
  };
}));
