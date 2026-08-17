/**
 * Flight history, and the paired comparison.
 *
 * THE FAILURE THESE TESTS EXIST TO REACH, stated once so no assertion below can
 * quietly stop reaching it: the shipped comparison said "improved" or "worsened"
 * six times out of six on pairs of real flights where the pilot had changed
 * nothing, evenly split between the two opposite wrong answers. Every gate in
 * `src/analysis/flight-history.mjs` is one of those six.
 *
 * So the fixtures here are built around the specific numbers that produced them
 * — 0.0303 → 0.0538 deg/s of yaw error, a 78% relative move that is 0.023 deg/s
 * in absolute terms — rather than around numbers chosen to make a gate fire.
 * A fixture whose relative move is ALSO small would pass with the absolute floor
 * deleted, and would be a test that agrees with the bug.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AIRBORNE_WINDOW_BASES,
  COMPARISON_OUTCOME,
  FLIGHT_HISTORY_KIND,
  FLIGHT_HISTORY_SCHEMA_VERSION,
  FLIGHT_RECORD_KIND,
  HISTORY_LIMITS,
  NEVER_SHARED,
  NEVER_STORED,
  RECORD_FIELDS,
  SHARED_RECORD_FIELDS,
  SHARED_RECORD_KIND,
  SENSITIVITY_FLOOR_DPS,
  SENSITIVITY_LIMITS,
  SENSITIVITY_MODEL_KIND,
  SENSITIVITY_RESPONSE_METRIC,
  SENSITIVITY_STATE,
  addFlightRecord,
  auditFlightRecord,
  auditShareableRecord,
  buildFlightRecord,
  buildSensitivityModel,
  checkFlightAdmissible,
  compareFlightRecords,
  createHistory,
  deriveAircraftIdentity,
  describeGainChanges,
  describeNoiseFloor,
  exportHistory,
  findRecords,
  findSensitivityTerm,
  forgetAircraft,
  forgetEverything,
  forgetFlight,
  importHistory,
  isSameFlight,
  isSharingId,
  listAircraft,
  newSharingId,
  readPilotGains,
  selectBaseline,
  shareableRecord
} from '../src/analysis/flight-history.mjs';
import {
  DIRECTIONAL_EVIDENCE_KIND,
  EVIDENCE_LIMITS,
  HOLD_EVIDENCE_KIND,
  buildHoldEvidence,
  buildDirectionalStopEvidence,
  compareHoldEvidence
} from '../src/analysis/pid-evidence.mjs';
import {FlightWindowBasis} from '../src/analysis/flight-window.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A header block of the shape a real Rotorflight log carries.
 *
 * Copied in structure, not in content, from the reference corpus — including the
 * fields that must NEVER reach a record: `Log start datetime` is present on all
 * 110 real sessions, and it is the single most likely field to be added later by
 * somebody being helpful.
 */
function session(overrides = {}) {
  const {headers: headerOverrides = {}, ...rest} = overrides;
  const headers = {
    Product: 'Blackbox flight data recorder by Nicholas Sherlock',
    'Firmware revision': 'Rotorflight 4.6.0 (118e912) STM32F7X2',
    'Firmware date': 'Jun 30 2026 07:20:47',
    'Board information': 'FRSK VANTAC_RF007',
    'Log start datetime': '2026-07-22T17:14:55.015+00:00',
    'Craft name': 'bell 222ut',
    rates_type: '4',
    rc_rates: '5,5,12',
    rc_expo: '30,30,50',
    rates: '10,10,25',
    rollPID: '52,105,0,100,0',
    pitchPID: '64,111,40,100,0',
    yawPID: '315,145,29,3,1',
    ...headerOverrides
  };

  return {
    headers,
    craftName: headers['Craft name'],
    board: headers['Board information'],
    firmware: {
      type: 'Rotorflight',
      revision: headers['Firmware revision'],
      date: headers['Firmware date']
    },
    locationFieldsDeclared: true,
    locationFields: ['GPS_home[0]', 'GPS_home[1]', 'GPS_coord[0]', 'GPS_coord[1]'],
    ...rest
  };
}

/** An airborne window. Only these are admitted; see AIRBORNE_WINDOW_BASES. */
function airborneWindow(seconds = 120) {
  return {basis: FlightWindowBasis.DETECTED, startUs: 22_762_337, endUs: 22_762_337 + seconds * 1e6};
}

/** Hold evidence of the shape `buildHoldEvidence` returns. */
function holdEvidence({
  axis = 'yaw',
  status = 'captured',
  holdCount = 6,
  zeroHoldCount = 6,
  meanAbsoluteSteadyStateErrorDps = 1,
  meanErrorRippleRmsDps = 0.3
} = {}) {
  return {
    schemaVersion: 1,
    kind: HOLD_EVIDENCE_KIND,
    axis,
    term: 'I',
    status,
    codes: [],
    holds: [],
    summary: status !== 'captured' ? null : {
      holdCount,
      zeroHoldCount,
      sustainedHoldCount: holdCount - zeroHoldCount,
      totalMeasuredDurationUs: holdCount * 5_000_000,
      meanSteadyStateErrorDps: meanAbsoluteSteadyStateErrorDps,
      meanAbsoluteSteadyStateErrorDps,
      worstAbsoluteSteadyStateErrorDps: meanAbsoluteSteadyStateErrorDps * 1.4,
      meanErrorDriftDpsPerSecond: null,
      driftMeasuredHoldCount: 0,
      meanErrorRippleRmsDps,
      meanErrorCrossingRateHz: 5,
      meanErrorNoiseRmsDps: 0.1,
      meanITermRms: 385.6,
      meanITermDriftPerSecond: 0
    }
  };
}

function stopEvidence({axis = 'yaw', trackingRmsDps = 30, eventCount = 2} = {}) {
  const direction = {
    directionEventCount: eventCount,
    trackingRmsDps,
    fastRingingRmsDps: 4,
    slowOscillationRmsDps: 2,
    commandAmplitudeDps: 180,
    headspeedRpm: 2000
  };
  return {
    schemaVersion: 1,
    kind: DIRECTIONAL_EVIDENCE_KIND,
    axis,
    status: 'captured',
    codes: [],
    directions: {positive: {...direction}, negative: {...direction}},
    asymmetry: {},
    directionsComparable: true,
    totalEventCount: eventCount * 2,
    discardedEventCount: 0
  };
}

/**
 * A record with the axes filled in, so a comparison has something to read.
 *
 * Defaults are deliberately *comparable*: same headspeed, same hold kind, six
 * holds a side. A test that wants a gate to fire has to break one of those on
 * purpose, which is what makes the gates reachable.
 */
function record({
  sourceSession = null,
  headers = {},
  craftName,
  board,
  errorDps = 1,
  rippleRmsDps = 0.3,
  holdCount = 6,
  zeroHoldCount = null,
  headspeedMedianRpm = 2000,
  stopTrackingRmsDps = 30,
  ordinal = 0,
  seconds = 120,
  windowBasis = null
} = {}) {
  const base = sourceSession ?? session({headers});
  if (craftName !== undefined) {
    base.craftName = craftName;
    base.headers['Craft name'] = craftName;
  }
  if (board !== undefined) {
    base.board = board;
    base.headers['Board information'] = board;
  }

  const window = airborneWindow(seconds);
  if (windowBasis !== null) {
    window.basis = windowBasis;
  }

  const axes = {};
  const resolvedZeroHoldCount = zeroHoldCount ?? holdCount;
  for (const axis of ['roll', 'pitch', 'yaw']) {
    axes[axis] = {
      headspeedMedianRpm,
      holdEvidence: holdEvidence({
        axis,
        holdCount,
        zeroHoldCount: resolvedZeroHoldCount,
        meanAbsoluteSteadyStateErrorDps: errorDps,
        meanErrorRippleRmsDps: rippleRmsDps
      }),
      stopEvidence: stopEvidence({axis, trackingRmsDps: stopTrackingRmsDps}),
      noise: {filteredHighFrequencyRmsDps: 1.2, unfilteredHighFrequencyRmsDps: 3.4}
    };
  }

  return buildFlightRecord({session: base, window, axes, ordinal});
}

/** Every leaf path in a value, for the privacy scans. */
function leafPaths(value, path = '', collected = []) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      leafPaths(child, path === '' ? key : `${path}.${key}`, collected);
    }
    return collected;
  }
  collected.push(path);
  return collected;
}

/** A deterministic generator, so a sweep that fails fails again. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

// ---------------------------------------------------------------------------
// Aircraft identity
// ---------------------------------------------------------------------------

test('the key is craft name AND board, because board alone merges two aircraft', () => {
  // MEASURED FAILURE, not hypothetical: a Bell 222UT and an OMP M4Max both
  // report "FRSK VANTAC_RF007" in the real corpus, because Board information is
  // a model string with no serial. Keying on the board pools two helicopters
  // into one history and compares one against the other.
  const bell = deriveAircraftIdentity(session());
  const omp = deriveAircraftIdentity(session({headers: {'Craft name': 'OMP4MAX'}}));

  assert.equal(bell.board, omp.board, 'the fixture must reproduce the shared board string');
  assert.notEqual(bell.key, omp.key, 'two aircraft on the same board model must not share a key');

  // And the other direction: the same machine keeps one key.
  assert.equal(deriveAircraftIdentity(session()).key, bell.key);
});

test('firmware is not in the key, because a firmware update splits one aircraft', () => {
  // Both real dumps span a firmware change mid-life. Keying on it split 2 of 3
  // aircraft into two histories, which loses every pairing across the update.
  const before = deriveAircraftIdentity(session());
  const after = deriveAircraftIdentity(session({
    headers: {'Firmware revision': 'Rotorflight 4.6.0-RC3 (aabbccd) STM32F7X2'}
  }));

  assert.equal(before.key, after.key, 'a firmware update must not create a second aircraft');
});

test('rates are not in the key either', () => {
  const before = deriveAircraftIdentity(session());
  const after = deriveAircraftIdentity(session({headers: {rates: '20,20,40'}}));
  assert.equal(before.key, after.key);
});

test('an unnamed aircraft is refused a key rather than pooled with every other one', () => {
  // The Rotorflight default is a blank craft name, so this is the common case
  // for a pilot who never set one — and pooling them all would be the board
  // merge above, committed deliberately.
  for (const name of [undefined, '', '   ']) {
    const identity = deriveAircraftIdentity(session({headers: {'Craft name': name}}));
    assert.equal(identity.keyable, false, `"${name}" must not be keyable`);
    assert.equal(identity.key, null);
    assert.ok(identity.codes.includes('CRAFT_NAME_MISSING'));
  }
});

test('the key survives the ways a pilot types the same name', () => {
  const plain = deriveAircraftIdentity(session()).key;
  for (const typed of ['  bell 222ut ', 'Bell 222UT', 'bell  222ut']) {
    assert.equal(
      deriveAircraftIdentity(session({headers: {'Craft name': typed}})).key,
      plain,
      `"${typed}" must key to the same aircraft`
    );
  }
});

test('a missing board is noted but does not lose the aircraft', () => {
  const identity = deriveAircraftIdentity(session({headers: {'Board information': ''}}));
  assert.equal(identity.keyable, true);
  assert.ok(identity.codes.includes('BOARD_INFORMATION_MISSING'));
});

// ---------------------------------------------------------------------------
// Pilot gains
// ---------------------------------------------------------------------------

test('the pilot gains are read from the header, P I D first and the rest kept', () => {
  const {gains, rates, codes} = readPilotGains(session());

  assert.deepEqual(gains.yaw, [315, 145, 29, 3, 1]);
  assert.deepEqual(gains.roll, [52, 105, 0, 100, 0]);
  assert.deepEqual(codes, []);
  assert.equal(rates, 'rf-rates-v2:4|5,5,12|30,30,50|10,10,25');
});

test('an unreadable gain line is reported, not guessed at', () => {
  const {gains, codes} = readPilotGains(session({headers: {yawPID: 'PID off'}}));
  assert.equal(gains.yaw, null);
  assert.ok(codes.includes('GAINS_UNREADABLE'));
});

test('a blank PID field is unreadable, never silently converted to zero', () => {
  for (const yawPID of ['315,145,', '315,,29', ',145,29']) {
    const {gains, codes} = readPilotGains(session({headers: {yawPID}}));
    assert.equal(gains.yaw, null, `blank field in "${yawPID}" became a gain`);
    assert.ok(codes.includes('GAINS_UNREADABLE'));
  }
});

test('the rate fingerprint includes expo and is absent unless every rate field is readable', () => {
  const baseline = readPilotGains(session());
  const changedExpo = readPilotGains(session({headers: {rc_expo: '35,35,55'}}));
  assert.notEqual(changedExpo.rates, baseline.rates,
    'an expo change must change the command-curve fingerprint');

  for (const key of ['rates_type', 'rc_rates', 'rc_expo', 'rates']) {
    for (const missing of [undefined, '', '   ']) {
      const result = readPilotGains(session({headers: {[key]: missing}}));
      assert.equal(result.rates, null, `${key}=${String(missing)} passed as a rate curve`);
      assert.ok(result.codes.includes('RATES_UNREADABLE'));
    }
  }
});

test('a change beyond P, I and D is seen rather than attributed to nothing', () => {
  // A pilot who changes feedforward alone must not look like a pilot who
  // changed nothing — the movement would then be credited to no cause at all.
  const before = record();
  const after = record({headers: {rollPID: '52,105,0,140,0'}});

  const {changes} = describeGainChanges(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].axis, 'roll');
  assert.equal(changes[0].index, 3);
  assert.equal(changes[0].term, 'index3', 'beyond D the term is not named, because it is not owned here');
});

test('a P, I or D change is named as a term', () => {
  const {changes} = describeGainChanges(record(), record({headers: {yawPID: '315,200,29,3,1'}}));
  assert.deepEqual(changes, [{axis: 'yaw', term: 'I', index: 1, from: 145, to: 200}]);
});

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

test('a session that never left the ground is not admitted', () => {
  // 72% of the real corpus: 73 of 110 sessions never started the rotor and 6
  // never lifted off. Stored, they would be padding, and "compare with the
  // previous flight" would pick a bench run.
  for (const basis of [
    FlightWindowBasis.NO_ROTOR_START,
    FlightWindowBasis.NO_LIFTOFF,
    FlightWindowBasis.NO_ROTOR_AT_SPEED,
    FlightWindowBasis.NO_COLLECTIVE
  ]) {
    const check = checkFlightAdmissible({
      session: session(),
      window: {basis, startUs: 0, endUs: 22_000_000}
    });
    assert.equal(check.admissible, false, `${basis} must not be admitted`);
    assert.ok(check.codes.includes('FLIGHT_NEVER_LEFT_THE_GROUND'));
  }
});

test('an airborne session is admitted, and both airborne bases are', () => {
  assert.ok(AIRBORNE_WINDOW_BASES.length === 2);
  for (const basis of AIRBORNE_WINDOW_BASES) {
    const check = checkFlightAdmissible({
      session: session(),
      window: {basis, startUs: 1_000_000, endUs: 61_000_000}
    });
    assert.equal(check.admissible, true, `${basis} must be admitted`);
    assert.deepEqual(check.codes, []);
  }
});

test('an unkeyable aircraft is not admitted, and says which of the two reasons it is', () => {
  const check = checkFlightAdmissible({
    session: session({headers: {'Craft name': ''}}),
    window: airborneWindow()
  });
  assert.equal(check.admissible, false);
  assert.ok(check.codes.includes('AIRCRAFT_NOT_KEYABLE'));
  assert.ok(!check.codes.includes('FLIGHT_NEVER_LEFT_THE_GROUND'),
    'the ground reason must not be reported for an airborne flight');
});

// ---------------------------------------------------------------------------
// The stored shape, and what may never be in it
// ---------------------------------------------------------------------------

test('every stored field is documented, and every documented field is stored', () => {
  const audit = auditFlightRecord(record());
  assert.deepEqual(audit.violations, [], 'RECORD_FIELDS and the record must agree exactly');
  assert.equal(audit.ok, true);
});

test('every documented field states a reason, not just a name', () => {
  for (const [path, reason] of Object.entries(RECORD_FIELDS)) {
    assert.equal(typeof reason, 'string', `${path} has no reason`);
    assert.ok(reason.length > 30, `${path}'s reason is too short to be one: "${reason}"`);
  }
  assert.ok(NEVER_STORED.length >= 6, 'the never-store list must survive tidying');
  for (const entry of NEVER_STORED) {
    assert.ok(entry.what.length > 0 && entry.why.length > 30, JSON.stringify(entry));
  }
});

test('the log start datetime never reaches a record, however the record is reached', () => {
  // The header carries it on every one of the 110 real sessions, and a list of
  // them is a record of when this person flies. This is the field most likely to
  // be added later by somebody being helpful.
  const stamp = '2026-07-22T17:14:55.015+00:00';
  const built = record();

  assert.ok(session().headers['Log start datetime'] === stamp,
    'the fixture must actually carry the timestamp, or this test proves nothing');
  assert.ok(!JSON.stringify(built).includes('2026-07-22'), 'the date reached the record');
  assert.ok(!JSON.stringify(built).includes('17:14'), 'the time reached the record');

  const history = addFlightRecord(createHistory(), built);
  assert.ok(!exportHistory(history).includes('2026-07-22'), 'the date reached the export');
});

test('nothing location-shaped reaches a record, even from a log that declares GPS', () => {
  const built = record();
  const text = JSON.stringify(built).toLowerCase();

  for (const forbidden of ['gps', 'coord', 'latitude', 'longitude', 'home', 'satellite', 'altitude']) {
    assert.ok(!text.includes(forbidden), `"${forbidden}" reached the record`);
  }
  // And the fixture really does declare location, so the check has something to
  // fail on rather than passing on a log with no GPS at all.
  assert.equal(session().locationFieldsDeclared, true);
  assert.ok(session().locationFields.length > 0);
});

test('the audit catches a timestamp, a path, and a trace pushed into a record', () => {
  // The audit is the guard; a guard that cannot go off is decoration. Each of
  // these is a plausible future "while we are here" addition.
  const base = record();

  const withClock = {...base, capturedAt: '2026-08-13T09:00:00.000+00:00'};
  const withPath = {...base, sourceFile: 'C:\\Users\\pilot\\Downloads\\flight.bbl'};
  const withTrace = {...base, gyroTrace: Array.from({length: 4096}, (unused, index) => index)};

  for (const [name, candidate] of Object.entries({withClock, withPath, withTrace})) {
    const audit = auditFlightRecord(candidate);
    assert.equal(audit.ok, false, `${name} must not pass the audit`);
  }

  assert.ok(auditFlightRecord(withClock).violations
    .some(violation => violation.reason.includes('wall-clock')));
  assert.ok(auditFlightRecord(withPath).violations
    .some(violation => violation.reason.includes('file path')));
  assert.ok(auditFlightRecord(withTrace).violations
    .some(violation => violation.reason.includes('raw trace')));
});

test('the export cannot carry a field somebody pushed into a record in memory', () => {
  // Structural, not a check: `exportHistory` rebuilds from the documented shape
  // rather than stringifying what it was handed, so an undocumented field has no
  // path to disk even if the audit is never called.
  const history = addFlightRecord(createHistory(), record());
  const contaminated = {
    ...history,
    records: history.records.map(entry => ({
      ...entry,
      sourceFile: 'C:\\Users\\pilot\\Downloads\\flight.bbl',
      capturedAt: '2026-08-13T09:00:00.000+00:00',
      gyroTrace: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    }))
  };

  const text = exportHistory(contaminated);
  assert.ok(!text.includes('sourceFile'), 'a filename reached the export');
  assert.ok(!text.includes('capturedAt'), 'a timestamp reached the export');
  assert.ok(!text.includes('gyroTrace'), 'a trace reached the export');

  // And the export still holds the flight it was meant to hold.
  assert.equal(importHistory(text).history.records.length, 1);
});

test('the export writes nothing the audit has not seen, including what nobody thought of', () => {
  // SHARPER THAN THE TEST ABOVE, which names three fields it already knows
  // about and therefore cannot catch a fourth. The change this reaches is a
  // field added to `exportableRecord` itself — the "while we are here" edit that
  // puts something undocumented on disk — caught by auditing what actually came
  // back off the export rather than by having been anticipated.
  //
  // Found by mutation: adding a plain number to `exportableRecord` left the
  // whole suite green before this existed.
  const history = addFlightRecord(createHistory(), record());
  const reread = importHistory(exportHistory(history)).history;

  assert.equal(reread.records.length, 1, 'the round trip must keep the flight');
  assert.deepEqual(auditFlightRecord(reread.records[0]).violations, []);
  assert.deepEqual(leafPaths(reread.records[0]).sort(), leafPaths(record()).sort(),
    'the exported shape and the built shape must be the same shape');
});

test('a record stays small enough that a history is not a database', () => {
  // Pinned so it cannot grow quietly, and stated as the measured number rather
  // than a round one. 2,539 bytes today; the cap of 200 makes a full history
  // 861 KiB of indented text, which the pilot can read end to end.
  const bytes = JSON.stringify(record()).length;
  assert.ok(bytes < 3000, `a record is ${bytes} bytes; the measured size is 2,539`);

  let history = createHistory();
  for (let index = 0; index < HISTORY_LIMITS.maximumRecordsPerAircraft; index += 1) {
    history = addFlightRecord(history, record());
  }
  const kib = exportHistory(history).length / 1024;
  assert.ok(kib < 1024, `a full history is ${kib.toFixed(0)} KiB; it must stay renderable`);
});

test('the stored shape is fixed, not conditional on what was measured', () => {
  // A record whose keys depend on what was measured cannot be checked against a
  // field list, and checking it against a field list is how the never-store
  // rules are enforced at all.
  const measured = record();
  const bare = buildFlightRecord({session: session(), window: airborneWindow()});

  assert.deepEqual(leafPaths(bare).sort(), leafPaths(measured).sort());
  assert.deepEqual(auditFlightRecord(bare).violations, []);
});

// ---------------------------------------------------------------------------
// The store: adding, listing, forgetting, exporting
// ---------------------------------------------------------------------------

test('ordinals are a monotone counter, and there is no clock anywhere in the store', () => {
  let history = createHistory();
  for (let index = 0; index < 3; index += 1) {
    history = addFlightRecord(history, record());
  }

  assert.deepEqual(history.records.map(entry => entry.ordinal), [0, 1, 2]);
  assert.equal(new Set(history.records.map(entry => entry.recordId)).size, 3);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(exportHistory(history)), 'a date appeared in the store');
});

test('forgetting a flight does not let the next one inherit its id', () => {
  // A reused id silently attaches a "forget this flight" tap to a different
  // flight. The sequence counter is what stops it.
  let history = addFlightRecord(createHistory(), record());
  const firstId = history.records[0].recordId;

  history = forgetFlight(history, firstId);
  assert.equal(history.records.length, 0);

  history = addFlightRecord(history, record());
  assert.notEqual(history.records[0].recordId, firstId);
});

test('adding never mutates the history it was given', () => {
  const before = addFlightRecord(createHistory(), record());
  const snapshot = JSON.stringify(before);
  addFlightRecord(before, record());
  assert.equal(JSON.stringify(before), snapshot);
});

test('forgetting one aircraft leaves the other alone and takes its counter with it', () => {
  let history = addFlightRecord(createHistory(), record());
  history = addFlightRecord(history, record({craftName: 'OMP4MAX'}));

  const bellKey = deriveAircraftIdentity(session()).key;
  history = forgetAircraft(history, bellKey);

  assert.equal(findRecords(history, bellKey).length, 0);
  assert.equal(listAircraft(history).length, 1);
  assert.ok(!(bellKey in history.sequences), 'the counter is residue and must go too');
  assert.ok(!exportHistory(history).includes('bell 222ut'), 'the aircraft is still in the export');
});

test('forgetting everything leaves nothing behind, counters included', () => {
  // A store the user cannot empty is a trail. "Empty" has to mean empty: a
  // surviving counter is still a count of how many times this person flew.
  let history = addFlightRecord(createHistory(), record());
  history = addFlightRecord(history, record({craftName: 'OMP4MAX'}));

  const emptied = forgetEverything(history);
  assert.deepEqual(emptied.records, []);
  assert.deepEqual(emptied.sequences, {});
  assert.deepEqual(listAircraft(emptied), []);

  const text = exportHistory(emptied);
  assert.ok(!text.includes('bell 222ut') && !text.includes('OMP4MAX'));
  assert.ok(!text.includes('VANTAC'));
});

test('a history is capped, so it cannot grow into a record of every flight ever made', () => {
  let history = createHistory();
  for (let index = 0; index < HISTORY_LIMITS.maximumRecordsPerAircraft + 5; index += 1) {
    history = addFlightRecord(history, record());
  }

  const kept = findRecords(history, deriveAircraftIdentity(session()).key);
  assert.equal(kept.length, HISTORY_LIMITS.maximumRecordsPerAircraft);
  assert.equal(kept[0].ordinal, 5, 'the OLDEST must be the one dropped');
  assert.equal(kept.at(-1).ordinal, HISTORY_LIMITS.maximumRecordsPerAircraft + 4);
});

test('export and import round-trip without losing or inventing a flight', () => {
  let history = addFlightRecord(createHistory(), record({errorDps: 0.0303}));
  history = addFlightRecord(history, record({errorDps: 0.0538}));

  const {history: restored, codes} = importHistory(exportHistory(history));
  assert.deepEqual(codes, []);
  assert.equal(restored.records.length, 2);
  assert.equal(
    restored.records[1].axes.yaw.hold.meanAbsoluteSteadyStateErrorDps,
    0.0538,
    'the measurement must survive the round trip exactly'
  );
  assert.deepEqual(restored.sequences, history.sequences);

  // And a comparison off the restored records reads the same as off the originals.
  assert.equal(
    compareFlightRecords(restored.records[0], restored.records[1]).outcome,
    compareFlightRecords(history.records[0], history.records[1]).outcome
  );
});

test('schema-1 rate fingerprints are preserved as flights but invalidated as evidence', () => {
  let history = addFlightRecord(createHistory(), record({errorDps: 5}));
  history = addFlightRecord(history, record({
    headers: {yawPID: '315,200,29,3,1'},
    errorDps: 1
  }));
  const legacy = JSON.parse(exportHistory(history));
  legacy.schemaVersion = 1;
  for (const stored of legacy.records) {
    stored.schemaVersion = 1;
    stored.ratesFingerprint = '4|5,5,12|10,10,25';
  }

  const imported = importHistory(JSON.stringify(legacy));
  assert.equal(imported.history.schemaVersion, FLIGHT_HISTORY_SCHEMA_VERSION);
  assert.equal(imported.history.records.length, 2, 'migration must not erase the pilot\'s flights');
  assert.ok(imported.codes.includes('HISTORY_RATE_FINGERPRINTS_INVALIDATED'));
  assert.ok(imported.history.records.every(stored => stored.ratesFingerprint === null));

  const comparison = compareFlightRecords(...imported.history.records);
  assert.equal(comparison.comparable, false);
  assert.ok(comparison.codes.includes('RATES_UNREADABLE'),
    'matching legacy strings do not prove expo was unchanged');
});

test('a malformed schema-2 rate fingerprint is retained only as unreadable', () => {
  const serialized = JSON.parse(exportHistory(
    addFlightRecord(createHistory(), record())
  ));
  serialized.records[0].ratesFingerprint = 'rf-rates-v2:only|two';

  const imported = importHistory(JSON.stringify(serialized));
  assert.equal(imported.history.records.length, 1);
  assert.equal(imported.history.records[0].ratesFingerprint, null);
  assert.ok(imported.codes.includes('HISTORY_RATE_FINGERPRINTS_INVALIDATED'));
});

test('a corrupt history loses the history, never the app', () => {
  // This runs at start. A throw here is a blank screen for a pilot at the field.
  for (const text of [
    undefined, null, '', '   ', 'not json', '{', '[]', '{"kind":"something-else"}',
    '{"kind":"rotorlens-flight-history","schemaVersion":99,"records":[]}',
    '{"kind":"rotorlens-flight-history","schemaVersion":1,"records":"nope"}'
  ]) {
    const result = importHistory(text);
    assert.equal(result.history.kind, FLIGHT_HISTORY_KIND);
    assert.ok(Array.isArray(result.history.records));
  }

  assert.ok(importHistory('not json').codes.includes('HISTORY_UNREADABLE'));
  assert.ok(importHistory('{"kind":"rotorlens-flight-history","schemaVersion":99,"records":[]}')
    .codes.includes('HISTORY_SCHEMA_VERSION_MISMATCH'));
});

// ---------------------------------------------------------------------------
// The comparison — refusals
// ---------------------------------------------------------------------------

test('two different aircraft are refused before anything is measured', () => {
  const comparison = compareFlightRecords(
    record({errorDps: 5}),
    {...record({craftName: 'OMP4MAX', errorDps: 1}), ordinal: 1}
  );
  assert.equal(comparison.comparable, false);
  assert.equal(comparison.outcome, COMPARISON_OUTCOME.NOT_ENOUGH_EVIDENCE);
  assert.ok(comparison.codes.includes('AIRCRAFT_MISMATCH'));
});

test('a firmware change is refused, because the controller moved under the numbers', () => {
  const comparison = compareFlightRecords(
    record({errorDps: 5}),
    {
      ...record({
        headers: {'Firmware revision': 'Rotorflight 4.6.0-RC3 (aabbccd) STM32F7X2', yawPID: '315,200,29,3,1'},
        errorDps: 1
      }),
      ordinal: 1
    }
  );
  assert.equal(comparison.comparable, false);
  assert.ok(comparison.codes.includes('FIRMWARE_CHANGED'));
});

test('a rate-curve change is refused, because the aircraft was asked something else', () => {
  const comparison = compareFlightRecords(
    record({errorDps: 5}),
    {...record({headers: {rates: '20,20,40', yawPID: '315,200,29,3,1'}, errorDps: 1}), ordinal: 1}
  );
  assert.equal(comparison.comparable, false);
  assert.ok(comparison.codes.includes('RATES_CHANGED'));
});

test('an expo change is a rate-curve change, and unknown matching configuration fails closed', () => {
  const expoChanged = compareFlightRecords(
    record({errorDps: 5}),
    {...record({headers: {rc_expo: '40,40,60', yawPID: '315,200,29,3,1'}, errorDps: 1}), ordinal: 1}
  );
  assert.equal(expoChanged.comparable, false);
  assert.ok(expoChanged.codes.includes('RATES_CHANGED'));

  const missingRates = record({headers: {rc_expo: ''}, errorDps: 5});
  const matchingUnknownRates = {
    ...record({headers: {rc_expo: '', yawPID: '315,200,29,3,1'}, errorDps: 1}),
    ordinal: 1
  };
  const unknownRates = compareFlightRecords(missingRates, matchingUnknownRates);
  assert.equal(unknownRates.comparable, false);
  assert.ok(unknownRates.codes.includes('RATES_UNREADABLE'));

  const legacyShape = compareFlightRecords(
    {...record({errorDps: 5}), ratesFingerprint: '4|5,5,12|10,10,25'},
    {
      ...record({headers: {yawPID: '315,200,29,3,1'}, errorDps: 1}),
      ratesFingerprint: '4|5,5,12|10,10,25',
      ordinal: 1
    }
  );
  assert.equal(legacyShape.comparable, false);
  assert.ok(legacyShape.codes.includes('RATES_UNREADABLE'));

  const missingFirmware = {...record({errorDps: 5}), firmwareRevision: '   '};
  const matchingUnknownFirmware = {
    ...record({headers: {yawPID: '315,200,29,3,1'}, errorDps: 1}),
    firmwareRevision: null,
    ordinal: 1
  };
  const unknownFirmware = compareFlightRecords(missingFirmware, matchingUnknownFirmware);
  assert.equal(unknownFirmware.comparable, false);
  assert.ok(unknownFirmware.codes.includes('FIRMWARE_UNREADABLE'));
});

test('more than one gain moving is refused — one change at a time or nothing', () => {
  const comparison = compareFlightRecords(
    record({errorDps: 5}),
    {...record({headers: {yawPID: '315,200,40,3,1'}, errorDps: 1}), ordinal: 1}
  );
  assert.equal(comparison.comparable, false);
  assert.ok(comparison.codes.includes('MULTIPLE_GAINS_CHANGED'));
});

test('a profile switch is named as one rather than reported as tuning', () => {
  // Four pairs in the real corpus change THIRTEEN values at once and revert.
  // Compared as tuning, that reports two profiles as a gain result.
  const comparison = compareFlightRecords(
    record({errorDps: 5}),
    {
      ...record({
        headers: {
          rollPID: '60,120,10,110,1',
          pitchPID: '70,120,50,110,1',
          yawPID: '300,200,40,5,0'
        },
        errorDps: 1
      }),
      ordinal: 1
    }
  );
  assert.equal(comparison.comparable, false);
  assert.ok(comparison.codes.includes('PROFILE_SWITCH_SUSPECTED'));
  assert.ok(!comparison.codes.includes('MULTIPLE_GAINS_CHANGED'),
    'a profile switch must be told apart from ordinary multi-gain fiddling');
});

test('records handed over in the wrong order are refused, not silently inverted', () => {
  const before = record({errorDps: 5, ordinal: 0});
  const after = {...record({headers: {yawPID: '315,200,29,3,1'}, errorDps: 1}), ordinal: 1};

  assert.equal(compareFlightRecords(before, after).comparable, true);
  const swapped = compareFlightRecords(after, before);
  assert.equal(swapped.comparable, false);
  assert.ok(swapped.codes.includes('RECORDS_OUT_OF_ORDER'));
});

test('an unkeyable aircraft cannot be compared at all', () => {
  const nameless = buildFlightRecord({
    session: session({headers: {'Craft name': ''}}),
    window: airborneWindow()
  });
  const comparison = compareFlightRecords(nameless, {...nameless, ordinal: 1});
  assert.equal(comparison.comparable, false);
  assert.ok(comparison.codes.includes('AIRCRAFT_NOT_KEYABLE'));
});

// ---------------------------------------------------------------------------
// The comparison — the noise floor
// ---------------------------------------------------------------------------

/** The one gain change the corpus actually contains: yaw I, 145 → 200 here. */
const YAW_I_CHANGED = {yawPID: '315,200,29,3,1'};

test('THE SIX-OF-SIX CASE: a 78% relative move that is 0.023 deg/s is not a result', () => {
  // These are the real numbers from OMP4MAX flights 32 → 34: yaw steady-state
  // error 0.0303 → 0.0538 deg/s. The shipped comparison called it "worsened" at
  // rel=78%. In absolute terms it is 0.0235 deg/s against a measured
  // flight-to-flight floor of 0.39.
  const before = record({errorDps: 0.0303});
  const after = {...record({headers: YAW_I_CHANGED, errorDps: 0.0538}), ordinal: 1};

  // The relative move really is large — otherwise this fixture would pass with
  // the absolute floor deleted, and would be a test that agrees with the bug.
  const relative = Math.abs(0.0538 - 0.0303) / 0.0303;
  assert.ok(relative > EVIDENCE_LIMITS.comparisonToleranceRatio * 7,
    `the fixture must clear the relative tolerance by a wide margin, got ${relative}`);

  const comparison = compareFlightRecords(before, after);
  assert.equal(comparison.comparable, true, 'this is a well-controlled pair; it must be compared');
  assert.equal(comparison.outcome, COMPARISON_OUTCOME.NO_DETECTABLE_CHANGE);
  assert.ok(comparison.axes.yaw.hold.codes.includes('CHANGE_BELOW_MEASURED_NOISE_FLOOR'));
  assert.equal(comparison.axes.yaw.hold.measured.clearsRelativeFloor, true);
  assert.equal(comparison.axes.yaw.hold.measured.clearsAbsoluteFloor, false);
});

test('a large absolute move that is a small fraction of a large error is not a result either', () => {
  // The mirror of the case above, and the reason both floors are needed. On a
  // machine whose steady-state error is 20 deg/s, a 1 deg/s move clears the
  // absolute floor comfortably and is still 5% — ordinary variation.
  const before = record({errorDps: 20});
  const after = {...record({headers: YAW_I_CHANGED, errorDps: 21}), ordinal: 1};

  assert.ok(Math.abs(21 - 20) > HISTORY_LIMITS.holdErrorNoiseFloorDps,
    'the fixture must clear the absolute floor, or it proves nothing about the relative one');

  const comparison = compareFlightRecords(before, after);
  assert.equal(comparison.outcome, COMPARISON_OUTCOME.NO_DETECTABLE_CHANGE);
  assert.equal(comparison.axes.yaw.hold.measured.clearsAbsoluteFloor, true);
  assert.equal(comparison.axes.yaw.hold.measured.clearsRelativeFloor, false);
});

test('a change that clears both floors, on the axis that was adjusted, is reported', () => {
  const before = record({errorDps: 5});
  const after = {...record({headers: YAW_I_CHANGED, errorDps: 3}), ordinal: 1};

  const comparison = compareFlightRecords(before, after);
  assert.equal(comparison.outcome, COMPARISON_OUTCOME.IMPROVED);
  assert.equal(comparison.changedAxis, 'yaw');
  assert.equal(comparison.changedTerm, 'I');
  assert.deepEqual(comparison.gainChanges, [{axis: 'yaw', term: 'I', index: 1, from: 145, to: 200}]);

  const worse = compareFlightRecords(
    before,
    {...record({headers: YAW_I_CHANGED, errorDps: 8}), ordinal: 1}
  );
  assert.equal(worse.outcome, COMPARISON_OUTCOME.WORSENED);
});

test('the I-only hold metric never judges P, D, feedforward, or boost changes', () => {
  const changes = [
    ['P', '400,145,29,3,1'],
    ['D', '315,145,50,3,1'],
    ['index3', '315,145,29,8,1'],
    ['index4', '315,145,29,3,4']
  ];

  for (const [term, yawPID] of changes) {
    const comparison = compareFlightRecords(
      record({errorDps: 5}),
      {...record({headers: {yawPID}, errorDps: 1}), ordinal: 1}
    );
    assert.equal(comparison.comparable, true, term);
    assert.equal(comparison.changedTerm, term);
    assert.equal(comparison.outcome, COMPARISON_OUTCOME.NOT_ENOUGH_EVIDENCE, term);
    assert.ok(comparison.axes.yaw.hold.codes
      .includes('RESPONSE_METRIC_NOT_SENSITIVE_TO_TERM'), term);
    assert.equal(comparison.axes.yaw.hold.measured.metric,
      'meanAbsoluteSteadyStateErrorDps');
  }
});

test('paired comparisons apply the measured floor for the changed axis', () => {
  const cases = [
    ['roll', 'rollPID', '52,200,0,100,0'],
    ['pitch', 'pitchPID', '64,200,40,100,0'],
    ['yaw', 'yawPID', '315,200,29,3,1']
  ];

  for (const [axis, header, gainLine] of cases) {
    const axisFloor = SENSITIVITY_FLOOR_DPS[axis];
    const baseline = axisFloor * 5;
    const above = compareFlightRecords(
      record({errorDps: baseline}),
      {
        ...record({headers: {[header]: gainLine}, errorDps: baseline - axisFloor * 1.1}),
        ordinal: 1
      }
    );
    assert.equal(above.noiseFloor.absoluteDps, axisFloor, axis);
    assert.equal(above.axes[axis].hold.measured.noiseFloorDps, axisFloor, axis);
    assert.equal(above.outcome, COMPARISON_OUTCOME.IMPROVED, axis);

    const below = compareFlightRecords(
      record({errorDps: baseline}),
      {
        ...record({headers: {[header]: gainLine}, errorDps: baseline - axisFloor * 0.9}),
        ordinal: 1
      }
    );
    assert.equal(below.outcome, COMPARISON_OUTCOME.NO_DETECTABLE_CHANGE, axis);
  }
});

test('the headline follows the axis the gain moved on, not the loudest axis', () => {
  // A yaw change credited with a roll result is how a tuning session goes wrong.
  const before = record({errorDps: 5});
  const after = {...record({headers: YAW_I_CHANGED, errorDps: 3}), ordinal: 1};

  const comparison = compareFlightRecords(before, after);
  assert.equal(comparison.changedAxis, 'yaw');
  assert.equal(comparison.outcome, comparison.axes.yaw.hold.outcome);
  // Roll moved by exactly the same amount in this fixture and is still not the
  // headline, because nothing on roll was adjusted.
  assert.equal(comparison.axes.roll.hold.outcome, COMPARISON_OUTCOME.NOT_ATTRIBUTABLE);
});

test('numbers that move with no gain change are NOT ATTRIBUTABLE, never "improved"', () => {
  // This is the six-of-six failure in its purest form: nothing was changed, and
  // the numbers moved anyway. The honest reading is that it is the aircraft, the
  // air, or the pilot — and it is the most useful thing this feature can show.
  const comparison = compareFlightRecords(
    record({errorDps: 5}),
    {...record({errorDps: 1}), ordinal: 1}
  );

  assert.equal(comparison.comparable, true);
  assert.ok(comparison.codes.includes('NO_GAIN_CHANGE'));
  assert.equal(comparison.outcome, COMPARISON_OUTCOME.NOT_ENOUGH_EVIDENCE,
    'with nothing changed there is no headline to give');
  assert.equal(comparison.axes.yaw.hold.outcome, COMPARISON_OUTCOME.NOT_ATTRIBUTABLE);
  assert.ok(comparison.axes.yaw.hold.codes.includes('NO_GAIN_CHANGE_TO_ATTRIBUTE_IT_TO'));
});

// ---------------------------------------------------------------------------
// The comparison — sample count and confounds
// ---------------------------------------------------------------------------

test('one hold against one hold cannot support a claim, however big the move', () => {
  // 59% of the comparable sides in the real corpus (58 of 98) had exactly one
  // hold segment. The gate is 3 per side, from per-axis power arithmetic
  // against the per-axis floors — see EVIDENCE_LIMITS.minimumComparisonHolds;
  // the old pooled derivation gave 5, which no real flight-axis has ever
  // reached, so the comparison had never once fired.
  for (const holdCount of [1, HISTORY_LIMITS.minimumComparisonHolds - 1]) {
    const comparison = compareFlightRecords(
      record({errorDps: 5, holdCount}),
      {...record({headers: YAW_I_CHANGED, errorDps: 1, holdCount}), ordinal: 1}
    );
    assert.equal(comparison.outcome, COMPARISON_OUTCOME.NOT_ENOUGH_EVIDENCE, `n=${holdCount}`);
    assert.ok(comparison.axes.yaw.hold.codes
      .includes('INSUFFICIENT_HOLD_SEGMENTS_FOR_COMPARISON'));
  }

  // And the same move at the minimum count does report, so the gate is a gate
  // and not a blanket refusal.
  const enough = compareFlightRecords(
    record({errorDps: 5, holdCount: HISTORY_LIMITS.minimumComparisonHolds}),
    {
      ...record({
        headers: YAW_I_CHANGED,
        errorDps: 1,
        holdCount: HISTORY_LIMITS.minimumComparisonHolds
      }),
      ordinal: 1
    }
  );
  assert.equal(enough.outcome, COMPARISON_OUTCOME.IMPROVED);
});

test('a headspeed change between the two flights is a confound, not a result', () => {
  const before = record({errorDps: 5, headspeedMedianRpm: 2000});
  const after = {
    ...record({headers: YAW_I_CHANGED, errorDps: 1, headspeedMedianRpm: 2400}),
    ordinal: 1
  };

  const comparison = compareFlightRecords(before, after);
  assert.equal(comparison.outcome, COMPARISON_OUTCOME.NOT_ENOUGH_EVIDENCE);
  assert.ok(comparison.axes.yaw.hold.codes.includes('HEADSPEED_MISMATCH'));

  // Inside the tolerance it is comparable again.
  const within = compareFlightRecords(
    before,
    {...record({headers: YAW_I_CHANGED, errorDps: 1, headspeedMedianRpm: 2050}), ordinal: 1}
  );
  assert.equal(within.outcome, COMPARISON_OUTCOME.IMPROVED);
});

test('an unknown headspeed fails the confound check rather than passing it', () => {
  // Not knowing is not the same as matching, and the failure mode of treating
  // them alike is a confident verdict from a flight with no headspeed logged.
  const before = record({errorDps: 5, headspeedMedianRpm: null});
  const after = {
    ...record({headers: YAW_I_CHANGED, errorDps: 1, headspeedMedianRpm: null}),
    ordinal: 1
  };

  assert.equal(before.axes.yaw.headspeedMedianRpm, null,
    'the fixture must really have no headspeed, or this test proves nothing');

  const comparison = compareFlightRecords(before, after);
  assert.equal(comparison.axes.yaw.hold.measured, null);
  assert.ok(comparison.axes.yaw.hold.codes.includes('HEADSPEED_MISMATCH'));
});

test('a heading hold is never compared against a constant-rate turn', () => {
  const before = record({errorDps: 5, zeroHoldCount: 6});
  const after = {...record({headers: YAW_I_CHANGED, errorDps: 1, zeroHoldCount: 0}), ordinal: 1};

  const comparison = compareFlightRecords(before, after);
  assert.ok(comparison.axes.yaw.hold.codes.includes('HOLD_KIND_MISMATCH'));
  assert.equal(comparison.outcome, COMPARISON_OUTCOME.NOT_ENOUGH_EVIDENCE);
});

test('mixed heading and rate holds are not relabelled as one hold kind', () => {
  const before = record({errorDps: 5, holdCount: 5, zeroHoldCount: 5});
  const mixed = {
    ...record({
      headers: YAW_I_CHANGED,
      errorDps: 1,
      holdCount: 5,
      zeroHoldCount: 1
    }),
    ordinal: 1
  };

  const comparison = compareFlightRecords(before, mixed);
  assert.equal(comparison.outcome, COMPARISON_OUTCOME.NOT_ENOUGH_EVIDENCE);
  assert.ok(comparison.axes.yaw.hold.codes.includes('HOLD_KIND_MISMATCH'));
});

test('inconclusive hold evidence on either side gives no verdict', () => {
  const before = record({errorDps: 5});
  const inconclusive = buildFlightRecord({
    session: session({headers: YAW_I_CHANGED}),
    window: airborneWindow(),
    axes: {
      yaw: {
        headspeedMedianRpm: 2000,
        holdEvidence: holdEvidence({status: 'inconclusive'}),
        noise: {}
      }
    },
    ordinal: 1
  });

  const comparison = compareFlightRecords(before, inconclusive);
  assert.equal(comparison.outcome, COMPARISON_OUTCOME.NOT_ENOUGH_EVIDENCE);
  assert.ok(comparison.axes.yaw.hold.codes.includes('HOLD_EVIDENCE_INCONCLUSIVE'));
});

// ---------------------------------------------------------------------------
// The stop half, which has never had a real log it could run on
// ---------------------------------------------------------------------------

test('stop metrics never produce a verdict, because no floor has ever been measured for them', () => {
  // Roll and pitch produced ZERO stop events across all 110 real flights, and
  // yaw never reached the two-per-direction minimum. The constants are
  // calibrated against nothing, so a direction read off them would be the
  // hold-comparison mistake committed a second time.
  const before = record({errorDps: 5, stopTrackingRmsDps: 60});
  const after = {
    ...record({headers: YAW_I_CHANGED, errorDps: 5.001, stopTrackingRmsDps: 5}),
    ordinal: 1
  };

  const comparison = compareFlightRecords(before, after);
  assert.equal(comparison.axes.yaw.stop.outcome, COMPARISON_OUTCOME.NOT_ENOUGH_EVIDENCE);
  assert.ok(comparison.axes.yaw.stop.codes.includes('STOP_FLOOR_NOT_MEASURED'));

  // The movement is still shown, because the pilot may look at it.
  assert.equal(comparison.axes.yaw.stop.directions.positive.trackingRmsDps.before, 60);
  assert.equal(comparison.axes.yaw.stop.directions.positive.trackingRmsDps.after, 5);

  // But a twelvefold change in it cannot make the headline anything.
  assert.equal(comparison.outcome, COMPARISON_OUTCOME.NO_DETECTABLE_CHANGE);
});

// ---------------------------------------------------------------------------
// The sweep. A hand-picked case is readable; a sweep is what makes it true.
// ---------------------------------------------------------------------------

test('no pair with nothing changed is ever called improved or worsened (4000 pairs)', () => {
  // This is the shipped defect, swept. The pairs are drawn across the whole
  // range the real corpus showed — yaw error down at 0.03 deg/s, roll up at 2.2
  // — which is where a purely relative tolerance goes wrong.
  const random = makeRandom(20260813);
  let compared = 0;

  for (let index = 0; index < 4000; index += 1) {
    const before = 10 ** (random() * 3 - 2);          // 0.01 .. 10 deg/s
    const after = before * (0.2 + random() * 4);      // -80% .. +300%
    const holdCount = 1 + Math.floor(random() * 12);

    const comparison = compareFlightRecords(
      record({errorDps: before, holdCount}),
      {...record({errorDps: after, holdCount}), ordinal: 1}
    );

    compared += 1;
    assert.notEqual(comparison.outcome, COMPARISON_OUTCOME.IMPROVED,
      `nothing changed, yet improved: ${before} -> ${after}`);
    assert.notEqual(comparison.outcome, COMPARISON_OUTCOME.WORSENED,
      `nothing changed, yet worsened: ${before} -> ${after}`);
    for (const axis of ['roll', 'pitch', 'yaw']) {
      assert.notEqual(comparison.axes[axis].hold.outcome, COMPARISON_OUTCOME.IMPROVED);
      assert.notEqual(comparison.axes[axis].hold.outcome, COMPARISON_OUTCOME.WORSENED);
    }
  }

  assert.equal(compared, 4000);
});

test('a verdict is given only when BOTH floors and the sample count are cleared (4000 pairs)', () => {
  const random = makeRandom(880123);
  const seen = {improved: 0, worsened: 0, floored: 0, thin: 0};

  for (let index = 0; index < 4000; index += 1) {
    const before = 10 ** (random() * 3 - 2);
    const after = before * (0.2 + random() * 4);
    const holdCount = 1 + Math.floor(random() * 12);

    const beforeRecord = record({errorDps: before, holdCount});
    const afterRecord = {
      ...record({headers: YAW_I_CHANGED, errorDps: after, holdCount}),
      ordinal: 1
    };
    const comparison = compareFlightRecords(beforeRecord, afterRecord);

    // Records deliberately retain four decimal places. The expected branch
    // must use the values the comparison actually receives: a raw difference
    // just above the floor can round to exactly the floor, which must withhold.
    const storedBefore = beforeRecord.axes.yaw.hold.meanAbsoluteSteadyStateErrorDps;
    const storedAfter = afterRecord.axes.yaw.hold.meanAbsoluteSteadyStateErrorDps;
    const difference = storedAfter - storedBefore;
    const relative = Math.abs(difference) / storedBefore;
    const clearsAbsolute = Math.abs(difference) > SENSITIVITY_FLOOR_DPS.yaw;
    const clearsRelative = relative > HISTORY_LIMITS.comparisonToleranceRatio;
    const enoughHolds = holdCount >= HISTORY_LIMITS.minimumComparisonHolds;

    const expected = !enoughHolds
      ? COMPARISON_OUTCOME.NOT_ENOUGH_EVIDENCE
      : (clearsAbsolute && clearsRelative
        ? (difference < 0 ? COMPARISON_OUTCOME.IMPROVED : COMPARISON_OUTCOME.WORSENED)
        : COMPARISON_OUTCOME.NO_DETECTABLE_CHANGE);

    assert.equal(comparison.outcome, expected,
      `${before} -> ${after}, n=${holdCount}: expected ${expected}`);

    if (!enoughHolds) {
      seen.thin += 1;
    } else if (expected === COMPARISON_OUTCOME.NO_DETECTABLE_CHANGE) {
      seen.floored += 1;
    } else if (expected === COMPARISON_OUTCOME.IMPROVED) {
      seen.improved += 1;
    } else {
      seen.worsened += 1;
    }
  }

  // A sweep that only ever generated one branch would pass while proving
  // nothing about the others.
  for (const [branch, count] of Object.entries(seen)) {
    assert.ok(count > 100, `the sweep reached ${branch} only ${count} times`);
  }
});

test('the outcome vocabulary is closed, and none of it is a magnitude', () => {
  // The product decision of 12 August 2026: directions, not magnitudes. The
  // arithmetic behind it is that resolving the corpus's one real gain change —
  // 0.0285 deg/s over the detected window — would need thousands of hold
  // segments a side. A magnitude may only ever arrive from the sensitivity
  // model, which earns it from six or more flights and un-says it on a delete.
  const allowed = new Set(Object.values(COMPARISON_OUTCOME));
  assert.equal(allowed.size, 5);

  const random = makeRandom(4242);
  for (let index = 0; index < 500; index += 1) {
    const comparison = compareFlightRecords(
      record({errorDps: random() * 8, holdCount: 1 + Math.floor(random() * 10)}),
      {...record({headers: YAW_I_CHANGED, errorDps: random() * 8}), ordinal: 1}
    );
    assert.ok(allowed.has(comparison.outcome), comparison.outcome);
    for (const axis of ['roll', 'pitch', 'yaw']) {
      assert.ok(allowed.has(comparison.axes[axis].hold.outcome));
    }
  }
});

test('the floor is reported with the comparison, so a pilot can see what it is', () => {
  const floor = describeNoiseFloor();
  assert.equal(floor.absoluteDps, EVIDENCE_LIMITS.holdErrorNoiseFloorDps);
  assert.ok(floor.sentence.includes(String(floor.absoluteDps)),
    'the sentence must carry the same number as the gate');

  const comparison = compareFlightRecords(record({errorDps: 5}), {...record(), ordinal: 1});
  assert.deepEqual(comparison.noiseFloor, floor);
  // Including on a refusal, where the pilot most needs to know why.
  assert.deepEqual(
    compareFlightRecords(record(), {...record({craftName: 'OMP4MAX'}), ordinal: 1}).noiseFloor,
    floor
  );
});

// ---------------------------------------------------------------------------
// Against the real evidence engine, not a hand-written imitation of it
// ---------------------------------------------------------------------------

const HOLD_US = EVIDENCE_LIMITS.minimumHoldDurationUs + 3_000_000;

function holdSamples({startUs = 0, durationUs = HOLD_US, errorDps = 0} = {}) {
  const records = [];
  for (let elapsed = 0; elapsed <= durationUs; elapsed += 1000) {
    records.push({
      timeUs: startUs + elapsed,
      setpoint: [0, 0, 0],
      gyro: [0, 0, -errorDps],
      raw: [0, 0, -errorDps],
      terms: [8, 12, 3],
      headspeed: 2000,
      collective: 5,
      vbat: 25
    });
  }
  return records;
}

function excursion(startUs) {
  const records = [];
  for (let elapsed = 0; elapsed <= 200_000; elapsed += 1000) {
    records.push({
      timeUs: startUs + elapsed,
      setpoint: [0, 0, 90],
      gyro: [0, 0, 90],
      raw: [0, 0, 90],
      terms: [8, 12, 3],
      headspeed: 2000,
      collective: 5,
      vbat: 25
    });
  }
  return records;
}

/** `count` real holds, separated by excursions, with a lead-in the engine needs. */
function realHoldRecords(count, errorDps) {
  const records = [...excursion(0)];
  let cursor = 500_000;
  for (let index = 0; index < count; index += 1) {
    records.push(...holdSamples({startUs: cursor, errorDps}));
    cursor += HOLD_US + 100_000;
    records.push(...excursion(cursor));
    cursor += 400_000;
  }
  return records;
}

test('the stored numbers are the evidence engine\'s own, not a shape invented here', () => {
  // The synthetic `holdEvidence()` fixture above is only as good as its
  // resemblance to the real thing. This builds evidence with the actual
  // `buildHoldEvidence` and checks the record carries its summary verbatim.
  const evidence = buildHoldEvidence(realHoldRecords(6, 4), {axis: 'yaw', term: 'I'});
  assert.equal(evidence.status, 'captured', 'the fixture must produce real captured evidence');
  assert.ok(evidence.summary.holdCount >= 5, `got ${evidence.summary.holdCount} holds`);

  const built = buildFlightRecord({
    session: session(),
    window: airborneWindow(),
    axes: {yaw: {headspeedMedianRpm: 2000, holdEvidence: evidence, noise: {}}}
  });

  const stored = built.axes.yaw.hold;
  assert.equal(stored.status, evidence.status);
  assert.equal(stored.holdCount, evidence.summary.holdCount);
  assert.equal(
    stored.meanAbsoluteSteadyStateErrorDps,
    evidence.summary.meanAbsoluteSteadyStateErrorDps
  );
  assert.equal(stored.meanITermRms, evidence.summary.meanITermRms);
  assert.deepEqual(auditFlightRecord(built).violations, []);
});

test('directional stop evidence is stored per direction, from the real builder', () => {
  const events = ['positive', 'negative'].flatMap(commandSign => [0, 1].map(() => ({
    commandSign,
    stopTimeUs: 0,
    commandAmplitudeDps: 180,
    trackingRmsDps: 34.8202,
    fastRingingRmsDps: 4,
    slowOscillationRmsDps: 2,
    headspeedRpm: 2000
  })));
  const evidence = buildDirectionalStopEvidence(events, {axis: 'yaw'});
  assert.equal(evidence.status, 'captured');

  const built = buildFlightRecord({
    session: session(),
    window: airborneWindow(),
    axes: {yaw: {headspeedMedianRpm: 2000, stopEvidence: evidence, noise: {}}}
  });

  assert.equal(built.axes.yaw.stop.positive.eventCount, 2);
  assert.equal(built.axes.yaw.stop.positive.trackingRmsDps, 34.8202);
  assert.deepEqual(auditFlightRecord(built).violations, []);
});

test('the engine\'s own comparison now refuses a move below the measured floor', () => {
  // `compareHoldEvidence` gained the same absolute floor, because it is the
  // function that produced the six false positives and it is still callable
  // directly. Yaw at 0.03 deg/s is where it went wrong.
  const before = buildHoldEvidence(realHoldRecords(3, 0.0303), {axis: 'yaw', term: 'I'});
  const after = buildHoldEvidence(realHoldRecords(3, 0.0538), {axis: 'yaw', term: 'I'});

  const comparison = compareHoldEvidence(before, after);
  assert.equal(comparison.changes.meanAbsoluteSteadyStateErrorDps.significant, true,
    'the relative tolerance must still be cleared, or this proves nothing');
  assert.equal(comparison.changes.meanAbsoluteSteadyStateErrorDps.clearsNoiseFloor, false);
  assert.equal(comparison.verdict, 'unchanged');
  assert.ok(comparison.codes.includes('CHANGE_BELOW_MEASURED_NOISE_FLOOR'));
  assert.equal(comparison.noiseFloorDps, EVIDENCE_LIMITS.holdErrorNoiseFloorByAxisDps.yaw,
    'the comparison must gate on its own axis\'s measured floor, not the pooled one');
  assert.equal(comparison.holdCounts.baseline, before.summary.holdCount);
});

test('a real move still reads as a real move through the engine\'s comparison', () => {
  // The other half of the pair above: the gate must be a gate, not a mute.
  const before = buildHoldEvidence(realHoldRecords(3, 4), {axis: 'yaw', term: 'I'});
  const after = buildHoldEvidence(realHoldRecords(3, 1), {axis: 'yaw', term: 'I'});

  const comparison = compareHoldEvidence(before, after);
  assert.equal(comparison.verdict, 'improved');
  assert.equal(comparison.changes.meanAbsoluteSteadyStateErrorDps.clearsNoiseFloor, true);
});

// ---------------------------------------------------------------------------
// Real logs, when one is provided
// ---------------------------------------------------------------------------

const REAL_LOG = process.env.ROTORLENS_REAL_LOG;

test('a real header keys, gains and refuses exactly as the corpus said it would',
  {skip: !REAL_LOG && 'set ROTORLENS_REAL_LOG to a .bbl path to run this'}, async () => {
    const {readFile} = await import('node:fs/promises');
    const {parseSessions} = await import('../src/blackbox/headers.mjs');

    const bytes = new Uint8Array(await readFile(REAL_LOG));
    const sessions = parseSessions(bytes);
    assert.ok(sessions.length > 0);

    for (const parsed of sessions) {
      const identity = deriveAircraftIdentity(parsed);
      const {gains} = readPilotGains(parsed);

      if (identity.keyable) {
        assert.ok(identity.key.includes('::'), identity.key);
        // The key is derived from header strings; none of it may be a clock.
        assert.ok(!/\d{4}-\d{2}-\d{2}/.test(identity.key), identity.key);
      }

      for (const axis of ['roll', 'pitch', 'yaw']) {
        if (gains[axis] !== null) {
          assert.ok(gains[axis].length >= 3, `${axis}: ${JSON.stringify(gains[axis])}`);
          assert.ok(gains[axis].every(Number.isFinite));
        }
      }

      // And the log's own timestamp, which every real session carries, must not
      // survive into a record built from it.
      const stamp = parsed.headers['Log start datetime'];
      if (typeof stamp === 'string' && stamp !== '') {
        const built = buildFlightRecord({session: parsed, window: airborneWindow()});
        assert.ok(!JSON.stringify(built).includes(stamp.slice(0, 10)),
          'a real log start date reached the record');
        assert.deepEqual(auditFlightRecord(built).violations, []);
      }

      // The location claim, against a log that really does carry GPS.
      //
      // The synthetic version of this check cannot fail: its fixture sets
      // `locationFieldsDeclared` and `locationFields`, and `buildFlightRecord`
      // reads neither, so the declaration cannot influence the result and the
      // test would pass just as happily on a log with no GPS at all. That is the
      // defect this repo keeps shipping — an assertion that cannot reach the
      // failure it names — so the real claim is made here instead, where the
      // field names come from the log's own header rather than from a fixture.
      if (parsed.locationFieldsDeclared && parsed.locationFields.length > 0) {
        const built = buildFlightRecord({session: parsed, window: airborneWindow()});
        const exported = exportHistory(addFlightRecord(createHistory(), built));

        // Every field name the log itself declares, verbatim. On the reference
        // Bell 222UT that is eight of them, coordinates and home position among
        // them, so the loop has real work to do rather than iterating zero times.
        for (const field of parsed.locationFields) {
          assert.ok(!JSON.stringify(built).includes(field),
            `the declared location field ${field} reached the record`);
          assert.ok(!exported.includes(field),
            `the declared location field ${field} reached the export`);
        }

        // And the shapes those fields take, in case one is ever renamed.
        const text = exported.toLowerCase();
        for (const forbidden of ['gps', 'coord', 'latitude', 'longitude',
          'satellite', 'numsat', 'altitude']) {
          assert.ok(!text.includes(forbidden),
            `"${forbidden}" reached the export of a flight from a log that declares GPS`);
        }
      }
    }
  });

/**
 * A flight is never its own baseline.
 *
 * Reproduced on a handset before this existed: save a flight, switch the window
 * to "Whole log", switch back to the detected one. The window change rebuilds
 * the candidate, which cleared the viewer's note of what it had just stored, so
 * the most recent stored record — this same flight — became the baseline. The
 * panel showed 19.00 against 19.00 and 20.54 against 20.54, then offered Save
 * again and stored a third copy.
 *
 * A before/after table whose two columns are identical by construction is the
 * most convincing possible way to tell a pilot their change did nothing.
 */
test('a re-derived flight is recognised as already stored, not used as its own baseline', () => {
  const firstSession = session({headers: {'Craft name': 'M4Max', 'Board information': 'NEXUS'}});
  const secondSession = session({headers: {'Craft name': 'M4Max', 'Board information': 'NEXUS'}});
  const first = record({sourceSession: firstSession, seconds: 56});
  const second = record({sourceSession: secondSession, seconds: 80});

  let history = addFlightRecord(createHistory(), first);

  // Nothing stored for this aircraft yet beyond `first`: `second` is a new
  // flight and compares against it.
  const fresh = selectBaseline(history, second);
  assert.equal(fresh.storedAs, null, 'an unsaved flight is not already stored');
  assert.equal(fresh.baseline?.durationSeconds, 56, 'and compares against the previous one');

  history = addFlightRecord(history, second);

  // Now re-derive `second` exactly as a window change does. It must be
  // recognised as the stored flight, and must NOT be its own baseline.
  const again = selectBaseline(history, record({sourceSession: secondSession, seconds: 80}));
  assert.ok(again.storedAs, 're-deriving a saved flight must report it as already stored');
  assert.equal(again.baseline?.durationSeconds, 56,
    'the baseline must be the earlier flight, never the candidate itself');
  assert.notEqual(again.baseline?.durationSeconds, 80,
    'a flight compared with itself is a table that agrees by construction');

  // The first flight of an aircraft has nothing to compare against, saved or not.
  const only = selectBaseline(
    addFlightRecord(createHistory(), first),
    record({sourceSession: firstSession, seconds: 56})
  );
  assert.ok(only.storedAs, 'the only stored flight is still recognised as stored');
  assert.equal(only.baseline, null, 'and has nothing before it to compare against');
});

test('isSameFlight uses the decoded session, not colliding rounded summaries', () => {
  const source = session({headers: {'Craft name': 'M4Max', 'Board information': 'NEXUS'}});
  const wrapper = decoded => ({...decoded, sourceSession: decoded});
  const flight = record({sourceSession: wrapper(source), seconds: 56});
  const rederived = record({sourceSession: wrapper(source), seconds: 56, ordinal: 99});
  const otherSource = session({headers: {'Craft name': 'M4Max', 'Board information': 'NEXUS'}});
  const lookalike = record({
    sourceSession: wrapper(otherSource),
    seconds: 56
  });

  assert.equal(isSameFlight(flight, rederived), true,
    're-analysis of one decoded session retains its process-local identity');
  assert.equal(isSameFlight(flight, lookalike), false,
    'a different flight with identical rounded summaries must not be conflated');
  assert.equal(isSameFlight(flight, null), false);
});

// ---------------------------------------------------------------------------
// The per-aircraft sensitivity model
//
// THE FAILURE THESE REACH FOR: a model that speaks from two flights. The
// measured flight-to-flight floor is 0.0966 deg/s on yaw and the one genuine
// experiment in the whole reference corpus moved the metric by 0.0285 — smaller
// than the noise, with a 95% interval that includes zero. Anything fitted to
// that would be fitting weather and would then speak with more authority than
// the paired comparison it replaced.
//
// So the two halves below are both required, and either alone is satisfied by a
// useless model: the NULL sweep (true slope zero, thousands of histories, how
// often does it speak) is passed by `return 'collecting'`, and the RECOVERY
// sweep (known injected slope, where does it start speaking and does it get the
// answer right) is passed by a model with no gates at all.
// ---------------------------------------------------------------------------

/** The aircraft every fixture below is the same machine of. */
const SENSITIVITY_KEY = record().aircraftKey;

/** Box-Muller, off the same deterministic generator, so a failure repeats. */
function gaussian(random) {
  const first = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * random());
}

/**
 * A history of flights differing only in one yaw gain and its measured error.
 *
 * `yawPID` is `P,I,D,…`, so index 1 is I. Everything else — roll and pitch
 * gains, firmware, rates, head speed, vibration — is held constant unless a
 * fixture deliberately moves it, which is what makes each gate reachable one at
 * a time.
 */
function sensitivityHistory(flights) {
  let history = createHistory();
  for (const flight of flights) {
    const {
      yawP = 315,
      yawI = 250,
      yawD = 29,
      errorDps,
      rippleRmsDps = 0.3,
      holdCount = 4,
      headspeedMedianRpm = 2000,
      headers = {}
    } = flight;
    history = addFlightRecord(history, record({
      headers: {yawPID: `${yawP},${yawI},${yawD},3,1`, ...headers},
      errorDps,
      rippleRmsDps,
      holdCount,
      headspeedMedianRpm
    }));
  }
  return history;
}

/** The yaw I entry of the model built from those flights. */
function yawIterm(flights) {
  return findSensitivityTerm(
    buildSensitivityModel(sensitivityHistory(flights), SENSITIVITY_KEY),
    'yaw',
    'I'
  );
}

test('the model is nine terms, three floors, and nothing stored', () => {
  const history = sensitivityHistory([{errorDps: 0.05}, {errorDps: 0.06}]);
  const before = exportHistory(history);
  const model = buildSensitivityModel(history, SENSITIVITY_KEY);

  assert.equal(model.kind, SENSITIVITY_MODEL_KIND);
  assert.equal(model.terms.length, 9);
  assert.equal(model.responseMetric, SENSITIVITY_RESPONSE_METRIC);
  for (const term of model.terms) {
    assert.equal(term.responseMetric, SENSITIVITY_RESPONSE_METRIC,
      'a second response metric must be a visible constant, not a hidden assumption');
  }

  // The whole reason for deriving rather than storing: building a model cannot
  // change what is on disk, because it never touches it.
  assert.equal(exportHistory(history), before);
  assert.ok(!before.includes(SENSITIVITY_MODEL_KIND));
  assert.equal(FLIGHT_HISTORY_SCHEMA_VERSION, 2,
    'expo changed the stored fingerprint contract and therefore the schema');
  for (const stored of history.records) {
    assert.deepEqual(auditFlightRecord(stored).violations, []);
  }
});

test('every flight is accounted for, admitted or refused with a reason', () => {
  // A pilot who remembers a flight and cannot find it in the count assumes the
  // feature is broken. The counts must reconcile with the flight count exactly.
  const history = sensitivityHistory([
    {yawI: 200, errorDps: 0.25},
    {yawI: 250, errorDps: 0.2},
    {yawI: 300, errorDps: 0.17, holdCount: 1},
    {yawI: 350, errorDps: 0.14, headspeedMedianRpm: 1500},
    {yawI: 400, errorDps: 0.12}
  ]);
  const model = buildSensitivityModel(history, SENSITIVITY_KEY);

  for (const term of model.terms) {
    const total = Object.values(term.exclusions).reduce((sum, count) => sum + count, 0);
    assert.equal(total, model.flightCount, `${term.axis} ${term.term} lost a flight`);
  }

  const yawI = findSensitivityTerm(model, 'yaw', 'I');
  assert.equal(yawI.exclusions.INSUFFICIENT_HOLD_SEGMENTS_FOR_COMPARISON, 1);
  assert.equal(yawI.exclusions.HEADSPEED_MISMATCH, 1);
  assert.equal(yawI.exclusions.admitted, 3);
  // And the refused ones are still visible with their reason, not silently gone.
  assert.deepEqual(
    yawI.points.filter(point => !point.admitted).map(point => point.excludedBy).sort(),
    ['HEADSPEED_MISMATCH', 'INSUFFICIENT_HOLD_SEGMENTS_FOR_COMPARISON']
  );
});

test('with a slope injected, it stays silent to five flights, speaks at six, and '
  + 'recovers the exponent it was given', () => {
  // metric = 50 / gain, i.e. exactly the inverse law a standing error follows
  // under a constant disturbance. The exponent to recover is therefore -1.
  const TRUE_EXPONENT = -1;
  const NOISE_SD = 0.05;

  let firstSpeakingN = null;
  const intervals = [];
  let trialsAtTwenty = 0;
  let usableAtTwenty = 0;

  for (let count = 1; count <= 24; count += 1) {
    for (let seed = 0; seed < 40; seed += 1) {
      const random = makeRandom(count * 7919 + seed);
      const flights = [];
      for (let index = 0; index < count; index += 1) {
        const yawI = 100 + Math.round(random() * 300);
        flights.push({
          yawI,
          errorDps: Math.max(0.002, 50 / yawI + gaussian(random) * NOISE_SD)
        });
      }

      const term = yawIterm(flights);
      if (term.state === SENSITIVITY_STATE.USABLE) {
        firstSpeakingN = firstSpeakingN === null ? count : Math.min(firstSpeakingN, count);
        intervals.push(term.fit.slope.interval);
      }
      if (count >= 20) {
        trialsAtTwenty += 1;
        usableAtTwenty += term.state === SENSITIVITY_STATE.USABLE ? 1 : 0;
      }
    }
  }

  // WHERE IT STARTS SPEAKING. A model that speaks at two on this noise floor is
  // the failure the whole feature exists to avoid.
  assert.equal(firstSpeakingN, SENSITIVITY_LIMITS.minimumPointsForFit,
    `first spoke at ${firstSpeakingN} flights`);
  assert.ok(firstSpeakingN > 2, 'it spoke from two flights');

  // AND IT MUST ACTUALLY SPEAK. Without this half, the silence above is passed
  // by a model that never says anything at all.
  const detection = usableAtTwenty / trialsAtTwenty;
  assert.ok(detection >= 0.9, `detected a real slope in only ${(detection * 100).toFixed(0)}%`);

  const covering = intervals
    .filter(([low, high]) => low <= TRUE_EXPONENT && TRUE_EXPONENT <= high).length;
  assert.ok(covering / intervals.length >= 0.8,
    `the interval held the true exponent ${(100 * covering / intervals.length).toFixed(0)}% `
    + `of the time over ${intervals.length} fits`);
});

test('on histories where nothing is happening, it almost never speaks', () => {
  // THE SIX-OF-SIX TEST, one level up. True exponent zero, the metric drawn at
  // the axis's own measured spread, and the confounds a real history carries:
  // head speed jittering in and out of the band, firmware and rates
  // occasionally moving, and a PID profile being flipped back and forth.
  const FLOOR = SENSITIVITY_FLOOR_DPS.yaw;
  let trials = 0;
  let spoke = 0;

  for (let seed = 0; seed < 1500; seed += 1) {
    const random = makeRandom(seed * 104_729 + 13);
    const count = 6 + Math.floor(random() * 15);
    const flights = [];
    for (let index = 0; index < count; index += 1) {
      const headers = {};
      if (random() < 0.08) {
        headers['Firmware revision'] = 'Rotorflight 4.6.1 (aaaaaaa) STM32F7X2';
      }
      if (random() < 0.08) {
        headers.rates = '10,10,30';
      }
      if (random() < 0.15) {
        headers.rollPID = '60,105,0,100,0';
      }
      flights.push({
        yawI: 100 + Math.round(random() * 300),
        errorDps: Math.max(0.002, 0.25 + gaussian(random) * FLOOR),
        headspeedMedianRpm: random() < 0.15 ? 2000 + Math.round(random() * 300) : 2000
      });
    }

    trials += 1;
    spoke += yawIterm(flights).state === SENSITIVITY_STATE.USABLE ? 1 : 0;
  }

  const rate = spoke / trials;
  assert.ok(rate <= 0.015,
    `spoke on ${(rate * 100).toFixed(1)}% of ${trials} histories where nothing happened`);
});

test('a gain that only ever climbed with the calendar cannot be told from the calendar, '
  + 'and the same physics flown out of order can', () => {
  // THE CONFOUND THE APP'S OWN ADVICE MANUFACTURES. "Change one gain, fly it,
  // change it again" produces a gain that rises monotonically with flight order,
  // and anything else that drifted over those weeks — blades wearing, a belt
  // loosening, the seasons — is then the SAME VARIABLE. Measured on the shipped
  // code before the fix: a drift of 0.2 deg/s across eight ordered flights, one
  // seventh of a single ordinary flight-to-flight excursion in the corpus, was
  // enough to reach `usable` on a gain whose true effect was exactly zero.
  //
  // BOTH HALVES ARE REQUIRED AND THEY ARE IN ONE TEST ON PURPOSE. The refusal
  // alone is passed by a model that refuses everything; the recovery alone is
  // passed by a model with no gate. The two fixtures below carry the SAME gain
  // values, the SAME noise draws and the SAME true relationship. Only the ORDER
  // the pilot flew them in differs.
  const gains = [20, 25, 30, 35, 40, 45, 50, 55];
  const random = makeRandom(20_260_812);
  const wobble = gains.map(() => gaussian(random) * 0.01);

  // A. The gain does NOTHING. A drift runs with the calendar.
  const ratchet = gains.map((yawI, index) => ({
    yawI,
    errorDps: 2 + 0.2 * index + wobble[index]
  }));
  const confounded = yawIterm(ratchet);
  assert.equal(confounded.state, SENSITIVITY_STATE.UNDERPOWERED,
    `a pure drift on an ordered ladder reached ${confounded.state}`);
  assert.ok(confounded.codes.includes('GAIN_CONFOUNDED_WITH_FLIGHT_ORDER'));
  assert.equal(confounded.magnitude, null, 'and no amount survives it either');
  // The plain slope is exactly the trap: it looks clean, and it is reported so a
  // pilot can see what was refused rather than being told nothing was found.
  assert.ok(confounded.fit.slope.excludesZero,
    'the fixture must be one the UNCONTROLLED fit would have believed');
  assert.ok(confounded.fit.residualSdDps < confounded.floor.appliedDps,
    'and one the residual-scatter gate lets through, which is why that gate is not enough');
  // Not a counter. More flights further up the ladder are the one thing that
  // cannot fix this, so asking for them would be asking for the wrong flight.
  assert.equal(confounded.needs.morePointsNeeded, null);
  assert.match(confounded.needs.sentence, /already flown/);

  // B. Same eight gains, same wobble, a REAL effect — flown out of order.
  const order = [0, 5, 2, 7, 1, 6, 3, 4];
  const revisited = order.map((which, index) => ({
    yawI: gains[which],
    errorDps: 40 / gains[which] + wobble[index]
  }));
  const clean = yawIterm(revisited);
  assert.equal(clean.state, SENSITIVITY_STATE.USABLE,
    `an out-of-order sweep with a real effect reached ${clean.state}`);
  assert.equal(clean.fit.direction, 'higher-gain-went-with-less-error');

  // C. And the SAME real effect, ratcheted, is refused — because the drift and
  //    the gain would be indistinguishable even when the gain is the true cause.
  const sameEffectRatcheted = gains.map((yawI, index) => ({
    yawI,
    errorDps: 40 / yawI + wobble[index]
  }));
  const honestRefusal = yawIterm(sameEffectRatcheted);
  assert.notEqual(honestRefusal.state, SENSITIVITY_STATE.USABLE,
    'a monotone ladder is refused even when the effect on it is real; that is the cost, '
    + 'and it is the reason the sentence asks for a value to be re-flown');

  // D. ONE token step down is not a design, and this is the half the structural
  //    check cannot do. The gain moves both ways here — 20 down to 18, then a
  //    ladder all the way up — so the design question is answered yes and it is
  //    then the ARITHMETIC that has to refuse. The gain is still almost perfectly
  //    correlated with the calendar; the variance that implies is paid honestly
  //    into the interval, and the interval opens far enough to contain zero.
  //    WITHOUT THIS FIXTURE, deleting the entire statistical half of the gate
  //    leaves the file green — measured, not assumed.
  const tokenStep = [20, 18, 25, 30, 35, 40, 45, 50].map((yawI, index) => ({
    yawI,
    errorDps: 2 + 0.1 * index
  }));
  const barelyMoved = yawIterm(tokenStep);
  assert.equal(barelyMoved.state, SENSITIVITY_STATE.UNDERPOWERED,
    `a ladder with one token step down reached ${barelyMoved.state}`);
  assert.ok(barelyMoved.codes.includes('GAIN_CONFOUNDED_WITH_FLIGHT_ORDER'));
  assert.ok(barelyMoved.fit.slope.excludesZero,
    'and again the UNCONTROLLED fit is the thing that would have believed it');
  assert.ok(barelyMoved.fit.residualSdDps < barelyMoved.floor.appliedDps,
    'and the residual gate lets it through, which is why the arithmetic is needed');
});

test('the ladder the app itself asks a pilot to fly is swept for false verdicts, with a '
  + 'drift running underneath it', () => {
  // WHY THIS EXISTS BESIDE THE OTHER NULL SWEEP. That one draws the gain
  // independently on every flight, which destroys the correlation between gain
  // and flight order BY CONSTRUCTION and therefore cannot generate the dominant
  // real-world confound at all. Measured: with only the gain ordering changed and
  // a drift added, the same generator took that sweep's own assertion from 1.13%
  // to 21.4%. A sweep that cannot reach the failure it is named for is this
  // repository's most-shipped defect, and it had reached this feature.
  const FLOOR = SENSITIVITY_FLOOR_DPS.yaw;
  let trials = 0;
  let spoke = 0;
  let wrongSign = 0;

  for (let seed = 0; seed < 1500; seed += 1) {
    const random = makeRandom(seed * 104_729 + 13);
    const count = 6 + Math.floor(random() * 15);
    // A drift the record cannot see, in both directions, up to three floors
    // across the whole run — well inside one ordinary flight-to-flight excursion
    // per flight, and far below the corpus's observed single-pair maximum.
    const drift = (random() * 2 - 1) * 3 * FLOOR / count;
    const flights = [];
    for (let index = 0; index < count; index += 1) {
      flights.push({
        // The ladder, in order, exactly as the app's own guidance describes it.
        yawI: 120 + index * 15,
        errorDps: Math.max(0.002, 0.25 + drift * index + gaussian(random) * FLOOR * 0.3),
        headspeedMedianRpm: 2000
      });
    }

    trials += 1;
    const term = yawIterm(flights);
    if (term.state === SENSITIVITY_STATE.USABLE) {
      spoke += 1;
      // The tell that it is the drift talking: the sign always follows the drift.
      if (Math.sign(term.fit.slope.exponent) === Math.sign(drift)) {
        wrongSign += 1;
      }
    }
  }

  const rate = spoke / trials;
  assert.ok(rate <= 0.015,
    `spoke on ${(rate * 100).toFixed(1)}% of ${trials} ordered ladders where the gain did `
    + `nothing and only the calendar moved (${wrongSign} of them signed as the drift)`);
});

test('an improving standing error is refused when the tail hunted harder at the same time', () => {
  // THE CLIFF THE FITTED METRIC CANNOT SEE. Standing hold error under a constant
  // disturbance falls as roughly 1/K all the way to the stability boundary, so
  // the fit is at its cleanest and most confident exactly where the aircraft is
  // about to oscillate. The module's extrapolation rule does not help: it warns
  // about values OUTSIDE the flown span, and this hazard is INSIDE it. The
  // in-band ripple has been on the record all along and was never read.
  //
  // BOTH HALVES IN ONE TEST, again: the veto alone is passed by refusing every
  // improving slope, so the control below is the same fixture with the ripple
  // held flat, and it must still speak.
  // Flown in this order, so the flight-order gate above is not what is being
  // measured here: the gain goes up, down and up again over the eight flights.
  const gains = [44, 60, 30, 50, 34, 60, 38, 56];
  const flown = (rippleFor) => gains.map(yawI => ({
    yawI,
    errorDps: 90 / yawI,
    rippleRmsDps: rippleFor(yawI)
  }));

  const hunting = yawIterm(flown(yawI => 0.2 * 2 ** ((yawI - 30) / 6)));
  assert.equal(hunting.state, SENSITIVITY_STATE.CONTRADICTORY,
    `a rising hunting signature reached ${hunting.state}`);
  assert.ok(hunting.codes.includes('OSCILLATION_ROSE_ACROSS_SPAN'));
  assert.equal(hunting.magnitude, null);
  assert.equal(hunting.fit.direction, 'higher-gain-went-with-less-error',
    'the fixture must be one the standing-error fit calls an IMPROVEMENT');
  assert.match(hunting.needs.sentence, /hunted harder/);

  // The control is NOT a flat ripple. A flat one leaves the rise at exactly
  // zero, and a veto mutated to fire on any rise above zero would still pass —
  // which would make it refuse every real improvement a real machine ever shows,
  // since ripple always moves a little. So the control rises by 0.15 deg/s,
  // under the two floors (2 x 0.1) the gate is measured against, and must speak.
  const steady = yawIterm(flown(yawI => 0.2 + 0.15 * (yawI - 30) / 30));
  assert.equal(steady.state, SENSITIVITY_STATE.USABLE,
    `the identical improvement with a ripple that only wandered reached ${steady.state}; `
    + 'a veto that fires on every improving slope is a veto that means nothing');

  // And the asymmetry is deliberate: rising ripple WITH rising error is not a
  // contradiction, it is two measurements agreeing that the higher gain is worse.
  const agreeing = yawIterm(gains.map(yawI => ({
    yawI,
    errorDps: yawI / 30,
    rippleRmsDps: 0.2 * 2 ** ((yawI - 30) / 6)
  })));
  assert.ok(!agreeing.codes.includes('OSCILLATION_ROSE_ACROSS_SPAN'),
    'two measurements that agree are not a contradiction');
});

test('five clean flights on a strong slope are not enough, and six are', () => {
  // THE TRAP THIS AVOIDS: a one-point fixture passes "refuses with too few
  // points" even with the gate deleted, because a one-point regression is
  // degenerate for an unrelated reason. So the fixture carries exactly one
  // fewer than the minimum, on a slope so clean that the ONLY thing withholding
  // the verdict is the count — and then shows the verdict arriving with the
  // sixth flight.
  const clean = [200, 100, 400, 150, 500, 300]
    .map(yawI => ({yawI, errorDps: 50 / yawI}));

  const five = yawIterm(clean.slice(0, 5));
  assert.equal(five.state, SENSITIVITY_STATE.COLLECTING);
  assert.equal(five.pointCount, 5);
  assert.equal(five.fit, null, 'no slope may be reported below the minimum');
  assert.ok(five.codes.includes('NOT_ENOUGH_POINTS_FOR_A_FIT'));
  assert.equal(five.needs.morePointsNeeded, 1);

  const six = yawIterm(clean);
  assert.equal(six.state, SENSITIVITY_STATE.USABLE);
  assert.equal(six.fit.pointCount, 6);
  assert.ok(Math.abs(six.fit.slope.exponent + 1) < 0.01, `exponent ${six.fit.slope.exponent}`);
  assert.equal(six.fit.direction, 'higher-gain-went-with-less-error');
});

test('a wide gain span with a flat measurement is reported as underpowered, by name', () => {
  // THE TRAP THIS AVOIDS: a fixture with identical gains, which exercises
  // `describeGainChanges` and not this at all. The gain here moves by a factor
  // of five; it is the MEASUREMENT that does not.
  const term = yawIterm([200, 100, 400, 150, 500, 300]
    .map((yawI, index) => ({yawI, errorDps: 0.2 + (index % 2) * 0.002})));

  assert.equal(term.state, SENSITIVITY_STATE.UNDERPOWERED);
  assert.ok(term.codes.includes('GAIN_SPAN_BELOW_NOISE_FLOOR'));
  assert.equal(term.magnitude, null);
  assert.ok(term.fit.predictedSpanEffectDps < term.floor.appliedDps);
});

test('a real effect smaller than the floor says a bigger step is needed, and how big', () => {
  // The state the design would most easily omit, and the one that matters most:
  // this experiment cannot resolve anything and repeating it never will. The
  // expected result is `underpowered` BY NAME — writing `collecting` here would
  // be stating the limitation as the expectation.
  const gains = [100, 150, 200, 250, 300, 400];
  const term = yawIterm(gains.map(yawI => ({yawI, errorDps: 5 / yawI})));

  assert.equal(term.state, SENSITIVITY_STATE.UNDERPOWERED);
  assert.ok(term.codes.includes('GAIN_SPAN_BELOW_NOISE_FLOOR'));

  const largestStep = Math.max(...gains.slice(1).map((gain, index) => gain - gains[index]));
  assert.ok(term.needs.minimumGainStepForResolution > largestStep,
    `it asked for ${term.needs.minimumGainStepForResolution} against a largest flown step of `
    + `${largestStep}; if it is not strictly bigger the advice is to do what was just done`);
  assert.ok(term.needs.sentence.includes('will not fix it'),
    term.needs.sentence);
});

test('points that disagree about the sign are refused loudly, not averaged', () => {
  // Two clean halves pointing opposite ways. Averaging them produces a
  // confident-looking line through the middle of a V, which is the single most
  // misleading output available here.
  const term = yawIterm([
    {yawI: 100, errorDps: 0.02},
    {yawI: 110, errorDps: 0.0242},
    {yawI: 120, errorDps: 0.0288},
    {yawI: 300, errorDps: 0.09},
    {yawI: 330, errorDps: 0.0744},
    {yawI: 360, errorDps: 0.0625}
  ]);

  assert.equal(term.state, SENSITIVITY_STATE.CONTRADICTORY);
  assert.ok(term.codes.includes('SIGN_FLIPS_ACROSS_SPAN'));
  assert.equal(term.magnitude, null);
  assert.equal(term.pointCount, 6, 'the contradictory points stay listed');
});

test('scatter wider than the aircraft\'s own floor is a contradiction, not a slope', () => {
  const term = yawIterm([
    {yawI: 100, errorDps: 0.5},
    {yawI: 150, errorDps: 1.6},
    {yawI: 200, errorDps: 0.3},
    {yawI: 250, errorDps: 1.4},
    {yawI: 300, errorDps: 0.2},
    {yawI: 400, errorDps: 1.1}
  ]);

  assert.equal(term.state, SENSITIVITY_STATE.CONTRADICTORY);
  assert.ok(term.codes.includes('RESIDUAL_SCATTER_ABOVE_FLOOR'));
  assert.ok(term.needs.sentence.includes('disagree'), term.needs.sentence);
});

test('D can never be concluded from hold error, and says so rather than collecting', () => {
  // Twenty clean, well-separated points — the same numbers that make I usable —
  // and D must still refuse, because D acts on the rate of change of error and
  // during a hold there is none. Silently collecting points that can never
  // conclude is the same lie told slowly.
  // Flown so the gain moves both ways over the twenty flights rather than
  // climbing with the calendar: a monotone ladder is refused for a DIFFERENT
  // reason, and this test must fail only for the reason in its title.
  const levels = [];
  for (let index = 0; index < 20; index += 1) {
    levels.push(100 + (index % 2 === 0 ? index : 19 - index) * 20);
  }

  const asD = findSensitivityTerm(
    buildSensitivityModel(
      sensitivityHistory(levels.map(value => ({yawD: value, errorDps: 50 / value}))),
      SENSITIVITY_KEY
    ),
    'yaw',
    'D'
  );
  assert.equal(asD.state, SENSITIVITY_STATE.UNDERPOWERED);
  assert.ok(asD.codes.includes('RESPONSE_METRIC_NOT_SENSITIVE_TO_TERM'));
  assert.equal(asD.fit, null);
  assert.ok(asD.needs.sentence.includes('not more flying'), asD.needs.sentence);
  assert.equal(asD.needs.morePointsNeeded, null,
    'asking for more flights would be advice that cannot work');

  // The same twenty numbers on the I term DO conclude, which is what proves the
  // refusal above is about the term and not about the fixture.
  const asI = yawIterm(levels.map(value => ({yawI: value, errorDps: 50 / value})));
  assert.equal(asI.state, SENSITIVITY_STATE.USABLE);
});

test('forgetting one flight un-learns what it taught, in the same test that '
  + 'watched it learn', () => {
  // THE TRAP THIS AVOIDS: asserting "not usable after the delete" passes
  // trivially when the term was never usable. Both halves are asserted here, on
  // one fixture, so the assertion cannot survive a `forgetFlight` that does
  // nothing or a model that caches.
  const history = sensitivityHistory(
    [200, 100, 400, 150, 500, 300].map(yawI => ({yawI, errorDps: 50 / yawI}))
  );

  const learned = findSensitivityTerm(buildSensitivityModel(history, SENSITIVITY_KEY), 'yaw', 'I');
  assert.equal(learned.state, SENSITIVITY_STATE.USABLE);
  assert.equal(learned.pointCount, 6);

  const forgotten = forgetFlight(history, history.records[2].recordId);
  const after = findSensitivityTerm(
    buildSensitivityModel(forgotten, SENSITIVITY_KEY), 'yaw', 'I'
  );
  assert.notEqual(after.state, SENSITIVITY_STATE.USABLE);
  assert.equal(after.state, SENSITIVITY_STATE.COLLECTING);
  assert.equal(after.pointCount, 5);
  assert.equal(after.fit, null);
  assert.ok(!after.points.some(point => point.recordId === history.records[2].recordId),
    'the deleted flight is still a point');

  // And the original history still says what it said, so the answer is a
  // function of the history handed in and of nothing else.
  assert.equal(
    findSensitivityTerm(buildSensitivityModel(history, SENSITIVITY_KEY), 'yaw', 'I').state,
    SENSITIVITY_STATE.USABLE
  );
  assert.equal(
    findSensitivityTerm(buildSensitivityModel(forgetEverything(), SENSITIVITY_KEY), 'yaw', 'I')
      .state,
    SENSITIVITY_STATE.NO_EVIDENCE
  );
});

test('a noisy aircraft loosens its own floor early; a quiet one tightens it late', () => {
  // THE TRAP THIS AVOIDS: asserting the applied floor EQUALS the corpus figure,
  // which passes with the entire own-floor computation deleted. Both directions
  // are asserted as STRICT inequalities against the corpus number.
  const corpus = SENSITIVITY_FLOOR_DPS.yaw;

  const noisy = buildSensitivityModel(sensitivityHistory([
    {errorDps: 0.2}, {errorDps: 0.9}, {errorDps: 0.3}, {errorDps: 1.0}
  ]), SENSITIVITY_KEY).floors.yaw;
  assert.equal(noisy.source, 'own-aircraft');
  assert.equal(noisy.reason, 'OWN_AIRCRAFT_IS_NOISIER');
  assert.ok(noisy.appliedDps > corpus, `applied ${noisy.appliedDps} against corpus ${corpus}`);

  const quiet = buildSensitivityModel(sensitivityHistory(
    Array.from({length: 10}, (unused, index) => ({errorDps: 0.2 + (index % 3) * 0.004}))
  ), SENSITIVITY_KEY).floors.yaw;
  assert.equal(quiet.source, 'own-aircraft');
  assert.equal(quiet.reason, 'OWN_AIRCRAFT_IS_QUIETER');
  assert.ok(quiet.nullPairCount >= SENSITIVITY_LIMITS.tightenFloorAtNullPairs);
  assert.ok(quiet.appliedDps < corpus, `applied ${quiet.appliedDps} against corpus ${corpus}`);
  assert.ok(quiet.appliedDps >= corpus * SENSITIVITY_LIMITS.minimumLearnedFloorRatio,
    'a learned floor must not fall below half the corpus figure however quiet the day was');

  // Three flights is not enough to TIGHTEN, only to loosen. Asymmetric on
  // purpose: loosening only ever refuses more.
  const early = buildSensitivityModel(sensitivityHistory([
    {errorDps: 0.2}, {errorDps: 0.201}, {errorDps: 0.202}
  ]), SENSITIVITY_KEY).floors.yaw;
  assert.equal(early.source, 'corpus');
  assert.equal(early.appliedDps, corpus);
});

test('the learned floor gets its own sentence, pinned separately from the default', () => {
  // THE TRAP THIS AVOIDS: the existing `describeNoiseFloor` test keeps passing
  // on the no-argument call whatever the learned sentence says, so the learned
  // numbers could drift out of the learned words with every test still green.
  // That is the defect `describeNoiseFloor` was itself written to prevent.
  const learned = buildSensitivityModel(sensitivityHistory(
    Array.from({length: 10}, (unused, index) => ({errorDps: 0.2 + (index % 3) * 0.004}))
  ), SENSITIVITY_KEY).floors.yaw;

  const sentence = describeNoiseFloor(learned).sentence;
  assert.notEqual(sentence, describeNoiseFloor().sentence);
  assert.equal(describeNoiseFloor(learned).source, 'own-aircraft');
  assert.equal(describeNoiseFloor(learned).absoluteDps, learned.appliedDps);
  assert.ok(sentence.includes(String(learned.appliedDps)),
    'the learned sentence must carry the number that is actually being applied');
  assert.ok(sentence.includes(String(learned.observedMaxDps)),
    'and the worst case beside it, which is the correction the default sentence needed');
  assert.ok(sentence.includes(String(learned.nullPairCount)));

  // A floor that has not been learned must not borrow the learned wording.
  assert.equal(
    describeNoiseFloor(buildSensitivityModel(createHistory(), SENSITIVITY_KEY).floors.yaw)
      .sentence,
    describeNoiseFloor().sentence
  );
});

test('flights under a different profile are a separate group, not more points', () => {
  // The M4Max flips back and forth between two whole gain sets. "Hold
  // everything else constant" sorts them into two groups with no heuristic and
  // no threshold, and both keep accumulating — which is what makes this better
  // than splitting the run at every switch.
  const ladder = [200, 100, 400, 150, 500, 300];
  const flights = [];
  for (const yawI of ladder) {
    flights.push({yawI, errorDps: 50 / yawI});
    flights.push({yawI, errorDps: 50 / yawI, headers: {rollPID: '60,105,0,100,0'}});
  }

  const term = yawIterm(flights);
  assert.equal(term.pointCount, 6,
    'the two profiles were pooled into one twelve-point fit');
  assert.ok(term.groups.filter(group => group.pointCount === 6).length === 2,
    'both profiles must keep accumulating, not one be discarded');
  assert.equal(term.state, SENSITIVITY_STATE.USABLE);

  // And the flights of the other profile are named as such rather than lost.
  assert.equal(term.exclusions.MULTIPLE_GAINS_CHANGED, 6);
});

test('a sensitivity profile is current only while every other gain still matches', () => {
  const learned = [200, 100, 400, 150, 500, 300]
    .map(yawI => ({yawI, errorDps: 50 / yawI}));

  const currentButNewProfile = yawIterm([
    ...learned,
    {
      yawI: 250,
      errorDps: 0.2,
      headers: {rollPID: '60,105,0,100,0'}
    }
  ]);
  assert.equal(currentButNewProfile.state, SENSITIVITY_STATE.COLLECTING,
    'the six-point old profile must not stay usable after another gain changes');
  assert.equal(currentButNewProfile.pointCount, 1);
  assert.equal(currentButNewProfile.groups.filter(group => group.current).length, 1);
  assert.equal(currentButNewProfile.groups.find(group => group.current).pointCount, 1);

  const unreadableCurrentProfile = yawIterm([
    ...learned,
    {
      yawI: 250,
      errorDps: 0.2,
      holdCount: 1,
      headers: {rollPID: '60,105,0,100,0'}
    }
  ]);
  assert.equal(unreadableCurrentProfile.state, SENSITIVITY_STATE.STALE);
  assert.ok(unreadableCurrentProfile.codes.includes('OTHER_GAINS_CHANGED'));
});

test('the latest head-speed band is current even when an older band has more points', () => {
  const oldBand = [200, 100, 400, 150, 500, 300]
    .map(yawI => ({yawI, errorDps: 50 / yawI, headspeedMedianRpm: 1800}));
  const term = yawIterm([
    ...oldBand,
    {yawI: 250, errorDps: 0.2, headspeedMedianRpm: 2200}
  ]);

  assert.equal(term.state, SENSITIVITY_STATE.COLLECTING);
  assert.equal(term.pointCount, 1);
  assert.equal(term.groups.filter(group => group.current).length, 1);
  assert.equal(term.groups.find(group => group.current).headspeedBandRpm, 2200);
  assert.equal(term.groups.find(group => group.current).pointCount, 1,
    'the six-point 1800-rpm history must not masquerade as the current setup');
});

test('partial gain arrays cannot train the aircraft noise floor', () => {
  const valid = sensitivityHistory([
    {errorDps: 0.1},
    {errorDps: 1.0},
    {errorDps: 2.0}
  ]);
  const malformed = {
    ...valid,
    records: valid.records.map(stored => ({
      ...stored,
      gains: {...stored.gains, roll: [52, 105]}
    }))
  };

  const floor = buildSensitivityModel(malformed, SENSITIVITY_KEY).floors.yaw;
  assert.equal(floor.source, 'corpus');
  assert.equal(floor.nullPairCount, 0,
    'two finite values are not a complete all-gains fingerprint');
});

test('sensitivity learning fails closed on missing firmware, rates, or gains', () => {
  const cases = [
    ['FIRMWARE_UNREADABLE', {'Firmware revision': ''}],
    ['RATES_UNREADABLE', {rc_expo: ''}],
    ['GAINS_UNREADABLE', {rollPID: '52,,0,100,0'}]
  ];

  for (const [code, headers] of cases) {
    const term = yawIterm([
      {yawI: 200, errorDps: 0.25, headers},
      {yawI: 100, errorDps: 0.5, headers},
      {yawI: 400, errorDps: 0.125, headers},
      {yawI: 150, errorDps: 0.333, headers},
      {yawI: 500, errorDps: 0.1, headers},
      {yawI: 300, errorDps: 0.167, headers}
    ]);
    assert.equal(term.state, SENSITIVITY_STATE.NO_EVIDENCE, code);
    assert.equal(term.pointCount, 0, code);
    assert.equal(term.exclusions[code], 6, code);
  }
});

test('learning from before a firmware update is kept, labelled, and never pooled', () => {
  // Both real dumps span a firmware update mid-life, which is why firmware is a
  // record field rather than part of the aircraft key. A pilot who updated
  // deserves to know their earlier learning was set aside rather than deleted.
  const flights = [200, 100, 400, 150, 500, 300].map(yawI => ({yawI, errorDps: 50 / yawI}));
  // …then one flight on the new firmware, with too few holds to be a point.
  flights.push({
    yawI: 500,
    errorDps: 0.1,
    holdCount: 1,
    headers: {'Firmware revision': 'Rotorflight 4.6.1 (aaaaaaa) STM32F7X2'}
  });

  const term = yawIterm(flights);
  assert.equal(term.state, SENSITIVITY_STATE.STALE);
  assert.ok(term.codes.includes('FIRMWARE_CHANGED'));
  assert.equal(term.pointCount, 6, 'the stale points are still shown');
  assert.equal(term.fit, null, 'and never fed to the current fit');
  assert.ok(term.needs.sentence.includes('no longer on'), term.needs.sentence);
});

test('a magnitude waits for the aircraft\'s own floor, and never leaves its span', () => {
  // The release conditions, all of them together. The same slope is usable in
  // both halves; what differs is whether the floor it is being judged against
  // was measured on this machine or on somebody else's.
  const ladder = [200, 100, 350, 150, 400, 300].map(yawI => ({yawI, errorDps: 50 / yawI}));

  const strangersFloor = yawIterm(ladder);
  assert.equal(strangersFloor.state, SENSITIVITY_STATE.USABLE);
  assert.equal(strangersFloor.floor.source, 'corpus');
  assert.equal(strangersFloor.magnitude, null,
    'a slope cannot be judged against a floor that was never measured on this aircraft');

  // Ten repeat flights at one value: no experiment, just ordinary flying. They
  // measure this machine's own floor AND join the fit at their own gain level.
  const withOwnFloor = yawIterm([
    ...ladder,
    ...Array.from({length: 10}, (unused, index) => ({
      yawI: 250,
      errorDps: 0.2 + (index % 3) * 0.004
    }))
  ]);

  assert.equal(withOwnFloor.floor.source, 'own-aircraft');
  assert.equal(withOwnFloor.state, SENSITIVITY_STATE.USABLE);
  assert.ok(withOwnFloor.magnitude !== null, 'the magnitude never arrived');

  const magnitude = withOwnFloor.magnitude;
  assert.deepEqual(magnitude.validOverGain, {from: 100, to: 400});
  assert.equal(magnitude.evidenceRecordIds.length, withOwnFloor.pointCount);

  // It is a measurement of the past, not a setting. Nothing here may read as an
  // instruction, and nothing may be quoted outside the gains actually flown.
  assert.ok(magnitude.sentence.includes('not a setting'), magnitude.sentence);
  assert.ok(!/\bset\b|\btry\b|\bincrease\b|\breduce\b/i.test(magnitude.sentence),
    magnitude.sentence);
  assert.ok(magnitude.sentence.includes('100') && magnitude.sentence.includes('400'));

  // And the evidence is deletable: losing one of those flights un-says it.
  const history = sensitivityHistory([
    ...ladder,
    ...Array.from({length: 10}, (unused, index) => ({
      yawI: 250,
      errorDps: 0.2 + (index % 3) * 0.004
    }))
  ]);
  const thinned = history.records
    .slice(6)
    .reduce((carried, stored) => forgetFlight(carried, stored.recordId), history);
  assert.equal(
    findSensitivityTerm(buildSensitivityModel(thinned, SENSITIVITY_KEY), 'yaw', 'I').magnitude,
    null
  );
});

/**
 * Ten repeat flights at one gain, which teach the machine its own floor.
 *
 * `spreadDps` sets how far apart those repeats are, and therefore what the
 * learned floor comes out at — which is the only lever that moves the two
 * STATISTICAL release conditions independently of the slope.
 */
function ownFloorRepeats(spreadDps) {
  return Array.from({length: 10}, (unused, index) => ({
    yawI: 250,
    // 50/250, so the repeats sit ON the slope the other flights trace and add
    // no artificial curvature to the fit they also join.
    errorDps: 50 / 250 + (index % 3) * spreadDps
  }));
}

test('a magnitude is refused when its own interval is too wide to be a magnitude, and the '
  + 'refusal is not a restatement of the constant', () => {
  // THE DEFECT THIS REPLACES, and it is the one this repository ships most: the
  // assertions that named these two conditions read
  //     magnitude.relativeHalfWidth <= SENSITIVITY_LIMITS.maximumRelativeSlopeHalfWidth
  // — both sides move with the constant, so the assertion cannot fail for any
  // value of it. Measured: deleting BOTH gates from buildMagnitude left the file
  // 76/76 green, and so did widening the half-width gate twentyfold. The fixture
  // was 17x clear of it, so nothing was ever near either edge.
  //
  // These two tests instead put the fixture ON the edge and cross it, and assert
  // the OUTCOME (a magnitude, or none) rather than an inequality between two
  // expressions built from the same constant.
  //
  // THE PAIR BELOW IS MATCHED ON EVERYTHING BUT THE DRAW. Same six flights at
  // gains drawn the same way, the same injected noise level, the same ten repeat
  // flights, and therefore the same learned floor of 0.2 deg/s. Both are
  // `usable`, both have their own floor, and both effects are comfortably clear
  // of three floors — so neither of the other two release conditions is what
  // separates them. Only the width of the interval around the slope does. The
  // band was found by sweeping the fixture space rather than guessed at: the
  // reachable range of the relative half-width on histories that pass everything
  // else runs to 0.95, and the magnitude flips off at 0.5 exactly.
  const build = (seed, noise, spread) => {
    const random = makeRandom(seed * 7919 + 6 * 31 + Math.round(noise * 1000));
    const gains = [];
    for (let index = 0; index < 6; index += 1) {
      gains.push(100 + Math.round(random() * 300));
    }
    return yawIterm([
      ...gains.map(yawI => ({
        yawI,
        errorDps: Math.max(0.02, 200 / yawI + gaussian(random) * noise)
      })),
      ...Array.from({length: 10}, (unused, index) => ({
        yawI: 250,
        errorDps: 0.8 + (index % 3) * spread
      }))
    ]);
  };

  const wide = build(3, 0.2, 0.1);
  const tight = build(5, 0.2, 0.1);

  for (const [label, term] of [['wide', wide], ['tight', tight]]) {
    assert.equal(term.state, SENSITIVITY_STATE.USABLE,
      `the ${label} half must still earn a DIRECTION, else this is testing another gate `
      + `(got ${term.state}, codes ${term.codes.join(',')})`);
    assert.equal(term.floor.source, 'own-aircraft',
      `${label}: the floor must be this aircraft's, else the third condition is what refused`);
    assert.ok(term.fit.predictedSpanEffectDps
      >= term.floor.appliedDps * SENSITIVITY_LIMITS.magnitudeFloorMultiple,
      `${label}: the effect must clear the OTHER magnitude condition, or that one is what fired`);
  }
  assert.equal(wide.floor.appliedDps, tight.floor.appliedDps,
    'the two halves must be judged against the same floor');

  const half = fit => Math.abs(fit.slope.interval[1] - fit.slope.interval[0]) / 2
    / Math.abs(fit.slope.exponent);
  assert.ok(half(wide.fit) > half(tight.fit),
    'the two halves must differ in the one quantity this gate reads');

  assert.equal(wide.magnitude, null,
    'an interval more than half the width of its own slope is not a magnitude');
  assert.ok(tight.magnitude !== null,
    'and a narrower one over the same setup must still produce one, or the gate refuses always');
});

test('a magnitude is refused when the effect it would quote is not clear of this '
  + 'aircraft\'s own noise', () => {
  // The other statistical condition, isolated the same way: the SLOPE is held
  // identical and tight in both halves, and only the aircraft's own measured
  // floor moves — up, by making its repeat flights disagree with each other more.
  // A real effect that a bad day could have produced is not an amount, however
  // confidently it was fitted.
  const spanning = [200, 100, 350, 150, 400, 300, 250, 320, 180, 120];
  const slope = spanning.map(yawI => ({yawI, errorDps: 50 / yawI}));

  // The arithmetic, written out so the fixture cannot drift away from it.
  // Span effect: 50/100 − 50/400 = 0.375 deg/s.
  // Ten repeats make 45 pairs whose deltas are {0, s, 2s}; the p90 and the
  // observed maximum are both 2s.
  //   s = 0.01 → floor tightens to max(0.02, half the corpus 0.1) = 0.05.
  //              Three floors = 0.15, under 0.375: an amount is quotable.
  //   s = 0.075 → 2s = 0.15 exceeds the corpus figure, so the floor LOOSENS to
  //              0.15. Two floors = 0.30, still under 0.375, so the direction
  //              survives; three floors = 0.45 is above it, so the amount does not.
  const quiet = yawIterm([...slope, ...ownFloorRepeats(0.01)]);
  const noisy = yawIterm([...slope, ...ownFloorRepeats(0.075)]);

  for (const [label, term] of [['quiet', quiet], ['noisy', noisy]]) {
    assert.equal(term.state, SENSITIVITY_STATE.USABLE,
      `the ${label} half must earn a direction, else the wrong gate is being tested `
      + `(got ${term.state}, codes ${term.codes.join(',')})`);
    assert.equal(term.floor.source, 'own-aircraft', `${label}: floor not learned`);
  }
  assert.ok(noisy.floor.appliedDps > quiet.floor.appliedDps,
    'the two halves must actually differ in the learned floor');

  assert.ok(quiet.magnitude !== null, 'a clear effect on a quiet machine must be quotable');
  assert.equal(noisy.magnitude, null,
    'the same effect on a machine whose own repeat flights differ by nearly as much is not');
});

test('nothing in the model is shaped like something to write to a flight controller', () => {
  const model = buildSensitivityModel(sensitivityHistory(
    [200, 100, 400, 150, 500, 300].map(yawI => ({yawI, errorDps: 50 / yawI}))
  ), SENSITIVITY_KEY);
  const term = findSensitivityTerm(model, 'yaw', 'I');

  assert.equal(term.state, SENSITIVITY_STATE.USABLE);
  // A direction and a span of gains already flown. No recommended value, no
  // prediction beyond the span, and no function that could make one.
  assert.ok(['higher-gain-went-with-less-error', 'higher-gain-went-with-more-error']
    .includes(term.fit.direction));
  assert.deepEqual(term.fit.spanOfGain, {from: 100, to: 500});
  assert.ok(!('recommendedGain' in term.fit) && !('predictedGain' in term.fit));
  assert.equal(typeof term.fit.predictAt, 'undefined',
    'the fit must not carry a callable that can be asked about an unflown gain');

  // And the slope cannot be picked up on its own. A caller reaching the exponent
  // has to reach through the object that carries the interval it only means
  // anything inside — a slope used without its uncertainty is the whole failure.
  assert.equal(term.fit.exponent, undefined, 'a bare exponent is readable alone');
  assert.equal(term.fit.exponentInterval, undefined);
  assert.equal(typeof term.fit.slope.exponent, 'number');
  assert.equal(term.fit.slope.interval.length, 2);
  assert.ok(term.fit.slope.interval[0] < term.fit.slope.exponent
    && term.fit.slope.exponent < term.fit.slope.interval[1]);
  assert.equal(term.fit.slope.confidence, 0.95);
});

test('the model survives a real header and concludes nothing from it',
  {skip: !REAL_LOG && 'set ROTORLENS_REAL_LOG to a .bbl path to run this'}, async () => {
    // The synthetic fixtures above all carry a full, well-formed record. A real
    // header does not: gains can be unreadable, rates can be missing, an axis can
    // have no head speed at all. This runs the model over records built from real
    // headers — which carry no hold evidence, because the caller has not measured
    // any — and requires it to say so rather than to throw or to guess.
    const {readFile} = await import('node:fs/promises');
    const {parseSessions} = await import('../src/blackbox/headers.mjs');

    const sessions = parseSessions(new Uint8Array(await readFile(REAL_LOG)));
    let history = createHistory();
    for (const parsed of sessions) {
      history = addFlightRecord(
        history,
        buildFlightRecord({session: parsed, window: airborneWindow()})
      );
    }
    assert.ok(history.records.length > 0, 'no real session produced a record');

    for (const {aircraftKey} of listAircraft(history)) {
      const model = buildSensitivityModel(history, aircraftKey);
      assert.equal(model.flightCount, findRecords(history, aircraftKey).length);

      for (const term of model.terms) {
        assert.notEqual(term.state, SENSITIVITY_STATE.USABLE,
          `${term.axis} ${term.term} concluded something from headers alone`);
        assert.equal(term.magnitude, null);
        // Silence with a reason, never bare silence.
        assert.ok(term.codes.length > 0, `${term.axis} ${term.term} refused without saying why`);
        assert.ok(term.needs.sentence.length > 0);
        assert.equal(
          Object.values(term.exclusions).reduce((sum, count) => sum + count, 0),
          model.flightCount
        );
      }

      // And with no hold evidence there are no null pairs, so the floor stays the
      // corpus one rather than being learned from nothing.
      for (const axis of ['roll', 'pitch', 'yaw']) {
        assert.equal(model.floors[axis].source, 'corpus');
        assert.equal(model.floors[axis].nullPairCount, 0);
        assert.equal(model.floors[axis].appliedDps, SENSITIVITY_FLOOR_DPS[axis]);
      }
    }
  });

// ---------------------------------------------------------------------------
// The shared projection, and the identity that replaces the name
//
// NOTHING HERE SENDS ANYTHING. The app requests neither INTERNET nor a sensitive
// platform permission; AndroidX may add an app-local signature permission to
// the merged manifest. `test/provenance.test.mjs` pins the relevant boundary to
// the Android manifest. These tests are about the SHAPE — see
// `docs/SHARED_CORPUS_DESIGN.md` sections 2 and 4a.
//
// THE FAILURE THEY EXIST TO REACH is a field added to the projection later. A
// test that lists the fields it already knows about cannot catch that, which is
// why the assertions below are (a) a string search over the serialised output
// for a name that came out of a real log, and (b) an audit that goes red for a
// field it has never heard of, whatever that field contains.
// ---------------------------------------------------------------------------

/** A stored record, with its ordinal and recordId assigned, plus a real id. */
function sharedFixture(options = {}) {
  const history = addFlightRecord(createHistory(), record(options));
  const stored = history.records[0];
  const sharingId = newSharingId();
  return {stored, sharingId, shared: shareableRecord(stored, sharingId)};
}

test('the shared allowlist is the record allowlist minus exactly the name, the key and the id', () => {
  // Stated as a set difference rather than as a list, so adding a field to
  // RECORD_FIELDS without deciding whether it may be shared fails here rather
  // than being shared by default.
  const local = Object.keys(RECORD_FIELDS);
  const sharedNames = Object.keys(SHARED_RECORD_FIELDS);

  assert.deepEqual(
    local.filter(name => !sharedNames.includes(name)).sort(),
    ['aircraftKey', 'craftName', 'recordId'],
    'the shared shape must drop the name, the key and the id — and nothing else'
  );
  assert.deepEqual(
    sharedNames.filter(name => !local.includes(name)).sort(),
    ['sharingId'],
    'the only field sharing adds is the opaque identity'
  );

  for (const [path, reason] of Object.entries(SHARED_RECORD_FIELDS)) {
    assert.equal(typeof reason, 'string', `${path} has no reason`);
    assert.ok(reason.length > 30, `${path}'s reason is too short to be one: "${reason}"`);
  }
  assert.ok(NEVER_SHARED.length >= 4, 'the never-share list must survive tidying');
  for (const entry of NEVER_SHARED) {
    assert.ok(entry.what.length > 0 && entry.why.length > 30, JSON.stringify(entry));
  }
});

test('the projection keeps every measurement, so a clean name search proves something', () => {
  // A projection that dropped everything would pass every privacy assertion
  // below and be useless. The corpus is wanted for these numbers; check they
  // survive before checking what does not.
  const {stored, shared} = sharedFixture();

  assert.deepEqual(shared.gains, stored.gains);
  assert.deepEqual(shared.axes, JSON.parse(JSON.stringify(stored.axes)));
  assert.equal(shared.durationSeconds, stored.durationSeconds);
  assert.equal(shared.windowBasis, stored.windowBasis);
  assert.equal(shared.ordinal, stored.ordinal);
  assert.equal(shared.board, stored.board);
  assert.equal(shared.firmwareRevision, stored.firmwareRevision);
  assert.equal(shared.ratesFingerprint, stored.ratesFingerprint);
  assert.equal(shared.axes.yaw.hold.meanAbsoluteSteadyStateErrorDps, 1);
  assert.equal(shared.axes.yaw.headspeedMedianRpm, 2000);
});

test('the sharing id is random, opaque, and cannot have been derived from the name', () => {
  const first = newSharingId();
  assert.ok(isSharingId(first), first);

  // The structural half of "not derived from craftName": this function has
  // arity zero, so it cannot see the name, the key, or anything the pilot
  // typed. A hash of the craft name would look exactly as opaque as this and
  // would carry the name back in disguised form — anyone with a list of likely
  // names could hash each one and recover the mapping.
  assert.equal(newSharingId.length, 0,
    'newSharingId must take no arguments, or it could be handed the craft name');

  // And the behavioural half, because the check above is weaker than it looks:
  // `function newSharingId(craftName = '')` also has arity zero, and mutation
  // proved that version passes. So hand it the craft name anyway — a derived
  // id, hashed or salted or truncated, would repeat for the same input, and a
  // random one cannot.
  const handedTheName = new Set();
  for (let index = 0; index < 200; index += 1) {
    handedTheName.add(newSharingId('bell 222ut'));
  }
  assert.equal(handedTheName.size, 200,
    'the id repeated when the craft name was handed to it, so it is derived from it');

  // The empirical half: the same aircraft asked twice gets two different ids,
  // so nothing about the aircraft is feeding them.
  const ids = new Set();
  for (let index = 0; index < 2000; index += 1) {
    const id = newSharingId();
    assert.ok(isSharingId(id), id);
    ids.add(id);
  }
  assert.equal(ids.size, 2000, 'sharing ids collided, so they are not 100 random bits');
});

test('the sharing id samples its alphabet evenly, so it is as large as it looks', () => {
  // Reaches a specific defect: five bits are taken by masking, which is uniform
  // only because 256 is a whole multiple of 32. A modulo of a non-multiple —
  // the obvious way to write this with a longer alphabet — would over-produce
  // the early symbols and quietly shrink the id. 5,000 ids is 100,000 symbols,
  // 3,125 expected each, so a standard deviation of about 55.
  const counts = new Map();
  const sampleCount = 5000;
  for (let index = 0; index < sampleCount; index += 1) {
    for (const symbol of newSharingId().replace(/-/g, '')) {
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    }
  }

  assert.equal(counts.size, 32, `the alphabet is 32 symbols; ${counts.size} were produced`);
  for (const forbidden of ['i', 'l', 'o', 'u']) {
    assert.ok(!counts.has(forbidden),
      `"${forbidden}" is transcribed wrong by hand and must not appear`);
  }
  const expected = (sampleCount * 20) / 32;
  for (const [symbol, count] of counts) {
    assert.ok(Math.abs(count - expected) < expected * 0.16,
      `"${symbol}" appeared ${count} times against ${expected} expected; the sampling is biased`);
  }
});

test('a record with no well-formed sharing id is refused rather than shared unattributable', () => {
  const history = addFlightRecord(createHistory(), record());
  const stored = history.records[0];

  for (const bad of [undefined, null, '', 'bell-222ut', 'IIIII-IIIII-IIIII-IIIII', 42]) {
    const shared = shareableRecord(stored, bad);
    assert.equal(shared.sharingId, null, `${JSON.stringify(bad)} must not become an id`);

    const audit = auditShareableRecord(shared, stored);
    assert.equal(audit.ok, false);
    assert.ok(
      audit.violations.some(violation => violation.path === 'sharingId'
        && violation.reason.includes('deleted')),
      'a record nobody can delete must not be shareable'
    );
  }

  // And a well-formed one passes, so the check above is a gate rather than a
  // wall that refuses everything.
  assert.deepEqual(auditShareableRecord(shareableRecord(stored, newSharingId()), stored).violations,
    []);
});

test('a shared record cannot be stored as a local one, in either direction', () => {
  // The two shapes are not interchangeable: the shared one has no aircraftKey,
  // and `addFlightRecord` admits anything whose key is not literally null — so
  // a shared record wearing the local kind would be stored as an aircraft that
  // can never be named, found or forgotten.
  const {shared, stored} = sharedFixture();
  assert.notEqual(shared.kind, FLIGHT_RECORD_KIND);
  assert.equal(shared.kind, SHARED_RECORD_KIND);

  const history = addFlightRecord(createHistory(), shared);
  assert.equal(history.records.length, 0, 'a shared record was accepted into the local store');

  // And the local record is not a shared one either: audited as shared, the
  // three fields it legitimately carries are violations.
  const audit = auditShareableRecord(stored, stored);
  assert.equal(audit.ok, false);
  for (const forbidden of ['craftName', 'aircraftKey', 'recordId']) {
    assert.ok(audit.violations.some(violation => violation.path === forbidden),
      `${forbidden} passed the shared audit`);
  }
});

test('the shared audit catches a field ADDED to the projection, not merely a value', () => {
  // THE POINT OF THIS TEST. Each candidate is a plausible future "while we are
  // here" addition, and the last two are the ones that matter: fields with
  // nothing wrong in them at all, caught purely for not having been decided on.
  // An audit that only knew the fields it already had could not catch those,
  // and would be indistinguishable from this one until the day it mattered.
  const {stored, shared} = sharedFixture();

  const candidates = {
    withName: {...shared, craftName: stored.craftName},
    withKey: {...shared, aircraftKey: stored.aircraftKey},
    withRecordId: {...shared, recordId: stored.recordId},
    withClock: {...shared, capturedAt: '2026-08-13T09:00:00.000+00:00'},
    withPath: {...shared, sourceFile: 'C:\\Users\\pilot\\Downloads\\flight.bbl'},
    withTrace: {...shared, gyroTrace: Array.from({length: 4096}, (unused, index) => index)},
    withHarmlessNumber: {...shared, headspeedTargetRpm: 2100},
    withNestedField: {
      ...shared,
      axes: {...shared.axes, roll: {...shared.axes.roll, pilotNote: 'felt twitchy'}}
    }
  };

  for (const [name, candidate] of Object.entries(candidates)) {
    const audit = auditShareableRecord(candidate, stored);
    assert.equal(audit.ok, false, `${name} must not pass the shared audit`);
  }

  assert.ok(auditShareableRecord(candidates.withName, stored).violations
    .some(violation => violation.path === 'craftName' && violation.reason.includes('never shared')));
  assert.ok(auditShareableRecord(candidates.withRecordId, stored).violations
    .some(violation => violation.reason.includes('never shared')));
  assert.ok(auditShareableRecord(candidates.withClock, stored).violations
    .some(violation => violation.reason.includes('wall-clock')));
  assert.ok(auditShareableRecord(candidates.withPath, stored).violations
    .some(violation => violation.reason.includes('file path')));
  assert.ok(auditShareableRecord(candidates.withTrace, stored).violations
    .some(violation => violation.reason.includes('raw trace')));

  // The two that carry nothing forbidden are caught by the allowlist alone.
  for (const name of ['withHarmlessNumber', 'withNestedField']) {
    const {violations} = auditShareableRecord(candidates[name], stored);
    assert.ok(violations.some(violation => violation.reason.includes('SHARED_RECORD_FIELDS')),
      `${name} was not caught for being undocumented: ${JSON.stringify(violations)}`);
  }
  assert.deepEqual(
    auditShareableRecord(candidates.withHarmlessNumber, stored).violations
      .map(violation => violation.path),
    ['headspeedTargetRpm'],
    'a plain number in a new field is caught for existing, and for nothing else'
  );
});

test('a name copied into a pass-through field is caught by value, not only by key', () => {
  // `board`, `firmwareRevision`, `ratesFingerprint` and `sharingId` have their
  // CONTENT passed through after a type check — the same weak spot
  // `exportableRecord` documents. A key-only audit passes all of these, because
  // every field name involved is on the allowlist and every value is a string.
  const {stored, shared} = sharedFixture();

  const leaks = {
    nameInRates: {...shared, ratesFingerprint: stored.craftName},
    keyInFirmware: {...shared, firmwareRevision: stored.aircraftKey},
    recordIdInBoard: {...shared, board: stored.recordId},
    nameInsideALongerString: {...shared, ratesFingerprint: `4|5,5,12|${stored.craftName}`},
    nameInDifferentCase: {...shared, board: stored.craftName.toUpperCase()}
  };

  for (const [name, candidate] of Object.entries(leaks)) {
    const audit = auditShareableRecord(candidate, stored);
    assert.equal(audit.ok, false, `${name} passed the shared audit`);
    assert.ok(audit.violations.every(violation => violation.reason.includes('as a value')),
      `${name} was caught by something other than the by-value scan: `
      + JSON.stringify(audit.violations));
  }

  // And the scan does not fire on the record it was projected from unaltered,
  // so it is a check rather than a blanket refusal.
  assert.deepEqual(auditShareableRecord(shared, stored).violations, []);
});

test('the by-value scan does not fire on an enumeration that happens to contain the name', () => {
  // The scan reads pass-through fields, not the enumerations this module writes
  // itself. Without that distinction a helicopter named "Detected" or "Not"
  // would fail its own audit forever, and the honest fix would be to weaken the
  // scan. Both names below are inside `windowBasis` and every hold status.
  for (const craftName of ['detected', 'not']) {
    // Built without evidence on purpose: that is what puts "not-measured" into
    // every status, so the second name really is present in the projection
    // rather than being looked for where it could never be.
    const history = addFlightRecord(createHistory(), buildFlightRecord({
      session: session({headers: {'Craft name': craftName}}),
      window: airborneWindow()
    }));
    const stored = history.records[0];
    const shared = shareableRecord(stored, newSharingId());

    assert.ok(JSON.stringify(shared).toLowerCase().includes(craftName),
      `the fixture must actually contain "${craftName}" somewhere, or this proves nothing`);
    assert.deepEqual(auditShareableRecord(shared, stored).violations, [],
      `an aircraft named "${craftName}" cannot audit its own shared record`);
  }
});

test('hold and stop statuses cannot carry tampered history text into a shared record', () => {
  // Status is deliberately excluded from the by-value name scan because it is
  // an enumeration. That is safe only if the projection writes the enumeration
  // rather than trusting a history object read from disk. Exercise both status
  // fields independently: a name in hold and the name-bearing record id in stop.
  const {stored, sharingId} = sharedFixture();
  const tampered = {
    ...stored,
    axes: {
      ...stored.axes,
      roll: {
        ...stored.axes.roll,
        hold: {...stored.axes.roll.hold, status: stored.craftName},
        stop: {...stored.axes.roll.stop, status: stored.recordId}
      },
      pitch: {
        ...stored.axes.pitch,
        hold: {...stored.axes.pitch.hold, status: 'inconclusive'},
        stop: {...stored.axes.pitch.stop, status: 'inconclusive'}
      }
    }
  };

  const shared = shareableRecord(tampered, sharingId);

  assert.equal(shared.axes.roll.hold.status, 'not-measured');
  assert.equal(shared.axes.roll.stop.status, 'not-measured');
  assert.equal(shared.axes.pitch.hold.status, 'inconclusive');
  assert.equal(shared.axes.pitch.stop.status, 'inconclusive');
  assert.equal(shared.axes.yaw.hold.status, 'captured');
  assert.equal(shared.axes.yaw.stop.status, 'captured');
  assert.ok(!JSON.stringify(shared).toLowerCase().includes(stored.craftName.toLowerCase()),
    'the craft name reached the shared projection through a status');
  assert.ok(!JSON.stringify(shared).toLowerCase().includes(stored.recordId.toLowerCase()),
    'the name-bearing record id reached the shared projection through a status');
  assert.deepEqual(auditShareableRecord(shared, stored).violations, []);
});

test('windowBasis cannot smuggle the name out, because it is pinned to the enumeration', () => {
  // THE COUNTERPART TO THE TEST ABOVE, and the reason that one is allowed to
  // exist. The by-value scan skips `windowBasis` on the grounds that it is an
  // enumeration — but the LOCAL export content-copies it, so the value in a
  // stored record is whatever the history FILE said, not whatever this module
  // wrote. A field skipped because of what it is usually called is exactly the
  // leak a field-by-field review passes over.
  //
  // Driven through exportHistory/importHistory rather than by mutating an object
  // in memory: the question is whether a history file on disk can do this, and a
  // hand-built record would prove only that a hand-built record can.
  const history = addFlightRecord(createHistory(), buildFlightRecord({
    session: session({headers: {'Craft name': 'bell 222ut'}}),
    window: airborneWindow()
  }));

  const genuine = history.records[0].windowBasis;
  assert.ok(Object.values(FlightWindowBasis).includes(genuine),
    'the fixture must start from a real basis, or the swap below proves nothing');

  const text = exportHistory(history);
  assert.ok(text.includes(genuine), 'the basis must actually be in the export');
  const imported = importHistory(text.split(genuine).join('flown by bell 222ut'));

  // Accepted without complaint, which is the premise rather than the defect:
  // importHistory does not police this field, so shareableRecord must.
  const stored = imported.history.records[0];
  assert.equal(stored.windowBasis, 'flown by bell 222ut',
    'the tampered basis must survive import, or the leak is unreachable and this test is theatre');

  const shared = shareableRecord(stored, newSharingId());
  assert.equal(shared.windowBasis, null,
    'a value that is not one of FlightWindowBasis must not be projected at all');
  assert.ok(!JSON.stringify(shared).toLowerCase().includes('bell 222ut'),
    'the craft name reached the shared projection through windowBasis');
  assert.deepEqual(auditShareableRecord(shared, stored).violations, []);

  // And a genuine basis still travels: the pin is a filter, not a deletion.
  assert.equal(shareableRecord(history.records[0], newSharingId()).windowBasis, genuine);
});

test('the projection of a REAL flight carries the craft name nowhere in its text',
  {skip: !REAL_LOG && 'set ROTORLENS_REAL_LOG to a .bbl path to run this'}, async () => {
    // THE TEST THAT MATTERS, and it is made against a real header rather than a
    // fixture: the reference log is a Bell 222UT whose craft name is
    // "bell 222ut" and whose header declares GPS. The assertion is a string
    // search over the serialised projection, NOT a field-by-field inspection —
    // a field inspection knows only the fields it already knows about, and the
    // leak that would actually arrive is `recordId`, which is
    // `${aircraftKey}#${ordinal}` and therefore the craft name inside a value
    // that reads like an opaque handle.
    const {readFile} = await import('node:fs/promises');
    const {parseSessions} = await import('../src/blackbox/headers.mjs');

    const sessions = parseSessions(new Uint8Array(await readFile(REAL_LOG)));
    assert.ok(sessions.length > 0);

    let checked = 0;
    for (const parsed of sessions) {
      const identity = deriveAircraftIdentity(parsed);
      if (!identity.keyable) {
        continue;
      }
      checked += 1;

      const history = addFlightRecord(
        createHistory(),
        buildFlightRecord({session: parsed, window: airborneWindow()})
      );
      const stored = history.records[0];
      const sharingId = newSharingId();
      const shared = shareableRecord(stored, sharingId);
      const text = JSON.stringify(shared).toLowerCase();

      // The local record really does carry all three, or the search below would
      // be looking for something that was never there to find.
      assert.ok(stored.craftName.length > 0, 'the real log has no craft name to leak');
      assert.ok(stored.aircraftKey.includes('::'));
      assert.ok(stored.recordId.includes('#'));
      assert.ok(JSON.stringify(stored).toLowerCase().includes(stored.craftName.toLowerCase()),
        'the local record must contain the name, or this test proves nothing');

      const name = stored.craftName.toLowerCase();
      assert.ok(!text.includes(name), `the craft name "${name}" reached the shared projection`);
      assert.ok(!text.includes(stored.aircraftKey.toLowerCase()),
        'the aircraft key reached the shared projection');
      assert.ok(!text.includes(stored.recordId.toLowerCase()),
        'the record id reached the shared projection, name and all');

      // Word by word too, so a projection that carried half the name — a
      // truncation, a slug, a first token — is caught as well. Words that are
      // legitimately part of the equipment strings are skipped: those are
      // shared on purpose and would be a false alarm rather than a leak.
      const equipment = [stored.board, stored.firmwareRevision, stored.ratesFingerprint]
        .filter(value => typeof value === 'string')
        .join(' ')
        .toLowerCase();
      for (const word of name.split(/\s+/)) {
        if (word.length >= 4 && !equipment.includes(word)) {
          assert.ok(!text.includes(word),
            `"${word}", part of the craft name, reached the shared projection`);
        }
      }

      // Everything the log itself declares about location, by the log's own
      // field names. On the reference Bell that is eight of them, coordinates
      // and home position among them.
      for (const field of parsed.locationFields ?? []) {
        assert.ok(!text.includes(field.toLowerCase()),
          `the declared location field ${field} reached the shared projection`);
      }
      for (const forbidden of ['gps', 'coord', 'latitude', 'longitude', 'satellite', 'altitude']) {
        assert.ok(!text.includes(forbidden), `"${forbidden}" reached the shared projection`);
      }

      // The audit agrees, and the numbers the corpus is wanted for survived.
      assert.deepEqual(auditShareableRecord(shared, stored).violations, []);
      assert.equal(shared.sharingId, sharingId);
      assert.deepEqual(shared.gains, readPilotGains(parsed).gains);
      assert.equal(shared.board, identity.board);
      assert.equal(shared.durationSeconds, stored.durationSeconds);
    }

    assert.ok(checked > 0, 'no real session was keyable, so nothing was actually projected');
  });
