/**
 * Flight history, and the paired comparison it exists to make possible.
 *
 * A pilot changes one gain, flies again, and wants to know whether it helped.
 * Answering that needs something remembered from the first flight. This module
 * decides WHAT may be remembered, derives it, and compares two of them.
 *
 * ---------------------------------------------------------------------------
 * THREE THINGS THIS MODULE DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * 1. IT DOES NOT PERSIST ANYTHING. Every function here takes plain data and
 *    returns plain data. There is no storage call in this file and there must
 *    never be one: `src/` runs unchanged in Node, in a browser and in the
 *    Android WebView, and each of those keeps files somewhere different. The
 *    caller owns the file. See the API contract at the bottom of this comment.
 *
 * 2. THE PAIRED COMPARISON DOES NOT CLAIM A MAGNITUDE. Under the product
 *    decision of 12 August 2026 RotorLens reports directions, not magnitudes.
 *    The arithmetic backs that up: from the measured per-segment spread,
 *    resolving the one real gain change in the reference corpus — 0.0285 deg/s
 *    over the detected window — would need thousands of hold segments a side.
 *    Numbers appear in the output as BASIS, so the pilot can see the floor
 *    beside them; no field in a comparison is a size-of-improvement.
 *
 *    `buildSensitivityModel`, at the bottom of this file, is the one place a
 *    magnitude may ever appear, and only after it has been earned from six or
 *    more of the pilot's own flights AND judged against a floor measured on
 *    their own aircraft. It disappears again the moment a flight behind it is
 *    forgotten, because it is derived rather than stored.
 *
 * 3. IT DOES NOT WRITE TO A FLIGHT CONTROLLER, and nothing it returns is
 *    shaped like something that could be written to one.
 *
 * ---------------------------------------------------------------------------
 * THE MEASUREMENT THAT SHAPED EVERY GATE BELOW
 * ---------------------------------------------------------------------------
 *
 * The shipped `compareHoldEvidence` was run over every pair of same-aircraft
 * flights in 109 real flights whose header PID lines were byte-identical —
 * pairs where the pilot had changed nothing. It said "improved" or "worsened"
 * six times out of six, evenly split between the two opposite wrong answers.
 * Everything in this file that looks like excessive caution is that number.
 *
 * The floor itself (`EVIDENCE_LIMITS.holdErrorNoiseFloorDps`, 0.39 deg/s) is
 * the p90 of the change seen between two flights where nothing was changed, and
 * it is POOLED across the three axes — which is the wrong statistic to apply per
 * axis, and is corrected for the model's own purposes by SENSITIVITY_FLOOR_DPS
 * further down. The corpus contains FIVE single-gain transitions, of which one
 * has hold evidence on both sides; re-measured over the detected window it moved
 * the metric by 0.0285 deg/s, with a 95% interval of [-0.087, +0.144] that
 * includes zero. The noise is more than ten times the effect against the pooled
 * floor and three times it against yaw's own, and no threshold exists that both
 * admits that experiment and silences the nulls — every threshold that admits it
 * fires on 20 to 44 of the 47 known-null pairs.
 *
 * So this module is built to REFUSE. `not-enough-evidence` is the default
 * outcome and the common one, and that is the feature working, not failing.
 *
 * ---------------------------------------------------------------------------
 * THE API CONTRACT WITH THE CALLER (viewer or native shell)
 * ---------------------------------------------------------------------------
 *
 *   const history = importHistory(textFromDisk).history;   // never throws
 *   const record  = buildFlightRecord({session, window, axes});
 *   const next    = addFlightRecord(history, record);      // new object
 *   writeToDisk(exportHistory(next));                      // caller's job
 *
 * `exportHistory` is the ONLY serialiser. It rebuilds each record from the
 * documented field list rather than stringifying whatever it was handed, so a
 * field a future caller stuffs into a record in memory cannot reach the disk.
 * That is the property that keeps this from becoming a trail, and
 * `test/flight-history.test.mjs` proves it by injecting one.
 *
 * The guarantee is about KEYS. `recordId` and `windowBasis` pass their content
 * through after a type check, while `ratesFingerprint` also has a versioned
 * shape check. `auditFlightRecord` is still what covers their values and is not
 * optional. See `exportableRecord`.
 */

import {
  AXES,
  DIRECTIONS,
  DIRECTIONAL_EVIDENCE_KIND,
  EVIDENCE_LIMITS,
  HOLD_EVIDENCE_KIND
} from './pid-evidence.mjs';
import {FlightWindowBasis} from './flight-window.mjs';

// Version 2 adds expo to the rates fingerprint. Version-1 records are migrated
// without discarding the flights, but their old three-field fingerprint is
// invalidated: the missing expo cannot be reconstructed after the log is gone.
export const FLIGHT_HISTORY_SCHEMA_VERSION = 2;
const LEGACY_FLIGHT_HISTORY_SCHEMA_VERSION = 1;

export const FLIGHT_HISTORY_KIND = 'rotorlens-flight-history';
export const FLIGHT_RECORD_KIND = 'rotorlens-flight-record';
export const FLIGHT_COMPARISON_KIND = 'rotorlens-flight-comparison';

/** The three rate-loop terms a paired comparison is about. */
export const GAIN_TERMS = Object.freeze(['P', 'I', 'D']);

/**
 * Window bases that mean the machine actually left the ground.
 *
 * 72% of the sessions a pilot imports are not flights. Of 110 real sessions,
 * 73 reported NO_ROTOR_START_IN_LOG and 6 NO_LIFTOFF_DETECTED: median duration
 * 22 s, peak commanded rate 0, no headspeed — bench and spool-up logs. One dump
 * was 73 sessions for 5 flights.
 *
 * A history that stored all of them would be 72% padding, would make the
 * pilot's own flight count wrong, and would make "compare with the previous
 * flight" pick a bench run. The engine already knows; it simply was not being
 * used as an admission criterion anywhere.
 */
export const AIRBORNE_WINDOW_BASES = Object.freeze([
  FlightWindowBasis.DETECTED,
  FlightWindowBasis.ENDED_IN_FLIGHT
]);

export const HISTORY_LIMITS = Object.freeze({
  /** Shared with the evidence engine rather than restated. */
  holdErrorNoiseFloorDps: EVIDENCE_LIMITS.holdErrorNoiseFloorDps,
  comparisonToleranceRatio: EVIDENCE_LIMITS.comparisonToleranceRatio,
  minimumComparisonHolds: EVIDENCE_LIMITS.minimumComparisonHolds,
  maximumHeadspeedVariationRatio: EVIDENCE_LIMITS.maximumHeadspeedVariationRatio,

  /**
   * Gains moving together in this many places is a profile switch, not tuning.
   *
   * Four pairs in the corpus change THIRTEEN values at once and then revert —
   * 4→5, 10→11, 11→12 flip back and forth between the same two sets. That is a
   * PID profile being switched. Compared as tuning it reports two profiles as a
   * gain result. Six of the fifteen stored values is comfortably above anything
   * a human adjusts between two flights and comfortably below thirteen.
   */
  profileSwitchGainCount: 6,

  /**
   * Records kept per aircraft before the oldest is dropped.
   *
   * A cap is what stops a history becoming a trail: unbounded, it is a record of
   * every flight this person has ever made. 200 is enough to hold a season of
   * tuning and small enough to render on screen in full, which is the point —
   * a history the pilot cannot see all of is one they cannot check.
   *
   * MEASURED SIZE, not estimated: 2,539 bytes for one record compact, and
   * 4,413 as actually stored — `exportHistory` writes indented text, so that is
   * what lands on disk. The cap is therefore 502 KiB compact and 862 KiB in
   * practice. (An earlier note here said "2,569 as stored", which was the
   * compact figure wearing the wrong label; the 861 KiB cap arithmetic beside
   * it already implied 4,406. Confirmed on a handset by reading the file before
   * and after a save: 4,574 bytes for one flight, 8,987 for two.)
   *
   * The feature investigation projected 574 bytes a record; that figure was
   * taken before this shape carried both stop directions, the rates
   * fingerprint, and an explicit null for every unmeasured field. The fixed
   * shape is what makes the never-store rules checkable, and it is worth the
   * bytes. `test/flight-history.test.mjs` pins the number so it cannot grow
   * quietly.
   */
  maximumRecordsPerAircraft: 200
});

/**
 * WHAT IS NEVER STORED, and why. This is the privacy decision, in code.
 *
 * `docs/PRIVACY_POLICY.md` carries the same list in prose. Anything added here
 * must be added there, and `auditFlightRecord` enforces the first four by
 * inspection rather than by trust.
 */
export const NEVER_STORED = Object.freeze([
  Object.freeze({
    what: 'the log, or any slice of it',
    why: 'a log is the pilot\'s raw flight data; the history is a handful of numbers derived from it, and keeping the source would make deleting the history meaningless'
  }),
  Object.freeze({
    what: 'GPS coordinates, home position, or any position frame',
    why: 'a home coordinate is usually where the pilot was standing and may be where they live. The decoder holds it only as a predictor base and never emits it; the history must not become the first place it appears'
  }),
  Object.freeze({
    what: 'the GPS satellite count, ground speed and altitude rows',
    why: 'location-adjacent. They are not coordinates, but a series of them describes where and how high someone flew, and nothing in a tuning comparison needs them'
  }),
  Object.freeze({
    what: 'wall-clock date or time, including the log\'s own start datetime',
    why: 'a list of them is a record of when this person flies, which is behaviour rather than tuning. This is a measurement and not an opinion: restricting comparisons to the same day does not tighten the noise floor (same-day median 57% / p90 141% against different-day 91% / p90 96%), so the date buys nothing and can simply not be collected. Ordering uses a monotone counter instead'
  }),
  Object.freeze({
    what: 'the imported file\'s name or path',
    why: 'a path into the user\'s own storage, and often into a folder name they chose'
  }),
  Object.freeze({
    what: 'raw sample arrays, traces, or spectra',
    why: 'a trace is the log again in another shape, and it is what makes a small record become a large one'
  }),
  Object.freeze({
    what: 'anything that never left the ground',
    why: 'see AIRBORNE_WINDOW_BASES: 72% of imported sessions are bench runs, and storing them fills the history with nothing while making the flight count wrong'
  })
]);

/**
 * EVERY STORED FIELD, WITH THE REASON IT EARNS ITS PLACE.
 *
 * Keyed by dotted path; `axes.*` stands for each of roll, pitch and yaw. This
 * is not documentation beside the code — it is the allowlist `exportHistory`
 * builds from, so a field with no entry here cannot be written to disk, and a
 * test asserts the two directions of the correspondence: nothing stored is
 * undocumented, and nothing documented is absent.
 *
 * The measured cost of all of it is 2,539 bytes a flight compact, 4,413 as
 * stored — the export writes indented text. See RECORD_CAP above.
 * (574 was the feature investigation's projection, taken before this shape
 * carried both stop directions, the rates fingerprint and an explicit null for
 * every unmeasured field. See RECORD_CAP above, where the measurement lives.)
 */
export const RECORD_FIELDS = Object.freeze({
  schemaVersion:
    'so a later version can read or refuse an older record instead of misreading it',
  kind:
    'so a file that is not a flight history is rejected rather than parsed into one',
  recordId:
    'a stable handle for "forget this flight", built from the aircraft key and the ordinal — never from a clock',
  aircraftKey:
    'which machine this was, so two aircraft are never pooled. Craft name and board, normalised; see deriveAircraftIdentity',
  craftName:
    'as the pilot typed it, so the history screen can name the machine in their words rather than in a normalised key',
  board:
    'the board model string, the second half of the key. Kept visible because it is what disambiguates two aircraft with the same name',
  ordinal:
    'a monotone per-aircraft counter deciding which flight came first. It replaces a timestamp: ordering is all a comparison needs, and a running count the device keeps about itself is not a record of when anyone flew',
  firmwareRevision:
    'NOT part of the identity — both real dumps span a firmware update mid-life, so keying on it splits one aircraft into two. Stored as a field so a comparison across a firmware change can be refused, because a new firmware can change the controller under the same numbers',
  windowBasis:
    'how the flight window was established. It is the admission criterion (see AIRBORNE_WINDOW_BASES) and it tells the pilot why a bench run was not kept',
  durationSeconds:
    'how long the flight was, so a 30 s hop and a 6 minute flight are not silently treated as equal evidence',
  ratesFingerprint:
    'the rate-curve settings joined into one short string. Rates decide what the aircraft was ASKED to do, so a change to them invalidates a before/after comparison. Stored as a fingerprint rather than as values because it is only ever tested for equality',
  'gains.roll':
    'the roll PID line from the header as integers. The first three are P, I and D — the terms a comparison is about — and the rest is kept so a change to feedforward or boost is detected rather than misattributed to P, I or D',
  'gains.pitch':
    'the pitch PID line, on the same terms as gains.roll: P, I and D first, and the remainder kept so a feedforward or boost change is detected rather than misattributed',
  'gains.yaw':
    'the yaw PID line, on the same terms as gains.roll: P, I and D first, and the remainder kept so a feedforward or boost change is detected rather than misattributed',
  'axes.*.headspeedMedianRpm':
    'the confound check with the most leverage: the same gains at a different headspeed are a different controller, and a comparison spanning more than a few percent is not comparing the gain',
  'axes.*.hold.status':
    'whether the hold evidence was conclusive on this flight. Without it, "no result" and "a result of zero" read alike',
  'axes.*.hold.holdCount':
    'how many hold segments the numbers rest on. 59% of the comparable sides in the corpus had exactly one, and one against one cannot support a claim — this is what lets the comparison refuse',
  'axes.*.hold.zeroHoldCount':
    'holds at zero command are heading holds; a heading hold and a constant-rate turn are different tests and must not be compared to each other',
  'axes.*.hold.sustainedHoldCount':
    'the other half of that count, kept so the mix is visible rather than inferred',
  'axes.*.hold.meanAbsoluteSteadyStateErrorDps':
    'the metric the paired comparison is decided on, and the only one whose flight-to-flight noise floor has been measured',
  'axes.*.hold.worstAbsoluteSteadyStateErrorDps':
    'the worst single hold, so one bad hold hidden inside a good mean is visible',
  'axes.*.hold.meanErrorDriftDpsPerSecond':
    'whether the error was going somewhere. Null when no hold\'s drift stood above its own uncertainty, and null is the honest answer there',
  'axes.*.hold.meanErrorRippleRmsDps':
    'in-band ripple: the hunting signature, and the measurement that separates a standing error from an oscillation around zero',
  'axes.*.hold.meanErrorCrossingRateHz':
    'how often the error crossed its own mean, the frequency half of that signature',
  // NOT written as an inference about the gain behind it — see the note below,
  // and `test/axis-report.test.mjs`, which holds every module but the
  // recommendation surface to measurement-only prose.
  'axes.*.hold.meanITermRms':
    'the integrator output itself. Kept for display only: across the corpus pair where that value was nearly halved in the header, this moved by 1%, which is correct control theory — the output follows the trim the aircraft needs rather than the header number, so it is evidence about the flight and not about the header',
  'axes.*.stop.status':
    'whether stop evidence was conclusive. It never has been on a real log — see STOP_FLOOR_NOT_MEASURED — so this field is mostly a record of that',
  'axes.*.stop.positive':
    'the summary of stops in the positive direction: count, tracking rms, fast ringing rms, slow oscillation rms, command amplitude. Kept per direction because a change that helps one way and hurts the other is a mechanical or authority limit, not a better gain',
  'axes.*.stop.negative':
    'the same summary for stops in the negative direction, kept separately for the same reason: pooling the two hides the asymmetry that says the fault is mechanical',
  'axes.*.noise.filteredHighFrequencyRmsDps':
    'the vibration floor the controller sees, so a gain result on a flight with a mechanical problem can be refused rather than reported',
  'axes.*.noise.unfilteredHighFrequencyRmsDps':
    'the same before filtering, which is where a bearing or a blade shows up first'
});

// ---------------------------------------------------------------------------
// Small helpers. Local so this module stays dependency-free and platform-neutral.
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

/** Trim, collapse internal runs of whitespace, and drop an empty result. */
function normalizeText(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const collapsed = value.trim().replace(/\s+/g, ' ');
  return collapsed === '' ? null : collapsed;
}

function addCode(codes, code) {
  if (!codes.includes(code)) {
    codes.push(code);
  }
  return codes;
}

// ---------------------------------------------------------------------------
// Aircraft identity
// ---------------------------------------------------------------------------

/**
 * Derives a stable identity for the machine a log came from, and says when it
 * cannot.
 *
 * MEASURED, not chosen. Seven candidate keys were tested across 110 real
 * sessions for two failure modes — one key value spanning two different
 * aircraft (a MERGE) and one aircraft producing several key values (a SPLIT):
 *
 *   key                          distinct  merged  split
 *   craftName                        3        0      0
 *   board                            2        1      0    <- MERGE
 *   craft+board                      3        0      0    <- this one
 *   craft+board+firmware             5        0      2    <- SPLIT
 *   craft+board+rates                8        0      1
 *   allPIDs                         17        0      2
 *
 * BOARD ALONE MERGES TWO DIFFERENT HELICOPTERS. A Bell 222UT and an OMP M4Max
 * both report "FRSK VANTAC_RF007", because Board information is a board MODEL
 * string, not a serial. There is no serial anywhere in a Blackbox header, so
 * there is no hardware identity to be had: the key is inherently user-typed and
 * inherently fallible, and this function's job is to be honest about that rather
 * than to manufacture confidence.
 *
 * FIRMWARE IS DELIBERATELY NOT IN THE KEY. Both real dumps span a firmware
 * update mid-life, so including it split 2 of 3 aircraft into two histories. It
 * is carried as a record field and used to REFUSE a comparison instead.
 *
 * @param {object} session a parsed session, or anything carrying `craftName`
 *   and `board` — `parseSession` output is the intended input
 * @returns {{key: string|null, craftName: string|null, board: string|null,
 *   keyable: boolean, codes: string[]}}
 */
export function deriveAircraftIdentity(session) {
  const codes = [];
  const craftName = normalizeText(session?.craftName ?? session?.headers?.['Craft name']);
  const board = normalizeText(session?.board ?? session?.headers?.['Board information']);

  if (craftName === null) {
    // The Rotorflight default is a blank craft name, so this is not an exotic
    // case. Pooling every unnamed machine into one history would be the merge
    // failure above, committed on purpose — so it is refused, and the caller is
    // expected to offer a rename rather than to guess.
    addCode(codes, 'CRAFT_NAME_MISSING');
  }
  if (board === null) {
    // Tolerable: craft name alone was perfect across the corpus. The board is in
    // the key as insurance against two pilots choosing the same name, not
    // because the name was ever seen to collide.
    addCode(codes, 'BOARD_INFORMATION_MISSING');
  }

  const keyable = craftName !== null;

  return Object.freeze({
    key: keyable ? `${craftName.toLowerCase()}::${(board ?? '').toLowerCase()}` : null,
    craftName,
    board,
    keyable,
    codes: Object.freeze(codes)
  });
}

// ---------------------------------------------------------------------------
// Pilot gains, read from the header
// ---------------------------------------------------------------------------

const GAIN_HEADER_KEYS = Object.freeze({roll: 'rollPID', pitch: 'pitchPID', yaw: 'yawPID'});

// Every value that shapes stick command must be present. Treating two partial
// configurations as equal is a fail-open comparison: matching nulls do not prove
// matching rate curves. Rotorflight 4.6 writes all four.
const RATES_HEADER_KEYS = Object.freeze(['rates_type', 'rc_rates', 'rc_expo', 'rates']);
const RATES_FINGERPRINT_PREFIX = 'rf-rates-v2:';

function ratesFingerprintReadable(value) {
  const fingerprint = normalizeText(value);
  if (fingerprint === null || !fingerprint.startsWith(RATES_FINGERPRINT_PREFIX)) {
    return false;
  }
  const parts = fingerprint.slice(RATES_FINGERPRINT_PREFIX.length).split('|');
  return parts.length === RATES_HEADER_KEYS.length
    && parts.every(part => normalizeText(part) !== null);
}

function parseGainLine(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const fields = raw.split(',').map(part => part.trim());
  // Number('') is zero. A blank PID field therefore used to become a real zero
  // gain and could be compared or fitted as if the firmware had logged it.
  if (fields.some(part => part === '')) {
    return null;
  }
  const parts = fields.map(Number);
  if (parts.length < GAIN_TERMS.length || parts.some(part => !Number.isFinite(part))) {
    return null;
  }
  return parts;
}

/**
 * Reads the pilot's gains out of the header, so a comparison knows what changed.
 *
 * Rotorflight writes one comma-separated line per axis. The first three values
 * are P, I and D; the remainder (feedforward, boost) is kept verbatim rather
 * than discarded, because a pilot who changes feedforward and nothing else would
 * otherwise look like a pilot who changed nothing, and the resulting movement in
 * the numbers would be attributed to no cause at all.
 *
 * @returns {{gains: object, rates: string|null, codes: string[]}}
 */
export function readPilotGains(session) {
  const codes = [];
  const headers = session?.headers ?? {};
  const gains = {};

  for (const axis of AXES) {
    const parsed = parseGainLine(headers[GAIN_HEADER_KEYS[axis]]);
    if (parsed === null) {
      addCode(codes, 'GAINS_UNREADABLE');
    }
    gains[axis] = parsed === null ? null : Object.freeze(parsed);
  }

  // One short string, only ever tested for equality. Rates decide what the
  // aircraft was asked to do; the M4Max changed them six times across 36
  // flights, and a comparison spanning that is not a comparison of the gain.
  const ratesParts = RATES_HEADER_KEYS.map(key => normalizeText(headers[key]));
  const rates = ratesParts.every(part => part !== null)
    ? `${RATES_FINGERPRINT_PREFIX}${ratesParts.join('|')}`
    : null;
  if (rates === null) {
    addCode(codes, 'RATES_UNREADABLE');
  }

  return Object.freeze({gains: Object.freeze(gains), rates, codes: Object.freeze(codes)});
}

// ---------------------------------------------------------------------------
// Building a record
// ---------------------------------------------------------------------------

const HOLD_SUMMARY_FIELDS = Object.freeze([
  'holdCount',
  'zeroHoldCount',
  'sustainedHoldCount',
  'meanAbsoluteSteadyStateErrorDps',
  'worstAbsoluteSteadyStateErrorDps',
  'meanErrorDriftDpsPerSecond',
  'meanErrorRippleRmsDps',
  'meanErrorCrossingRateHz',
  'meanITermRms'
]);

const STOP_DIRECTION_FIELDS = Object.freeze([
  'trackingRmsDps',
  'fastRingingRmsDps',
  'slowOscillationRmsDps',
  'commandAmplitudeDps'
]);

function emptyHold() {
  const summary = {status: 'not-measured'};
  for (const field of HOLD_SUMMARY_FIELDS) {
    summary[field] = null;
  }
  return summary;
}

function summarizeHold(evidence) {
  if (!evidence || evidence.kind !== HOLD_EVIDENCE_KIND) {
    return Object.freeze(emptyHold());
  }

  const summary = emptyHold();
  summary.status = evidence.status ?? 'not-measured';
  for (const field of HOLD_SUMMARY_FIELDS) {
    const value = evidence.summary?.[field];
    summary[field] = typeof value === 'number' ? round(value, 4) : null;
  }
  // A capture with no summary is still a capture with no numbers; holdCount 0
  // rather than null keeps "zero holds" from reading as "not measured".
  summary.holdCount = summary.holdCount ?? (evidence.holds?.length ?? null);
  return Object.freeze(summary);
}

function emptyStopDirection() {
  const direction = {eventCount: 0};
  for (const field of STOP_DIRECTION_FIELDS) {
    direction[field] = null;
  }
  return direction;
}

function summarizeStop(evidence) {
  const stop = {status: 'not-measured'};
  for (const direction of DIRECTIONS) {
    stop[direction] = Object.freeze(emptyStopDirection());
  }

  if (!evidence || evidence.kind !== DIRECTIONAL_EVIDENCE_KIND) {
    return Object.freeze(stop);
  }

  stop.status = evidence.status ?? 'not-measured';
  for (const direction of DIRECTIONS) {
    const measured = evidence.directions?.[direction];
    const summary = emptyStopDirection();
    summary.eventCount = Number.isFinite(measured?.directionEventCount)
      ? measured.directionEventCount
      : 0;
    for (const field of STOP_DIRECTION_FIELDS) {
      summary[field] = typeof measured?.[field] === 'number' ? round(measured[field], 4) : null;
    }
    stop[direction] = Object.freeze(summary);
  }

  return Object.freeze(stop);
}

function summarizeNoise(noise) {
  return Object.freeze({
    filteredHighFrequencyRmsDps: round(noise?.filteredHighFrequencyRmsDps, 4),
    unfilteredHighFrequencyRmsDps: round(noise?.unfilteredHighFrequencyRmsDps, 4)
  });
}

/**
 * Whether a session may be admitted to the history at all.
 *
 * Separate from `buildFlightRecord` so a viewer can tell the pilot WHY an import
 * was not kept. A log that silently vanishes looks like a bug; "this one never
 * left the ground, so there is nothing to compare" is an answer.
 *
 * @returns {{admissible: boolean, codes: string[]}}
 */
export function checkFlightAdmissible({session, window} = {}) {
  const codes = [];
  const identity = deriveAircraftIdentity(session);

  if (!identity.keyable) {
    addCode(codes, 'AIRCRAFT_NOT_KEYABLE');
  }

  const basis = window?.basis ?? null;
  if (!AIRBORNE_WINDOW_BASES.includes(basis)) {
    addCode(codes, 'FLIGHT_NEVER_LEFT_THE_GROUND');
  }

  const durationSeconds = windowDurationSeconds(window);
  if (durationSeconds === null) {
    addCode(codes, 'FLIGHT_DURATION_UNKNOWN');
  }

  return Object.freeze({admissible: codes.length === 0, codes: Object.freeze(codes)});
}

function windowDurationSeconds(window) {
  const start = window?.startUs;
  const end = window?.endUs;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  return round((end - start) / 1e6, 3);
}

/**
 * Derives the stored record for one flight.
 *
 * Takes only what it needs and never the log. `session` is used for its header
 * strings; `window` for its basis and its length in microseconds — which are
 * offsets within the recording, not clock times; `axes` for evidence objects the
 * caller has already built.
 *
 * The shape is FIXED: every documented field is present on every record, with
 * null where a thing was not measured. A record whose shape depends on what was
 * measured cannot be checked against a field list, and checking it against a
 * field list is how the never-store rules are enforced.
 *
 * @param {object}  input
 * @param {object}  input.session parsed session headers
 * @param {object}  input.window  resolved flight window
 * @param {object}  [input.axes]  `{roll: {holdEvidence, stopEvidence, noise,
 *   headspeedMedianRpm}, pitch: …, yaw: …}`
 * @param {number}  [input.ordinal] normally assigned by `addFlightRecord`
 */
// Same-flight identity is deliberately process-local. It distinguishes two
// decoded sessions that happen to round to the same summaries without storing a
// timestamp, raw-log hash, or other persistent flight identifier. Re-analysis
// of the same decoded session retains the token; export/import intentionally
// does not.
const SESSION_SOURCE_TOKENS = new WeakMap();
const RECORD_SOURCE_TOKENS = new WeakMap();

function sourceTokenForSession(session) {
  if (session === null || typeof session !== 'object') {
    return null;
  }
  // The viewer combines decoded-session fields with parsed header fields in a
  // lightweight wrapper. That wrapper is rebuilt whenever the analysis window
  // changes, so it carries the stable decoded object explicitly.
  const explicitSource = session.sourceSession;
  const source = explicitSource !== null && typeof explicitSource === 'object'
    ? explicitSource
    : session;
  let token = SESSION_SOURCE_TOKENS.get(source);
  if (token === undefined) {
    token = Object.freeze({});
    SESSION_SOURCE_TOKENS.set(source, token);
  }
  return token;
}

export function buildFlightRecord({session, window, axes = {}, ordinal = null} = {}) {
  const identity = deriveAircraftIdentity(session);
  const {gains, rates} = readPilotGains(session);

  const record = {
    schemaVersion: FLIGHT_HISTORY_SCHEMA_VERSION,
    kind: FLIGHT_RECORD_KIND,
    recordId: null,
    aircraftKey: identity.key,
    craftName: identity.craftName,
    board: identity.board,
    ordinal: Number.isInteger(ordinal) ? ordinal : null,
    firmwareRevision: normalizeText(
      session?.firmware?.revision ?? session?.headers?.['Firmware revision']
    ),
    windowBasis: window?.basis ?? null,
    durationSeconds: windowDurationSeconds(window),
    ratesFingerprint: rates,
    gains: Object.freeze({
      roll: gains.roll ?? null,
      pitch: gains.pitch ?? null,
      yaw: gains.yaw ?? null
    }),
    axes: {}
  };

  for (const axis of AXES) {
    const measured = axes?.[axis] ?? {};
    record.axes[axis] = Object.freeze({
      headspeedMedianRpm: round(measured.headspeedMedianRpm, 1),
      hold: summarizeHold(measured.holdEvidence),
      stop: summarizeStop(measured.stopEvidence),
      noise: summarizeNoise(measured.noise)
    });
  }

  record.axes = Object.freeze(record.axes);
  record.recordId = makeRecordId(record.aircraftKey, record.ordinal);
  const frozenRecord = Object.freeze(record);
  const sourceToken = sourceTokenForSession(session);
  if (sourceToken !== null) {
    RECORD_SOURCE_TOKENS.set(frozenRecord, sourceToken);
  }
  return frozenRecord;
}

function makeRecordId(aircraftKey, ordinal) {
  if (aircraftKey === null || !Number.isInteger(ordinal)) {
    return null;
  }
  return `${aircraftKey}#${ordinal}`;
}

// ---------------------------------------------------------------------------
// Auditing a record against the never-store rules
// ---------------------------------------------------------------------------

/** Anything that looks like a wall clock. The header carries one on every log. */
const CLOCK_PATTERN = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Windows drive letters, POSIX absolute paths, and any log filename. */
const PATH_PATTERN = /^[A-Za-z]:[\\/]|^\/[^/]|\.(?:bbl|bfl|txt|csv)$/i;

/** Longer than this and a value is a trace rather than a measurement. */
const MAXIMUM_ARRAY_LENGTH = 8;

function documentedPathFor(path) {
  // axes.roll.hold.status and axes.yaw.hold.status are one documented field.
  return path.replace(/^axes\.(roll|pitch|yaw)\./, 'axes.*.');
}

function walkRecord(value, path, visit) {
  if (Array.isArray(value)) {
    visit(path, value);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      walkRecord(child, path === '' ? key : `${path}.${key}`, visit);
    }
    return;
  }
  visit(path, value);
}

/**
 * Checks a record against the never-store rules by inspection, not by trust.
 *
 * Four independent checks, because the failure this guards against is a future
 * change that adds "just one more field" — and the most likely such fields are
 * exactly a timestamp and a filename.
 *
 * @returns {{ok: boolean, violations: {path: string, reason: string}[]}}
 */
export function auditFlightRecord(record) {
  const violations = [];
  const seen = new Set();

  walkRecord(record, '', (path, value) => {
    if (path === '') {
      return;
    }
    seen.add(path);

    // `axes.*.stop.positive` is documented as a group, so its children are too.
    const documented = documentedPathFor(path);
    const documentedGroup = documented.replace(/\.(eventCount|[a-zA-Z]+RmsDps|commandAmplitudeDps)$/, '');
    if (!(documented in RECORD_FIELDS) && !(documentedGroup in RECORD_FIELDS)) {
      violations.push({
        path,
        reason: 'not in RECORD_FIELDS; every stored field needs a documented reason'
      });
      // Deliberately NOT a return. An undocumented field is exactly where a
      // timestamp or a filename would arrive, and reporting only "undocumented"
      // would describe the least important thing wrong with it.
    }

    if (typeof value === 'string' && CLOCK_PATTERN.test(value)) {
      violations.push({path, reason: 'looks like a wall-clock time, which is never stored'});
    }
    if (typeof value === 'string' && PATH_PATTERN.test(value)) {
      violations.push({path, reason: 'looks like a file path or filename, which is never stored'});
    }
    if (Array.isArray(value) && value.length > MAXIMUM_ARRAY_LENGTH) {
      violations.push({path, reason: 'looks like a raw trace, which is never stored'});
    }
  });

  for (const documented of Object.keys(RECORD_FIELDS)) {
    const present = [...seen].some(path => {
      const normalized = documentedPathFor(path);
      return normalized === documented || normalized.startsWith(`${documented}.`);
    });
    if (!present) {
      violations.push({
        path: documented,
        reason: 'documented but absent; the stored shape must be fixed, not conditional'
      });
    }
  }

  return Object.freeze({ok: violations.length === 0, violations: Object.freeze(violations)});
}

// ---------------------------------------------------------------------------
// The store: add, list, forget, export, import
// ---------------------------------------------------------------------------

/** An empty history. The caller decides where it lives; this module never does. */
export function createHistory() {
  return Object.freeze({
    schemaVersion: FLIGHT_HISTORY_SCHEMA_VERSION,
    kind: FLIGHT_HISTORY_KIND,
    records: Object.freeze([]),
    /**
     * Next ordinal per aircraft.
     *
     * Kept so that forgetting a flight cannot make the next one reuse its id —
     * a reused id would silently attach a "forget this flight" tap to a
     * different flight. It is a running count the device keeps about itself,
     * which is the standing rule here, and it carries no clock.
     */
    sequences: Object.freeze({})
  });
}

function isHistory(history) {
  return Boolean(history)
    && history.kind === FLIGHT_HISTORY_KIND
    && Array.isArray(history.records);
}

/**
 * Adds a record, assigning its ordinal and id, and caps the aircraft's history.
 *
 * Returns a NEW history; the input is never mutated, because the caller may
 * still be rendering it. The oldest record is dropped when the cap is reached —
 * a history that grows forever is a trail.
 */
export function addFlightRecord(history, record) {
  const base = isHistory(history) ? history : createHistory();

  if (!record || record.kind !== FLIGHT_RECORD_KIND || record.aircraftKey === null) {
    return base;
  }

  const nextOrdinal = base.sequences[record.aircraftKey] ?? 0;
  const stored = Object.freeze({
    ...record,
    ordinal: nextOrdinal,
    recordId: makeRecordId(record.aircraftKey, nextOrdinal)
  });
  const sourceToken = RECORD_SOURCE_TOKENS.get(record);
  if (sourceToken !== undefined) {
    RECORD_SOURCE_TOKENS.set(stored, sourceToken);
  }

  const kept = [...base.records, stored];
  const forThisAircraft = kept.filter(entry => entry.aircraftKey === record.aircraftKey);
  const excess = forThisAircraft.length - HISTORY_LIMITS.maximumRecordsPerAircraft;
  const dropped = excess <= 0
    ? new Set()
    : new Set(
      [...forThisAircraft]
        .sort((left, right) => left.ordinal - right.ordinal)
        .slice(0, excess)
        .map(entry => entry.recordId)
    );

  return Object.freeze({
    schemaVersion: FLIGHT_HISTORY_SCHEMA_VERSION,
    kind: FLIGHT_HISTORY_KIND,
    records: Object.freeze(kept.filter(entry => !dropped.has(entry.recordId))),
    sequences: Object.freeze({...base.sequences, [record.aircraftKey]: nextOrdinal + 1})
  });
}

/** Every aircraft the history knows about, for the history screen. */
export function listAircraft(history) {
  if (!isHistory(history)) {
    return Object.freeze([]);
  }

  const byKey = new Map();
  for (const record of history.records) {
    const existing = byKey.get(record.aircraftKey);
    if (existing) {
      existing.flightCount += 1;
      continue;
    }
    byKey.set(record.aircraftKey, {
      aircraftKey: record.aircraftKey,
      craftName: record.craftName,
      board: record.board,
      flightCount: 1
    });
  }

  return Object.freeze([...byKey.values()].map(entry => Object.freeze(entry)));
}

/** One aircraft's flights, oldest first. */
export function findRecords(history, aircraftKey) {
  if (!isHistory(history)) {
    return Object.freeze([]);
  }
  return Object.freeze(
    history.records
      .filter(record => record.aircraftKey === aircraftKey)
      .sort((left, right) => left.ordinal - right.ordinal)
  );
}

/**
 * Whether two records describe the SAME flight, analysed twice.
 *
 * Rounded summaries are not an identity: two distinct flights can produce the
 * same stored values. Records built from the same decoded session instead carry
 * one process-local token. It survives storage and re-analysis in this process,
 * but is never serialised, so no timestamp or raw-log fingerprint is retained.
 *
 * WHY THIS EXISTS. Reproduced on a handset: save a flight, switch the window to
 * "Whole log", switch back to the detected one. The window change rebuilds the
 * candidate and clears the viewer's note of what it had just stored, so the most
 * recent stored record — this same flight — became the baseline. The panel then
 * showed 19.00 against 19.00 and 20.54 against 20.54, and offered Save again,
 * which stored a third copy.
 *
 * A flight compared with itself is not merely useless. It is a before/after
 * table whose two columns are guaranteed to agree, which is the most convincing
 * possible way to tell somebody their change did nothing.
 */
export function isSameFlight(left, right) {
  const looksLikeRecord = value =>
    value?.kind === FLIGHT_RECORD_KIND && typeof value.aircraftKey === 'string';
  if (!looksLikeRecord(left) || !looksLikeRecord(right)) {
    return false;
  }
  if (left === right) {
    return true;
  }

  const leftToken = RECORD_SOURCE_TOKENS.get(left);
  const rightToken = RECORD_SOURCE_TOKENS.get(right);
  return leftToken !== undefined && leftToken === rightToken;
}

/**
 * The flight to compare a candidate against, and whether it is already stored.
 *
 * Kept beside the record shape rather than in the viewer, so the rule that a
 * flight is never its own baseline can be tested without a browser.
 *
 * @returns {{baseline: object|null, storedAs: string|null}} `baseline` is the
 *   most recent DIFFERENT flight, or null. `storedAs` is the recordId this
 *   candidate is already saved under, or null.
 */
export function selectBaseline(history, candidate) {
  const kept = findRecords(history, candidate?.aircraftKey ?? null);
  if (kept.length === 0) {
    return Object.freeze({baseline: null, storedAs: null});
  }

  const last = kept[kept.length - 1];
  if (isSameFlight(last, candidate)) {
    return Object.freeze({
      baseline: kept.length > 1 ? kept[kept.length - 2] : null,
      storedAs: last.recordId ?? null
    });
  }
  return Object.freeze({baseline: last, storedAs: null});
}

/**
 * Forgets one flight.
 *
 * The sequence counter is deliberately left alone: see `createHistory`.
 */
export function forgetFlight(history, recordId) {
  if (!isHistory(history)) {
    return createHistory();
  }
  return Object.freeze({
    ...history,
    records: Object.freeze(history.records.filter(record => record.recordId !== recordId))
  });
}

/** Forgets one aircraft entirely, counter included — nothing of it remains. */
export function forgetAircraft(history, aircraftKey) {
  if (!isHistory(history)) {
    return createHistory();
  }
  const sequences = {...history.sequences};
  delete sequences[aircraftKey];

  return Object.freeze({
    ...history,
    records: Object.freeze(history.records.filter(record => record.aircraftKey !== aircraftKey)),
    sequences: Object.freeze(sequences)
  });
}

/**
 * Empties the history completely.
 *
 * Returns a fresh empty history rather than a filtered one, so the sequence
 * counters go with it. A "delete everything" that leaves a counter behind has
 * left a count of how many times this person flew, which is the trail the whole
 * design is avoiding.
 */
export function forgetEverything() {
  return createHistory();
}

/**
 * The measurement half of a record — gains and axes — rebuilt field by field.
 *
 * Shared by `exportableRecord` and `shareableRecord` so the numbers are derived
 * in ONE place. Nothing here reads an identity: no craft name, no key, no id.
 * That is deliberate. If the two projections each rebuilt the axes themselves,
 * the shared one would drift from the local one field by field, and the drift
 * that matters is the one nobody notices.
 *
 * Status is pinned here rather than content-copied. `auditShareableRecord` does
 * not scan enumeration fields by value because a helicopter named "Detected"
 * or "Not" must be able to audit its own record. A tampered history therefore
 * cannot turn either status into an unscanned string channel.
 */
const KNOWN_EVIDENCE_STATUSES = new Set(['not-measured', 'inconclusive', 'captured']);

function evidenceStatusOrNotMeasured(status) {
  return KNOWN_EVIDENCE_STATUSES.has(status) ? status : 'not-measured';
}

function projectMeasurements(record) {
  const axes = {};
  for (const axis of AXES) {
    const source = record?.axes?.[axis] ?? {};
    const hold = {status: evidenceStatusOrNotMeasured(source.hold?.status)};
    for (const field of HOLD_SUMMARY_FIELDS) {
      hold[field] = finiteOrNull(source.hold?.[field]);
    }

    const stop = {status: evidenceStatusOrNotMeasured(source.stop?.status)};
    for (const direction of DIRECTIONS) {
      const measured = source.stop?.[direction] ?? {};
      const summary = {
        eventCount: Number.isInteger(measured.eventCount) ? measured.eventCount : 0
      };
      for (const field of STOP_DIRECTION_FIELDS) {
        summary[field] = finiteOrNull(measured[field]);
      }
      stop[direction] = summary;
    }

    axes[axis] = {
      headspeedMedianRpm: finiteOrNull(source.headspeedMedianRpm),
      hold,
      stop,
      noise: {
        filteredHighFrequencyRmsDps: finiteOrNull(source.noise?.filteredHighFrequencyRmsDps),
        unfilteredHighFrequencyRmsDps: finiteOrNull(source.noise?.unfilteredHighFrequencyRmsDps)
      }
    };
  }

  const gainsOf = axis => {
    const line = record?.gains?.[axis];
    return Array.isArray(line)
      && line.length >= GAIN_TERMS.length
      && line.every(Number.isFinite)
      ? [...line]
      : null;
  };

  return {
    gains: {roll: gainsOf('roll'), pitch: gainsOf('pitch'), yaw: gainsOf('yaw')},
    axes
  };
}

function exportableRecord(record) {
  // Rebuilt from the documented shape rather than copied, which makes the
  // never-store list structural for KEYS: a field a caller pushed into a record
  // in memory has no path to disk, because nothing here reads it.
  //
  // BE PRECISE ABOUT WHAT THAT DOES NOT COVER. `recordId` and `windowBasis`
  // have their CONTENT copied through after a type check; `ratesFingerprint`
  // has a versioned shape check as well, but its component values still pass
  // through. A caller that wrote something forbidden into one of those strings
  // could otherwise see it exported. The structural guarantee is about the
  // shape; `auditFlightRecord` covers the values and is therefore not optional.
  // Anything added below that copies a value rather than deriving it belongs on
  // that same list.
  const rebuilt = buildFlightRecord({
    session: {
      craftName: record?.craftName ?? null,
      board: record?.board ?? null,
      headers: {},
      firmware: {revision: record?.firmwareRevision ?? null}
    },
    window: null
  });

  const {gains, axes} = projectMeasurements(record);

  return {
    ...rebuilt,
    recordId: typeof record?.recordId === 'string' ? record.recordId : null,
    ordinal: Number.isInteger(record?.ordinal) ? record.ordinal : null,
    aircraftKey: rebuilt.aircraftKey,
    windowBasis: typeof record?.windowBasis === 'string' ? record.windowBasis : null,
    durationSeconds: finiteOrNull(record?.durationSeconds),
    ratesFingerprint: ratesFingerprintReadable(record?.ratesFingerprint)
      ? record.ratesFingerprint
      : null,
    gains,
    axes
  };
}

/**
 * Serialises the history to text the pilot can read, export, and hand to
 * anybody.
 *
 * Human-readable on purpose. An export the pilot cannot read is an export they
 * have to trust, and the whole point of the export is that they should not have
 * to.
 */
export function exportHistory(history) {
  const base = isHistory(history) ? history : createHistory();
  return `${JSON.stringify({
    schemaVersion: FLIGHT_HISTORY_SCHEMA_VERSION,
    kind: FLIGHT_HISTORY_KIND,
    records: base.records.map(exportableRecord),
    sequences: {...base.sequences}
  }, null, 2)}\n`;
}

/**
 * Reads an exported history back, and never throws.
 *
 * A corrupt or truncated file must lose the history, not the app: this runs on
 * start, and a throw here would be a blank screen for a pilot at the field.
 *
 * @returns {{history: object, codes: string[]}}
 */
export function importHistory(text) {
  const codes = [];

  if (typeof text !== 'string' || text.trim() === '') {
    return Object.freeze({history: createHistory(), codes: Object.freeze(['HISTORY_EMPTY'])});
  }

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return Object.freeze({
      history: createHistory(),
      codes: Object.freeze(['HISTORY_UNREADABLE'])
    });
  }

  if (!parsed || parsed.kind !== FLIGHT_HISTORY_KIND) {
    return Object.freeze({
      history: createHistory(),
      codes: Object.freeze(['HISTORY_KIND_MISMATCH'])
    });
  }
  const legacySchema = parsed.schemaVersion === LEGACY_FLIGHT_HISTORY_SCHEMA_VERSION;
  if (parsed.schemaVersion !== FLIGHT_HISTORY_SCHEMA_VERSION && !legacySchema) {
    // Refused rather than guessed at. A record read under the wrong schema is a
    // comparison built on fields that meant something else.
    return Object.freeze({
      history: createHistory(),
      codes: Object.freeze(['HISTORY_SCHEMA_VERSION_MISMATCH'])
    });
  }

  const records = Array.isArray(parsed.records) ? parsed.records : [];
  const malformedCurrentFingerprint = !legacySchema && records.some(record =>
    normalizeText(record?.ratesFingerprint) !== null
      && !ratesFingerprintReadable(record.ratesFingerprint));
  const kept = records
    .filter(record => record?.kind === FLIGHT_RECORD_KIND && typeof record.aircraftKey === 'string')
    .map(record => {
      const migrated = exportableRecord(record);
      return Object.freeze(legacySchema
        ? {...migrated, ratesFingerprint: null}
        : migrated);
    });

  if (legacySchema || malformedCurrentFingerprint) {
    // The old fingerprint omitted expo, and a malformed current fingerprint is
    // no stronger. Preserve every flight for the pilot to inspect or delete,
    // but never use matching incomplete strings as proof that two controller
    // configurations were equal.
    addCode(codes, 'HISTORY_RATE_FINGERPRINTS_INVALIDATED');
  }

  if (kept.length !== records.length) {
    addCode(codes, 'HISTORY_RECORDS_DISCARDED');
  }

  const sequences = {};
  for (const record of kept) {
    const next = Number.isInteger(record.ordinal) ? record.ordinal + 1 : 0;
    sequences[record.aircraftKey] = Math.max(sequences[record.aircraftKey] ?? 0, next);
  }
  for (const [key, value] of Object.entries(parsed.sequences ?? {})) {
    if (Number.isInteger(value)) {
      sequences[key] = Math.max(sequences[key] ?? 0, value);
    }
  }

  return Object.freeze({
    history: Object.freeze({
      schemaVersion: FLIGHT_HISTORY_SCHEMA_VERSION,
      kind: FLIGHT_HISTORY_KIND,
      records: Object.freeze(kept),
      sequences: Object.freeze(sequences)
    }),
    codes: Object.freeze(codes)
  });
}

// ---------------------------------------------------------------------------
// The shared projection, and the identity it carries instead of a name
// ---------------------------------------------------------------------------
//
// NOTHING IN THIS SECTION SENDS ANYTHING. There is no transport here, and the
// app requests neither INTERNET nor a sensitive platform permission. (AndroidX
// may add an app-local signature permission to the merged manifest.) Tests pin
// that security boundary to the Android manifest. What follows is the SHAPE
// data would take if the owner ever
// decides to add one — built and proved now, because retrofitting a projection
// onto records already collected is how a name escapes.
//
// See `docs/SHARED_CORPUS_DESIGN.md` sections 2 and 4a. That document is the
// agreement; this code implements it, and section 7 states plainly what adding
// the transport would cost.

/**
 * The kind a shared record carries, which is NOT the local one.
 *
 * The design lists `kind` among the shared fields without fixing its value. It
 * is given a distinct one here because the two shapes are not interchangeable:
 * a shared record has no `aircraftKey`, and `addFlightRecord` admits anything
 * whose key is not literally `null` — so a shared record wearing the local kind
 * would be stored as an aircraft with an undefined key. One constant makes that
 * unrepresentable in both directions.
 */
export const SHARED_RECORD_KIND = 'rotorlens-shared-flight-record';

/**
 * WHAT MAY NEVER APPEAR IN A SHARED RECORD, beyond everything on NEVER_STORED.
 *
 * NEVER_STORED already governs what reaches the device's own file. This list is
 * the second, narrower rule: three fields that are perfectly fine on the pilot's
 * own phone and must not leave it. `auditShareableRecord` enforces all three by
 * inspection, by key AND by value, because two of them are strings that carry
 * the third one inside them.
 */
export const NEVER_SHARED = Object.freeze([
  Object.freeze({
    what: 'craftName',
    why: 'whatever the pilot typed into the configurator. Harmless in their own history — it is how the history screen names the machine in their words — and people name helicopters after themselves, their callsign or their children'
  }),
  Object.freeze({
    what: 'aircraftKey',
    why: 'the craft name lowercased with the board appended, so it carries the same name in a field whose own name does not admit it. A projection that dropped craftName and kept this would have leaked exactly as much'
  }),
  Object.freeze({
    what: 'recordId',
    why: 'built as `${aircraftKey}#${ordinal}`, so it carries the name a second time inside a value that reads like an opaque handle. This is the one a reviewer scanning field NAMES would pass over, which is why the audit also scans values'
  }),
  Object.freeze({
    what: 'anything on NEVER_STORED — the log, coordinates, dates, filenames, traces',
    why: 'the local record was already careful about all of it. A shared projection that relaxed any of it would be the same defect one level further out, and one level further from anyone who could notice'
  })
]);

/** Enforced by key. Each is a field a local record legitimately carries. */
const NEVER_SHARED_KEYS = Object.freeze(['craftName', 'aircraftKey', 'recordId']);

/**
 * The fields carried over from RECORD_FIELDS, by name and one at a time.
 *
 * WRITTEN OUT RATHER THAN DERIVED, deliberately. Deriving this as "RECORD_FIELDS
 * minus three" would mean any field a future change adds to the local record
 * becomes shareable the moment it is added, with no second decision — and the
 * whole reason two allowlists exist is that the second decision is a different
 * decision. A field added to RECORD_FIELDS and not added here simply is not
 * shared; if it is also projected below, `auditShareableRecord` goes red.
 */
const SHARED_FROM_RECORD_FIELDS = Object.freeze([
  'schemaVersion',
  'ordinal',
  'board',
  'firmwareRevision',
  'windowBasis',
  'durationSeconds',
  'ratesFingerprint',
  'gains.roll',
  'gains.pitch',
  'gains.yaw',
  'axes.*.headspeedMedianRpm',
  'axes.*.hold.status',
  'axes.*.hold.holdCount',
  'axes.*.hold.zeroHoldCount',
  'axes.*.hold.sustainedHoldCount',
  'axes.*.hold.meanAbsoluteSteadyStateErrorDps',
  'axes.*.hold.worstAbsoluteSteadyStateErrorDps',
  'axes.*.hold.meanErrorDriftDpsPerSecond',
  'axes.*.hold.meanErrorRippleRmsDps',
  'axes.*.hold.meanErrorCrossingRateHz',
  'axes.*.hold.meanITermRms',
  'axes.*.stop.status',
  'axes.*.stop.positive',
  'axes.*.stop.negative',
  'axes.*.noise.filteredHighFrequencyRmsDps',
  'axes.*.noise.unfilteredHighFrequencyRmsDps'
]);

function sharedFieldsFromRecord() {
  const fields = {};
  for (const path of SHARED_FROM_RECORD_FIELDS) {
    // A name that is not in RECORD_FIELDS is a typo, and a typo here would
    // silently drop a field from the shared allowlist while looking correct.
    // `test/flight-history.test.mjs` asserts the correspondence; this keeps the
    // reason string singular rather than copied and left to rot.
    if (path in RECORD_FIELDS) {
      fields[path] = RECORD_FIELDS[path];
    }
  }
  return fields;
}

/**
 * EVERY SHARED FIELD, WITH THE REASON IT MAY LEAVE THE DEVICE.
 *
 * The second, narrower allowlist beside RECORD_FIELDS, in the same shape and
 * read the same way: `auditShareableRecord` requires that nothing outside it is
 * present and that nothing in it is absent. Every reason carried over is the
 * reason the field earns its place at all; the two below are specific to
 * sharing, because those two fields mean something different once shared.
 */
export const SHARED_RECORD_FIELDS = Object.freeze({
  kind:
    'so a shared record is never mistaken for a local one, in either direction — the shared shape has no aircraft key, and a store that accepted it would hold an aircraft that cannot be named, found or forgotten',
  sharingId:
    'the opaque identity that replaces craftName and aircraftKey. It groups one machine\'s flights, which null pairs require — two flights with nothing changed are how a noise floor is measured — and identifies nobody. See newSharingId for how it is generated and why it is not derived',
  ...sharedFieldsFromRecord()
});

// ---------------------------------------------------------------------------
// The sharing identity
// ---------------------------------------------------------------------------

/**
 * 32 symbols, Crockford's alphabet: no i, l, o or u.
 *
 * i/l/1 and o/0 are the pairs a person transcribing by hand gets wrong, and the
 * design requires the id be readable off a screen and written down — it is the
 * only way a pilot who wipes the app can still ask for their records to be
 * deleted. Dropping u additionally means no run of letters spells a word.
 */
const SHARING_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

const SHARING_ID_GROUPS = 4;
const SHARING_ID_GROUP_LENGTH = 5;

/** Four groups of five symbols: `k7f3z-9xqm2-wtbr5-hnp8d`. 100 bits. */
const SHARING_ID_PATTERN = new RegExp(
  `^[${SHARING_ID_ALPHABET}]{${SHARING_ID_GROUP_LENGTH}}`
  + `(?:-[${SHARING_ID_ALPHABET}]{${SHARING_ID_GROUP_LENGTH}}){${SHARING_ID_GROUPS - 1}}$`
);

/** Whether a value is a well-formed sharing id. Shape only; see newSharingId. */
export function isSharingId(value) {
  return typeof value === 'string' && SHARING_ID_PATTERN.test(value);
}

/**
 * A new opaque sharing identity for one aircraft.
 *
 * HOW IT IS GENERATED. 20 bytes from the platform's cryptographic random source
 * — `crypto.getRandomValues`, which Node, every browser and the Android WebView
 * all provide — reduced to one symbol each by taking the low five bits. 256 is a
 * whole multiple of 32, so masking is uniform; a modulo of a non-multiple would
 * quietly bias the early symbols, and a biased id is a smaller id than it looks.
 * That is 100 bits of entropy, formatted as four groups of five so a pilot can
 * copy it off the screen without transcription errors.
 *
 * WHY IT TAKES NO ARGUMENTS, WHICH IS THE POINT. It cannot be derived from the
 * craft name because it cannot SEE the craft name: this function has arity zero
 * and reads nothing but the random source. A derived id — a hash of the name, of
 * the key, of anything the pilot typed — would look exactly as opaque, would be
 * the obvious way to write this, and would carry the name back in disguised
 * form: anyone holding a list of likely names could hash each one and recover
 * the mapping, and the name would then be attached to every record ever sent.
 * That is the single failure the whole projection exists to prevent, so the
 * defence is structural rather than a comment asking the next author not to.
 *
 * The id is generated ONCE per aircraft and stored beside the history, by the
 * caller — this module persists nothing. Regenerating it per record would break
 * the grouping that null pairs depend on; regenerating it per install is how a
 * pilot who wipes the app loses the ability to delete what was already sent, and
 * `docs/SHARED_CORPUS_DESIGN.md` section 5 requires that be said in the app
 * rather than buried.
 *
 * @returns {string|null} the id, or null when the platform has no cryptographic
 *   random source. Null rather than a `Math.random` fallback: a fallback would
 *   be indistinguishable from the real thing at the call site while colliding
 *   between devices, which would pool two pilots' aircraft into one. Nothing can
 *   be shared without an id, which is the correct way to fail.
 */
export function newSharingId() {
  const source = globalThis.crypto;
  if (!source || typeof source.getRandomValues !== 'function') {
    return null;
  }

  const bytes = source.getRandomValues(new Uint8Array(SHARING_ID_GROUPS * SHARING_ID_GROUP_LENGTH));
  const groups = [];
  for (let group = 0; group < SHARING_ID_GROUPS; group += 1) {
    let text = '';
    for (let index = 0; index < SHARING_ID_GROUP_LENGTH; index += 1) {
      text += SHARING_ID_ALPHABET[bytes[group * SHARING_ID_GROUP_LENGTH + index] & 31];
    }
    groups.push(text);
  }
  return groups.join('-');
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

/**
 * The anonymised projection of a stored record: what could be shared, and no
 * more.
 *
 * A SECOND, NARROWER ALLOWLIST beside `exportableRecord`, and built the same
 * way — each field named here explicitly rather than copied from the record —
 * so a field a caller pushed into a record in memory has no path out, because
 * nothing below reads it.
 *
 * The difference is three fields. `craftName` and `aircraftKey` are replaced by
 * `sharingId`, and `recordId` has no shared equivalent at all: it is the key
 * with the ordinal appended, and the ordinal is already here on its own. Every
 * remaining field describes EQUIPMENT — a board model, a firmware string, gains,
 * head speed, how well an axis tracked — rather than a person.
 *
 * The same precision `exportableRecord` insists on applies here: `board`,
 * `firmwareRevision`, `ratesFingerprint` and `sharingId` have their CONTENT
 * copied through after a type check, so `auditShareableRecord` is what covers
 * their values and is not optional.
 *
 * @param {object} record a stored flight record
 * @param {string} sharingId the aircraft's id, from `newSharingId`, held by the
 *   caller. Anything that is not a well-formed id becomes null, and a shared
 *   record with a null id fails the audit rather than being sent unattributable
 * @returns {object} the projection. It is not sent anywhere: nothing in this
 *   repository can reach a network
 */
export function shareableRecord(record, sharingId = null) {
  const {gains, axes} = projectMeasurements(record);

  return Object.freeze({
    schemaVersion: FLIGHT_HISTORY_SCHEMA_VERSION,
    kind: SHARED_RECORD_KIND,
    sharingId: isSharingId(sharingId) ? sharingId : null,
    ordinal: Number.isInteger(record?.ordinal) ? record.ordinal : null,
    board: normalizeText(record?.board),
    firmwareRevision: normalizeText(record?.firmwareRevision),
    // NOT a type check, unlike the local export at `exportableRecord`. There the
    // value is content-copied, and a record read back from a tampered or corrupt
    // history file carries whatever that file said — `importHistory` accepts an
    // unrecognised basis without a code. That is how a craft name reaches a field
    // whose NAME looks like an enumeration, which no field-by-field review would
    // catch and which the by-value scan below deliberately does not read. Pinning
    // it to the enumeration is what makes that exclusion true rather than assumed.
    windowBasis: KNOWN_WINDOW_BASES.has(record?.windowBasis) ? record.windowBasis : null,
    durationSeconds: finiteOrNull(record?.durationSeconds),
    ratesFingerprint: typeof record?.ratesFingerprint === 'string'
      ? record.ratesFingerprint
      : null,
    gains,
    axes
  });
}

/** Every value `FlightWindowBasis` defines; anything else is not a basis. */
const KNOWN_WINDOW_BASES = new Set(Object.values(FlightWindowBasis));

/**
 * Shared fields whose content is passed through rather than derived.
 *
 * These are the ones scanned for a leaked name by VALUE. The rest of the shared
 * strings are enumerations — `windowBasis`, `kind`, every `status` — and scanning
 * those for a substring would fail on a helicopter named "Detected" or "Not"
 * while proving nothing.
 *
 * That exclusion is only sound because `shareableRecord` pins `windowBasis` to
 * `FlightWindowBasis`, and `projectMeasurements` pins evidence status to its
 * closed set, rather than copying either field from a stored record.
 */
const SHARED_PASSTHROUGH_FIELDS = Object.freeze([
  'board',
  'firmwareRevision',
  'ratesFingerprint',
  'sharingId'
]);

/**
 * Checks a shared projection the way `auditFlightRecord` checks a local record,
 * and then checks the two things only sharing can get wrong.
 *
 * Everything the local audit does: nothing undocumented, no wall clock, no file
 * path, no raw trace, and the shape fixed rather than conditional — against
 * SHARED_RECORD_FIELDS, which is narrower. Then:
 *
 *   - no `craftName`, `aircraftKey` or `recordId`, BY KEY at any depth;
 *   - none of those values hiding inside a pass-through string, BY VALUE, when
 *     the source record is supplied. This is the check that catches `recordId`
 *     copied into some other field, which is the leak a key-only audit misses;
 *   - a well-formed `sharingId`, because a record that cannot be grouped cannot
 *     be deleted either, and a record nobody can delete must not be sent;
 *   - the shared `kind`, so the two shapes stay distinguishable.
 *
 * IT CATCHES A FIELD ADDED, not merely a value: every path in the projection is
 * checked against the allowlist, so a field someone adds to `shareableRecord`
 * without adding it to SHARED_RECORD_FIELDS is a violation the moment it exists,
 * whatever it contains and whether or not anyone thought to test for it.
 *
 * @param {object} shared the projection from `shareableRecord`
 * @param {object} [source] the record it was projected from. Supplying it turns
 *   on the by-value scan; without it the by-key checks still run
 * @returns {{ok: boolean, violations: {path: string, reason: string}[]}}
 */
export function auditShareableRecord(shared, source = null) {
  const violations = [];
  const seen = new Set();

  const forbiddenValues = [];
  for (const key of NEVER_SHARED_KEYS) {
    const value = source?.[key];
    if (typeof value === 'string' && value.trim() !== '') {
      forbiddenValues.push({key, needle: value.trim().toLowerCase()});
    }
  }

  walkRecord(shared, '', (path, value) => {
    if (path === '') {
      return;
    }
    seen.add(path);

    const documented = documentedPathFor(path);
    const documentedGroup = documented.replace(
      /\.(eventCount|[a-zA-Z]+RmsDps|commandAmplitudeDps)$/,
      ''
    );
    const known = documented in SHARED_RECORD_FIELDS || documentedGroup in SHARED_RECORD_FIELDS;
    if (!known) {
      violations.push({
        path,
        reason: 'not in SHARED_RECORD_FIELDS; the shared shape is a second, narrower allowlist and a field with no entry there is not shareable'
      });
      // Deliberately NOT a return, exactly as in auditFlightRecord: an
      // undocumented field is where a name or a clock would arrive, and
      // reporting only "undocumented" would name the least important thing
      // wrong with it.
    }

    const leaf = path.slice(path.lastIndexOf('.') + 1);
    if (NEVER_SHARED_KEYS.includes(leaf)) {
      violations.push({
        path,
        reason: `${leaf} is never shared; the sharingId is what replaces it`
      });
    }

    if (typeof value === 'string' && CLOCK_PATTERN.test(value)) {
      violations.push({path, reason: 'looks like a wall-clock time, which is never stored'});
    }
    if (typeof value === 'string' && PATH_PATTERN.test(value)) {
      violations.push({path, reason: 'looks like a file path or filename, which is never stored'});
    }
    if (Array.isArray(value) && value.length > MAXIMUM_ARRAY_LENGTH) {
      violations.push({path, reason: 'looks like a raw trace, which is never stored'});
    }

    if (typeof value === 'string' && (!known || SHARED_PASSTHROUGH_FIELDS.includes(leaf))) {
      const haystack = value.toLowerCase();
      for (const {key, needle} of forbiddenValues) {
        if (haystack.includes(needle)) {
          violations.push({
            path,
            reason: `carries ${key} as a value; the name may not leave the device in any field, however that field is named`
          });
        }
      }
    }
  });

  for (const documented of Object.keys(SHARED_RECORD_FIELDS)) {
    const present = [...seen].some(path => {
      const normalized = documentedPathFor(path);
      return normalized === documented || normalized.startsWith(`${documented}.`);
    });
    if (!present) {
      violations.push({
        path: documented,
        reason: 'documented but absent; the shared shape must be fixed, not conditional'
      });
    }
  }

  if (!isSharingId(shared?.sharingId)) {
    violations.push({
      path: 'sharingId',
      reason: 'missing or malformed; a record with no sharing id can be neither grouped into null pairs nor deleted on request, and must not be shared'
    });
  }
  if (shared?.kind !== SHARED_RECORD_KIND) {
    violations.push({
      path: 'kind',
      reason: `must be ${SHARED_RECORD_KIND}, so a shared record and a local one are never mistaken for each other`
    });
  }

  return Object.freeze({ok: violations.length === 0, violations: Object.freeze(violations)});
}

// ---------------------------------------------------------------------------
// The paired comparison
// ---------------------------------------------------------------------------

/**
 * What a paired comparison can conclude.
 *
 * `NOT_ENOUGH_EVIDENCE` is the default and, on real logs, the usual answer.
 * `NO_DETECTABLE_CHANGE` is deliberately a different word: it means the evidence
 * WAS adequate and the movement was below the floor, which is a real finding and
 * the opposite message to "we could not tell". Conflating those two was one of
 * the defects this design exists to avoid.
 */
export const COMPARISON_OUTCOME = Object.freeze({
  IMPROVED: 'improved',
  WORSENED: 'worsened',
  NO_DETECTABLE_CHANGE: 'no-detectable-change',
  /** The numbers moved, but nothing the history knows about was adjusted. */
  NOT_ATTRIBUTABLE: 'not-attributable',
  NOT_ENOUGH_EVIDENCE: 'not-enough-evidence'
});

/**
 * The gains that differ between two records, as named terms.
 *
 * "Exactly one gain changed" fires on 5 of 107 consecutive real flight pairs —
 * a yaw P ladder of three steps, a roll D change and a yaw I change — and just
 * 1 of those 5 has usable evidence on both sides. The other four die for a
 * reason worth knowing: the yaw P ladder produced ZERO yaw hold segments on all
 * four of its flights, because a pilot testing P flies stops and pirouettes
 * rather than holds, and both roll D flights never left the ground. The
 * constraint is not that pilots never change one gain. It is that the evidence
 * is missing when they do. The feature is expected to be silent almost always.
 */
export function describeGainChanges(before, after) {
  const changes = [];
  const codes = [];

  for (const axis of AXES) {
    const from = before?.gains?.[axis];
    const to = after?.gains?.[axis];

    const readable = line => Array.isArray(line)
      && line.length >= GAIN_TERMS.length
      && line.every(Number.isFinite);
    if (!readable(from) || !readable(to)) {
      addCode(codes, 'GAINS_UNREADABLE');
      continue;
    }
    if (from.length !== to.length) {
      addCode(codes, 'GAIN_LINE_SHAPE_CHANGED');
      continue;
    }

    for (let index = 0; index < from.length; index += 1) {
      if (from[index] === to[index]) {
        continue;
      }
      changes.push(Object.freeze({
        axis,
        // Beyond P, I and D the header's remaining values are feedforward and
        // boost. They are reported by index rather than named, because naming
        // them would be a claim about a header layout this module does not own.
        term: index < GAIN_TERMS.length ? GAIN_TERMS[index] : `index${index}`,
        index,
        from: from[index],
        to: to[index]
      }));
    }
  }

  return Object.freeze({changes: Object.freeze(changes), codes: Object.freeze(codes)});
}

function headspeedComparable(before, after, axis) {
  const from = before?.axes?.[axis]?.headspeedMedianRpm;
  const to = after?.axes?.[axis]?.headspeedMedianRpm;
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    // Not knowing is not the same as matching. A missing headspeed cannot clear
    // the confound check, so it fails it.
    return false;
  }
  const largest = Math.max(Math.abs(from), Math.abs(to));
  if (largest === 0) {
    return false;
  }
  return Math.abs(to - from) / largest <= HISTORY_LIMITS.maximumHeadspeedVariationRatio;
}

function compareAxisHold(before, after, axis, changedTerm = null) {
  const codes = [];
  const from = before?.axes?.[axis]?.hold;
  const to = after?.axes?.[axis]?.hold;

  const inconclusive = reason => {
    addCode(codes, reason);
    return Object.freeze({
      axis,
      outcome: COMPARISON_OUTCOME.NOT_ENOUGH_EVIDENCE,
      codes: Object.freeze(codes),
      measured: null
    });
  };

  if (from?.status !== 'captured' || to?.status !== 'captured') {
    return inconclusive('HOLD_EVIDENCE_INCONCLUSIVE');
  }

  // n=1 against n=1 cannot support any claim, and 59% of the comparable sides in
  // the reference corpus were exactly that.
  if (!(from.holdCount >= HISTORY_LIMITS.minimumComparisonHolds)
      || !(to.holdCount >= HISTORY_LIMITS.minimumComparisonHolds)) {
    return inconclusive('INSUFFICIENT_HOLD_SEGMENTS_FOR_COMPARISON');
  }

  // A heading hold and a constant-rate turn are different tests. Mixed evidence
  // is not one kind and cannot be compared as though it were.
  const fromKind = holdKindOf(from);
  const toKind = holdKindOf(to);
  if (fromKind === null || toKind === null || fromKind !== toKind) {
    return inconclusive('HOLD_KIND_MISMATCH');
  }

  if (!headspeedComparable(before, after, axis)) {
    return inconclusive('HEADSPEED_MISMATCH');
  }

  const baseline = from.meanAbsoluteSteadyStateErrorDps;
  const test = to.meanAbsoluteSteadyStateErrorDps;
  if (!Number.isFinite(baseline) || !Number.isFinite(test)) {
    return inconclusive('HOLD_METRIC_MISSING');
  }

  const difference = test - baseline;
  const relative = baseline === 0 ? null : difference / Math.abs(baseline);

  const absoluteFloorDps = SENSITIVITY_FLOOR_DPS[axis]
    ?? SENSITIVITY_FLOOR_DPS.pooled;
  const clearsAbsoluteFloor = Math.abs(difference) > absoluteFloorDps;
  const clearsRelativeFloor = Number.isFinite(relative)
    && Math.abs(relative) > HISTORY_LIMITS.comparisonToleranceRatio;

  const measured = Object.freeze({
    metric: 'meanAbsoluteSteadyStateErrorDps',
    before: round(baseline, 4),
    after: round(test, 4),
    differenceDps: round(difference, 4),
    relative: round(relative, 4),
    clearsAbsoluteFloor,
    clearsRelativeFloor,
    noiseFloorDps: absoluteFloorDps,
    holdCounts: Object.freeze({before: from.holdCount, after: to.holdCount})
  });

  // This metric is sustained steady-state error: evidence about the I term. A
  // P, D, feedforward or boost change may coincide with movement in it, but that
  // movement cannot establish that the changed term helped or hurt.
  if (changedTerm !== null && changedTerm !== 'I') {
    addCode(codes, 'RESPONSE_METRIC_NOT_SENSITIVE_TO_TERM');
    return Object.freeze({
      axis,
      outcome: COMPARISON_OUTCOME.NOT_ENOUGH_EVIDENCE,
      codes: Object.freeze(codes),
      measured
    });
  }

  // BOTH FLOORS. Either alone is the shipped defect: a relative floor alone
  // called 0.023 deg/s of yaw error a 78% result, and an absolute floor alone
  // would pass a large aircraft's ordinary variation.
  if (!clearsAbsoluteFloor || !clearsRelativeFloor) {
    addCode(codes, 'CHANGE_BELOW_MEASURED_NOISE_FLOOR');
    return Object.freeze({
      axis,
      outcome: COMPARISON_OUTCOME.NO_DETECTABLE_CHANGE,
      codes: Object.freeze(codes),
      measured
    });
  }

  if (changedTerm === null) {
    // The numbers moved and nothing was adjusted. This is the honest reading of
    // the six-of-six false positives: it is the aircraft, the air, or the pilot.
    addCode(codes, 'NO_GAIN_CHANGE_TO_ATTRIBUTE_IT_TO');
    return Object.freeze({
      axis,
      outcome: COMPARISON_OUTCOME.NOT_ATTRIBUTABLE,
      codes: Object.freeze(codes),
      measured
    });
  }

  return Object.freeze({
    axis,
    outcome: difference < 0 ? COMPARISON_OUTCOME.IMPROVED : COMPARISON_OUTCOME.WORSENED,
    codes: Object.freeze(codes),
    measured
  });
}

/**
 * The stop half of the comparison, which is deliberately not a verdict.
 *
 * Roll and pitch produced ZERO stop events across all 110 real flights, and yaw
 * never reached the two-per-direction minimum, so no floor has ever been
 * measured for these metrics the way one was measured for hold error. Reporting
 * a direction from an unmeasured floor would be exactly the mistake the hold
 * comparison was caught making.
 *
 * The movement is reported so a pilot can see it. The outcome is not.
 */
function compareAxisStop(before, after, axis) {
  const codes = ['STOP_FLOOR_NOT_MEASURED'];
  const directions = {};

  for (const direction of DIRECTIONS) {
    const from = before?.axes?.[axis]?.stop?.[direction];
    const to = after?.axes?.[axis]?.stop?.[direction];
    const fromValue = from?.trackingRmsDps;
    const toValue = to?.trackingRmsDps;

    directions[direction] = Object.freeze({
      eventCounts: Object.freeze({before: from?.eventCount ?? 0, after: to?.eventCount ?? 0}),
      trackingRmsDps: Number.isFinite(fromValue) && Number.isFinite(toValue)
        ? Object.freeze({before: round(fromValue, 4), after: round(toValue, 4)})
        : null
    });
  }

  return Object.freeze({
    axis,
    outcome: COMPARISON_OUTCOME.NOT_ENOUGH_EVIDENCE,
    codes: Object.freeze(codes),
    directions: Object.freeze(directions)
  });
}

/**
 * The largest difference ever measured between two nominally identical flights.
 *
 * From the same 47 identical-gain pairs the floor is derived over — see
 * EVIDENCE_LIMITS.holdErrorNoiseFloorDps in pid-evidence.mjs, which records
 * median 0.044, p90 0.309, p95 0.354, max 1.390.
 */
const OBSERVED_FLOOR_MAX_DPS = 1.39;

/**
 * The sentence a pilot is shown about the floor, beside the numbers.
 *
 * Kept here rather than in the viewer so the number in the sentence cannot drift
 * from the number in the gate.
 *
 * IT SAID "differ by up to 0.39", AND THAT WAS NOT TRUE. 0.39 is the p90 of 47
 * identical-gain pairs, so by construction about one such pair in ten exceeds
 * it, and the worst observed was 1.390 — 3.6x the figure quoted. This is the one
 * sentence whose entire job is to let a pilot tell a result from weather, and a
 * bound it does not have is exactly the wrong thing for it to claim.
 *
 * The gate itself is unchanged: 0.39 is still where a verdict is withheld, and
 * that remains a defensible place to draw it. What changed is that the sentence
 * now describes the figure honestly — a usual case, with the worst case named
 * beside it rather than left out.
 *
 * THE OPTIONAL ARGUMENT is a floor entry from `buildSensitivityModel`, measured
 * on the pilot's OWN aircraft. When one is passed the sentence changes, because
 * the numbers changed and a sentence that kept the corpus wording beside a
 * different number would be the "differ by up to 0.39" incident again with new
 * figures. `test/flight-history.test.mjs` pins the learned sentence separately
 * for exactly that reason: the default sentence's test keeps passing whatever
 * the learned one says.
 *
 * @param {object} [learned] a `model.floors[axis]` entry, or null
 */
export function describeNoiseFloor(learned = null, axis = null) {
  const own = learned?.source === 'own-aircraft' && Number.isFinite(learned.appliedDps)
    ? learned
    : null;

  if (own === null) {
    const floor = SENSITIVITY_FLOOR_DPS[axis] ?? SENSITIVITY_FLOOR_DPS.pooled;
    return Object.freeze({
      absoluteDps: floor,
      observedMaximumDps: OBSERVED_FLOOR_MAX_DPS,
      relativeRatio: HISTORY_LIMITS.comparisonToleranceRatio,
      minimumHoldsPerSide: HISTORY_LIMITS.minimumComparisonHolds,
      source: 'corpus',
      axis,
      sentence: `Two flights with nothing changed between them usually differ by less than `
        + `${floor}°/s on this measurement, and have differed by as much as `
        + `${OBSERVED_FLOOR_MAX_DPS}°/s. A change smaller than that cannot be told apart `
        + `from a different day.`
    });
  }

  return Object.freeze({
    absoluteDps: own.appliedDps,
    observedMaximumDps: own.observedMaxDps,
    relativeRatio: HISTORY_LIMITS.comparisonToleranceRatio,
    minimumHoldsPerSide: HISTORY_LIMITS.minimumComparisonHolds,
    source: 'own-aircraft',
    sentence: `Measured on your own ${own.axis}: across ${own.nullPairCount} pairs of your `
      + `flights with nothing changed between them, this measurement usually differed by less `
      + `than ${own.p90Dps}°/s and at worst by ${own.observedMaxDps}°/s. ${own.appliedDps}°/s `
      + `is what is now used, in place of the ${SENSITIVITY_FLOOR_DPS[own.axis]}°/s measured `
      + `on other people's machines.`
  });
}

/**
 * Compares two records of the same aircraft.
 *
 * Reports three things, in this order of importance:
 *   1. WHAT CHANGED — the gains that differ, as named terms.
 *   2. WHAT MOVED — the measurement, with the floor beside it.
 *   3. WHETHER THE MOVEMENT MEANS ANYTHING — which is usually no.
 *
 * Refuses outright, before any measurement is read, when the two records are not
 * a controlled pair: a different aircraft, a different firmware, a different
 * rate curve, several gains at once, or a profile switch. Those refusals are the
 * feature. Six of six identical-gain pairs in the corpus produced a confident
 * verdict from the shipped comparison; none of them survives this one.
 *
 * @param {object} before earlier record (the lower ordinal)
 * @param {object} after  later record
 */
export function compareFlightRecords(before, after) {
  const codes = [];
  let floor = describeNoiseFloor();

  const refuse = reason => Object.freeze({
    schemaVersion: FLIGHT_HISTORY_SCHEMA_VERSION,
    kind: FLIGHT_COMPARISON_KIND,
    aircraftKey: before?.aircraftKey ?? null,
    comparable: false,
    outcome: COMPARISON_OUTCOME.NOT_ENOUGH_EVIDENCE,
    // Same shape as a successful comparison. A refusal that returns a different
    // object is a refusal a viewer reads with `?.` and renders as a blank.
    changedAxis: null,
    changedTerm: null,
    codes: Object.freeze(addCode(codes, reason)),
    gainChanges: Object.freeze([]),
    axes: Object.freeze({}),
    noiseFloor: floor
  });

  if (before?.kind !== FLIGHT_RECORD_KIND || after?.kind !== FLIGHT_RECORD_KIND) {
    return refuse('RECORD_KIND_MISMATCH');
  }
  if (before.schemaVersion !== after.schemaVersion
      || before.schemaVersion !== FLIGHT_HISTORY_SCHEMA_VERSION) {
    return refuse('RECORD_SCHEMA_VERSION_MISMATCH');
  }
  if (before.aircraftKey === null || after.aircraftKey === null) {
    return refuse('AIRCRAFT_NOT_KEYABLE');
  }
  if (before.aircraftKey !== after.aircraftKey) {
    return refuse('AIRCRAFT_MISMATCH');
  }
  if (before.ordinal !== null && after.ordinal !== null && before.ordinal >= after.ordinal) {
    // Not pedantry: swapping them silently inverts every direction reported.
    return refuse('RECORDS_OUT_OF_ORDER');
  }

  // Firmware is a field precisely so it can do this. A firmware change can move
  // the controller under identical numbers, and both real dumps span one.
  if (normalizeText(before.firmwareRevision) === null
      || normalizeText(after.firmwareRevision) === null) {
    return refuse('FIRMWARE_UNREADABLE');
  }
  if (before.firmwareRevision !== after.firmwareRevision) {
    return refuse('FIRMWARE_CHANGED');
  }
  if (!ratesFingerprintReadable(before.ratesFingerprint)
      || !ratesFingerprintReadable(after.ratesFingerprint)) {
    return refuse('RATES_UNREADABLE');
  }
  if (before.ratesFingerprint !== after.ratesFingerprint) {
    return refuse('RATES_CHANGED');
  }

  const {changes, codes: gainCodes} = describeGainChanges(before, after);
  for (const code of gainCodes) {
    addCode(codes, code);
  }
  if (gainCodes.includes('GAINS_UNREADABLE') || gainCodes.includes('GAIN_LINE_SHAPE_CHANGED')) {
    return refuse('GAINS_NOT_COMPARABLE');
  }

  if (changes.length >= HISTORY_LIMITS.profileSwitchGainCount) {
    // Reported as its own thing rather than as "too many changes": the pilot
    // switched profile, and telling them that is useful where withholding is not.
    return refuse('PROFILE_SWITCH_SUSPECTED');
  }
  if (changes.length > 1) {
    return refuse('MULTIPLE_GAINS_CHANGED');
  }

  // ATTRIBUTION IS PER AXIS, NOT PER COMPARISON.
  //
  // Caught by `test/flight-history.test.mjs`: with a single yaw gain changed,
  // the first draft passed one `attributable` flag to all three axes, so a roll
  // movement of exactly the same size came back as "improved" — a roll result
  // credited to a yaw adjustment. Nothing was changed on roll, so nothing on
  // roll can be attributed to anything.
  const changedAxis = changes.length === 1 ? changes[0].axis : null;
  const changedTerm = changes.length === 1 ? changes[0].term : null;
  floor = describeNoiseFloor(null, changedAxis);
  if (changedAxis === null) {
    // Not a refusal. The comparison still runs, because "you changed nothing and
    // the numbers moved this much" is the most useful thing this feature can
    // show a pilot: it is the noise floor, on their own aircraft.
    addCode(codes, 'NO_GAIN_CHANGE');
  }

  const axes = {};
  for (const axis of AXES) {
    axes[axis] = Object.freeze({
      hold: compareAxisHold(before, after, axis, axis === changedAxis ? changedTerm : null),
      stop: compareAxisStop(before, after, axis)
    });
  }

  // The headline follows the axis the gain moved on, when one did.
  const outcome = changedAxis === null
    ? COMPARISON_OUTCOME.NOT_ENOUGH_EVIDENCE
    : axes[changedAxis].hold.outcome;

  return Object.freeze({
    schemaVersion: FLIGHT_HISTORY_SCHEMA_VERSION,
    kind: FLIGHT_COMPARISON_KIND,
    aircraftKey: before.aircraftKey,
    comparable: true,
    outcome,
    changedAxis,
    changedTerm,
    codes: Object.freeze(codes),
    gainChanges: changes,
    axes: Object.freeze(axes),
    noiseFloor: floor
  });
}

// ---------------------------------------------------------------------------
// The per-aircraft sensitivity model
// ---------------------------------------------------------------------------

/**
 * What this aircraft has taught the app about its own gains — and, far more
 * often, what it has not.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS DERIVED AND NEVER STORED
 * ---------------------------------------------------------------------------
 *
 * Every input the model needs is already a documented record field: the gain
 * level (`gains.<axis>[0..2]`), the response (`hold.meanAbsoluteSteadyState-
 * ErrorDps`), the confound guards (`firmwareRevision`, `ratesFingerprint`,
 * `headspeedMedianRpm`, `holdCount`, `zeroHoldCount`, `noise.filteredHigh-
 * FrequencyRmsDps`), the ordering (`ordinal`) and the handle for un-learning
 * (`recordId`). So nothing new is stored: RECORD_FIELDS, NEVER_STORED,
 * `auditFlightRecord` and `exportHistory` are untouched by this derived model.
 * The history schema changes only when a stored input changes meaning (as it did
 * when expo became part of the rate fingerprint), never for model output.
 *
 * That is not tidiness, it is the un-learning guarantee. `forgetFlight` needs no
 * hook here: deleting a record deletes a point, and the conclusion that rested
 * on it recomputes without it on the next call. A model with its own stored
 * state would leave a conclusion still containing a flight the pilot deleted,
 * which is the never-store defect in a new place.
 *
 * THERE IS THEREFORE NO MUTATOR AND NO INCREMENTAL UPDATE. `buildSensitivityModel`
 * is a pure function of the history, recomputed from scratch every call, and
 * nothing in this module takes a model and returns a model. It is cheap enough
 * to afford: 200 records capped, nine (axis, term) fits, a least-squares line
 * each. If a future change adds a cache, "forget this flight" becomes a lie.
 *
 * ---------------------------------------------------------------------------
 * ONE FLIGHT IS ONE POINT. THE FIT IS ON LEVELS, NOT ON PAIRS
 * ---------------------------------------------------------------------------
 *
 * The obvious design reuses `compareFlightRecords` and treats every admitted
 * before/after pair as a data point. That is the trap this file exists to avoid:
 * n flights make up to n(n-1)/2 pairs, each flight appears in many of them, and
 * any interval computed over them overstates confidence by roughly the square
 * root of the reuse factor. Six flights counted fifteen ways is noise wearing a
 * number, and it would speak with more authority than the paired comparison it
 * replaced.
 *
 * So a flight contributes exactly one point, `(gain level, metric)`, and the fit
 * is ordinary least squares within a group where everything else is held
 * constant. Points are independent by construction, the pilot who moves P up,
 * back down and up again is three levels rather than a run of contradictory
 * deltas, and deleting one flight deletes one visible point.
 *
 * `compareFlightRecords` is untouched. It stays the paired surface for "did my
 * last change help"; this is the aggregate surface. Conflating them is how the
 * pair-dependence defect gets in.
 *
 * ---------------------------------------------------------------------------
 * A POWER LAW, NEVER A LINE, AND NEVER BEYOND THE GAINS ALREADY FLOWN
 * ---------------------------------------------------------------------------
 *
 * Standing error under a constant disturbance goes roughly as 1/K_I — a
 * hyperbola with a pole at zero, not a line. The corpus's one measured
 * experiment agrees: gain ratio 1.750 against error ratio 1.544 is a power-law
 * exponent of 0.776 against a first-order theoretical 1.0.
 *
 * The reason it matters is extrapolation. From those SAME two points a straight
 * line extrapolated to I = 0 predicts 0.119 deg/s while the inverse law predicts
 * unbounded error, and near the stability boundary the response diverges — that
 * is the cliff a tune has. A line fitted below the cliff returns a finite,
 * safe-looking number for a gain at which the aircraft oscillates, which is the
 * most dangerous output this feature could produce and the natural output of the
 * obvious implementation. So the fit is log-response on log-gain, and every
 * number it emits carries `spanOfGain` and is valid only inside it. There is no
 * prediction function here, deliberately.
 *
 * ---------------------------------------------------------------------------
 * ONE RESPONSE METRIC, WHICH MAKES D UNLEARNABLE
 * ---------------------------------------------------------------------------
 *
 * `meanAbsoluteSteadyStateErrorDps` and nothing else, because it is the only
 * metric whose flight-to-flight noise floor has ever been measured. Ripple,
 * crossing rate, drift and every stop metric are stored and floorless — a slope
 * fitted to one of them could not be gated, which is the STOP_FLOOR_NOT_MEASURED
 * mistake in a new place. `meanITermRms` is doubly excluded: it moved 1% when
 * the header I was nearly halved, because the integrator output follows the trim
 * the aircraft needs rather than the number the pilot typed.
 *
 * The honest consequence is that D can never be concluded from this: D acts on
 * the RATE of change of error, and during a hold there is none. So the D terms
 * report `underpowered` with RESPONSE_METRIC_NOT_SENSITIVE_TO_TERM however many
 * clean points they accumulate, and their `needs` names a missing instrument
 * rather than telling the pilot to fly more. Silently collecting points that can
 * never conclude would be the same lie told slowly.
 *
 * ---------------------------------------------------------------------------
 * THE FLOOR IS PER AXIS, AND THE POOLED 0.39 IS THE WRONG STATISTIC HERE
 * ---------------------------------------------------------------------------
 *
 * `EVIDENCE_LIMITS.holdErrorNoiseFloorDps` (0.39) is the p90 of identical-gain
 * pairs POOLED across roll, pitch and yaw, and it is applied per axis. Measured
 * per axis on the same corpus it is wrong on all three: roll p90 0.915 (n=5),
 * pitch p90 1.390 (n=4), yaw p90 0.0966 max 0.1006 (n=18) — roughly 4x too loose
 * on yaw, where the metric's entire observed range is 0.0025 to 0.105 so the
 * pooled gate sits above the full dynamic range, and 2.4x to 3.6x too tight on
 * roll and pitch. The scale separation is corroborated independently at better n
 * by per-segment spread: roll sd 0.348 (n=28), pitch 0.445 (n=21), yaw 0.0355
 * (n=25).
 *
 * The same cut dissolves the "heavy tail" that motivated so much of the caution
 * here. Half-normal sigmas fitted to the pooled null quantiles span 8.3x
 * (median 0.065, p90 0.188, p95 0.181, max 0.544); per axis they span 1.3x on
 * yaw, 1.5x on roll and 2.0x on pitch. The pooled distribution is a mixture of a
 * tight yaw component with two loose ones, and a mixture of Gaussians at
 * different scales looks exactly like one heavy-tailed Gaussian. Per axis the
 * null is approximately Gaussian, which is why standard-error arithmetic is
 * legitimate below and was never legitimate pooled. The refusal to model rests
 * on scarcity of experiments, which is real and measured, not on non-normality,
 * which was an artifact.
 *
 * SENSITIVITY_FLOOR_DPS carries those per-axis figures. Paired comparisons use
 * the floor for their own axis; the pooled figure remains only as an explicitly
 * named fallback for callers that have no axis.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE REFERENCE CORPUS ACTUALLY CONTAINS, so nobody expects a slope
 * ---------------------------------------------------------------------------
 *
 * A header scan of 110 real sessions finds FIVE adjacent single-gain
 * transitions, not one as an earlier note here said: yaw P 50 to 90, 90 to 100,
 * 100 to 110 (a genuine three-step ladder), roll D 40 to 60, and yaw I 350 to
 * 200. Four die on evidence — the yaw P ladder produced zero yaw hold segments
 * on all four flights, because a pilot testing P flies stops and pirouettes
 * rather than holds, and both roll D flights are bench runs. Only yaw I 350 to
 * 200 has hold evidence on both sides, and re-measured through the shipped
 * pipeline over the DETECTED window it moved the metric 0.0524 to 0.0809, i.e.
 * 0.0285 deg/s. (The 0.039 quoted elsewhere in this file was measured over a
 * different window; the stored record uses the detected one, so 0.0285 is the
 * figure the feature sees. Its own 95% interval is [-0.087, +0.144] and includes
 * zero, so that one pair does not even establish the SIGN.)
 *
 * So the corpus contains ZERO usable data points, and passive learning from
 * whatever a pilot happens to do is not slow but nil. The reachable products of
 * this module are therefore, in order of how soon they arrive:
 *
 *   1. THE AIRCRAFT'S OWN NOISE FLOOR, which accumulates from ordinary repeat
 *      flying and needs no experiment at all. See `floors` below.
 *   2. THE `underpowered` STATE, which tells a pilot that the change they made
 *      is below the resolution of the instrument and that no number of repeat
 *      flights will fix it. Without it, an underpowered experiment masquerades
 *      as patience.
 *   3. A SIGN, and only then a magnitude — the far horizon, and honest about it.
 *
 * The binding constraint on all three is hold segments per flight: the corpus
 * means are 0.93 roll, 0.70 pitch, 0.83 yaw, with a maximum of 4 ever, against a
 * paired-comparison gate of 5. A qualifying hold is 5 s and the median observed
 * hold is 8.4 s, so five deliberate tail holds is 25 s of a 59 s flight. That is
 * a guidance problem, not a modelling one, and it is the highest-leverage change
 * available to this feature.
 */
export const SENSITIVITY_MODEL_KIND = 'rotorlens-sensitivity-model';

/**
 * What the model may say about one (axis, term). Six states, no transitions.
 *
 * There is no state machine because there is no state: every one of these is
 * recomputed from the history on every call, and a term is allowed to go
 * BACKWARDS — `usable` to `collecting` after a deletion, or after the 200-record
 * cap drops the oldest flight. That is a conclusion following its evidence
 * exactly, and it is required behaviour rather than a wobble to be smoothed over
 * by caching.
 */
export const SENSITIVITY_STATE = Object.freeze({
  /** No admitted point at all. Different from `collecting`: nothing to show. */
  NO_EVIDENCE: 'no-evidence',
  /** Points exist and are fewer, or flatter, than a fit needs. Never a slope. */
  COLLECTING: 'collecting',
  /**
   * The experiment as run cannot resolve an effect, and repeating it as run
   * never will. The most important state here and the one most likely to be
   * omitted, because without it patience looks like progress.
   */
  UNDERPOWERED: 'underpowered',
  /** A fit exists and cleared every release condition. May speak a direction. */
  USABLE: 'usable',
  /**
   * Enough points, and they disagree by more than two identical flights ever do.
   * Loud, and never a quiet fall back to `collecting`: it means something the
   * history cannot see — blades, a filter, the head — moved.
   */
  CONTRADICTORY: 'contradictory',
  /** Points exist only under a firmware or rate curve that is no longer flown. */
  STALE: 'stale'
});

/** The one response variable, named as a field so a second one cannot be quiet. */
export const SENSITIVITY_RESPONSE_METRIC = 'meanAbsoluteSteadyStateErrorDps';

/**
 * The flight-to-flight noise floor PER AXIS, in deg/s, measured on the corpus.
 *
 * Rounded UP from the measured identical-gain p90s (roll 0.915, pitch 1.3896,
 * yaw 0.0966), because rounding a floor up only ever refuses more. `pooled` is
 * the shipped figure, kept as the fallback for an axis with no per-axis
 * measurement and named `pooled` so it can never again be mistaken for one.
 *
 * These are other people's machines. The point of `model.floors` is to replace
 * them with the pilot's own.
 */
export const SENSITIVITY_FLOOR_DPS = Object.freeze({
  roll: 0.92,
  pitch: 1.39,
  yaw: 0.1,
  pooled: EVIDENCE_LIMITS.holdErrorNoiseFloorDps
});

export const SENSITIVITY_LIMITS = Object.freeze({
  /**
   * Hold segments a flight needs before it may be ONE POINT.
   *
   * Deliberately lower than `minimumComparisonHolds` (5), and the difference is
   * not a relaxation. A paired comparison has two numbers and no way to estimate
   * how much they scatter, so it must buy its confidence inside each flight. A
   * fit over six or more flights estimates the scatter from its own residuals,
   * so a noisier point pays for itself in a wider interval rather than by being
   * refused. Two rather than one because a single segment is a single moment of
   * air; at two, 19% of real flight-axes qualify against 51% at one, and the
   * guided protocol (five 5 s tail holds) is what is meant to feed this.
   *
   * The 5-hold paired gate, for the record, has never once opened on real data:
   * the maximum ever observed on one flight-axis across 109 sessions is 4, and
   * 0 of 90 admissible flight-axes reach 5.
   */
  minimumHoldsPerPoint: 2,

  /**
   * Flights before a line through them may be believed.
   *
   * From the measured per-axis spread and a t interval at 95%: the slope's
   * interval excludes zero when the effect across the span beats about
   * 1.42*t/sqrt(n) times the residual spread, which is 1.61 at n=6 and 1.04 at
   * n=10. Six is where the arithmetic starts working at all, and it is the floor
   * rather than the target. NO N IS HARD-CODED AS SUFFICIENT: the release gate
   * is the fitted interval itself, computed from the points in hand, because the
   * N that would be needed scales as the effect size squared and the corpus
   * constrains that effect only to somewhere between 4 and unbounded.
   */
  minimumPointsForFit: 6,

  /**
   * Distinct gain values a fit needs.
   *
   * Two levels is a line through two clouds: it cannot show curvature and cannot
   * expose an outlier, so the residual it reports is a measure of nothing.
   */
  minimumDistinctGainLevels: 3,

  /**
   * Effect across the span, in floors, before a DIRECTION may be spoken.
   *
   * MEASURED, by sweeping the gate against both halves of the acceptance
   * criterion — 4,000 synthetic null histories (true exponent zero, the metric
   * drawn at the axis's own spread, with head speed, firmware, rates and profile
   * all jittering) and 800 with a real slope injected at half that spread:
   *
   *     gate   speaks on a null   finds a real slope
   *     x1           2.55%              89.4%
   *     x1.5         1.95%              87.5%
   *     x2           1.05%              79.5%
   *     x2.5         0.43%              67.3%
   *     x3           0.10%              48.8%
   *
   * Two is the knee: the false-positive rate falls by well over half for ten
   * points of detection. It is also the principled place rather than only the
   * convenient one, because the floor is a p90 — one pair in ten exceeds it by
   * construction — so an effect merely equal to the floor is an effect the size
   * of a bad day. This is the same correction the "differ by up to 0.39"
   * sentence needed, applied to a gate instead of to a sentence.
   */
  verdictFloorMultiple: 2,

  /** Effect across the span, in floors, before a magnitude may be quoted. */
  magnitudeFloorMultiple: 3,

  /** Half-width over slope. Above this the magnitude is not a magnitude. */
  maximumRelativeSlopeHalfWidth: 0.5,

  /**
   * Vibration ratio between a point and its group's median before the point is
   * dropped. The record stores the filtered high-frequency RMS precisely so a
   * result from a flight with a mechanical problem can be refused; blades and
   * belts are the confound the grouping cannot see, and this is the only partial
   * guard available against them.
   */
  maximumNoiseRatio: 1.5,

  /**
   * Null pairs before the aircraft's own floor may LOOSEN the applied one.
   *
   * Asymmetric on purpose. Evidence that this machine is noisier than assumed is
   * acted on early, because loosening only ever refuses more and refusing more is
   * always safe.
   */
  loosenFloorAtNullPairs: 3,

  /**
   * Null pairs, and distinct flights behind them, before the aircraft's own
   * floor may TIGHTEN the applied one.
   *
   * Late and cautiously: a p90 from six samples is essentially the max of six and
   * is optimistic by construction. The pairs are also not independent of each
   * other — k identical flights make k(k-1)/2 of them — which is tolerable for a
   * percentile in a way it would not be for a t test, but it is why the flight
   * count is gated separately from the pair count.
   */
  tightenFloorAtNullPairs: 20,
  tightenFloorAtNullFlights: 10,

  /** A learned floor may never fall below this fraction of the corpus figure. */
  minimumLearnedFloorRatio: 0.5
});

/**
 * Things the model cannot control for, said in the pilot's words.
 *
 * "Hold everything else constant" holds constant everything the RECORD KNOWS
 * ABOUT. The tempting fix — storing more of the header — is refused: a header
 * dump per flight is the trail this whole design avoids, and it would still miss
 * the blades. What the model must never do is imply it controlled for something
 * it cannot see.
 */
export const SENSITIVITY_CAVEATS = Object.freeze([
  Object.freeze({
    what: 'blades, belts, bearings, filters and governor settings are not in the history',
    why: 'a flight with new blades or a changed notch filter can step this measurement, '
      + 'and the model would attribute the step to whichever gain happened to move. Three '
      + 'partial guards stand against it — the vibration reading catches gross mechanical '
      + 'change, the contradictory state catches scatter, and a slope that cannot be '
      + 'separated from the passage of time is refused outright — but none of them is a '
      + 'substitute for knowing, and a smooth change nobody wrote down is the hardest case'
  }),
  Object.freeze({
    what: 'a gain changed in one direction only, over time, cannot be read at all',
    why: 'the protocol this app asks for produces a gain that climbs with the calendar, '
      + 'and anything else that drifted over those same weeks is then the same variable. '
      + 'The fit controls for flight order and refuses when the two cannot be told apart, '
      + 'which is why re-flying a value already flown is worth more than a new one'
  }),
  Object.freeze({
    what: 'the standing error falls smoothly right up to the edge of stability',
    why: 'the one measurement with a known noise floor gets better as a gain rises, and '
      + 'keeps getting better until the aircraft hunts. The in-band ripple is checked '
      + 'against the same floor and vetoes an improving slope it disagrees with, but a '
      + 'slope that ends just short of that edge still reads as an unqualified improvement'
  }),
  Object.freeze({
    what: 'every hold segment in the reference corpus was a heading hold',
    why: 'not one sustained constant-rate turn appears in 109 sessions, so anything '
      + 'concluded here is about holding a heading and has no standing to speak about a '
      + 'sustained turn. The two test different things: trim against windup, versus a '
      + 'standing demand'
  }),
  Object.freeze({
    what: 'a change on a different axis starts a new group rather than being ignored',
    why: 'a helicopter cross-couples, so a roll gain can move a pitch measurement. '
      + 'Requiring every other stored gain to be identical is stricter than necessary and '
      + 'costs points, and it is the only version of the rule that does not rest on an '
      + 'assumption nobody measured'
  })
]);

// --- Arithmetic. A dozen lines each, because src/ has no dependencies. --------

/**
 * Two-sided 95% t critical values, df 1..30, then an asymptotic tail.
 *
 * Legitimate PER AXIS and not pooled — see the module note on the heavy tail
 * being a mixture artifact. Using this on pooled roll/pitch/yaw nulls would be
 * the arithmetic the corpus does not support.
 */
const T_CRITICAL_95 = Object.freeze([
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042
]);

function tCritical(degreesOfFreedom) {
  if (!Number.isInteger(degreesOfFreedom) || degreesOfFreedom < 1) {
    return null;
  }
  if (degreesOfFreedom <= T_CRITICAL_95.length) {
    return T_CRITICAL_95[degreesOfFreedom - 1];
  }
  // Within 0.001 of the table from df 31 upward, and it errs wide.
  return 1.96 + 2.4 / degreesOfFreedom;
}

/** Nearest-rank percentile, the same convention the corpus figures were taken with. */
function percentileNearestRank(sortedAscending, fraction) {
  if (sortedAscending.length === 0) {
    return null;
  }
  const rank = Math.ceil(fraction * sortedAscending.length);
  return sortedAscending[Math.min(sortedAscending.length - 1, Math.max(0, rank - 1))];
}

function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Least squares of log(response) on log(gain): response = coefficient * gain^exponent.
 *
 * A POWER LAW rather than a line, for the reason in the module note — a line
 * extrapolates to a finite, safe-looking number on the far side of the stability
 * cliff. The residual spread is reported in deg/s rather than in log units,
 * because the floor it has to be judged against is in deg/s and a residual in a
 * unit the floor is not in cannot be compared with it at all.
 *
 * @returns {object|null} null when the points cannot support a line
 */
function correlation(left, right) {
  const count = left.length;
  if (count < 2) {
    return null;
  }
  const leftMean = left.reduce((sum, value) => sum + value, 0) / count;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / count;
  let cross = 0;
  let leftSquares = 0;
  let rightSquares = 0;
  for (let index = 0; index < count; index += 1) {
    const a = left[index] - leftMean;
    const b = right[index] - rightMean;
    cross += a * b;
    leftSquares += a * a;
    rightSquares += b * b;
  }
  if (!(leftSquares > 0) || !(rightSquares > 0)) {
    return null;
  }
  return cross / Math.sqrt(leftSquares * rightSquares);
}

/**
 * The same slope, refitted with FLIGHT ORDER as a second explanatory variable.
 *
 * THE CONFOUND THIS EXISTS FOR IS THE ONE THE APP'S OWN ADVICE CREATES. The
 * protocol a pilot is asked to fly — change one gain, fly it, change it again —
 * produces a gain that climbs monotonically with time. Anything else that drifts
 * or steps over those same flights is then perfectly aliased onto the gain, and
 * the plain fit cannot tell the two apart: a run of flights where the gain did
 * nothing at all and the AIR slowly changed comes out as a clean slope with a
 * tight interval, and it is confidently signed in the direction of the drift.
 *
 * Measured on the shipped code before this existed: a drift of 0.20 deg/s spread
 * over eight ordered flights — one seventh of a single ordinary flight-to-flight
 * excursion in the reference corpus — was enough to reach `usable` on a gain
 * whose true effect was EXACTLY ZERO, and a drift running against a real effect
 * reversed the reported direction. The residual-scatter gate does not catch it,
 * because a smooth confound leaves small residuals: that gate is a smoothness
 * detector, and this is a causality question.
 *
 * The fix is the textbook one rather than a threshold. Regressing on both gain
 * and ordinal partials the drift out, and the collinearity between them is paid
 * for honestly in the standard error: a perfect ladder makes the two variables
 * indistinguishable, the determinant collapses, and the interval opens until it
 * contains zero. NOTHING IS TUNED HERE. A design that revisits a gain value it
 * has already flown separates the two by itself and pays almost nothing; a
 * design that only ever ratchets in one direction cannot be rescued by any
 * number of further flights in the same direction, which is exactly the truth a
 * pilot needs told.
 *
 * @returns {object|null} null when order is unknown or cannot be separated
 */
function fitControllingForFlightOrder(usable, xs, ys, xMean) {
  const count = usable.length;
  const ordinals = usable.map(point => point.ordinal);
  if (!ordinals.every(Number.isFinite) || count < 4) {
    // Fewer than four points leaves no residual degree of freedom once order is
    // controlled for, and an unknown order cannot be controlled for at all.
    return null;
  }

  /**
   * DID THE GAIN EVER GO BACK DOWN? The structural half, and it comes first
   * because no amount of arithmetic substitutes for it.
   *
   * A monotone ladder is not merely ill-conditioned, it is UNIDENTIFIABLE except
   * through assumptions about functional form that nobody can defend: the fit
   * assumes the metric is a power law in the gain and the drift is linear in
   * flight number, and on a monotone design the ONLY thing separating them is
   * the difference between those two curvatures. With a tight residual that
   * difference is "significant" while resting entirely on two guesses. Measured:
   * a pure calendar drift on an eight-rung ladder passed the partial regression
   * comfortably, because the noise was small, and would have been published.
   *
   * Requiring the gain to have moved both ways at least once is the design
   * question rather than the arithmetic one, and it is satisfied by a single
   * re-flight of a value already flown. It is also, for free, the break in the
   * app-suggests-then-confirms feedback loop: a pilot who has taken a gain back
   * down is not merely confirming what he was told.
   */
  const inFlightOrder = [...usable].sort((left, right) => left.ordinal - right.ordinal);
  let wentUp = false;
  let wentDown = false;
  for (let index = 1; index < inFlightOrder.length; index += 1) {
    const step = inFlightOrder[index].gain - inFlightOrder[index - 1].gain;
    wentUp = wentUp || step > 0;
    wentDown = wentDown || step < 0;
  }
  if (!wentUp || !wentDown) {
    return {
      separable: false,
      oneWayOnly: true,
      gainOrderCorrelation: round(correlation(xs, ordinals) ?? 1, 3),
      exponent: null,
      interval: null,
      excludesZero: false
    };
  }

  const yMean = ys.reduce((sum, value) => sum + value, 0) / count;
  const tMean = ordinals.reduce((sum, value) => sum + value, 0) / count;

  let sxx = 0;
  let stt = 0;
  let sxt = 0;
  let sxy = 0;
  let sty = 0;
  for (let index = 0; index < count; index += 1) {
    const x = xs[index] - xMean;
    const t = ordinals[index] - tMean;
    const y = ys[index] - yMean;
    sxx += x * x;
    stt += t * t;
    sxt += x * t;
    sxy += x * y;
    sty += t * y;
  }

  const determinant = sxx * stt - sxt * sxt;
  if (!(determinant > 0) || !(sxx > 0) || !(stt > 0)) {
    // Perfectly collinear: every flight at a new gain, in order, never revisited.
    // The gain and the passage of time are the same variable, and no arithmetic
    // recovers which of them moved the measurement.
    return {
      separable: false,
      oneWayOnly: false,
      gainOrderCorrelation: round(correlation(xs, ordinals) ?? 1, 3),
      exponent: null,
      interval: null,
      excludesZero: false
    };
  }

  const gainSlope = (stt * sxy - sxt * sty) / determinant;
  const orderSlope = (sxx * sty - sxt * sxy) / determinant;
  const degreesOfFreedom = count - 3;
  if (degreesOfFreedom < 1) {
    return null;
  }

  let residualSumSquares = 0;
  for (let index = 0; index < count; index += 1) {
    const predicted = gainSlope * (xs[index] - xMean)
      + orderSlope * (ordinals[index] - tMean);
    residualSumSquares += ((ys[index] - yMean) - predicted) ** 2;
  }

  const variance = residualSumSquares / degreesOfFreedom;
  const standardError = Math.sqrt(Math.max(0, variance) * stt / determinant);
  const critical = tCritical(degreesOfFreedom);
  const halfWidth = critical * standardError;

  return {
    separable: true,
    oneWayOnly: false,
    gainOrderCorrelation: round(correlation(xs, ordinals) ?? 0, 3),
    exponent: gainSlope,
    interval: [gainSlope - halfWidth, gainSlope + halfWidth],
    excludesZero: Math.abs(gainSlope) > halfWidth,
    degreesOfFreedom
  };
}

function fitPowerLaw(points) {
  const usable = points.filter(point => point.gain > 0 && point.metricDps > 0);
  const count = usable.length;
  if (count < 3) {
    return null;
  }

  const xs = usable.map(point => Math.log(point.gain));
  const ys = usable.map(point => Math.log(point.metricDps));
  const xMean = xs.reduce((sum, value) => sum + value, 0) / count;
  const yMean = ys.reduce((sum, value) => sum + value, 0) / count;

  let sumXX = 0;
  let sumXY = 0;
  for (let index = 0; index < count; index += 1) {
    sumXX += (xs[index] - xMean) ** 2;
    sumXY += (xs[index] - xMean) * (ys[index] - yMean);
  }
  if (!(sumXX > 0)) {
    return null;
  }

  const exponent = sumXY / sumXX;
  const logIntercept = yMean - exponent * xMean;
  const degreesOfFreedom = count - 2;

  let logResidualSumSquares = 0;
  let linearResidualSumSquares = 0;
  for (let index = 0; index < count; index += 1) {
    logResidualSumSquares += (ys[index] - (logIntercept + exponent * xs[index])) ** 2;
    const predicted = Math.exp(logIntercept + exponent * xs[index]);
    linearResidualSumSquares += (usable[index].metricDps - predicted) ** 2;
  }

  const standardError = Math.sqrt(logResidualSumSquares / degreesOfFreedom / sumXX);
  const critical = tCritical(degreesOfFreedom);
  const halfWidth = critical * standardError;

  const gains = usable.map(point => point.gain);
  const fromGain = Math.min(...gains);
  const toGain = Math.max(...gains);
  const predictAt = gain => Math.exp(logIntercept + exponent * Math.log(gain));

  return {
    count,
    timeControlled: fitControllingForFlightOrder(usable, xs, ys, xMean),
    exponent,
    logIntercept,
    coefficient: Math.exp(logIntercept),
    standardError,
    halfWidth,
    interval: [exponent - halfWidth, exponent + halfWidth],
    excludesZero: Math.abs(exponent) > halfWidth,
    degreesOfFreedom,
    residualSdDps: Math.sqrt(linearResidualSumSquares / degreesOfFreedom),
    fromGain,
    toGain,
    fromDps: predictAt(fromGain),
    toDps: predictAt(toGain),
    spanEffectDps: Math.abs(predictAt(toGain) - predictAt(fromGain)),
    distinctGainLevels: new Set(gains).size,
    predictAt
  };
}

/**
 * Whether the low half and the high half of the span disagree about the sign.
 *
 * This is the "refuse loudly when the points contradict each other" gate. It is
 * deliberately a strong requirement — BOTH halves' intervals must exclude zero
 * AND point opposite ways — because a weak version would fire on ordinary
 * scatter and turn a refusal that means something into one that means nothing.
 * General scatter is caught separately by the residual spread against the floor.
 */
/**
 * How much the hunting signature ROSE across the span, in deg/s, or null.
 *
 * THE CLIFF THE FITTED METRIC CANNOT SEE. Standing hold error under a constant
 * disturbance falls as roughly 1/K all the way to the stability boundary, so a
 * fit on it alone reports its cleanest, most confident improvement exactly where
 * the aircraft is about to start hunting. The module's extrapolation rule does
 * not help: it warns about gain values OUTSIDE the flown span, and this hazard is
 * INSIDE it, at the top end the pilot has already flown.
 *
 * The in-band ripple is the measurement that separates a standing error from an
 * oscillation around zero, and the record has carried it all along. Comparing
 * the high-gain half against the low-gain half by their medians, rather than
 * fitting it, is deliberate: this is a veto and wants to be robust to one bad
 * flight, not a second slope with a second interval to explain.
 */
function oscillationRiseAcrossSpan(points) {
  const withRipple = points
    .filter(point => Number.isFinite(point.rippleRmsDps) && Number.isFinite(point.gain))
    .sort((left, right) => left.gain - right.gain);
  const half = Math.floor(withRipple.length / 2);
  if (half < 2) {
    return null;
  }
  const low = median(withRipple.slice(0, half).map(point => point.rippleRmsDps));
  const high = median(withRipple.slice(withRipple.length - half).map(p => p.rippleRmsDps));
  if (low === null || high === null) {
    return null;
  }
  return high - low;
}

function halvesDisagree(points) {
  const sorted = [...points].sort((left, right) => left.gain - right.gain);
  const cut = Math.floor(sorted.length / 2);
  const low = fitPowerLaw(sorted.slice(0, cut));
  const high = fitPowerLaw(sorted.slice(sorted.length - cut));
  if (low === null || high === null || !low.excludesZero || !high.excludesZero) {
    return false;
  }
  return Math.sign(low.exponent) !== Math.sign(high.exponent);
}

// --- The aircraft's own noise floor ------------------------------------------

function holdKindOf(hold) {
  const zero = hold?.zeroHoldCount;
  const sustained = hold?.sustainedHoldCount;
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

function usableHold(record, axis) {
  const hold = record?.axes?.[axis]?.hold;
  if (hold?.status !== 'captured') {
    return null;
  }
  if (!(hold.holdCount >= SENSITIVITY_LIMITS.minimumHoldsPerPoint)) {
    return null;
  }
  const metric = hold[SENSITIVITY_RESPONSE_METRIC];
  return Number.isFinite(metric) ? hold : null;
}

function headspeedsComparable(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return false;
  }
  const largest = Math.max(Math.abs(left), Math.abs(right));
  if (largest === 0) {
    return false;
  }
  return Math.abs(right - left) / largest <= HISTORY_LIMITS.maximumHeadspeedVariationRatio;
}

function allGainsFingerprint(record) {
  const parts = [];
  for (const axis of AXES) {
    const line = record?.gains?.[axis];
    if (!Array.isArray(line)
        || line.length < GAIN_TERMS.length
        || !line.every(Number.isFinite)) {
      return null;
    }
    parts.push(line.join(','));
  }
  return parts.join('|');
}

/**
 * This aircraft's own flight-to-flight floor on one axis, from its null pairs.
 *
 * A null pair is two of the pilot's own flights with every stored gain
 * byte-identical, the same firmware, the same rates, the same hold kind and the
 * same head speed. Whatever those two flights differ by is, by construction, not
 * the gain — it is the pilot, the trim and the air, which is exactly what the
 * corpus derivation of 0.39 concluded the residual was.
 *
 * THIS IS WHERE "more accurate over time" ACTUALLY BECOMES REACHABLE. It needs
 * no experiment, no discipline and no gain change: it accumulates from ordinary
 * repeat flying, which is what pilots mostly do. A quiet, well set up machine may
 * have a floor of a tenth of the corpus figure, and learning that lets a real
 * result through that a stranger's number would have hidden.
 *
 * PAIRS ARE THE RIGHT UNIT HERE, and that is not an inconsistency with the
 * level-based fit above. A floor is a statement about pair-to-pair variation, and
 * the output is a percentile rather than a t statistic, so the dependence between
 * overlapping pairs inflates the count without manufacturing significance. It
 * still inflates the count, which is why tightening is gated on distinct flights
 * as well as on pairs.
 */
function learnAxisFloor(records, axis) {
  const corpusDps = SENSITIVITY_FLOOR_DPS[axis] ?? SENSITIVITY_FLOOR_DPS.pooled;

  const byKey = new Map();
  for (const record of records) {
    const hold = usableHold(record, axis);
    const gains = allGainsFingerprint(record);
    const kind = holdKindOf(hold);
    if (hold === null || gains === null || kind === null
        || normalizeText(record?.firmwareRevision) === null
        || !ratesFingerprintReadable(record?.ratesFingerprint)) {
      continue;
    }
    const key = `${record.firmwareRevision}|${record.ratesFingerprint}|${gains}|${kind}`;
    const bucket = byKey.get(key);
    if (bucket) {
      bucket.push(record);
    } else {
      byKey.set(key, [record]);
    }
  }

  const deltas = [];
  const flights = new Set();
  for (const bucket of byKey.values()) {
    for (let left = 0; left < bucket.length; left += 1) {
      for (let right = left + 1; right < bucket.length; right += 1) {
        const first = bucket[left];
        const second = bucket[right];
        if (!headspeedsComparable(
          first.axes[axis].headspeedMedianRpm,
          second.axes[axis].headspeedMedianRpm
        )) {
          continue;
        }
        deltas.push(Math.abs(
          second.axes[axis].hold[SENSITIVITY_RESPONSE_METRIC]
            - first.axes[axis].hold[SENSITIVITY_RESPONSE_METRIC]
        ));
        flights.add(first.recordId);
        flights.add(second.recordId);
      }
    }
  }

  const sorted = [...deltas].sort((left, right) => left - right);
  const p90 = percentileNearestRank(sorted, 0.9);
  const observedMax = sorted.length === 0 ? null : sorted[sorted.length - 1];
  const nullPairCount = sorted.length;
  const nullFlightCount = flights.size;

  let appliedDps = corpusDps;
  let source = 'corpus';
  let reason = 'NOT_ENOUGH_NULL_PAIRS';

  if (nullPairCount >= SENSITIVITY_LIMITS.loosenFloorAtNullPairs && p90 > corpusDps) {
    // Loosened early: this machine is noisier than the corpus assumed, and a
    // looser floor can only refuse more.
    appliedDps = p90;
    source = 'own-aircraft';
    reason = 'OWN_AIRCRAFT_IS_NOISIER';
  } else if (nullPairCount >= SENSITIVITY_LIMITS.tightenFloorAtNullPairs
      && nullFlightCount >= SENSITIVITY_LIMITS.tightenFloorAtNullFlights
      && observedMax !== null && observedMax < corpusDps) {
    // Tightened late, and to the OBSERVED MAXIMUM rather than to the p90. A p90
    // over twenty pairs still lets one pair in ten exceed it, and quoting a bound
    // the figure does not have is the "differ by up to 0.39" incident.
    appliedDps = Math.max(
      observedMax,
      corpusDps * SENSITIVITY_LIMITS.minimumLearnedFloorRatio
    );
    source = 'own-aircraft';
    reason = 'OWN_AIRCRAFT_IS_QUIETER';
  } else if (nullPairCount > 0) {
    reason = 'NOT_ENOUGH_NULL_PAIRS_TO_TIGHTEN';
  }

  return Object.freeze({
    axis,
    source,
    reason,
    nullPairCount,
    nullFlightCount,
    medianDps: round(median(sorted), 4),
    p90Dps: round(p90, 4),
    observedMaxDps: round(observedMax, 4),
    corpusDps,
    appliedDps: round(appliedDps, 4)
  });
}

// --- Grouping: hold everything else constant ---------------------------------

/**
 * Every stored gain EXCEPT the one being fitted, as one comparable string.
 *
 * This is the definition of a controlled experiment, and it is exactly
 * implementable from what is already stored. It is also strictly better than a
 * profile-switch heuristic and it dissolves the corpus's nastiest case for free:
 * the M4Max flips back and forth between two whole gain sets, and a "split at
 * every switch" rule would fragment that into useless slivers, where this simply
 * sorts the A-profile flights into one group and the B-profile flights into
 * another and lets both keep accumulating.
 *
 * The non-PID tail of the gain line — feedforward, boost — is part of "everything
 * else", which is why RECORD_FIELDS keeps it: a feedforward change starts a new
 * group instead of contaminating a P slope.
 */
function otherGainsFingerprint(record, axis, termIndex) {
  const parts = [];
  for (const other of AXES) {
    const line = record?.gains?.[other];
    if (!Array.isArray(line)
        || line.length < GAIN_TERMS.length
        || !line.every(Number.isFinite)) {
      return null;
    }
    parts.push(line
      .map((value, index) => (other === axis && index === termIndex ? 'x' : value))
      .join(','));
  }
  return parts.join('|');
}

/**
 * Head speed is a BAND, not a key.
 *
 * Keying on a continuous number fragments everything, so a band is a maximal run
 * of flights whose head speeds lie within the same 5% the paired comparison uses.
 * A pilot who flies 1800 and 2100 rpm builds two models rather than one
 * contaminated one — segmented rather than discarded, which is the standing rule
 * here for every confound.
 */
function splitHeadspeedBands(records, axis) {
  const speedOf = record => record?.axes?.[axis]?.headspeedMedianRpm;
  const withSpeed = records
    .filter(record => Number.isFinite(speedOf(record)))
    .sort((left, right) => speedOf(left) - speedOf(right));

  const bands = [];
  let current = [];
  for (const record of withSpeed) {
    if (current.length === 0) {
      current = [record];
      continue;
    }
    const low = speedOf(current[0]);
    const speed = speedOf(record);
    if (speed > 0 && (speed - low) / speed <= HISTORY_LIMITS.maximumHeadspeedVariationRatio) {
      current.push(record);
    } else {
      bands.push(current);
      current = [record];
    }
  }
  if (current.length > 0) {
    bands.push(current);
  }

  return {
    bands,
    unbanded: records.filter(record => !Number.isFinite(speedOf(record)))
  };
}

/**
 * Turns the records of one band into points, keeping the refused ones.
 *
 * EXCLUDED POINTS ARE RETAINED with their reason, because a pilot who remembers
 * a flight and cannot find it in the count will assume the feature is broken.
 * The reason codes are the ones `compareFlightRecords` already uses — one set of
 * words for one set of reasons — plus two this surface needs and that one does
 * not.
 */
function admitPoints(records, axis, termIndex) {
  const holds = records.map(record => usableHold(record, axis)).filter(hold => hold !== null);
  const zeroKind = holds.filter(hold => holdKindOf(hold) === 'zero').length;
  const majorityKind = holds.length === 0
    ? null
    : (zeroKind >= holds.length - zeroKind ? 'zero' : 'sustained');

  const noiseMedian = median(
    records
      .map(record => record?.axes?.[axis]?.noise?.filteredHighFrequencyRmsDps)
      .filter(value => Number.isFinite(value))
  );

  return records.map(record => {
    const hold = record?.axes?.[axis]?.hold;
    const line = record?.gains?.[axis];
    const gain = Array.isArray(line) ? line[termIndex] : undefined;
    const metric = hold?.[SENSITIVITY_RESPONSE_METRIC];
    const noise = record?.axes?.[axis]?.noise?.filteredHighFrequencyRmsDps;

    let excludedBy = null;
    if (!Number.isFinite(gain)) {
      excludedBy = 'GAINS_UNREADABLE';
    } else if (hold?.status !== 'captured') {
      excludedBy = 'HOLD_EVIDENCE_INCONCLUSIVE';
    } else if (!(hold.holdCount >= SENSITIVITY_LIMITS.minimumHoldsPerPoint)) {
      excludedBy = 'INSUFFICIENT_HOLD_SEGMENTS_FOR_COMPARISON';
    } else if (!Number.isFinite(metric)) {
      excludedBy = 'HOLD_METRIC_MISSING';
    } else if (!(metric > 0)) {
      // A power law is fitted in logs, and log of zero is not a number. A metric
      // of exactly zero is also not a measurement of a small error; it is an
      // axis that was never really tested.
      excludedBy = 'RESPONSE_METRIC_NOT_POSITIVE';
    } else if (holdKindOf(hold) !== majorityKind) {
      excludedBy = 'HOLD_KIND_MISMATCH';
    } else if (Number.isFinite(noise) && noiseMedian !== null && noise > 0 && noiseMedian > 0
        && Math.max(noise, noiseMedian) / Math.min(noise, noiseMedian)
          > SENSITIVITY_LIMITS.maximumNoiseRatio) {
      // The partial guard against blades and belts. Absence of a vibration
      // reading does NOT exclude: unlike head speed, it is a field a caller may
      // legitimately not have measured, and refusing on absence would refuse
      // everything rather than refuse the confound.
      excludedBy = 'MECHANICAL_NOISE_CHANGED';
    }

    return Object.freeze({
      recordId: record?.recordId ?? null,
      ordinal: record?.ordinal ?? null,
      gain: Number.isFinite(gain) ? gain : null,
      metricDps: Number.isFinite(metric) ? round(metric, 4) : null,
      /**
       * The OTHER half of what a gain does, carried so the fit can be checked
       * against it. The fitted metric is the standing error, which falls
       * smoothly towards the stability boundary and is therefore blind to it;
       * the in-band ripple is the hunting signature and rises there. Storing it
       * and never reading it — which is what this module did — is how a model
       * comes to report a clean improving trend across a span whose top end is
       * already oscillating. See OSCILLATION_ROSE_ACROSS_SPAN.
       */
      rippleRmsDps: Number.isFinite(hold?.meanErrorRippleRmsDps)
        ? round(hold.meanErrorRippleRmsDps, 4)
        : null,
      holdCount: Number.isFinite(hold?.holdCount) ? hold.holdCount : null,
      headspeedMedianRpm: record?.axes?.[axis]?.headspeedMedianRpm ?? null,
      admitted: excludedBy === null,
      excludedBy
    });
  });
}

// --- One (axis, term) --------------------------------------------------------

const RESPONSE_METRIC_WORDS = 'the standing error during a hold';

function termLabel(axis, term) {
  return `${axis} ${term}`;
}

function buildNeeds({state, axis, term, points, fit, floor, codes}) {
  const label = termLabel(axis, term);
  const admitted = points.filter(point => point.admitted);
  const levels = new Set(admitted.map(point => point.gain)).size;
  const morePointsNeeded = Math.max(
    0,
    SENSITIVITY_LIMITS.minimumPointsForFit - admitted.length
  );
  const moreLevelsNeeded = Math.max(0, SENSITIVITY_LIMITS.minimumDistinctGainLevels - levels);

  const needs = {
    morePointsNeeded,
    moreLevelsNeeded,
    minimumGainRatioForResolution: null,
    minimumGainStepForResolution: null,
    manoeuvre: `at least ${SENSITIVITY_LIMITS.minimumHoldsPerPoint} deliberate holds a flight, `
      + `${Math.round(EVIDENCE_LIMITS.minimumHoldDurationUs / 1e6)} seconds each, at a steady `
      + `head speed`,
    sentence: ''
  };

  // The gain ratio that WOULD be readable, computed from this aircraft's own
  // fitted exponent and its own floor rather than guessed at. This is what makes
  // `underpowered` actionable instead of a shrug: "a step this size would be
  // readable" rather than "keep flying".
  if (fit !== null && Math.abs(fit.exponent) > 0) {
    const middleGain = median(admitted.map(point => point.gain));
    const middleDps = fit.predictAt(middleGain);
    // The DIRECTION gate, not the magnitude one: the pilot is being told what
    // would let the app say anything at all, which is the nearer of the two.
    const target = floor.appliedDps * SENSITIVITY_LIMITS.verdictFloorMultiple;
    const ratio = (1 + target / middleDps) ** (1 / Math.abs(fit.exponent));
    if (Number.isFinite(ratio) && ratio > 1 && ratio < 1e6) {
      needs.minimumGainRatioForResolution = round(ratio, 3);
      needs.minimumGainStepForResolution = round(middleGain * (ratio - 1), 1);
    }
  }

  if (state === SENSITIVITY_STATE.NO_EVIDENCE) {
    needs.sentence = codes.includes('GAIN_NEVER_CHANGED')
      ? `You have never changed ${label} on this aircraft, so there is nothing to learn from `
        + `yet. A change worth recording is one gain, changed on its own, with the same head `
        + `speed and rate curve either side.`
      : `No flight on this aircraft carries usable hold evidence for ${label}. Flying with `
        + `${needs.manoeuvre} is what produces it.`;
  } else if (state === SENSITIVITY_STATE.STALE) {
    needs.sentence = `The ${admitted.length} flights that would teach ${label} were all flown `
      + `under a firmware or rate curve you are no longer on. They are kept and shown, but a `
      + `new controller under the same numbers is a different aircraft, so they cannot be `
      + `pooled with what you are flying now.`;
  } else if (state === SENSITIVITY_STATE.UNDERPOWERED
      && codes.includes('RESPONSE_METRIC_NOT_SENSITIVE_TO_TERM')) {
    needs.morePointsNeeded = null;
    needs.moreLevelsNeeded = null;
    needs.sentence = `Nothing here can learn ${label}, however many flights you record. The one `
      + `measurement with a known noise floor is ${RESPONSE_METRIC_WORDS}, and D acts on how `
      + `fast the error is changing, which during a hold is nothing. This needs an instrument `
      + `that does not exist yet, not more flying.`;
  } else if (state === SENSITIVITY_STATE.UNDERPOWERED
      && codes.includes('GAIN_CONFOUNDED_WITH_FLIGHT_ORDER')) {
    // Not a count and not a step: an ORDER. morePointsNeeded is nulled because
    // more flights up the same ladder are the one thing that cannot fix this,
    // and a counter here would be asking for exactly the wrong flight.
    needs.morePointsNeeded = null;
    needs.sentence = `Your ${label} values went one way over time, so nothing here can tell `
      + `the gain apart from the weeks that passed with it — a new set of blades, a colder `
      + `day or a slowly loosening belt would look exactly like this. Fly a ${label} value `
      + `you have already flown once more, out of order, and the two come apart. More `
      + `flights further up will not do it.`;
  } else if (state === SENSITIVITY_STATE.CONTRADICTORY
      && codes.includes('OSCILLATION_ROSE_ACROSS_SPAN')) {
    needs.sentence = `Across your ${label} values the standing error got smaller, but the `
      + `tail hunted harder at the same time, and by more than two of your own unchanged `
      + `flights ever differ. Those are two measurements of the same flights disagreeing `
      + `about whether the higher values were better, so nothing is concluded. This is what `
      + `the edge of stability looks like from the inside of the range you have flown.`;
  } else if (state === SENSITIVITY_STATE.UNDERPOWERED) {
    const step = needs.minimumGainStepForResolution;
    needs.sentence = `The ${label} values you have flown are too close together to read. Across `
      + `all of them ${RESPONSE_METRIC_WORDS} moved by ${round(fit.spanEffectDps, 3)}°/s, and `
      + `two of your flights with nothing changed differ by as much as ${floor.appliedDps}°/s. `
      + `More flights at these values will not fix it`
      + `${step === null ? '' : `; a step of about ${step} would be readable`}.`;
  } else if (state === SENSITIVITY_STATE.CONTRADICTORY) {
    needs.sentence = `The ${admitted.length} flights recorded for ${label} disagree with each `
      + `other by more than two of your own unchanged flights ever do. Something the history `
      + `cannot see moved — blades, a filter, the head, the air — so nothing is concluded from `
      + `them. They are all still listed.`;
  } else if (state === SENSITIVITY_STATE.COLLECTING
      && codes.includes('SLOPE_INTERVAL_INCLUDES_ZERO')) {
    // How many more flights it would take, computed from the scatter in hand
    // rather than from a constant. The count needed scales as the effect size
    // squared, so a fixed N here would be a guess about the effect dressed up as
    // a measurement — and the estimate is expected to move as more points
    // arrive, which is said out loud rather than hidden.
    const scale = (fit.halfWidth / Math.abs(fit.exponent)) ** 2;
    const projected = Math.ceil(fit.count * scale) - fit.count;
    needs.morePointsNeeded = Number.isFinite(projected) && projected > 0
      ? Math.min(projected, 9999)
      : 1;
    needs.sentence = `${admitted.length} flights recorded for ${label} at ${levels} different `
      + `values, and the line through them is still not distinguishable from flat. On the `
      + `scatter measured so far it would take about ${needs.morePointsNeeded} more — an `
      + `estimate that will move as the scatter does, because the number of flights needed `
      + `depends on the size of the effect, which is the thing being measured.`;
  } else if (state === SENSITIVITY_STATE.COLLECTING) {
    const flights = admitted.length === 1 ? 'One flight' : `${admitted.length} flights`;
    const wanted = [];
    if (morePointsNeeded > 0) {
      wanted.push(`${morePointsNeeded} more ${morePointsNeeded === 1 ? 'flight' : 'flights'}`);
    }
    if (moreLevelsNeeded > 0) {
      wanted.push(`${moreLevelsNeeded} more ${moreLevelsNeeded === 1 ? 'value' : 'values'} of `
        + `${label}`);
    }
    // Never phrased as progress towards a total. The number of flights a slope
    // would need scales as the effect size squared, and the effect size is the
    // thing being measured, so a denominator here would be a promise the
    // arithmetic cannot keep.
    needs.sentence = `${flights} recorded for ${label} at `
      + `${levels} ${levels === 1 ? 'value' : 'different values'}. `
      + `${wanted.length === 0
        ? 'They do not yet separate a change from a different day.'
        : `A line through them needs ${wanted.join(' and ')} before it means anything.`} `
      + `Two flights cannot tell a change from a different day, and neither can five.`;
  } else {
    needs.morePointsNeeded = null;
    needs.moreLevelsNeeded = null;
    needs.sentence = `Learned from ${admitted.length} of your own flights at ${levels} different `
      + `${label} values, between ${fit.fromGain} and ${fit.toGain}. It says nothing about `
      + `values outside that range.`;
  }

  return Object.freeze(needs);
}

/**
 * The magnitude, when the interval supports one — and never otherwise.
 *
 * Phrased as a measurement of the past rather than an instruction, which is what
 * keeps it on the right side of the "directions, not magnitudes" rule and of the
 * flight-controller boundary: it says what happened between two gains this
 * aircraft has actually flown, not what to set. It carries `evidenceRecordIds`
 * so that deleting one of those flights un-says it on the next call.
 *
 * The interval on the effect is a FIRST-ORDER propagation of the exponent's own
 * interval: over a modest span, effect = c*x^k*(r^k - 1) is approximately
 * proportional to k, so the effect's relative uncertainty is the exponent's. It
 * is only ever quoted when that relative half-width is at or under a half, which
 * is where the approximation is still worth something.
 */
function buildMagnitude({axis, term, fit, floor, points}) {
  const relativeHalfWidth = fit.halfWidth / Math.abs(fit.exponent);
  if (relativeHalfWidth > SENSITIVITY_LIMITS.maximumRelativeSlopeHalfWidth) {
    return null;
  }
  if (fit.spanEffectDps < floor.appliedDps * SENSITIVITY_LIMITS.magnitudeFloorMultiple) {
    return null;
  }
  if (floor.source !== 'own-aircraft') {
    // You cannot judge a slope against a floor you have not measured. Until the
    // aircraft's own floor is established, the number beside the magnitude would
    // be somebody else's machine.
    return null;
  }

  const effect = fit.toDps - fit.fromDps;
  const lower = effect * (1 - relativeHalfWidth);
  const upper = effect * (1 + relativeHalfWidth);

  return Object.freeze({
    axis,
    term,
    validOverGain: Object.freeze({from: fit.fromGain, to: fit.toGain}),
    fromDps: round(fit.fromDps, 4),
    toDps: round(fit.toDps, 4),
    effectDps: round(effect, 4),
    effectIntervalDps: Object.freeze([
      round(Math.min(lower, upper), 4),
      round(Math.max(lower, upper), 4)
    ]),
    relativeHalfWidth: round(relativeHalfWidth, 3),
    evidenceRecordIds: Object.freeze(
      points.filter(point => point.admitted).map(point => point.recordId)
    ),
    sentence: `On this aircraft, in this configuration, ${termLabel(axis, term)} between `
      + `${fit.fromGain} and ${fit.toGain} went with ${RESPONSE_METRIC_WORDS} moving from `
      + `${round(fit.fromDps, 3)}°/s to ${round(fit.toDps, 3)}°/s, give or take `
      + `${round(Math.abs(effect) * relativeHalfWidth, 3)}°/s, measured over `
      + `${fit.count} of your flights. That is what happened between those two values; it is `
      + `not a setting, and it says nothing outside them.`
  });
}

/**
 * Everything the model can say about one axis and one term.
 *
 * The order of the checks below is the design. A contradiction outranks a
 * verdict, a verdict outranks patience, and patience outranks silence — because
 * the failure mode this whole feature has to avoid is a model that keeps quiet
 * for the wrong reason and lets the pilot read it as the right one.
 */
function evaluateTerm({records, axis, term, termIndex, floor, latest}) {
  const codes = [];
  const groups = [];
  const pointById = new Map();
  const bandOf = new Map();

  // 1. Candidate groups: everything else held constant.
  const candidates = new Map();
  for (const record of records) {
    const fingerprint = otherGainsFingerprint(record, axis, termIndex);
    if (fingerprint === null
        || normalizeText(record?.firmwareRevision) === null
        || !ratesFingerprintReadable(record?.ratesFingerprint)) {
      continue;
    }
    const key = `${record.firmwareRevision}|${record.ratesFingerprint}|${fingerprint}`;
    const bucket = candidates.get(key);
    if (bucket) {
      bucket.records.push(record);
    } else {
      candidates.set(key, {
        key,
        firmwareRevision: record.firmwareRevision,
        ratesFingerprint: record.ratesFingerprint,
        otherGainsFingerprint: fingerprint,
        records: [record]
      });
    }
  }

  // 2. Head speed bands inside each, and points inside each band.
  let groupIndex = 0;
  for (const candidate of candidates.values()) {
    const {bands, unbanded} = splitHeadspeedBands(candidate.records, axis);
    for (const record of unbanded) {
      pointById.set(record.recordId, Object.freeze({
        recordId: record.recordId,
        ordinal: record.ordinal,
        gain: null,
        metricDps: null,
        rippleRmsDps: null,
        holdCount: null,
        headspeedMedianRpm: null,
        admitted: false,
        excludedBy: 'HEADSPEED_MISMATCH'
      }));
      bandOf.set(record.recordId, null);
    }

    for (const bandRecords of bands) {
      const points = admitPoints(bandRecords, axis, termIndex);
      const admitted = points.filter(point => point.admitted);
      const band = {
        groupId: `${axis}.${term}#${groupIndex}`,
        candidateKey: candidate.key,
        otherGainsFingerprint: candidate.otherGainsFingerprint,
        firmwareRevision: candidate.firmwareRevision,
        ratesFingerprint: candidate.ratesFingerprint,
        headspeedBandRpm: round(median(bandRecords.map(
          record => record.axes[axis].headspeedMedianRpm
        )), 1),
        current: latest !== null
          && bandRecords.includes(latest)
          && candidate.firmwareRevision === latest.firmwareRevision
          && candidate.ratesFingerprint === latest.ratesFingerprint
          && candidate.otherGainsFingerprint
            === otherGainsFingerprint(latest, axis, termIndex),
        recordIds: Object.freeze(bandRecords.map(record => record.recordId)),
        pointCount: admitted.length,
        distinctGainLevels: new Set(admitted.map(point => point.gain)).size,
        maximumOrdinal: Math.max(...bandRecords.map(record => record.ordinal ?? 0)),
        points,
        records: bandRecords
      };
      groupIndex += 1;
      groups.push(band);
      for (let index = 0; index < bandRecords.length; index += 1) {
        pointById.set(bandRecords[index].recordId, points[index]);
        bandOf.set(bandRecords[index].recordId, band);
      }
    }
  }

  // 3. The band to speak from: the most points, then the most levels, then the
  //    most recent. Current groups first; a stale one is only ever reported as
  //    stale, and never pooled with a current one.
  const better = (left, right) => {
    if (right === null) {
      return true;
    }
    if (left.pointCount !== right.pointCount) {
      return left.pointCount > right.pointCount;
    }
    if (left.distinctGainLevels !== right.distinctGainLevels) {
      return left.distinctGainLevels > right.distinctGainLevels;
    }
    return left.maximumOrdinal > right.maximumOrdinal;
  };

  let chosen = null;
  for (const band of groups) {
    if (band.current && band.pointCount > 0 && better(band, chosen)) {
      chosen = band;
    }
  }
  let stale = false;
  if (chosen === null) {
    for (const band of groups) {
      if (!band.current && band.pointCount > 0 && better(band, chosen)) {
        chosen = band;
        stale = true;
      }
    }
  }

  // 4. Why every other flight is not in it. Counted over ALL of the aircraft's
  //    records, so the total always reconciles with the flight count.
  const exclusions = {};
  const bump = code => {
    exclusions[code] = (exclusions[code] ?? 0) + 1;
  };
  for (const record of records) {
    const band = bandOf.get(record.recordId);
    const fingerprint = otherGainsFingerprint(record, axis, termIndex);
    const firmware = normalizeText(record?.firmwareRevision);
    const rates = ratesFingerprintReadable(record?.ratesFingerprint)
      ? record.ratesFingerprint
      : null;

    // Missing configuration is not a profile and matching nulls are not proof
    // that two flights used the same controller. Name the unreadable field even
    // when every record is unreadable and no candidate group exists.
    if (fingerprint === null) {
      bump('GAINS_UNREADABLE');
      continue;
    }
    if (firmware === null) {
      bump('FIRMWARE_UNREADABLE');
      continue;
    }
    if (rates === null) {
      bump('RATES_UNREADABLE');
      continue;
    }

    if (chosen !== null && band !== chosen) {
      if (record.firmwareRevision !== chosen.firmwareRevision) {
        bump('FIRMWARE_CHANGED');
      } else if (record.ratesFingerprint !== chosen.ratesFingerprint) {
        bump('RATES_CHANGED');
      } else if (fingerprint !== chosen.otherGainsFingerprint) {
        // Some OTHER gain moved as well, so this flight and the fitted ones are
        // not the same experiment. Same word the paired comparison uses.
        bump('MULTIPLE_GAINS_CHANGED');
      } else {
        bump('HEADSPEED_MISMATCH');
      }
      continue;
    }
    const point = pointById.get(record.recordId);
    if (point === undefined) {
      bump('GAINS_UNREADABLE');
    } else if (point.admitted) {
      bump('admitted');
    } else {
      bump(point.excludedBy);
    }
  }

  // 5. The parent-group view: the chosen band's points, plus the flights a pilot
  //    would think comparable that fell into a neighbouring head speed band.
  const points = chosen === null
    ? Object.freeze([])
    : Object.freeze([...chosen.points, ...records
      .filter(record => bandOf.get(record.recordId) !== chosen
        && otherGainsFingerprint(record, axis, termIndex) !== null
        && record.firmwareRevision === chosen.firmwareRevision
        && record.ratesFingerprint === chosen.ratesFingerprint
        && otherGainsFingerprint(record, axis, termIndex) === chosen.otherGainsFingerprint)
      .map(record => Object.freeze({
        ...pointById.get(record.recordId),
        admitted: false,
        excludedBy: 'HEADSPEED_MISMATCH'
      }))]
      .sort((left, right) => (left.ordinal ?? 0) - (right.ordinal ?? 0)));

  const admitted = points.filter(point => point.admitted);
  const levels = new Set(admitted.map(point => point.gain));

  const finish = (state, fit = null, magnitude = null) => Object.freeze({
    axis,
    term,
    responseMetric: SENSITIVITY_RESPONSE_METRIC,
    state,
    groupId: chosen?.groupId ?? null,
    pointCount: admitted.length,
    distinctGainLevels: levels.size,
    floor,
    points,
    exclusions: Object.freeze(exclusions),
    groups: Object.freeze(groups.map(band => Object.freeze({
      groupId: band.groupId,
      firmwareRevision: band.firmwareRevision,
      ratesFingerprint: band.ratesFingerprint,
      headspeedBandRpm: band.headspeedBandRpm,
      current: band.current,
      pointCount: band.pointCount,
      distinctGainLevels: band.distinctGainLevels,
      recordIds: band.recordIds
    }))),
    fit: fit === null ? null : Object.freeze({
      form: 'power-law',
      description: 'metric = coefficient * gain ^ exponent, fitted in logs',
      /**
       * THE SLOPE AND ITS UNCERTAINTY TRAVEL TOGETHER, in one object, on purpose.
       *
       * A bare `exponent` beside a separate `exponentInterval` is a number a
       * caller can pick up on its own, and a slope used without its interval is
       * exactly the noise-wearing-a-number failure this whole module is built
       * around. Reaching the exponent means reaching through the object that
       * carries the interval it is only meaningful inside.
       */
      slope: Object.freeze({
        exponent: round(fit.exponent, 4),
        interval: Object.freeze([
          round(fit.interval[0], 4),
          round(fit.interval[1], 4)
        ]),
        standardError: round(fit.standardError, 4),
        excludesZero: fit.excludesZero,
        confidence: 0.95
      }),
      coefficient: round(fit.coefficient, 6),
      degreesOfFreedom: fit.degreesOfFreedom,
      pointCount: fit.count,
      distinctGainLevels: fit.distinctGainLevels,
      spanOfGain: Object.freeze({from: fit.fromGain, to: fit.toGain}),
      predictedSpanEffectDps: round(fit.spanEffectDps, 4),
      residualSdDps: round(fit.residualSdDps, 4),
      appliedFloorDps: floor.appliedDps,
      // The direction, and never anything shaped like a setting.
      direction: fit.exponent < 0 ? 'higher-gain-went-with-less-error'
        : 'higher-gain-went-with-more-error'
    }),
    magnitude,
    needs: buildNeeds({state, axis, term, points, fit, floor, codes}),
    codes: Object.freeze(codes)
  });

  // --- the checks, in the order that decides the design --------------------

  if (admitted.length === 0) {
    const everLevels = new Set(records
      .map(record => record?.gains?.[axis]?.[termIndex])
      .filter(value => Number.isFinite(value)));
    addCode(codes, everLevels.size <= 1 ? 'GAIN_NEVER_CHANGED' : 'NO_ADMITTED_POINTS');
    return finish(SENSITIVITY_STATE.NO_EVIDENCE);
  }

  if (term === 'D') {
    // Not "not yet". Never, on this response metric — see the module note.
    addCode(codes, 'RESPONSE_METRIC_NOT_SENSITIVE_TO_TERM');
    return finish(SENSITIVITY_STATE.UNDERPOWERED);
  }

  if (stale) {
    if (normalizeText(latest?.firmwareRevision) === null) {
      addCode(codes, 'FIRMWARE_UNREADABLE');
    } else if (!ratesFingerprintReadable(latest?.ratesFingerprint)) {
      addCode(codes, 'RATES_UNREADABLE');
    } else if (chosen.firmwareRevision !== latest.firmwareRevision) {
      addCode(codes, 'FIRMWARE_CHANGED');
    } else if (chosen.ratesFingerprint !== latest.ratesFingerprint) {
      addCode(codes, 'RATES_CHANGED');
    } else if (chosen.otherGainsFingerprint
        !== otherGainsFingerprint(latest, axis, termIndex)) {
      addCode(codes, 'OTHER_GAINS_CHANGED');
    } else {
      addCode(codes, 'HEADSPEED_MISMATCH');
    }
    return finish(SENSITIVITY_STATE.STALE);
  }

  if (levels.size < 2) {
    addCode(codes, 'SINGLE_GAIN_LEVEL');
    return finish(SENSITIVITY_STATE.COLLECTING);
  }

  if (admitted.length < SENSITIVITY_LIMITS.minimumPointsForFit
      || levels.size < SENSITIVITY_LIMITS.minimumDistinctGainLevels) {
    addCode(codes, 'NOT_ENOUGH_POINTS_FOR_A_FIT');
    return finish(SENSITIVITY_STATE.COLLECTING);
  }

  const fit = fitPowerLaw(admitted);
  if (fit === null) {
    addCode(codes, 'NOT_ENOUGH_POINTS_FOR_A_FIT');
    return finish(SENSITIVITY_STATE.COLLECTING);
  }

  // A contradiction outranks everything. Scatter wider than two of the pilot's
  // own unchanged flights means the line does not explain what happened, and
  // averaging it away is how a model comes to speak for something that moved
  // without being recorded.
  if (fit.residualSdDps > floor.appliedDps) {
    addCode(codes, 'RESIDUAL_SCATTER_ABOVE_FLOOR');
    return finish(SENSITIVITY_STATE.CONTRADICTORY, fit);
  }
  if (halvesDisagree(admitted)) {
    addCode(codes, 'SIGN_FLIPS_ACROSS_SPAN');
    return finish(SENSITIVITY_STATE.CONTRADICTORY, fit);
  }

  // The cliff the fitted metric is blind to. Checked here, above the verdict,
  // because a rising hunting signature does not weaken the standing-error slope
  // — it contradicts what the slope would be READ as, which is that the higher
  // gain was better.
  const oscillationRise = oscillationRiseAcrossSpan(admitted);
  if (fit.exponent < 0
      && oscillationRise !== null
      && oscillationRise > floor.appliedDps * SENSITIVITY_LIMITS.verdictFloorMultiple) {
    addCode(codes, 'OSCILLATION_ROSE_ACROSS_SPAN');
    return finish(SENSITIVITY_STATE.CONTRADICTORY, fit);
  }

  if (fit.spanEffectDps < floor.appliedDps * SENSITIVITY_LIMITS.verdictFloorMultiple) {
    addCode(codes, 'GAIN_SPAN_BELOW_NOISE_FLOOR');
    return finish(SENSITIVITY_STATE.UNDERPOWERED, fit);
  }

  if (!fit.excludesZero) {
    addCode(codes, 'SLOPE_INTERVAL_INCLUDES_ZERO');
    return finish(SENSITIVITY_STATE.COLLECTING, fit);
  }

  /**
   * The last question, and the one that decides whether this is a measurement of
   * a GAIN or a measurement of a MONTH.
   *
   * `underpowered` rather than `collecting` is the exact word: the experiment as
   * run cannot resolve the gain from the passage of time, and running more of
   * the same experiment — another rung up the same ladder — never will. It is
   * repaired by flying a value already flown, not by flying more values.
   */
  const time = fit.timeControlled;
  if (time === null
      || !time.separable
      || !time.excludesZero
      || Math.sign(time.exponent) !== Math.sign(fit.exponent)) {
    addCode(codes, 'GAIN_CONFOUNDED_WITH_FLIGHT_ORDER');
    return finish(SENSITIVITY_STATE.UNDERPOWERED, fit);
  }

  return finish(
    SENSITIVITY_STATE.USABLE,
    fit,
    buildMagnitude({axis, term, fit, floor, points})
  );
}

/**
 * What this aircraft's own flights have taught the app about its own gains.
 *
 * PURE, and derived from the history every call. There is no companion mutator
 * and there must never be one: see the module note. Nothing here is written, so
 * nothing here survives `forgetFlight`, and the un-learning is a property of the
 * shape rather than of any wiring.
 *
 * @param {object} history a history from `createHistory`/`importHistory`
 * @param {string} aircraftKey the machine to model; nothing pools across two
 * @returns {object} nine (axis, term) entries and three per-axis floors
 */
export function buildSensitivityModel(history, aircraftKey) {
  const records = findRecords(history, aircraftKey ?? null);

  const floors = {};
  for (const axis of AXES) {
    floors[axis] = learnAxisFloor(records, axis);
  }

  const latest = records.length === 0 ? null : records[records.length - 1];
  const terms = [];
  for (const axis of AXES) {
    for (let termIndex = 0; termIndex < GAIN_TERMS.length; termIndex += 1) {
      terms.push(evaluateTerm({
        records,
        axis,
        term: GAIN_TERMS[termIndex],
        termIndex,
        floor: floors[axis],
        latest
      }));
    }
  }

  return Object.freeze({
    schemaVersion: FLIGHT_HISTORY_SCHEMA_VERSION,
    kind: SENSITIVITY_MODEL_KIND,
    aircraftKey: aircraftKey ?? null,
    flightCount: records.length,
    responseMetric: SENSITIVITY_RESPONSE_METRIC,
    floors: Object.freeze(floors),
    terms: Object.freeze(terms),
    caveats: SENSITIVITY_CAVEATS
  });
}

/** One term out of a model, for a caller that wants to render one row. */
export function findSensitivityTerm(model, axis, term) {
  if (model?.kind !== SENSITIVITY_MODEL_KIND) {
    return null;
  }
  return model.terms.find(entry => entry.axis === axis && entry.term === term) ?? null;
}
