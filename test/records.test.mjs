import assert from 'node:assert/strict';
import test from 'node:test';
import {buildAnalysisRecords, detectStopEvents} from '../src/analysis/records.mjs';
import {buildDirectionalStopEvidence} from '../src/analysis/pid-evidence.mjs';

/** Builds a decoded-session shape with the given field names. */
function session(fieldNames, rows) {
  return {
    index: 0,
    fields: fieldNames.map((name, index) => ({name, index, signed: true, sampleCount: rows.length})),
    samples: rows
  };
}

const FULL_FIELDS = [
  'time',
  'setpoint[0]', 'setpoint[1]', 'setpoint[2]',
  'gyroADC[0]', 'gyroADC[1]', 'gyroADC[2]',
  'axisP[0]', 'axisI[0]', 'axisD[0]',
  'axisP[2]', 'axisI[2]', 'axisD[2]',
  'headspeed', 'rcCommand[3]', 'Vbat'
];

function fullRow(timeUs, {setpoint = [0, 0, 0], gyro = [0, 0, 0]} = {}) {
  return [
    timeUs,
    setpoint[0], setpoint[1], setpoint[2],
    gyro[0], gyro[1], gyro[2],
    10, 20, 5,
    11, 21, 6,
    2000, 50, 250
  ];
}

test('named quantities are resolved from the log field inventory', () => {
  const decoded = session(FULL_FIELDS, [fullRow(0, {setpoint: [100, 0, 0], gyro: [90, 0, 0]})]);
  const {records, usable, missing, resolved} = buildAnalysisRecords(decoded, {axis: 'roll'});

  assert.equal(usable, true);
  assert.deepEqual(missing, []);
  assert.equal(resolved.time, 'time');
  assert.equal(resolved.termI, 'axisI[0]');
  assert.equal(records[0].timeUs, 0);
  assert.deepEqual(records[0].setpoint, [100, 0, 0]);
  assert.deepEqual(records[0].gyro, [90, 0, 0]);
  assert.deepEqual(records[0].terms, [10, 20, 5]);
  assert.equal(records[0].headspeed, 2000);
});

test('the PID terms follow the selected axis', () => {
  const decoded = session(FULL_FIELDS, [fullRow(0)]);

  assert.deepEqual(buildAnalysisRecords(decoded, {axis: 'roll'}).records[0].terms, [10, 20, 5]);
  assert.deepEqual(buildAnalysisRecords(decoded, {axis: 'yaw'}).records[0].terms, [11, 21, 6]);
});

test('a log without the core signals is reported unusable, not silently zeroed', () => {
  const decoded = session(['time', 'headspeed'], [[0, 2000]]);
  const {usable, missing, records} = buildAnalysisRecords(decoded, {axis: 'roll'});

  assert.equal(usable, false);
  assert.deepEqual(records, []);
  assert.ok(missing.includes('gyro[0]'));
  assert.ok(missing.includes('setpoint[0]'));
});

test('a missing optional signal is named but does not block analysis', () => {
  const decoded = session(FULL_FIELDS, [fullRow(0, {gyro: [42, 0, 0]})]);
  const {usable, missing, records} = buildAnalysisRecords(decoded, {axis: 'roll'});

  assert.equal(usable, true);
  assert.ok(!missing.includes('raw[0]'), 'unfiltered gyro is optional');
  assert.equal(records[0].raw[0], 42, 'raw falls back to the filtered signal');
});

// ---------------------------------------------------------------------------
// The unfiltered gyro
//
// `FIELD_MAP.raw` used to end with `debug[n]`. Rotorflight 4.6 writes
// `gyroRAW[0..2]` and no `gyroUnfilt`, so on the reference log that fallback
// resolved the unfiltered gyro to `debug[0..2]` — which on that firmware carries
// governor headspeed, 1710 to 1830. `resolved` then told the caller an
// unfiltered gyro had been found, and `missing` stayed empty. The downstream
// noise metric read 0.231 deg/s instead of 8.772: a noisy airframe reported as
// clean, which is the dangerous direction.
// ---------------------------------------------------------------------------

/** FULL_FIELDS with extra columns appended, and a row builder to match. */
function withExtraFields(extraNames, extraValues) {
  const names = [...FULL_FIELDS, ...extraNames];
  const row = (timeUs, options) => [...fullRow(timeUs, options), ...extraValues];
  return {names, row};
}

test('the unfiltered gyro prefers a real gyro field over anything else present', () => {
  const {names, row} = withExtraFields(
    ['gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]', 'debug[0]', 'debug[1]', 'debug[2]'],
    [101, 102, 103, 1710, 1720, 1730]
  );
  const {records, resolved, missing} = buildAnalysisRecords(
    session(names, [row(0, {gyro: [42, 43, 44]})]), {axis: 'roll'}
  );

  assert.deepEqual(missing, []);
  assert.deepEqual([resolved['raw[0]'], resolved['raw[1]'], resolved['raw[2]']],
    ['gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]']);
  assert.deepEqual(records[0].raw, [101, 102, 103]);
});

test('a debug channel is never accepted as the unfiltered gyro', () => {
  // debug[] carries whatever the active debug_mode selects. These values are the
  // reference log's: a rotor speed in rpm, six times anything the gyro reaches
  // in that flight (peak 272 deg/s) and not a rate at all.
  const {names, row} = withExtraFields(['debug[0]', 'debug[1]', 'debug[2]'], [1710, 1720, 1730]);
  const {records, resolved, missing, usable} = buildAnalysisRecords(
    session(names, [row(0, {gyro: [42, 43, 44]})]), {axis: 'roll'}
  );

  assert.equal(usable, true, 'no unfiltered gyro is not a reason to refuse the log');
  assert.equal(resolved['raw[0]'], undefined, 'nothing was resolved, so nothing may be claimed');
  assert.ok(!missing.includes('raw[0]'), 'the unfiltered gyro stays optional');
  assert.deepEqual(records[0].raw, [42, 43, 44],
    'the documented fallback is the FILTERED gyro, never a debug channel');
  for (const value of records[0].raw) {
    assert.ok(Math.abs(value) < 1000, `${value} is a headspeed, not a rate`);
  }
});

test('the older unfiltered spellings still resolve when no gyroRAW is present', () => {
  for (const spelling of ['gyroUnfilt', 'gyroADCunfilt']) {
    const {names, row} = withExtraFields(
      [`${spelling}[0]`, `${spelling}[1]`, `${spelling}[2]`], [7, 8, 9]
    );
    const {records, resolved} = buildAnalysisRecords(
      session(names, [row(0, {gyro: [42, 43, 44]})]), {axis: 'roll'}
    );

    assert.equal(resolved['raw[0]'], `${spelling}[0]`);
    assert.deepEqual(records[0].raw, [7, 8, 9]);
  }
});

test('a missing headspeed is reported rather than becoming zero', () => {
  const names = FULL_FIELDS.filter(name => name !== 'headspeed');
  const decoded = session(names, [fullRow(0).filter((value, index) => index !== 13)]);
  const {missing, records} = buildAnalysisRecords(decoded, {axis: 'roll'});

  assert.ok(missing.includes('headspeed'));
  assert.ok(Number.isNaN(records[0].headspeed), 'a zero here would fail plausibility invisibly');
});

test('an unknown axis is refused', () => {
  const result = buildAnalysisRecords(session(FULL_FIELDS, [fullRow(0)]), {axis: 'collective'});
  assert.equal(result.usable, false);
  assert.deepEqual(result.missing, ['axis']);
});

// ---------------------------------------------------------------------------
// Stop detection
// ---------------------------------------------------------------------------

/**
 * Synthesizes alternating left/right stops on one axis.
 *
 * The release is a 30 ms linear ramp, not a step. This fixture used to drop the
 * command from 150 deg/s to 0 between two consecutive 1 ms samples — a release
 * rate of 150,000 deg/s, which no stick, servo or radio link produces — and that
 * single unrealistic sample shape was the only one the old detector accepted.
 * 30 ms brackets the two genuine 80 deg/s releases in the reference flight,
 * which cross the band in 36.75 ms and 17.88 ms. `releaseRampMs: 0` restores the
 * old step release; a test below keeps that case covered as a limit, not as the
 * normal case.
 */
function stopFlight({
  axisIndex = 2,
  count = 6,
  peakDps = 150,
  holdMs = 300,
  releaseRampMs = 30,
  quietMs = 1300,
  trackingErrorBySign = {1: 5, [-1]: 5}
} = {}) {
  const records = [];
  const intervalUs = 1000;
  let timeUs = 0;

  const push = (setpointDps, sign) => {
    const setpoint = [0, 0, 0];
    const gyro = [0, 0, 0];
    setpoint[axisIndex] = setpointDps;
    // A constant tracking error on every commanded sample, so the expected
    // tracking RMS is exactly the injected error whatever window is measured.
    gyro[axisIndex] = setpointDps === 0
      ? 0
      : setpointDps - trackingErrorBySign[sign] * Math.sign(setpointDps);
    records.push({
      timeUs,
      setpoint,
      gyro,
      raw: [...gyro],
      terms: [10, 20, 5],
      headspeed: 2000,
      collective: 50,
      vbat: 250
    });
    timeUs += intervalUs;
  };

  for (let event = 0; event < count; event += 1) {
    const sign = event % 2 === 0 ? 1 : -1;
    for (let step = 0; step < holdMs; step += 1) {
      push(peakDps * sign, sign); // sustained command
    }
    for (let step = 1; step <= releaseRampMs; step += 1) {
      push(peakDps * sign * (1 - step / releaseRampMs), sign); // released over a ramp
    }
    for (let step = 0; step < quietMs; step += 1) {
      push(0, sign); // response window, uncommanded
    }
  }
  for (let step = 0; step < 1200; step += 1) {
    push(0, 1); // tail so the last stop has a full response window
  }

  return records;
}

test('stops are detected with the command direction preserved', () => {
  const events = detectStopEvents(stopFlight(), {axis: 'yaw'});

  // Hand-derived: the command holds 150 deg/s for samples 0..299 (1 ms apart),
  // then ramps 150 - 5k at t = (299 + k) ms. The first sample at or below the
  // 20 deg/s stop threshold is k = 26, so the first stop is at 325 ms, and each
  // cycle is 300 + 30 + 1300 = 1630 ms long.
  assert.equal(events.length, 6);
  assert.deepEqual(
    events.map(event => event.stopTimeUs),
    [0, 1, 2, 3, 4, 5].map(cycle => 325_000 + cycle * 1_630_000)
  );
  assert.ok(events.some(event => event.commandSign === 'positive'));
  assert.ok(events.some(event => event.commandSign === 'negative'));
  for (const event of events) {
    // Last sample at or above 80 deg/s is k = 14, i.e. t = 313 ms after the
    // command opened: the hold, with the release excluded.
    assert.equal(event.commandDurationUs, 313_000);
    assert.equal(event.trackingRmsDps, 5, 'the injected tracking error, exactly');
    assert.ok(Number.isFinite(event.commandAmplitudeDps));
  }
});

test('a step release still counts — the old fixture shape is a limit case, not the only case', () => {
  const events = detectStopEvents(stopFlight({releaseRampMs: 0}), {axis: 'yaw'});

  assert.equal(events.length, 6);
  // With no ramp the command holds 0..299 ms and the next sample is already at
  // zero, so the stop is at 300 ms and the cycle is 1600 ms.
  assert.deepEqual(
    events.map(event => event.stopTimeUs),
    [0, 1, 2, 3, 4, 5].map(cycle => 300_000 + cycle * 1_600_000)
  );
  for (const event of events) {
    assert.equal(event.commandDurationUs, 299_000);
  }
});

test('detected stops feed directional evidence end to end', () => {
  // Worse tracking one way than the other: exactly the yaw asymmetry that
  // pooling both directions would have hidden.
  const events = detectStopEvents(
    stopFlight({trackingErrorBySign: {1: 4, [-1]: 20}}),
    {axis: 'yaw'}
  );
  const evidence = buildDirectionalStopEvidence(events, {axis: 'yaw'});

  // The injected errors, recovered exactly: the tracking window now ends where
  // the command leaves its plateau, so no part of the release ramp dilutes them.
  assert.equal(evidence.directions.positive.trackingRmsDps, 4);
  assert.equal(evidence.directions.negative.trackingRmsDps, 20);
  assert.equal(evidence.status, 'captured');
  assert.ok(evidence.directions.positive.trackingRmsDps < evidence.directions.negative.trackingRmsDps);
  assert.ok(evidence.codes.includes('YAW_DIRECTIONAL_ASYMMETRY_DETECTED'));
});

test('stops on an axis that was never commanded are not invented', () => {
  assert.deepEqual(detectStopEvents(stopFlight({axisIndex: 2}), {axis: 'roll'}), []);
});
