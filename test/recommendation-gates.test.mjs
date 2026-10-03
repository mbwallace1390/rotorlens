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
// The app's entry point for a flight window, reached through the namespace so a
// module missing it fails only the tests that need it.
import * as spectrum from '../src/analysis/advisor/mechanical-spectrum.mjs';

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
  // Split from the code above on 2 October 2026: "vibration was measured" and
  // "vibration could not be measured" were one code, so a 40 Hz log was told
  // its range "shows vibration".
  ['MECHANICAL_EVIDENCE_NOT_MEASURED', () => evaluateAirframeGate(mechanicalStub({
    status: 'insufficient', reasonCodes: ['TIMING_GAPS_EXCESSIVE'],
    tuningEvidenceGate: {status: 'blocked', reasonCodes: ['TIMING_GAPS_EXCESSIVE']}
  }))],
  ['ROTOR_CORRELATION_UNAVAILABLE', () => evaluateAirframeGate(mechanicalStub({
    harmonicCorrelation: {state: 'unavailable'}
  }))],
  ['ROTOR_CORRELATION_NOT_ATTEMPTED', () => evaluateAirframeGate(mechanicalStub({
    harmonicCorrelation: {state: 'not-evaluated'}
  }))],
  // A window measured in stretches, compared against the rotor in one of them
  // and not in the other. "Never compared" would be false about the first.
  ['ROTOR_CORRELATION_PARTIAL', () => evaluateAirframeGate(mechanicalStub({
    harmonicCorrelation: {state: 'not-evaluated'},
    chunks: [
      {status: 'clear', harmonicCorrelationState: 'evaluated'},
      {status: 'insufficient', harmonicCorrelationState: 'not-evaluated'}
    ]
  }))],
  // Main-rotor 1/rev or 2/rev, and nothing else, but past the severity ceiling.
  ['MAIN_ROTOR_ORDER_TONE_LARGE', () => evaluateAirframeGate(withAxis(rotorOrderOnlyStub(),
    'roll', entry => ({...entry, peaks: [{...entry.peaks[0], bandRmsDps: 30,
      attentionWindowBandRmsDps: 30}, entry.peaks[1]]})))],
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
  ['SWEEP_INCOMPLETE', () => evaluateStabilityGate({
    outcomes: [...unanimousSweep().outcomes.slice(0, 269),
      {...unanimousSweep().outcomes[269], worse: null, overWarnRatio: null}]
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

/**
 * A gyro series the real analyser cannot measure, for a named reason.
 *
 * Built rather than stubbed: what is being pinned is what `evaluateAirframeGate`
 * makes of a result the analyser actually returns, and a stub could only
 * agree with whatever shape its author remembered.
 */
function unmeasurableSeries(kind) {
  const rateHz = kind === 'low-rate' ? 40 : 1000;
  const count = rateHz * 20;
  const timeUs = [];
  const roll = [];
  for (let index = 0; index < count; index += 1) {
    // Keep 15 samples, drop 10: one 11 ms hole every 25 ms of flight. The
    // median interval stays 1 ms and the 95th percentile does not.
    if (kind === 'gaps' && index % 25 >= 15) {
      continue;
    }
    timeUs.push(Math.round((index * 1e6) / rateHz));
    roll.push(6 * Math.sin(2 * Math.PI * 47 * index / rateHz) + ((index * 7919) % 13) / 13);
  }
  const values = Float64Array.from(roll);
  return {
    timeUs: Float64Array.from(timeUs),
    gyro: {roll: values, pitch: values, yaw: values},
    gyroSources: {roll: 'gyroRAW', pitch: 'gyroRAW', yaw: 'gyroRAW'},
    // A rock-steady head: nothing about the rotor speed moved.
    headspeedRpm: new Float64Array(timeUs.length).fill(1800),
    tailspeedRpm: new Float64Array(timeUs.length).fill(Number.NaN)
  };
}

test('a vibration check that could not measure is never reported as vibration measured',
  async () => {
    for (const [kind, reason] of [
      ['low-rate', 'SAMPLE_RATE_UNAVAILABLE'],
      ['gaps', 'TIMING_GAPS_EXCESSIVE']
    ]) {
      const series = unmeasurableSeries(kind);
      const mechanical = await analyzeMechanicalTimeSeries(series, {
        timeRangeUs: {startTimeUs: series.timeUs[0], endTimeUs: series.timeUs.at(-1)}
      });
      // The fixture must genuinely be unmeasurable, for the named reason.
      assert.equal(mechanical.status, 'insufficient', `${kind}: ${mechanical.reasonCodes}`);
      assert.ok(mechanical.reasonCodes.includes(reason), `${kind}: ${mechanical.reasonCodes}`);

      const gate = evaluateAirframeGate(mechanical);
      assert.equal(gate.status, 'blocked', 'an unmeasured airframe still blocks every gain');
      assert.ok(gate.codes.includes('MECHANICAL_EVIDENCE_NOT_MEASURED'),
        `${kind}: expected the not-measured code, got [${gate.codes.join(', ')}]`);
      assert.ok(!gate.codes.includes('MECHANICAL_EVIDENCE_GATE_BLOCKED'),
        `${kind}: "this range shows vibration" is false when nothing was measured`);
      for (const entry of describeGateBlock(gate)) {
        assert.doesNotMatch(entry.sentence, /shows (?:measured )?vibration|shaking/i,
          `${kind}: ${entry.code} claims vibration that was never measured: ${entry.sentence}`);
        // The head speed was constant. Nothing may say it moved.
        assert.doesNotMatch(entry.sentence, /moved too much/i,
          `${kind}: ${entry.code} blames a head speed that never moved: ${entry.sentence}`);
      }
    }
  });

/* =====================================================================
 * PART 3b — the rotor-order exception (owner decision, 2 October 2026).
 *
 * The 8 deg/s attention level is synthetic-calibrated and fires on 32 of 33
 * real flights, mostly from the main rotor's own once- and twice-per-rev. When
 * EVERYTHING above it is one of those two tones, measured on unfiltered gyro
 * against a rotor speed that was actually compared, it is reported instead of
 * blocking. Anything else still blocks. Each disqualifier below must block on
 * its own, or it is decoration.
 * ===================================================================== */

/** A result whose only attention-level energy is main-rotor 1/rev and 2/rev. */
function rotorOrderOnlyStub(overrides = {}) {
  // A tone above the level in every window: its size while present IS its
  // flight average. The rule judges the ceiling on the size while present, so a
  // peak without one is the unknown case and is refused.
  //
  // Stage 2d: the match carries the head speed's spread at that order and the
  // analysis resolution, which identity is judged from (a 0.01 relative spread of
  // a 1800 rpm head is 0.15 Hz either side of the once-per-rev). A match without
  // them cannot be judged the rotor's own, and is refused.
  const peak = (frequencyHz, order, bandRmsDps) => ({
    frequencyHz, bandRmsDps, attentionWindowBandRmsDps: bandRmsDps, attentionPersistenceRatio: 1,
    bandwidthHz: 2, persistenceRatio: 1, attentionEligible: true,
    harmonicMatch: {rotor: 'main', order, predictedHz: 30 * order, deltaHz: 0.7, toleranceHz: 2.9,
      spreadHz: 0.15 * order, frequencyResolutionHz: 1.953}
  });
  return mechanicalStub({
    status: 'attention',
    reasonCodes: ['PERSISTENT_NARROWBAND_ENERGY', 'MAIN_ROTOR_HARMONIC_CORRELATION'],
    tuningEvidenceGate: {
      status: 'blocked',
      reasonCodes: ['PERSISTENT_NARROWBAND_ENERGY', 'MAIN_ROTOR_HARMONIC_CORRELATION']
    },
    harmonicCorrelation: {state: 'evaluated', evaluated: true},
    rpmEvidence: {headspeed: {relativeSpread: 0.01, state: 'trustworthy', medianRpm: 1800}},
    axes: ['roll', 'pitch', 'yaw'].map(axis => ({
      axis, source: 'gyroRAW', available: true,
      // The analyser's own statement that the list below holds every
      // attention-level peak it found. Without it, "every attention peak is
      // the rotor" is a claim about a list that may have been cut short.
      attentionEligibleUnlistedCount: 0,
      peaks: axis === 'yaw'
        ? [peak(29.3, 1, 11.2), {...peak(44, 1, 3), attentionEligible: false, harmonicMatch: null}]
        : [peak(29.3, 1, 13.8), peak(60.5, 2, 9.1)]
    })),
    ...overrides
  });
}

function withAxis(stub, axisName, change) {
  return {...stub, axes: stub.axes.map(entry => (entry.axis === axisName ? change(entry) : entry))};
}

test('main-rotor 1/rev and 2/rev above the experimental threshold are reported, not blocked',
  () => {
    const gate = evaluateAirframeGate(rotorOrderOnlyStub());
    assert.equal(gate.status, 'permitted',
      `rotor-order tones alone must not block; got [${gate.codes.join(', ')}]`);
    assert.deepEqual([...gate.codes], []);
    assert.equal(gate.measured.rotorOrderTonesOnly, true);
    assert.ok(gate.observations.includes('MAIN_ROTOR_ORDER_TONE_ABOVE_EXPERIMENTAL_THRESHOLD'),
      'the tone is reported as a non-blocking observation');
    // The basis a finding needs: which axis, which order, how big, at what head speed.
    const tones = gate.measured.rotorOrderTones;
    assert.equal(tones.length, 5, JSON.stringify(tones));
    assert.deepEqual(tones.map(tone => `${tone.axis}:${tone.order}`).sort(),
      ['pitch:1', 'pitch:2', 'roll:1', 'roll:2', 'yaw:1']);
    for (const tone of tones) {
      assert.equal(tone.rotor, 'main');
      assert.ok(tone.bandRmsDps >= 8, `${tone.axis} ${tone.bandRmsDps}`);
      assert.equal(tone.headspeedRpm, 1800, 'head speed is the one the tone was matched against');
    }
    // The sub-threshold, unmatched yaw tone is not part of the attention set.
    assert.ok(!tones.some(tone => tone.frequencyHz === 44));

    // And through the interlock: the airframe gate is not the one blocking.
    const events = symmetricEvents();
    const verdict = evaluateGainRecommendationGates({
      axis: 'yaw', metric: 'trackingRmsDps', mechanical: rotorOrderOnlyStub(),
      capture: captureFor(events), evidence: evidenceFor(events), events,
      sweep: unanimousSweep()
    });
    assert.equal(verdict.mayRecommend, true,
      `blocked by ${verdict.blockedBy.join(', ')}: ${verdict.sentences.map(s => s.code)}`);
  });

test('anything other than main-rotor 1/rev or 2/rev still blocks, each on its own', () => {
  const disqualifiers = [
    ['an attention peak matching no rotor order', stub => withAxis(stub, 'roll', entry => ({
      ...entry, peaks: [{...entry.peaks[0], harmonicMatch: null}, entry.peaks[1]]
    }))],
    ['an attention peak matched to the TAIL rotor', stub => withAxis(stub, 'pitch', entry => ({
      ...entry,
      peaks: [{...entry.peaks[0], harmonicMatch: {...entry.peaks[0].harmonicMatch, rotor: 'tail'}},
        entry.peaks[1]]
    }))],
    ['an attention peak on main-rotor order 3', stub => withAxis(stub, 'roll', entry => ({
      ...entry,
      peaks: [entry.peaks[0], {...entry.peaks[1], harmonicMatch: {
        ...entry.peaks[1].harmonicMatch, order: 3, predictedHz: 90}}]
    }))],
    ['rotor correlation not evaluated',
      stub => ({...stub, harmonicCorrelation: {state: 'unavailable', evaluated: false}})],
    ['rotor correlation never attempted',
      stub => ({...stub, harmonicCorrelation: {state: 'not-evaluated', evaluated: false}})],
    ['one axis measured on the FILTERED gyro', stub => withAxis(stub, 'yaw', entry => ({
      ...entry, source: 'gyroADC-filtered'
    }))],
    ['one axis not available', stub => withAxis(stub, 'pitch', entry => ({
      ...entry, available: false
    }))],
    ['one axis missing altogether',
      stub => ({...stub, axes: stub.axes.filter(entry => entry.axis !== 'yaw')})],
    ['any other reason code on the result (a gap in part of the window)', stub => ({
      ...stub, reasonCodes: [...stub.reasonCodes, 'TIMING_GAPS_EXCESSIVE']
    })],
    ['a reason code only the upstream gate carries', stub => ({
      ...stub, tuningEvidenceGate: {
        status: 'blocked', reasonCodes: [...stub.tuningEvidenceGate.reasonCodes, 'FILTERED_GYRO_SOURCE_USED']
      }
    })],
    ['one analysed stretch that could not be measured', stub => ({
      ...stub, chunks: [{status: 'attention'}, {status: 'insufficient'}]
    })],
    ['attention status with no attention-eligible peak to explain it', stub => ({
      ...stub, axes: stub.axes.map(entry => ({...entry, peaks: []}))
    })],
    // The peak list is what the rule reads. One that left out an attention-level
    // peak, or does not say whether it did, cannot support "every one is the rotor".
    ['an attention-level peak the analyser found but did not list', stub => withAxis(stub,
      'pitch', entry => ({...entry, attentionEligibleUnlistedCount: 1}))],
    ['a peak list that does not say whether it is complete', stub => withAxis(stub,
      'yaw', entry => {
        const {attentionEligibleUnlistedCount: omitted, ...rest} = entry;
        return rest;
      })],
    ['a tone whose size was not measured', stub => withAxis(stub, 'roll', entry => ({
      ...entry, peaks: [{...entry.peaks[0], bandRmsDps: null}, entry.peaks[1]]
    }))],
    // The ceiling is judged on the size while present; without it a tone present
    // a third of the flight cannot be told from one present throughout.
    ['a tone whose size while present was not measured', stub => withAxis(stub, 'roll', entry => ({
      ...entry, peaks: [{...entry.peaks[0], attentionWindowBandRmsDps: null}, entry.peaks[1]]
    }))],
    ['no attention level published to judge the tones against', stub => ({
      ...stub, attentionThreshold: undefined
    })]
  ];

  for (const [name, mutate] of disqualifiers) {
    const gate = evaluateAirframeGate(mutate(rotorOrderOnlyStub()));
    assert.equal(gate.status, 'blocked', `${name} must still block`);
    assert.ok(gate.codes.includes('MECHANICAL_EVIDENCE_GATE_BLOCKED'),
      `${name}: expected the measured-vibration block, got [${gate.codes.join(', ')}]`);
    assert.equal(gate.measured.rotorOrderTonesOnly, false, name);
    assert.deepEqual([...gate.observations], [], `${name}: no rotor-order observation`);
    // Why the rule did not apply is published, so the card can say it.
    assert.equal(typeof gate.measured.rotorOrderRefusal, 'string',
      `${name}: the refusal must name its reason`);
  }

  // Not-attention is not this rule's business at all: an unmeasured result
  // carrying main-order peaks is still a missing measurement.
  const unmeasured = evaluateAirframeGate(rotorOrderOnlyStub({status: 'insufficient'}));
  assert.equal(unmeasured.status, 'blocked');
  assert.ok(unmeasured.codes.includes('MECHANICAL_EVIDENCE_NOT_MEASURED'));
  assert.equal(unmeasured.measured.rotorOrderTonesOnly, false);
});

/* ---------------------------------------------------------------------------
 * The rule reads a peak LIST, and a list can be cut short. Review of 2 October
 * 2026: the analyser kept five peaks per axis, ranked by persistence and then
 * prominence, BEFORE it asked which of them were attention-level. An unmatched
 * tone above the level that ranked sixth was thrown away and the rule passed
 * the flight; with enough small whole-flight tones, the 1/rev itself was thrown
 * away and the flight read "clear".
 * ------------------------------------------------------------------------- */

/** Deterministic PRNG, so a failing configuration is reproducible from its seed. */
function rng(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Gyro tones under a steady 1800 rpm head — the real analyser's input. `tones`
 * go on roll over quiet pitch and yaw; `axisTones` gives each axis its own set.
 * A tone may carry `fromS`/`toS` to be present for only part of the window,
 * which is what sets its persistence and so its rank.
 */
function toneFlight({tones = [], axisTones = null, seed, rateHz = 1000, seconds = 20}) {
  const random = rng(seed);
  const count = Math.round(rateHz * seconds);
  const sets = axisTones ?? {roll: tones, pitch: [], yaw: []};
  const timeUs = new Float64Array(count);
  const gyro = {roll: new Float64Array(count), pitch: new Float64Array(count),
    yaw: new Float64Array(count)};
  const head = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    const at = index / rateHz;
    timeUs[index] = Math.round(at * 1e6);
    for (const axis of ['roll', 'pitch', 'yaw']) {
      let value = 0;
      for (const tone of sets[axis]) {
        if (at >= (tone.fromS ?? 0) && at <= (tone.toS ?? Infinity)) {
          value += tone.amp * Math.sin(2 * Math.PI * tone.hz * at + (tone.phase ?? 0));
        }
      }
      gyro[axis][index] = value + (random() - 0.5);
    }
    head[index] = 1800 + (random() - 0.5) * 4;
  }
  return {
    timeUs,
    gyro,
    gyroSources: {roll: 'gyroRAW', pitch: 'gyroRAW', yaw: 'gyroRAW'},
    headspeedRpm: head,
    tailspeedRpm: new Float64Array(count).fill(Number.NaN)
  };
}

const wholeWindow = series => ({
  timeRangeUs: {startTimeUs: series.timeUs[0], endTimeUs: series.timeUs[series.timeUs.length - 1]}
});

// At 1800 rpm the head turns at 30 Hz. These sit on its orders 2 to 8...
const MAIN_ORDER_HZ = Object.freeze([60, 90, 120, 150, 180, 210, 240]);
// ...and these sit half-way between two orders, or past the eighth: 15 Hz from
// anything the head predicts, so the analyser's own match leaves them unmatched.
const OFF_ORDER_HZ = Object.freeze([45, 75, 105, 135, 165, 195, 225, 255, 285, 315, 345, 375, 405]);
/** MAX_PEAKS_PER_AXIS in mechanical-spectrum.mjs: the cap this hole lived behind. */
const LISTED_PEAK_CAP = 5;

test('an unexplained attention-level peak is never cut from the list, at any rank, and the '
  + 'rotor-order rule never passes over it', async () => {
  const random = rng(2026);
  const pick = list => list.splice(Math.floor(random() * list.length), 1)[0];
  const ranksSeen = new Set();
  const unlisted = [];
  let configuration = 0;
  /**
   * One axis's peak set: the main 1/rev for the whole flight, `ahead` small
   * whole-flight tones (rotor orders and not), and one or two small tones present
   * for under half of it — plus, on the chosen axis, THE tone.
   */
  const peakSet = (ahead, oneRevDps, hiddenHz) => {
    const orders = [...MAIN_ORDER_HZ];
    const offOrder = OFF_ORDER_HZ.filter(hz => hz !== hiddenHz);
    const tones = [{hz: 30, amp: oneRevDps}];
    for (let index = 0; index < ahead; index += 1) {
      const pool = random() < 0.6 && orders.length > 0 ? orders : offOrder;
      tones.push({hz: pick(pool), amp: 2.5 + random() * 3.5, phase: random() * 6});
    }
    if (hiddenHz !== null) {
      // Matching no rotor order, above the attention level, present for 62-85%
      // of the window: sustained enough to be attention-eligible, short enough to
      // rank behind every whole-flight tone on persistence.
      tones.push({hz: hiddenHz, amp: 20 + random() * 6, toS: 20 * (0.62 + random() * 0.23)});
    }
    const behind = Math.min(1 + Math.floor(random() * 2), 12 - tones.length);
    for (let index = 0; index < behind; index += 1) {
      tones.push({hz: pick(offOrder), amp: 2.5 + random() * 3, fromS: 20 * (0.52 + random() * 0.1)});
    }
    return tones;
  };
  for (let ahead = 0; ahead <= 9; ahead += 1) {
    for (const oneRevDps of [20, 5]) {
      for (let repeat = 0; repeat < 2; repeat += 1) {
        configuration += 1;
        const hiddenAxis = ['roll', 'pitch', 'yaw'][configuration % 3];
        const hiddenHz = OFF_ORDER_HZ[Math.floor(random() * OFF_ORDER_HZ.length)];
        // Every axis gets its own random set; only one carries the tone.
        const axisTones = {};
        for (const axis of ['roll', 'pitch', 'yaw']) {
          axisTones[axis] = axis === hiddenAxis
            ? peakSet(ahead, oneRevDps, hiddenHz)
            : peakSet(Math.floor(random() * 10), oneRevDps, null);
        }
        const tones = axisTones[hiddenAxis];
        assert.ok(tones.length >= 3 && tones.length <= 12, `${tones.length} tones`);

        const series = toneFlight({axisTones, seed: 7000 + configuration});
        const mechanical = await spectrum.analyzeMechanicalWindow(series, wholeWindow(series));
        const carrier = mechanical.axes.find(axis => axis.axis === hiddenAxis);
        const listed = JSON.stringify(carrier.peaks.map(peak => [peak.frequencyHz,
          peak.persistenceRatio, peak.attentionEligible,
          peak.harmonicMatch ? peak.harmonicMatch.order : null]));
        const label = `configuration ${configuration}: ${ahead} small tones ahead on `
          + `${hiddenAxis}, 1/rev at ${oneRevDps} deg/s, unexplained tone at ${hiddenHz} Hz; `
          + `listed ${listed}`;

        const hidden = carrier.peaks.find(peak => Math.abs(peak.frequencyHz - hiddenHz) <= 3);
        assert.ok(hidden && hidden.attentionEligible === true && hidden.harmonicMatch === null,
          `${label}: the unexplained attention-level tone is not in the list`);
        // Its rank is set by construction: behind the 1/rev and every small
        // whole-flight tone, on persistence. The listed list can no longer show
        // that rank — that is the fix — so the construction is checked on what it
        // does show: every whole-flight tone listed outranks it.
        const wholeFlight = tones.filter(tone => tone.fromS === undefined && tone.toS === undefined);
        for (const peak of carrier.peaks) {
          if (wholeFlight.some(tone => Math.abs(tone.hz - peak.frequencyHz) <= 3)) {
            assert.ok(peak.persistenceRatio > hidden.persistenceRatio,
              `${label}: a whole-flight tone does not outrank the hidden one`);
          }
        }
        ranksSeen.add(wholeFlight.length);
        if (oneRevDps === 20) {
          for (const axis of mechanical.axes) {
            assert.ok(axis.peaks.some(peak => peak.attentionEligible === true
              && peak.harmonicMatch?.rotor === 'main' && peak.harmonicMatch.order === 1),
            `${label}: the attention-level 1/rev is not in the ${axis.axis} list`);
          }
        }
        assert.equal(mechanical.status, 'attention',
          `${label}: an attention-level tone was measured and the flight reads ${mechanical.status}`);

        const gate = evaluateAirframeGate(mechanical);
        assert.equal(gate.measured.rotorOrderTonesOnly, false,
          `${label}: the rotor-order rule passed a flight carrying unexplained vibration`);
        assert.equal(gate.status, 'blocked', label);
        assert.ok(gate.codes.includes('MECHANICAL_EVIDENCE_GATE_BLOCKED'), `${label}: ${gate.codes}`);

        // The list says of itself that it holds every attention-level peak.
        for (const axis of mechanical.axes) {
          if (axis.attentionEligibleUnlistedCount !== 0) {
            unlisted.push(`${label}: ${axis.axis} ${axis.attentionEligibleUnlistedCount}`);
          }
        }
      }
    }
  }
  assert.deepEqual(unlisted, [], 'every axis must publish a measured zero');
  // The sweep must actually have reached the ranks the cap used to cut, and
  // every rank from the second to the eleventh, or it proves nothing about them.
  const ranks = [...ranksSeen].sort((left, right) => left - right);
  for (let rank = 1; rank <= 10; rank += 1) {
    assert.ok(ranksSeen.has(rank), `no configuration put the tone at rank ${rank}: ${ranks}`);
  }
  assert.ok(ranks.at(-1) >= LISTED_PEAK_CAP, `${ranks}`);
});

test('a peak list that held more attention-level peaks than it shows is never read as complete',
  () => {
    // The analyser merges two attention-level peaks closer together than it can
    // resolve into one entry. It publishes how many it merged; the rule reads that
    // count and refuses on anything but a measured zero.
    for (const [name, count] of [['one merged', 1], ['three merged', 3], ['not published', undefined],
      ['not a number', Number.NaN]]) {
      const gate = evaluateAirframeGate(withAxis(rotorOrderOnlyStub(), 'roll',
        entry => ({...entry, attentionEligibleUnlistedCount: count})));
      assert.equal(gate.status, 'blocked', name);
      assert.equal(gate.measured.rotorOrderTonesOnly, false, name);
      assert.equal(gate.measured.rotorOrderRefusal, 'ATTENTION_PEAK_LIST_INCOMPLETE', name);
    }
    assert.equal(evaluateAirframeGate(rotorOrderOnlyStub()).status, 'permitted',
      'the control: a list that says it is complete');
  });

/* ---------------------------------------------------------------------------
 * The severity ceiling. Decided 2 October 2026 as a safety refinement of the
 * owner's rotor-order rule: a once- or twice-per-rev is reported rather than
 * blocking only while it is at most three times the experimental level. Past
 * that it is the size a badly out-of-track or out-of-balance head produces, and
 * it blocks again — as its own measurement, not as "unexplained".
 * ------------------------------------------------------------------------- */

test('a main-rotor tone past three times the attention level blocks again, on its own code',
  async () => {
    assert.equal(GAIN_GATE_THRESHOLDS.rotorOrderToneCeilingMultiple, 3,
      'the ceiling is a safety backstop decided as a number, and is pinned as one');
    const outcomes = {reported: 0, large: 0};
    for (const [order, frequencyHz] of [[1, 30], [2, 60]]) {
      for (let amplitude = 14; amplitude <= 74; amplitude += 4) {
        const series = toneFlight({tones: [{hz: frequencyHz, amp: amplitude}],
          seed: 400 + amplitude * 3 + order});
        const mechanical = await spectrum.analyzeMechanicalWindow(series, wholeWindow(series));
        const label = `order ${order} at ${amplitude} deg/s`;
        const attention = mechanical.axes.flatMap(axis =>
          axis.peaks.filter(peak => peak.attentionEligible === true));
        // The fixture must be the rule's own case: every attention peak a
        // main-rotor tone of this order, and the list complete.
        assert.ok(attention.length > 0 && attention.every(peak =>
          peak.harmonicMatch?.rotor === 'main' && peak.harmonicMatch.order === order),
        `${label}: ${JSON.stringify(attention.map(peak => [peak.frequencyHz, peak.harmonicMatch]))}`);
        // Judged on the tone's size WHILE PRESENT, which for a tone above the
        // level in every window is its flight average to the rounding.
        for (const peak of attention) {
          assert.ok(Math.abs(peak.attentionWindowBandRmsDps - peak.bandRmsDps) <= 0.002,
            `${label}: a steady tone's size while present is its average: ${JSON.stringify(peak)}`);
        }
        const worst = Math.max(...attention.map(peak => peak.attentionWindowBandRmsDps));
        const ceilingDps = 3 * mechanical.attentionThreshold.bandRmsDps;

        const gate = evaluateAirframeGate(mechanical);
        if (worst <= ceilingDps) {
          outcomes.reported += 1;
          assert.equal(gate.status, 'permitted', `${label} (${worst} deg/s): ${gate.codes}`);
          assert.equal(gate.measured.rotorOrderTonesOnly, true, label);
          assert.deepEqual([...gate.measured.rotorOrderTonesLarge], [], label);
        } else {
          outcomes.large += 1;
          assert.equal(gate.status, 'blocked', `${label} (${worst} deg/s) passed the airframe`);
          assert.deepEqual([...gate.codes], ['MAIN_ROTOR_ORDER_TONE_LARGE'], label);
          assert.equal(gate.measured.rotorOrderTonesOnly, false, label);
          assert.deepEqual([...gate.measured.rotorOrderTones], [], label);
          assert.ok(gate.measured.rotorOrderTonesLarge.some(tone =>
            tone.aboveLevelBandRmsDps === worst),
          `${label}: the tone that crossed the ceiling must be published`);
          assert.equal(gate.measured.rotorOrderToneCeilingDps, ceilingDps, label);
          assert.deepEqual([...gate.observations], [], label);
        }
      }
    }
    assert.ok(outcomes.reported >= 4 && outcomes.large >= 4,
      `the sweep must straddle the ceiling: ${JSON.stringify(outcomes)}`);

    // The boundary itself, to the hundredth: at the ceiling is reported, past it
    // is not. A steady tone: its size while present is its average.
    const sized = (whilePresent, average = whilePresent) => withAxis(rotorOrderOnlyStub(), 'roll',
      entry => ({...entry, peaks: [{...entry.peaks[0], bandRmsDps: average,
        attentionWindowBandRmsDps: whilePresent}, entry.peaks[1]]}));
    assert.equal(evaluateAirframeGate(sized(24)).status, 'permitted');
    assert.deepEqual([...evaluateAirframeGate(sized(24.01)).codes], ['MAIN_ROTOR_ORDER_TONE_LARGE']);
    // An intermittent tone is judged on its size while present, never on the
    // flight average its quiet stretches pull down (round-2 review: a 1/rev at
    // 3.5-5.3 times the level, present for a third of the flight, averaged
    // under the ceiling and was waved through).
    assert.equal(evaluateAirframeGate(sized(24, 13.2)).status, 'permitted');
    assert.deepEqual([...evaluateAirframeGate(sized(24.01, 13.2)).codes],
      ['MAIN_ROTOR_ORDER_TONE_LARGE']);
    assert.deepEqual([...evaluateAirframeGate(sized(42.4, 22.3)).codes],
      ['MAIN_ROTOR_ORDER_TONE_LARGE']);
    // And it scales with the published level, not with a copy of the number 8.
    assert.deepEqual([...evaluateAirframeGate({...sized(24.01),
      attentionThreshold: {bandRmsDps: 10, basis: 'experimental-synthetic-calibration'}}).codes], []);
  });

test('a main-rotor tone past the ceiling is named as large whatever else stops the rotor-order '
  + 'rule', () => {
    // Round-2 review: the ceiling was checked only after every completeness
    // refusal had passed, so a 40 deg/s once-per-rev on a window with one stretch
    // unmeasured was reported exactly like a 13.6 deg/s one — as vibration whose
    // origin "could not be established". It still blocks; now it is also named.
    const large = stub => withAxis(stub, 'roll', entry => ({...entry, peaks: [
      {...entry.peaks[0], bandRmsDps: 40.8, attentionWindowBandRmsDps: 40.8}, entry.peaks[1]]}));
    const others = [
      ['one analysed stretch that could not be measured', 'STRETCH_NOT_MEASURED', stub => ({
        ...stub, chunks: [{status: 'attention', harmonicCorrelationState: 'evaluated'},
          {status: 'insufficient', harmonicCorrelationState: 'not-evaluated'}],
        harmonicCorrelation: {state: 'not-evaluated', evaluated: false}})],
      // A window in stretches whose other stretch's head speed moved: the tone's
      // own stretch was compared and matched, the window as a whole was not.
      ['the rotor not compared across all of the window', 'ROTOR_NOT_COMPARED', stub => ({
        ...stub, harmonicCorrelation: {state: 'unavailable', evaluated: false}})],
      ['another reason code on the result', 'REASON_CODE_OUTSIDE_ALLOW_LIST', stub => ({
        ...stub, reasonCodes: [...stub.reasonCodes, 'TIMING_GAPS_EXCESSIVE']})],
      ['another axis measured on the filtered gyro', 'AXIS_NOT_MEASURED_ON_UNFILTERED_GYRO',
        stub => withAxis(stub, 'yaw', entry => ({...entry, source: 'gyroADC-filtered'}))],
      ['a peak list that is not complete', 'ATTENTION_PEAK_LIST_INCOMPLETE',
        stub => withAxis(stub, 'pitch', entry => ({...entry, attentionEligibleUnlistedCount: 1}))],
      ['an attention peak matching no rotor order', 'ATTENTION_PEAK_NOT_MAIN_ORDER_1_OR_2',
        stub => withAxis(stub, 'pitch', entry => ({...entry, peaks: [
          {...entry.peaks[0], harmonicMatch: null}, entry.peaks[1]]}))]
    ];
    for (const [name, refusal, other] of others) {
      const gate = evaluateAirframeGate(other(large(rotorOrderOnlyStub())));
      assert.equal(gate.status, 'blocked', name);
      assert.ok(gate.codes.includes('MAIN_ROTOR_ORDER_TONE_LARGE'),
        `${name}: a 40.8 deg/s once-per-rev must be named as large: [${gate.codes}]`);
      assert.equal(gate.codes[0], 'MAIN_ROTOR_ORDER_TONE_LARGE', `${name}: it leads: [${gate.codes}]`);
      // The other condition still blocks on its own account, and is still named.
      assert.ok(gate.codes.includes('MECHANICAL_EVIDENCE_GATE_BLOCKED'), `${name}: [${gate.codes}]`);
      assert.equal(gate.measured.rotorOrderRefusal, refusal, name);
      assert.equal(gate.measured.rotorOrderTonesOnly, false, name);
      assert.ok(gate.measured.rotorOrderTonesLarge.some(tone => tone.axis === 'roll'
        && tone.order === 1 && tone.aboveLevelBandRmsDps === 40.8),
      `${name}: ${JSON.stringify(gate.measured.rotorOrderTonesLarge)}`);
      assert.deepEqual([...gate.observations], [], name);
      // The control: the same refusal without the large tone names no size.
      const small = evaluateAirframeGate(other(rotorOrderOnlyStub()));
      assert.ok(!small.codes.includes('MAIN_ROTOR_ORDER_TONE_LARGE'), `${name}: [${small.codes}]`);
      assert.equal(small.measured.rotorOrderRefusal, refusal, `${name} (control)`);
    }
    // A tone the rule cannot call the rotor's is not called large: on a filtered
    // axis, or matched to nothing.
    for (const [name, mutate] of [
      ['the large tone on a filtered axis', stub => withAxis(stub, 'roll', entry => ({
        ...entry, source: 'gyroADC-filtered'}))],
      ['the large tone matched to no rotor order', stub => withAxis(stub, 'roll', entry => ({
        ...entry, peaks: [{...entry.peaks[0], harmonicMatch: null}, entry.peaks[1]]}))]
    ]) {
      const gate = evaluateAirframeGate(mutate(large(rotorOrderOnlyStub())));
      assert.equal(gate.status, 'blocked', name);
      assert.ok(!gate.codes.includes('MAIN_ROTOR_ORDER_TONE_LARGE'), `${name}: [${gate.codes}]`);
    }
  });

test('the same tone measured in two stretches is one tone, at its worst', () => {
  const peak = (bandRmsDps, chunkRangeUs) => ({
    frequencyHz: 29.3, bandRmsDps, attentionWindowBandRmsDps: bandRmsDps,
    attentionPersistenceRatio: 1, bandwidthHz: 2, persistenceRatio: 1, attentionEligible: true,
    harmonicMatch: {rotor: 'main', order: 1, predictedHz: 30, deltaHz: 0.7, toleranceHz: 2.9,
      spreadHz: 0.15, frequencyResolutionHz: 1.953},
    chunkRangeUs
  });
  const first = [0, 150_000_000];
  const second = [150_000_000, 300_000_000];
  const stub = rotorOrderOnlyStub({
    range: {startTimeUs: 0, endTimeUs: 300_000_000},
    chunks: [{status: 'attention', startTimeUs: 0, endTimeUs: 150_000_000},
      {status: 'attention', startTimeUs: 150_000_000, endTimeUs: 300_000_000}],
    axes: ['roll', 'pitch', 'yaw'].map(axis => ({
      axis, source: 'gyroRAW', available: true, attentionEligibleUnlistedCount: 0,
      peaks: axis === 'roll' ? [peak(13.5, first), peak(14.2, second)] : []
    }))
  });
  const gate = evaluateAirframeGate(stub);
  assert.equal(gate.status, 'permitted', `${gate.codes}`);
  const tones = gate.measured.rotorOrderTones;
  assert.equal(tones.length, 1, `one roll once-per-rev, not one per stretch: ${JSON.stringify(tones)}`);
  assert.equal(tones[0].bandRmsDps, 14.2, 'the worst stretch speaks for it');
  assert.deepEqual([...tones[0].chunkRangeUs], second, 'and names the stretch it was worst in');
  assert.deepEqual(tones[0].chunkRangesUs.map(range => [...range]), [first, second],
    'and every stretch it was measured in');
});

/* ---------------------------------------------------------------------------
 * Stage 2d, airframe review of 3 October 2026.
 * ------------------------------------------------------------------------- */

test('a tone\'s worst stretch is the one it was largest in while present, not the one with the '
  + 'larger average', () => {
    // Stage 2d, item 6 (case W). The ceiling is judged on the size while present,
    // and so is which stretch a tone measured twice is worst in. Picked by the
    // average instead, a once-per-rev steady at 21 deg/s in one stretch and at
    // 31 deg/s for a third of the next — 17 deg/s averaged over it — read 21,
    // under the ceiling, and the flight was passed.
    const first = [0, 150_000_000];
    const second = [150_000_000, 300_000_000];
    for (const [steady, loud, average] of [[21.1, 30.7, 16.7], [22.1, 32.6, 19.4], [19.2, 26.8, 17.2]]) {
      const peak = (bandRmsDps, whilePresent, share, chunkRangeUs) => ({
        frequencyHz: 29.3, bandRmsDps, attentionWindowBandRmsDps: whilePresent,
        attentionPersistenceRatio: share, bandwidthHz: 2, persistenceRatio: share,
        attentionEligible: true, chunkRangeUs,
        harmonicMatch: {rotor: 'main', order: 1, predictedHz: 30, deltaHz: 0.7, toleranceHz: 2.9,
          spreadHz: 0.15, frequencyResolutionHz: 1.953}
      });
      const gate = evaluateAirframeGate(rotorOrderOnlyStub({
        range: {startTimeUs: 0, endTimeUs: 300_000_000},
        chunks: [{status: 'attention', startTimeUs: 0, endTimeUs: 150_000_000},
          {status: 'attention', startTimeUs: 150_000_000, endTimeUs: 300_000_000}],
        axes: ['roll', 'pitch', 'yaw'].map(axis => ({
          axis, source: 'gyroRAW', available: true, attentionEligibleUnlistedCount: 0,
          peaks: axis === 'roll'
            ? [peak(steady, steady, 1, first), peak(average, loud, 0.35, second)] : []
        }))
      }));
      const label = `steady ${steady} in the first stretch, ${loud} while present (${average} `
        + `averaged) in the second`;
      // The fixture is the case: the averages order the stretches one way, the
      // sizes while present the other.
      assert.ok(steady > average && loud > steady, label);
      assert.equal(gate.status, 'blocked', `${label}: ${gate.codes}`);
      assert.deepEqual([...gate.codes], ['MAIN_ROTOR_ORDER_TONE_LARGE'], label);
      const [tone] = gate.measured.rotorOrderTonesLarge;
      assert.equal(tone.aboveLevelBandRmsDps, loud, label);
      assert.equal(tone.bandRmsDps, average, `${label}: the worst stretch's own average beside it`);
      assert.deepEqual([...tone.chunkRangeUs], second, label);
    }
  });

/**
 * One tone on roll that was above the attention level in part of the range and
 * is not attention-eligible, the way the analyser lists one, over a clear result.
 */
function aboveLevelInPartStub({whilePresent, share = 0.22, match, frequencyHz = 29.3,
  status = 'clear', ...overrides}) {
  return mechanicalStub({
    status,
    reasonCodes: ['PERSISTENT_NARROWBAND_ENERGY_BELOW_ATTENTION_THRESHOLD'],
    axes: ['roll', 'pitch', 'yaw'].map(axis => ({
      axis, source: 'gyroRAW', available: true, attentionEligibleUnlistedCount: 0,
      peaks: axis !== 'roll' ? [] : [{
        frequencyHz, bandRmsDps: whilePresent === null ? 5.1 : whilePresent * Math.sqrt(share),
        attentionWindowBandRmsDps: whilePresent, attentionPersistenceRatio: whilePresent === null ? 0 : share,
        attentionWindowSizeIsLowerBound: false, bandwidthHz: 2, persistenceRatio: share + 0.05,
        attentionEligible: false, harmonicMatch: match
      }]
    })),
    ...overrides
  });
}

const MATCHES = Object.freeze({
  'main 1/rev': {rotor: 'main', order: 1, predictedHz: 30, deltaHz: 0.7, toleranceHz: 2.9,
    spreadHz: 0.15, frequencyResolutionHz: 1.953},
  'main 2/rev': {rotor: 'main', order: 2, predictedHz: 60, deltaHz: 0.55, toleranceHz: 2.9,
    spreadHz: 0.3, frequencyResolutionHz: 1.953},
  'no rotor order': null,
  'the tail rotor': {rotor: 'tail', order: 1, predictedHz: 29, deltaHz: 0.3, toleranceHz: 2.9,
    spreadHz: 0.1, frequencyResolutionHz: 1.953},
  'main order 3': {rotor: 'main', order: 3, predictedHz: 90, deltaHz: 0.5, toleranceHz: 2.9,
    spreadHz: 0.45, frequencyResolutionHz: 1.953}
});

test('a tone above the attention level for only part of the range is never an all-clear, and '
  + 'blocks past the ceiling', () => {
    // Stage 2d, item 1 (pre-existing on main). A tone that reached the level in
    // some windows but not enough of them, or not spread across enough of the
    // flight, is not attention-eligible, and the result reads "clear" — so the
    // gate passed it as a positive measurement of absence, over a tone measured
    // at three to six times the level while it was there.
    const events = symmetricEvents();
    for (const [name, match] of Object.entries(MATCHES)) {
      for (const whilePresent of [8, 15.5, 24, 24.01, 31, 48]) {
        // On the frequency its match names, 0.7 Hz off it: within what the head
        // speed allows, so a main 1/rev or 2/rev here IS the rotor's (item 3).
        const stub = aboveLevelInPartStub({whilePresent, match,
          frequencyHz: match ? match.predictedHz - 0.7 : 29.3});
        const gate = evaluateAirframeGate(stub);
        const label = `${name} at ${whilePresent} deg/s while present: [${gate.codes}] `
          + `${JSON.stringify(gate.observations)}`;
        const [tone, ...more] = gate.measured.tonesAboveLevelInPart;
        assert.equal(more.length, 0, label);
        assert.equal(tone.aboveLevelBandRmsDps, whilePresent, label);
        assert.equal(tone.aboveLevelShare, 0.22, label);
        assert.equal(tone.axis, 'roll', label);
        const verdict = evaluateGainRecommendationGates({
          axis: 'yaw', metric: 'trackingRmsDps', mechanical: stub,
          capture: captureFor(events), evidence: evidenceFor(events), events, sweep: unanimousSweep()
        });
        if (whilePresent <= 24) {
          // Up to the ceiling: not a blocker, and not an all-clear either — the
          // observation is what the airframe card is built from.
          assert.equal(gate.status, 'permitted', label);
          assert.ok(gate.observations.includes('TONE_ABOVE_ATTENTION_LEVEL_IN_PART'), label);
          assert.equal(tone.pastCeiling, false, label);
          assert.equal(verdict.mayRecommend, true, `${label}: ${verdict.blockedBy}`);
          continue;
        }
        assert.equal(gate.status, 'blocked', label);
        assert.equal(tone.pastCeiling, true, label);
        assert.equal(verdict.mayRecommend, false, label);
        assert.ok(!gate.observations.includes('TONE_ABOVE_ATTENTION_LEVEL_IN_PART'), label);
        if (name === 'main 1/rev' || name === 'main 2/rev') {
          // The rotor's own tone, past the ceiling: named as large, as a steady one is.
          assert.deepEqual([...gate.codes], ['MAIN_ROTOR_ORDER_TONE_LARGE'], label);
          assert.ok(gate.measured.rotorOrderTonesLarge.some(entry =>
            entry.aboveLevelBandRmsDps === whilePresent && entry.order === match.order), label);
        } else {
          // Anything else past it is vibration nothing explains.
          assert.deepEqual([...gate.codes], ['MECHANICAL_EVIDENCE_GATE_BLOCKED'], label);
          assert.deepEqual([...gate.measured.rotorOrderTonesLarge], [], label);
        }
      }
    }

    // The control: the same peak, never above the level in any window, is the
    // all-clear it always was.
    const quiet = evaluateAirframeGate(aboveLevelInPartStub({whilePresent: null,
      match: MATCHES['main 1/rev']}));
    assert.equal(quiet.status, 'permitted');
    assert.deepEqual([...quiet.observations], []);
    assert.deepEqual([...quiet.measured.tonesAboveLevelInPart], []);

    // Beside persistent rotor-order tones the rule still applies to those, and the
    // tone above the level in part is reported beside them, or blocks past the
    // ceiling, whatever it is.
    for (const [whilePresent, blocked] of [[18, false], [30, true]]) {
      const stub = withAxis(rotorOrderOnlyStub(), 'yaw', entry => ({...entry, peaks: [
        entry.peaks[0], {frequencyHz: 47, bandRmsDps: whilePresent / 2,
          attentionWindowBandRmsDps: whilePresent, attentionPersistenceRatio: 0.25,
          bandwidthHz: 2, persistenceRatio: 0.3, attentionEligible: false, harmonicMatch: null}]}));
      const gate = evaluateAirframeGate(stub);
      const label = `47 Hz at ${whilePresent} beside rotor-order tones: [${gate.codes}]`;
      assert.equal(gate.measured.rotorOrderTonesOnly, true, label);
      assert.equal(gate.status, blocked ? 'blocked' : 'permitted', label);
      if (blocked) {
        assert.deepEqual([...gate.codes], ['MECHANICAL_EVIDENCE_GATE_BLOCKED'], label);
      } else {
        assert.ok(gate.observations.includes('TONE_ABOVE_ATTENTION_LEVEL_IN_PART')
          && gate.observations.includes('MAIN_ROTOR_ORDER_TONE_ABOVE_EXPERIMENTAL_THRESHOLD'), label);
      }
    }

    // Without a published level nothing can be judged against one: it blocks.
    const unknown = evaluateAirframeGate(aboveLevelInPartStub({whilePresent: 15.5,
      match: MATCHES['main 1/rev'], attentionThreshold: undefined}));
    assert.equal(unknown.status, 'blocked', `${unknown.codes}`);
  });

test('a tone is the main rotor\'s own only where the logged head speed puts it', async () => {
  // Stage 2d, item 2. The analyser names a peak a rotor order within the wider
  // of a bin and a half, 2.5% and the head speed's spread — about 2.9 Hz at a
  // 2 Hz resolution — and the rotor-order rule took that naming as identity, so a
  // tone 5-8% off the once-per-rev, with the head speed logged steady, was let
  // through as the rotor's own. Identity now needs the peak's interpolated
  // frequency within the head speed's own spread at that order plus half a bin.
  const withMatch = (offsetHz, order, spreadHz, interpolated = true) => withAxis(
    rotorOrderOnlyStub(), 'roll', entry => ({...entry, peaks: [{
      ...entry.peaks[0], frequencyHz: 30 * order + Math.round(offsetHz / 1.953) * 1.953,
      ...(interpolated ? {interpolatedFrequencyHz: 30 * order + offsetHz} : {}),
      harmonicMatch: {...entry.peaks[0].harmonicMatch, order, predictedHz: 30 * order,
        spreadHz, frequencyResolutionHz: 1.953}
    }, entry.peaks[1]]}));
  for (const order of [1, 2]) {
    for (const spreadHz of [0.03, 0.15, 0.6]) {
      const toleranceHz = spreadHz + 1.953 / 2;
      for (const share of [0, 0.5, 0.95, 1.05, 1.5, 2.5]) {
        for (const sign of [1, -1]) {
          const offsetHz = sign * share * toleranceHz;
          const gate = evaluateAirframeGate(withMatch(offsetHz, order, spreadHz));
          const label = `order ${order}, ${offsetHz.toFixed(2)} Hz off with a ${spreadHz} Hz spread: `
            + `[${gate.codes}] ${gate.measured.rotorOrderRefusal}`;
          if (share <= 1) {
            assert.equal(gate.status, 'permitted', label);
            assert.equal(gate.measured.rotorOrderTonesOnly, true, label);
          } else {
            assert.equal(gate.status, 'blocked', label);
            assert.equal(gate.measured.rotorOrderRefusal, 'ROTOR_ORDER_MATCH_NOT_ESTABLISHED', label);
          }
        }
      }
    }
  }
  // Without the interpolated frequency the bin's own frequency is judged; without
  // the spread or the resolution the identity cannot be judged at all.
  assert.equal(evaluateAirframeGate(withMatch(0.5, 1, 0.15, false)).status, 'permitted');
  for (const missing of ['spreadHz', 'frequencyResolutionHz', 'predictedHz']) {
    const stub = withAxis(rotorOrderOnlyStub(), 'roll', entry => {
      const {[missing]: omitted, ...match} = entry.peaks[0].harmonicMatch;
      return {...entry, peaks: [{...entry.peaks[0], harmonicMatch: match}, entry.peaks[1]]};
    });
    const gate = evaluateAirframeGate(stub);
    assert.equal(gate.measured.rotorOrderRefusal, 'ROTOR_ORDER_MATCH_NOT_ESTABLISHED', missing);
  }

  // Stage 2d follow-up, item 3: identity is required past the CEILING too. A tone
  // the analyser named the once- or twice-per-rev but that sits outside what the
  // head speed allows was judged the rotor's own large tone there — "track and
  // balance the blades" — while the exemption said it was not established. Past
  // the ceiling it blocks as vibration not established as the rotor's, steady or
  // above the level for only part of the range; on the order it is still large.
  for (const order of [1, 2]) {
    const toleranceHz = 0.15 * order + 1.953 / 2;
    for (const [offsetHz, established] of [[1.5 * toleranceHz, false], [0.5 * toleranceHz, true]]) {
      const predictedHz = 30 * order;
      const match = {...MATCHES[`main ${order}/rev`], predictedHz, spreadHz: 0.15 * order};
      const steady = withAxis(rotorOrderOnlyStub(), 'roll', entry => ({...entry, peaks: [{
        ...entry.peaks[0], frequencyHz: predictedHz + offsetHz, interpolatedFrequencyHz: predictedHz + offsetHz,
        bandRmsDps: 32, attentionWindowBandRmsDps: 32, harmonicMatch: match}, entry.peaks[1]]}));
      const inPart = aboveLevelInPartStub({whilePresent: 32, match,
        frequencyHz: predictedHz + offsetHz});
      for (const [shape, stub] of [['steady', steady], ['in part', inPart]]) {
        const gate = evaluateAirframeGate(stub);
        const label = `order ${order}, ${offsetHz.toFixed(2)} Hz off (tolerance ${toleranceHz.toFixed(2)}), `
          + `${shape}, at 4x: [${gate.codes}] ${gate.measured.rotorOrderRefusal}`;
        assert.equal(gate.status, 'blocked', label);
        if (established) {
          assert.equal(gate.codes[0], 'MAIN_ROTOR_ORDER_TONE_LARGE', label);
          assert.ok(gate.measured.rotorOrderTonesLarge.some(tone => tone.aboveLevelBandRmsDps === 32), label);
          continue;
        }
        assert.ok(!gate.codes.includes('MAIN_ROTOR_ORDER_TONE_LARGE'), label);
        assert.deepEqual([...gate.measured.rotorOrderTonesLarge], [], label);
        assert.deepEqual([...gate.codes], ['MECHANICAL_EVIDENCE_GATE_BLOCKED'], label);
        if (shape === 'steady') {
          assert.equal(gate.measured.rotorOrderRefusal, 'ROTOR_ORDER_MATCH_NOT_ESTABLISHED', label);
        } else {
          const [tone] = gate.measured.tonesAboveLevelInPart;
          assert.equal(tone.blocks, 'MECHANICAL_EVIDENCE_GATE_BLOCKED', label);
        }
      }
    }
  }

  // Through the real analyser, the reviewer's case: a lone tone 1.5-4 Hz off the
  // once- or twice-per-rev of a head logged steady at 1800 rpm is never let
  // through as the rotor's own...
  let neighbours = 0;
  for (const [order, rotorHz] of [[1, 30], [2, 60]]) {
    for (const offsetHz of [1.5, 2, 2.5, 3, 3.5, 4]) {
      for (const amp of [14, 20, 28]) {
        const series = toneFlight({tones: [{hz: rotorHz + offsetHz, amp, phase: 1}],
          seed: 700 + order * 100 + offsetHz * 10 + amp});
        const mechanical = await spectrum.analyzeMechanicalWindow(series, wholeWindow(series));
        const gate = evaluateAirframeGate(mechanical);
        const named = mechanical.axes.flatMap(axis => axis.peaks.filter(peak =>
          peak.attentionEligible && peak.harmonicMatch?.rotor === 'main'
          && peak.harmonicMatch.order === order));
        const label = `${rotorHz + offsetHz} Hz at ${amp}: ${JSON.stringify(named.map(peak =>
          [peak.frequencyHz, peak.interpolatedFrequencyHz, peak.harmonicMatch]))} [${gate.codes}]`;
        assert.ok(!gate.measured.rotorOrderTonesOnly, label);
        if (named.length > 0) {
          // The analyser still names it the rotor's order; only the rule refuses.
          neighbours += 1;
          assert.equal(gate.status, 'blocked', label);
        }
      }
    }
  }
  assert.ok(neighbours >= 12, `only ${neighbours} neighbours were named a rotor order at all`);

  // ...while the rotor's own tone, at any head speed and wandering with it as a
  // governor does, still is.
  const random = rng(1907);
  for (let index = 0; index < 16; index += 1) {
    const rpm = 1500 + random() * 600;
    const wander = random() * 0.01;
    const order = index % 2 === 0 ? 1 : 2;
    const series = rotorToneFlight({rpm: at => rpm * (1 + wander * Math.sin(2 * Math.PI * 0.2 * at)),
      order, amp: 14 + random() * 14, seed: 800 + index});
    const mechanical = await spectrum.analyzeMechanicalWindow(series, wholeWindow(series));
    const gate = evaluateAirframeGate(mechanical);
    const label = `order ${order} of ${rpm.toFixed(0)} rpm wandering ${(wander * 100).toFixed(2)}%: `
      + `[${gate.codes}] ${gate.measured.rotorOrderRefusal}`;
    assert.equal(gate.status, 'permitted', label);
    assert.equal(gate.measured.rotorOrderTonesOnly, true, label);
  }
});

/** A main-rotor tone that follows `rpm(at)`, as a rotor's own tone does, on roll. */
function rotorToneFlight({rpm, order, amp, seed, rateHz = 1000, seconds = 20}) {
  const random = rng(seed);
  const count = Math.round(rateHz * seconds);
  const timeUs = new Float64Array(count);
  const quiet = new Float64Array(count);
  const roll = new Float64Array(count);
  const head = new Float64Array(count);
  let phase = 0;
  for (let index = 0; index < count; index += 1) {
    const at = index / rateHz;
    timeUs[index] = Math.round(at * 1e6);
    head[index] = rpm(at);
    phase += (2 * Math.PI * order * head[index]) / 60 / rateHz;
    roll[index] = amp * Math.sin(phase) + (random() - 0.5);
    quiet[index] = random() - 0.5;
  }
  return {timeUs, gyro: {roll, pitch: quiet, yaw: quiet},
    gyroSources: {roll: 'gyroRAW', pitch: 'gyroRAW', yaw: 'gyroRAW'},
    headspeedRpm: head, tailspeedRpm: new Float64Array(count).fill(Number.NaN)};
}

test('the measured-vibration sentence claims no rotor comparison that did not happen', () => {
  // Raised whenever vibration was measured and the rotor-order rule did not
  // apply — including when the rotor was never compared, and when every tone IS
  // the main rotor and the rule refused on other grounds.
  for (const [name, stub] of [
    ['rotor not compared', rotorOrderOnlyStub({harmonicCorrelation: {state: 'unavailable'}})],
    ['every tone the rotor, one stretch unmeasured', rotorOrderOnlyStub({
      chunks: [{status: 'attention'}, {status: 'insufficient'}]})]
  ]) {
    const gate = evaluateAirframeGate(stub);
    assert.ok(gate.codes.includes('MECHANICAL_EVIDENCE_GATE_BLOCKED'), `${name}: ${gate.codes}`);
    const sentence = describeGateBlock(gate)
      .find(entry => entry.code === 'MECHANICAL_EVIDENCE_GATE_BLOCKED').sentence;
    assert.doesNotMatch(sentence, /not explained by|do(?:es)? not explain|once- or twice-per-rev/i,
      `${name}: ${sentence}`);
  }
});

test('a window compared against the rotor over part of its length says part, never "never"',
  () => {
    const partly = evaluateAirframeGate(mechanicalStub({
      harmonicCorrelation: {state: 'not-evaluated', evaluated: false},
      chunks: [
        {status: 'clear', harmonicCorrelationState: 'evaluated'},
        {status: 'insufficient', harmonicCorrelationState: 'not-evaluated'}
      ]
    }));
    assert.equal(partly.status, 'blocked', 'part of a window is not the window');
    assert.deepEqual([...partly.codes], ['ROTOR_CORRELATION_PARTIAL']);
    // Counted as what they were: one stretch compared, of the one that was
    // measured, of two. An unmeasured stretch is not a stretch "it was measured in".
    assert.equal(partly.measured.rotorComparedStretchCount, 1);
    assert.equal(partly.measured.measuredStretchCount, 1);
    assert.equal(partly.measured.stretchCount, 2);
    const sentence = describeGateBlock(partly)[0].sentence;
    assert.match(sentence, /\bpart of\b/, sentence);
    assert.doesNotMatch(sentence, /\bnever\b/, sentence);
    // The control: no stretch compared is still "never".
    const none = evaluateAirframeGate(mechanicalStub({
      harmonicCorrelation: {state: 'not-evaluated', evaluated: false},
      chunks: [
        {status: 'insufficient', harmonicCorrelationState: 'not-evaluated'},
        {status: 'insufficient', harmonicCorrelationState: 'not-evaluated'}
      ]
    }));
    assert.deepEqual([...none.codes], ['ROTOR_CORRELATION_NOT_ATTEMPTED']);
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
