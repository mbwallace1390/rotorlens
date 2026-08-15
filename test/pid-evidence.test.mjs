import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DIRECTIONS,
  EVIDENCE_LIMITS,
  HUNTING_BAND_HZ,
  buildDirectionalStopEvidence,
  describeDirectionalComparison,
  buildHoldEvidence,
  compareDirectionalStopEvidence,
  compareHoldEvidence,
  detectHoldSegments,
  driftSignificance,
  extremes,
  interpretHoldEvidence,
  movingAverage,
  slopePerSecond,
  weightedMean,
  zeroCrossingRateHz
} from '../src/analysis/pid-evidence.mjs';

const YAW = 2;

/**
 * The shortest hold the analysis will measure, plus its settle window.
 *
 * Taken from the module rather than written out, so a fixture cannot quietly
 * stop exercising the thing it names when the derivation moves.
 */
const HOLD_US = EVIDENCE_LIMITS.minimumHoldDurationUs + 3_000_000;

/** Builds a stop-event metric of the shape the analysis aggregates. */
function stopEvent(commandSign, overrides = {}) {
  return {
    commandSign,
    stopTimeUs: 0,
    commandAmplitudeDps: 120,
    trackingRmsDps: 10,
    fastRingingRmsDps: 5,
    slowOscillationRmsDps: 2,
    headspeedRpm: 2000,
    ...overrides
  };
}

/**
 * Synthesizes a steady hold on the yaw axis.
 *
 * `error(seconds)` returns the instantaneous tracking error in deg/s, which is
 * what separates the cases the analysis has to tell apart: a constant offset, a
 * slow oscillation, or nothing worth acting on.
 */
function holdSamples({
  startUs = 0,
  durationUs = HOLD_US,
  intervalUs = 1000,
  setpointDps = 0,
  error = () => 0,
  headspeed = () => 2000,
  vbat = () => 25,
  offAxisDps = 0
} = {}) {
  const records = [];

  for (let elapsed = 0; elapsed <= durationUs; elapsed += intervalUs) {
    const seconds = elapsed / 1_000_000;
    const errorDps = error(seconds);
    const setpoint = [0, 0, 0];
    setpoint[YAW] = setpointDps;
    setpoint[0] = offAxisDps;

    const gyro = [0, 0, 0];
    gyro[YAW] = setpointDps - errorDps;

    records.push({
      timeUs: startUs + elapsed,
      setpoint,
      gyro,
      raw: [...gyro],
      terms: [8, 12, 3],
      headspeed: headspeed(seconds),
      collective: 5,
      vbat: vbat(seconds)
    });
  }

  return records;
}

/**
 * A brief command excursion, used to bound a hold at either end.
 *
 * THE LEAD-IN IT PROVIDES IS LOAD-BEARING, added 13 August 2026.
 * `buildHoldEvidence` drops a steady segment that begins at the first sample of
 * the records it was handed (CLIPPED_BY_WINDOW): there the command's history is
 * unknown, the duration is a lower bound rather than a measurement, and the
 * settle skip is being applied to an instant that may be the middle of a
 * manoeuvre. Without a lead-in these fixtures would be asserting behaviour on a
 * hold the engine is right to refuse — and no real flight begins with the
 * aircraft already trimmed and steady at the first logged sample.
 */
function excursion(startUs) {
  return holdSamples({startUs, durationUs: 200_000, setpointDps: 90, error: () => 0});
}

const LEAD_IN_US = 500_000;

/** Two holds separated by a command excursion too brief to be a hold itself. */
function twoHolds(options = {}) {
  const duration = options.durationUs ?? HOLD_US;
  const first = holdSamples({...options, startUs: LEAD_IN_US});
  const gap = excursion(LEAD_IN_US + duration + 100_000);
  const second = holdSamples({...options, startUs: LEAD_IN_US + duration + 400_000});
  return [...excursion(0), ...first, ...gap, ...second];
}

/** One hold, with the same lead-in and for the same reason. */
function oneHold(options = {}) {
  return [...excursion(0), ...holdSamples({...options, startUs: LEAD_IN_US})];
}

/** Prepends the same lead-in to a hand-built record set, shifting it clear. */
function withLeadIn(records) {
  return [
    ...excursion(0),
    ...records.map(record => ({...record, timeUs: record.timeUs + LEAD_IN_US}))
  ];
}

/** Moves a yaw-shaped record set onto another axis. */
function onAxis(records, axis) {
  const axisIndex = ['roll', 'pitch', 'yaw'].indexOf(axis);
  return records.map(record => {
    const setpoint = [0, 0, 0];
    const gyro = [0, 0, 0];
    setpoint[axisIndex] = record.setpoint[YAW];
    gyro[axisIndex] = record.gyro[YAW];
    return {...record, setpoint, gyro, raw: [...gyro]};
  });
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

test('slope recovers a known drift rate', () => {
  const times = [];
  const values = [];
  for (let index = 0; index <= 1000; index += 1) {
    times.push(index * 1000);
    values.push(2 + 3 * (index * 1000) / 1_000_000);
  }
  assert.ok(Math.abs(slopePerSecond(times, values) - 3) < 1e-6);
});

test('zero-crossing rate separates a steady offset from an oscillation', () => {
  const times = [];
  const steady = [];
  const oscillating = [];
  for (let index = 0; index <= 2000; index += 1) {
    const timeUs = index * 1000;
    times.push(timeUs);
    steady.push(5);
    oscillating.push(Math.sin(2 * Math.PI * 2 * (timeUs / 1_000_000)) * 4);
  }

  assert.equal(zeroCrossingRateHz(times, steady), 0);
  // A 2 Hz signal crosses its mean twice per cycle.
  assert.ok(Math.abs(zeroCrossingRateHz(times, oscillating) - 4) < 0.6);
});

// ---------------------------------------------------------------------------
// Directional stop evidence
// ---------------------------------------------------------------------------

test('stops are summarized per direction and never pooled', () => {
  const evidence = buildDirectionalStopEvidence([
    stopEvent('positive', {trackingRmsDps: 10}),
    stopEvent('positive', {trackingRmsDps: 12}),
    stopEvent('negative', {trackingRmsDps: 30}),
    stopEvent('negative', {trackingRmsDps: 34})
  ], {axis: 'yaw'});

  assert.equal(evidence.status, 'captured');
  assert.equal(evidence.directions.positive.directionEventCount, 2);
  assert.equal(evidence.directions.negative.directionEventCount, 2);
  assert.equal(evidence.directions.positive.trackingRmsDps, 11);
  assert.equal(evidence.directions.negative.trackingRmsDps, 32);
  // The pooled mean would have been 21.5 — a number describing neither direction.
  assert.notEqual(evidence.directions.positive.trackingRmsDps, 21.5);
});

test('yaw asymmetry is reported as a finding, not averaged away', () => {
  const evidence = buildDirectionalStopEvidence([
    stopEvent('positive', {trackingRmsDps: 10}),
    stopEvent('positive', {trackingRmsDps: 10}),
    stopEvent('negative', {trackingRmsDps: 40}),
    stopEvent('negative', {trackingRmsDps: 40})
  ], {axis: 'yaw'});

  assert.ok(evidence.codes.includes('YAW_DIRECTIONAL_ASYMMETRY_DETECTED'));
  assert.equal(evidence.directionsComparable, false);
  assert.ok(Math.abs(evidence.asymmetry.trackingRmsDps - 0.75) < 1e-9);
});

test('a symmetric axis reports no asymmetry and stays comparable', () => {
  const evidence = buildDirectionalStopEvidence([
    stopEvent('positive', {trackingRmsDps: 20}),
    stopEvent('positive', {trackingRmsDps: 21}),
    stopEvent('negative', {trackingRmsDps: 20}),
    stopEvent('negative', {trackingRmsDps: 22})
  ], {axis: 'roll'});

  assert.equal(evidence.status, 'captured');
  assert.equal(evidence.directionsComparable, true);
  assert.deepEqual(evidence.codes, []);
});

// ---------------------------------------------------------------------------
// Describing the comparison
//
// `directionsComparable` is false for two unrelated reasons, and a viewer that
// reads it as a boolean states the wrong one. A real Rotorflight 4.6 log with no
// qualifying stops was described on screen as "the two directions do not behave
// alike" while the codes beside it read INSUFFICIENT_POSITIVE_DIRECTION_STOPS.
// ---------------------------------------------------------------------------

test('no stops means no claim about the directions', () => {
  const evidence = buildDirectionalStopEvidence([], {axis: 'roll'});
  const described = describeDirectionalComparison(evidence);

  assert.equal(evidence.status, 'inconclusive');
  assert.equal(evidence.directionsComparable, false, 'the flag alone cannot tell you why');

  assert.equal(described.comparable, null, 'unknown is not the same as false');
  assert.equal(described.asymmetryRatio, null);
  assert.match(described.sentence, /not contain enough stops/);
  assert.doesNotMatch(described.sentence, /behave alike/,
    'with no stops, any statement about how the directions behave is invented');
});

test('stops in one direction only still makes no claim', () => {
  const evidence = buildDirectionalStopEvidence([
    stopEvent('positive', {trackingRmsDps: 10}),
    stopEvent('positive', {trackingRmsDps: 11})
  ], {axis: 'yaw'});
  const described = describeDirectionalComparison(evidence);

  assert.equal(described.comparable, null);
  assert.doesNotMatch(described.sentence, /behave alike/);
});

test('a genuine difference is still stated plainly', () => {
  const evidence = buildDirectionalStopEvidence([
    stopEvent('positive', {trackingRmsDps: 10}),
    stopEvent('positive', {trackingRmsDps: 10}),
    stopEvent('negative', {trackingRmsDps: 40}),
    stopEvent('negative', {trackingRmsDps: 40})
  ], {axis: 'yaw'});
  const described = describeDirectionalComparison(evidence);

  assert.equal(described.comparable, false);
  assert.ok(Math.abs(described.asymmetryRatio - 0.75) < 1e-9);
  assert.match(described.sentence, /do not behave alike/);
});

test('directions that match are reported as matching', () => {
  const evidence = buildDirectionalStopEvidence([
    stopEvent('positive', {trackingRmsDps: 20}),
    stopEvent('positive', {trackingRmsDps: 21}),
    stopEvent('negative', {trackingRmsDps: 20}),
    stopEvent('negative', {trackingRmsDps: 22})
  ], {axis: 'roll'});
  const described = describeDirectionalComparison(evidence);

  assert.equal(described.comparable, true);
  assert.match(described.sentence, /behave alike/);
});

test('stops in only one direction cannot conclude', () => {
  const evidence = buildDirectionalStopEvidence([
    stopEvent('positive'),
    stopEvent('positive'),
    stopEvent('positive')
  ], {axis: 'yaw'});

  assert.equal(evidence.status, 'inconclusive');
  assert.ok(evidence.codes.includes('INSUFFICIENT_NEGATIVE_DIRECTION_STOPS'));
  assert.equal(evidence.directions.negative.directionEventCount, 0);
});

test('events without a direction are discarded and counted, not guessed', () => {
  const evidence = buildDirectionalStopEvidence([
    stopEvent('positive'), stopEvent('positive'),
    stopEvent('negative'), stopEvent('negative'),
    stopEvent(undefined)
  ], {axis: 'yaw'});

  assert.equal(evidence.discardedEventCount, 1);
  assert.equal(evidence.totalEventCount, 4);
  assert.ok(evidence.codes.includes('DIRECTION_UNKNOWN_EVENTS_DISCARDED'));
});

test('a gain change is compared within each direction', () => {
  const baseline = buildDirectionalStopEvidence([
    stopEvent('positive', {trackingRmsDps: 20}), stopEvent('positive', {trackingRmsDps: 20}),
    stopEvent('negative', {trackingRmsDps: 20}), stopEvent('negative', {trackingRmsDps: 20})
  ], {axis: 'yaw'});

  const test_ = buildDirectionalStopEvidence([
    stopEvent('positive', {trackingRmsDps: 10}), stopEvent('positive', {trackingRmsDps: 10}),
    stopEvent('negative', {trackingRmsDps: 12}), stopEvent('negative', {trackingRmsDps: 12})
  ], {axis: 'yaw'});

  const comparison = compareDirectionalStopEvidence(baseline, test_);

  assert.equal(comparison.status, 'captured');
  assert.deepEqual(comparison.directionsCompared, [...DIRECTIONS]);
  assert.equal(comparison.directions.positive.changes.trackingRmsDps.difference, -10);
  assert.equal(comparison.directions.positive.changes.trackingRmsDps.significant, true);
  assert.equal(comparison.directions.negative.changes.trackingRmsDps.difference, -8);
});

test('a change that helps one direction and hurts the other is refused', () => {
  const baseline = buildDirectionalStopEvidence([
    stopEvent('positive', {trackingRmsDps: 20}), stopEvent('positive', {trackingRmsDps: 20}),
    stopEvent('negative', {trackingRmsDps: 20}), stopEvent('negative', {trackingRmsDps: 20})
  ], {axis: 'yaw'});

  const test_ = buildDirectionalStopEvidence([
    stopEvent('positive', {trackingRmsDps: 10}), stopEvent('positive', {trackingRmsDps: 10}),
    stopEvent('negative', {trackingRmsDps: 32}), stopEvent('negative', {trackingRmsDps: 32})
  ], {axis: 'yaw'});

  const comparison = compareDirectionalStopEvidence(baseline, test_);

  assert.ok(comparison.codes.includes('DIRECTIONAL_RESULT_CONFLICT'));
  assert.equal(comparison.status, 'inconclusive');
});

test('a direction missing from either capture is not silently pooled', () => {
  const baseline = buildDirectionalStopEvidence([
    stopEvent('positive'), stopEvent('positive'),
    stopEvent('negative'), stopEvent('negative')
  ], {axis: 'yaw'});
  const test_ = buildDirectionalStopEvidence([
    stopEvent('positive'), stopEvent('positive')
  ], {axis: 'yaw'});

  const comparison = compareDirectionalStopEvidence(baseline, test_);

  assert.equal(comparison.directions.negative.status, 'inconclusive');
  assert.ok(comparison.codes.includes('PARTIAL_DIRECTION_COVERAGE'));
});

test('directional evidence from different axes is never reported as captured', () => {
  const events = [
    stopEvent('positive'), stopEvent('positive'),
    stopEvent('negative'), stopEvent('negative')
  ];
  const roll = buildDirectionalStopEvidence(events, {axis: 'roll'});
  const yaw = buildDirectionalStopEvidence(events, {axis: 'yaw'});
  const comparison = compareDirectionalStopEvidence(roll, yaw);

  assert.equal(comparison.status, 'inconclusive');
  assert.ok(comparison.codes.includes('AXIS_MISMATCH'));
  assert.deepEqual(comparison.directionsCompared, []);
});

// ---------------------------------------------------------------------------
// Hold detection
// ---------------------------------------------------------------------------

test('holds are found and command excursions between them are not holds', () => {
  const segments = detectHoldSegments(twoHolds(), YAW);

  assert.equal(segments.length, 2, 'the 200 ms excursion must not count as a hold');
  for (const segment of segments) {
    assert.ok(segment.durationUs >= EVIDENCE_LIMITS.minimumHoldDurationUs);
  }
});

test('a hold ends when the command leaves its band', () => {
  const records = [
    ...holdSamples({startUs: 0, setpointDps: 0}),
    ...holdSamples({startUs: HOLD_US + 100_000, setpointDps: 100})
  ];

  const segments = detectHoldSegments(records, YAW);
  assert.equal(segments.length, 2);
  assert.ok(records[segments[1].startIndex].setpoint[YAW] === 100);
});

test('a hold shorter than the minimum is ignored', () => {
  assert.deepEqual(detectHoldSegments(holdSamples({durationUs: 900_000}), YAW), []);
});

test('elapsed time across a sample gap is not counted as hold evidence', () => {
  const gapStartUs = LEAD_IN_US + EVIDENCE_LIMITS.holdSettleUs + 200_000;
  const gapEndUs = gapStartUs + 2_000_000;
  const sparse = oneHold({error: () => 4}).filter(record =>
    record.timeUs <= gapStartUs || record.timeUs >= gapEndUs);

  const evidence = buildHoldEvidence(sparse, {axis: 'yaw', term: 'I'});
  assert.equal(evidence.status, 'inconclusive');
  assert.ok(evidence.codes.includes('HOLD_SAMPLE_GAP_TOO_LARGE'));
  assert.equal(evidence.holds.length, 0,
    'endpoint duration must not stand in for continuously sampled evidence');
});

// ---------------------------------------------------------------------------
// The minimum measurable span, and why it is where it is.
//
// The old 400 ms admitted windows shorter than one cycle of the slowest
// oscillation the interpretation is willing to blame on the I term. Inside such
// a window a drift and the rising side of a hunt are the same picture, and the
// least-squares line reports whichever it was handed.
// ---------------------------------------------------------------------------

test('the timing constants are derived from the hunting band, not chosen', () => {
  const [bottomHz, topHz] = HUNTING_BAND_HZ;

  // A running mean of length L has its -3 dB corner at about 0.443/L. Setting it
  // at the band top is what stops the filter length from deciding what counts as
  // in-band.
  assert.ok(
    Math.abs(EVIDENCE_LIMITS.huntingSmoothingUs - (0.443 / topHz) * 1e6) < 1,
    `smoothing window must be 0.443/${topHz} Hz, got ${EVIDENCE_LIMITS.huntingSmoothingUs} us`
  );

  // 1.2 full cycles of the slowest in-band oscillation.
  assert.ok(
    Math.abs(EVIDENCE_LIMITS.minimumHoldMeasureUs - (1.2 / bottomHz) * 1e6) < 1,
    `measurable span must be 1.2/${bottomHz} Hz, got ${EVIDENCE_LIMITS.minimumHoldMeasureUs} us`
  );

  assert.ok(
    EVIDENCE_LIMITS.minimumHoldMeasureUs >= 20 * EVIDENCE_LIMITS.huntingSmoothingUs,
    'a window a few filter lengths long is all filter transient'
  );

  // The detector must not admit a hold that the measurement will always refuse.
  assert.equal(
    EVIDENCE_LIMITS.minimumHoldDurationUs,
    EVIDENCE_LIMITS.holdSettleUs + EVIDENCE_LIMITS.minimumHoldMeasureUs
  );
});

test('a window shorter than one hunting cycle is refused, not fitted', () => {
  // Half a cycle of a 0.35 Hz wander, taken across its monotone half: the error
  // walks from -12 to +12 deg/s and back to nothing, so its mean is zero while a
  // least-squares line through it is steep and fits beautifully. This is the
  // reference flight's pitch artefact in miniature — a -15 deg/s^2 slope over a
  // 1.36 s window whose mean absolute error was 1.84 deg/s.
  const settleUs = EVIDENCE_LIMITS.holdSettleUs;
  const halfCycleUs = Math.round(1e6 / (2 * 0.35));
  const wander = seconds => -12 * Math.cos(2 * Math.PI * 0.35 * (seconds - settleUs / 1e6));

  const holdUs = settleUs + halfCycleUs;
  const records = withLeadIn([
    ...holdSamples({startUs: 0, durationUs: holdUs, error: wander}),
    // A real command excursion, so the two holds are not merged into one.
    ...holdSamples({startUs: holdUs + 100_000, durationUs: 200_000, setpointDps: 90}),
    ...holdSamples({startUs: holdUs + 400_000, durationUs: holdUs, error: wander})
  ]);

  // First: the fixture really does contain the artefact. Under the old 0.4 s
  // measurable span these windows were admitted, and what came out was a slope
  // an order of magnitude larger than the error it was fitted to.
  const asShipped = buildHoldEvidence(records, {axis: 'yaw', term: 'I'}, {
    limits: {minimumHoldMeasureUs: 400_000, minimumHoldDurationUs: 1_400_000}
  });
  assert.equal(asShipped.holds.length, 2, 'the old span admitted these windows');
  for (const hold of asShipped.holds) {
    assert.ok(Math.abs(hold.errorDriftDpsPerSecond) > 10,
      `a steep slope is fitted here: ${hold.errorDriftDpsPerSecond}`);
    assert.ok(hold.absoluteSteadyStateErrorDps < 1,
      `...to an error that is not there: ${hold.absoluteSteadyStateErrorDps}`);
    assert.ok(hold.errorDriftImpliedChangeDps > 10 * hold.absoluteSteadyStateErrorDps,
      'the change the slope implies dwarfs the error observed');
  }

  // Now with the derived span: the window is never measured at all.
  const evidence = buildHoldEvidence(records, {axis: 'yaw', term: 'I'});
  const verdict = interpretHoldEvidence(evidence);

  assert.equal(evidence.holds.length, 0, 'no window here is long enough to measure');
  assert.ok(evidence.rejectedHoldCounts.HOLD_TOO_SHORT_AFTER_SETTLE > 0
    || evidence.codes.includes('INSUFFICIENT_HOLD_SEGMENTS'));
  assert.equal(verdict.indication, 'hold');
  assert.equal(verdict.confidence, 'none');
});

// ---------------------------------------------------------------------------
// Hold evidence and interpretation
// ---------------------------------------------------------------------------

test('a standing error is measured with its sign preserved', () => {
  const evidence = buildHoldEvidence(twoHolds({error: () => 6}), {axis: 'yaw', term: 'I'});

  assert.equal(evidence.status, 'captured');
  assert.equal(evidence.summary.holdCount, 2);
  assert.equal(evidence.summary.zeroHoldCount, 2);
  assert.ok(Math.abs(evidence.summary.meanSteadyStateErrorDps - 6) < 0.01);
  assert.ok(evidence.summary.meanErrorRippleRmsDps < 0.01, 'a constant error has no ripple');
  assert.equal(evidence.summary.meanErrorCrossingRateHz, 0);
  assert.equal(evidence.summary.driftMeasuredHoldCount, 0,
    'a flat line has no drift merely because its residual variance is also zero');
  assert.equal(evidence.summary.meanErrorDriftDpsPerSecond, null);
  assert.ok(evidence.codes.includes('DRIFT_NOT_SEPARABLE_FROM_ERROR'));
});

test('too little I: standing error that is still drifting says increase', () => {
  const evidence = buildHoldEvidence(
    twoHolds({error: seconds => 5 + 2 * seconds}),
    {axis: 'yaw', term: 'I'}
  );
  const verdict = interpretHoldEvidence(evidence);

  assert.equal(verdict.indication, 'increase');
  assert.equal(verdict.confidence, 'medium');
  assert.ok(verdict.codes.includes('STEADY_STATE_ERROR_PRESENT'));
  assert.ok(verdict.codes.includes('STEADY_STATE_ERROR_DRIFTING'));
});

test('too much I: low-frequency hunting around zero says decrease', () => {
  const evidence = buildHoldEvidence(
    twoHolds({error: seconds => 5 * Math.sin(2 * Math.PI * 1.0 * seconds)}),
    {axis: 'yaw', term: 'I'}
  );
  const verdict = interpretHoldEvidence(evidence);

  assert.equal(verdict.indication, 'decrease');
  assert.ok(verdict.codes.includes('LOW_FREQUENCY_HUNTING'));
  assert.ok(!verdict.codes.includes('STEADY_STATE_ERROR_PRESENT'));
});

test('sensor noise is not mistaken for hunting', () => {
  // Real gyro error crosses its own mean tens of times a second. Before the error
  // was smoothed, a real flight with 0.8 deg/s of steady error produced a
  // confident "reduce I" purely from noise crossings.
  const noise = (() => {
    let state = 12345;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return ((state >>> 16) % 2001) / 1000 - 1; // ±1 dps, uncorrelated
    };
  })();

  const evidence = buildHoldEvidence(twoHolds({error: () => 0.5 + noise() * 3}),
    {axis: 'yaw', term: 'I'});
  const verdict = interpretHoldEvidence(evidence);

  assert.equal(verdict.indication, 'hold', 'noise must not read as an I-term fault');
  assert.ok(
    evidence.summary.meanErrorNoiseRmsDps > evidence.summary.meanErrorRippleRmsDps,
    'the fast component must be reported separately from the slow one'
  );
});

test('an oscillation too fast for the I term is never blamed on it', () => {
  // 8 Hz is frame or tail resonance, not I-term hunting, and lowering the I term
  // would not fix it. Characterizing what it *is* needs spectral analysis this
  // module does not do — so the requirement is only that it is not misattributed.
  for (const frequencyHz of [5, 8, 15]) {
    const evidence = buildHoldEvidence(
      twoHolds({error: seconds => 6 * Math.sin(2 * Math.PI * frequencyHz * seconds)}),
      {axis: 'yaw', term: 'I'}
    );
    const verdict = interpretHoldEvidence(evidence);

    assert.notEqual(
      verdict.indication, 'decrease',
      `${frequencyHz} Hz is above the band the I term can cause`
    );
  }
});

test('a clean hold recommends no change', () => {
  const evidence = buildHoldEvidence(twoHolds({error: () => 0.4}), {axis: 'yaw', term: 'I'});
  const verdict = interpretHoldEvidence(evidence);

  assert.equal(verdict.indication, 'hold');
  assert.ok(verdict.codes.includes('HOLD_EVIDENCE_WITHIN_TOLERANCE'));
});

test('both signatures at once refuses to recommend a gain change', () => {
  const evidence = buildHoldEvidence(
    twoHolds({error: seconds => 8 + 5 * Math.sin(2 * Math.PI * 1.0 * seconds)}),
    {axis: 'yaw', term: 'I'}
  );
  const verdict = interpretHoldEvidence(evidence);

  assert.equal(verdict.indication, 'hold');
  assert.equal(verdict.confidence, 'low');
  assert.ok(verdict.codes.includes('CONFLICTING_HOLD_SIGNATURES'));
});

test('inconclusive evidence never yields a recommendation', () => {
  const evidence = buildHoldEvidence(holdSamples({durationUs: 300_000}), {axis: 'yaw', term: 'I'});
  const verdict = interpretHoldEvidence(evidence);

  assert.equal(evidence.status, 'inconclusive');
  assert.equal(verdict.indication, 'hold');
  assert.equal(verdict.confidence, 'none');
});

test('an unstable governor invalidates the hold rather than reading as tune', () => {
  const evidence = buildHoldEvidence(
    twoHolds({error: () => 6, headspeed: seconds => 2000 + 300 * seconds}),
    {axis: 'yaw', term: 'I'}
  );

  assert.equal(evidence.status, 'inconclusive');
  assert.ok(evidence.codes.includes('HOLD_HEADSPEED_UNSTABLE'));
  assert.equal(evidence.holds.length, 0);
});

test('off-axis input disqualifies a hold', () => {
  const evidence = buildHoldEvidence(
    twoHolds({error: () => 6, offAxisDps: 60}),
    {axis: 'yaw', term: 'I'}
  );

  assert.ok(evidence.codes.includes('HOLD_OFF_AXIS_INPUT'));
  assert.equal(evidence.status, 'inconclusive');
});

test('a sustained-rate hold is distinguished from a hold at zero', () => {
  const evidence = buildHoldEvidence(
    twoHolds({setpointDps: 120, error: () => 6}),
    {axis: 'yaw', term: 'I'}
  );

  assert.equal(evidence.summary.sustainedHoldCount, 2);
  assert.equal(evidence.summary.zeroHoldCount, 0);
});

test('a hold that begins at the first sample is refused, and where the window opens '
  + 'cannot change the verdict', () => {
    // THE DEFECT THIS GUARDS. `ui/app.mjs` trims the session to a detected
    // takeoff before building records, so the first sample this module sees is
    // wherever that trim landed. On the reference flight, sweeping the trim
    // start made roll's I-term evidence read captured/2 holds at 18, 20, 22.76
    // and 24 seconds and inconclusive/1 at 0 and 26 — non-monotonically, with
    // the detected window sitting inside the captured region. A hold that exists
    // only because of where the cut fell was about to become a recommendation.
    const good = twoHolds({error: () => 6});
    const captured = buildHoldEvidence(good, {axis: 'yaw', term: 'I'});
    assert.equal(captured.status, 'captured',
      'the fixture must capture when its holds are interior, or nothing below means anything');
    assert.equal(captured.holds.length, 2);
    assert.equal(captured.clippedSegmentCount, 0);
    assert.ok(!captured.codes.includes('CLIPPED_BY_WINDOW'));

    // Now cut the lead-in off, so the first hold starts at sample zero. Same
    // aircraft, same holds, same everything — only the window moved.
    const cut = good.filter(record => record.timeUs >= LEAD_IN_US);
    const clipped = buildHoldEvidence(cut, {axis: 'yaw', term: 'I'});
    assert.equal(clipped.holds.length, 1,
      'the segment that begins at the first sample must not be measured');
    assert.equal(clipped.clippedSegmentCount, 1);
    assert.ok(clipped.codes.includes('CLIPPED_BY_WINDOW'),
      'and the pilot must be told a hold was seen and not used, not just shown one fewer');
    assert.equal(clipped.status, 'inconclusive',
      'one measured hold is not two, whatever the window did');

    // The END of the records is a different problem and must NOT be treated the
    // same. A hold running to the last sample was entered from a command change
    // this array contains: its settle skip is real and every number inside it is
    // measured over fully observed samples. Only its future is unknown, and that
    // changes nothing.
    const truncated = good.filter(record => record.timeUs <= LEAD_IN_US + HOLD_US * 2);
    const stillMeasured = buildHoldEvidence(truncated, {axis: 'yaw', term: 'I'});
    assert.ok(stillMeasured.holds.length >= 1,
      'a hold cut short by the end of the recording is still a measured hold');
    assert.equal(stillMeasured.clippedSegmentCount, 0);

    // And the segment flags themselves say which edge, so a caller can tell.
    const segments = detectHoldSegments(cut, YAW, {});
    assert.equal(segments[0].clippedAtStart, true);
    assert.equal(segments[0].clippedAtEnd, false);
    assert.equal(segments.at(-1).clippedAtStart, false);
  });

test('sweeping where the window opens cannot manufacture a captured I-term verdict', () => {
  // The same claim as above, made the way the defect was actually found: by
  // moving the cut across a flight and watching the verdict. A single
  // hand-picked cut can pass while the sweep it came from is non-monotonic.
  const flight = twoHolds({error: () => 6});
  const trace = [];
  for (let cutUs = 0; cutUs <= LEAD_IN_US + HOLD_US; cutUs += 25_000) {
    const records = flight.filter(record => record.timeUs >= cutUs);
    if (records.length < 100) {
      continue;
    }
    const evidence = buildHoldEvidence(records, {axis: 'yaw', term: 'I'});
    trace.push({cutUs, count: evidence.holds.length, status: evidence.status});
    // Whatever else moves, a segment starting on the edge is always reported.
    for (const segment of detectHoldSegments(records, YAW, {})) {
      if (segment.clippedAtStart) {
        assert.ok(evidence.clippedSegmentCount > 0,
          `cut at ${cutUs}: an edge segment was present and not reported as clipped`);
      }
    }
  }

  assert.ok(trace.length > 30, `the sweep must actually run, ${trace.length} points`);
  assert.equal(trace[0].status, 'captured',
    'and it must START from a captured verdict, or it is sweeping a flight with '
    + 'nothing in it to lose');

  // MONOTONE NON-INCREASING is the property the defect broke. On the reference
  // flight the hold count ran 1, 2, 2, 2, 2, 1, 1, 2 as the cut moved later —
  // evidence APPEARING because a window edge fell in the right place. Cutting
  // the front off a flight can only ever remove evidence.
  for (let at = 1; at < trace.length; at += 1) {
    assert.ok(trace[at].count <= trace[at - 1].count,
      `cutting later must never ADD a hold: at ${trace[at - 1].cutUs} us there were `
      + `${trace[at - 1].count}, at ${trace[at].cutUs} us there were ${trace[at].count}`);
  }
  assert.equal(trace.at(-1).status, 'inconclusive',
    'and with the front of the flight gone the verdict must be lost, not preserved');
});

test('hold evidence works on every axis, not just yaw', () => {
  for (const axis of ['roll', 'pitch', 'yaw']) {
    const records = onAxis(twoHolds({error: () => 6}), axis);

    const evidence = buildHoldEvidence(records, {axis, term: 'I'});
    assert.equal(evidence.status, 'captured', `${axis} hold evidence should capture`);
    assert.equal(interpretHoldEvidence(evidence).indication, 'increase', `${axis} verdict`);
  }
});

test('an I-term change is scored as improved or worsened', () => {
  const before = buildHoldEvidence(twoHolds({error: () => 8}), {axis: 'yaw', term: 'I'});
  const better = buildHoldEvidence(twoHolds({error: () => 2}), {axis: 'yaw', term: 'I'});
  const worse = buildHoldEvidence(twoHolds({error: () => 14}), {axis: 'yaw', term: 'I'});

  assert.equal(compareHoldEvidence(before, better).verdict, 'improved');
  assert.equal(compareHoldEvidence(before, worse).verdict, 'worsened');
  assert.equal(
    compareHoldEvidence(before, buildHoldEvidence(twoHolds({error: () => 8.2}),
      {axis: 'yaw', term: 'I'})).verdict,
    'unchanged',
    'a change inside tolerance is not a result'
  );
});

test('comparing a heading hold against a rate turn is refused', () => {
  const zeroHold = buildHoldEvidence(twoHolds({error: () => 6}), {axis: 'yaw', term: 'I'});
  const rateHold = buildHoldEvidence(
    twoHolds({setpointDps: 120, error: () => 6}),
    {axis: 'yaw', term: 'I'}
  );

  const comparison = compareHoldEvidence(zeroHold, rateHold);
  assert.ok(comparison.codes.includes('HOLD_KIND_MISMATCH'));
  assert.equal(comparison.status, 'inconclusive');
});

test('hold comparisons fail closed on axis, term, and mixed-kind mismatches', () => {
  const yawI = buildHoldEvidence(twoHolds({error: () => 6}), {axis: 'yaw', term: 'I'});
  const rollI = buildHoldEvidence(onAxis(twoHolds({error: () => 6}), 'roll'),
    {axis: 'roll', term: 'I'});
  const yawP = buildHoldEvidence(twoHolds({error: () => 6}), {axis: 'yaw', term: 'P'});

  const axisMismatch = compareHoldEvidence(yawI, rollI);
  assert.equal(axisMismatch.status, 'inconclusive');
  assert.ok(axisMismatch.codes.includes('AXIS_MISMATCH'));

  const termMismatch = compareHoldEvidence(yawI, yawP);
  assert.equal(termMismatch.status, 'inconclusive');
  assert.ok(termMismatch.codes.includes('TERM_MISMATCH'));

  const mixed = {
    ...yawI,
    summary: {...yawI.summary, zeroHoldCount: 1, sustainedHoldCount: 1}
  };
  const kindMismatch = compareHoldEvidence(yawI, mixed);
  assert.equal(kindMismatch.status, 'inconclusive');
  assert.ok(kindMismatch.codes.includes('HOLD_KIND_MISMATCH'));
  assert.equal(kindMismatch.verdict, 'unchanged',
    'an inconclusive API result must not carry a contradictory improved verdict');

  const interpreted = interpretHoldEvidence(mixed);
  assert.equal(interpreted.indication, 'hold');
  assert.equal(interpreted.confidence, 'none');
  assert.ok(interpreted.codes.includes('HOLD_KIND_MISMATCH'));
});

test('an invalid axis is rejected without throwing', () => {
  const evidence = buildHoldEvidence([], {axis: 'collective', term: 'I'});
  assert.equal(evidence.status, 'inconclusive');
  assert.deepEqual(evidence.codes, ['AXIS_INVALID']);
});

// ---------------------------------------------------------------------------
// Aggregating across holds
// ---------------------------------------------------------------------------

test('extremes and weightedMean survive and describe long windows', () => {
  assert.equal(extremes([]), null);
  assert.equal(extremes([Number.NaN, undefined]), null);
  assert.deepEqual(extremes([3, -1, Number.NaN, 7]), {lowest: -1, highest: 7});

  assert.equal(weightedMean([], []), null);
  assert.equal(weightedMean([5, 9], [0, 0]), null, 'no weight is not a mean of zero');
  assert.equal(weightedMean([10, 0], [3, 1]), 7.5);
  // A pair whose weight is unusable contributes nothing rather than dividing by it.
  assert.equal(weightedMean([10, 999], [4, Number.NaN]), 10);
  assert.equal(weightedMean([10, 999], [4, -2]), 10);
});

test('a long hold outweighs a short one instead of tying with it', () => {
  // One minute of near-perfect tracking and five seconds of 30 deg/s error. The
  // plain mean of the two calls that a 15 deg/s standing error and demands more
  // I; weighted by the time each was measured over, the aircraft's steady-state
  // error is 2.4 deg/s. This is the reference flight's roll axis: three holds,
  // one of them 0.41 s long, and the short one carried the verdict.
  const longUs = 60_000_000;
  const shortUs = 5_500_000;
  const records = withLeadIn([
    ...holdSamples({startUs: 0, durationUs: longUs, intervalUs: 4000, error: () => 0.3}),
    ...holdSamples({
      startUs: longUs + 100_000, durationUs: 200_000, intervalUs: 4000, setpointDps: 90
    }),
    ...holdSamples({
      startUs: longUs + 400_000, durationUs: shortUs, intervalUs: 4000, error: () => 30
    })
  ]);

  const evidence = buildHoldEvidence(records, {axis: 'yaw', term: 'I'});
  assert.equal(evidence.holds.length, 2);

  // The unweighted mean of exactly these holds, computed here so the test states
  // what it is defending against rather than assuming it.
  const plain = evidence.holds.reduce((total, hold) =>
    total + hold.absoluteSteadyStateErrorDps, 0) / evidence.holds.length;
  assert.ok(plain > 3,
    `the plain mean crosses the standing-error threshold at ${plain.toFixed(2)} deg/s`);

  assert.ok(evidence.summary.meanAbsoluteSteadyStateErrorDps < 3,
    `weighted by measured time it is ${evidence.summary.meanAbsoluteSteadyStateErrorDps}`);
  assert.notEqual(interpretHoldEvidence(evidence).indication, 'increase');
});

// ---------------------------------------------------------------------------
// A drift is an estimate, and an estimate without its uncertainty is a guess.
// ---------------------------------------------------------------------------

test('a fitted slope is reported only when it stands above its own error', () => {
  const times = [];
  const ramp = [];
  const wander = [];
  for (let index = 0; index <= 5000; index += 1) {
    const timeUs = index * 1000;
    const seconds = timeUs / 1e6;
    times.push(timeUs);
    ramp.push(4 * seconds);
    // No drift at all: one and a bit cycles of a slow wander.
    wander.push(9 * Math.sin(2 * Math.PI * 0.25 * seconds));
  }

  const smoothing = EVIDENCE_LIMITS.huntingSmoothingUs;
  const rampSlope = slopePerSecond(times, ramp);
  assert.ok(Math.abs(rampSlope - 4) < 1e-6);
  assert.ok(driftSignificance(times, movingAverage(ramp, 148), rampSlope, smoothing) > 50,
    'a line through a line is perfectly determined');

  const wanderSlope = slopePerSecond(times, wander);
  const wanderRatio = driftSignificance(times, movingAverage(wander, 148), wanderSlope, smoothing);
  assert.ok(wanderRatio < EVIDENCE_LIMITS.driftSignificanceRatio,
    `a slope through a wander is not separable from zero, got ${wanderRatio}`);
});

test('the drift gate separates real drift from wander, swept both ways', () => {
  // The failure this repo keeps shipping is a test whose inputs cannot reach the
  // fault, so this sweeps rather than picks: thousands of windows of random
  // length, frequency, amplitude, phase and noise. Half contain exactly zero
  // drift; half contain a large one. Both halves are asserted, because a gate
  // that refuses everything passes a one-sided test while measuring nothing.
  //
  // Wander frequencies are drawn from inside the hunting band. Below that band a
  // window shorter than one cycle is monotone, and an error walking one way for
  // twenty seconds *is* a drift by any measurement anyone can make — which is
  // why the minimum measurable span is derived from the band's floor rather than
  // this gate being asked to do work it cannot do.
  let state = 987654321;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  const driftThreshold = 1.5;
  const intervalUs = 10_000;
  const smoothing = EVIDENCE_LIMITS.huntingSmoothingUs;
  const smoothingSamples = Math.round(smoothing / intervalUs);

  let freeTotal = 0;
  let freeReported = 0;
  let freeWorst = 0;
  let realTotal = 0;
  let realFound = 0;

  for (let draw = 0; draw < 4000; draw += 1) {
    const durationSeconds = EVIDENCE_LIMITS.minimumHoldMeasureUs / 1e6 + random() * 16;
    const frequencyHz = HUNTING_BAND_HZ[0] + random() * (HUNTING_BAND_HZ[1] + 0.2);
    const amplitude = 0.5 + random() * 20;
    const phase = random() * 2 * Math.PI;
    const noiseScale = random() * 3;

    const isDrifting = draw % 2 === 1;
    const trueSlope = isDrifting
      ? (random() < 0.5 ? -1 : 1) * (4 + random() * 8)
      : 0;

    const times = [];
    const values = [];
    for (let timeUs = 0; timeUs <= durationSeconds * 1e6; timeUs += intervalUs) {
      const seconds = timeUs / 1e6;
      times.push(timeUs);
      values.push(
        trueSlope * seconds
        + amplitude * Math.sin(2 * Math.PI * frequencyHz * seconds + phase)
        + (random() * 2 - 1) * noiseScale
      );
    }

    const slope = slopePerSecond(times, values);
    const ratio = driftSignificance(times, movingAverage(values, smoothingSamples), slope, smoothing);
    const reported = ratio >= EVIDENCE_LIMITS.driftSignificanceRatio
      && Math.abs(slope) > driftThreshold;

    if (isDrifting) {
      realTotal += 1;
      if (reported && Math.sign(slope) === Math.sign(trueSlope)) {
        realFound += 1;
      }
    } else {
      freeTotal += 1;
      if (reported) {
        freeReported += 1;
        freeWorst = Math.max(freeWorst, Math.abs(slope));
      }
    }
  }

  assert.equal(freeReported, 0,
    `${freeReported} of ${freeTotal} drift-free windows were reported as drifting, ` +
    `worst ${freeWorst.toFixed(2)} deg/s^2`);
  assert.ok(realFound / realTotal > 0.95,
    `only ${realFound}/${realTotal} real drifts were found — the gate is refusing ` +
    'everything rather than separating anything');
});

// ---------------------------------------------------------------------------
// A steady hover is not an edge case
// ---------------------------------------------------------------------------

test('a five-minute hold is measured rather than crashing the analysis', () => {
  // measureHold once took the off-axis peak with Math.max(...window.map(...)),
  // and spanRatio took the headspeed span the same way. Both spread every sample
  // in the window into an argument list. A 60 s hold was fine; 133 s threw
  // "RangeError: Maximum call stack size exceeded" and took the whole I-term
  // analysis with it — on the single most useful manoeuvre there is.
  const hold = holdSamples({durationUs: 300_000_000, intervalUs: 1000, error: () => 0.4});
  assert.ok(hold.length > 250_000, `${hold.length} samples must exceed the spread limit`);
  const records = withLeadIn(hold);

  const evidence = buildHoldEvidence(records, {axis: 'yaw', term: 'I'});

  assert.equal(evidence.holds.length, 1);
  assert.equal(evidence.holds[0].sampleCount, hold.length - 1000);
  assert.ok(Math.abs(evidence.summary.meanAbsoluteSteadyStateErrorDps - 0.4) < 0.01);
});

// ---------------------------------------------------------------------------
// THE DECIDING TEST
//
// Three constants each individually decided the sign of the indication on the
// reference flight: the measurable span (400 ms), the smoothing window (100 ms)
// and the off-axis command limit (30 deg/s). Roll read "increase" at a 400 ms
// span and "hold" at 600 ms and above; pitch read "decrease" at exactly 100 ms
// of smoothing and "increase" at 50; pitch's "decrease" appeared only at exactly
// 30 deg/s of off-axis limit. A verdict that turns on a constant nobody derived
// is a verdict about the constant.
//
// The reference log cannot be committed, so the fixture below reproduces its
// shape: a small standing error, several dB of slow content just above the
// hunting band, holds differing in length by an order of magnitude, and two
// short windows whose local slope is steep and meaningless.
// ---------------------------------------------------------------------------

function referenceShapedFlight() {
  let state = 24680;
  const noise = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return ((state >>> 16) % 2001) / 1000 - 1;
  };

  const segments = [
    // Long, quiet, and carrying ripple just above the band the I term can cause.
    {durationUs: 20_000_000, error: seconds => 0.3 + 3 * Math.sin(2 * Math.PI * 3.6 * seconds)},
    {durationUs: 6_000_000, error: seconds => -0.5 + 2.5 * Math.sin(2 * Math.PI * 4.1 * seconds)},
    // The traps: short windows sitting on the monotone rising flank of a slow
    // wander. Same sign, so their fitted slopes reinforce rather than cancel —
    // cancellation would let the fixture pass for the wrong reason.
    {durationUs: 2_400_000, error: seconds => -12 * Math.cos(2 * Math.PI * 0.2 * seconds)},
    {durationUs: 1_500_000, error: seconds => -11 * Math.cos(2 * Math.PI * 0.22 * seconds)}
  ];

  const records = [];
  // A command excursion BEFORE the first hold, so the first hold does not begin
  // at the first sample of the array — where `buildHoldEvidence` correctly
  // refuses to measure it. See `excursion` above.
  let cursor = 0;
  records.push(...excursion(cursor));
  cursor += 500_000;
  for (const segment of segments) {
    records.push(...holdSamples({
      startUs: cursor,
      durationUs: segment.durationUs,
      error: seconds => segment.error(seconds) + noise() * 1.2
    }));
    cursor += segment.durationUs + 100_000;
    // A command excursion, so consecutive holds are not merged into one.
    records.push(...holdSamples({startUs: cursor, durationUs: 200_000, setpointDps: 90}));
    cursor += 500_000;
  }

  return records;
}

test('the fixture really does contain the verdict-flipping trap', () => {
  // Guards the deciding test below. Under the constants as they shipped, this
  // fixture produces a directional indication — so a sweep that finds none under
  // the derived constants is measuring the fix and not a harmless fixture.
  const asShipped = buildHoldEvidence(referenceShapedFlight(), {axis: 'yaw', term: 'I'}, {
    limits: {
      minimumHoldMeasureUs: 400_000,
      minimumHoldDurationUs: 1_400_000,
      huntingSmoothingUs: 100_000,
      driftSignificanceRatio: 0
    }
  });

  const unweighted = asShipped.holds.reduce(
    (total, hold) => total + hold.errorDriftDpsPerSecond, 0
  ) / asShipped.holds.length;

  assert.ok(asShipped.holds.length >= 4, `${asShipped.holds.length} holds admitted`);
  assert.ok(Math.abs(unweighted) > 1.5,
    `the plain mean of the fitted slopes is ${unweighted.toFixed(2)} deg/s^2, ` +
    'which is what used to be published as a drift');

  // Weighting alone already refuses it: the steep slopes live in 1.4 s and 0.5 s
  // windows beside 19 s and 5 s of quiet, and time-weighted they do not survive.
  assert.ok(Math.abs(asShipped.summary.meanErrorDriftDpsPerSecond) < 1.5,
    'weighting by measured duration is what stops one short window carrying an axis');

  // And under the derived constants those windows are never measured at all.
  const derived = buildHoldEvidence(referenceShapedFlight(), {axis: 'yaw', term: 'I'});
  assert.ok(derived.holds.every(hold => hold.measuredDurationUs
    >= EVIDENCE_LIMITS.minimumHoldMeasureUs));
});

test('no deciding constant can flip the indication on reference-shaped data', () => {
  const records = referenceShapedFlight();
  const seen = new Map();

  const record = (label, limits) => {
    const evidence = buildHoldEvidence(records, {axis: 'yaw', term: 'I'}, {limits});
    const verdict = interpretHoldEvidence(evidence);
    if (verdict.indication !== 'hold') {
      seen.set(label, `${verdict.indication}/${verdict.confidence}`);
    }
  };

  // The measurable span, across and well beyond its plausible neighbourhood.
  for (let spanUs = 2_000_000; spanUs <= 10_000_000; spanUs += 250_000) {
    record(`span ${spanUs}`, {
      minimumHoldMeasureUs: spanUs,
      minimumHoldDurationUs: EVIDENCE_LIMITS.holdSettleUs + spanUs
    });
  }

  // The smoothing window. The band travels with it, which is the whole point:
  // a filter that hides content above the band cannot then be used to argue the
  // content was inside it.
  for (let smoothingUs = 20_000; smoothingUs <= 400_000; smoothingUs += 10_000) {
    record(`smoothing ${smoothingUs}`, {huntingSmoothingUs: smoothingUs});
  }

  // The off-axis command limit.
  for (let offAxisDps = 5; offAxisDps <= 90; offAxisDps += 1) {
    record(`off-axis ${offAxisDps}`, {offAxisCommandLimitDps: offAxisDps});
  }

  // And the significance ratio that now gates the drift.
  for (let ratio = 1.5; ratio <= 6.001; ratio += 0.25) {
    record(`significance ${ratio}`, {driftSignificanceRatio: ratio});
  }

  assert.deepEqual([...seen.entries()], [],
    'a constant that decides the sign of the indication is deciding the diagnosis');
});

test('an unmeasurable drift is reported as absent, not as a number', () => {
  // Two layers, and each is asserted here because each is separately reachable.
  // The summary field is what the viewer prints: "-7.47 deg/s^2" beside a
  // 1.47 deg/s error is the exact number that made the reference flight's I-term
  // panel wrong, and null is the only honest thing to show in its place.
  const evidence = buildHoldEvidence(referenceShapedFlight(), {axis: 'yaw', term: 'I'});

  assert.ok(evidence.holds.length >= 2);
  assert.equal(evidence.summary.driftMeasuredHoldCount, 0);
  assert.equal(evidence.summary.meanErrorDriftDpsPerSecond, null,
    'a drift no hold could separate from zero must not be printed as a number');
  assert.ok(evidence.codes.includes('DRIFT_NOT_SEPARABLE_FROM_ERROR'));

  // The second layer: even handed a drift number, the interpretation must not
  // claim drift when nothing measured one.
  const forged = {
    kind: 'rotorlens-hold-evidence',
    status: 'captured',
    codes: [],
    summary: {
      holdCount: 3,
      zeroHoldCount: 3,
      sustainedHoldCount: 0,
      meanAbsoluteSteadyStateErrorDps: 0.5,
      meanErrorDriftDpsPerSecond: -7.47,
      driftMeasuredHoldCount: 0,
      meanErrorCrossingRateHz: 6.5,
      meanErrorRippleRmsDps: 0.9,
      meanErrorNoiseRmsDps: 0.7
    }
  };

  const verdict = interpretHoldEvidence(forged);
  assert.ok(!verdict.codes.includes('STEADY_STATE_ERROR_DRIFTING'),
    'a drift no hold measured is not a drift, whatever the summary says');
  assert.equal(verdict.indication, 'hold');

  // Same numbers with the holds behind them: now it is a finding.
  const measured = {...forged,
    summary: {...forged.summary, driftMeasuredHoldCount: 3}};
  assert.ok(interpretHoldEvidence(measured).codes.includes('STEADY_STATE_ERROR_DRIFTING'),
    'the fixture must be able to reach a drift finding, or this proves nothing');
});

test('a capture carries the settings it was measured through', () => {
  const evidence = buildHoldEvidence(referenceShapedFlight(), {axis: 'yaw', term: 'I'});

  assert.deepEqual([...evidence.measurement.huntingBandHz], [...HUNTING_BAND_HZ]);
  assert.equal(evidence.measurement.huntingSmoothingUs, EVIDENCE_LIMITS.huntingSmoothingUs);
  assert.equal(evidence.measurement.minimumHoldMeasureUs, EVIDENCE_LIMITS.minimumHoldMeasureUs);

  const custom = buildHoldEvidence(referenceShapedFlight(), {axis: 'yaw', term: 'I'},
    {limits: {huntingSmoothingUs: 222_000}});
  assert.equal(custom.measurement.huntingSmoothingUs, 222_000,
    'an overridden filter must travel with the numbers it produced');
});

test('the band the interpretation tests cannot exceed what the filter passed', () => {
  // A box average 222 ms long has its -3 dB corner at 2.0 Hz, so a 2.6 Hz
  // crossing rate measured through it is content the filter had already begun
  // removing. Judging that rate against a band reaching 3 Hz claims an in-band
  // oscillation on the strength of the filter's own roll-off — which on the
  // reference flight turned roll's "no conclusion" into a confident "decrease".
  const summary = Object.freeze({
    holdCount: 3,
    zeroHoldCount: 3,
    sustainedHoldCount: 0,
    meanAbsoluteSteadyStateErrorDps: 0.5,
    meanErrorDriftDpsPerSecond: null,
    driftMeasuredHoldCount: 0,
    meanErrorCrossingRateHz: 2.6,
    meanErrorRippleRmsDps: 4,
    meanErrorNoiseRmsDps: 1
  });
  const capture = smoothingUs => ({
    kind: 'rotorlens-hold-evidence',
    status: 'captured',
    codes: [],
    summary,
    measurement: {huntingBandHz: [0.3, 3.0], huntingSmoothingUs: smoothingUs}
  });

  // Measured through the derived 148 ms filter, whose corner is at 3 Hz, a
  // 2.6 Hz ripple genuinely is in band and is reported as hunting.
  assert.equal(
    interpretHoldEvidence(capture(EVIDENCE_LIMITS.huntingSmoothingUs)).indication,
    'decrease',
    'the fixture must be able to reach a hunting verdict, or this proves nothing'
  );

  // The same numbers measured through a 222 ms filter are not.
  assert.notEqual(interpretHoldEvidence(capture(222_000)).indication, 'decrease');

  // ...including when the caller insists on the wider band. The cap is
  // one-directional: a shorter filter reveals more but must not widen what the
  // I term is held responsible for.
  assert.notEqual(
    interpretHoldEvidence(capture(222_000), {huntingBandHz: [0.3, 3.0]}).indication,
    'decrease'
  );
  assert.equal(
    interpretHoldEvidence(capture(50_000), {huntingBandHz: [0.3, 3.0]}).indication,
    'decrease',
    'a shorter filter must not push a genuine in-band finding out of band'
  );
});
