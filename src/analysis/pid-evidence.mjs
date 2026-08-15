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

export const PID_EVIDENCE_SCHEMA_VERSION = 1;

export const AXES = Object.freeze(['roll', 'pitch', 'yaw']);
export const TERMS = Object.freeze(['P', 'I', 'D']);
export const DIRECTIONS = Object.freeze(['positive', 'negative']);

export const DIRECTIONAL_EVIDENCE_KIND = 'rotorlens-directional-stop-evidence';
export const HOLD_EVIDENCE_KIND = 'rotorlens-hold-evidence';

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
export const HUNTING_BAND_HZ = Object.freeze([0.3, 3.0]);

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
export const EVIDENCE_LIMITS = Object.freeze({
  /** Stops needed *per direction*, not in total. */
  minimumStopsPerDirection: 2,

  /** Above this, the two directions are not describing the same aircraft behavior. */
  directionalAsymmetryWarnRatio: 0.30,

  /** A hold's command must stay inside this band around its median. */
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

  /** |median setpoint| under this makes it a hold at zero — heading/attitude hold. */
  zeroHoldThresholdDps: 10,

  /** Off-axis command above this means the pilot was not holding one axis. */
  offAxisCommandLimitDps: 30,

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

// ---------------------------------------------------------------------------
// Small numeric helpers. Kept local so this module stays dependency-free.
// ---------------------------------------------------------------------------

function finiteValues(values) {
  return values.filter(value => Number.isFinite(value));
}

export function mean(values) {
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
export function extremes(values) {
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
export function weightedMean(values, weights) {
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

export function rms(values) {
  const finite = finiteValues(values);
  if (finite.length === 0) {
    return null;
  }
  const total = finite.reduce((sum, value) => sum + value * value, 0);
  return Math.sqrt(total / finite.length);
}

export function quantile(values, fraction) {
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
export function spanRatio(values, reference) {
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
export function slopePerSecond(timesUs, values) {
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
export function driftSignificance(timesUs, slowValues, slopePerSec, correlationFloorUs) {
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
 * Sign changes per second of a mean-removed signal.
 *
 * Steady offset and slow hunting both raise the average error magnitude, but
 * only hunting keeps crossing zero — which is what separates "not enough I" from
 * "too much I".
 */
export function zeroCrossingRateHz(timesUs, values) {
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
export function movingAverage(values, count) {
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

export function axisIndexOf(axis) {
  return AXES.indexOf(axis);
}

export function termIndexOf(term) {
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
export function buildDirectionalStopEvidence(events, options = {}) {
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
export function describeDirectionalComparison(evidence) {
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
export function compareDirectionalStopEvidence(baseline, test, options = {}) {
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
 * Finds spans where the command on `axisIndex` is steady long enough to expose
 * steady-state behavior.
 *
 * A hold ends as soon as the command leaves the band around the value it started
 * with — extending it through a command change would blend two different
 * operating points into one average.
 */
export function detectHoldSegments(records, axisIndex, options = {}) {
  const limits = {...EVIDENCE_LIMITS, ...options.limits};
  const segments = [];

  if (!Array.isArray(records) || records.length === 0) {
    return segments;
  }

  let startIndex = null;
  let reference = null;

  const closeSegment = endIndex => {
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
        clippedAtEnd: endIndex === records.length - 1
      });
    }
  };

  for (let index = 0; index < records.length; index += 1) {
    const setpoint = records[index].setpoint?.[axisIndex];

    if (!Number.isFinite(setpoint)) {
      closeSegment(index - 1);
      startIndex = null;
      reference = null;
      continue;
    }

    if (startIndex === null) {
      startIndex = index;
      reference = setpoint;
      continue;
    }

    if (Math.abs(setpoint - reference) > limits.holdSetpointBandDps) {
      closeSegment(index - 1);
      startIndex = index;
      reference = setpoint;
    }
  }

  closeSegment(records.length - 1);
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
  const others = offAxisIndexes(axisIndex);
  let offAxisPeak = 0;
  for (const record of window) {
    const first = Math.abs(record.setpoint?.[others[0]] ?? 0);
    const second = Math.abs(record.setpoint?.[others[1]] ?? 0);
    if (first > offAxisPeak) {
      offAxisPeak = first;
    }
    if (second > offAxisPeak) {
      offAxisPeak = second;
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

/**
 * Builds I-term evidence from every usable hold in `records`.
 *
 * @param {object[]} records  record contract described at the top of this file
 * @param {object}   selection `{axis, term}` — `term` selects which controller
 *   contribution is tracked; hold evidence is about the I term but the machinery
 *   is term-agnostic
 */
export function buildHoldEvidence(records, selection, options = {}) {
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

  // Every cross-hold mean below is weighted by measured duration. A hold is a
  // sample of steady state, and a 16 s sample is not one observation of the same
  // worth as a 0.41 s one — it is forty times the evidence. The unweighted mean
  // is how a single 0.41 s window, whose slope was not distinguishable from
  // zero, outvoted two long holds and carried an axis to "increase I".
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
  if (holds.length > 0 && driftHolds.length === 0) {
    addCode(codes, 'DRIFT_NOT_SEPARABLE_FROM_ERROR');
  }

  const worstError = extremes(holds.map(hold => hold.absoluteSteadyStateErrorDps));

  const summary = holds.length === 0 ? null : {
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

  return Object.freeze({
    schemaVersion: PID_EVIDENCE_SCHEMA_VERSION,
    kind: HOLD_EVIDENCE_KIND,
    axis: selection.axis,
    term: selection?.term ?? 'I',
    status: holds.length >= limits.minimumHolds ? 'captured' : 'inconclusive',
    codes,
    holds,
    summary,
    rejectedHoldCounts: rejections,

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
 * The caller owns what to do with this. Nothing here writes to an aircraft.
 */
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

export function interpretHoldEvidence(evidence, options = {}) {
  const codes = [];

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
  if (holdKindOfSummary(evidence.summary) === null) {
    return Object.freeze({
      indication: 'hold',
      confidence: 'none',
      codes: Object.freeze([...new Set([...(evidence.codes ?? []), 'HOLD_KIND_MISMATCH'])])
    });
  }

  const {
    errorDpsThreshold = 3,
    driftDpsPerSecondThreshold = 1.5,
    // I-term hunting is slow. A band, not a floor: on a real flight the error
    // crossed at 5 Hz, which is frame or tail resonance, and a floor-only test
    // called it an I-term fault. Anything faster than a few Hz is something the
    // I term did not cause and lowering the I term will not fix.
    //
    // Defaulted from the capture, not restated here. The smoothing window that
    // produces `meanErrorCrossingRateHz` is derived from this band's top edge; a
    // band redefined only in this signature would silently be measured through a
    // filter tuned for a different one.
    huntingBandHz: declaredBandHz =
      evidence.measurement?.huntingBandHz ?? EVIDENCE_LIMITS.huntingBandHz,
    huntingRippleDps = 2
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

  const inHuntingBand = crossingRate >= huntingBandHz[0] && crossingRate <= huntingBandHz[1];
  // The slow component must actually stand above what was filtered out, or the
  // "oscillation" is the tail of the noise rather than a signal.
  const hunting = inHuntingBand && ripple > huntingRippleDps && ripple > noise;

  if (!inHuntingBand && crossingRate > huntingBandHz[1] && ripple > huntingRippleDps) {
    addCode(codes, 'OSCILLATION_ABOVE_I_TERM_BAND');
  }

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

  if (standingError || drifting) {
    return Object.freeze({
      indication: 'increase',
      confidence: standingError && drifting ? 'medium' : 'low',
      codes
    });
  }

  addCode(codes, 'HOLD_EVIDENCE_WITHIN_TOLERANCE');
  return Object.freeze({indication: 'hold', confidence: 'medium', codes});
}

/** Compares two hold captures. Same tolerance discipline as the stop comparison. */
export function compareHoldEvidence(baseline, test, options = {}) {
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

  const compared = [
    'meanAbsoluteSteadyStateErrorDps',
    'worstAbsoluteSteadyStateErrorDps',
    'meanErrorDriftDpsPerSecond',
    'meanErrorRippleRmsDps',
    'meanErrorCrossingRateHz',
    'meanITermRms'
  ];

  const changes = {};
  for (const metric of compared) {
    const from = baseline.summary[metric];
    const to = test.summary[metric];
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
      significant: Number.isFinite(relative)
        ? Math.abs(relative) > limits.comparisonToleranceRatio
        : null
    };
  }

  // Comparing a heading hold against a constant-rate turn would be comparing two
  // different tests and calling the difference a result.
  const baselineKind = holdKindOfSummary(baseline.summary);
  const testKind = holdKindOfSummary(test.summary);
  if (baselineKind === null || testKind === null || baselineKind !== testKind) {
    addCode(codes, 'HOLD_KIND_MISMATCH');
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
  if (!codes.includes('HOLD_KIND_MISMATCH')
      && errorChange?.significant && clearsNoiseFloor) {
    verdict = errorChange.difference < 0 ? 'improved' : 'worsened';
  } else if (errorChange?.significant) {
    addCode(codes, 'CHANGE_BELOW_MEASURED_NOISE_FLOOR');
  }

  return Object.freeze({
    schemaVersion: PID_EVIDENCE_SCHEMA_VERSION,
    kind: HOLD_EVIDENCE_KIND,
    axis: baseline.axis,
    status: codes.includes('HOLD_KIND_MISMATCH') ? 'inconclusive' : 'captured',
    codes,
    changes,
    verdict,

    /**
     * How many hold segments each side's verdict rests on.
     *
     * Reported rather than gated on here — see `minimumComparisonHolds`. Without
     * this a caller cannot tell a verdict resting on one hold each side from one
     * resting on twenty, and in this corpus the former is the common case.
     */
    holdCounts: Object.freeze({
      baseline: baseline.summary?.holdCount ?? null,
      test: test.summary?.holdCount ?? null
    }),

    /** The floor the verdict was measured against, carried with the verdict. */
    noiseFloorDps: floorDps
  });
}
