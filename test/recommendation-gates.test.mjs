/**
 * The gates that must pass before RotorLens tells a pilot to change a gain.
 *
 * THIS FILE EXISTS BECAUSE OF A SPECIFIC DEFECT CLASS. Five times in this
 * repository's history a test has passed a fully green suite while being unable
 * to reach the failure it named — a provenance test that rewrote its own
 * fixtures, an advisor-bundle test that rebuilt what it checked, a layout
 * assertion measured mid-scroll, a decoder round-trip whose encoder shared the
 * decoder's bug, and a safety guard that swept only part of what its module
 * could emit.
 *
 * So the structure here is deliberate:
 *
 *  - Every gate gets an input on which it is the SOLE blocker, and an input on
 *    which it passes. A gate that cannot be made to block alone is inert, and
 *    an inert gate is the exact shape of the fifth failure above.
 *  - Any numbers asserted against owner-supplied real logs are measured values,
 *    not values chosen to match the code. Those private regressions run only
 *    when their paths are supplied through the documented environment gates.
 *  - The wording guard enumerates the codes by construction rather than by
 *    reading the ones that happen to fire today.
 *
 * Each assertion below was verified by mutating the module and watching it go
 * red; the failure text is recorded in the commit that introduced this file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  GAIN_GATE_THRESHOLDS,
  GATE_WORDING,
  UNCONSTRAINED_SWEEP,
  describeGateBlock,
  evaluateAgreementGate,
  evaluateAirframeGate,
  evaluateCompletenessGate,
  evaluateGainRecommendationGates,
  evaluateHeadspeedGate,
  evaluateStabilityGate,
  sweepCombinations,
  sweepDirectionalConclusion
} from '../src/analysis/advisor/recommendation-gates.mjs';

import {decodeLog} from '../src/blackbox/decode.mjs';
import {buildAnalysisRecords, detectStopEvents} from '../src/analysis/records.mjs';
import {
  EVIDENCE_LIMITS,
  buildDirectionalStopEvidence
} from '../src/analysis/pid-evidence.mjs';
import {describeStopCapture} from '../src/analysis/axis-report.mjs';
import {
  analyzeMechanicalTimeSeries,
  buildMechanicalSeries,
  sessionTimeBounds
} from '../src/analysis/advisor/mechanical-spectrum.mjs';

const REAL_LOG = process.env.ROTORLENS_REAL_LOG;
const STOP_FIXTURE = new URL(
  '../fixtures/synthetic/rf46-stop-manoeuvres.TXT', import.meta.url
);

/* ------------------------------------------------------------------- helpers */

function sessionOf(path) {
  return decodeLog(new Uint8Array(fs.readFileSync(path))).sessions[0];
}

/** Everything the gates need for one axis of one session. */
function axisMaterial(session, axis) {
  const {records, usable} = buildAnalysisRecords(session, {axis});
  assert.ok(usable, `${axis} records must be usable`);
  const diagnostics = detectStopEvents(records, {axis, diagnostics: true});
  const evidence = buildDirectionalStopEvidence(diagnostics.events, {axis});
  const capture = describeStopCapture(diagnostics, {axis});
  return {records, events: diagnostics.events, diagnostics, evidence, capture};
}

/** A mechanical result shaped as the analyser produces one, for gate 1. */
function mechanicalStub(overrides = {}) {
  return {
    status: 'clear',
    tuningEvidenceGate: {status: 'permitted', reasonCodes: []},
    harmonicCorrelation: {state: 'evaluated'},
    rpmEvidence: {headspeed: {relativeSpread: 0.04, state: 'trustworthy'}},
    attentionThreshold: {bandRmsDps: 8, basis: 'experimental-synthetic-calibration'},
    range: {startTimeUs: 0, endTimeUs: 1_000_000_000},
    ...overrides
  };
}

/** Two clean stops each way, identical both ways: the shape that should pass. */
function symmetricEvents(headspeedRpm = 1800) {
  const out = [];
  for (let index = 0; index < 2; index += 1) {
    for (const commandSign of ['positive', 'negative']) {
      out.push({
        commandSign,
        stopTimeUs: 10_000_000 + index * 5_000_000 + (commandSign === 'negative' ? 2_000_000 : 0),
        commandDurationUs: 1_500_000,
        headspeedRpm,
        trackingRmsDps: 5 + index * 0.05,
        fastRingingRmsDps: 7 + index * 0.05
      });
    }
  }
  return out;
}

function evidenceFor(events) {
  return buildDirectionalStopEvidence(events, {axis: 'yaw'});
}

function captureFor(events) {
  return {
    state: 'captured',
    captured: {
      positive: events.filter(event => event.commandSign === 'positive').length,
      negative: events.filter(event => event.commandSign === 'negative').length
    }
  };
}

/** A sweep result that agrees with itself everywhere: the shape that passes. */
function unanimousSweep(worse = 'negative', over = false) {
  return {
    axis: 'yaw',
    metric: 'trackingRmsDps',
    combinationCount: sweepCombinations().length,
    outcomes: sweepCombinations().map(combination => ({
      ...combination,
      positiveStops: 2,
      negativeStops: 2,
      captureStatus: 'captured',
      positive: 4,
      negative: 5,
      asymmetryRatio: over ? 0.5 : 0.2,
      worse,
      overWarnRatio: over
    }))
  };
}

/* =====================================================================
 * PART 1 — every gate can block ALONE. An inert gate is the defect class.
 * ===================================================================== */

test('each gate blocks on its own, and the interlock passes when none of them do', () => {
  const events = symmetricEvents();
  const clean = {
    axis: 'yaw',
    metric: 'trackingRmsDps',
    mechanical: mechanicalStub(),
    capture: captureFor(events),
    evidence: evidenceFor(events),
    events,
    sweep: unanimousSweep()
  };

  // The control. If this ever fails, every "blocks alone" case below is
  // meaningless, because they would all be blocking for the same background
  // reason rather than for the one thing each varies.
  const baseline = evaluateGainRecommendationGates(clean);
  assert.equal(
    baseline.mayRecommend, true,
    `the all-clear input must pass all five gates; blocked by ${baseline.blockedBy.join(', ')} `
      + `— ${baseline.sentences.map(entry => entry.code).join(', ')}`
  );
  assert.deepEqual(baseline.blockedBy, []);

  const cases = [
    ['airframe', {mechanical: mechanicalStub({harmonicCorrelation: {state: 'unavailable'}})}],
    ['completeness', {capture: {state: 'partial', captured: {positive: 1, negative: 1}}}],
    ['agreement', (() => {
      // One direction three times the other: a real asymmetry, not scatter.
      const lopsided = symmetricEvents().map(event => ({
        ...event,
        trackingRmsDps: event.commandSign === 'positive' ? 5 : 15
      }));
      return {events: lopsided, evidence: evidenceFor(lopsided), capture: captureFor(lopsided)};
    })()],
    ['headspeed', (() => {
      // Same stops, one direction flown 20% faster.
      const drifted = symmetricEvents().map(event => ({
        ...event,
        headspeedRpm: event.commandSign === 'positive' ? 1800 : 2160
      }));
      return {events: drifted, evidence: evidenceFor(drifted), capture: captureFor(drifted)};
    })()],
    ['stability', {
      sweep: {
        ...unanimousSweep(),
        outcomes: unanimousSweep().outcomes.map((outcome, index) => ({
          ...outcome,
          worse: index % 2 === 0 ? 'positive' : 'negative'
        }))
      }
    }]
  ];

  for (const [name, override] of cases) {
    const result = evaluateGainRecommendationGates({...clean, ...override});
    assert.equal(
      result.mayRecommend, false,
      `the ${name} gate must be able to block: it did not`
    );
    assert.deepEqual(
      result.blockedBy, [name],
      `the ${name} gate must block ALONE, got [${result.blockedBy.join(', ')}]`
    );
    assert.ok(
      result.sentences.length > 0 && result.sentences.every(entry =>
        typeof entry.sentence === 'string' && entry.sentence.length > 40),
      `the ${name} gate must say something useful when it blocks`
    );
  }
});

/* =====================================================================
 * PART 2 — the wording. Every code a gate can emit has a sentence, and no
 * sentence is a tuning instruction. This is the guard that swept only part
 * of its module last time, so it enumerates by construction.
 * ===================================================================== */

/**
 * Every code, DEMONSTRATED reachable by an input that fires it.
 *
 * The previous incarnation of this guard read the codes out of the module's
 * source with a regular expression, which is how a guard ends up sweeping only
 * part of what its module can emit: a code moved behind a computed string, or a
 * push written in a shape the pattern did not match, would have gone unlisted
 * and untested while the guard still passed. Here every entry is an input, and
 * the gate has to actually produce the code from it.
 */
const REACHABILITY = [
  ['MECHANICAL_ANALYSIS_ABSENT', () => evaluateAirframeGate(null)],
  ['MECHANICAL_EVIDENCE_GATE_BLOCKED', () => evaluateAirframeGate(mechanicalStub({
    status: 'attention', tuningEvidenceGate: {status: 'blocked', reasonCodes: ['X']}
  }))],
  ['ROTOR_CORRELATION_UNAVAILABLE', () => evaluateAirframeGate(mechanicalStub({
    harmonicCorrelation: {state: 'unavailable'}
  }))],
  ['ROTOR_CORRELATION_NOT_ATTEMPTED', () => evaluateAirframeGate(mechanicalStub({
    harmonicCorrelation: {state: 'not-evaluated'}
  }))],
  ['MECHANICAL_RANGE_EXCLUDES_EVENTS', () => evaluateAirframeGate(
    mechanicalStub({range: {startTimeUs: 0, endTimeUs: 1_000}}), {eventTimesUs: [9_000_000]}
  )],
  ['MECHANICAL_RANGE_EXCLUDES_HOLDS', () => evaluateAirframeGate(
    mechanicalStub({range: {startTimeUs: 0, endTimeUs: 1_000}}), {holdTimesUs: [9_000_000]}
  )],
  ['CAPTURE_STATE_PARTIAL', () => evaluateCompletenessGate(
    {state: 'partial', captured: {positive: 1, negative: 1}})],
  ['CAPTURE_STATE_REJECTED', () => evaluateCompletenessGate(
    {state: 'rejected', captured: {positive: 0, negative: 0}})],
  ['CAPTURE_STATE_ABSENT', () => evaluateCompletenessGate(
    {state: 'absent', captured: {positive: 0, negative: 0}})],
  ['CAPTURE_STATE_UNAVAILABLE', () => evaluateCompletenessGate(
    {state: 'unavailable', captured: {positive: 0, negative: 0}})],
  ['CAPTURE_STATE_MISSING', () => evaluateCompletenessGate(undefined)],
  ['INSUFFICIENT_STOPS_PER_DIRECTION', () => evaluateCompletenessGate(
    {state: 'partial', captured: {positive: 1, negative: 3}})],
  ['ASYMMETRY_NOT_MEASURABLE', () => evaluateAgreementGate(
    {asymmetry: {}, directions: {}}, 'trackingRmsDps')],
  ['DIRECTIONS_DISAGREE', () => {
    const events = symmetricEvents().map(event => ({
      ...event, trackingRmsDps: event.commandSign === 'positive' ? 5 : 15
    }));
    return evaluateAgreementGate(evidenceFor(events), 'trackingRmsDps', events);
  }],
  ['DIRECTIONS_UNRESOLVED', () => {
    // A large apparent gap between the direction MEANS, produced by stops that
    // scatter at least as widely inside each direction.
    const events = [
      {commandSign: 'positive', trackingRmsDps: 1, headspeedRpm: 1800},
      {commandSign: 'positive', trackingRmsDps: 19, headspeedRpm: 1800},
      {commandSign: 'negative', trackingRmsDps: 1, headspeedRpm: 1800},
      {commandSign: 'negative', trackingRmsDps: 3, headspeedRpm: 1800}
    ];
    return evaluateAgreementGate(evidenceFor(events), 'trackingRmsDps', events);
  }],
  ['STOP_SCATTER_EXCEEDS_ASYMMETRY_LIMIT', () => {
    // Direction means nearly equal — the between-direction ratio passes — while
    // the individual stops inside each direction differ by a factor of ten.
    const events = [
      {commandSign: 'positive', trackingRmsDps: 1, headspeedRpm: 1800},
      {commandSign: 'positive', trackingRmsDps: 19, headspeedRpm: 1800},
      {commandSign: 'negative', trackingRmsDps: 2, headspeedRpm: 1800},
      {commandSign: 'negative', trackingRmsDps: 18, headspeedRpm: 1800}
    ];
    return evaluateAgreementGate(evidenceFor(events), 'trackingRmsDps', events);
  }],
  ['HEADSPEED_NOT_MEASURABLE', () => evaluateHeadspeedGate([])],
  ['HEADSPEED_EVIDENCE_INCOMPLETE', () => evaluateHeadspeedGate(
    symmetricEvents().map((event, index) => index === 0 ? {...event, headspeedRpm: null} : event)
  )],
  ['HEADSPEED_DIFFERS_BETWEEN_DIRECTIONS', () => evaluateHeadspeedGate(
    symmetricEvents().map(event => ({
      ...event, headspeedRpm: event.commandSign === 'positive' ? 1800 : 2160
    })))],
  ['HEADSPEED_UNSTABLE_ACROSS_EVENTS', () => evaluateHeadspeedGate([
    {commandSign: 'positive', headspeedRpm: 1500},
    {commandSign: 'positive', headspeedRpm: 1900},
    {commandSign: 'negative', headspeedRpm: 1500},
    {commandSign: 'negative', headspeedRpm: 1900}
  ])],
  ['HEADSPEED_UNSTABLE_WITHIN_EVENT', () => evaluateHeadspeedGate(
    symmetricEvents(1800).map(event => ({...event, stopTimeUs: 2_000_000})),
    {records: Array.from({length: 501}, (unused, index) => ({
      timeUs: 500_000 + index * 5_000,
      // A governor sag inside the measured window: 1800 down to 1500.
      headspeed: 1800 - index * 0.75
    }))}
  )],
  ['SWEEP_NOT_RUN', () => evaluateStabilityGate(null)],
  // Silence is abstention, not dissent: the gate blocks only when the silent
  // combinations reach half the grid — see `requiredSweepOpinionShare`, whose
  // rule used to be applied in the shape sweep but not here, so one over-narrow
  // window vetoed what the rest of the grid unanimously measured.
  ['SWEEP_INCOMPLETE', () => evaluateStabilityGate({
    outcomes: unanimousSweep().outcomes.map((outcome, index) => index < 136
      ? {...outcome, worse: null, overWarnRatio: null}
      : outcome)
  })],
  ['SWEEP_FLIPS_DIRECTION', () => evaluateStabilityGate({
    outcomes: unanimousSweep().outcomes.map((outcome, index) => ({
      ...outcome, worse: index === 0 ? 'positive' : 'negative'
    }))
  })],
  ['SWEEP_FLIPS_THRESHOLD_VERDICT', () => evaluateStabilityGate({
    outcomes: unanimousSweep().outcomes.map((outcome, index) => ({
      ...outcome, asymmetryRatio: index === 0 ? 0.9 : 0.2, overWarnRatio: index === 0
    }))
  })],
  ['SWEEP_LOSES_CAPTURE', () => evaluateStabilityGate({
    outcomes: unanimousSweep().outcomes.map((outcome, index) => ({
      ...outcome, positiveStops: index === 0 ? 1 : 2
    }))
  })]
];

test('every code any gate can emit is reachable, and has wording', () => {
  const reached = new Set();
  for (const [code, build] of REACHABILITY) {
    const gate = build();
    assert.ok(
      gate.codes.includes(code),
      `${code} is unreachable: that input produced [${gate.codes.join(', ')}] instead`
    );
    assert.equal(gate.status, 'blocked', `${code} must block`);
    reached.add(code);
  }

  // Both directions. A code with no wording is a silent block; wording with no
  // code is a sentence nobody can ever be shown, and both have shipped here.
  const withoutWording = [...reached].filter(code => !GATE_WORDING[code]);
  assert.deepEqual(withoutWording, [],
    `these codes have no wording: ${withoutWording.join(', ')}`);
  const unreachable = Object.keys(GATE_WORDING).filter(code => !reached.has(code));
  assert.deepEqual(unreachable, [],
    `this wording can never be shown to anyone: ${unreachable.join(', ')}`);

  // Nothing here may be a tuning instruction. The gates say what could not be
  // measured and what to fly; naming a gain or a direction to move it is the
  // recommendation layer's job, above this one, and only when all five pass.
  const forbidden = [
    /\bincrease (?:the )?(?:P|I|D|gain)\b/i,
    /\bdecrease (?:the )?(?:P|I|D|gain)\b/i,
    /\breduce (?:the )?(?:P|I|D|gain)\b/i,
    /\braise (?:the )?(?:P|I|D|gain)\b/i,
    /\blower (?:the )?(?:P|I|D|gain)\b/i,
    /\bset (?:the )?(?:P|I|D)\b/i,
    /\bturn (?:it |the gain )?(?:up|down)\b/i
  ];
  for (const [code, sentence] of Object.entries(GATE_WORDING)) {
    for (const pattern of forbidden) {
      assert.ok(
        !pattern.test(sentence),
        `${code} reads as a tuning instruction: ${sentence}`
      );
    }
    // "Cannot tell you" is useless. Every sentence must offer something.
    assert.ok(
      /\b(fly|flying|select|run|hold|release|look|sort|keep|let|check|more stops)\b/i.test(sentence),
      `${code} blocks without telling the pilot anything to do: ${sentence}`
    );
  }
});

test('describeGateBlock never invents a sentence for a code it does not have', () => {
  const described = describeGateBlock({gate: 'airframe', codes: ['NOT_A_REAL_CODE']});
  assert.equal(described.length, 1);
  assert.equal(described[0].code, 'NOT_A_REAL_CODE');
  assert.ok(described[0].sentence.length > 20);
  assert.ok(!described[0].sentence.includes('NOT_A_REAL_CODE'));
});

/* =====================================================================
 * PART 3 — the airframe gate's actual content: the rotor must have been
 * compared, not merely not-found.
 * ===================================================================== */

test('the airframe gate blocks a "clear" reached without ever checking the rotor', () => {
  // This is the reference log's whole-range shape, reproduced exactly: the
  // upstream tuningEvidenceGate says permitted, and the rotor was never
  // compared because the head speed spread 0.62107 against its 0.12 gate.
  const uncorrelated = evaluateAirframeGate(mechanicalStub({
    harmonicCorrelation: {state: 'unavailable'},
    rpmEvidence: {headspeed: {
      relativeSpread: 0.62107, state: 'unavailable', reasonCode: 'RPM_UNSTABLE_IN_SELECTION'
    }}
  }));
  assert.equal(uncorrelated.status, 'blocked');
  assert.deepEqual([...uncorrelated.codes], ['ROTOR_CORRELATION_UNAVAILABLE']);
  assert.equal(uncorrelated.measured.upstreamGate, 'permitted',
    'the upstream gate must still read permitted here — that is the whole point');

  // Never reached the rotor step at all is a different sentence.
  const notAttempted = evaluateAirframeGate(mechanicalStub({
    harmonicCorrelation: {state: 'not-evaluated'}
  }));
  assert.deepEqual([...notAttempted.codes], ['ROTOR_CORRELATION_NOT_ATTEMPTED']);

  // And a genuine clear-with-correlation passes.
  assert.equal(evaluateAirframeGate(mechanicalStub()).status, 'permitted');
});

test('the airframe gate blocks when the vibration check covered other seconds', () => {
  const elsewhere = evaluateAirframeGate(
    mechanicalStub({range: {startTimeUs: 0, endTimeUs: 50_000_000}}),
    {eventTimesUs: [180_361_000, 184_821_000]}
  );
  assert.equal(elsewhere.status, 'blocked');
  assert.ok(elsewhere.codes.includes('MECHANICAL_RANGE_EXCLUDES_EVENTS'));
  assert.equal(elsewhere.measured.rangeContainsEvents, false);

  const containing = evaluateAirframeGate(
    mechanicalStub({range: {startTimeUs: 0, endTimeUs: 214_505_747}}),
    {eventTimesUs: [180_361_000, 184_821_000]}
  );
  assert.equal(containing.status, 'permitted');
  assert.equal(containing.measured.rangeContainsEvents, true);

  const holdElsewhere = evaluateAirframeGate(
    mechanicalStub({range: {startTimeUs: 0, endTimeUs: 50_000_000}}),
    {holdTimesUs: [80_000_000, 90_000_000]}
  );
  assert.equal(holdElsewhere.status, 'blocked');
  assert.ok(holdElsewhere.codes.includes('MECHANICAL_RANGE_EXCLUDES_HOLDS'));
  assert.equal(holdElsewhere.measured.rangeContainsHolds, false);
});

test('partial sample-level headspeed cannot pass behind a complete event mean', () => {
  const events = [
    {commandSign: 'positive', stopTimeUs: 10_000_000, commandDurationUs: 500_000, headspeedRpm: 2000},
    {commandSign: 'positive', stopTimeUs: 20_000_000, commandDurationUs: 500_000, headspeedRpm: 2000},
    {commandSign: 'negative', stopTimeUs: 30_000_000, commandDurationUs: 500_000, headspeedRpm: 2000},
    {commandSign: 'negative', stopTimeUs: 40_000_000, commandDurationUs: 500_000, headspeedRpm: 2000}
  ];
  const records = events.flatMap((event, eventIndex) => {
    const from = event.stopTimeUs - event.commandDurationUs;
    const to = event.stopTimeUs + 1_000_000;
    return Array.from({length: ((to - from) / 50_000) + 1}, (unused, sampleIndex) => ({
      timeUs: from + sampleIndex * 50_000,
      headspeed: eventIndex === 2 && sampleIndex === 10 ? null : 2000
    }));
  });

  const result = evaluateHeadspeedGate(events, {records});
  assert.equal(result.status, 'blocked');
  assert.ok(result.codes.includes('HEADSPEED_EVIDENCE_INCOMPLETE'));
  assert.equal(result.measured.incompleteEventWindowCount, 1);
});

test('two distant headspeed samples do not stand in for continuous event coverage', () => {
  const events = symmetricEvents(2000);
  const records = events.flatMap(event => {
    const from = event.stopTimeUs - event.commandDurationUs;
    const to = event.stopTimeUs + 1_000_000;
    return [
      {timeUs: from, headspeed: 2000},
      {timeUs: to, headspeed: 2000}
    ];
  });

  const result = evaluateHeadspeedGate(events, {records});
  assert.equal(result.status, 'blocked');
  assert.ok(result.codes.includes('HEADSPEED_EVIDENCE_INCOMPLETE'));
  assert.equal(result.measured.incompleteEventWindowCount, events.length);
  assert.equal(result.measured.maximumSampleGapUs, EVIDENCE_LIMITS.maximumHoldSampleGapUs);
});

/* =====================================================================
 * PART 4 — the stop fixture. Measured, and asserted against the numbers
 * that were measured.
 * ===================================================================== */

test('the stop fixture: captured on all three axes, and past the airframe gate', async () => {
  const session = sessionOf(STOP_FIXTURE);

  // This test asserted the opposite until 2026-08-13, and its name said so. The
  // corpus carried only gyroADC, which is filtered, and an airframe cannot be
  // ruled out from a filtered signal because the filter has already removed the
  // evidence. So the gate blocked on all 35 ranges tried and every gain finding
  // sat behind it — meaning this fixture, built specifically to reach a captured
  // directional result, could never put one on a screen. Confirmed on a real
  // handset: "This log has no unfiltered gyro, so the airframe cannot be ruled
  // out from it at all."
  //
  // The generator now emits gyroRAW as the filtered signal plus a small
  // broadband dither — RMS(raw − filtered) 2.0 deg/s against an 8 deg/s
  // attention threshold — so the gate clears on its merits rather than being
  // stepped around.
  const series = buildMechanicalSeries(session);
  assert.deepEqual(series.gyroSources, {
    roll: 'gyroRAW', pitch: 'gyroRAW', yaw: 'gyroRAW'
  });
  const bounds = sessionTimeBounds(session);
  const mechanical = await analyzeMechanicalTimeSeries(series, {timeRangeUs: bounds});
  assert.equal(mechanical.status, 'clear');
  assert.equal(mechanical.tuningEvidenceGate.status, 'permitted');
  // The head speed here is rock steady — 0.01757 against the 0.12 range gate.
  assert.ok(mechanical.rpmEvidence.headspeed.relativeSpread < 0.02);
  assert.equal(mechanical.harmonicCorrelation.state, 'evaluated');
  assert.equal(evaluateAirframeGate(mechanical).status, 'permitted');

  const expected = {
    roll: {tracking: 0.6489, agreement: 'blocked'},
    pitch: {tracking: 0.0219, agreement: 'permitted'},
    yaw: {tracking: 0.7486, agreement: 'blocked'}
  };

  for (const axis of ['roll', 'pitch', 'yaw']) {
    const {records, events, evidence, capture} = axisMaterial(session, axis);

    // Gate 2 passes: 2 stops each way on every axis.
    assert.equal(capture.state, 'captured', `${axis} capture state`);
    assert.deepEqual({...capture.captured}, {positive: 2, negative: 2}, `${axis} stop counts`);
    assert.equal(evaluateCompletenessGate(capture).status, 'permitted');

    // Gate 3, measured. The fixture carries a deliberate 2.8x directional
    // asymmetry and this is it being caught on roll and yaw.
    assert.ok(
      Math.abs(evidence.asymmetry.trackingRmsDps - expected[axis].tracking) < 0.0002,
      `${axis} tracking asymmetry ${evidence.asymmetry.trackingRmsDps}, expected `
        + `${expected[axis].tracking}`
    );
    const agreement = evaluateAgreementGate(evidence, 'trackingRmsDps', events);
    assert.equal(agreement.status, expected[axis].agreement, `${axis} agreement gate`);

    // Gate 4 passes on every axis: measured between-direction ratios are
    // 0.00098 / 0.00000 / 0.00024 against a 0.05 limit.
    const headspeed = evaluateHeadspeedGate(events, {records});
    assert.equal(headspeed.status, 'permitted', `${axis} headspeed: ${headspeed.codes.join(', ')}`);
    assert.ok(
      headspeed.measured.betweenDirectionRatio
        <= GAIN_GATE_THRESHOLDS.maximumHeadspeedVariationRatio / 10,
      `${axis} between-direction ratio ${headspeed.measured.betweenDirectionRatio}`
    );

    // The airframe no longer blocks, so what stops a gain verdict here is the
    // evidence itself rather than a missing field. Roll and yaw carry the
    // deliberate 2.8x asymmetry, which is larger than a gain explains and is
    // therefore reported as mechanical; pitch is symmetric and clears every
    // gate. That difference is the point of the fixture, and it was invisible
    // while gate 1 rejected all three axes for the same unrelated reason.
    const overall = evaluateGainRecommendationGates({
      axis, metric: 'trackingRmsDps', mechanical, capture, evidence, events, records,
      sweep: unanimousSweep()
    });
    assert.ok(!overall.blockedBy.includes('airframe'),
      `${axis} must not be blocked by the airframe: ${overall.blockedBy.join(', ')}`);

    if (expected[axis].agreement === 'permitted') {
      assert.equal(overall.mayRecommend, true,
        `${axis} is symmetric and should reach a verdict: ${overall.blockedBy.join(', ')}`);
    } else {
      assert.equal(overall.mayRecommend, false, `${axis} asymmetry must not become a gain`);
      assert.ok(overall.blockedBy.includes('agreement'),
        `${axis} should be stopped by the agreement gate: ${overall.blockedBy.join(', ')}`);
    }
  }
});

test('the stop fixture survives the unconstrained sweep on every axis', () => {
  const session = sessionOf(STOP_FIXTURE);
  for (const axis of ['roll', 'pitch', 'yaw']) {
    const {records} = axisMaterial(session, axis);
    for (const metric of ['trackingRmsDps', 'fastRingingRmsDps']) {
      const sweep = sweepDirectionalConclusion(records, axis, metric);
      assert.equal(sweep.outcomes.length, 270);
      const gate = evaluateStabilityGate(sweep);
      assert.equal(
        gate.status, 'permitted',
        `${axis}/${metric} should survive the sweep: ${gate.codes.join(', ')} `
          + `(direction agreement ${gate.measured.directionAgreementRatio})`
      );
      assert.equal(gate.measured.directionAgreementRatio, 1);
      assert.equal(gate.measured.verdictAgreementRatio, 1);
      assert.equal(gate.measured.captureShortfallCount, 0);
    }
  }
});

/* =====================================================================
 * PART 5 — the reference log. The measurements this whole design rests on.
 * ===================================================================== */

test(
  'the reference log: the airframe gate is a constant upstream and a real gate here',
  {skip: !REAL_LOG && 'set ROTORLENS_REAL_LOG to a .bbl path to run this'},
  async t => {
    const session = sessionOf(REAL_LOG);
    const series = buildMechanicalSeries(session);
    const bounds = sessionTimeBounds(session);
    const total = bounds.endTimeUs - bounds.startTimeUs;

    await t.test('upstream reads permitted on every range tried; ours does not', async () => {
      const ranges = [
        [0, 0.1], [0, 1.0], [0.05, 0.2], [0.1, 0.35], [0.15, 0.9], [0.2, 0.5], [0.3, 0.5]
      ];
      let upstreamPermitted = 0;
      let oursPermitted = 0;
      let uncorrelated = 0;
      for (const [startFraction, durationFraction] of ranges) {
        const startTimeUs = bounds.startTimeUs + Math.round(total * startFraction);
        const endTimeUs = Math.min(bounds.endTimeUs, startTimeUs + Math.round(total * durationFraction));
        const result = await analyzeMechanicalTimeSeries(series, {
          timeRangeUs: {startTimeUs, endTimeUs}
        });
        if (result.tuningEvidenceGate.status === 'permitted') upstreamPermitted += 1;
        const gate = evaluateAirframeGate(result);
        if (gate.status === 'permitted') oursPermitted += 1;
        if (result.harmonicCorrelation.state !== 'evaluated') uncorrelated += 1;
      }
      // The upstream gate has never fired on this log. That is not a criticism
      // of it — it measures vibration and this aircraft has little — it is why
      // it cannot be the whole airframe gate.
      assert.equal(upstreamPermitted, ranges.length,
        'upstream tuningEvidenceGate is permitted on every range of this log');
      // Ours blocks the ranges where the rotor was never compared.
      assert.ok(uncorrelated > 0, 'some ranges of this log cannot be correlated at all');
      assert.equal(oursPermitted, ranges.length - uncorrelated,
        'our airframe gate must block exactly the uncorrelated ranges');
      assert.ok(oursPermitted < upstreamPermitted,
        'if these are equal, this gate adds nothing on the only real log we have');
    });

    await t.test('the whole-log range is one of the uncorrelated ones', async () => {
      const result = await analyzeMechanicalTimeSeries(series, {timeRangeUs: bounds});
      assert.equal(result.status, 'clear');
      assert.equal(result.tuningEvidenceGate.status, 'permitted');
      assert.equal(result.harmonicCorrelation.state, 'unavailable');
      assert.ok(Math.abs(result.rpmEvidence.headspeed.relativeSpread - 0.62107) < 0.0005,
        `whole-log headspeed spread ${result.rpmEvidence.headspeed.relativeSpread}`);
      const gate = evaluateAirframeGate(result);
      assert.equal(gate.status, 'blocked');
      assert.deepEqual([...gate.codes], ['ROTOR_CORRELATION_UNAVAILABLE']);
    });

    await t.test('a post-spool-up range is correlated, and passes', async () => {
      const startTimeUs = bounds.startTimeUs + 20_000_000;
      const result = await analyzeMechanicalTimeSeries(series, {
        timeRangeUs: {startTimeUs, endTimeUs: bounds.endTimeUs}
      });
      assert.equal(result.status, 'clear');
      assert.equal(result.harmonicCorrelation.state, 'evaluated');
      assert.ok(result.rpmEvidence.headspeed.relativeSpread < 0.12);
      assert.equal(evaluateAirframeGate(result).status, 'permitted');
    });
  }
);

test(
  'the reference log: no axis earns a gain recommendation, and each is blocked for its own reason',
  {skip: !REAL_LOG && 'set ROTORLENS_REAL_LOG to a .bbl path to run this'},
  async t => {
    const session = sessionOf(REAL_LOG);
    const series = buildMechanicalSeries(session);
    const bounds = sessionTimeBounds(session);
    const mechanical = await analyzeMechanicalTimeSeries(series, {
      timeRangeUs: {startTimeUs: bounds.startTimeUs + 20_000_000, endTimeUs: bounds.endTimeUs}
    });

    await t.test('roll and pitch: the manoeuvre is not in the log', () => {
      for (const [axis, peak] of [['roll', 56], ['pitch', 32]]) {
        const {events, capture, evidence, records} = axisMaterial(session, axis);
        assert.equal(events.length, 0);
        assert.equal(capture.state, 'absent');
        assert.equal(Math.round(capture.peakCommandDps), peak, `${axis} peak command`);
        const gate = evaluateCompletenessGate(capture);
        assert.deepEqual([...gate.codes].sort(), [
          'CAPTURE_STATE_ABSENT', 'INSUFFICIENT_STOPS_PER_DIRECTION'
        ]);
        const overall = evaluateGainRecommendationGates({
          axis, metric: 'trackingRmsDps', mechanical, capture, evidence, events, records,
          sweep: sweepDirectionalConclusion(records, axis, 'trackingRmsDps')
        });
        assert.equal(overall.mayRecommend, false);
        // The sentence a pilot actually gets: fly the manoeuvre, nothing is wrong.
        assert.ok(overall.sentences.some(entry => entry.code === 'CAPTURE_STATE_ABSENT'));
      }
    });

    await t.test('yaw: two stops, one each way — measured, and not enough', () => {
      const {events, capture, evidence} = axisMaterial(session, 'yaw');
      assert.equal(events.length, 2);
      assert.equal(capture.state, 'partial');
      assert.deepEqual({...capture.captured}, {positive: 1, negative: 1});
      assert.equal(evaluateCompletenessGate(capture).status, 'blocked');

      // The measured numbers this whole workflow turned on.
      assert.ok(Math.abs(evidence.asymmetry.trackingRmsDps - 0.2645) < 0.0002,
        `yaw tracking asymmetry ${evidence.asymmetry.trackingRmsDps}`);
      assert.ok(Math.abs(evidence.asymmetry.fastRingingRmsDps - 0.7955) < 0.0002,
        `yaw ringing asymmetry ${evidence.asymmetry.fastRingingRmsDps}`);
      // At the shipped constants the tracking asymmetry sits UNDER the 0.30
      // warn ratio — twelve percent under. A layer that only ever ran the
      // shipped constants would call this "the two directions behave alike".
      assert.ok(evidence.asymmetry.trackingRmsDps
        < GAIN_GATE_THRESHOLDS.directionalAsymmetryWarnRatio);
    });

    await t.test('yaw: the head speed gate passes, and the whole-log number would not have', () => {
      const {events, records} = axisMaterial(session, 'yaw');
      const gate = evaluateHeadspeedGate(events, {records});
      assert.equal(gate.status, 'permitted', gate.codes.join(', '));
      // Both stops at essentially the same rotor speed, 4.46 s apart: 1828.5
      // and 1831.3 rpm mean over their tracking windows, a ratio of 0.00152.
      assert.ok(Math.abs(gate.measured.betweenDirectionRatio - 0.001523) < 0.00002,
        `between-direction ratio ${gate.measured.betweenDirectionRatio}`);
      assert.ok(Math.abs(gate.measured.worstWithinEventRatio - 0.027337) < 0.00002,
        `worst within-event span ${gate.measured.worstWithinEventRatio}`);
      assert.ok(gate.measured.worstWithinEventRatio
        < GAIN_GATE_THRESHOLDS.maximumHeadspeedVariationRatio);
      // Against a whole-log spread of 0.62107. Measuring the log instead of the
      // events would have rejected a comparison the aircraft supports.
      const wholeLogSpread = 0.62107;
      assert.ok(wholeLogSpread > GAIN_GATE_THRESHOLDS.maximumHeadspeedVariationRatio * 10,
        'the log-level and event-level numbers must be far apart, or this gate is untested');
    });

    await t.test('yaw: the P-term conclusion does NOT survive the sweep', () => {
      const {records} = axisMaterial(session, 'yaw');
      const sweep = sweepDirectionalConclusion(records, 'yaw', 'trackingRmsDps');
      assert.equal(sweep.outcomes.length, 270);
      const gate = evaluateStabilityGate(sweep);
      assert.equal(gate.status, 'blocked');
      assert.ok(gate.codes.includes('SWEEP_FLIPS_DIRECTION'),
        `codes: ${gate.codes.join(', ')}`);
      assert.ok(gate.codes.includes('SWEEP_FLIPS_THRESHOLD_VERDICT'));
      // Measured: positive worse in 75 of 270, negative in 195.
      const positive = sweep.outcomes.filter(outcome => outcome.worse === 'positive').length;
      assert.equal(positive, 75, `positive-worse count ${positive}`);
      assert.equal(sweep.outcomes.filter(outcome => outcome.worse === 'negative').length, 195);
      // And the warn-threshold verdict flips too: 125 of 270 read over.
      assert.equal(sweep.outcomes.filter(outcome => outcome.overWarnRatio).length, 125);
      // A factor of 52 between the smallest and largest asymmetry the same two
      // events produce, purely from constants nobody in this project derived.
      assert.ok(gate.measured.asymmetryRatioMaximum / gate.measured.asymmetryRatioMinimum > 40,
        `asymmetry spans ${gate.measured.asymmetryRatioMinimum}..`
          + `${gate.measured.asymmetryRatioMaximum}`);
    });

    await t.test('yaw: the D-term conclusion DOES survive the sweep, and is blocked anyway', () => {
      const {records, capture} = axisMaterial(session, 'yaw');
      const sweep = sweepDirectionalConclusion(records, 'yaw', 'fastRingingRmsDps');
      const stability = evaluateStabilityGate(sweep);
      // Every one of the 270 combinations names the same direction and lands on
      // the same side of the threshold. This is the one conclusion in the
      // reference log that is stable.
      assert.equal(stability.measured.directionAgreementRatio, 1);
      assert.equal(stability.measured.verdictAgreementRatio, 1);
      assert.deepEqual([...stability.measured.directionsSeen], ['negative']);
      // It still cannot be spoken: it rests on one stop per direction, so the
      // sweep also reports the capture shortfall and gate 2 blocks outright.
      assert.ok(stability.codes.includes('SWEEP_LOSES_CAPTURE'));
      assert.equal(evaluateCompletenessGate(capture).status, 'blocked');
    });
  }
);

/* =====================================================================
 * PART 6 — the thresholds are imported, not restated.
 * ===================================================================== */

test('thresholds come from the constants that already had derivations', async () => {
  const {EVIDENCE_LIMITS} = await import('../src/analysis/pid-evidence.mjs');
  assert.equal(GAIN_GATE_THRESHOLDS.minimumStopsPerDirection,
    EVIDENCE_LIMITS.minimumStopsPerDirection);
  assert.equal(GAIN_GATE_THRESHOLDS.directionalAsymmetryWarnRatio,
    EVIDENCE_LIMITS.directionalAsymmetryWarnRatio);
  assert.equal(GAIN_GATE_THRESHOLDS.maximumHeadspeedVariationRatio,
    EVIDENCE_LIMITS.maximumHeadspeedVariationRatio);
  // Unanimity, not a majority. The swept constants are unconstrained, so no
  // point in the grid — the shipped one included — has a claim to being right.
  assert.equal(GAIN_GATE_THRESHOLDS.requiredSweepAgreementRatio, 1);

  // A HALF, pinned to the value and not merely bracketed by a range.
  //
  // This one governs how many combinations had an opinion at all; the gate above
  // governs agreement among the ones that did, and the two were once conflated.
  // Pinning it matters more than it looks: the tests that exercise the quorum
  // state their bounds as arithmetic, so they only constrain it to roughly
  // (0.41, 0.99), and seven of the nine real axis-directions that carry stop
  // events at all sit below 0.95. A constant free to drift upward would silence
  // most of the corpus with the whole suite still green — the failure this repo
  // keeps shipping. Half is the point at which the windows that could see a hold
  // outnumber those that could not: a statement about meaning, which is exactly
  // the kind of claim that has to be asserted rather than left to drift into a
  // percentile.
  assert.equal(GAIN_GATE_THRESHOLDS.requiredSweepOpinionShare, 0.5);

  assert.deepEqual([...GAIN_GATE_THRESHOLDS.admissibleCaptureStates], ['captured']);
});

test('the sweep grid brackets the shipped constants on both sides', async () => {
  const {STOP_DETECTION_DEFAULTS} = await import('../src/analysis/records.mjs');
  const grid = UNCONSTRAINED_SWEEP;
  assert.ok(grid.plateauFraction.includes(STOP_DETECTION_DEFAULTS.plateauFraction));
  assert.ok(Math.min(...grid.plateauFraction) < STOP_DETECTION_DEFAULTS.plateauFraction);
  assert.ok(Math.max(...grid.plateauFraction) > STOP_DETECTION_DEFAULTS.plateauFraction);
  assert.ok(grid.trackingWindowUs.includes(STOP_DETECTION_DEFAULTS.trackingWindowUs));
  assert.ok(Math.min(...grid.trackingWindowUs) <= STOP_DETECTION_DEFAULTS.trackingWindowUs / 3);
  assert.ok(Math.max(...grid.trackingWindowUs) >= STOP_DETECTION_DEFAULTS.trackingWindowUs * 3);
  assert.ok(grid.fastWindowUs.some(window =>
    window[0] === STOP_DETECTION_DEFAULTS.fastWindowUs[0]
    && window[1] === STOP_DETECTION_DEFAULTS.fastWindowUs[1]));
  assert.equal(sweepCombinations().length, 9 * 6 * 5);
});

test('one silent sweep combination abstains; a silent majority blocks', () => {
  // A combination whose window could not measure is silence, and silence is
  // not a contrary verdict. The old unconditional SWEEP_INCOMPLETE let a
  // single over-narrow window veto a grid that was otherwise unanimous.
  const oneSilent = evaluateStabilityGate({
    outcomes: unanimousSweep().outcomes.map((outcome, index) => index === 0
      ? {...outcome, worse: null, overWarnRatio: null}
      : outcome)
  });
  assert.ok(!oneSilent.codes.includes('SWEEP_INCOMPLETE'),
    'one abstention out of 270 must not veto the unanimous rest');
  assert.equal(oneSilent.status, 'permitted');
  assert.ok(oneSilent.measured.opinionShare > 0.99);

  // Exactly half is not a majority of opinions, so it still blocks.
  const halfSilent = evaluateStabilityGate({
    outcomes: unanimousSweep().outcomes.map((outcome, index) => index < 135
      ? {...outcome, worse: null, overWarnRatio: null}
      : outcome)
  });
  assert.ok(halfSilent.codes.includes('SWEEP_INCOMPLETE'));
  assert.equal(halfSilent.status, 'blocked');
});
