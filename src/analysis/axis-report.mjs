/**
 * Per-axis measurements and capture guidance for the viewer.
 *
 * Everything the tune evidence can conclude is gated behind a manoeuvre: stop
 * evidence needs clean releases, hold evidence needs steady segments. A flight
 * containing neither produces a blank panel, and a blank panel reads to a pilot
 * as "this app could not open my log" — which on a log that decoded perfectly is
 * the worst thing it could say.
 *
 * This module closes that gap in two ways.
 *
 * 1. **Something honest on every log.** Every Blackbox log carries a command and
 *    a measured rate on all three axes, so peak rates, tracking error and gyro
 *    noise are always available. They are reported here whatever else the flight
 *    did or did not contain.
 *
 * 2. **Why there is no evidence, and what would produce some.** The stop
 *    detector reports its diagnostics; this turns them into the difference
 *    between *this flight contains no such manoeuvre* and *your manoeuvre was
 *    rejected, at this gate* — and then names the manoeuvre that would yield a
 *    measurement.
 *
 * Telling a pilot what to FLY is not telling him what to CHANGE. Nothing here
 * produces, implies, or ranks a gain. Every sentence it emits is either a
 * measurement of the flight it was given or an instruction for capturing a
 * better one, and the copy says which.
 *
 * Pure and platform-neutral like the rest of `src/`: no I/O, no globals, no
 * `node:` imports, no `Buffer`. It runs in Node, a browser and a WebView from
 * one copy.
 */

// Namespace imports, deliberately.
//
// A named import of an export that has been renamed is a link-time failure: the
// whole module graph refuses to load, and in the viewer that is a blank screen
// rather than a missing number. These two modules carry the thresholds this one
// only reads, and they are tuned independently of it. Reading them through a
// namespace means a rename degrades a label, not the app.
import * as records from './records.mjs';
import * as evidence from './pid-evidence.mjs';

export const AXES = Object.freeze(['roll', 'pitch', 'yaw']);

/**
 * Averaging window used to split a gyro trace into "what the airframe did" and
 * "what is above it".
 *
 * 10 ms, so the residual is content faster than roughly 50 Hz. That is well
 * above any rate a pilot commands or a helicopter's rigid-body response
 * produces, so what is left is vibration and sensor noise rather than flight.
 * Deliberately a box average: its behaviour follows from the window length,
 * which matters more here than a sharp cutoff.
 *
 * **UNCONSTRAINED BY REAL DATA.** The 10 ms is a design choice and nothing
 * measures it. Swept over 33 real flights (two airframes, two board models, each
 * flight measured inside its own resolved flight window) the residual RMS rises
 * monotonically with the box length and sits on no plateau anywhere — median
 * across the flights, in deg/s:
 *
 *            2 ms    5 ms   10 ms   20 ms   40 ms   80 ms
 *   roll     0.634   0.851  1.409   2.854   4.880   5.627
 *   pitch    0.248   0.313  0.459   0.773   0.928   1.252
 *   yaw      0.326   0.428  0.538   0.777   1.122   1.665
 *
 * So the reported noise floor is set by this window as much as by the airframe,
 * and a figure taken at one window is not comparable with one taken at another.
 * That is the same defect `FAST_WINDOW_US` has in `records.mjs`, in a different
 * module and for the same reason: an RMS over a window is a function of the
 * window. The window length is published on every result as
 * `highFrequencyWindowUs` so a caller can never quote the number without it.
 *
 * What the corpus does establish is the SCALE the emitted number lives on: at
 * the shipped 10 ms, per-flight residuals run 0.51 / 1.41 / 2.38 deg/s on roll
 * (min / median / max), 0.37 / 0.46 / 1.02 on pitch and 0.34 / 0.54 / 0.79 on
 * yaw. The two board models do NOT separate on it — RDMS NEXUS_XR median 1.40
 * against FRSK VANTAC_RF007 1.63 median on roll (1.28 is the second-smallest
 * of the six values, not their median) — so nothing here licenses
 * reading the figure as a property of the hardware.
 *
 * SETTLED BY: a log recorded with a known injected tone above 50 Hz at a known
 * amplitude, which is the only way to find out what fraction of it this window
 * actually passes. Until then the number is a comparison between flights taken
 * at the same window and nothing more.
 */
const HIGH_FREQUENCY_WINDOW_US = 10_000;

/**
 * |command| at or above this counts as the pilot actually asking for a rate.
 *
 * **UNCONSTRAINED BY REAL DATA.** 10°/s is a judgement, not a measurement. The
 * reference log (Rotorflight 4.6, Bell 222UT, 134 429 samples, 133.5 s) has no
 * elbow anywhere near it: the fraction of samples at or above a candidate
 * threshold falls smoothly and monotonically —
 *
 *   roll   1°/s 37.9%   2°/s 30.2%   5°/s 19.3%   10°/s 10.9%   15°/s 6.6%
 *          20°/s 4.0%   25°/s 2.5%   40°/s 1.0%
 *   pitch  1°/s 43.5%   5°/s 22.0%   10°/s 9.3%   20°/s 1.3%    25°/s 0.6%
 *   yaw    1°/s 18.7%   5°/s 16.0%   10°/s 14.3%  20°/s 10.1%   25°/s 9.4%
 *
 * — so no value in that range is picked out by the data. Nothing derives it and
 * nothing downstream validates it; it is here because a number was needed to
 * separate "flying" from "centred", and it is reported to the caller as
 * `movingCommandThresholdDps` so the screen can say which number it used.
 *
 * NO ELBOW EXISTS ON 33 REAL FLIGHTS EITHER — two airframes, two board models,
 * measured inside each flight's own window. Median share of samples at or above
 * a candidate threshold, in percent:
 *
 *            1     2     3     5     7    10    12    15    20    25    30
 *   roll   34.0  26.5  20.8  14.0   8.4   4.1   2.7   1.1   0.4   0.1   0.1
 *   pitch  45.8  37.1  29.8  18.8  10.8   5.5   3.5   1.9   0.6   0.1   0.0
 *   yaw     4.4   3.5   3.2   2.0   1.5   1.4   1.4   1.3   1.3   1.2   1.2
 *
 * On the cyclic axes the log-log slope steepens smoothly and without a break —
 * roll goes −0.36 (1→2 deg/s), −0.78 (3→5), −1.50 (5→7), −2.41 (7→10), −4.02
 * (10→12) — so the curve has no feature at 10 or anywhere near it, and one
 * airframe's smoothness is now three.
 *
 * YAW IS A DIFFERENT SHAPE, which the single reference flight could not show.
 * Its curve is nearly FLAT from 5 to 30 deg/s (slopes −0.79, −0.23, −0.15,
 * −0.16, −0.16, −0.15) because yaw is either centred or pirouetting with very
 * little in between. This constant therefore does something qualitatively
 * different per axis: on cyclic it cuts a smooth distribution at an arbitrary
 * point, on yaw it separates two populations that a wide range of values would
 * separate equally well.
 *
 * Its per-flight CONSEQUENCE varies enormously and is worth knowing before the
 * `movingSeconds` tile is compared between logs: at the shipped 10 deg/s the
 * moving-sample share runs 0.4% to 22.8% on roll, 1.0% to 14.6% on pitch and
 * 0.0% to 16.7% on yaw across the 33 flights.
 *
 * Nothing can make it correct — it is a display convention, not a measurement —
 * so the label is unchanged and it stays UNCONSTRAINED BY REAL DATA.
 *
 * It is load-bearing all the same. Moving it 10 → 25 cuts the roll
 * `movingSeconds` tile on that log from 14.55 s to about 3.3 s and moves
 * `trackingRmsWhileMovingDps` with it, so it is pinned by test rather than left
 * free: `test/axis-report.test.mjs` fixes both the exported value and the exact
 * set of samples it admits, including the boundary. The boundary is not
 * hypothetical — that log's setpoints are 100% integer-valued, and |command|
 * lands *exactly* on 10 in 1139 roll samples and 281 yaw samples, so `>=`
 * against `>` is a difference the real data can see.
 *
 * Changing it means changing the pinned consequence deliberately, in the same
 * commit, with a reason. It must not drift.
 */
const MOVING_COMMAND_DPS = 10;

/**
 * Below this the rotor is not turning, so nothing measured there describes
 * flight. Aligned with the hold evidence's own plausibility floor rather than
 * re-derived, so the two cannot drift apart.
 *
 * The reference log is a weak witness for this filter and must not be used as
 * one: only 4.4% of its samples sit below the floor, so removing the filter
 * moves its reported median from 1719 to 1716 rpm — three revolutions, invisible
 * on screen. The filter exists for the log shape that log does not contain, a
 * recording that spends most of its length on the ground, where the unfiltered
 * median is a spool-up value and not a headspeed at all. The test therefore
 * builds that shape explicitly rather than mirroring the reference log's
 * proportions; a fixture with the reference log's 4.4% cannot see this filter
 * work or fail.
 */
const SPINNING_HEADSPEED_RPM = evidence.EVIDENCE_LIMITS?.minimumPlausibleHeadspeedRpm ?? 300;

/**
 * Unfiltered-gyro field names, in preference order.
 *
 * Deliberately NOT `FIELD_MAP.raw`, which lists `debug[N]` as a last resort.
 * `debug[N]` is whatever the flight controller's current debug mode happens to
 * emit — on a real Rotorflight 4.6 log it carried headspeed, values from 1710 to
 * 1830, and differencing it against the gyro would have reported a 1700 deg/s
 * "noise floor". A noise number is worthless unless the field behind it is
 * certain, so this list contains only names that mean unfiltered gyro and
 * nothing else, and a log without one is reported as not having logged it.
 */
const UNFILTERED_GYRO_CANDIDATES = Object.freeze([
  Object.freeze(['gyroUnfilt[0]', 'gyroADCunfilt[0]', 'gyroRAW[0]']),
  Object.freeze(['gyroUnfilt[1]', 'gyroADCunfilt[1]', 'gyroRAW[1]']),
  Object.freeze(['gyroUnfilt[2]', 'gyroADCunfilt[2]', 'gyroRAW[2]'])
]);

function candidatesFor(key, axisIndex, fallback) {
  const map = records.FIELD_MAP?.[key];
  if (!map) {
    return fallback;
  }
  return Array.isArray(map[axisIndex]) ? map[axisIndex] : (Array.isArray(map) ? map : fallback);
}

function firstIndexOf(indexByName, candidates) {
  for (const candidate of candidates) {
    const index = indexByName.get(candidate);
    if (index !== undefined) {
      return {index, name: candidate};
    }
  }
  return null;
}

/**
 * Resolves the columns one axis needs, straight out of the decoded session.
 *
 * Deliberately does NOT go through `buildAnalysisRecords`. That allocates an
 * object and four arrays per sample — 45 MiB on a 134k-sample log, on top of the
 * 102 MiB the decode already holds — and the plot and the summary need four
 * columns, not a record contract. On a phone that difference is the difference
 * between a view that opens and one that is killed.
 *
 * @param {object} session a session from `decodeLog`
 * @param {string} axis `'roll' | 'pitch' | 'yaw'`
 */
export function resolveAxisSignals(session, axis) {
  const axisIndex = AXES.indexOf(axis);
  const fields = session?.fields ?? [];
  const indexByName = new Map(fields.map(field => [field.name, field.index]));
  const missing = [];

  if (axisIndex === -1) {
    return {axis, axisIndex: -1, usable: false, missing: ['axis'], names: {}};
  }

  const time = firstIndexOf(indexByName, candidatesFor('timeUs', axisIndex, ['time']));
  const setpoint = firstIndexOf(indexByName, candidatesFor(
    'setpoint', axisIndex, [`setpoint[${axisIndex}]`]
  ));
  const gyro = firstIndexOf(indexByName, candidatesFor(
    'gyro', axisIndex, [`gyroADC[${axisIndex}]`]
  ));
  const unfiltered = firstIndexOf(indexByName, UNFILTERED_GYRO_CANDIDATES[axisIndex]);
  const headspeed = firstIndexOf(indexByName, candidatesFor('headspeed', axisIndex, ['headspeed']));

  if (!time) missing.push('time');
  if (!setpoint) missing.push(`setpoint[${axisIndex}]`);
  if (!gyro) missing.push(`gyro[${axisIndex}]`);

  return {
    axis,
    axisIndex,
    usable: Boolean(time && setpoint && gyro),
    missing,
    timeIndex: time?.index ?? null,
    setpointIndex: setpoint?.index ?? null,
    gyroIndex: gyro?.index ?? null,
    unfilteredIndex: unfiltered?.index ?? null,
    headspeedIndex: headspeed?.index ?? null,
    names: {
      time: time?.name ?? null,
      setpoint: setpoint?.name ?? null,
      gyro: gyro?.name ?? null,
      unfiltered: unfiltered?.name ?? null,
      headspeed: headspeed?.name ?? null
    }
  };
}

/** Column of one field as a Float64Array. ~1 MiB per 134k samples, freed on return. */
function column(samples, index) {
  const out = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i][index];
    out[i] = Number.isFinite(value) ? value : Number.NaN;
  }
  return out;
}

/**
 * RMS of what a centred box average of `window` samples removes.
 *
 * The first and last half-window are skipped rather than averaged over a partial
 * window: a partial window is a different filter, and near an edge it leaves a
 * residual that is an artefact of the edge rather than a property of the signal.
 * Reporting that as noise is how a short span acquires an inflated noise floor.
 */
function highFrequencyRms(values, window) {
  const half = Math.floor(window / 2);
  if (!(half >= 1) || values.length < window + 2) {
    return null;
  }

  let running = 0;
  let counted = 0;
  for (let i = 0; i < window && i < values.length; i += 1) {
    if (Number.isFinite(values[i])) {
      running += values[i];
      counted += 1;
    }
  }

  let sumSquares = 0;
  let n = 0;
  for (let centre = half; centre < values.length - half; centre += 1) {
    const value = values[centre];
    if (counted > 0 && Number.isFinite(value)) {
      const residual = value - running / counted;
      sumSquares += residual * residual;
      n += 1;
    }

    const leaving = values[centre - half];
    const arriving = values[centre + half + 1];
    if (Number.isFinite(leaving)) {
      running -= leaving;
      counted -= 1;
    }
    if (Number.isFinite(arriving)) {
      running += arriving;
      counted += 1;
    }
  }

  return n === 0 ? null : Math.sqrt(sumSquares / n);
}

/** Median of at most `cap` evenly spaced finite values. */
function stridedMedian(values, cap = 4096, keep = () => true) {
  const stride = Math.max(1, Math.floor(values.length / cap));
  const picked = [];
  for (let i = 0; i < values.length; i += stride) {
    if (Number.isFinite(values[i]) && keep(values[i])) {
      picked.push(values[i]);
    }
  }
  if (picked.length === 0) {
    return null;
  }
  picked.sort((left, right) => left - right);
  return picked[(picked.length - 1) >> 1];
}

function medianIntervalUs(times) {
  const stride = Math.max(1, Math.floor(times.length / 4096));
  const gaps = [];
  for (let i = stride; i < times.length; i += stride) {
    const gap = (times[i] - times[i - stride]) / stride;
    if (Number.isFinite(gap) && gap > 0) {
      gaps.push(gap);
    }
  }
  if (gaps.length === 0) {
    return null;
  }
  gaps.sort((left, right) => left - right);
  return gaps[(gaps.length - 1) >> 1];
}

/**
 * Measurements that are available on any log, whatever was flown.
 *
 * Nothing here is gated behind a manoeuvre and nothing here is a verdict. These
 * are the quantities a pilot can check a trace against.
 *
 * @param {object} session a session from `decodeLog`
 * @param {object} signals from `resolveAxisSignals`
 */
export function summarizeAxis(session, signals) {
  const samples = session?.samples ?? [];
  if (!signals?.usable || samples.length === 0) {
    return null;
  }

  const defaults = records.STOP_DETECTION_DEFAULTS ?? {};
  const commandThresholdDps = defaults.commandThresholdDps ?? 80;
  const stopThresholdDps = defaults.stopThresholdDps ?? 20;
  const minimumCommandHoldUs = defaults.minimumCommandHoldUs ?? 150_000;

  const times = column(samples, signals.timeIndex);
  const setpoints = column(samples, signals.setpointIndex);
  const gyros = column(samples, signals.gyroIndex);

  const intervalUs = medianIntervalUs(times);
  const durationSeconds = samples.length > 1
    ? (times[times.length - 1] - times[0]) / 1e6
    : 0;

  let peakCommandDps = 0;
  let peakMeasuredDps = 0;
  let errorSquares = 0;
  let errorCount = 0;
  let movingSquares = 0;
  let movingCount = 0;
  let aboveCount = 0;

  // Excursions are counted with the detector's own two thresholds, so a command
  // that dithers around one of them is one excursion rather than a dozen.
  let excursionCount = 0;
  let inExcursion = false;
  let excursionStartUs = null;
  let longestAboveUs = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const command = setpoints[i];
    const measured = gyros[i];

    if (Number.isFinite(command)) {
      const magnitude = Math.abs(command);
      if (magnitude > peakCommandDps) {
        peakCommandDps = magnitude;
      }
      if (magnitude >= commandThresholdDps) {
        aboveCount += 1;
        if (!inExcursion) {
          inExcursion = true;
          excursionCount += 1;
          excursionStartUs = times[i];
        }
      } else if (inExcursion && magnitude <= stopThresholdDps) {
        inExcursion = false;
        if (Number.isFinite(excursionStartUs)) {
          longestAboveUs = Math.max(longestAboveUs, times[i] - excursionStartUs);
        }
      }
    }

    if (Number.isFinite(measured)) {
      const magnitude = Math.abs(measured);
      if (magnitude > peakMeasuredDps) {
        peakMeasuredDps = magnitude;
      }
    }

    if (Number.isFinite(command) && Number.isFinite(measured)) {
      const error = command - measured;
      errorSquares += error * error;
      errorCount += 1;
      if (Math.abs(command) >= MOVING_COMMAND_DPS) {
        movingSquares += error * error;
        movingCount += 1;
      }
    }
  }

  if (inExcursion && Number.isFinite(excursionStartUs)) {
    longestAboveUs = Math.max(longestAboveUs, times[times.length - 1] - excursionStartUs);
  }

  const window = Number.isFinite(intervalUs) && intervalUs > 0
    ? Math.max(3, Math.round(HIGH_FREQUENCY_WINDOW_US / intervalUs) | 1)
    : 3;

  const gyroHighFrequencyRmsDps = highFrequencyRms(gyros, window);
  let unfilteredHighFrequencyRmsDps = null;
  if (signals.unfilteredIndex !== null) {
    unfilteredHighFrequencyRmsDps = highFrequencyRms(
      column(samples, signals.unfilteredIndex), window
    );
  }

  let headspeedMedianRpm = null;
  if (signals.headspeedIndex !== null) {
    headspeedMedianRpm = stridedMedian(
      column(samples, signals.headspeedIndex), 4096,
      value => value >= SPINNING_HEADSPEED_RPM
    );
  }

  return {
    axis: signals.axis,
    sampleCount: samples.length,
    durationSeconds,
    sampleRateHz: Number.isFinite(intervalUs) && intervalUs > 0 ? 1e6 / intervalUs : null,

    peakCommandDps,
    peakMeasuredDps,

    /** Over the whole flight, including every sample where nothing was asked for. */
    trackingRmsDps: errorCount === 0 ? null : Math.sqrt(errorSquares / errorCount),
    /** Over the samples where a rate was actually being commanded. */
    trackingRmsWhileMovingDps: movingCount === 0 ? null : Math.sqrt(movingSquares / movingCount),
    movingSeconds: Number.isFinite(intervalUs) ? movingCount * intervalUs / 1e6 : null,
    movingCommandThresholdDps: MOVING_COMMAND_DPS,

    /** Content above ~50 Hz, which is vibration and sensor noise, not flight. */
    gyroHighFrequencyRmsDps,
    unfilteredHighFrequencyRmsDps,
    unfilteredFieldName: signals.names.unfiltered,
    highFrequencyWindowUs: HIGH_FREQUENCY_WINDOW_US,

    headspeedMedianRpm,

    /** How much of this flight was a command big enough for a stop to exist in. */
    secondsAboveCommandThreshold: Number.isFinite(intervalUs)
      ? aboveCount * intervalUs / 1e6
      : null,
    commandExcursionCount: excursionCount,
    longestCommandAboveThresholdUs: longestAboveUs,
    commandThresholdDps,
    minimumCommandHoldUs
  };
}

// ---------------------------------------------------------------------------
// Trace decimation
// ---------------------------------------------------------------------------

/** First sample index at or after `timeUs`, by binary search over the time column. */
export function indexAtOrAfter(samples, timeIndex, timeUs) {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (samples[mid][timeIndex] < timeUs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * Reduces one field over a sample range to per-column minima and maxima.
 *
 * The column count comes from the caller, which sizes it against the canvas's
 * measured width and the device pixel ratio. The previous plot decimated to a
 * hard-coded 1600 columns whatever the element was: on a 384 px phone that is
 * 4.17 backing-store pixels per CSS pixel, and a one-second step response
 * occupied under three pixels of screen.
 *
 * @returns {{min: Float64Array, max: Float64Array, low: number, high: number,
 *   columns: number, samplesPerColumn: number, empty: boolean}}
 */
export function decimate(samples, valueIndex, fromIndex, toIndex, columns) {
  const from = Math.max(0, Math.min(fromIndex, samples.length - 1));
  const to = Math.max(from, Math.min(toIndex, samples.length - 1));
  const span = to - from + 1;
  const count = Math.max(1, Math.min(columns, span));

  const min = new Float64Array(count).fill(Number.NaN);
  const max = new Float64Array(count).fill(Number.NaN);
  const perColumn = span / count;

  let low = Infinity;
  let high = -Infinity;

  for (let c = 0; c < count; c += 1) {
    const start = from + Math.floor(c * perColumn);
    const end = Math.min(to, from + Math.floor((c + 1) * perColumn));

    let columnMin = Infinity;
    let columnMax = -Infinity;
    for (let i = start; i <= end; i += 1) {
      const value = samples[i][valueIndex];
      if (!Number.isFinite(value)) {
        continue;
      }
      if (value < columnMin) columnMin = value;
      if (value > columnMax) columnMax = value;
    }

    if (columnMin !== Infinity) {
      min[c] = columnMin;
      max[c] = columnMax;
      if (columnMin < low) low = columnMin;
      if (columnMax > high) high = columnMax;
    }
  }

  return {
    min,
    max,
    columns: count,
    samplesPerColumn: perColumn,
    low: Number.isFinite(low) ? low : 0,
    high: Number.isFinite(high) ? high : 0,
    empty: !Number.isFinite(low)
  };
}

/** Round, human-readable gridline step covering `range` in about `target` steps. */
export function niceStep(range, target = 4) {
  if (!(range > 0) || !(target > 0)) {
    return 1;
  }
  const rough = range / target;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step = normalized < 1.5 ? 1 : normalized < 3.5 ? 2 : normalized < 7.5 ? 5 : 10;
  return step * magnitude;
}

// ---------------------------------------------------------------------------
// Capture briefs — what happened, and what to fly so something can be measured
// ---------------------------------------------------------------------------

/**
 * Plain-language readings of the stop detector's refusal codes.
 *
 * Each is a description of the signal, not a judgement of the pilot and not a
 * change to make. An unrecognised code falls through to a humanised form of the
 * code itself, so a detector that grows a new gate degrades to a readable label
 * rather than to a shouted enum.
 */
const STOP_REFUSAL_TEXT = Object.freeze({
  HOLD_TOO_SHORT: 'the command was not held long enough before it was released',
  RELEASE_DWELL: 'the command paused part-way back to centre instead of returning in one motion',
  RELEASE_TOO_SLOW: 'the command returned to centre too gradually to read as a release',
  RELEASE_NOT_MONOTONE: 'the command moved back up part-way through the release',
  RELEASE_REVERSED: 'the command carried on through centre into the other direction',
  COMMANDED_AGAIN_INSIDE_RESPONSE_WINDOW:
    'the next input arrived before the aircraft had finished settling',
  RESPONSE_WINDOW_PAST_END_OF_LOG: 'the log ends before the aircraft had finished settling',
  TOO_SOON_AFTER_PREVIOUS_STOP: 'it followed too soon after the previous stop to be a separate one',
  MEASUREMENT_WINDOW_EMPTY: 'there were too few samples around the stop to measure it',
  EVENT_CAP_REACHED: 'the per-flight limit on measured stops had already been reached'
});

const HOLD_REFUSAL_TEXT = Object.freeze({
  INSUFFICIENT_HOLD_SEGMENTS: 'the flight contains too few steady segments on this axis',
  HOLD_TOO_SHORT_AFTER_SETTLE: 'the steady segment was too short once settling time was removed',
  HOLD_WINDOW_EMPTY: 'there were too few samples left in the segment to measure',
  HOLD_OFF_AXIS_INPUT: 'another axis was being commanded during the hold',
  HOLD_HEADSPEED_INVALID: 'rotor speed was missing or implausible during the hold',
  HOLD_HEADSPEED_UNSTABLE: 'rotor speed moved during the hold, which moves the whole response',
  HOLD_BATTERY_UNSTABLE: 'pack voltage moved during the hold, which changes available authority'
});

function humanizeCode(code) {
  return String(code).toLowerCase().replace(/_/g, ' ');
}

export function explainStopRefusal(code) {
  return STOP_REFUSAL_TEXT[code] ?? humanizeCode(code);
}

export function explainHoldRefusal(code) {
  return HOLD_REFUSAL_TEXT[code] ?? humanizeCode(code);
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * The manoeuvre that would produce stop evidence on this axis.
 *
 * Every number in it is read from the detector's own defaults rather than
 * written here, so a pilot who flies to this brief is flying to the gates that
 * will actually judge him. A brief that drifts from the detector is worse than
 * none: it sends someone up to fly a manoeuvre that will be refused again.
 */
export function stopManoeuvre(axis) {
  const defaults = records.STOP_DETECTION_DEFAULTS ?? {};
  const commandDps = defaults.commandThresholdDps ?? 80;
  const holdSeconds = round((defaults.minimumCommandHoldUs ?? 150_000) / 1e6, 2);
  const quietSeconds = round((defaults.slowWindowUs?.[1] ?? 1_000_000) / 1e6, 1);
  const needed = evidence.EVIDENCE_LIMITS?.minimumStopsPerDirection ?? 2;
  const control = axis === 'yaw' ? 'pedal' : 'cyclic';
  const ways = axis === 'yaw'
    ? ['nose left', 'nose right']
    : axis === 'roll' ? ['left', 'right'] : ['forward', 'back'];

  return Object.freeze({
    axis,
    title: `To capture stop evidence on ${axis}`,
    steps: Object.freeze([
      `From steady flight, put in a definite ${axis} ${control} command — at least ` +
        `${commandDps}°/s, which is a deliberate input rather than a nudge.`,
      `Hold it steady for about a second. ${holdSeconds} s is the floor; longer is better.`,
      'Release it back to centre in one clean motion. Easing it off, or pausing part-way, ' +
        'is read as a change of command rather than a stop.',
      `Then leave the stick alone for ${quietSeconds} s while the aircraft settles. That ` +
        'second is the measurement.',
      `Repeat until you have ${needed} ${ways[0]} and ${needed} ${ways[1]}. Directions are ` +
        'never pooled, so each one needs its own.'
    ]),
    note: 'This says what to fly so there is something to measure. It is not a change ' +
      'to your aircraft or your setup.'
  });
}

/** The manoeuvre that would produce hold evidence, i.e. I-term evidence. */
export function holdManoeuvre(axis) {
  const limits = evidence.EVIDENCE_LIMITS ?? {};
  const settleSeconds = round((limits.holdSettleUs ?? 1_000_000) / 1e6, 1);
  const measureSeconds = round((limits.minimumHoldMeasureUs ?? 400_000) / 1e6, 1);
  const totalSeconds = round((limits.minimumHoldDurationUs ?? 1_400_000) / 1e6, 1);
  const needed = limits.minimumHolds ?? 2;
  const offAxis = limits.offAxisCommandLimitDps ?? 30;

  return Object.freeze({
    axis,
    title: `To capture hold evidence on ${axis}`,
    steps: Object.freeze([
      axis === 'yaw'
        ? 'Hold a heading, or a steady pirouette rate, with the pedals still.'
        : `Hold a steady ${axis} attitude, or a constant ${axis} rate, with the cyclic still.`,
      `Keep it for at least ${totalSeconds} s — the first ${settleSeconds} s is discarded so ` +
        `the previous input is not measured, leaving ${measureSeconds} s of steady state.`,
      `Keep the other two axes under ${offAxis}°/s while you do it. A correction on ` +
        'another axis moves this one too.',
      `Repeat until you have ${needed} such holds.`
    ]),
    note: 'This says what to fly so there is something to measure. It is not a change ' +
      'to your aircraft or your setup.'
  });
}

function refusalsFrom(counts) {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1])
    .map(([code, count]) => ({code, count, text: explainStopRefusal(code)}));
}

function tallyCandidates(entries) {
  const counts = {};
  for (const entry of entries) {
    if (entry && !entry.accepted && entry.reason) {
      counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
    }
  }
  return refusalsFrom(counts);
}

/**
 * Detector outcomes that mean the question could not be asked at all.
 *
 * Distinct from "nothing was flown": an axis with no finite samples is a
 * different log, not a different flight, and offering a manoeuvre brief for it
 * would send a pilot up to record a second log with the same field missing.
 */
const UNAVAILABLE_OUTCOMES = Object.freeze({
  NO_RECORDS: 'There are no samples in this session to look at.',
  AXIS_NOT_LOGGED: 'This axis carries no finite command samples in this log, so there is ' +
    'nothing to detect. Check that the Blackbox field set includes it.',
  UNKNOWN_AXIS: 'That axis is not one this analysis knows about.'
});

/**
 * Turns the detector's diagnostics into an answer to "why is this panel empty?".
 *
 * Five states, because collapsing any two of them is what makes the app look
 * broken:
 *
 *   captured     enough stops in both directions
 *   partial      at least one stop, short in a direction — nearly there
 *   rejected     the commands were big enough and every release was refused
 *   absent       no command in the flight was big enough for a stop to exist in
 *   unavailable  the question could not be asked: the axis is not in the log
 *
 * `absent` and `rejected` are the pair that matters most. They produce the same
 * empty table and call for opposite responses — a different flight, or a
 * different threshold — and deciding between them from an event count alone is
 * how a viewer ends up telling a pilot to re-fly a manoeuvre he already flew.
 *
 * The detector answers that itself in `diagnostics.diagnosis`, which is
 * preferred here over anything derivable from the counters; the counter path
 * survives only so that losing the field costs a sentence rather than the screen.
 *
 * @param {object} diagnostics `detectStopEvents(records, {axis, diagnostics: true})`
 * @param {object} [context] `{summary}` from `summarizeAxis`, used for the
 *   measured sentence; omitted, the numbers are simply absent
 */
export function describeStopCapture(diagnostics, context = {}) {
  const diagnosis = diagnostics?.diagnosis ?? null;
  const axis = context.axis ?? diagnosis?.axis ?? diagnostics?.axis ?? 'this axis';
  const needed = evidence.EVIDENCE_LIMITS?.minimumStopsPerDirection ?? 2;
  const events = diagnostics?.events ?? [];
  const counters = diagnostics?.counters ?? {};
  const candidates = diagnostics?.candidates ?? [];
  const summary = context.summary ?? null;

  const captured = {
    positive: events.filter(event => event?.commandSign === 'positive').length,
    negative: events.filter(event => event?.commandSign === 'negative').length
  };
  const total = captured.positive + captured.negative;
  const attempts = diagnosis?.candidatesOpened ?? counters.started ?? 0;

  // `diagnosis.rejections` counts every refusal; `candidates` is capped, so a
  // log that refuses ten thousand releases would otherwise report the first few
  // hundred as if they were all of them. Fall back only when it is absent.
  const refusals = diagnosis?.rejections
    ? refusalsFrom(diagnosis.rejections)
    : tallyCandidates(candidates);

  // The detector's own verdict on which question it was able to ask, when it
  // offers one. Deriving this downstream from counters is how a viewer ends up
  // telling a pilot to re-fly a manoeuvre he already flew, or offering a
  // manoeuvre brief for an axis the log does not contain.
  const unavailable = diagnosis && UNAVAILABLE_OUTCOMES[diagnosis.outcome];

  let state;
  if (unavailable) {
    state = 'unavailable';
  } else if (captured.positive >= needed && captured.negative >= needed) {
    state = 'captured';
  } else if (total > 0) {
    state = 'partial';
  } else if (diagnosis) {
    state = diagnosis.outcome === 'ALL_CANDIDATES_REJECTED' ? 'rejected' : 'absent';
  } else if (attempts > 0 || refusals.length > 0) {
    state = 'rejected';
  } else {
    state = 'absent';
  }

  const thresholdDps = diagnosis?.commandThresholdDps
    ?? summary?.commandThresholdDps
    ?? records.STOP_DETECTION_DEFAULTS?.commandThresholdDps ?? 80;
  const peakCommandDps = diagnosis?.peakCommandDps ?? summary?.peakCommandDps ?? null;
  const holdSeconds = round(
    (summary?.minimumCommandHoldUs
      ?? records.STOP_DETECTION_DEFAULTS?.minimumCommandHoldUs ?? 150_000) / 1e6, 2
  );

  let headline;
  if (unavailable) {
    headline = unavailable;
  } else if (state === 'captured') {
    headline = `${captured.positive} and ${captured.negative} stops captured, both directions ` +
      'measured separately.';
  } else if (state === 'partial') {
    headline = `${captured.positive} stop${captured.positive === 1 ? '' : 's'} one way and ` +
      `${captured.negative} the other. ${needed} each way are needed before the two ` +
      'directions can be compared, so nothing is concluded from these yet.';
  } else if (state === 'rejected') {
    const dominant = diagnosis?.dominantRejectionReason ?? refusals[0]?.code ?? null;
    headline = `This flight contains ${attempts} ${axis} command${attempts === 1 ? '' : 's'} ` +
      `above ${round(thresholdDps, 0)}°/s, and none of them ended in a release clean ` +
      'enough to measure.' +
      (dominant ? ` Most often, ${explainStopRefusal(dominant)}.` : '');
  } else if (Number.isFinite(peakCommandDps)) {
    headline = `The largest ${axis} command in this flight was ` +
      `${round(peakCommandDps, 0)}°/s. A stop is measured from a command of at ` +
      `least ${round(thresholdDps, 0)}°/s held for ${holdSeconds} s and then released, ` +
      `and this flight contains none on ${axis}. That is a fact about the flight, not a ` +
      'fault in it or in the aircraft.';
  } else {
    headline = `This flight contains no ${axis} command large enough for a stop to exist in.`;
  }

  return Object.freeze({
    axis,
    state,
    captured: Object.freeze(captured),
    needed,
    attemptCount: attempts,
    peakCommandDps,
    commandThresholdDps: thresholdDps,
    refusals: Object.freeze(refusals),
    headline,
    // No manoeuvre when the log itself is what is missing. Flying the aircraft
    // again will not add a field that was never enabled, and a brief that says
    // otherwise wastes a flight.
    manoeuvre: unavailable ? null : stopManoeuvre(axis),
    // Fly-this guidance is never a tuning change, and this is the sentence that
    // keeps that line visible on screen rather than only in this comment.
    boundary: 'Everything above is a measurement of the flight you opened. The manoeuvre ' +
      'below is how to record a flight that can be measured further — RotorLens does ' +
      'not tell you what to change, and never writes to a flight controller.'
  });
}

/** The same treatment for hold evidence, which is what measures the I term. */
export function describeHoldCapture(holdEvidence, context = {}) {
  const axis = context.axis ?? holdEvidence?.axis ?? 'this axis';
  const needed = evidence.EVIDENCE_LIMITS?.minimumHolds ?? 2;
  const holds = holdEvidence?.holds ?? [];
  const rejected = holdEvidence?.rejectedHoldCounts ?? {};

  const refusals = Object.entries(rejected)
    .sort((left, right) => right[1] - left[1])
    .map(([code, count]) => ({code, count, text: explainHoldRefusal(code)}));

  const state = holdEvidence?.status === 'captured'
    ? 'captured'
    : holds.length > 0 ? 'partial' : refusals.length > 0 ? 'rejected' : 'absent';

  let headline;
  if (state === 'captured') {
    headline = `${holds.length} steady holds measured on ${axis}.`;
  } else if (state === 'partial') {
    headline = `${holds.length} steady hold${holds.length === 1 ? '' : 's'} on ${axis}. ` +
      `${needed} are needed, so nothing is concluded from ${holds.length === 1 ? 'it' : 'them'} yet.`;
  } else if (state === 'rejected') {
    headline = `This flight contains steady segments on ${axis}, and none of them survived ` +
      'the checks that keep something other than the loop out of the measurement.';
  } else {
    headline = `This flight contains no steady ${axis} segment long enough to measure.`;
  }

  return Object.freeze({
    axis,
    state,
    holdCount: holds.length,
    needed,
    refusals: Object.freeze(refusals),
    headline,
    manoeuvre: holdManoeuvre(axis),
    boundary: 'Everything above is a measurement of the flight you opened. The manoeuvre ' +
      'below is how to record a flight that can be measured further — RotorLens does ' +
      'not tell you what to change, and never writes to a flight controller.'
  });
}

// ---------------------------------------------------------------------------
// What each term shows up in
// ---------------------------------------------------------------------------

/**
 * Which measured quantity carries each term's signature.
 *
 * This is what makes selecting P different from selecting D. It is a statement
 * about where a term is *visible*, which is a property of the control loop, not
 * a suggestion about a gain — nothing here says whether a number is too high or
 * too low, and the descriptions deliberately have no direction in them.
 */
export const TERM_VIEWS = Object.freeze({
  P: Object.freeze({
    term: 'P',
    evidenceKind: 'stop',
    metric: 'trackingRmsDps',
    metricLabel: 'Tracking error while the command was held',
    description: 'P acts on the error that exists right now, so it shows up while a ' +
      'command is being held: how far the measured rate sat from the commanded one.',
    supporting: Object.freeze(['slowOscillationRmsDps'])
  }),
  I: Object.freeze({
    term: 'I',
    evidenceKind: 'hold',
    metric: null,
    metricLabel: 'Steady-state error during a hold',
    description: 'I acts on error that has been present for a while, so it is invisible ' +
      'in a stop and shows up in a sustained hold instead.',
    supporting: Object.freeze([])
  }),
  D: Object.freeze({
    term: 'D',
    evidenceKind: 'stop',
    metric: 'fastRingingRmsDps',
    metricLabel: 'Fast ringing after the release (20–250 ms)',
    description: 'D acts on how fast the error is changing, so it shows up in the moment ' +
      'straight after a release: how much the aircraft rang before it settled.',
    supporting: Object.freeze(['trackingRmsDps'])
  })
});

/**
 * Per-metric asymmetry with its stop count attached.
 *
 * Reported as soon as each direction has at least one stop, rather than waiting
 * for a full capture. A 4.9x difference between left and right is a real
 * observation with one stop each way; suppressing it while displaying the two
 * numbers that produce it, which is what the viewer used to do, states less than
 * the screen already shows. The count travels with it so nobody mistakes one
 * stop each way for a settled result.
 */
export function directionalObservations(stopEvidence, metrics) {
  const directions = stopEvidence?.directions ?? {};
  const positive = directions.positive ?? {};
  const negative = directions.negative ?? {};

  if (!(positive.directionEventCount > 0) || !(negative.directionEventCount > 0)) {
    return [];
  }

  const out = [];
  for (const metric of metrics) {
    const left = positive[metric];
    const right = negative[metric];
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      continue;
    }
    const largest = Math.max(Math.abs(left), Math.abs(right));
    const smallest = Math.min(Math.abs(left), Math.abs(right));
    out.push({
      metric,
      positive: left,
      negative: right,
      ratio: smallest === 0 ? null : largest / smallest,
      higher: Math.abs(left) >= Math.abs(right) ? 'positive' : 'negative',
      positiveCount: positive.directionEventCount,
      negativeCount: negative.directionEventCount,
      // Two stops per direction is where the evidence stops being provisional.
      provisional: positive.directionEventCount < (evidence.EVIDENCE_LIMITS?.minimumStopsPerDirection ?? 2)
        || negative.directionEventCount < (evidence.EVIDENCE_LIMITS?.minimumStopsPerDirection ?? 2)
    });
  }
  return out;
}
