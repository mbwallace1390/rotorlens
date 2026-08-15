/**
 * End-to-end cover for the stop-manoeuvre fixture.
 *
 * Until this fixture existed, `describeStopCapture` returning 'captured' — and
 * the whole non-provisional directional table behind it — was reached only by
 * unit tests handing the evidence builders fabricated event objects. Nothing in
 * the corpus could produce a qualifying stop, because a stop needs a command
 * held past 150 ms, released cleanly, and then a full second of hands-off flight
 * inside the same log, and every generated session was 0.08–0.16 s long. A state
 * that no bytes can reach is a state nobody has seen the app render.
 *
 * So every assertion below starts from the committed FILE: decode it, build
 * records, detect stops, build directional evidence, describe the capture.
 *
 * THE EXPECTED NUMBERS BELOW ARE DELIBERATELY NOT IMPORTED FROM THE GENERATOR.
 * They are written out here by hand. Importing `MANOEUVRE_AXES` would make this
 * a test that rebuilds what it checks: mutating the injected asymmetry would
 * move the fixture and the expectation together and the test would stay green
 * for both. That exact shape has shipped in this repository four times.
 */

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {decodeLog} from '../src/blackbox/decode.mjs';
import {Encoding, groupSize} from '../src/blackbox/encodings.mjs';
import {Predictor} from '../src/blackbox/predictors.mjs';
import {measureIntraFrameContinuity} from '../src/blackbox/continuity.mjs';
import {buildAnalysisRecords, detectStopEvents} from '../src/analysis/records.mjs';
import {buildDirectionalStopEvidence} from '../src/analysis/pid-evidence.mjs';
import {
  describeStopCapture, directionalObservations, resolveAxisSignals, summarizeAxis
} from '../src/analysis/axis-report.mjs';
import {
  MECHANICAL_CONSTANTS, analyzeMechanicalTimeSeries, buildMechanicalSeries, sessionTimeBounds
} from '../src/analysis/advisor/mechanical-spectrum.mjs';
import {analyseAxisEvidence, buildRecommendations} from '../src/analysis/recommendations.mjs';
import {buildFixtures} from '../tools/generate-fixtures.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = 'rf46-stop-manoeuvres.TXT';

async function decodeFixture(file) {
  const bytes = new Uint8Array(
    await readFile(path.join(projectRoot, 'fixtures', 'synthetic', file))
  );
  return decodeLog(bytes);
}

/**
 * What the fixture was flown to contain, restated independently of the code that
 * produces it. `trackingErrorDps` is the steady error injected between command
 * and gyro while the command was held; `ringingDps` is the amplitude of the
 * post-release oscillation. The two point OPPOSITE ways on roll and pitch, which
 * is what makes "some asymmetry came out" insufficient to pass.
 */
const INJECTED = Object.freeze({
  roll: {
    trackingErrorDps: {positive: 4, negative: 12},
    ringingDps: {positive: 30, negative: 10},
    commandPeakDps: 180
  },
  pitch: {
    trackingErrorDps: {positive: 6, negative: 6},
    ringingDps: {positive: 12, negative: 36},
    commandPeakDps: 140
  },
  yaw: {
    trackingErrorDps: {positive: 6, negative: 24},
    ringingDps: {positive: 15, negative: 45},
    commandPeakDps: 260
  }
});

/**
 * Recovery tolerance on the tracking error, in deg/s.
 *
 * `trackingRmsDps` is the RMS of (command − gyro) over the 150 ms before the
 * command leaves its plateau, and the injected error carries ±1 deg/s of sensor
 * ripple, so it cannot come back exact. Measured deviation across all six
 * direction/axis pairs is at most 0.20 deg/s; 0.5 leaves 2.5x headroom while
 * still failing on a 1 deg/s change to any injected value.
 */
const TRACKING_TOLERANCE_DPS = 0.5;

/**
 * Recovery tolerance on a ratio between two directions, as a fraction.
 *
 * A ratio of RMS values is not the ratio of the amplitudes that produced them —
 * the ringing envelope decays through the measurement window — so this is looser
 * than the absolute check above. Measured deviation is at most 6%.
 */
const RATIO_TOLERANCE = 0.15;

function pipeline(session, axis) {
  const {records, usable, missing} = buildAnalysisRecords(session, {axis});
  const diagnostics = detectStopEvents(records, {axis, diagnostics: true});
  const evidence = buildDirectionalStopEvidence(diagnostics.events, {axis});
  return {
    records,
    usable,
    missing,
    diagnostics,
    evidence,
    capture: describeStopCapture(diagnostics, {axis}),
    observations: directionalObservations(evidence, [
      'trackingRmsDps', 'fastRingingRmsDps', 'commandAmplitudeDps'
    ])
  };
}

const observationOf = (observations, metric) =>
  observations.find(entry => entry.metric === metric);

// ---------------------------------------------------------------------------
// The fixture is long enough to be measured at all
// ---------------------------------------------------------------------------

test('the stop fixture is the only one long enough for the continuity check to run', async () => {
  // `verify:log` prints "not measured" on the rest of the corpus: 320 frames at
  // an I interval of 32 give 9 keyframe transitions against a minimum of 16, so
  // the one check that can see a permuted bit layout was never exercised by any
  // committed fixture. This is the fixture that changes that, and this assertion
  // is what stops it being shortened back below the floor.
  const short = await decodeFixture('rf43-single-session.TXT');
  const shortContinuity = measureIntraFrameContinuity({
    samples: short.sessions[0].samples,
    intraSampleIndices: short.sessions[0].intraSampleIndices,
    fields: short.sessions[0].fields
  });
  assert.equal(shortContinuity.measured, false, 'the 320-frame fixture cannot support it');
  assert.match(shortContinuity.reason, /I-frame/);

  const [session] = (await decodeFixture(FIXTURE)).sessions;
  const continuity = measureIntraFrameContinuity({
    samples: session.samples,
    intraSampleIndices: session.intraSampleIndices,
    fields: session.fields
  });

  assert.equal(continuity.measured, true, 'the stop fixture must reach the continuity check');
  assert.ok(
    continuity.intraTransitions >= 16,
    `only ${continuity.intraTransitions} keyframe transitions`
  );
  assert.deepEqual(
    continuity.flagged.map(entry => entry.name), [],
    'the fixture itself must decode continuously, or it cannot be a baseline'
  );
});

test('the stop fixture decodes clean, end to end, at a plausible logging rate', async () => {
  const [session] = (await decodeFixture(FIXTURE)).sessions;

  assert.deepEqual(session.errors, []);
  assert.equal(session.reachedLogEnd, true);
  assert.equal(session.truncated, false);
  assert.equal(session.frameCounts.resyncBytes, 0);
  assert.equal(session.samples.length, 9200);

  const timeIndex = session.fields.findIndex(field => field.name === 'time');
  const spanUs = session.samples.at(-1)[timeIndex] - session.samples[0][timeIndex];
  // A stop needs a full second of quiet after it and the log must outlast that,
  // twelve times over. Anything under ~15 s cannot hold this manoeuvre set.
  assert.ok(spanUs > 15_000_000, `session spans only ${spanUs} µs`);
});

// ---------------------------------------------------------------------------
// The state that had never been rendered from bytes
// ---------------------------------------------------------------------------

test('every axis reaches a full stop capture from the committed bytes', async () => {
  const [session] = (await decodeFixture(FIXTURE)).sessions;

  for (const axis of ['roll', 'pitch', 'yaw']) {
    const {usable, missing, diagnostics, evidence, capture} = pipeline(session, axis);

    assert.equal(usable, true, `${axis}: records must be usable`);
    assert.deepEqual(missing, [], `${axis}: nothing may be missing`);
    assert.equal(diagnostics.diagnosis.outcome, 'EVENTS_DETECTED', `${axis} outcome`);
    assert.deepEqual(
      diagnostics.diagnosis.rejections, {},
      `${axis}: the fixture is flown to the gates, so nothing should be refused`
    );

    assert.equal(capture.state, 'captured', `${axis} capture state`);
    assert.deepEqual(capture.captured, {positive: 2, negative: 2}, `${axis} stops per direction`);
    assert.deepEqual(capture.refusals, [], `${axis} refusals`);
    assert.match(capture.headline, /stops captured/);
    // The boundary sentence is what keeps "fly this" from reading as "change
    // this". It renders on this path and nowhere else in these assertions.
    assert.match(capture.boundary, /does not tell you what to change/);

    assert.equal(evidence.status, 'captured', `${axis} evidence status`);
    for (const direction of ['positive', 'negative']) {
      assert.equal(evidence.directions[direction].directionEventCount, 2);
    }
  }
});

test('the stops are spaced as flown, alternating direction, two per direction per axis', async () => {
  const [session] = (await decodeFixture(FIXTURE)).sessions;

  for (const axis of ['roll', 'pitch', 'yaw']) {
    const {diagnostics} = pipeline(session, axis);
    const signs = diagnostics.events.map(event => event.commandSign);
    assert.deepEqual(signs, ['positive', 'negative', 'positive', 'negative'], `${axis} order`);

    for (let index = 1; index < diagnostics.events.length; index += 1) {
      const gap = diagnostics.events[index].stopTimeUs - diagnostics.events[index - 1].stopTimeUs;
      assert.equal(gap, 1_500_000, `${axis}: stop ${index} is ${gap} µs after the last`);
    }
  }
});

// ---------------------------------------------------------------------------
// The asymmetry that was built in has to come back out
// ---------------------------------------------------------------------------

test('the injected directional asymmetry is recovered per axis and per metric', async () => {
  const [session] = (await decodeFixture(FIXTURE)).sessions;

  for (const axis of ['roll', 'pitch', 'yaw']) {
    const expected = INJECTED[axis];
    const {evidence, observations} = pipeline(session, axis);

    // 1. The tracking error comes back as the number that was put in, per
    //    direction. This is the assertion that a swapped asymmetry cannot pass.
    for (const direction of ['positive', 'negative']) {
      const measured = evidence.directions[direction].trackingRmsDps;
      const injected = expected.trackingErrorDps[direction];
      assert.ok(
        Math.abs(measured - injected) <= TRACKING_TOLERANCE_DPS,
        `${axis} ${direction}: tracking ${measured} deg/s, ${injected} was injected`
      );
    }

    const tracking = observationOf(observations, 'trackingRmsDps');
    const ringing = observationOf(observations, 'fastRingingRmsDps');
    const command = observationOf(observations, 'commandAmplitudeDps');

    // 2. Two stops each way is where the evidence stops being provisional. That
    //    branch of the directional table is only reachable from a log like this.
    for (const entry of [tracking, ringing, command]) {
      assert.equal(entry.provisional, false, `${axis} ${entry.metric} provisional`);
      assert.equal(entry.positiveCount, 2);
      assert.equal(entry.negativeCount, 2);
    }

    // 3. Which side is worse, and by how much. Asserted separately for tracking
    //    and for ringing because on roll and pitch they point OPPOSITE ways: a
    //    single blanket "the negative direction is worse" would be wrong on both.
    const trackingSides = expected.trackingErrorDps;
    const ringingSides = expected.ringingDps;

    if (trackingSides.positive !== trackingSides.negative) {
      const worse = trackingSides.positive > trackingSides.negative ? 'positive' : 'negative';
      assert.equal(tracking.higher, worse, `${axis}: tracking is worse ${worse}`);
      const injectedRatio = Math.max(trackingSides.positive, trackingSides.negative)
        / Math.min(trackingSides.positive, trackingSides.negative);
      assert.ok(
        Math.abs(tracking.ratio - injectedRatio) / injectedRatio <= RATIO_TOLERANCE,
        `${axis}: tracking ratio ${tracking.ratio}, ${injectedRatio} was injected`
      );
    }

    const worseRinging = ringingSides.positive > ringingSides.negative ? 'positive' : 'negative';
    assert.equal(ringing.higher, worseRinging, `${axis}: ringing is worse ${worseRinging}`);
    const injectedRingingRatio = Math.max(ringingSides.positive, ringingSides.negative)
      / Math.min(ringingSides.positive, ringingSides.negative);
    assert.ok(
      Math.abs(ringing.ratio - injectedRingingRatio) / injectedRingingRatio <= RATIO_TOLERANCE,
      `${axis}: ringing ratio ${ringing.ratio}, ${injectedRingingRatio} was injected`
    );

    // 4. The command itself is symmetric by construction. Without this, an
    //    analysis that simply echoed the stick would pass every check above.
    assert.equal(command.ratio, 1, `${axis}: the command amplitude must be symmetric`);
    assert.equal(evidence.asymmetry.commandAmplitudeDps, 0);
    assert.ok(
      Math.abs(evidence.directions.positive.commandAmplitudeDps - expected.commandPeakDps)
        <= expected.commandPeakDps * 0.05,
      `${axis}: command amplitude ${evidence.directions.positive.commandAmplitudeDps}`
    );
  }
});

test('an axis symmetric in tracking is comparable even when its ringing is not', async () => {
  // `directionsComparable` reads trackingRmsDps alone. Pitch is flown with equal
  // tracking error both ways and 3x ringing asymmetry, which separates "the two
  // directions may be reasoned about together" from "nothing differs" — a
  // distinction no other fixture can exercise.
  const [session] = (await decodeFixture(FIXTURE)).sessions;

  const pitch = pipeline(session, 'pitch');
  assert.equal(pitch.evidence.status, 'captured');
  assert.equal(pitch.evidence.directionsComparable, true);
  assert.deepEqual(pitch.evidence.codes, []);
  assert.ok(
    pitch.evidence.asymmetry.trackingRmsDps < 0.30,
    `pitch tracking asymmetry ${pitch.evidence.asymmetry.trackingRmsDps}`
  );
  // Still visibly asymmetric where it was built to be.
  assert.ok(
    pitch.evidence.asymmetry.fastRingingRmsDps > 0.5,
    `pitch ringing asymmetry ${pitch.evidence.asymmetry.fastRingingRmsDps}`
  );

  const roll = pipeline(session, 'roll');
  assert.equal(roll.evidence.directionsComparable, false);
  assert.ok(roll.evidence.codes.includes('DIRECTIONAL_ASYMMETRY_DETECTED'));

  // Yaw asymmetry is raised under its own code, because on yaw it usually means
  // tail authority rather than a gain.
  const yaw = pipeline(session, 'yaw');
  assert.equal(yaw.evidence.directionsComparable, false);
  assert.ok(yaw.evidence.codes.includes('YAW_DIRECTIONAL_ASYMMETRY_DETECTED'));
});

// ---------------------------------------------------------------------------
// The same recovery, over thousands of randomized flights
// ---------------------------------------------------------------------------

/**
 * A parameterised manoeuvre, built straight into analysis records.
 *
 * The fixture is one point in this space. A single hand-picked point is how the
 * last four silent defects here got through, so the same shape is swept over
 * randomized peaks, errors, ringing amplitudes and sample rates — including the
 * cases where the injected asymmetry favours the OTHER direction, which a test
 * that hardcoded "negative is worse" would fail.
 */
function manoeuvreRecords(spec) {
  const {
    intervalUs, peakDps, trackingErrorDps, ringingDps, axisIndex, leadSamples
  } = spec;
  const rampSamples = Math.round(40_000 / intervalUs);
  const holdSamples = Math.round(300_000 / intervalUs);
  const releaseSamples = Math.round(60_000 / intervalUs);
  const quietSamples = Math.round(1_100_000 / intervalUs);
  const cycleSamples = rampSamples + holdSamples + releaseSamples + quietSamples;
  const releaseFrom = rampSamples + holdSamples;
  const settleFrom = releaseFrom + releaseSamples;
  const fastDecay = Math.round(300_000 / intervalUs);
  const fastPeriod = Math.max(4, Math.round(40_000 / intervalUs));

  const total = leadSamples + 4 * cycleSamples + leadSamples;
  const setpoint = new Array(total).fill(0);
  const gyro = new Array(total).fill(0);

  for (let cycle = 0; cycle < 4; cycle += 1) {
    const sign = cycle % 2 === 0 ? 1 : -1;
    const direction = sign > 0 ? 'positive' : 'negative';
    const error = trackingErrorDps[direction];
    const amplitude = ringingDps[direction];
    const start = leadSamples + cycle * cycleSamples;

    for (let offset = 0; offset < cycleSamples; offset += 1) {
      let magnitude;
      if (offset < rampSamples) {
        magnitude = Math.trunc((peakDps * offset) / rampSamples);
      } else if (offset < releaseFrom) {
        magnitude = peakDps;
      } else if (offset < settleFrom) {
        magnitude = Math.trunc(
          (peakDps * (releaseSamples - 1 - (offset - releaseFrom))) / (releaseSamples - 1)
        );
      } else {
        magnitude = 0;
      }

      const step = start + offset;
      setpoint[step] = magnitude * sign;
      if (offset < settleFrom) {
        gyro[step] = setpoint[step] - error * sign;
      } else {
        const since = offset - settleFrom;
        const envelope = Math.max(0, Math.trunc((amplitude * (fastDecay - since)) / fastDecay));
        const phase = (since + Math.trunc(fastPeriod / 4)) % fastPeriod;
        const half = fastPeriod >> 1;
        const rising = phase < half ? phase : fastPeriod - phase;
        gyro[step] = Math.trunc((rising * 2 * envelope) / half) - envelope;
      }
    }
  }

  return setpoint.map((value, index) => {
    const command = [0, 0, 0];
    const measured = [0, 0, 0];
    command[axisIndex] = value;
    measured[axisIndex] = gyro[index];
    return {
      timeUs: index * intervalUs,
      setpoint: command,
      gyro: measured,
      raw: measured,
      terms: [10, 20, 5],
      headspeed: 2000,
      collective: 50,
      vbat: 250
    };
  });
}

test('the injected asymmetry is recovered over thousands of randomized manoeuvres', () => {
  // Deterministic draw, so a failure is reproducible from the seed alone.
  let state = 0x52_4c_07_01 >>> 0;
  const next = bound => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state >>> 8) % bound;
  };

  const axes = ['roll', 'pitch', 'yaw'];
  let checked = 0;
  let asymmetricTracking = 0;
  let positiveWorse = 0;

  for (let draw = 0; draw < 2000; draw += 1) {
    const axisIndex = next(3);
    const axis = axes[axisIndex];
    const spec = {
      intervalUs: [2000, 4000, 5000][next(3)],
      // Well above the 80 deg/s command threshold, and up past the reference
      // flight's 250 deg/s pirouettes.
      peakDps: 100 + next(220),
      // Includes equal pairs, near-equal pairs, and extreme splits.
      trackingErrorDps: {positive: 2 + next(29), negative: 2 + next(29)},
      ringingDps: {positive: 5 + next(56), negative: 5 + next(56)},
      axisIndex,
      leadSamples: 20 + next(40)
    };
    // Adversarial: force an exactly symmetric pair every eighth draw, where
    // `higher` is a coin toss and only the absolute values mean anything.
    if (draw % 8 === 0) {
      spec.trackingErrorDps.negative = spec.trackingErrorDps.positive;
    }

    const records = manoeuvreRecords(spec);
    const diagnostics = detectStopEvents(records, {axis, diagnostics: true});
    const evidence = buildDirectionalStopEvidence(diagnostics.events, {axis});
    const capture = describeStopCapture(diagnostics, {axis});

    assert.equal(
      capture.state, 'captured',
      `draw ${draw} ${axis}: state ${capture.state}, ` +
      `rejections ${JSON.stringify(diagnostics.diagnosis.rejections)}, spec ${JSON.stringify(spec)}`
    );
    assert.deepEqual(capture.captured, {positive: 2, negative: 2}, `draw ${draw} counts`);

    for (const direction of ['positive', 'negative']) {
      const measured = evidence.directions[direction].trackingRmsDps;
      const injected = spec.trackingErrorDps[direction];
      // No ripple in this generator, so the recovery is exact.
      assert.equal(
        measured, injected,
        `draw ${draw} ${axis} ${direction}: tracking ${measured}, injected ${injected}`
      );
    }

    const [tracking] = directionalObservations(evidence, ['trackingRmsDps']);
    assert.equal(tracking.provisional, false, `draw ${draw} provisional`);

    const {positive, negative} = spec.trackingErrorDps;
    if (positive !== negative) {
      asymmetricTracking += 1;
      const worse = positive > negative ? 'positive' : 'negative';
      if (worse === 'positive') {
        positiveWorse += 1;
      }
      assert.equal(tracking.higher, worse, `draw ${draw} ${axis}: worse side`);
      assert.ok(
        Math.abs(tracking.ratio - Math.max(positive, negative) / Math.min(positive, negative))
          < 1e-9,
        `draw ${draw} ${axis}: ratio ${tracking.ratio}`
      );
    }
    checked += 1;
  }

  assert.equal(checked, 2000);
  // The sweep is worthless if every draw leaned the same way. Both sides must be
  // well represented, or "recovers the asymmetry" would be one hardcoded answer.
  assert.ok(asymmetricTracking > 1500, `only ${asymmetricTracking} asymmetric draws`);
  assert.ok(
    positiveWorse > asymmetricTracking * 0.35 && positiveWorse < asymmetricTracking * 0.65,
    `${positiveWorse} of ${asymmetricTracking} draws had the positive direction worse`
  );
});

// ---------------------------------------------------------------------------
// The fixture's payload is not blind to the width slots
// ---------------------------------------------------------------------------

/**
 * Reads a fixture's P-frame field table out of its own header block.
 *
 * Parsed from the committed bytes rather than imported from the generator, so
 * this cannot agree with the generator by construction.
 */
function interFieldsOf(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  const lines = text.slice(0, text.indexOf('H debug_mode:') + 200).split('\n');
  const valuesOf = key => {
    const line = lines.find(entry => entry.startsWith(`H ${key}:`));
    return line === undefined ? [] : line.slice(key.length + 3).split(',');
  };

  const names = valuesOf('Field I name');
  const predictors = valuesOf('Field P predictor').map(Number);
  const encodings = valuesOf('Field P encoding').map(Number);
  return names.map((name, index) => ({
    name, predictor: predictors[index], encoding: encodings[index]
  }));
}

/** Byte width TAG2_3S32 selector 3 spends on one residual: 1 to 4. */
function widthOf(residual) {
  const magnitude = Math.abs(residual);
  if (magnitude <= 127) return 1;
  if (magnitude <= 32_767) return 2;
  if (magnitude <= 8_388_607) return 3;
  return 4;
}

const fitsSigned = (value, bits) => {
  const limit = 2 ** (bits - 1);
  return value >= -limit && value < limit;
};

/**
 * Census of TAG2_3S32 selector-3 groups in a decoded session, by width pattern.
 *
 * Computed from the residuals the frames imply — value minus previous value for
 * a PREVIOUS-predicted field — using the shipped grouping rule. It touches
 * neither the encoder nor the width-slot layout, so it cannot inherit whatever
 * either of them assumes.
 */
function selectorThreeCensus(session, fields) {
  const census = {groups: 0, unequal01: 0, unequal12: 0};

  for (let index = 0; index < fields.length;) {
    const {encoding} = fields[index];
    let run = 1;
    while (index + run < fields.length && fields[index + run].encoding === encoding) {
      run += 1;
    }
    const count = groupSize(encoding, run);
    const group = fields.slice(index, index + count);
    index += count;

    if (encoding !== Encoding.TAG2_3S32 || count !== 3
      || !group.every(field => field.predictor === Predictor.PREVIOUS)) {
      continue;
    }

    const slots = group.map(field => fields.indexOf(field));
    const intra = new Set(session.intraSampleIndices);

    for (let sample = 1; sample < session.samples.length; sample += 1) {
      if (intra.has(sample)) {
        continue; // an I frame carries absolutes, not residuals
      }
      const residuals = slots.map(
        slot => session.samples[sample][slot] - session.samples[sample - 1][slot]
      );
      // Selector 3 is the fallback: anything the narrower packings cannot hold.
      if (residuals.every(value => fitsSigned(value, 6))) {
        continue;
      }
      const widths = residuals.map(widthOf);
      census.groups += 1;
      if (widths[0] !== widths[1]) {
        census.unequal01 += 1;
      }
      if (widths[1] !== widths[2]) {
        census.unequal12 += 1;
      }
    }
  }

  return census;
}

test('this fixture is the only one whose payload can see the selector-3 width slots', async () => {
  // Measured 2026-08-12: every TAG2_3S32 selector-3 group the rest of the corpus
  // produces has three EQUAL widths — 87 of 87 in rf43-single-session, and the
  // reference 4.6 log is degenerate in the first slot pair too, 633 of 633. On a
  // corpus like that, permuting the width slots is a byte-for-byte no-op, so
  // nothing anywhere would notice a decoder reading them in a different order.
  //
  // What this pins is our decoder against our writer, and nothing more: both are
  // ours and both would move together if the layout assumption is wrong. Only
  // firmware output can settle the layout — see docs/BLACKBOX_FORMAT_NOTES.md.
  const fixture = buildFixtures().find(entry => entry.file === FIXTURE);
  assert.ok(fixture, 'the stop fixture must be in the corpus');

  const [frames] = fixture.expected;
  const [session] = decodeLog(new Uint8Array(fixture.bytes)).sessions;
  assert.deepEqual(session.errors, []);
  assert.deepEqual(session.samples, frames, 'the committed bytes must round-trip exactly');

  const census = selectorThreeCensus(session, interFieldsOf(fixture.bytes));
  assert.ok(census.groups > 0, 'the fixture must reach selector 3 at all');
  assert.ok(
    census.unequal01 > 0,
    `no selector-3 group has width[0] != width[1] (${census.groups} groups). That is the ` +
    'one slot pair no real log we hold separates, so without it this corpus cannot tell ' +
    'the shipped order from its field-0/field-1 transposition either.'
  );
  assert.ok(
    census.unequal12 > 0,
    `no selector-3 group has width[1] != width[2] (${census.groups} groups)`
  );

  // The corollary, stated as a measurement rather than left in a comment: the
  // long-standing fixture cannot do this. If this ever stops being zero that is
  // an improvement — relax the assertion, do not weaken the fixture.
  const short = await decodeFixture('rf43-single-session.TXT');
  const shortCensus = selectorThreeCensus(
    short.sessions[0],
    interFieldsOf(buildFixtures().find(entry => entry.file === 'rf43-single-session.TXT').bytes)
  );
  assert.ok(shortCensus.groups > 0, 'the older fixture does reach selector 3');
  assert.equal(shortCensus.unequal01, 0);
  assert.equal(shortCensus.unequal12, 0);
});

// ===========================================================================
// THE FAULT LIBRARY
//
// Eight committed logs, six named conclusions, and for every fault a CONTROL
// that differs from it in exactly ONE term. Every assertion below runs the
// whole engine — decode the committed bytes, build the mechanical spectrum,
// build analysis records, build recommendations — and every one asserts BOTH
// directions: the fault earns its verdict, AND its control does not.
//
// WHY BOTH DIRECTIONS, EVERY TIME. A fixture that produces its verdict no
// matter what is measuring nothing, and this repository has shipped that exact
// defect six times. Presence alone would pass on a fixture whose injected fault
// had been deleted, as long as some other property of the flight happened to
// reach the same finding. Absence on the twin is what makes the injected term
// load-bearing.
//
// WHY THESE READ BYTES RATHER THAN RECORDS. `ui-browser.test.mjs` proves the
// adjustment path from record objects built inline by the test itself, so its
// assertions never cross the decoder. That is the shape of the round-trip
// defect whose encoder shared the decoder's bug. These start at the file.
//
// THE EXPECTED VERDICTS BELOW ARE WRITTEN OUT BY HAND. Importing the fault
// configs from the generator would make this a test that rebuilds what it
// checks: changing an injected amplitude would move the fixture and the
// expectation together, and the test would stay green for both.
// ===========================================================================

/** Whole-engine result for one committed fixture. Memoised: each costs ~1 s. */
const analysisCache = new Map();

async function analyseFixture(file) {
  if (analysisCache.has(file)) {
    return analysisCache.get(file);
  }
  const promise = (async () => {
    const [session] = (await decodeFixture(file)).sessions;
    assert.deepEqual(session.errors, [], `${file} must decode clean`);

    const bounds = sessionTimeBounds(session);
    const startTimeUs = bounds.startTimeUs;
    const endTimeUs = startTimeUs + Math.min(
      bounds.endTimeUs - startTimeUs, MECHANICAL_CONSTANTS.maximumSelectionDurationUs
    );
    const mechanical = await analyzeMechanicalTimeSeries(
      buildMechanicalSeries(session), {timeRangeUs: {startTimeUs, endTimeUs}}
    );

    const axes = {};
    const axisSummaries = {};
    let records = [];
    for (const axis of ['roll', 'pitch', 'yaw']) {
      const signals = resolveAxisSignals(session, axis);
      if (signals.usable) {
        axisSummaries[axis] = summarizeAxis(session, signals);
      }
      const built = buildAnalysisRecords(session, {axis});
      assert.equal(built.usable, true, `${file} ${axis} records must be usable`);
      records = built.records;
      axes[axis] = {...analyseAxisEvidence(built.records, axis), records: built.records};
    }

    const result = buildRecommendations({axes, records, mechanical, axisSummaries});
    return {session, mechanical, axes, result};
  })();
  analysisCache.set(file, promise);
  return promise;
}

const idsOf = result => result.findings.map(finding => finding.id);
const adjustmentsOf = result => result.findings
  .filter(finding => finding.kind === 'adjustment')
  .map(finding => `${finding.axis}:${finding.id}:${finding.direction}`)
  .sort();

// A safety gate or the global one-change latch can withhold an adjustment after
// its diagnosis was measured. `findingId` keeps that diagnosis testable without
// returning a second imperative instruction.
const diagnosesOf = (result, id) => [
  ...result.findings
    .filter(finding => finding.id === id)
    .map(finding => ({axis: finding.axis, source: 'finding', reason: null})),
  ...result.withheld
    .filter(entry => entry.findingId === id)
    .map(entry => ({axis: entry.axis, source: 'withheld', reason: entry.reason}))
];

/** The named finding was reached on all three axes and nowhere else. */
function assertOnEveryAxis(result, id, message) {
  const axesSaying = diagnosesOf(result, id).map(entry => entry.axis).sort();
  assert.deepEqual(
    axesSaying, ['pitch', 'roll', 'yaw'],
    `${message}: ${id} was reached on [${axesSaying.join(', ')}] — visible findings were `
      + `[${idsOf(result).join(', ')}], withheld were `
      + `[${result.withheld.map(entry => entry.findingId ?? entry.reason).join(', ')}]`
  );
}

function assertNobodySays(result, id, message) {
  const axesSaying = diagnosesOf(result, id).map(entry => entry.axis ?? '-');
  assert.deepEqual(
    axesSaying, [],
    `${message}: ${id} was reached anyway, on [${axesSaying.join(', ')}]`
  );
}

/**
 * The measured shape of one direction of one axis, averaged over its two stops.
 *
 * Read out of `analyseAxisEvidence`'s per-stop `shapes` — `measureStopShape` and
 * `measureTrackingShape` over the decoded records — rather than out of the
 * engine's own internal direction summary. The point of these fixtures is that
 * an injected term survives the trip from bytes to verdict, so the term has to
 * be measured from the bytes independently of the layer being judged.
 */
function directionMetrics(analysis, axis, direction) {
  const entries = analysis.axes[axis].shapes.filter(entry => entry.commandSign === direction);
  assert.equal(entries.length, 2, `${axis} ${direction}: two stops per direction`);
  const average = values => values.reduce((total, value) => total + value, 0) / values.length;
  return {
    plateauRippleDps: average(entries.map(entry => entry.tracking.plateauRippleRmsDps)),
    ringingRmsDps: average(entries.map(entry => entry.event.fastRingingRmsDps)),
    offsetShare: average(entries.map(entry => entry.tracking.offsetShare)),
    signedOffsetDps: average(entries.map(entry => entry.tracking.signedOffsetDps)),
    commandAmplitudeDps: average(entries.map(entry => entry.event.commandAmplitudeDps))
  };
}

/* ---------------------------------------------------------------------------
 * PAIR 1 — too much D, and the log that was never read
 *
 * `rf46-gain-fault.TXT` was added specifically because no `kind: 'adjustment'`
 * finding had ever been rendered from bytes, and was then referenced by nothing
 * in test/ — only by the manifest and the generator. The provenance test hashes
 * it, which pins the bytes and asserts nothing whatever about what the engine
 * says when it reads them. This is that seam.
 * ------------------------------------------------------------------------ */

test('rf46-gain-fault: three D diagnoses yield one actionable change', async () => {
  const {result} = await analyseFixture('rf46-gain-fault.TXT');

  assertOnEveryAxis(result, 'D_TOO_HIGH', 'the gain fault must name the D term');
  assert.deepEqual(adjustmentsOf(result), ['roll:D_TOO_HIGH:decrease']);
  assert.deepEqual(
    diagnosesOf(result, 'D_TOO_HIGH')
      .filter(entry => entry.reason === 'ONE_CHANGE_AT_A_TIME')
      .map(entry => entry.axis).sort(),
    ['pitch', 'yaw']
  );

  // The three findings that separate this from every neighbouring verdict.
  assertNobodySays(result, 'P_TOO_HIGH', 'a quiet plateau is not a P fault');
  assertNobodySays(result, 'RINGING_SOURCE_UNKNOWN', 'a two-second hold is measurable');
  assertNobodySays(result, 'OSCILLATION_MATCHES_AIRFRAME_TONE', '25 Hz is off every rotor order');

  // The rungs above it had to clear for any of that to be spoken.
  assert.ok(idsOf(result).includes('AIRFRAME_CLEAR'));
  assert.ok(idsOf(result).includes('HEADSPEED_STEADY_ENOUGH'));
});

test('rf46-stop-manoeuvres: the same twelve stops earn NO adjustment', async () => {
  // The specificity control that already existed and was never asserted. Same
  // generator, same schedule, same twelve stops; the difference is a deliberate
  // 2.8x directional asymmetry, which is larger than a gain explains. If this
  // ever produces an adjustment, the agreement gate has stopped working.
  const {result} = await analyseFixture('rf46-stop-manoeuvres.TXT');
  assert.deepEqual(adjustmentsOf(result), [],
    `the asymmetric fixture must earn nothing: ${idsOf(result).join(', ')}`);
  assert.ok(idsOf(result).includes('DIRECTIONAL_ASYMMETRY_MECHANICAL'));
});

/* ---------------------------------------------------------------------------
 * PAIR 2 — too much P against too much D, one term apart
 *
 * Both ring after a release. The ONLY thing that separates them is whether the
 * axis was also oscillating while the command was held steady, so the two
 * fixtures differ in exactly that and in nothing else — same seed, same
 * schedule, same ring, same tracking error.
 * ------------------------------------------------------------------------ */

test('rf46-p-too-high: an oscillating plateau moves the verdict from D to P', async () => {
  const {result} = await analyseFixture('rf46-p-too-high.TXT');

  assertOnEveryAxis(result, 'P_TOO_HIGH', 'an axis that chatters while held is a P fault');
  assert.deepEqual(adjustmentsOf(result), [],
    'the P diagnosis must not become advice while its tracking sweep is unstable');
  assertNobodySays(result, 'D_TOO_HIGH', 'the D term is quiet during a hold, and this is not');

  for (const entry of result.withheld.filter(entry => entry.findingId === 'P_TOO_HIGH')) {
    assert.equal(entry.rung, 'gain-P');
    assert.equal(entry.reason, 'GATES_NOT_PASSED');
    assert.equal(entry.gateStatus.stability, 'blocked');
  }
});

test('the P and D fixtures differ ONLY in the plateau, not in the ringing', async () => {
  // If the two files also differed in how hard they ring, "P rather than D"
  // could be coming from the ringing and the plateau term would be decorative.
  // Measured per axis per direction: the post-release ringing must match within
  // a few percent while the plateau ripple differs by a factor of ten or more.
  const fault = await analyseFixture('rf46-p-too-high.TXT');
  const control = await analyseFixture('rf46-gain-fault.TXT');

  for (const axis of ['roll', 'pitch', 'yaw']) {
    for (const direction of ['positive', 'negative']) {
      const faultSide = directionMetrics(fault, axis, direction);
      const controlSide = directionMetrics(control, axis, direction);

      const ringingGap = Math.abs(faultSide.ringingRmsDps - controlSide.ringingRmsDps)
        / controlSide.ringingRmsDps;
      assert.ok(
        ringingGap < 0.08,
        `${axis} ${direction}: the ringing must be the same in both — `
          + `${faultSide.ringingRmsDps} against ${controlSide.ringingRmsDps}`
      );

      assert.ok(
        faultSide.plateauRippleDps > controlSide.plateauRippleDps * 10,
        `${axis} ${direction}: the plateau must be the term that moved — `
          + `${faultSide.plateauRippleDps} against ${controlSide.plateauRippleDps}`
      );
    }
  }
});

test('rf46-ringing-source-unknown: the engine declines when the sweep cannot separate', async () => {
  // The third member of the P/D family, and the one that matters most. Its
  // plateau ripple is a QUARTER of the ringing, which lands inside the range
  // `plateauShareOfRinging` is swept over — so some of the 270 combinations
  // call the axis hold-and-release and others call it release-only. A verdict
  // that depends on which unconstrained constant the engine happened to use is
  // not a verdict, and refusing to give one is the correct output.
  //
  // A corpus that only ever produces D_TOO_HIGH proves nothing about when the
  // engine should decline, which is why this fixture exists at all.
  const edge = await analyseFixture('rf46-ringing-source-unknown.TXT');
  const {result} = edge;

  assertOnEveryAxis(result, 'RINGING_SOURCE_UNKNOWN', 'a sweep that disagrees must not conclude');
  assert.deepEqual(adjustmentsOf(result), [],
    `no gain may be named here: ${idsOf(result).join(', ')}`);
  assertNobodySays(result, 'P_TOO_HIGH', 'the sweep does not agree it was oscillating');
  assertNobodySays(result, 'D_TOO_HIGH', 'the sweep does not agree it was quiet');

  // WHY it is refused, measured from the bytes rather than taken on trust. The
  // ratio the sweep varies is plateau ripple over post-release ringing, and
  // `SHAPE_SWEEP` runs it from 0.15 to 0.40. This fixture's ratio has to land
  // INSIDE that range while its two neighbours land outside it on either side —
  // otherwise the refusal is a coincidence rather than the sweep doing its job.
  const highFault = await analyseFixture('rf46-p-too-high.TXT');
  const quietControl = await analyseFixture('rf46-gain-fault.TXT');
  for (const axis of ['roll', 'pitch', 'yaw']) {
    for (const direction of ['positive', 'negative']) {
      const ratioOf = analysis => {
        const metrics = directionMetrics(analysis, axis, direction);
        return metrics.plateauRippleDps / metrics.ringingRmsDps;
      };
      const edgeRatio = ratioOf(edge);
      assert.ok(edgeRatio > 0.15 && edgeRatio < 0.40,
        `${axis} ${direction}: this fixture's ratio ${edgeRatio} must be inside the swept range`);
      assert.ok(ratioOf(highFault) > 0.40,
        `${axis} ${direction}: the P fault's ratio ${ratioOf(highFault)} must be above it`);
      assert.ok(ratioOf(quietControl) < 0.15,
        `${axis} ${direction}: the D control's ratio ${ratioOf(quietControl)} must be below it`);
    }
  }

  for (const finding of result.findings.filter(entry => entry.id === 'RINGING_SOURCE_UNKNOWN')) {
    assert.equal(finding.kind, 'next-flight');
    // It has to name BOTH candidates. A refusal that names one is a verdict
    // wearing a refusal's clothes.
    assert.deepEqual([...finding.candidates].sort(),
      ['too much D on this axis', 'too much P on this axis']);
    assert.match(finding.confirm, /two seconds/);
  }
});

/* ---------------------------------------------------------------------------
 * PAIR 3 — the twin. Identical gyro, one column apart.
 *
 * The strongest control in the corpus, because it is not "a different flight":
 * it is the SAME flight with the head speed moved so the ring lands on 1/rev
 * instead of between orders.
 * ------------------------------------------------------------------------ */

test('the twin pair is sample-identical except for the head speed it was flown at', async () => {
  const off = (await analyseFixture('rf46-tone-off-rotor-order.TXT')).session;
  const on = (await analyseFixture('rf46-tone-on-rotor-order.TXT')).session;

  const names = off.fields.map(field => field.name);
  assert.deepEqual(names, on.fields.map(field => field.name));
  assert.equal(off.samples.length, on.samples.length);

  const differing = [];
  for (let index = 0; index < names.length; index += 1) {
    for (let sample = 0; sample < off.samples.length; sample += 1) {
      if (off.samples[sample][index] !== on.samples[sample][index]) {
        differing.push(names[index]);
        break;
      }
    }
  }
  // Head speed, and the tail speed geared off it. Nothing the loop can see.
  assert.deepEqual(differing.sort(), ['headspeed', 'tailspeed'],
    `these columns differ between the twins: ${differing.join(', ')}`);

  const headspeedIndex = names.indexOf('headspeed');
  const median = samples => {
    const values = samples.map(sample => sample[headspeedIndex]).sort((a, b) => a - b);
    return values[values.length >> 1];
  };
  // 2050/60 = 34.2 Hz, 1500/60 = 25.0 Hz, and the ring is at 25 Hz in both. The
  // governor ripple is ±20 rpm, so the median lands a count either side.
  assert.ok(Math.abs(median(off.samples) - 2050) <= 2,
    `the off-order twin runs at 2050 rpm, measured ${median(off.samples)}`);
  assert.ok(Math.abs(median(on.samples) - 1500) <= 2,
    `the on-order twin runs at 1500 rpm, measured ${median(on.samples)}`);
});

test('the twin pair: off a rotor order the gain is named, on one it is refused', async () => {
  const off = await analyseFixture('rf46-tone-off-rotor-order.TXT');
  const on = await analyseFixture('rf46-tone-on-rotor-order.TXT');

  assertOnEveryAxis(off.result, 'D_TOO_HIGH', 'off every rotor order the loop is the explanation');
  assert.deepEqual(adjustmentsOf(off.result), ['roll:D_TOO_HIGH:decrease']);
  assert.deepEqual(
    diagnosesOf(off.result, 'D_TOO_HIGH')
      .filter(entry => entry.reason === 'ONE_CHANGE_AT_A_TIME')
      .map(entry => entry.axis).sort(),
    ['pitch', 'yaw']
  );
  assertNobodySays(off.result, 'OSCILLATION_MATCHES_AIRFRAME_TONE', '25 Hz is not 34.2 Hz');

  assertOnEveryAxis(on.result, 'OSCILLATION_MATCHES_AIRFRAME_TONE',
    'on 1/rev a mechanical explanation is on the table and one flight cannot exclude it');
  assert.deepEqual(adjustmentsOf(on.result), [],
    `no gain may be named at a rotor order: ${idsOf(on.result).join(', ')}`);
  assertNobodySays(on.result, 'D_TOO_HIGH', 'lowering D to quieten a rotor order does not');

  // The refusal has to say which order, or it is not a refusal a pilot can act
  // on. It also outranks the gain rungs, which is why it is not merely silence.
  for (const finding of on.result.findings
    .filter(entry => entry.id === 'OSCILLATION_MATCHES_AIRFRAME_TONE')) {
    assert.equal(finding.rung, 'axis-mechanical');
    assert.equal(finding.kind, 'next-flight');
    assert.match(finding.headline, /same frequency as something the airframe is already/);
    assert.match(finding.confirm, /clearly different head speed/);
    const rotorEntry = finding.basis.find(entry => /rotor order it matches/.test(entry.label));
    assert.equal(rotorEntry.value, 'main rotor, order 1');
  }

  // And the tone itself is present in BOTH — same amplitude, same frequency.
  // Without this the pair could be passing because one file has a tone and the
  // other has none, which is a difference in two terms rather than one.
  for (const analysis of [off, on]) {
    assert.ok(idsOf(analysis.result).includes('AIRFRAME_TONE_BELOW_ATTENTION'));
    assert.equal(analysis.mechanical.status, 'clear');
  }
});

/* ---------------------------------------------------------------------------
 * PAIR 4 — the governor. A blocker that has to actually block.
 * ------------------------------------------------------------------------ */

test('rf46-governor-droop: the head speed rung suppresses the gains below it', async () => {
  const droop = await analyseFixture('rf46-governor-droop.TXT');
  const steady = await analyseFixture('rf46-gain-fault.TXT');

  // Same twelve stops, same capture, same evidence — and one selected adjustment in
  // one and none in the other. `RUNGS` is an ordered list precisely so a
  // blocker suppresses what sits under it; a blocker that does not is the
  // reason the list would be decorative.
  assert.deepEqual(adjustmentsOf(steady.result), ['roll:D_TOO_HIGH:decrease']);
  assert.deepEqual(adjustmentsOf(droop.result), [],
    `a drooping governor must suppress every gain: ${idsOf(droop.result).join(', ')}`);

  // It is suppressed rather than absent: the evidence is still there and the
  // engine says so, which is the difference between "nothing was measured" and
  // "this was measured and may not be spoken yet".
  const withheld = droop.result.withheld
    .filter(entry => entry.reason === 'GATES_NOT_PASSED');
  assert.deepEqual(withheld.map(entry => entry.axis).sort(), ['pitch', 'roll', 'yaw']);
  for (const entry of withheld) {
    assert.equal(entry.gateStatus.headspeed, 'blocked', `${entry.axis} head-speed gate`);
    // And the rungs ABOVE the head speed are not what stopped it. If the
    // airframe blocked here too, this fixture would prove nothing about the
    // governor — it would be two faults arriving together.
    assert.equal(entry.gateStatus.airframe, 'permitted', `${entry.axis} airframe`);
    assert.equal(entry.gateStatus.completeness, 'permitted', `${entry.axis} completeness`);
    assert.equal(entry.gateStatus.agreement, 'permitted', `${entry.axis} agreement`);
  }
  // On yaw head speed is the sole blocker among the four evidence/configuration
  // gates. The mandatory stability sweep may block independently; that is a
  // fifth gate, not a reason to stop testing whether head speed has leverage.
  const yaw = withheld.find(entry => entry.axis === 'yaw');
  assert.deepEqual(
    Object.entries(yaw.gateStatus).filter(([, status]) => status === 'blocked')
      .map(([gate]) => gate)
      .filter(gate => gate !== 'stability'),
    ['headspeed'],
    `yaw should be blocked among the core gates by head speed alone: ${JSON.stringify(yaw.gateStatus)}`
  );

  // The airframe still clears on the drooping log — about 9.5% spread against
  // the 12% the rotor-harmonic check needs — so the suppression is the governor
  // and not a vibration finding arriving with it.
  assert.equal(droop.mechanical.harmonicCorrelation.state, 'evaluated');
  assert.ok(
    droop.mechanical.rpmEvidence.headspeed.relativeSpread > 0.05
      && droop.mechanical.rpmEvidence.headspeed.relativeSpread < 0.12,
    `droop spread ${droop.mechanical.rpmEvidence.headspeed.relativeSpread}`
  );
  assert.ok(steady.mechanical.rpmEvidence.headspeed.relativeSpread < 0.02);
});

/* ---------------------------------------------------------------------------
 * PAIR 5 — too little P against a control at its travel limit
 *
 * The same shape, differing only in how much of the commanded rate is missing.
 * This is the pair that stops "raise P" being aimed at a mechanical stop, which
 * is the failure `AUTHORITY_LIMITS.standingOffsetShareOfCommand` was added for:
 * the old engine grew MORE confident the harder the control was jammed.
 * ------------------------------------------------------------------------ */

test('rf46-p-too-low: a shortfall is diagnosed but unstable advice is withheld', async () => {
  const {result} = await analyseFixture('rf46-p-too-low.TXT');

  assertOnEveryAxis(result, 'P_TOO_LOW', 'an axis sitting below the commanded rate');
  assert.deepEqual(adjustmentsOf(result), [],
    'the P diagnosis must not become advice while its tracking sweep is unstable');
  assertNobodySays(result, 'AXIS_DOES_NOT_ARREST', '19% of the command is one step away');
  // Not read as ringing. A failure to arrest is not an oscillation, and calling
  // it one would lower the very gain that is meant to stop the aircraft.
  assertNobodySays(result, 'D_TOO_HIGH', 'there is no oscillation here at all');
  assertNobodySays(result, 'P_TOO_HIGH', 'and none during the hold either');

  for (const entry of result.withheld.filter(entry => entry.findingId === 'P_TOO_LOW')) {
    assert.equal(entry.rung, 'gain-P');
    assert.equal(entry.reason, 'GATES_NOT_PASSED');
    assert.equal(entry.gateStatus.stability, 'blocked');
  }
});

test('rf46-travel-limit: the same shape, too far short for a gain, is refused', async () => {
  const {result} = await analyseFixture('rf46-travel-limit.TXT');

  assertOnEveryAxis(result, 'AXIS_DOES_NOT_ARREST', 'half the commanded rate is missing');
  assert.deepEqual(adjustmentsOf(result), [],
    `no gain may be named against a stop: ${idsOf(result).join(', ')}`);
  assertNobodySays(result, 'P_TOO_LOW',
    'raising P into a travel limit is the failure this pair exists for');

  for (const finding of result.findings.filter(entry => entry.id === 'AXIS_DOES_NOT_ARREST')) {
    // The out-of-authority wording, not the generic "this log does not say why".
    // Those are two different roads to the same finding and a pilot needs to
    // know which one he is on.
    assert.match(finding.headline, /too large for a gain to be the whole story/);
    assert.match(finding.reasoning, /travel limit/);
    assert.match(finding.confirm, /half the rate/);
    assert.ok(finding.candidates.some(entry => /travel or rate limit/.test(entry)));
  }
});

test('the authority pair differs only in the rate the aircraft settled at', async () => {
  const soft = await analyseFixture('rf46-p-too-low.TXT');
  const jammed = await analyseFixture('rf46-travel-limit.TXT');

  for (const axis of ['roll', 'pitch', 'yaw']) {
    for (const direction of ['positive', 'negative']) {
      const softSide = directionMetrics(soft, axis, direction);
      const jammedSide = directionMetrics(jammed, axis, direction);

      // The command flown is the same in both, or the shortfall SHARE would be
      // moving for two reasons at once and the pair would prove nothing.
      assert.ok(
        Math.abs(softSide.commandAmplitudeDps - jammedSide.commandAmplitudeDps) < 1,
        `${axis} ${direction}: command ${softSide.commandAmplitudeDps} against `
          + `${jammedSide.commandAmplitudeDps}`
      );
      // Both are clean standing offsets — that is the SHARED property. If the
      // jammed one were merely messier, "not a gain" could be coming from the
      // shape rather than from the size.
      for (const side of [softSide, jammedSide]) {
        assert.ok(side.offsetShare > 0.6,
          `${axis} ${direction} offset share ${side.offsetShare}`);
        assert.ok(side.signedOffsetDps > 0,
          `${axis} ${direction} must sit behind the command`);
      }

      const softShare = softSide.signedOffsetDps / softSide.commandAmplitudeDps;
      const jammedShare = jammedSide.signedOffsetDps / jammedSide.commandAmplitudeDps;
      // 0.35 is the limit. Both sit a clear factor away from it, on opposite
      // sides, so neither verdict is balanced on the constant.
      assert.ok(softShare > 0.15 && softShare < 0.25,
        `${axis} ${direction}: soft-loop shortfall share ${softShare}`);
      assert.ok(jammedShare > 0.45 && jammedShare < 0.55,
        `${axis} ${direction}: jammed shortfall share ${jammedShare}`);
    }
  }
});

/* ---------------------------------------------------------------------------
 * The corpus as a whole: no knob may quietly stop doing anything.
 * ------------------------------------------------------------------------ */

test('every fault fixture reaches the one conclusion it was built for', async () => {
  // A library whose members all produce the same output is one fixture with
  // eight file names. This is the assertion that would catch a knob quietly
  // ceasing to do anything — the fixture would still decode, still capture
  // twelve stops, still pass its neighbours' absence checks, and collapse onto
  // whichever verdict its base flight already produced.
  const library = [
    'rf46-gain-fault.TXT',
    'rf46-p-too-high.TXT',
    'rf46-ringing-source-unknown.TXT',
    'rf46-governor-droop.TXT',
    'rf46-tone-off-rotor-order.TXT',
    'rf46-tone-on-rotor-order.TXT',
    'rf46-p-too-low.TXT',
    'rf46-travel-limit.TXT'
  ];

  const verdicts = new Map();
  for (const file of library) {
    const {result} = await analyseFixture(file);
    // The gain-rung conclusion only: the rungs above it are shared by design.
    const visible = result.findings
      .filter(finding => ['axis-mechanical', 'gain-P', 'gain-D', 'gain-I'].includes(finding.rung))
      .map(finding => ({id: finding.id, axis: finding.axis, reason: null}));
    const hidden = result.withheld
      .filter(entry => entry.findingId
        && ['axis-mechanical', 'gain-P', 'gain-D', 'gain-I'].includes(entry.rung))
      .map(entry => ({id: entry.findingId, axis: entry.axis, reason: entry.reason}));
    const conclusion = [...visible, ...hidden];

    if (conclusion.length === 0) {
      // Nothing was SAID, which is not the same as nothing being found. A log
      // whose gates blocked still measured a shape on all three axes and
      // reports it withheld, and that distinction is the whole governor case.
      const blocked = result.withheld.filter(entry => entry.reason === 'GATES_NOT_PASSED');
      assert.deepEqual(blocked.map(entry => entry.axis).sort(), ['pitch', 'roll', 'yaw'],
        `${file} said nothing and withheld nothing — it measured nothing at all`);
      verdicts.set(file, 'WITHHELD_BY_GATES');
      continue;
    }

    const distinct = [...new Set(conclusion.map(entry => entry.id))].sort();
    assert.equal(distinct.length, 1,
      `${file} must reach ONE conclusion on all three axes, got [${distinct.join(', ')}]`);
    assert.equal(conclusion.length, 3, `${file} must reach it on all three axes`);
    const entirelyGateWithheld = conclusion.every(entry => entry.reason === 'GATES_NOT_PASSED');
    verdicts.set(file, entirelyGateWithheld ? `${distinct[0]}:WITHHELD_BY_GATES` : distinct[0]);
  }

  assert.equal(verdicts.get('rf46-gain-fault.TXT'), 'D_TOO_HIGH');
  assert.equal(verdicts.get('rf46-tone-off-rotor-order.TXT'), 'D_TOO_HIGH');
  assert.equal(verdicts.get('rf46-governor-droop.TXT'), 'WITHHELD_BY_GATES');
  assert.equal(verdicts.get('rf46-p-too-high.TXT'), 'P_TOO_HIGH:WITHHELD_BY_GATES');
  assert.equal(verdicts.get('rf46-ringing-source-unknown.TXT'), 'RINGING_SOURCE_UNKNOWN');
  assert.equal(verdicts.get('rf46-tone-on-rotor-order.TXT'), 'OSCILLATION_MATCHES_AIRFRAME_TONE');
  assert.equal(verdicts.get('rf46-p-too-low.TXT'), 'P_TOO_LOW:WITHHELD_BY_GATES');
  assert.equal(verdicts.get('rf46-travel-limit.TXT'), 'AXIS_DOES_NOT_ARREST');

  // Seven distinct outcomes from eight logs. The one repeat is deliberate: the
  // twin pair's control is the same D fault as `rf46-gain-fault.TXT`, because
  // the twin's whole claim is that the head speed alone moves the verdict.
  assert.equal(new Set(verdicts.values()).size, 7,
    `the library reaches ${new Set(verdicts.values()).size} distinct outcomes: `
      + `${[...new Set(verdicts.values())].join(', ')}`);
});
