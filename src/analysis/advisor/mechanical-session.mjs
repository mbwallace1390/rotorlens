/**
 * The boundary between a decoded RotorLens session and the mechanical spectrum.
 *
 * RotorLens-authored, not ported. It replaces the four FlightLog-shaped
 * functions deleted from `js/advisor/mechanical_analysis.js` on the way in —
 * `fieldIndex`, `findGyroAxis`, `collectFlightLogSelection`, and the
 * `getMinTime`/`getMaxTime` half of `analyzeFlightLog` — none of which were
 * adapted, per the rule in CLAUDE.md that anything touching the viewer's
 * interface gets rewritten against our own session shape.
 *
 * What survived from the source is the one thing in those functions that is a
 * fact about Rotorflight rather than about a viewer: the field-name preference
 * ladder, gyroRAW then gyroUnfilt then gyroADC, and the source labels that go
 * with it. Field names are format vocabulary.
 *
 * What is deliberately absent is the chunk-boundary dedupe machinery
 * (`sameFinite`, `sameCollectedFrame`). It existed because a viewer's chunks
 * repeat frames at their seams. `session.samples` is one flat array, and on the
 * validation log all 134,429 samples are strictly monotonic in time with zero
 * duplicate timestamps, so there is nothing here for it to do.
 *
 * Pure and dependency-free. Float64Array, Number, Object, Map — it runs in Node,
 * a browser, and an Android WebView from one copy.
 */

/** Analysis axis order. Matches `AXIS_NAMES` in `mechanical-spectrum.mjs`. */
const AXES = Object.freeze(['roll', 'pitch', 'yaw']);

/**
 * Gyro field candidates, per axis, most trustworthy first.
 *
 * The label is not cosmetic. `gyroADC-filtered` means the samples came out of
 * the flight controller's filter chain, and filtering removes vibration evidence
 * before it can be measured — so the analysis refuses to call a range clear from
 * a filtered source. Mislabelling one as unfiltered turns "we cannot tell" into
 * "nothing is wrong", which is why `mechanical-spectrum.mjs` requires the labels
 * and this module always emits all three.
 */
const GYRO_LADDER = Object.freeze([
  Object.freeze({name: axis => `gyroRAW[${axis}]`, source: 'gyroRAW'}),
  Object.freeze({name: axis => `gyroUnfilt[${axis}]`, source: 'gyroUnfilt'}),
  Object.freeze({name: axis => `gyroADC[${axis}]`, source: 'gyroADC-filtered'})
]);

/**
 * Rotor-speed field candidates.
 *
 * One spelling each, and no fallback. `records.mjs` accepts `rpm[0]` as a
 * headspeed alias; that is not safe here. This module's output feeds harmonic
 * correlation, where the rotor fundamental is `rpm / 60` and a motor or ESC rpm
 * substituted for a head rpm differs by the gear ratio — on a typical machine
 * eight to twelve times. The correlation would still find a match, name a rotor
 * order, and be wrong. A missing field is reported; it is never approximated.
 *
 * `tailspeed` does not exist in Rotorflight 4.6.0 logs of the shape held here,
 * so tail-rotor correlation is permanently unavailable on them. That is absence
 * of evidence about the tail, not evidence the tail is sound.
 */
const HEADSPEED_FIELDS = Object.freeze(['headspeed']);
const TAILSPEED_FIELDS = Object.freeze(['tailspeed']);
const TIME_FIELDS = Object.freeze(['time']);

function indexByName(session) {
  const fields = session?.fields ?? [];
  const map = new Map();
  for (const field of fields) {
    if (field && typeof field.name === 'string' && Number.isInteger(field.index)) {
      map.set(field.name, field.index);
    }
  }
  return map;
}

function resolveFirst(indexes, candidates) {
  for (const candidate of candidates) {
    const index = indexes.get(candidate);
    if (index !== undefined) {
      return {index, name: candidate};
    }
  }
  return null;
}

/**
 * Copies one column out of the sample rows.
 *
 * A non-finite cell becomes NaN rather than 0. The spectrum treats NaN as a gap
 * it refuses to interpolate across and excludes any Welch window containing one;
 * a 0 would be a silent impulse in the middle of the signal, which is a broadband
 * feature the peak detector would then have to explain.
 */
function column(samples, index) {
  const out = new Float64Array(samples.length);
  for (let row = 0; row < samples.length; row += 1) {
    const value = samples[row]?.[index];
    out[row] = Number.isFinite(value) ? value : Number.NaN;
  }
  return out;
}

function missingColumn(length) {
  const out = new Float64Array(length);
  out.fill(Number.NaN);
  return out;
}

/**
 * First and last sample timestamps in a session.
 *
 * Replaces `flightLog.getMinTime()` / `getMaxTime()`. Deliberately trivial: it
 * reads the ends of the time column rather than scanning, because the decoder
 * emits samples in log order and the validation log has zero non-monotonic
 * timestamps across all 134,429 of them. If that ever stops being true the
 * spectrum's own NON_MONOTONIC_TIMESTAMPS gate is what catches it, and that gate
 * returns no conclusion rather than a wrong one.
 *
 * @param {object} session a session from `decodeLog`
 * @returns {{startTimeUs: number|null, endTimeUs: number|null, durationUs: number|null}}
 */
export function sessionTimeBounds(session) {
  const samples = session?.samples ?? [];
  const timeField = resolveFirst(indexByName(session), TIME_FIELDS);
  if (!timeField || samples.length === 0) {
    return {startTimeUs: null, endTimeUs: null, durationUs: null};
  }

  const startTimeUs = samples[0]?.[timeField.index];
  const endTimeUs = samples[samples.length - 1]?.[timeField.index];
  if (!Number.isFinite(startTimeUs) || !Number.isFinite(endTimeUs)) {
    return {startTimeUs: null, endTimeUs: null, durationUs: null};
  }

  return {startTimeUs, endTimeUs, durationUs: endTimeUs - startTimeUs};
}

/**
 * Builds the timestamped gyro series the mechanical spectrum consumes.
 *
 * This does NOT go through `buildAnalysisRecords`, and that is not a style
 * preference. `records.mjs` `FIELD_MAP.raw` lists `gyroUnfilt`, `gyroADCunfilt`,
 * then `debug[n]`, with no `gyroRAW` candidate at all. Rotorflight 4.6.0 logs
 * carry `gyroRAW[0..2]` and `debug[0..7]` but no `gyroUnfilt`, so on the
 * validation log that map resolves `raw[0..2]` to `debug[0]`, `debug[1]`,
 * `debug[2]` — three arbitrary firmware debug channels whose meaning depends on
 * the active debug mode. Running an FFT over those and labelling the result
 * unfiltered gyro would produce a confident spectrum of nothing in particular.
 *
 * @param {object} session a session from `decodeLog`
 * @returns {{timeUs: Float64Array,
 *            gyro: {roll: Float64Array, pitch: Float64Array, yaw: Float64Array},
 *            gyroSources: {roll: string, pitch: string, yaw: string},
 *            headspeedRpm: Float64Array,
 *            tailspeedRpm: Float64Array,
 *            resolved: object,
 *            missing: string[],
 *            usable: boolean}}
 */
export function buildMechanicalSeries(session) {
  const samples = session?.samples ?? [];
  const indexes = indexByName(session);

  const missing = [];
  const resolved = {};

  const timeField = resolveFirst(indexes, TIME_FIELDS);
  if (timeField) {
    resolved.time = timeField.name;
  } else {
    missing.push('time');
  }

  const gyro = {};
  const gyroSources = {};
  for (let axis = 0; axis < AXES.length; axis += 1) {
    const name = AXES[axis];
    let found = null;
    for (const rung of GYRO_LADDER) {
      const candidate = resolveFirst(indexes, [rung.name(axis)]);
      if (candidate) {
        found = {index: candidate.index, name: candidate.name, source: rung.source};
        break;
      }
    }
    if (found) {
      // Always emitted, for every axis, even when the ladder fell through. The
      // spectrum validates these and throws on absence; there is no default it
      // could apply that would not be a claim about data it has not seen.
      gyroSources[name] = found.source;
      resolved[`gyro.${name}`] = found.name;
      gyro[name] = column(samples, found.index);
    } else {
      gyroSources[name] = 'missing';
      gyro[name] = missingColumn(samples.length);
      missing.push(`gyro.${name}`);
    }
  }

  const headspeedField = resolveFirst(indexes, HEADSPEED_FIELDS);
  if (headspeedField) {
    resolved.headspeed = headspeedField.name;
  } else {
    missing.push('headspeed');
  }

  const tailspeedField = resolveFirst(indexes, TAILSPEED_FIELDS);
  if (tailspeedField) {
    resolved.tailspeed = tailspeedField.name;
  } else {
    missing.push('tailspeed');
  }

  // Rotor speed is correlation evidence, not a precondition. Without it the
  // spectrum still measures peaks; it just cannot say whether one sits on a
  // rotor harmonic. An absent column is filled with NaN here, which is what
  // makes FIELD_MISSING mean exactly one thing downstream: no finite cell
  // anywhere. A column that is present but never shows a usable rotor speed —
  // the head stopped — is a different measurement and gets a different code.
  const usable = Boolean(timeField)
    && samples.length > 0
    && AXES.every(name => gyroSources[name] !== 'missing');

  return {
    timeUs: timeField ? column(samples, timeField.index) : new Float64Array(0),
    gyro,
    gyroSources,
    headspeedRpm: headspeedField
      ? column(samples, headspeedField.index)
      : missingColumn(samples.length),
    tailspeedRpm: tailspeedField
      ? column(samples, tailspeedField.index)
      : missingColumn(samples.length),
    resolved,
    missing,
    usable
  };
}

export {AXES as MECHANICAL_AXES, GYRO_LADDER as MECHANICAL_GYRO_LADDER};
