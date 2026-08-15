/**
 * Measures a donated flight log, one session at a time, into the small fixed
 * shape a corpus is built from.
 *
 * WHY THIS EXISTS. Half a dozen constants in `src/` are calibrated on two
 * helicopters nobody has assessed, and one of them — `minimumComparisonHolds`
 * of 5 — has never once been reached on real data, so a shipped gate has never
 * opened. Those numbers need volume, and volume needs other people's logs. The
 * upload path in `docs/SHARED_CORPUS_DESIGN.md` is not built and may never be;
 * pilots already hand `.bbl` files to each other in Discord, so this is the half
 * that needs no permission, no endpoint and no change to the app.
 *
 * WHAT IT MUST NEVER DO. The output of this tool is meant to be shared — pasted
 * into a thread, sent back to the donor, quoted in a comment beside a constant.
 * That makes it a shared projection of somebody else's flight, and the rules the
 * on-device record is careful about apply one level further out or they do not
 * apply at all. `CORPUS_FIELDS` documents every field with the reason it earns
 * its place, `NEVER_REPORTED` lists what may not appear, and
 * `auditCorpusMeasurement` enforces both by inspection rather than by trust.
 *
 * The two fields `docs/SHARED_CORPUS_DESIGN.md` §2 forbids leaving a device —
 * `craftName` and the `aircraftKey` derived from it — are replaced here by a
 * run-local group label (`aircraft-1`, `aircraft-2`, …). It groups one machine's
 * flights together, which the null-pair measurement requires, and it identifies
 * nobody. It is the `sharingId` idea, applied to a batch run on a workstation.
 *
 * ROBUSTNESS IS THE POINT, not a nicety. A donated file may be truncated by a
 * power-off, written by firmware this decoder has never seen, or not be a log at
 * all. Every stage below is wrapped separately so one bad session, or one bad
 * axis inside a good session, is reported and stepped over. This module never
 * throws on input; if it does, that is the defect.
 */

import {FrameType, parseSession, findSessionStarts} from '../../src/blackbox/headers.mjs';
import {FrameDecoder} from '../../src/blackbox/frames.mjs';
import {resolveFlightWindow} from '../../src/analysis/flight-window.mjs';
import {buildAnalysisRecords} from '../../src/analysis/records.mjs';
import {
  AXES, resolveAxisSignals, summarizeAxis, indexAtOrAfter
} from '../../src/analysis/axis-report.mjs';
import {buildHoldEvidence} from '../../src/analysis/pid-evidence.mjs';
import {
  checkFlightAdmissible, deriveAircraftIdentity, readPilotGains
} from '../../src/analysis/flight-history.mjs';

export const CORPUS_MEASUREMENT_SCHEMA_VERSION = 1;
export const CORPUS_MEASUREMENT_KIND = 'rotorlens-corpus-measurement';

/**
 * WHAT IS NEVER REPORTED, and why.
 *
 * `src/analysis/flight-history.mjs` carries the same list for the record stored
 * on the pilot's own phone. This one is stricter in two places, because a
 * measurement of somebody else's log is going somewhere the pilot cannot see.
 */
export const NEVER_REPORTED = Object.freeze([
  Object.freeze({
    what: 'the craft name, or any key derived from it',
    why: 'whatever the donor typed into the configurator. Harmless on their own phone, which is why the local record keeps it; people name helicopters after themselves, so it cannot be in a file that gets pasted into a thread. Grouping uses a run-local label instead'
  }),
  Object.freeze({
    what: 'GPS coordinates, home position, satellite count, ground speed or altitude',
    why: 'the decoder never emits a coordinate, but a corpus report must not become the first place one appears. Nothing measured here needs to know where anyone flew — see tools/corpus/donation-check.mjs for the file-level half of this'
  }),
  Object.freeze({
    what: 'wall-clock date or time, including the log\'s own start datetime',
    why: 'a list of them says when this person flies, which is behaviour rather than tuning. Sessions are ordered by their position in the file'
  }),
  Object.freeze({
    what: 'a file path, a directory name, or anything but the bare filename',
    why: 'a path leaks the folder the owner filed a donation under, and folders get named after people. The bare name is kept because the owner has to be able to answer the donor about a specific file'
  }),
  Object.freeze({
    what: 'raw sample arrays, traces or spectra',
    why: 'a trace is the donated log again in another shape, and it is what turns a report into a redistribution of somebody else\'s flight data'
  })
]);

/**
 * EVERY REPORTED FIELD, WITH THE REASON IT EARNS ITS PLACE.
 *
 * Keyed by dotted path; `axes.*` stands for each of roll, pitch and yaw. This is
 * the allowlist `auditCorpusMeasurement` checks in both directions: nothing
 * reported is undocumented, and nothing documented is quietly absent.
 */
export const CORPUS_FIELDS = Object.freeze({
  schemaVersion:
    'so a later version can refuse an older measurement rather than misread it',
  kind:
    'so a file that is not a corpus measurement is rejected rather than parsed into one',
  sourceFile:
    'the bare filename of the donation, so the owner can go back to the donor about a specific file. Basename only — auditCorpusMeasurement refuses anything carrying a separator or a drive letter',
  sessionIndex:
    'which session inside that file, counted from the start. It replaces a timestamp: position in the file is all the ordering a comparison needs',
  readable:
    'whether this session could be measured at all. Without it a failed session and a quiet session read alike, which is how a batch tool reports a smaller corpus than it was given and nobody notices',
  failureStage:
    'where it stopped — header, frames, window or analysis. A donor can act on "your file is truncated" and cannot act on "failed"',
  failureCode:
    'the machine-readable form of the same, so a run can be tallied by failure kind',
  failureDetail:
    'the decoder\'s own message, kept because an unknown firmware reports itself here and that is the single most useful thing a donation can tell us',
  board:
    'the board model string. Equipment, not a person, and it is what separates two airframes in a pooled statistic',
  firmwareRevision:
    'which firmware wrote it. A corpus pooled across a firmware change is pooling two controllers',
  aircraftGroup:
    'an opaque run-local label grouping one machine\'s sessions. Null pairs are measured within an aircraft, so the grouping is required; the craft name it replaces is not',
  sampleCount:
    'how many samples were decoded, so a 40-sample stub is never weighed equally with a six-minute flight',
  decodeErrorCount:
    'how many frames failed to decode. A donation with thousands is telling us about our decoder, not about a helicopter',
  reachedLogEnd:
    'whether the stream ran out cleanly. False is normal for a log cut by a power-off, and is what distinguishes that from a corrupt one',
  windowBasis:
    'how the flight window was established, and therefore why a bench run was excluded',
  durationSeconds:
    'the length of the analysed window. An offset within the recording, never a clock time',
  admissible:
    'whether the shipped gate would keep this session as a flight. 72% of sessions in the reference corpus are bench runs and spool-ups, and a distribution that pools them describes a workbench',
  admissionCodes:
    'why not, when not. This is the field that stops "33 flights" being quietly reported as "110 flights"',
  ratesFingerprint:
    'the rate-curve settings joined into one string, only ever tested for equality. Rates decide what the aircraft was asked to do, so a null pair spanning a rates change is not a null pair',
  'gains.roll':
    'the roll PID line as integers, so a pair with any gain changed can be excluded from the noise floor',
  'gains.pitch':
    'the pitch PID line, on the same terms as gains.roll',
  'gains.yaw':
    'the yaw PID line, on the same terms as gains.roll',
  'axes.*.usable':
    'whether this axis had the fields the measurement needs. An axis missing from the log and an axis measuring zero are different answers',
  'axes.*.peakCommandDps':
    'the largest rate the pilot asked for on this axis. This is the measurement that decides whether COMMAND_THRESHOLD_DPS of 80 suits a learner, and it is the one number here that a single hover flight can supply',
  'axes.*.peakMeasuredDps':
    'the largest rate the aircraft actually reached, kept beside the command so a saturated axis is visible rather than inferred',
  'axes.*.headspeedMedianRpm':
    'the confound with the most leverage: the same gains at a different headspeed are a different controller, so a null pair must match on it',
  'axes.*.gyroHighFrequencyRmsDps':
    'broadband content above ~50 Hz on the filtered gyro — vibration and sensor noise rather than flight. It is the number the 8 deg/s attention threshold is argued about beside; see the caveat in summarize.mjs, which says plainly that the shipped gate is narrowband and this is not',
  'axes.*.unfilteredHighFrequencyRmsDps':
    'the same on the pre-filter gyro where the log carries one. Null is the honest answer when gyroRAW was off, and how often it is null is itself worth knowing before asking donors for anything',
  'axes.*.holdStatus':
    'whether hold evidence was conclusive on this axis. Without it, "no result" and "a result of zero" read alike',
  'axes.*.holdCount':
    'HOW MANY HOLD SEGMENTS THIS FLIGHT-AXIS PRODUCED. The distribution of this field is the whole reason the tool exists: minimumComparisonHolds is 5 and the maximum ever observed is 4, so the comparison has never fired',
  'axes.*.zeroHoldCount':
    'holds at zero command are heading holds; a heading hold and a constant-rate turn are different tests and a null pair must not mix them',
  'axes.*.sustainedHoldCount':
    'the other half of that count, kept so the mix is visible rather than inferred',
  'axes.*.meanAbsoluteSteadyStateErrorDps':
    'the metric the paired comparison is decided on, and the one whose flight-to-flight noise floor the null pairs measure',
  'axes.*.worstAbsoluteSteadyStateErrorDps':
    'the worst single hold, so one bad hold hidden inside a good mean is visible'
});

/** Anything that looks like a wall clock. Every log header carries one. */
const CLOCK_PATTERN = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** A path separator or a drive letter: a filename must be a bare basename. */
const PATH_SEPARATOR_PATTERN = /[\\/]|^[A-Za-z]:/;

/** Longer than this and a value is a trace rather than a measurement. */
const MAXIMUM_ARRAY_LENGTH = 12;

function documentedPathFor(path) {
  return path.replace(/^axes\.(roll|pitch|yaw)\./, 'axes.*.');
}

function walk(value, path, visit) {
  if (Array.isArray(value)) {
    visit(path, value);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      walk(child, path === '' ? key : `${path}.${key}`, visit);
    }
    return;
  }
  visit(path, value);
}

/**
 * Checks one measurement against the never-report rules by inspection.
 *
 * The failure this guards against is a future change adding "just one more
 * field" for convenience — and the most likely such fields are exactly a craft
 * name, a start datetime and a full path, because all three are sitting in the
 * parsed header two lines away from the code that builds this.
 *
 * @returns {{ok: boolean, violations: {path: string, reason: string}[]}}
 */
export function auditCorpusMeasurement(measurement) {
  const violations = [];
  const seen = new Set();

  walk(measurement, '', (path, value) => {
    if (path === '') {
      return;
    }
    seen.add(path);

    const documented = documentedPathFor(path);
    if (!(documented in CORPUS_FIELDS)) {
      violations.push({
        path,
        reason: 'not in CORPUS_FIELDS; every reported field needs a documented reason'
      });
      // Deliberately not a `return`. An undocumented field is exactly where a
      // craft name would arrive, and reporting only "undocumented" would name
      // the least important thing wrong with it.
    }

    if (typeof value === 'string' && CLOCK_PATTERN.test(value)) {
      violations.push({path, reason: 'looks like a wall-clock time, which is never reported'});
    }
    if (path === 'sourceFile' && typeof value === 'string'
        && PATH_SEPARATOR_PATTERN.test(value)) {
      violations.push({
        path,
        reason: 'a path rather than a bare filename; a directory name leaks who the donor is'
      });
    }
    if (Array.isArray(value) && value.length > MAXIMUM_ARRAY_LENGTH) {
      violations.push({path, reason: 'looks like a raw trace, which is never reported'});
    }
  });

  for (const documented of Object.keys(CORPUS_FIELDS)) {
    const present = [...seen].some(path => {
      const normalized = documentedPathFor(path);
      return normalized === documented || normalized.startsWith(`${documented}.`);
    });
    if (!present) {
      violations.push({
        path: documented,
        reason: 'documented but absent; the reported shape must be fixed, not conditional'
      });
    }
  }

  return Object.freeze({ok: violations.length === 0, violations: Object.freeze(violations)});
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

function round(value, places) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

/** The fixed empty shape. Every axis has every field, with null for unmeasured. */
function emptyAxis() {
  return {
    usable: false,
    peakCommandDps: null,
    peakMeasuredDps: null,
    headspeedMedianRpm: null,
    gyroHighFrequencyRmsDps: null,
    unfilteredHighFrequencyRmsDps: null,
    holdStatus: null,
    holdCount: null,
    zeroHoldCount: null,
    sustainedHoldCount: null,
    meanAbsoluteSteadyStateErrorDps: null,
    worstAbsoluteSteadyStateErrorDps: null
  };
}

/** The fixed empty measurement. A failed session reports the same shape. */
function emptyMeasurement(sourceFile, sessionIndex) {
  const axes = {};
  for (const axis of AXES) {
    axes[axis] = emptyAxis();
  }
  return {
    schemaVersion: CORPUS_MEASUREMENT_SCHEMA_VERSION,
    kind: CORPUS_MEASUREMENT_KIND,
    sourceFile,
    sessionIndex,
    readable: false,
    failureStage: null,
    failureCode: null,
    failureDetail: null,
    board: null,
    firmwareRevision: null,
    aircraftGroup: null,
    sampleCount: 0,
    decodeErrorCount: 0,
    reachedLogEnd: false,
    windowBasis: null,
    durationSeconds: null,
    admissible: false,
    admissionCodes: [],
    ratesFingerprint: null,
    gains: {roll: null, pitch: null, yaw: null},
    axes
  };
}

/**
 * Trims a decoded session to its flight window.
 *
 * Everything downstream measures inside the window, because a distribution
 * measured over the spool-up and the walk back to the bench is a distribution
 * about a workbench. `ui/app.mjs` does the same thing before building a record.
 */
function windowedSession(session, window) {
  if (!window || !Number.isFinite(window.startUs) || !Number.isFinite(window.endUs)) {
    return session;
  }
  const timeIndex = session.fields.findIndex(field => field.name === 'time');
  if (timeIndex === -1) {
    return session;
  }
  const from = indexAtOrAfter(session.samples, timeIndex, window.startUs);
  const to = indexAtOrAfter(session.samples, timeIndex, window.endUs + 1);
  return (from === 0 && to >= session.samples.length)
    ? session
    : {...session, samples: session.samples.slice(from, to)};
}

/** Shapes a decoded session the way `src/analysis/**` expects to receive one. */
function toAnalysisSession(definition, decoded) {
  const mainTable = definition.frames[FrameType.INTRA];
  return {
    fields: (mainTable?.fields ?? []).map((field, index) => ({
      name: field.name,
      index,
      signed: field.signed
    })),
    samples: decoded.samples,
    intraSampleIndices: decoded.intraSampleIndices,
    events: decoded.events,
    headers: definition.headers,
    firmware: definition.firmware,
    board: definition.board,
    craftName: definition.craftName
  };
}

function measureAxis(session, scoped, axis) {
  const result = emptyAxis();

  const signals = resolveAxisSignals(session, axis);
  if (!signals.usable) {
    return result;
  }
  result.usable = true;

  const summary = summarizeAxis(scoped, signals);
  if (summary) {
    result.peakCommandDps = round(summary.peakCommandDps, 3);
    result.peakMeasuredDps = round(summary.peakMeasuredDps, 3);
    result.headspeedMedianRpm = finiteOrNull(summary.headspeedMedianRpm);
    result.gyroHighFrequencyRmsDps = round(summary.gyroHighFrequencyRmsDps, 4);
    result.unfilteredHighFrequencyRmsDps = round(summary.unfilteredHighFrequencyRmsDps, 4);
  }

  const built = buildAnalysisRecords(scoped, {axis});
  if (!built.usable) {
    return result;
  }

  const hold = buildHoldEvidence(built.records, {axis, term: 'I'});
  result.holdStatus = hold?.status ?? null;

  // HOLD COUNT IS COUNTED FROM THE SEGMENTS, not read from the summary.
  //
  // `buildHoldEvidence` returns `summary: null` when there were no holds at all,
  // so reading the count out of the summary would drop every zero-hold axis out
  // of the histogram — and a histogram of hold counts that cannot show a zero is
  // a histogram that flatters the gate it exists to test.
  result.holdCount = Array.isArray(hold?.holds) ? hold.holds.length : null;
  result.zeroHoldCount = hold?.summary?.zeroHoldCount ?? (result.holdCount === 0 ? 0 : null);
  result.sustainedHoldCount =
    hold?.summary?.sustainedHoldCount ?? (result.holdCount === 0 ? 0 : null);
  result.meanAbsoluteSteadyStateErrorDps =
    round(hold?.summary?.meanAbsoluteSteadyStateErrorDps, 4);
  result.worstAbsoluteSteadyStateErrorDps =
    round(hold?.summary?.worstAbsoluteSteadyStateErrorDps, 4);

  return result;
}

/**
 * A scan over one or more donated logs.
 *
 * Stateful only in the aircraft grouping, which has to span files: two donations
 * from the same pilot are two files and one helicopter, and a null pair measured
 * across them is a real null pair.
 */
export function createCorpusScan() {
  const groupByKey = new Map();
  const measurements = [];
  const fileFailures = [];

  function groupFor(key) {
    if (key === null || key === undefined || key === '') {
      return null;
    }
    if (!groupByKey.has(key)) {
      groupByKey.set(key, `aircraft-${groupByKey.size + 1}`);
    }
    return groupByKey.get(key);
  }

  /**
   * Measures every session in one log's bytes.
   *
   * Never throws. Anything that goes wrong becomes a measurement with
   * `readable: false` and a stage, or — when the file yields no session at all —
   * a file-level failure.
   *
   * @param {Uint8Array} bytes
   * @param {string} sourceFile bare filename; a path is refused by the audit
   * @param {(measurement: object) => void} [onSession] progress callback
   */
  function addLog(bytes, sourceFile, onSession = null) {
    let starts = [];
    try {
      starts = findSessionStarts(bytes);
    } catch (error) {
      fileFailures.push({
        sourceFile,
        code: 'FILE_UNSCANNABLE',
        detail: String(error?.message ?? error)
      });
      return [];
    }

    if (starts.length === 0) {
      fileFailures.push({
        sourceFile,
        code: 'NOT_A_BLACKBOX_LOG',
        detail: `no "H Product:" session header in ${bytes.length} bytes`
      });
      return [];
    }

    const produced = [];
    for (let index = 0; index < starts.length; index += 1) {
      const measurement = measureSession(bytes, starts, index, sourceFile, groupFor);
      measurements.push(measurement);
      produced.push(measurement);
      if (onSession) {
        onSession(measurement);
      }
    }
    return produced;
  }

  return {
    addLog,
    get measurements() {
      return measurements;
    },
    get fileFailures() {
      return fileFailures;
    },
    get aircraftCount() {
      return groupByKey.size;
    }
  };
}

/**
 * One session, end to end, with each stage caught separately.
 *
 * The separation is not defensive style — it is what lets a truncated file still
 * contribute. A session whose frame stream dies half way through still has a
 * header, still has the samples decoded before the failure, and those samples
 * are as good as any others. Catching everything in one block would throw all of
 * that away and report the donation as unreadable.
 */
function measureSession(bytes, starts, index, sourceFile, groupFor) {
  const measurement = emptyMeasurement(sourceFile, index);
  const start = starts[index];
  const end = starts[index + 1] ?? bytes.length;

  let definition = null;
  try {
    definition = parseSession(bytes, start, index);
  } catch (error) {
    measurement.failureStage = 'header';
    measurement.failureCode = errorCodeOf(error, 'HEADER_UNREADABLE');
    measurement.failureDetail = String(error?.message ?? error);
    return measurement;
  }

  measurement.board = definition.board ?? null;
  measurement.firmwareRevision = definition.firmware?.revision ?? null;

  let decoded = null;
  try {
    decoded = new FrameDecoder(definition, bytes, {}).decode(end);
  } catch (error) {
    measurement.failureStage = 'frames';
    measurement.failureCode = errorCodeOf(error, 'FRAME_STREAM_UNREADABLE');
    measurement.failureDetail = String(error?.message ?? error);
    return measurement;
  }

  measurement.sampleCount = decoded.samples.length;
  measurement.decodeErrorCount = decoded.errors?.length ?? 0;
  measurement.reachedLogEnd = Boolean(decoded.reachedLogEnd);

  const session = toAnalysisSession(definition, decoded);

  // The identity is read here and immediately reduced to an opaque group. The
  // key and the craft name it is built from do not leave this function.
  try {
    measurement.aircraftGroup = groupFor(deriveAircraftIdentity(session).key);
  } catch {
    measurement.aircraftGroup = null;
  }

  try {
    const pilot = readPilotGains(session);
    measurement.ratesFingerprint = pilot.rates ?? null;
    for (const axis of AXES) {
      const gains = pilot.gains?.[axis];
      measurement.gains[axis] = Array.isArray(gains) ? [...gains] : null;
    }
  } catch {
    // Gains are header text; unreadable gains cost the null pairs and nothing
    // else, so the rest of the measurement still stands.
  }

  let window = null;
  try {
    window = resolveFlightWindow(session);
    measurement.windowBasis = window?.basis ?? null;
    if (Number.isFinite(window?.startUs) && Number.isFinite(window?.endUs)) {
      measurement.durationSeconds = round((window.endUs - window.startUs) / 1e6, 3);
    }
  } catch (error) {
    measurement.failureStage = 'window';
    measurement.failureCode = errorCodeOf(error, 'FLIGHT_WINDOW_FAILED');
    measurement.failureDetail = String(error?.message ?? error);
    return measurement;
  }

  try {
    const admission = checkFlightAdmissible({session, window});
    measurement.admissible = admission.admissible;
    measurement.admissionCodes = [...admission.codes];
  } catch {
    measurement.admissible = false;
    measurement.admissionCodes = ['ADMISSION_CHECK_FAILED'];
  }

  const scoped = windowedSession(session, window);

  for (const axis of AXES) {
    try {
      measurement.axes[axis] = measureAxis(session, scoped, axis);
    } catch (error) {
      // One axis failing does not cost the other two. The axis keeps its empty
      // shape and the session is still readable — which is the honest report,
      // because the sessions that fail here fail on one axis' missing field.
      measurement.axes[axis] = emptyAxis();
      measurement.failureDetail = measurement.failureDetail
        ?? `${axis}: ${String(error?.message ?? error)}`;
    }
  }

  measurement.readable = true;
  return measurement;
}

function errorCodeOf(error, fallback) {
  const code = error?.code;
  return typeof code === 'string' && code !== '' ? code : fallback;
}

export {AXES};
