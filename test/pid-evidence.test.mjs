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

/**
 * Holds of the given lengths, in seconds, separated by the same excursion, with
 * `error(seconds, holdIndex)` read on the FLIGHT's clock — so a slow wander
 * carries from one hold into the next the way it does in the air.
 * `setpointsDps[i]` makes hold i a turn at that rate. Three holds is the fewest
 * a standing error is read from (round three).
 */
function holdsOfLengths(lengthsS, {error = () => 0, setpointsDps = null, intervalUs = 2000} = {}) {
  const records = [...excursion(0)];
  let cursor = LEAD_IN_US;
  lengthsS.forEach((lengthS, at) => {
    const startUs = cursor;
    const durationUs = Math.round(lengthS * 1_000_000);
    records.push(...holdSamples({startUs, durationUs, intervalUs,
      setpointDps: setpointsDps?.[at] ?? 0,
      error: seconds => error(startUs / 1_000_000 + seconds, at, seconds)}));
    cursor += durationUs + 100_000;
    records.push(...excursion(cursor));
    cursor += 400_000;
  });
  return records;
}

/**
 * `twoHolds` with a third: the fewest a standing error is read from. `error` is
 * read on each hold's own clock, as `twoHolds` reads it.
 */
function threeHolds(options = {}) {
  const lengthS = (options.durationUs ?? HOLD_US) / 1_000_000;
  const {error = () => 0, setpointDps = 0} = options;
  return holdsOfLengths([lengthS, lengthS, lengthS], {
    error: (flightSeconds, at, holdSeconds) => error(holdSeconds),
    setpointsDps: [setpointDps, setpointDps, setpointDps],
    intervalUs: 1000
  });
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
  // THREE holds since round three. Two holds on the same side is what too little
  // I looks like and also what a slice of a slow wander looks like; the fixture
  // used to fly two, and the pin was the gap the review found.
  const evidence = buildHoldEvidence(
    threeHolds({error: seconds => 5 + 2 * seconds}),
    {axis: 'yaw', term: 'I'}
  );
  const verdict = interpretHoldEvidence(evidence);

  assert.equal(evidence.holds.length, 3);
  assert.equal(verdict.indication, 'increase');
  assert.equal(verdict.confidence, 'medium');
  assert.ok(verdict.codes.includes('STEADY_STATE_ERROR_PRESENT'));
  assert.ok(verdict.codes.includes('STEADY_STATE_ERROR_DRIFTING'));

  // The same error over two holds is refused, and says why.
  const two = interpretHoldEvidence(buildHoldEvidence(
    twoHolds({error: seconds => 5 + 2 * seconds}), {axis: 'yaw', term: 'I'}));
  assert.equal(two.indication, 'hold', two.codes.join(','));
  assert.ok(two.codes.includes('TOO_FEW_HOLDS_FOR_A_STANDING_ERROR'), two.codes.join(','));
  assert.ok(!two.codes.includes('HOLD_EVIDENCE_WITHIN_TOLERANCE'), two.codes.join(','));
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
    // Three holds since round three: the fewest a standing error is read from.
    const records = onAxis(threeHolds({error: () => 6}), axis);

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
  // oscillation measured through it is content the filter had already begun
  // removing. Judging it against a band reaching 3 Hz claims an in-band
  // oscillation on the strength of the filter's own roll-off — which on the
  // reference flight turned roll's "no conclusion" into a confident "decrease".
  //
  // RE-DERIVED 2 October 2026. This summary used to carry a crossing rate of
  // 2.6 and call it a 2.6 Hz ripple. A crossing rate counts sign changes, two
  // per cycle, so 2.6 crossings a second is a 1.3 Hz oscillation — inside every
  // corner here — and the test only passed because the module compared the two
  // numbers as if they were the same unit. A 2.6 Hz oscillation crosses its
  // mean 5.2 times a second.
  const summary = Object.freeze({
    holdCount: 3,
    zeroHoldCount: 3,
    sustainedHoldCount: 0,
    meanAbsoluteSteadyStateErrorDps: 0.5,
    meanErrorDriftDpsPerSecond: null,
    driftMeasuredHoldCount: 0,
    meanErrorCrossingRateHz: 5.2,
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

test('the hunting band is a band of oscillation frequency, and a crossing rate is twice that',
  () => {
    // `zeroCrossingRateHz` counts sign changes — two per cycle, as the numeric
    // test at the top of this file pins — and HUNTING_BAND_HZ is a band of
    // oscillation FREQUENCY: its floor, its top and the smoothing corner are all
    // derived as frequencies. Comparing one with the other halved the band to
    // about 0.15-1.5 Hz. A 0.2 Hz wander, below the floor the module documents
    // as the pilot, the wind or the airframe settling, read as "too much I"; a
    // 2 Hz hunt inside the band read as nothing.
    //
    // Swept rather than picked: random frequency, phase, amplitude and noise in
    // each of three regions, held clear of the band edges by the resolution a
    // crossing count over an 11 s window has.
    let state = 20261002;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const holdUs = 12_000_000;
    const intervalUs = 2000;
    const fourHolds = error => {
      const records = [...excursion(0)];
      let cursor = LEAD_IN_US;
      for (let at = 0; at < 4; at += 1) {
        const offset = at * 13.7;
        records.push(...holdSamples({
          startUs: cursor, durationUs: holdUs, intervalUs,
          error: seconds => error(seconds + offset)
        }));
        cursor += holdUs + 100_000;
        records.push(...excursion(cursor));
        cursor += 400_000;
      }
      return records;
    };

    const misread = [];
    const regions = [
      {name: 'below the band', from: 0.05, to: 0.22, hunting: false,
        code: 'SLOW_MOVEMENT_BELOW_I_TERM_BAND'},
      {name: 'inside the band', from: 0.4, to: 2.6, hunting: true, code: null},
      {name: 'above the band', from: 3.6, to: 6.0, hunting: false,
        code: 'OSCILLATION_ABOVE_I_TERM_BAND'}
    ];
    const outOfBandCodes = ['SLOW_MOVEMENT_BELOW_I_TERM_BAND', 'OSCILLATION_ABOVE_I_TERM_BAND'];
    for (const region of regions) {
      for (let draw = 0; draw < 40; draw += 1) {
        const frequencyHz = region.from + random() * (region.to - region.from);
        const amplitude = 7 + random() * 5;
        const phase = random() * 2 * Math.PI;
        const noise = random();
        const evidence = buildHoldEvidence(fourHolds(seconds =>
          amplitude * Math.sin(2 * Math.PI * frequencyHz * seconds + phase)
          + (random() * 2 - 1) * noise), {axis: 'yaw', term: 'I'});
        const verdict = interpretHoldEvidence(evidence);
        const hunting = verdict.codes.includes('LOW_FREQUENCY_HUNTING');
        // Each out-of-band oscillation carries ITS side's code and never the
        // other's, and an in-band one carries neither. Replaces a clause that
        // could not fail (round two of the review): "in band and also called
        // above" is unreachable, because the above-band code is guarded by the
        // in-band test. The side codes are not: halving only the below-band
        // comparison loses SLOW_MOVEMENT on the 0.15-0.22 Hz draws, and dropping
        // its "below the floor" clause puts it on every draw above the band.
        // Only where the slow part moved by more than the ripple threshold: a
        // 5-6 Hz oscillation is mostly removed by the 148 ms filter, and an
        // oscillation that did not register is not called anything.
        const outOfBand = outOfBandCodes.filter(code => verdict.codes.includes(code));
        const registered = evidence.summary.meanErrorRippleRmsDps > 2;
        if (hunting !== region.hunting
            || outOfBand.join() !== (region.code && registered ? region.code : '')
            || (region.hunting && verdict.indication !== 'decrease')
            || (!region.hunting && verdict.indication === 'decrease')) {
          misread.push(`${region.name}: ${frequencyHz.toFixed(2)} Hz crossed `
            + `${evidence.summary?.meanErrorCrossingRateHz}/s -> ${verdict.indication} `
            + `[${verdict.codes.join(',')}]`);
        }
      }
    }
    assert.deepEqual(misread, [],
      `${misread.length} of 120 oscillations were read against the wrong band`);

    // The case that turns a unit slip into the opposite instruction: a 2 Hz hunt
    // with a 3.5 deg/s standing error is BOTH signatures, which is a refusal. With
    // the band halved it was read as a standing error alone, and "raise I".
    const both = interpretHoldEvidence(buildHoldEvidence(fourHolds(seconds =>
      3.5 + 8 * Math.sin(2 * Math.PI * 2 * seconds)), {axis: 'yaw', term: 'I'}));
    assert.equal(both.indication, 'hold', both.codes.join(','));
    assert.ok(both.codes.includes('CONFLICTING_HOLD_SIGNATURES'), both.codes.join(','));

    // The top of the band is the FILTER'S top when the filter is blunter than the
    // band. Measured through 300 ms (corner 1.48 Hz), a 1.8-2.4 Hz oscillation is
    // above what the I term is held responsible for, and is said to be: tested
    // against the declared 3 Hz instead, it would carry no out-of-band code at
    // all and read as an error that simply did not move.
    for (const frequencyHz of [1.8, 2.0, 2.4]) {
      const capped = interpretHoldEvidence(buildHoldEvidence(fourHolds(seconds =>
        10 * Math.sin(2 * Math.PI * frequencyHz * seconds)), {axis: 'yaw', term: 'I'},
      {limits: {huntingSmoothingUs: 300_000}}));
      assert.ok(capped.codes.includes('OSCILLATION_ABOVE_I_TERM_BAND'),
        `${frequencyHz} Hz through 300 ms: ${capped.codes.join(',')}`);
      assert.ok(!capped.codes.includes('LOW_FREQUENCY_HUNTING'), capped.codes.join(','));
      assert.ok(!capped.codes.includes('SLOW_MOVEMENT_BELOW_I_TERM_BAND'), capped.codes.join(','));
    }
  });

test('a standing error is read only where it stands clear of the slow movement around it', () => {
  // ROUND TWO OF THE REVIEW, 2 October 2026. A wander slower than the band does
  // not average out of a 12 s hold: each hold's mean keeps part of a cycle, so
  // an error with NO standing component reads several deg/s of "standing error"
  // — and with the band in the right units nothing else stood in the way of
  // "increase". On a closed loop that was "Raise yaw I" on a healthy integrator
  // pushed by a hunting governor. A standing error is evidence of too little I
  // only where it is larger than the slow movement it sits in.
  let state = 9_2026;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const fourHolds = error => {
    const records = [...excursion(0)];
    let cursor = LEAD_IN_US;
    for (let at = 0; at < 4; at += 1) {
      const offset = at * 13.7;
      records.push(...holdSamples({
        startUs: cursor, durationUs: 12_000_000, intervalUs: 2000,
        error: seconds => error(seconds + offset)
      }));
      cursor += 12_100_000;
      records.push(...excursion(cursor));
      cursor += 400_000;
    }
    return records;
  };

  const misread = [];
  let standingMeasured = 0;
  // A slow wander and nothing else, across the band the review swept.
  for (let draw = 0; draw < 60; draw += 1) {
    const frequencyHz = 0.06 + random() * 0.2;
    const amplitude = 10 + random() * 30;
    const phase = random() * 2 * Math.PI;
    const evidence = buildHoldEvidence(fourHolds(seconds =>
      amplitude * Math.sin(2 * Math.PI * frequencyHz * seconds + phase)
      + (random() * 2 - 1) * 0.3), {axis: 'yaw', term: 'I'});
    const verdict = interpretHoldEvidence(evidence);
    if (verdict.codes.includes('STEADY_STATE_ERROR_PRESENT')) {
      standingMeasured += 1;
      if (!verdict.codes.includes('STANDING_ERROR_NOT_CLEAR_OF_SLOW_MOVEMENT')) {
        misread.push(`no refusal code: ${verdict.codes.join(',')}`);
      }
    }
    // And an error that moved is never stamped as one that did not.
    if (verdict.codes.includes('HOLD_EVIDENCE_WITHIN_TOLERANCE')) {
      misread.push(`wander ${frequencyHz.toFixed(3)} Hz called within tolerance: `
        + verdict.codes.join(','));
    }
    if (verdict.indication === 'increase') {
      misread.push(`wander ${frequencyHz.toFixed(3)} Hz, ${amplitude.toFixed(1)} deg/s: `
        + `mean ${evidence.summary.meanAbsoluteSteadyStateErrorDps}, ripple `
        + `${evidence.summary.meanErrorRippleRmsDps} -> increase [${verdict.codes.join(',')}]`);
    }
  }
  assert.ok(standingMeasured >= 10,
    `the wanders must leave a measured standing error to misread, saw ${standingMeasured}`);

  // A standing error with a smaller slow movement over it is still too little I.
  for (let draw = 0; draw < 40; draw += 1) {
    const standing = (random() < 0.5 ? -1 : 1) * (6 + random() * 9);
    const amplitude = random() * Math.abs(standing) / 4;
    const frequencyHz = 0.06 + random() * 0.2;
    const phase = random() * 2 * Math.PI;
    const evidence = buildHoldEvidence(fourHolds(seconds => standing
      + amplitude * Math.sin(2 * Math.PI * frequencyHz * seconds + phase)
      + (random() * 2 - 1) * 0.3), {axis: 'yaw', term: 'I'});
    const verdict = interpretHoldEvidence(evidence);
    if (verdict.indication !== 'increase') {
      misread.push(`standing ${standing.toFixed(1)} under ${amplitude.toFixed(1)} at `
        + `${frequencyHz.toFixed(3)} Hz -> ${verdict.indication} [${verdict.codes.join(',')}]`);
    }
  }
  assert.deepEqual(misread, [], `${misread.length} holds were read the wrong way`);

  // A fast oscillation averages out of a hold's mean, so it cannot MANUFACTURE a
  // standing error — but it dominates the crossing count, so a hunt under it is
  // never measured, and "a standing error with no hunt" (too little I) cannot be
  // told from "a standing error with a hunt" (the conflicting signature, which
  // is refused). UPDATED in round three: this pinned 'increase' for 20 deg/s at
  // 3.6-4.4 Hz over a 5 deg/s offset. The review put "Raise I" on an aircraft
  // with NO integrator and an in-band wobble — both signatures — once a 12 Hz
  // vibration was laid over it. The pin was the gap. A standing error is read
  // only where every hold's mean stands clear of everything that moved in it.
  for (const frequencyHz of [3.6, 4.0, 4.4]) {
    const evidence = buildHoldEvidence(fourHolds(seconds =>
      5 + 20 * Math.sin(2 * Math.PI * frequencyHz * seconds)), {axis: 'yaw', term: 'I'});
    assert.ok(evidence.summary.meanErrorRippleRmsDps > 5,
      `${frequencyHz} Hz: the ripple must exceed the offset, or this tests nothing: `
      + evidence.summary.meanErrorRippleRmsDps);
    const fast = interpretHoldEvidence(evidence);
    assert.equal(fast.indication, 'hold', `${frequencyHz} Hz: ${fast.codes.join(',')}`);
    assert.ok(fast.codes.includes('STANDING_ERROR_NOT_CLEAR_IN_EVERY_HOLD'),
      `${frequencyHz} Hz: ${fast.codes.join(',')}`);
    assert.ok(!fast.codes.includes('HOLD_EVIDENCE_WITHIN_TOLERANCE'), fast.codes.join(','));
  }
  // The same offset under a SMALL fast oscillation, one the mean clears in every
  // hold, is still read. Small means its slow part moved under the 2 deg/s that
  // is read as movement, so it carries no code: a measurement that would have
  // seen a hunt of that size beside it (since the re-review of 3 October 2026,
  // one that registered is refused — see 'beside a band nothing could see into').
  for (const frequencyHz of [3.6, 4.0, 4.4]) {
    const small = interpretHoldEvidence(buildHoldEvidence(fourHolds(seconds =>
      5 + 3 * Math.sin(2 * Math.PI * frequencyHz * seconds)), {axis: 'yaw', term: 'I'}));
    assert.equal(small.indication, 'increase', `${frequencyHz} Hz: ${small.codes.join(',')}`);
    assert.ok(!small.codes.includes('OSCILLATION_ABOVE_I_TERM_BAND'), small.codes.join(','));
  }
});

test('a standing error is read only when it keeps its side, clear of its movement, in three or more '
  + 'holds', () => {
  // ROUND THREE OF THE REVIEW, 2 October 2026. Over a short hold a slice of a
  // slow cycle has a mean larger than its own ripple, so the round-two rule —
  // the mean over the holds against the ripple over the holds — passed a slow
  // wander flown as ordinary 5.5-8 s holds, and a healthy integrator was told
  // "Raise I". What a wander cannot do is keep to one side of the command from
  // hold to hold. A standing error is now read only when there are three or
  // more holds, every one of them on the same side, every one clear of what
  // moved inside it.
  let state = 3_2026;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const between = (low, high) => low + random() * (high - low);
  const layout = (count, spacingS) => Array.from({length: count}, () =>
    Math.min(14, Math.max(5.5, spacingS - 0.5 + between(-0.5, 0.5))));
  const read = (lengthsS, options) => {
    const evidence = buildHoldEvidence(holdsOfLengths(lengthsS, options), {axis: 'yaw', term: 'I'});
    return {evidence, verdict: interpretHoldEvidence(evidence)};
  };

  const misread = [];
  // A slow wander alone, flown as 4-8 ordinary holds: never read as a standing
  // error, however much of a cycle each hold kept. Half the draws in the
  // review's own corner — 0.05-0.12 Hz, a pulse every 6.5-8 s — where a slice
  // of the cycle most often outweighs its own ripple; half across 0.06-0.30 Hz
  // and 6.5-12 s. Four holds or more, because an open-loop sine slow enough to
  // stay on one side across every hold is, on these holds, a slowly varying
  // standing torque — the closed-loop sweep in recommendations.test.mjs flies
  // three-hold layouts through the real loop.
  let slipped = 0;
  for (let draw = 0; draw < 120; draw += 1) {
    const corner = draw % 2 === 0;
    const frequencyHz = corner ? between(0.05, 0.12) : between(0.06, 0.30);
    const amplitude = between(8, 35);
    const phase = between(0, 2 * Math.PI);
    const lengthsS = layout(4 + Math.floor(random() * 5), corner ? between(6.5, 8) : between(6.5, 12));
    const {evidence, verdict} = read(lengthsS, {error: seconds =>
      amplitude * Math.sin(2 * Math.PI * frequencyHz * seconds + phase)
      + (random() * 2 - 1) * 0.5});
    const codes = verdict.codes;
    // What the round-two rule let through: a standing error clear of the
    // ripple averaged over the holds.
    if (codes.includes('STEADY_STATE_ERROR_PRESENT')
        && !codes.includes('STANDING_ERROR_NOT_CLEAR_OF_SLOW_MOVEMENT')
        && !codes.includes('LOW_FREQUENCY_HUNTING')) {
      slipped += 1;
    }
    if (verdict.indication === 'increase' || codes.includes('HOLD_EVIDENCE_WITHIN_TOLERANCE')) {
      misread.push(`wander ${frequencyHz.toFixed(3)} Hz ${amplitude.toFixed(1)} over `
        + `${lengthsS.length} holds [${evidence.holds.map(hold =>
          hold.steadyStateErrorDps.toFixed(1)).join(' ')}] -> ${verdict.indication} `
        + `[${codes.join(',')}]`);
    }
  }
  assert.ok(slipped >= 15, `the wanders must reach the hole the round-two rule left: ${slipped}`);

  // A standing error with a smaller slow movement over it, three to eight holds,
  // either sign: too little I.
  for (let draw = 0; draw < 40; draw += 1) {
    const standing = (random() < 0.5 ? -1 : 1) * between(4, 15);
    const amplitude = between(0, Math.abs(standing) / 4);
    const frequencyHz = between(0.06, 0.30);
    const lengthsS = layout(3 + Math.floor(random() * 6), between(6.5, 12));
    const {verdict} = read(lengthsS, {error: seconds => standing
      + amplitude * Math.sin(2 * Math.PI * frequencyHz * seconds) + (random() * 2 - 1) * 0.5});
    if (verdict.indication !== 'increase') {
      misread.push(`standing ${standing.toFixed(1)} under ${amplitude.toFixed(1)} over `
        + `${lengthsS.length} holds -> ${verdict.indication} [${verdict.codes.join(',')}]`);
    }
  }
  assert.deepEqual(misread, [], `${misread.length} holds were read the wrong way:\n`
    + misread.join('\n'));

  // TWO holds of the same standing error: not read, and not cleared either.
  const two = read([7, 7], {error: () => 6}).verdict;
  assert.equal(two.indication, 'hold');
  assert.ok(two.codes.includes('TOO_FEW_HOLDS_FOR_A_STANDING_ERROR'), two.codes.join(','));
  assert.ok(!two.codes.includes('HOLD_EVIDENCE_WITHIN_TOLERANCE'), two.codes.join(','));

  // An error that sits off the command on one side in some holds and on the
  // other in others, each hold clear of its own movement: a wander slower than
  // the holds, not a standing error.
  const sides = read([7, 7, 7, 7], {error: (seconds, at) => (at % 2 === 0 ? 6 : -6)}).verdict;
  assert.equal(sides.indication, 'hold');
  assert.ok(sides.codes.includes('STANDING_ERROR_CHANGES_SIDE_BETWEEN_HOLDS'), sides.codes.join(','));

  // Turns both ways. A standing torque the aircraft fights whichever way it
  // turns keeps the error on one side: read. An error that follows the stick —
  // a lagging loop, or a wander in step with the turns — flips with it: not read.
  const directions = [120, -120, -120, 120];
  const bias = read([7, 7, 7, 7], {setpointsDps: directions, error: () => -6}).verdict;
  assert.equal(bias.indication, 'increase', bias.codes.join(','));
  const follows = read([7, 7, 7, 7], {setpointsDps: directions,
    error: (seconds, at) => Math.sign(directions[at]) * 6}).verdict;
  assert.equal(follows.indication, 'hold', follows.codes.join(','));
  assert.ok(follows.codes.includes('STANDING_ERROR_FOLLOWS_COMMAND_DIRECTION'),
    follows.codes.join(','));
  // Turns all one way, lagging behind the stick: one side, read.
  const lag = read([7, 7, 7], {setpointsDps: [120, 120, 120], error: () => 6}).verdict;
  assert.equal(lag.indication, 'increase', lag.codes.join(','));
});

test('an all-clear needs a slow part quiet enough to have seen trouble in', () => {
  // ROUND THREE. HOLD_EVIDENCE_WITHIN_TOLERANCE is a positive measurement of an
  // error that neither stood nor moved. Two roads reached it without one: a
  // fast oscillation, which dominates the crossing count so nothing slower is
  // measured under it; and a slow ripple above the threshold refused as hunting
  // only because it was no larger than the noise, which carried no code at all.
  let state = 4_2026;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const between = (low, high) => low + random() * (high - low);
  const misread = [];
  // The noise is a 40.5 Hz tone sitting on a null of the 148 ms box average, so
  // it is all "noise" (what the box removed) and none of it leaks into the slow
  // part's crossing count — the slow part is exactly the sine under test.
  const nullHz = 6 / (EVIDENCE_LIMITS.huntingSmoothingUs / 1_000_000);
  const regions = [
    {name: 'inside the band', from: 0.4, to: 2.6},
    {name: 'below the band', from: 0.08, to: 0.22}
  ];
  for (const region of regions) {
    for (let draw = 0; draw < 30; draw += 1) {
      const frequencyHz = between(region.from, region.to);
      const amplitude = between(4, 8);
      const noise = between(10, 20);
      const evidence = buildHoldEvidence(holdsOfLengths([12, 12, 12], {intervalUs: 1000,
        error: seconds => amplitude * Math.sin(2 * Math.PI * frequencyHz * seconds)
          + noise * Math.sin(2 * Math.PI * nullHz * seconds) + (random() * 2 - 1) * 0.3
      }), {axis: 'yaw', term: 'I'});
      const summary = evidence.summary;
      const verdict = interpretHoldEvidence(evidence);
      if (!(summary.meanErrorRippleRmsDps > 2 && summary.meanErrorRippleRmsDps <= summary.meanErrorNoiseRmsDps)) {
        misread.push(`${region.name}: the fixture must put the ripple over 2 and under the noise: `
          + `${summary.meanErrorRippleRmsDps} vs ${summary.meanErrorNoiseRmsDps}`);
        continue;
      }
      if (verdict.codes.includes('HOLD_EVIDENCE_WITHIN_TOLERANCE')
          || !verdict.codes.includes('SLOW_RIPPLE_NOT_CLEAR_OF_NOISE')) {
        misread.push(`${region.name}: ${frequencyHz.toFixed(2)} Hz ${amplitude.toFixed(1)} under `
          + `${noise.toFixed(0)} noise -> ${verdict.indication} [${verdict.codes.join(',')}]`);
      }
    }
  }
  // Above the band, with the slow part moved past the threshold.
  for (let draw = 0; draw < 30; draw += 1) {
    const frequencyHz = between(3.4, 6);
    const amplitude = between(8, 14);
    const evidence = buildHoldEvidence(holdsOfLengths([12, 12, 12], {
      error: seconds => amplitude * Math.sin(2 * Math.PI * frequencyHz * seconds)
    }), {axis: 'yaw', term: 'I'});
    const verdict = interpretHoldEvidence(evidence);
    if (evidence.summary.meanErrorRippleRmsDps > 2
        && (verdict.codes.includes('HOLD_EVIDENCE_WITHIN_TOLERANCE')
          || !verdict.codes.includes('OSCILLATION_ABOVE_I_TERM_BAND'))) {
      misread.push(`above: ${frequencyHz.toFixed(2)} Hz -> [${verdict.codes.join(',')}]`);
    }
  }
  assert.deepEqual(misread, [], `${misread.length} holds were cleared without a measurement:\n`
    + misread.join('\n'));

  // CONTROL: a quiet error is still a positive measurement of nothing wrong.
  const quiet = interpretHoldEvidence(buildHoldEvidence(holdsOfLengths([12, 12, 12], {
    error: () => 0.4 + (random() * 2 - 1) * 0.5}), {axis: 'yaw', term: 'I'}));
  assert.ok(quiet.codes.includes('HOLD_EVIDENCE_WITHIN_TOLERANCE'), quiet.codes.join(','));
});

/* ROUND THREE, RE-REVIEWED 3 October 2026 ---------------------------------- */

test('a standing error is not read as too little I beside a band nothing could see into', () => {
  // A standing error with an in-band hunt beside it is the conflicting signature,
  // which is refused — but only where the hunt is SEEN. An oscillation above the
  // band dominates the crossing count, and a slow ripple no larger than the noise
  // is not told from it, so under either a hunt is neither read nor ruled out. A
  // cover SMALLER than the standing error passed every per-hold rule, and the
  // reading was "increase" by elimination: the review laid a 6-15 Hz torque, or
  // 50-400 deg/s of gyro noise, over an aircraft with no integrator AND an
  // in-band wobble, and got "Raise I" in 2 and 10 of 40 flights.
  //
  // Swept: either sign, three to six holds of 6-11 s, an in-band wobble beside
  // the error or none (it was not measured either way, so the reading must not
  // depend on it), and the two covers in turn. The noise is a tone on a null of
  // the box average, as in the test above, so all of it is "noise" and the slow
  // part is exactly the wobble.
  let state = 6_2026;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const between = (low, high) => low + random() * (high - low);
  const nullHz = 6 / (EVIDENCE_LIMITS.huntingSmoothingUs / 1_000_000);
  const misread = [];
  const reached = {fast: 0, noise: 0};
  for (let draw = 0; draw < 80; draw += 1) {
    const noisy = draw % 2 === 1;
    const standing = (random() < 0.5 ? -1 : 1) * between(6, 18);
    const lengthsS = Array.from({length: 3 + Math.floor(random() * 4)}, () => between(6, 11));
    const wobbleHz = between(0.4, 2.4);
    const wobble = noisy ? between(4, 14) : (random() < 0.5 ? between(1, 3) : 0);
    const phase = between(0, 2 * Math.PI);
    // Up to a per-hold ripple near the standing error, as the review's were
    // (13.3/7.7, 16.5/10.9 deg/s): a cover that reaches past it is refused
    // hold by hold, and one that stays under it is the hole.
    const coverHz = between(3.5, 5);
    const cover = between(8, 34);
    const noise = between(14, 30);
    const evidence = buildHoldEvidence(holdsOfLengths(lengthsS, {intervalUs: 1000,
      error: seconds => standing + wobble * Math.sin(2 * Math.PI * wobbleHz * seconds + phase)
        + (noisy
          ? noise * Math.sin(2 * Math.PI * nullHz * seconds)
          : cover * Math.sin(2 * Math.PI * coverHz * seconds))
        + (random() * 2 - 1) * 0.3}), {axis: 'yaw', term: 'I'});
    const verdict = interpretHoldEvidence(evidence);
    const codes = verdict.codes;
    const coverCode = noisy ? 'SLOW_RIPPLE_NOT_CLEAR_OF_NOISE' : 'OSCILLATION_ABOVE_I_TERM_BAND';
    const label = `${noisy ? 'noise' : 'fast'} draw ${draw}: standing ${standing.toFixed(1)}, `
      + `wobble ${wobble.toFixed(1)} at ${wobbleHz.toFixed(2)} Hz over ${lengthsS.length} holds `
      + `[${evidence.holds.map(hold => `${hold.steadyStateErrorDps.toFixed(1)}/`
        + hold.errorRippleRmsDps.toFixed(1)).join(' ')}] -> ${verdict.indication} [${codes.join(',')}]`;
    // THE HOLE: every hold's mean clear of what moved in it, on one side, in
    // enough holds — every per-hold rule passed, and only the cover stood
    // between this and "increase".
    const holds = evidence.holds;
    const perHoldClear = holds.length >= EVIDENCE_LIMITS.minimumHoldsForStandingError
      && holds.every(hold => Math.abs(hold.steadyStateErrorDps) > hold.errorRippleRmsDps)
      && (holds.every(hold => hold.steadyStateErrorDps > 0)
        || holds.every(hold => hold.steadyStateErrorDps < 0));
    if (codes.includes(coverCode) && perHoldClear && codes.includes('STEADY_STATE_ERROR_PRESENT')) {
      reached[noisy ? 'noise' : 'fast'] += 1;
      if (verdict.indication !== 'hold' || verdict.confidence !== 'low'
          || !codes.includes('STANDING_ERROR_WITH_UNMEASURED_BAND')) {
        misread.push(label);
      }
    }
    if (verdict.indication === 'increase' && codes.includes(coverCode)) {
      misread.push(`read under the cover: ${label}`);
    }
    if (codes.includes('HOLD_EVIDENCE_WITHIN_TOLERANCE')) {
      misread.push(`cleared: ${label}`);
    }
  }
  assert.deepEqual(misread, [], `${misread.length} standing errors were read beside a band nothing `
    + `could see into:\n${misread.join('\n')}`);
  // Not vacuous: the hole was reached, under both covers, many times.
  assert.ok(reached.fast >= 12 && reached.noise >= 12,
    `the sweep must reach the hole under both covers: ${JSON.stringify(reached)}`);

  // CONTROL: the same standing error under a fast oscillation too small to
  // register — its slow part moves under the 2 deg/s that would be read as
  // movement, so there is no cover code, and it was a measurement that could
  // have seen a hunt of that size — is still read as too little I.
  for (let draw = 0; draw < 40; draw += 1) {
    const standing = (random() < 0.5 ? -1 : 1) * between(6, 15);
    const lengthsS = Array.from({length: 3 + Math.floor(random() * 4)}, () => between(6, 11));
    const coverHz = between(3.5, 5);
    const verdict = interpretHoldEvidence(buildHoldEvidence(holdsOfLengths(lengthsS, {
      intervalUs: 1000,
      error: seconds => standing + 2.5 * Math.sin(2 * Math.PI * coverHz * seconds)
        + (random() * 2 - 1) * 0.3}), {axis: 'yaw', term: 'I'}));
    assert.equal(verdict.indication, 'increase', `${standing.toFixed(1)} under a small `
      + `${coverHz.toFixed(2)} Hz oscillation: [${verdict.codes.join(',')}]`);
    assert.ok(!verdict.codes.includes('OSCILLATION_ABOVE_I_TERM_BAND')
      && !verdict.codes.includes('STANDING_ERROR_WITH_UNMEASURED_BAND'), verdict.codes.join(','));
  }
});

test('an error that follows the stick says which side of the command it was on', () => {
  // ROUND THREE, RE-REVIEWED 3 October 2026. An error that changes side exactly
  // with the turn is refused as STANDING_ERROR_FOLLOWS_COMMAND_DIRECTION, and the
  // card said "a loop that lags behind every turn does that" whichever side it
  // was — including for an aircraft turning FASTER than commanded both ways,
  // which is what feedforward set too high does. The side is measured here, in
  // each turn's own direction (setpoint minus gyro, so positive is short of the
  // command), and said: RATE_SHORT_OF_COMMAND_IN_EVERY_TURN or
  // RATE_PAST_COMMAND_IN_EVERY_TURN, never both.
  let state = 7_2026;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const between = (low, high) => low + random() * (high - low);
  const misread = [];
  const seen = {short: 0, past: 0};
  for (let draw = 0; draw < 40; draw += 1) {
    const count = 4 + Math.floor(random() * 4);
    // Both ways, in a random order. Rates clear of the 90 deg/s excursion between
    // holds, which a turn near it would merge with.
    const directions = Array.from({length: count}, (_, at) => (at < 2 ? [1, -1][at]
      : (random() < 0.5 ? -1 : 1)));
    directions.sort(() => random() - 0.5);
    const rateDps = between(150, 300);
    const short = draw % 2 === 0;
    const size = between(4, 15);
    const evidence = buildHoldEvidence(holdsOfLengths(
      Array.from({length: count}, () => between(6, 10)), {
        setpointsDps: directions.map(direction => direction * rateDps),
        error: (seconds, at) => directions[at] * (short ? size : -size) + (random() * 2 - 1) * 0.3
      }), {axis: 'yaw', term: 'I'});
    const verdict = interpretHoldEvidence(evidence);
    const codes = verdict.codes;
    const expected = short ? 'RATE_SHORT_OF_COMMAND_IN_EVERY_TURN' : 'RATE_PAST_COMMAND_IN_EVERY_TURN';
    const other = short ? 'RATE_PAST_COMMAND_IN_EVERY_TURN' : 'RATE_SHORT_OF_COMMAND_IN_EVERY_TURN';
    if (verdict.indication !== 'hold' || !codes.includes('STANDING_ERROR_FOLLOWS_COMMAND_DIRECTION')
        || !codes.includes(expected) || codes.includes(other)) {
      misread.push(`${short ? 'short' : 'past'} by ${size.toFixed(1)} at ${rateDps.toFixed(0)} deg/s `
        + `[${directions.join(',')}] -> ${verdict.indication} [${codes.join(',')}]`);
    } else {
      seen[short ? 'short' : 'past'] += 1;
    }
  }
  assert.deepEqual(misread, [], `${misread.length} turns were given the wrong side:\n${misread.join('\n')}`);
  assert.ok(seen.short >= 15 && seen.past >= 15, JSON.stringify(seen));

  // An error that keeps ONE side through turns both ways is a standing error,
  // not one that follows the stick, and carries neither side code.
  const directions = [150, -150, -150, 150];
  const bias = interpretHoldEvidence(buildHoldEvidence(holdsOfLengths([7, 7, 7, 7], {
    setpointsDps: directions, error: () => -6}), {axis: 'yaw', term: 'I'}));
  assert.equal(bias.indication, 'increase', bias.codes.join(','));
  assert.ok(!bias.codes.some(code => /^RATE_(?:SHORT_OF|PAST)_COMMAND/.test(code)), bias.codes.join(','));
  // Nor does a side change at zero rate, where there is no turn to be short of.
  const sides = interpretHoldEvidence(buildHoldEvidence(holdsOfLengths([7, 7, 7, 7], {
    error: (seconds, at) => (at % 2 === 0 ? 6 : -6)}), {axis: 'yaw', term: 'I'}));
  assert.ok(sides.codes.includes('STANDING_ERROR_CHANGES_SIDE_BETWEEN_HOLDS'), sides.codes.join(','));
  assert.ok(!sides.codes.some(code => /^RATE_(?:SHORT_OF|PAST)_COMMAND/.test(code)), sides.codes.join(','));
});
