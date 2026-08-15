/**
 * The batch corpus tool: what it must never leak, what it must survive, and
 * whether its distributions can actually reach the answers they claim to.
 *
 * TWO DEFECT CLASSES ARE BEING GUARDED AGAINST HERE, and they pull in opposite
 * directions.
 *
 * The first is a shared projection that leaks a field the local record was
 * careful about. `auditFlightRecord` protects the record on the pilot's phone;
 * nothing protected the measurement of somebody else's donated log, which is the
 * artefact that actually gets sent to another person. So the scrub is asserted
 * against craft names read out of generated fixtures at test time, rather than
 * against a list written down here that could drift.
 *
 * The second is a distribution that cannot reach the answer it is named after.
 * The histogram of hold segments exists to find out whether a gate needing 5 can
 * ever open — and a histogram built from the evidence summary silently drops
 * every axis that produced ZERO holds, because the summary is null there. That
 * version of the tool reports a healthier corpus than exists. The zero-hold case
 * is therefore tested directly, with a comment saying so, because it is exactly
 * the kind of hole that looks like nothing.
 */

import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

import {parseSessions} from '../src/blackbox/headers.mjs';
import {EVIDENCE_LIMITS} from '../src/analysis/pid-evidence.mjs';
import {
  AXES, createCorpusScan, auditCorpusMeasurement, CORPUS_FIELDS, NEVER_REPORTED
} from '../tools/corpus/measure.mjs';
import {
  summarizeCorpus, findNullPairs, describeDistribution, auditAll, SHIPPED_FIGURES,
  renderCorpusReport
} from '../tools/corpus/summarize.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const syntheticDir = path.join(projectRoot, 'fixtures', 'synthetic');
const realDir = path.join(projectRoot, 'fixtures', 'real');

async function bytesOf(file) {
  return new Uint8Array(await readFile(file));
}

/** Every committed log, scanned once. */
async function scanEveryFixture() {
  const scan = createCorpusScan();
  const craftNames = new Set();
  const clockStrings = new Set();

  for (const directory of [syntheticDir, realDir]) {
    for (const name of await readdir(directory)) {
      if (!/\.(bbl|txt)$/i.test(name)) {
        continue;
      }
      const bytes = await bytesOf(path.join(directory, name));
      for (const session of parseSessions(bytes)) {
        if (session.craftName) {
          craftNames.add(session.craftName);
        }
        const datetime = session.headers['Log start datetime'];
        if (datetime) {
          clockStrings.add(datetime);
        }
      }
      scan.addLog(bytes, name);
    }
  }

  return {scan, craftNames, clockStrings};
}

// ---------------------------------------------------------------------------
// What must never leave in a report
// ---------------------------------------------------------------------------

test('no measurement carries a craft name from the log it measured', async () => {
  const {scan, craftNames} = await scanEveryFixture();
  assert.ok(craftNames.size >= 5,
    `the fixtures must actually carry craft names for this to test anything; found ${craftNames.size}`);

  const serialized = JSON.stringify(scan.measurements);
  for (const name of craftNames) {
    assert.ok(!serialized.includes(name),
      `craft name ${JSON.stringify(name)} reached the corpus measurements. `
      + 'docs/SHARED_CORPUS_DESIGN.md §2: people name helicopters after themselves');
  }
});

test('no measurement carries the log\'s own start datetime', async () => {
  const {scan, clockStrings} = await scanEveryFixture();
  assert.ok(clockStrings.size >= 1, 'the fixtures must carry a start datetime');

  const serialized = JSON.stringify(scan.measurements);
  for (const clock of clockStrings) {
    assert.ok(!serialized.includes(clock),
      `${clock} reached the measurements; a list of these is a record of when somebody flies`);
  }
});

test('every measurement passes its own audit', async () => {
  const {scan} = await scanEveryFixture();
  assert.ok(scan.measurements.length > 10);

  const audit = auditAll(scan.measurements);
  assert.equal(audit.ok, true, JSON.stringify(audit.violations.slice(0, 4), null, 1));
});

test('the audit catches a craft name added to a measurement', async () => {
  const {scan} = await scanEveryFixture();
  const leaky = {...scan.measurements[0], craftName: 'Mike\'s 700'};

  const audit = auditCorpusMeasurement(leaky);
  assert.equal(audit.ok, false);
  assert.ok(audit.violations.some(violation => violation.path === 'craftName'));
});

test('the audit catches a wall clock hidden in any field', async () => {
  const {scan} = await scanEveryFixture();
  const leaky = {...scan.measurements[0], firmwareRevision: 'RF 4.6.0 2026-08-13T09:14:00'};

  const audit = auditCorpusMeasurement(leaky);
  assert.equal(audit.ok, false);
  assert.ok(audit.violations.some(violation => /wall-clock/.test(violation.reason)));
});

test('the audit refuses a source path and accepts a bare filename', async () => {
  const {scan} = await scanEveryFixture();
  const base = scan.measurements[0];

  for (const bad of ['C:/donations/from-mike/log.bbl', '/home/mike/log.bbl', 'mike/log.bbl']) {
    const audit = auditCorpusMeasurement({...base, sourceFile: bad});
    assert.equal(audit.ok, false, `${bad} must be refused`);
    assert.ok(audit.violations.some(violation => violation.path === 'sourceFile'));
  }

  assert.equal(auditCorpusMeasurement({...base, sourceFile: 'log.bbl'}).ok, true);
});

test('the audit catches a documented field that has gone missing', async () => {
  const {scan} = await scanEveryFixture();
  const thinned = {...scan.measurements[0]};
  delete thinned.admissionCodes;

  const audit = auditCorpusMeasurement(thinned);
  assert.equal(audit.ok, false);
  assert.ok(audit.violations.some(violation => violation.path === 'admissionCodes'
    && /absent/.test(violation.reason)));
});

test('the audit catches a raw trace smuggled in as an array', async () => {
  const {scan} = await scanEveryFixture();
  const leaky = {...scan.measurements[0], admissionCodes: new Array(400).fill('x')};

  const audit = auditCorpusMeasurement(leaky);
  assert.equal(audit.ok, false);
  assert.ok(audit.violations.some(violation => /trace/.test(violation.reason)));
});

test('every never-reported rule names a reason, and every field a why', () => {
  assert.ok(NEVER_REPORTED.length >= 4);
  for (const rule of NEVER_REPORTED) {
    assert.ok(rule.what.length > 10);
    assert.ok(rule.why.length > 40, `${rule.what} needs a reason, not a label`);
  }
  for (const [field, reason] of Object.entries(CORPUS_FIELDS)) {
    assert.ok(reason.length > 30, `${field} needs a reason, not a label`);
  }
});

// ---------------------------------------------------------------------------
// Rubbish input
// ---------------------------------------------------------------------------

test('a directory of rubbish is reported and stepped over, never thrown on', async () => {
  const scan = createCorpusScan();
  const good = await bytesOf(path.join(syntheticDir, 'rf46-stop-manoeuvres.TXT'));
  const random = new Uint8Array(50_000);
  for (let index = 0; index < random.length; index += 1) {
    random[index] = (index * 37 + 11) & 0xff;
  }

  scan.addLog(new Uint8Array(0), 'empty.bbl');
  scan.addLog(new TextEncoder().encode('a README\n'), 'notes.txt');
  scan.addLog(random, 'random.bbl');
  scan.addLog(good.subarray(0, 30_000), 'truncated.bbl');
  scan.addLog(good, 'good.bbl');

  // The good file is still measured. That is the property that matters: a batch
  // tool which aborts on file 3 of 5 reports a corpus half the size it was given
  // and says nothing about it.
  const goodMeasurements = scan.measurements.filter(entry => entry.sourceFile === 'good.bbl');
  assert.equal(goodMeasurements.length, 1);
  assert.equal(goodMeasurements[0].readable, true);
  assert.ok(goodMeasurements[0].sampleCount > 1000);

  const failedFiles = scan.fileFailures.map(failure => failure.sourceFile).sort();
  assert.deepEqual(failedFiles, ['empty.bbl', 'notes.txt', 'random.bbl']);
  for (const failure of scan.fileFailures) {
    assert.equal(failure.code, 'NOT_A_BLACKBOX_LOG');
  }

  // A truncated donation still contributes the samples it did record.
  const truncated = scan.measurements.find(entry => entry.sourceFile === 'truncated.bbl');
  assert.equal(truncated.readable, true);
  assert.ok(truncated.sampleCount > 0);
  assert.equal(truncated.reachedLogEnd, false);
});

test('a corrupt session header costs that session and not the one beside it', async () => {
  const good = await bytesOf(path.join(syntheticDir, 'rf46-gps-declared.TXT'));
  const text = new TextDecoder('latin1').decode(good);
  const brokenText = text.replace(
    /^H Field I encoding:(.*)$/m,
    (whole, list) => `H Field I encoding:${list.split(',').slice(0, -1).join(',')}`
  );
  assert.notEqual(brokenText, text);
  const broken = Uint8Array.from(brokenText, character => character.charCodeAt(0) & 0xff);

  const bytes = new Uint8Array(broken.length + good.length);
  bytes.set(broken, 0);
  bytes.set(good, broken.length);

  const scan = createCorpusScan();
  scan.addLog(bytes, 'mixed.bbl');

  assert.equal(scan.measurements.length, 2);
  assert.equal(scan.measurements[0].readable, false);
  assert.equal(scan.measurements[0].failureStage, 'header');
  assert.ok(scan.measurements[0].failureDetail.length > 0,
    'a donor can act on "your header is malformed" and cannot act on "failed"');
  assert.equal(scan.measurements[1].readable, true,
    'the second session is intact and must still be measured');
  assert.ok(scan.measurements[1].sampleCount > 0);
});

test('fuzzed bytes never throw and never produce an unaudited measurement', () => {
  let state = 0x1234_5678;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state >>> 24;
  };

  const header = new TextEncoder().encode(
    'H Product:Blackbox flight data recorder by Nicholas Sherlock\nH Data version:2\n'
  );

  for (let trial = 0; trial < 300; trial += 1) {
    const tail = new Uint8Array(next() % 2048);
    for (let index = 0; index < tail.length; index += 1) {
      tail[index] = next();
    }
    // Half the trials look enough like a log to get past findSessionStarts, so
    // the fuzz actually reaches the decoder rather than bouncing off the front.
    const bytes = trial % 2 === 0
      ? tail
      : (() => {
        const joined = new Uint8Array(header.length + tail.length);
        joined.set(header, 0);
        joined.set(tail, header.length);
        return joined;
      })();

    const scan = createCorpusScan();
    scan.addLog(bytes, `fuzz-${trial}.bbl`);
    const audit = auditAll(scan.measurements);
    assert.equal(audit.ok, true,
      `trial ${trial}: ${JSON.stringify(audit.violations.slice(0, 2))}`);
    assert.equal(typeof renderCorpusReport(summarizeCorpus(scan.measurements, scan.fileFailures)),
      'string');
  }
});

// ---------------------------------------------------------------------------
// The distributions, over measurements built by hand
//
// The committed fixtures never leave the ground, so the summariser cannot be
// exercised end to end without a real log. Building measurements directly is
// better than waiting for one: it reaches cases a donation would not supply on
// demand, including the adversarial ones.
// ---------------------------------------------------------------------------

let nextOrdinal = 0;

function measurementOf(overrides = {}) {
  const axes = {};
  for (const axis of AXES) {
    axes[axis] = {
      usable: true,
      peakCommandDps: 30,
      peakMeasuredDps: 32,
      headspeedMedianRpm: 1800,
      gyroHighFrequencyRmsDps: 1.2,
      unfilteredHighFrequencyRmsDps: 6.4,
      holdStatus: 'inconclusive',
      holdCount: 1,
      zeroHoldCount: 1,
      sustainedHoldCount: 0,
      meanAbsoluteSteadyStateErrorDps: 0.5,
      worstAbsoluteSteadyStateErrorDps: 0.9,
      ...(overrides.axisDefaults ?? {})
    };
  }
  const {axisDefaults, axisOverrides, ...rest} = overrides;
  for (const [axis, values] of Object.entries(axisOverrides ?? {})) {
    axes[axis] = {...axes[axis], ...values};
  }

  return {
    schemaVersion: 1,
    kind: 'rotorlens-corpus-measurement',
    sourceFile: 'x.bbl',
    sessionIndex: nextOrdinal++,
    readable: true,
    failureStage: null,
    failureCode: null,
    failureDetail: null,
    board: 'BOARD',
    firmwareRevision: 'Rotorflight 4.6.0',
    aircraftGroup: 'aircraft-1',
    sampleCount: 10_000,
    decodeErrorCount: 0,
    reachedLogEnd: true,
    windowBasis: 'detected',
    durationSeconds: 240,
    admissible: true,
    admissionCodes: [],
    ratesFingerprint: 'rates-a',
    gains: {roll: [50, 60, 30], pitch: [50, 60, 30], yaw: [80, 90, 10]},
    ...rest,
    axes
  };
}

test('a measured axis with no hold segments reports 0, never null', async () => {
  // THIS IS THE HALF OF THE ZERO-HOLD BUG THAT LIVES IN THE MEASUREMENT.
  //
  // `buildHoldEvidence` returns `summary: null` when it found no holds at all,
  // so `hold.summary.holdCount` is `undefined` on exactly the axes that produced
  // nothing — and a `?? null` beside it turns those into null. Null is not zero:
  // `summarizeCorpus` skips non-finite counts, so every zero-hold flight-axis
  // silently leaves the histogram. On the reference dumps that is 44 of 93.
  //
  // The sibling test below proves the histogram side. This one proves that the
  // number reaching it is a number, which the sibling cannot see because it
  // builds its measurements by hand.
  const {scan} = await scanEveryFixture();

  let zeros = 0;
  for (const measurement of scan.measurements) {
    if (!measurement.readable) {
      continue;
    }
    for (const axis of AXES) {
      const entry = measurement.axes[axis];
      if (!entry.usable) {
        continue;
      }
      assert.equal(typeof entry.holdCount, 'number',
        `${measurement.sourceFile} #${measurement.sessionIndex} ${axis}: holdCount is `
        + `${entry.holdCount}. A null here drops this axis out of the histogram that `
        + 'exists to say whether the 5-hold gate can ever open');
      if (entry.holdCount === 0) {
        zeros += 1;
      }
    }
  }

  assert.ok(zeros >= 40,
    `only ${zeros} zero-hold axes in the fixtures; this test is not reaching the case it names`);
});

test('zero-hold axes measured from real bytes reach the histogram', async () => {
  // The join between the two halves, asserted rather than assumed. The committed
  // fixtures are bench runs, so they never pass admission — admission is flipped
  // here because the question is whether a zero SURVIVES the trip from
  // measureAxis to the histogram, and that is independent of whether it flew.
  const {scan} = await scanEveryFixture();
  const asFlights = scan.measurements
    .filter(measurement => measurement.readable)
    .map(measurement => ({...measurement, admissible: true, admissionCodes: []}));

  const summary = summarizeCorpus(asFlights);
  const histogram = new Map(summary.holds.histogram);

  const expectedZeros = asFlights.reduce((total, measurement) => total
    + AXES.filter(axis => measurement.axes[axis].holdCount === 0).length, 0);

  assert.ok(expectedZeros >= 40);
  assert.equal(histogram.get(0), expectedZeros,
    'every zero measured from real bytes must be counted in the distribution');
  assert.equal(summary.holds.flightAxes, expectedZeros);
  assert.equal(summary.holds.flightAxesReachingGate, 0);
});

test('a flight-axis that produced ZERO holds appears in the histogram', () => {
  // The failure this pins: `buildHoldEvidence` returns `summary: null` when no
  // hold segments were found, so reading the count off the summary drops every
  // zero-hold axis. On the reference dumps that is 44 of 93 flight-axes — a tool
  // with that bug reports a corpus half as sparse as the real one, in the exact
  // direction that makes a gate needing 5 look reachable.
  const summary = summarizeCorpus([
    measurementOf({axisDefaults: {holdCount: 0, zeroHoldCount: 0, sustainedHoldCount: 0}}),
    measurementOf({axisDefaults: {holdCount: 3}})
  ]);

  const histogram = new Map(summary.holds.histogram);
  assert.equal(histogram.get(0), 3, 'three zero-hold flight-axes must be counted');
  assert.equal(histogram.get(3), 3);
  assert.equal(summary.holds.flightAxes, 6);
  assert.equal(summary.holds.maximumHolds, 3);
});

test('the gate-reaching count uses the shipped minimum and can go both ways', () => {
  const below = summarizeCorpus([
    measurementOf({axisDefaults: {holdCount: EVIDENCE_LIMITS.minimumComparisonHolds - 1}})
  ]);
  assert.equal(below.holds.flightAxesReachingGate, 0);

  const at = summarizeCorpus([
    measurementOf({axisDefaults: {holdCount: EVIDENCE_LIMITS.minimumComparisonHolds}})
  ]);
  assert.equal(at.holds.flightAxesReachingGate, 3,
    'a corpus that DOES reach the gate must be reported as reaching it — a report '
    + 'that can only ever say "not one" is not a measurement');
  assert.match(renderCorpusReport(at), /The gate CAN open on real data/);
  assert.match(renderCorpusReport(below), /NOT ONE/);
});

test('sessions that never flew are excluded from every distribution', () => {
  const summary = summarizeCorpus([
    measurementOf({admissible: true, axisDefaults: {peakCommandDps: 40, holdCount: 2}}),
    measurementOf({
      admissible: false,
      admissionCodes: ['FLIGHT_NEVER_LEFT_THE_GROUND'],
      axisDefaults: {peakCommandDps: 900, holdCount: 99}
    })
  ]);

  assert.equal(summary.counts.flights, 1);
  assert.equal(summary.holds.maximumHolds, 2, 'the bench run must not set the maximum');
  assert.equal(summary.peakCommand.roll.distribution.max, 40);
  assert.deepEqual(summary.admissionTally, [['FLIGHT_NEVER_LEFT_THE_GROUND', 1]]);
});

test('unreadable sessions are counted, not quietly dropped', () => {
  const summary = summarizeCorpus([
    measurementOf(),
    measurementOf({readable: false, failureCode: 'corrupt-header', admissible: false})
  ], [{sourceFile: 'junk.bbl', code: 'NOT_A_BLACKBOX_LOG'}]);

  assert.equal(summary.counts.sessions, 2);
  assert.equal(summary.counts.readable, 1);
  assert.equal(summary.counts.unreadable, 1);
  assert.deepEqual(summary.failureTally.sort(), [
    ['NOT_A_BLACKBOX_LOG', 1], ['corrupt-header', 1]
  ].sort());
});

// ---------------------------------------------------------------------------
// Null pairs, condition by condition
// ---------------------------------------------------------------------------

function pairCount(left, right, axis = 'roll') {
  return findNullPairs([left, right], axis).pairCount;
}

test('two flights with nothing changed are a null pair', () => {
  const a = measurementOf({axisDefaults: {meanAbsoluteSteadyStateErrorDps: 0.40}});
  const b = measurementOf({axisDefaults: {meanAbsoluteSteadyStateErrorDps: 0.55}});

  const result = findNullPairs([a, b], 'roll');
  assert.equal(result.pairCount, 1);
  assert.ok(Math.abs(result.delta.max - 0.15) < 1e-9);
  assert.equal(result.level.n, 2);
});

test('a gain change on ANY axis disqualifies the pair, not just the axis measured', () => {
  // The subtle one. A roll noise floor measured across a pair where only YAW's
  // gains moved is not a null pair: the controller changed. Measuring only the
  // axis under test would silently inflate every floor.
  const a = measurementOf();
  for (const axis of AXES) {
    const changed = {...a.gains, [axis]: [...a.gains[axis].slice(0, -1), 999]};
    const b = measurementOf({gains: changed});
    assert.equal(pairCount(a, b), 0, `a change on ${axis} must disqualify a roll pair`);
  }
  assert.equal(pairCount(a, measurementOf()), 1, 'and an unchanged pair must still count');
});

test('different aircraft, firmware or rates are not a null pair', () => {
  const a = measurementOf();
  assert.equal(pairCount(a, measurementOf({aircraftGroup: 'aircraft-2'})), 0);
  assert.equal(pairCount(a, measurementOf({firmwareRevision: 'Rotorflight 4.6.1'})), 0);
  assert.equal(pairCount(a, measurementOf({ratesFingerprint: 'rates-b'})), 0);
});

test('the headspeed tolerance is the shipped one, and it bites at the edge', () => {
  const tolerance = SHIPPED_FIGURES.maximumHeadspeedVariationRatio;
  const a = measurementOf({axisDefaults: {headspeedMedianRpm: 2000}});

  const inside = 2000 * (1 + tolerance * 0.9);
  const outside = 2000 / (1 - tolerance * 1.5);

  assert.equal(pairCount(a, measurementOf({axisDefaults: {headspeedMedianRpm: inside}})), 1);
  assert.equal(pairCount(a, measurementOf({axisDefaults: {headspeedMedianRpm: outside}})), 0,
    'the same gains at a different headspeed are a different controller');
});

test('a heading hold and a constant-rate turn are not paired with each other', () => {
  const heading = measurementOf({axisDefaults: {zeroHoldCount: 2, sustainedHoldCount: 0}});
  const turning = measurementOf({axisDefaults: {zeroHoldCount: 0, sustainedHoldCount: 2}});
  assert.equal(pairCount(heading, turning), 0);
  assert.equal(pairCount(heading, measurementOf({
    axisDefaults: {zeroHoldCount: 3, sustainedHoldCount: 1}
  })), 1);
});

test('a flight with no measured hold error contributes no pair', () => {
  const a = measurementOf();
  const b = measurementOf({axisDefaults: {meanAbsoluteSteadyStateErrorDps: null}});
  assert.equal(pairCount(a, b), 0);
});

test('a session that never flew is never half of a null pair', () => {
  const a = measurementOf();
  const b = measurementOf({admissible: false, admissionCodes: ['FLIGHT_NEVER_LEFT_THE_GROUND']});
  assert.equal(pairCount(a, b), 0);
});

test('every pair found satisfies an independently written predicate, over random sets', () => {
  // The rule this repository keeps re-learning: an assertion can be right while
  // the inputs never reach the failure. So the conditions are re-stated here in
  // a different shape and swept over thousands of randomised sets, rather than
  // demonstrated on one tidy example.
  let state = 0xdead_beef;
  const next = () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state / 0x1_0000_0000;
  };
  const pick = list => list[Math.floor(next() * list.length)];

  /** The same rules, written from the description rather than from the code. */
  function shouldPair(left, right, axis) {
    if (!left.admissible || !right.admissible) return false;
    if (left.aircraftGroup === null || left.aircraftGroup !== right.aircraftGroup) return false;
    if (left.firmwareRevision !== right.firmwareRevision) return false;
    if (left.ratesFingerprint !== right.ratesFingerprint) return false;
    for (const each of AXES) {
      const one = left.gains[each];
      const other = right.gains[each];
      if (String(one) !== String(other)) return false;
    }
    const a = left.axes[axis];
    const b = right.axes[axis];
    if (!Number.isFinite(a.meanAbsoluteSteadyStateErrorDps)) return false;
    if (!Number.isFinite(b.meanAbsoluteSteadyStateErrorDps)) return false;
    if ((a.zeroHoldCount > 0) !== (b.zeroHoldCount > 0)) return false;
    if (!Number.isFinite(a.headspeedMedianRpm) || !Number.isFinite(b.headspeedMedianRpm)) {
      return false;
    }
    const largest = Math.max(Math.abs(a.headspeedMedianRpm), Math.abs(b.headspeedMedianRpm));
    if (largest === 0) return false;
    const spread = Math.abs(b.headspeedMedianRpm - a.headspeedMedianRpm) / largest;
    return spread <= SHIPPED_FIGURES.maximumHeadspeedVariationRatio;
  }

  let sawPairs = 0;
  let sawRejections = 0;

  // ONE DIMENSION IS PERTURBED AT A TIME, deliberately. The first version of
  // this sweep randomised eight fields independently, so almost every candidate
  // pair failed on something and 400 trials produced SIX pairs — a test that
  // would have agreed with a `findNullPairs` that returned nothing at all. The
  // coverage assertions at the bottom are what caught it, and they stay.
  for (let trial = 0; trial < 400; trial += 1) {
    const set = [];
    const size = 2 + Math.floor(next() * 5);

    for (let index = 0; index < size; index += 1) {
      const base = {
        admissible: true,
        aircraftGroup: 'aircraft-1',
        firmwareRevision: '4.6.0',
        ratesFingerprint: 'rates-a',
        gains: {roll: [50, 60, 30], pitch: [50, 60, 30], yaw: [80, 90, 10]},
        axisDefaults: {
          headspeedMedianRpm: 1800,
          zeroHoldCount: 1,
          meanAbsoluteSteadyStateErrorDps: Math.round(next() * 200) / 100
        }
      };

      // Half the flights are unperturbed, so pairs actually form; the other half
      // breaks exactly one condition, so each rejection reason is reached alone
      // rather than being masked by three others failing at the same time.
      if (next() < 0.5) {
        const dimension = pick([
          'admissible', 'aircraft', 'firmware', 'rates',
          'gain-roll', 'gain-pitch', 'gain-yaw',
          'headspeed-near', 'headspeed-far', 'hold-kind', 'no-error', 'no-headspeed'
        ]);
        if (dimension === 'admissible') base.admissible = false;
        if (dimension === 'aircraft') base.aircraftGroup = pick(['aircraft-2', null]);
        if (dimension === 'firmware') base.firmwareRevision = '4.6.1';
        if (dimension === 'rates') base.ratesFingerprint = 'rates-b';
        if (dimension === 'gain-roll') base.gains = {...base.gains, roll: [50, 60, 31]};
        if (dimension === 'gain-pitch') base.gains = {...base.gains, pitch: [50, 60, 32]};
        if (dimension === 'gain-yaw') base.gains = {...base.gains, yaw: [80, 90, 11]};
        if (dimension === 'headspeed-near') base.axisDefaults.headspeedMedianRpm = 1860;
        if (dimension === 'headspeed-far') base.axisDefaults.headspeedMedianRpm = 2400;
        if (dimension === 'hold-kind') base.axisDefaults.zeroHoldCount = 0;
        if (dimension === 'no-error') base.axisDefaults.meanAbsoluteSteadyStateErrorDps = null;
        if (dimension === 'no-headspeed') base.axisDefaults.headspeedMedianRpm = null;
      }

      set.push(measurementOf(base));
    }

    for (const axis of AXES) {
      const found = findNullPairs(set, axis);
      const expected = [];
      for (let i = 0; i < set.length; i += 1) {
        for (let j = i + 1; j < set.length; j += 1) {
          if (shouldPair(set[i], set[j], axis)) {
            expected.push(Math.abs(
              set[j].axes[axis].meanAbsoluteSteadyStateErrorDps
              - set[i].axes[axis].meanAbsoluteSteadyStateErrorDps
            ));
          }
        }
      }

      assert.equal(found.pairCount, expected.length,
        `trial ${trial} ${axis}: found ${found.pairCount}, predicate says ${expected.length}`);
      assert.deepEqual(
        found.pairs.map(pair => pair.deltaDps).sort((x, y) => x - y),
        expected.sort((x, y) => x - y)
      );

      sawPairs += expected.length;
      sawRejections += (set.length * (set.length - 1)) / 2 - expected.length;
    }
  }

  // A sweep that never reaches either outcome proves nothing about either.
  assert.ok(sawPairs > 200, `the sweep found only ${sawPairs} pairs; it is not exercising the yes case`);
  assert.ok(sawRejections > 200, `the sweep rejected only ${sawRejections}; it is not exercising the no case`);
});

// ---------------------------------------------------------------------------
// The plumbing under the distributions
// ---------------------------------------------------------------------------

test('quantiles agree with a brute-force rank over random samples', () => {
  let state = 0x0bad_c0de;
  const next = () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state / 0x1_0000_0000;
  };

  for (let trial = 0; trial < 500; trial += 1) {
    const values = [];
    const size = 1 + Math.floor(next() * 40);
    for (let index = 0; index < size; index += 1) {
      values.push(Math.round(next() * 1000) / 10);
    }
    values.push(Number.NaN, null, undefined);

    const described = describeDistribution(values);
    const clean = values.filter(Number.isFinite).sort((a, b) => a - b);

    assert.equal(described.n, clean.length);
    assert.equal(described.min, clean[0]);
    assert.equal(described.max, clean[clean.length - 1]);
    for (const [key, fraction] of [['p25', 0.25], ['median', 0.5], ['p75', 0.75], ['p90', 0.9]]) {
      const rank = Math.min(clean.length - 1, Math.floor(fraction * clean.length));
      assert.equal(described[key], clean[rank], `${key} at n=${clean.length}`);
    }
    assert.ok(described.min <= described.median && described.median <= described.max);
  }
});

test('the peak-command ladder is monotone as the threshold rises', () => {
  let state = 0xfeed_face;
  const next = () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state / 0x1_0000_0000;
  };

  for (let trial = 0; trial < 200; trial += 1) {
    const set = [];
    for (let index = 0; index < 1 + Math.floor(next() * 12); index += 1) {
      set.push(measurementOf({
        axisDefaults: {peakCommandDps: Math.round(next() * 320)}
      }));
    }
    const summary = summarizeCorpus(set);
    for (const axis of AXES) {
      const ladder = summary.peakCommand[axis].reaching;
      for (let index = 1; index < ladder.length; index += 1) {
        assert.ok(ladder[index].flights <= ladder[index - 1].flights,
          `${axis}: ${ladder[index - 1].thresholdDps}->${ladder[index].thresholdDps} rose`);
      }
      assert.equal(ladder[0].flights,
        set.filter(entry => entry.axes[axis].peakCommandDps >= ladder[0].thresholdDps).length);
    }
  }
});

test('the report separates filtered from unfiltered broadband gyro RMS', () => {
  // The two answers are nothing alike, and a report quoting only one of them
  // says "nothing is near the threshold" about a corpus where the pre-filter
  // signal routinely is.
  const summary = summarizeCorpus([
    measurementOf({axisDefaults: {
      gyroHighFrequencyRmsDps: 1.4, unfilteredHighFrequencyRmsDps: 12.0
    }})
  ]);

  assert.equal(summary.gyroRms.roll.filteredAtOrAboveThreshold, 0);
  assert.equal(summary.gyroRms.roll.unfilteredAtOrAboveThreshold, 1);

  const rendered = renderCorpusReport(summary);
  assert.match(rendered, /NARROWBAND/,
    'the caveat that the shipped gate is narrowband must travel with the number');
});

test('a corpus with no unfiltered gyro says so, because it cannot judge an airframe', () => {
  const summary = summarizeCorpus([
    measurementOf({axisDefaults: {unfilteredHighFrequencyRmsDps: null}})
  ]);
  assert.match(renderCorpusReport(summary), /NO DONATION IN THIS RUN CARRIES AN UNFILTERED GYRO/);

  const withRaw = summarizeCorpus([measurementOf()]);
  assert.doesNotMatch(renderCorpusReport(withRaw), /NO DONATION IN THIS RUN/);
});

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

test('one aircraft donated as two files is one group', async () => {
  const bytes = await bytesOf(path.join(syntheticDir, 'rf46-stop-manoeuvres.TXT'));
  const scan = createCorpusScan();
  scan.addLog(bytes, 'monday.bbl');
  scan.addLog(bytes, 'tuesday.bbl');

  const groups = new Set(scan.measurements.map(entry => entry.aircraftGroup));
  assert.equal(groups.size, 1,
    'a null pair across two donated files from one pilot is a real null pair');
  assert.equal(scan.aircraftCount, 1);
});

test('two aircraft are two groups, and the label identifies nobody', async () => {
  const scan = createCorpusScan();
  scan.addLog(await bytesOf(path.join(syntheticDir, 'rf46-stop-manoeuvres.TXT')), 'a.bbl');
  scan.addLog(await bytesOf(path.join(syntheticDir, 'rf46-p-too-low.TXT')), 'b.bbl');

  const groups = scan.measurements.map(entry => entry.aircraftGroup);
  assert.equal(new Set(groups).size, 2);
  for (const group of groups) {
    assert.match(group, /^aircraft-\d+$/);
  }
});

// ---------------------------------------------------------------------------
// The reference dumps, when they are available
// ---------------------------------------------------------------------------

const REAL_LOG = process.env.ROTORLENS_REAL_LOG;

test('the reference dumps reproduce the per-axis floors quoted in src/',
  {skip: !process.env.ROTORLENS_CORPUS_LOGS
    && 'set ROTORLENS_CORPUS_LOGS to a semicolon-separated list of .bbl paths'},
  async () => {
    const scan = createCorpusScan();
    for (const file of process.env.ROTORLENS_CORPUS_LOGS.split(';').filter(Boolean)) {
      scan.addLog(await bytesOf(file), path.basename(file));
    }

    const summary = summarizeCorpus(scan.measurements, scan.fileFailures);
    assert.equal(auditAll(scan.measurements).ok, true);

    // The whole reason the tool exists: the gate has never opened, and this is
    // the run that says so out of a corpus rather than out of a comment.
    assert.equal(summary.holds.maximumHolds, SHIPPED_FIGURES.observedMaximumHolds);
    assert.equal(summary.holds.flightAxesReachingGate, 0);

    for (const [axis, expected] of Object.entries(SHIPPED_FIGURES.perAxisNoiseFloorP90Dps)) {
      const measured = summary.nullPairs[axis].delta.p90;
      assert.ok(Math.abs(measured - expected) < 0.005,
        `${axis} p90 measured ${measured}, src/ quotes ${expected}`);
    }
  });

test('a real log produces a measurement that passes the audit',
  {skip: !REAL_LOG && 'set ROTORLENS_REAL_LOG to a .bbl path to run this'},
  async () => {
    const scan = createCorpusScan();
    scan.addLog(await bytesOf(REAL_LOG), path.basename(REAL_LOG));

    assert.ok(scan.measurements.length >= 1);
    assert.equal(auditAll(scan.measurements).ok, true);

    const sessions = parseSessions(await bytesOf(REAL_LOG));
    const serialized = JSON.stringify(scan.measurements);
    for (const session of sessions) {
      if (session.craftName) {
        assert.ok(!serialized.includes(session.craftName),
          'a real donor\'s craft name reached the report');
      }
    }
  });
