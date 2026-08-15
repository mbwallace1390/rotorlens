/**
 * The layer that tells a pilot what to adjust — and refuses to when it cannot.
 *
 * THIS FILE EXISTS BECAUSE OF A SPECIFIC DEFECT CLASS. Five times in this
 * repository's history a test passed a fully green suite while being unable to
 * reach the failure it named: a provenance test that rewrote its own fixtures,
 * an advisor-bundle test that rebuilt what it checked, a layout assertion
 * measured mid-scroll, a decoder round-trip whose encoder shared the decoder's
 * bug, and a safety guard that swept only part of what its module could emit.
 *
 * A recommendation engine that has never been shown a fault it must diagnose has
 * not been tested at all, so the structure here is:
 *
 *  1 INJECTED FAULTS. Flights are BUILT with a named fault in them — too much D,
 *    too much P, too little P, too little I, an over-large I, a binding linkage,
 *    a mechanical resonance — and the engine is required to name the right one.
 *    The generator writes physics (a damping ratio, a frequency, a residual rate,
 *    a controller gain); the engine measures crossings, envelopes and peaks. The
 *    two do not share a formula, so getting a measurement wrong makes a fixture
 *    come out as the wrong fault rather than quietly agreeing.
 *
 *  2 THE HOLD FIXTURES ARE A CLOSED-LOOP SIMULATION, not painted metrics. A PID
 *    controller runs against a plant, and the fault is a wrong GAIN. Nothing in
 *    the generator knows what `interpretHoldEvidence` measures.
 *
 *  3 RANDOMISED SWEEPS, thousands of draws, for everything numeric — plus a few
 *    hand-picked cases for readability. A hand-picked case cannot show that a
 *    classifier is monotone in damping, and monotone in damping is the whole
 *    claim.
 *
 *  4 A GUARD ON THE OUTPUT ITSELF. Only an `adjustment` may carry a direction;
 *    every adjustment must carry a basis, a confidence and a confirming flight;
 *    no finding may carry a magnitude; and no adjustment may survive a blocked
 *    rung above it. This is the re-scoped successor to the measurement-only
 *    guard in axis-report.test.mjs, which the product decision of 12 August 2026
 *    made too broad — it is now wrong to forbid direction everywhere, and right
 *    to forbid it everywhere it has not been earned.
 *
 * Every assertion below was verified by mutating the module and watching it go
 * red. The failure text is recorded in the report that accompanied this file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  AUTHORITY_LIMITS,
  BIND_LIMITS,
  DIRECTIONS,
  GAIN_GATE_THRESHOLDS,
  HOLD_SWEEP,
  RUNGS,
  SHAPE_DEFAULTS,
  SHAPE_SWEEP,
  airframeAmbiguity,
  analyseAxisEvidence,
  assessAirframe,
  assessHeadspeed,
  assessHoldIndication,
  buildRecommendations,
  classifyStopShape,
  coincidentTone,
  measureStopShape,
  measureTrackingShape,
  orderFindings,
  oscillationSource,
  resolvePlateauDeparture,
  separableFromNoiseFloor,
  shapeSweepCombinations,
  sweepStopShapeConclusion,
  timesWorse,
  unmatchedTone
} from '../src/analysis/recommendations.mjs';

import {decodeLog} from '../src/blackbox/decode.mjs';
import {buildAnalysisRecords, detectStopEvents, STOP_DETECTION_DEFAULTS}
  from '../src/analysis/records.mjs';
import {resolveAxisSignals, summarizeAxis} from '../src/analysis/axis-report.mjs';
import {
  analyzeMechanicalTimeSeries,
  buildMechanicalSeries,
  sessionTimeBounds
} from '../src/analysis/advisor/mechanical-spectrum.mjs';

const REAL_LOG = process.env.ROTORLENS_REAL_LOG;
const STOP_FIXTURE = new URL(
  '../fixtures/synthetic/rf46-stop-manoeuvres.TXT', import.meta.url
);
const GAIN_FAULT_FIXTURE = new URL(
  '../fixtures/synthetic/rf46-gain-fault.TXT', import.meta.url
);

/* ------------------------------------------------------------------ generators */

/** Deterministic PRNG, so a fixture is the same flight every run. */
function rng(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const AXIS_INDEX = {roll: 0, pitch: 1, yaw: 2};

/**
 * A flight built around a NAMED PHYSICAL RESPONSE, one stop at a time.
 *
 * The response after each release is written as an explicit second-order
 * transient plus a residual:
 *
 *   rate(t) = sign * [ residualDps * exp(-t / residualTauS)
 *                    + amplitudeDps * exp(-zeta * w * t) * sin(w * t) ]
 *
 * so a fixture is specified by things a control engineer would say out loud — a
 * damping ratio, a frequency, how much rate was left in the commanded direction
 * — and never by the quantities the engine measures. `zeta` near zero is a flat
 * envelope (ringing); `zeta` near one is a transient that dies; a large
 * `residualDps` is an axis that did not arrest whatever the oscillation does.
 *
 * During the hold, the aircraft sits `trackingOffsetDps` BEHIND the command
 * (which is the too-little-P signature) with `plateauRippleDps` of oscillation
 * about it (which is the too-much-P signature, because a marginal loop chatters
 * while it holds).
 */
function buildStopFlight({
  axis = 'yaw',
  amplitudeDps = 200,
  stopCount = 4,
  holdS = 1.6,
  rampS = 0.1,
  releaseS = 0.02,
  gapS = 2.6,
  sampleHz = 1000,
  residualDps = 3,
  residualTauS = 0.05,
  ringAmplitudeDps = 6,
  zeta = 0.6,
  frequencyHz = 14,
  trackingOffsetDps = 1.5,
  plateauRippleDps = 0.3,
  plateauRippleHz = 18,
  noiseDps = 0.5,
  laggyRelease = false,
  headspeedRpm = 1800,
  headspeedJitterRpm = 4,
  vibration = null,
  seed = 4242
} = {}) {
  const index = AXIS_INDEX[axis];
  const random = rng(seed);
  const dt = 1 / sampleHz;
  const period = rampS + holdS + releaseS + gapS;
  const totalS = period * stopCount + 1.5;
  const samples = Math.round(totalS / dt);
  const w = 2 * Math.PI * frequencyHz;
  const records = [];

  for (let step = 0; step < samples; step += 1) {
    const t = step * dt;
    const which = Math.floor(t / period);
    const local = t - which * period;
    const sign = which % 2 === 0 ? 1 : -1;
    const active = which < stopCount;

    let command = 0;
    let rate = 0;
    if (active && local < rampS) {
      command = sign * amplitudeDps * (local / rampS);
      rate = command - sign * trackingOffsetDps * (local / rampS);
    } else if (active && local < rampS + holdS) {
      command = sign * amplitudeDps;
      rate = command - sign * trackingOffsetDps
        + plateauRippleDps * Math.sin(2 * Math.PI * plateauRippleHz * t);
    } else if (active && local < rampS + holdS + releaseS) {
      const through = (local - rampS - holdS) / releaseS;
      command = sign * amplitudeDps * (1 - through);
      // `laggyRelease` holds the aircraft at its plateau rate while the command
      // falls away beneath it, which is what a real release looks like: the
      // stick reaches centre long before the machine does. It matters here
      // because `plateauFraction` is 0.9, so the tracking window ends a little
      // way INTO this ramp and the error across it is enormous compared with
      // the error during the hold.
      rate = laggyRelease
        ? sign * (amplitudeDps - trackingOffsetDps)
        : command - sign * trackingOffsetDps * (1 - through);
    } else if (active) {
      const since = local - rampS - holdS - releaseS;
      rate = sign * (
        residualDps * Math.exp(-since / residualTauS)
        + ringAmplitudeDps * Math.exp(-zeta * w * since) * Math.sin(w * since)
      );
    }

    const noise = (random() - 0.5) * 2 * noiseDps;
    const vibrationDps = vibration
      ? vibration.amplitudeDps * Math.sin(2 * Math.PI * vibration.frequencyHz * t)
      : 0;

    const setpoint = [0, 0, 0];
    const gyro = [0, 0, 0];
    const raw = [0, 0, 0];
    setpoint[index] = command;
    gyro[index] = rate + noise;
    // Vibration lives in the unfiltered signal, which is where the mechanical
    // analysis looks and where a filter chain would not have removed it.
    for (let other = 0; other < 3; other += 1) {
      raw[other] = gyro[other] + vibrationDps + (random() - 0.5) * 2 * noiseDps;
    }

    records.push({
      timeUs: Math.round(t * 1e6),
      setpoint,
      gyro,
      raw,
      terms: [0, 0, 0],
      headspeed: headspeedRpm + (random() - 0.5) * 2 * headspeedJitterRpm,
      collective: 0,
      vbat: 24 + (random() - 0.5) * 0.05
    });
  }
  return records;
}

/**
 * A CLOSED-LOOP flight: a real PID controller against a first-order plant with
 * transport delay, actuator lag and a gyro filter.
 *
 * The fault is a wrong GAIN — nothing here writes an error, a ripple or a
 * crossing rate. `disturbanceDps2` is a standing torque the loop has to hold
 * against (main-rotor torque on the tail, a nose-down trim), which is what makes
 * a missing I term show up as a standing error. `gustDps2` is low-frequency
 * turbulence, which is what excites an over-large I term into hunting.
 * `actuatorLimit` is a control that cannot move past a point — a bind.
 */
function simulateHoldFlight({
  axis = 'yaw',
  gains,
  seed = 9001,
  durationS = 28,
  splitAtS = 12,
  splitPulseS = 0.4,
  splitAmplitudeDps = 120,
  disturbanceDps2 = 0,
  gustDps2 = 0,
  gustTauS = 0.3,
  actuatorLimit = Infinity,
  // The flight controller's own `iterm_limit`. Every real one has it, and this
  // simulator did not until 13 August 2026 — which is exactly why the bind
  // discriminator could be switched off by a setting RotorLens cannot see.
  integratorLimit = Infinity,
  // A periodic torque from OUTSIDE the loop: a hunting governor modulating
  // main-rotor torque, a slipping belt, wind. The loop's job is to reject it and
  // it cannot; nothing about the gains is wrong.
  externalTorqueDps2 = 0,
  externalTorqueHz = 0.8,
  // Stop manoeuvres instead of one split pulse, for the stop-shape path.
  stops = null,
  noiseDps = 0.8,
  headspeedRpm = 1800
} = {}) {
  const plant = {
    dt: 0.001, delaySamples: 3, actuatorTau: 0.020, derivativeTau: 0.003,
    gyroTau: 0.0015, controlAuthority: 800, damping: 2
  };
  const index = AXIS_INDEX[axis];
  const random = rng(seed);
  const samples = Math.round(durationS / plant.dt);
  const records = [];
  const delayLine = new Array(plant.delaySamples).fill(0);
  let rate = 0;
  let actuator = 0;
  let integral = 0;
  let previousError = 0;
  let derivative = 0;
  let measured = 0;
  let gust = 0;

  // THE LEAD-IN PULSE IS LOAD-BEARING, added 13 August 2026. `buildHoldEvidence`
  // drops a steady segment that begins at the FIRST sample of the records it was
  // handed (CLIPPED_BY_WINDOW), because there the command's history is unknown
  // and the settle skip is being applied to a fictitious start. Without a
  // command change near the beginning, this generator's first hold ran from
  // sample zero, and the fixture would have been asserting behaviour on a hold
  // the engine is right to refuse. No real flight begins with the aircraft
  // already trimmed and steady at the first logged sample.
  const leadInAtS = 1;
  for (let step = 0; step < samples; step += 1) {
    const t = step * plant.dt;
    let command = 0;
    if (stops) {
      for (const stop of stops) {
        const ramp = 0.1;
        if (t >= stop.atS && t < stop.atS + ramp) {
          command = stop.amplitudeDps * (t - stop.atS) / ramp;
        } else if (t >= stop.atS + ramp && t < stop.atS + ramp + stop.holdS) {
          command = stop.amplitudeDps;
        }
      }
    } else if ((t >= leadInAtS && t < leadInAtS + splitPulseS)
        || (t >= splitAtS && t < splitAtS + splitPulseS)) {
      command = splitAmplitudeDps;
    }
    const error = command - measured;
    integral += error * plant.dt;
    // The clamp is applied to the TERM, which is where a flight controller
    // applies it, and then carried back onto the accumulator so it cannot creep.
    if (Number.isFinite(integratorLimit) && gains.ki !== 0) {
      const cap = integratorLimit / Math.abs(gains.ki);
      integral = Math.max(-cap, Math.min(cap, integral));
    }
    const rawDerivative = (error - previousError) / plant.dt;
    previousError = error;
    derivative += (rawDerivative - derivative) * (plant.dt / plant.derivativeTau);

    const pTerm = gains.kp * error;
    const iTerm = gains.ki * integral;
    const dTerm = gains.kd * derivative;
    const output = Math.max(-actuatorLimit, Math.min(actuatorLimit, pTerm + iTerm + dTerm));

    delayLine.push(output);
    const delayed = delayLine.shift();
    actuator += (delayed - actuator) * (plant.dt / plant.actuatorTau);
    gust += ((random() - 0.5) * 2 * gustDps2 - gust) * (plant.dt / gustTauS);
    const external = externalTorqueDps2 === 0
      ? 0 : externalTorqueDps2 * Math.sin(2 * Math.PI * externalTorqueHz * t);
    rate += (plant.controlAuthority * actuator - plant.damping * rate
      + disturbanceDps2 + external + gust) * plant.dt;

    const noise = (random() - 0.5) * 2 * noiseDps;
    measured += (rate + noise * 0.25 - measured) * (plant.dt / plant.gyroTau);

    const setpoint = [0, 0, 0];
    const gyro = [0, 0, 0];
    const raw = [0, 0, 0];
    setpoint[index] = command;
    gyro[index] = measured;
    raw[index] = rate + noise;
    records.push({
      timeUs: Math.round(t * 1e6),
      setpoint, gyro, raw,
      terms: [pTerm, iTerm, dTerm],
      headspeed: headspeedRpm,
      collective: 0,
      vbat: 24
    });
  }
  return records;
}

/** The same closed loop, flown as a series of stops rather than one hold. */
function simulateStopLoop(options = {}) {
  return simulateHoldFlight({axis: 'roll', durationS: 28, noiseDps: 0.6, ...options});
}

/** Peak-to-peak rate on `index` after the loop has settled, as a pilot sees it. */
function holdWanderPkPk(records, index) {
  let low = Infinity;
  let high = -Infinity;
  for (const record of records) {
    if (record.timeUs > 15_000_000) {
      low = Math.min(low, record.gyro[index]);
      high = Math.max(high, record.gyro[index]);
    }
  }
  return high - low;
}

const HOLD_NOMINAL = Object.freeze({kp: 0.105, ki: 0.05, kd: 0.0014});
const HOLD_SOFT = Object.freeze({kp: 0.003, ki: 0.03, kd: 0.0005});

/** A mechanical result shaped as the analyser produces one, and clean. */
function cleanAirframe(overrides = {}) {
  return {
    status: 'clear',
    reasonCodes: [],
    tuningEvidenceGate: {status: 'permitted', reasonCodes: []},
    harmonicCorrelation: {state: 'evaluated'},
    rpmEvidence: {headspeed: {relativeSpread: 0.03, state: 'trustworthy'}},
    attentionThreshold: {bandRmsDps: 8, basis: 'experimental-synthetic-calibration'},
    range: {startTimeUs: 0, endTimeUs: 10_000_000_000},
    analyzedBandHz: [5, 450],
    axes: ['roll', 'pitch', 'yaw'].map(axis => ({
      axis, source: 'gyroRAW', available: true,
      medianNoisePsdDps2PerHz: 0.0002, broadbandRmsDps: 1.2, peaks: []
    })),
    ...overrides
  };
}

function findingsById(result) {
  const out = {};
  for (const finding of result.findings) {
    out[`${finding.id}${finding.axis ? ':' + finding.axis : ''}`] = finding;
  }
  return out;
}

/** Everything `buildRecommendations` needs for one synthetic single-axis flight. */
function recommendFor(records, axis, mechanical = cleanAirframe(), options = {}) {
  return buildRecommendations({
    records,
    mechanical,
    axes: {[axis]: {...analyseAxisEvidence(records, axis), records}},
    axisSummaries: {[axis]: {gyroHighFrequencyRmsDps: 0.5}},
    options
  });
}

function sessionOf(path) {
  return decodeLog(new Uint8Array(fs.readFileSync(path))).sessions[0];
}

/** The shape `analyzeMechanicalTimeSeries` takes, built from synthetic records. */
function seriesOf(records) {
  return {
    timeUs: Float64Array.from(records.map(record => record.timeUs)),
    gyro: {
      roll: Float64Array.from(records.map(record => record.raw[0])),
      pitch: Float64Array.from(records.map(record => record.raw[1])),
      yaw: Float64Array.from(records.map(record => record.raw[2]))
    },
    gyroSources: {roll: 'gyroRAW', pitch: 'gyroRAW', yaw: 'gyroRAW'},
    headspeedRpm: Float64Array.from(records.map(record => record.headspeed)),
    tailspeedRpm: Float64Array.from(records.map(() => Number.NaN)),
    resolved: {}, missing: [], usable: true
  };
}

/* =========================================================================== */
/* 1. THE WINDOW RECONSTRUCTION                                                */
/* =========================================================================== */

test('the reconstructed tracking window is the one records.mjs measured through',
  {skip: REAL_LOG ? false : 'set ROTORLENS_REAL_LOG'}, () => {
    // `measureTrackingShape` splits `trackingRmsDps` into an offset and a ripple,
    // and that split is only meaningful if it is computed over the SAME samples
    // the upstream number was. `records.mjs` does not publish the plateau
    // departure index, so this module rebuilds it. If the upstream anchoring ever
    // moves, this assertion fails rather than the module silently measuring a
    // different second of flight.
    const session = sessionOf(REAL_LOG);
    let checked = 0;
    for (const axis of ['roll', 'pitch', 'yaw']) {
      const {records, usable} = buildAnalysisRecords(session, {axis});
      if (!usable) {
        continue;
      }
      for (const event of detectStopEvents(records, {axis})) {
        const anchor = resolvePlateauDeparture(records, event, axis);
        assert.ok(anchor, `${axis} plateau departure must be recoverable`);
        const tracking = measureTrackingShape(records, event, axis);
        assert.ok(tracking, `${axis} tracking shape must be measurable`);
        assert.ok(
          Math.abs(tracking.trackingRmsDps - event.trackingRmsDps) < 1e-4,
          `${axis} @${event.stopTimeUs}: reconstructed window RMS `
          + `${tracking.trackingRmsDps} must equal the event's own `
          + `${event.trackingRmsDps}`
        );
        checked += 1;
      }
    }
    assert.ok(checked >= 2, `expected at least 2 events to check, saw ${checked}`);
  });

test('the same reconstruction holds on the stop fixture, on all three axes', () => {
  const session = sessionOf(STOP_FIXTURE);
  let checked = 0;
  for (const axis of ['roll', 'pitch', 'yaw']) {
    const {records} = buildAnalysisRecords(session, {axis});
    for (const event of detectStopEvents(records, {axis})) {
      const tracking = measureTrackingShape(records, event, axis);
      assert.ok(
        Math.abs(tracking.trackingRmsDps - event.trackingRmsDps) < 1e-4,
        `${axis}: ${tracking.trackingRmsDps} vs ${event.trackingRmsDps}`
      );
      checked += 1;
    }
  }
  assert.equal(checked, 12, 'the fixture has twelve stops');
});

/* =========================================================================== */
/* 2. THE SHAPE CLASSIFIER, SWEPT                                              */
/* =========================================================================== */

test('the classifier is monotone in damping: as the envelope flattens, it becomes ringing',
  () => {
    // The claim is not "this hand-picked case is ringing". It is that damping is
    // what decides, monotonically, across the whole plausible space. A hand-
    // picked case cannot show that and a hand-picked case is how a classifier
    // ends up keying on something else that happened to correlate.
    const random = rng(20260812);
    let ringingWhenUndamped = 0;
    let settledWhenDamped = 0;
    let undampedDraws = 0;
    let dampedDraws = 0;

    // What matters is how much the envelope falls ACROSS THE WINDOW, which is
    // zeta * omega * T and not zeta alone: a damping ratio of 0.02 is nearly
    // flat at 16 Hz and mostly gone by 50 Hz. So each draw picks a target
    // envelope fall and solves for the damping ratio that produces it, which is
    // what makes this a monotonicity claim rather than a coincidence.
    const windowS = (STOP_DETECTION_DEFAULTS.fastWindowUs[1]
      - STOP_DETECTION_DEFAULTS.fastWindowUs[0]) / 1e6;

    for (let draw = 0; draw < 1200; draw += 1) {
      const undamped = draw % 2 === 0;
      const frequencyHz = 16 + random() * 34;
      const targetDecay = undamped
        ? 0.95 + random() * 0.049
        : 0.05 + random() * 0.25;
      const zeta = -Math.log(targetDecay)
        / (2 * Math.PI * frequencyHz * (windowS / 2));
      const records = buildStopFlight({
        stopCount: 2,
        zeta,
        frequencyHz,
        ringAmplitudeDps: 8 + random() * 9,
        // Held small so a residual cannot compete with the envelope for the
        // verdict: this test is about damping and nothing else.
        residualDps: random() * 2,
        noiseDps: 0.2 + random() * 0.6,
        seed: 1000 + draw
      });
      const events = detectStopEvents(records, {axis: 'yaw'});
      if (events.length === 0) {
        continue;
      }
      const verdict = classifyStopShape(measureStopShape(records, events[0], 'yaw'));
      if (undamped) {
        undampedDraws += 1;
        if (verdict.classification === 'ringing') {
          ringingWhenUndamped += 1;
        }
      } else {
        dampedDraws += 1;
        if (verdict.classification !== 'ringing') {
          settledWhenDamped += 1;
        }
      }
    }

    assert.ok(undampedDraws > 400 && dampedDraws > 400,
      `expected both arms populated, saw ${undampedDraws}/${dampedDraws}`);
    assert.ok(ringingWhenUndamped / undampedDraws > 0.97,
      'an essentially undamped oscillation must read as ringing: only '
      + `${ringingWhenUndamped}/${undampedDraws} did`);
    assert.ok(settledWhenDamped / dampedDraws > 0.97,
      'a well-damped transient must not read as ringing: '
      + `${dampedDraws - settledWhenDamped}/${dampedDraws} did`);
  });

test('a large symmetric oscillation is NOT read as a failure to arrest', () => {
  // The trap the reference log walked into one level up. A ringing axis peaks
  // above the stop threshold on the commanded side too, so a criterion that
  // reads the peak alone calls every ringing axis a failure to stop — and the
  // remedies are opposite. What separates them is the BIAS between the two
  // sides.
  const random = rng(777);
  let misread = 0;
  for (let draw = 0; draw < 900; draw += 1) {
    const records = buildStopFlight({
      stopCount: 2,
      zeta: 0.002 + random() * 0.01,
      frequencyHz: 14 + random() * 36,
      // Deliberately far above the 20 deg/s stop threshold, both ways.
      ringAmplitudeDps: 30 + random() * 90,
      residualDps: random() * 2,
      seed: 30_000 + draw
    });
    const events = detectStopEvents(records, {axis: 'yaw'});
    if (events.length === 0) {
      continue;
    }
    const shape = measureStopShape(records, events[0], 'yaw');
    assert.ok(shape.sameWayPeakDps > SHAPE_DEFAULTS.residualStoppedDps,
      'the fixture must actually exceed the stop threshold, or this proves nothing');
    if (classifyStopShape(shape).classification === 'not-stopped') {
      misread += 1;
    }
  }
  assert.equal(misread, 0,
    `${misread} symmetric oscillations were read as a failure to arrest`);
});

test('a residual in the commanded direction IS read as a failure to arrest, and the '
  + 'threshold is where it says it is', () => {
    const random = rng(31_415);
    let below = 0;
    let belowMisread = 0;
    let above = 0;
    let aboveMissed = 0;
    for (let draw = 0; draw < 1200; draw += 1) {
      // Straddle the threshold from both sides, with everything else varying.
      const residualDps = 2 + random() * 60;
      const records = buildStopFlight({
        stopCount: 2,
        residualDps,
        residualTauS: 0.08 + random() * 0.12,
        zeta: 0.4 + random() * 0.5,
        frequencyHz: 5 + random() * 20,
        ringAmplitudeDps: random() * 5,
        noiseDps: 0.2 + random() * 0.5,
        seed: 50_000 + draw
      });
      const events = detectStopEvents(records, {axis: 'yaw'});
      if (events.length === 0) {
        continue;
      }
      const shape = measureStopShape(records, events[0], 'yaw');
      const stopped = classifyStopShape(shape).classification !== 'not-stopped';
      const bias = shape.sameWayPeakDps - shape.overshootDps;
      if (bias < SHAPE_DEFAULTS.residualStoppedDps * 0.7) {
        below += 1;
        if (!stopped) {
          belowMisread += 1;
        }
      } else if (bias > SHAPE_DEFAULTS.residualStoppedDps * 1.4) {
        above += 1;
        if (stopped) {
          aboveMissed += 1;
        }
      }
    }
    assert.ok(below > 100 && above > 100, `both sides must be populated: ${below}/${above}`);
    assert.equal(belowMisread, 0, 'a small residual must not read as a failure to arrest');
    assert.equal(aboveMissed, 0, 'a large residual must read as a failure to arrest');
  });

test('the classification does not depend on which way the stick was pushed', () => {
  // Direction symmetry is not decoration: every finding in the engine compares
  // the two directions, and a classifier that is asymmetric would manufacture a
  // directional asymmetry out of nothing.
  const random = rng(2718);
  for (let draw = 0; draw < 400; draw += 1) {
    const shared = {
      stopCount: 4,
      zeta: 0.002 + random() * 0.9,
      frequencyHz: 4 + random() * 40,
      ringAmplitudeDps: random() * 40,
      // Deliberately AWAY from the residual threshold: sampled either well
      // below it or well above it. A draw sitting exactly on a boundary would
      // be flipped by any difference at all, which would make this test about
      // the random seed rather than about symmetry.
      residualDps: draw % 2 === 0 ? random() * 6 : 45 + random() * 40,
      residualTauS: 0.05 + random() * 0.15,
      // No noise: two directions given identical physics must be classified
      // identically, and shared noise realisations are not identical physics.
      noiseDps: 0,
      seed: 70_000 + draw
    };
    const records = buildStopFlight(shared);
    const events = detectStopEvents(records, {axis: 'yaw'});
    const byDirection = {positive: [], negative: []};
    for (const event of events) {
      byDirection[event.commandSign].push(
        classifyStopShape(measureStopShape(records, event, 'yaw')).classification
      );
    }
    if (byDirection.positive.length === 0 || byDirection.negative.length === 0) {
      continue;
    }
    assert.deepEqual(
      new Set(byDirection.positive), new Set(byDirection.negative),
      `draw ${draw}: the two directions were classified differently from identical physics`
    );
  }
});

test('oscillationSource separates an axis that chatters while holding from one that '
  + 'only rings after the release', () => {
    const random = rng(1123);
    let holdAndRelease = 0;
    let releaseOnly = 0;
    for (let draw = 0; draw < 600; draw += 1) {
      const chattering = draw % 2 === 0;
      const ringAmplitudeDps = 10 + random() * 8;
      const records = buildStopFlight({
        stopCount: 2,
        zeta: 0.002 + random() * 0.01,
        frequencyHz: 14 + random() * 30,
        ringAmplitudeDps,
        residualDps: random() * 2,
        plateauRippleDps: chattering
          ? ringAmplitudeDps * (0.6 + random() * 0.6)
          : ringAmplitudeDps * (random() * 0.05),
        noiseDps: 0.2 + random() * 0.3,
        seed: 90_000 + draw
      });
      const events = detectStopEvents(records, {axis: 'yaw'});
      if (events.length === 0) {
        continue;
      }
      const source = oscillationSource(
        measureStopShape(records, events[0], 'yaw'),
        measureTrackingShape(records, events[0], 'yaw')
      );
      if (chattering) {
        assert.equal(source, 'hold-and-release',
          `draw ${draw}: an axis chattering through the hold must be seen to`);
        holdAndRelease += 1;
      } else {
        assert.equal(source, 'release-only',
          `draw ${draw}: an axis quiet through the hold must be seen to be`);
        releaseOnly += 1;
      }
    }
    assert.ok(holdAndRelease > 200 && releaseOnly > 200,
      `both arms must be populated: ${holdAndRelease}/${releaseOnly}`);
  });

test('the hold oscillation is measured over the FLAT command only, not across the '
  + 'release ramp', () => {
    // MUTATION-DRIVEN. An earlier version of this test file could not reach this:
    // deleting the flat-command filter and measuring the whole tracking window
    // left the whole suite green, because the synthetic releases were gentle
    // enough that the ramp carried almost no error. It is not a small effect on
    // a real flight — `plateauFraction` is 0.9, so the tracking window ends a
    // little way INTO the release ramp, and on the reference log's two yaw stops
    // that ramp alone carries error ripple of 12.4 and 30.7 deg/s against holds
    // that are quiet. Averaging it in makes every axis look like it chatters,
    // which turns every D finding into a P finding.
    const laggy = buildStopFlight({
      axis: 'yaw', stopCount: 2, laggyRelease: true,
      // A 200 ms release, which is the scale a real one runs at: the reference
      // log's two yaw stops depart their plateaus 212.6 ms and 64.6 ms before
      // the command reaches centre. A quiet hold, by construction, so whatever
      // ripple the whole window shows came from the ramp.
      releaseS: 0.2, plateauRippleDps: 0, trackingOffsetDps: 4, noiseDps: 0.2,
      zeta: 0.002, frequencyHz: 30, ringAmplitudeDps: 12, residualDps: 2
    });
    const events = detectStopEvents(laggy, {axis: 'yaw'});
    assert.ok(events.length >= 2, `expected stops, saw ${events.length}`);

    for (const event of events) {
      const tracking = measureTrackingShape(laggy, event, 'yaw');
      assert.ok(tracking.flatSampleCount > 0 && tracking.flatSampleCount < tracking.sampleCount,
        'the window must genuinely straddle the ramp, or this test proves nothing: '
        + `${tracking.flatSampleCount} of ${tracking.sampleCount} samples were flat`);
      assert.ok(tracking.rippleRmsDps > 3,
        `the whole window must be polluted by the ramp, read ${tracking.rippleRmsDps}`);
      assert.ok(tracking.plateauRippleRmsDps < 0.6,
        'and the flat-command figure must not be: read '
        + `${tracking.plateauRippleRmsDps}`);
      assert.ok(tracking.rippleRmsDps > tracking.plateauRippleRmsDps * 8,
        `the two must differ by nearly an order of magnitude: ${tracking.rippleRmsDps} `
        + `against ${tracking.plateauRippleRmsDps}`);
    }

    // And the consequence, which is the thing that actually matters: a
    // quiet-holding axis that rings after the release must read as a D fault,
    // not a P one. Measuring the ramp in flips it, because the ramp's error is
    // a quarter of the ringing it is being compared against.
    const shape = measureStopShape(laggy, events[0], 'yaw');
    const tracking = measureTrackingShape(laggy, events[0], 'yaw');
    assert.equal(classifyStopShape(shape).classification, 'ringing');
    assert.equal(oscillationSource(shape, tracking), 'release-only');
    assert.ok(
      tracking.rippleRmsDps / shape.rmsDps > SHAPE_DEFAULTS.plateauShareOfRinging,
      'the ramp-polluted figure must be over the threshold, or the flat-command '
      + `filter is doing nothing here: ${tracking.rippleRmsDps} / ${shape.rmsDps}`
    );
  });

test('separableFromNoiseFloor removes the floor in quadrature and returns null when '
  + 'nothing is left', () => {
    const random = rng(6161);
    for (let draw = 0; draw < 5000; draw += 1) {
      const metric = random() * 40;
      const floor = random() * 40;
      const result = separableFromNoiseFloor(metric, floor);
      if (metric <= floor) {
        assert.equal(result, null,
          `a metric of ${metric} under a floor of ${floor} is entirely accounted for`);
      } else {
        assert.ok(Math.abs(result - Math.sqrt(metric ** 2 - floor ** 2)) < 1e-9);
        assert.ok(result < metric, 'removing a floor cannot make a measurement larger');
      }
    }
    assert.equal(separableFromNoiseFloor(5, null), 5, 'no floor removes nothing');
    assert.equal(separableFromNoiseFloor(null, 1), null);
  });

/* =========================================================================== */
/* 3. INJECTED FAULTS: THE ENGINE MUST NAME THE RIGHT ONE                      */
/* =========================================================================== */

const STOP_FAULTS = Object.freeze({
  clean: {
    // A well-behaved axis: it arrests, it does not ring, it tracks.
    residualDps: 3, zeta: 0.7, frequencyHz: 14, ringAmplitudeDps: 5,
    trackingOffsetDps: 1.5, plateauRippleDps: 0.3
  },
  tooMuchD: {
    // A sustained fast oscillation after the release, and a QUIET hold — D acts
    // on the change in error, and during a steady hold there is none.
    //
    // 45 Hz, CHANGED FROM 32 ON 13 AUGUST 2026, and the reason matters. These
    // fixtures fly at 1800 rpm, so 1/rev is 30 Hz and the spectrum analyser's
    // harmonic tolerance at this window length is 2.93 Hz — which means a 32 Hz
    // ring is NOT DISTINGUISHABLE from the main rotor's once-per-rev by the
    // analysis this engine has. The rotor-order coincidence was never part of
    // the injected fault; it was an accident of an arbitrary number, and it
    // collided with the tone rule added the same day. 36 Hz is 5.2 Hz clear of
    // 1/rev and nowhere near 2/rev. The cost of that rule is not hidden: the
    // test 'a D fault that rings on a rotor order is refused a verdict' below
    // flies this same fault at 30 Hz and requires the engine to refuse it.
    residualDps: 2, zeta: 0.002, frequencyHz: 36, ringAmplitudeDps: 14,
    trackingOffsetDps: 1.5, plateauRippleDps: 0.2
  },
  tooMuchP: {
    // The same sustained oscillation, and the axis was ALREADY chattering while
    // the command was held, at the SAME frequency — a marginal loop oscillates
    // at its own crossover whenever it is doing work, whether the stick is
    // moving or not.
    residualDps: 2, zeta: 0.002, frequencyHz: 26, ringAmplitudeDps: 14,
    trackingOffsetDps: 1.5, plateauRippleDps: 11, plateauRippleHz: 26
  },
  tooLittleP: {
    // It never arrests, and while it held it sat well behind the command.
    residualDps: 75, residualTauS: 0.14, zeta: 0.85, frequencyHz: 7,
    ringAmplitudeDps: 3, trackingOffsetDps: 24, plateauRippleDps: 0.5
  },
  underdamped: {
    // One big excursion PAST CENTRE and back, decaying. The negative amplitude
    // is the phase that makes the first excursion the overshoot, which is what
    // an overshoot is — it goes past the target before it comes back, rather
    // than carrying on the way it was going. Too little D, too much P and too
    // much feedforward all do this, and the hold was quiet, so P is the least
    // likely of the three and the other two are not separable from one flight.
    residualDps: 2, zeta: 0.28, frequencyHz: 5, ringAmplitudeDps: -48,
    trackingOffsetDps: 1.5, plateauRippleDps: 0.3
  }
});

test('INJECTED FAULT — too much D is withheld when the mandatory stability gate fails', () => {
  const records = buildStopFlight({axis: 'yaw', ...STOP_FAULTS.tooMuchD});
  const result = recommendFor(records, 'yaw');
  const found = findingsById(result);

  assert.equal(found['D_TOO_HIGH:yaw'], undefined,
    'a stability-blocked D conclusion must not remain an instruction');
  assert.ok(result.withheld.some(entry => entry.findingId === 'D_TOO_HIGH'));
  assert.ok(result.gates.axes.yaw.gates.gainInterlocks.ringing.blockedBy.includes('stability'));
});

test('INJECTED FAULT — too much P is withheld when the mandatory stability gate fails', () => {
    const records = buildStopFlight({axis: 'yaw', ...STOP_FAULTS.tooMuchP});
    const result = recommendFor(records, 'yaw');
    const found = findingsById(result);

    assert.equal(found['P_TOO_HIGH:yaw'], undefined);
    assert.ok(result.withheld.some(entry => entry.findingId === 'P_TOO_HIGH'));
    assert.ok(result.gates.axes.yaw.gates.gainInterlocks.tracking.blockedBy.includes('stability'));
    assert.ok(!found['D_TOO_HIGH:yaw'],
      'a chattering hold must not be read as a D fault — that is the whole point');

    // And the P finding must come before any D finding could, because D set
    // against a wrong P has to be redone.
    assert.ok(RUNGS.indexOf('gain-P') < RUNGS.indexOf('gain-D'));
  });

test('INJECTED FAULT — too little P is withheld when the mandatory stability gate fails', () => {
    const records = buildStopFlight({axis: 'yaw', ...STOP_FAULTS.tooLittleP});
    const result = recommendFor(records, 'yaw');
    const found = findingsById(result);

    assert.equal(found['P_TOO_LOW:yaw'], undefined);
    assert.ok(result.withheld.some(entry => entry.findingId === 'P_TOO_LOW'));
    assert.ok(result.gates.axes.yaw.gates.gainInterlocks.tracking.blockedBy.includes('stability'));
  });

test('INJECTED FAULT — underdamped: the engine refuses to pick a term and prescribes '
  + 'the flight that would separate them', () => {
    const records = buildStopFlight({axis: 'yaw', ...STOP_FAULTS.underdamped});
    const result = recommendFor(records, 'yaw');
    const found = findingsById(result);

    const finding = found['OVERSHOOT_CANDIDATES_UNSEPARATED:yaw'];
    assert.ok(finding, 'expected the unseparated overshoot finding, got '
      + result.findings.map(entry => entry.id).join(', '));
    assert.equal(finding.kind, 'next-flight');
    assert.equal(finding.direction, null, 'a next-flight finding may not name a direction');
    assert.equal(finding.candidates.length, 3, 'all three candidates must be named');
    assert.match(finding.confirm, /stick/, 'and the manoeuvre that separates them');

    // Nothing anywhere in this result may be an adjustment: this is the honest
    // "I can see it, I cannot name it" case and it must stay that way.
    assert.deepEqual(
      result.findings.filter(entry => entry.kind === 'adjustment').map(entry => entry.id),
      [], 'an unseparated overshoot must not produce a gain change'
    );
  });

test('INJECTED FAULT — none: a clean axis gets a confident negative, not silence', () => {
  const records = buildStopFlight({axis: 'yaw', ...STOP_FAULTS.clean});
  const result = recommendFor(records, 'yaw');
  const found = findingsById(result);

  assert.ok(found['STOPS_SETTLE_CLEANLY:yaw'], 'expected the clean verdict, got '
    + result.findings.map(entry => entry.id).join(', '));
  assert.equal(found['STOPS_SETTLE_CLEANLY:yaw'].kind, 'observation');
  assert.equal(found['STOPS_SETTLE_CLEANLY:yaw'].direction, null);
  assert.deepEqual(
    result.findings.filter(entry => entry.kind === 'adjustment').map(entry => entry.id), []
  );
});

test('the four stop faults are diagnosed as four DIFFERENT things', () => {
  // Individually each test above could pass while the engine returned the same
  // answer for everything. This is the test that cannot.
  const verdicts = {};
  for (const [name, fault] of Object.entries(STOP_FAULTS)) {
    const records = buildStopFlight({axis: 'yaw', ...fault});
    const result = recommendFor(records, 'yaw');
    const headline = result.findings.find(entry =>
      entry.rung === 'gain-P' || entry.rung === 'gain-D');
    const withheld = result.withheld.find(entry => entry.findingId);
    verdicts[name] = headline?.id ?? withheld?.findingId ?? null;
  }
  assert.deepEqual(verdicts, {
    clean: 'STOPS_SETTLE_CLEANLY',
    tooMuchD: 'D_TOO_HIGH',
    tooMuchP: 'P_TOO_HIGH',
    tooLittleP: 'P_TOO_LOW',
    underdamped: 'OVERSHOOT_CANDIDATES_UNSEPARATED'
  });
  assert.equal(new Set(Object.values(verdicts)).size, 5,
    'five distinct faults must produce five distinct verdicts');
});

/* =========================================================================== */
/* 4. INJECTED FAULTS IN THE HOLD PATH (CLOSED-LOOP SIMULATION)                */
/* =========================================================================== */

test('INJECTED FAULT — no integral term against a standing torque: the engine says '
  + 'raise I', () => {
    const records = simulateHoldFlight({
      gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400
    });
    const hold = assessHoldIndication(records, 'yaw');
    assert.equal(hold.evidence.status, 'captured', 'the fixture must yield two holds');
    assert.equal(hold.indication, 'increase');
    assert.equal(hold.bind.suspected, false,
      'with no I term there is nothing wound up, so this is not a bind');

    const result = recommendFor(records, 'yaw');
    const found = findingsById(result);
    assert.ok(found['I_TOO_LOW:yaw'], 'expected I_TOO_LOW, got '
      + result.findings.map(entry => entry.id).join(', '));
    assert.equal(found['I_TOO_LOW:yaw'].direction, 'increase');
    assert.match(found['I_TOO_LOW:yaw'].reasoning, /bind/,
      'the finding must say why this is not a bind, because that is the dangerous '
      + 'confusion');
  });

test('INJECTED FAULT — a control that cannot move far enough: the engine names a bind '
  + 'and does NOT say raise I', () => {
    // The most dangerous single output this engine could produce is "add I" to an
    // aircraft whose linkage is binding. `interpretHoldEvidence` reads only the
    // error and gets exactly that answer; the bind discriminator is what stops it.
    const records = simulateHoldFlight({
      gains: HOLD_NOMINAL, disturbanceDps2: 200, actuatorLimit: 0.2
    });
    const hold = assessHoldIndication(records, 'yaw');

    assert.equal(hold.shippedIndication, 'increase',
      'upstream must genuinely have said increase, or this proves nothing');
    assert.equal(hold.bind.suspected, true);
    assert.equal(hold.indication, 'hold', 'the bind must override the gain reading');

    const result = recommendFor(records, 'yaw');
    const found = findingsById(result);
    assert.ok(found['SUSPECTED_MECHANICAL_BIND:yaw'], 'expected the bind finding, got '
      + result.findings.map(entry => entry.id).join(', '));
    assert.equal(found['SUSPECTED_MECHANICAL_BIND:yaw'].kind, 'blocker');
    assert.equal(found['SUSPECTED_MECHANICAL_BIND:yaw'].rung, 'axis-mechanical');
    assert.ok(!found['I_TOO_LOW:yaw'],
      'a binding linkage must never be reported as too little I');
    assert.match(found['SUSPECTED_MECHANICAL_BIND:yaw'].confirm, /by hand/);
  });

test('INJECTED FAULT — an over-large integral term on a soft loop: the engine says '
  + 'lower I, and it survives the filter sweep', () => {
    const records = simulateHoldFlight({
      gains: HOLD_SOFT, gustDps2: 2200, durationS: 28
    });
    const hold = assessHoldIndication(records, 'yaw');
    assert.equal(hold.evidence.status, 'captured');
    assert.equal(hold.shippedIndication, 'decrease');
    assert.equal(hold.sweepStable, true,
      'a genuine hunt must survive every smoothing length and ripple threshold in '
      + `HOLD_SWEEP; saw ${hold.sweepIndicationsSeen.join(', ')}`);
    assert.equal(hold.indication, 'decrease');
    // Every filter length either voted or abstained; none was skipped silently.
    // A filter abstains when it is too blunt to see this oscillation at all,
    // which is a limit of the measurement rather than a disagreement about the
    // aircraft.
    assert.equal(
      hold.sweepRunCount / HOLD_SWEEP.huntingRippleDps.length
      + hold.sweepAbstainedFilterCount,
      HOLD_SWEEP.huntingSmoothingUs.length,
      `${hold.sweepRunCount} votes and ${hold.sweepAbstainedFilterCount} abstentions`
    );
    assert.ok(hold.sweepRunCount > 0, 'and at least one filter could see it');

    const result = recommendFor(records, 'yaw');
    const found = findingsById(result);
    assert.ok(found['I_TOO_HIGH:yaw'], 'expected I_TOO_HIGH, got '
      + result.findings.map(entry => entry.id).join(', '));
    assert.equal(found['I_TOO_HIGH:yaw'].direction, 'decrease');
  });

test('a nominal loop gets a confident negative on the I term', () => {
  const records = simulateHoldFlight({gains: HOLD_NOMINAL, disturbanceDps2: 200});
  const result = recommendFor(records, 'yaw');
  const found = findingsById(result);
  assert.ok(found['I_TERM_WITHIN_TOLERANCE:yaw'], 'expected the clean I verdict, got '
    + result.findings.map(entry => entry.id).join(', '));
  assert.equal(found['I_TERM_WITHIN_TOLERANCE:yaw'].direction, null);
});

test('the three hold faults are diagnosed as three different things', () => {
  const cases = {
    tooLittleI: {gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400},
    bind: {gains: HOLD_NOMINAL, disturbanceDps2: 200, actuatorLimit: 0.2},
    tooMuchI: {gains: HOLD_SOFT, gustDps2: 2200},
    nominal: {gains: HOLD_NOMINAL, disturbanceDps2: 200}
  };
  const verdicts = {};
  for (const [name, setup] of Object.entries(cases)) {
    const records = simulateHoldFlight(setup);
    const result = recommendFor(records, 'yaw');
    verdicts[name] = result.findings.find(entry =>
      entry.rung === 'gain-I' || entry.id === 'SUSPECTED_MECHANICAL_BIND')?.id ?? null;
  }
  assert.deepEqual(verdicts, {
    tooLittleI: 'I_TOO_LOW',
    bind: 'SUSPECTED_MECHANICAL_BIND',
    tooMuchI: 'I_TOO_HIGH',
    nominal: 'I_TERM_WITHIN_TOLERANCE'
  });
});

test('I-term advice is blocked when the mechanical range excludes its captured holds', () => {
  const records = simulateHoldFlight({
    gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400
  });
  const result = recommendFor(records, 'yaw', cleanAirframe({
    range: {startTimeUs: 0, endTimeUs: 2_000_000}
  }));

  assert.equal(result.gates.holds.yaw.evidence.status, 'captured',
    'the fixture must really contain the hold whose range is being checked');
  assert.ok(result.gates.airframe.codes.includes('MECHANICAL_RANGE_EXCLUDES_HOLDS'));
  assert.ok(result.findings.some(finding => finding.id === 'AIRFRAME_RANGE_EXCLUDES_HOLDS'));
  assert.equal(result.findings.some(finding => finding.id === 'I_TOO_LOW'), false,
    'an I instruction cannot survive a vibration check over other seconds');
});

/* =========================================================================== */
/* 5. MECHANICAL FAULTS OUTRANK GAINS                                          */
/* =========================================================================== */

test('INJECTED FAULT — a mechanical resonance: the airframe blocks, and the gain '
  + 'finding that WOULD have been made is withheld', async () => {
    // Built so the ONLY difference between the two runs is the vibration. The
    // control side is identical, so the same flight earns a D recommendation
    // with a quiet airframe and none at all with a shaking one.
    const control = buildStopFlight({axis: 'yaw', ...STOP_FAULTS.tooMuchD});
    // 1800 rpm is 30 Hz, so 71 Hz is not a rotor order and cannot be explained
    // away as the rotor — it is a frame or a bearing.
    const shaking = buildStopFlight({
      axis: 'yaw', ...STOP_FAULTS.tooMuchD,
      vibration: {frequencyHz: 71, amplitudeDps: 26}
    });
    const range = {
      startTimeUs: control[0].timeUs,
      endTimeUs: control[control.length - 1].timeUs
    };

    const clean = await analyzeMechanicalTimeSeries(seriesOf(control), {timeRangeUs: range});
    const shaken = await analyzeMechanicalTimeSeries(seriesOf(shaking), {timeRangeUs: range});

    const cleanGate = assessAirframe(clean);
    const shakenGate = assessAirframe(shaken);
    assert.equal(cleanGate.status, 'permitted',
      `the quiet airframe must pass, blocked by ${cleanGate.codes.join(', ')}`);
    assert.equal(shakenGate.status, 'blocked',
      'a 71 Hz resonance at 26 deg/s must block the airframe gate');

    // The control-loop oscillation on the clean run is 14 deg/s and lives on
    // yaw. It must NOT be read as an airframe fault — a tone is not a floor —
    // or the gate would block the very finding it is evidence for.
    const yaw = cleanGate.axes.find(entry => entry.axis === 'yaw');
    assert.ok(yaw.totalBandRmsDps > 15,
      `the loop oscillation must show in the total band power, read ${yaw.totalBandRmsDps}`);
    assert.ok(yaw.broadbandNoiseRmsDps < 1,
      `and must NOT show in the noise floor, read ${yaw.broadbandNoiseRmsDps}`);

    const withClean = recommendFor(control, 'yaw', clean);
    const withShaking = recommendFor(control, 'yaw', shaken);

    assert.ok(withClean.withheld.some(entry => entry.findingId === 'D_TOO_HIGH'),
      'the control-side D shape must still be identified, then withheld by stability');
    assert.deepEqual(
      withShaking.findings.filter(entry => entry.kind === 'adjustment').map(entry => entry.id),
      [], 'no gain change may survive a blocked airframe'
    );
    assert.equal(withShaking.findings[0].rung, 'airframe',
      'and the airframe must be what the pilot is told about first');
    assert.equal(withShaking.findings[0].actNow, true);
    assert.ok(withShaking.withheld.length > 0,
      'what was withheld, and why, must be visible rather than silently dropped');
    assert.match(withShaking.withheld[0].sentence, /ringing|not-stopped|overshoot|settled/);
  });

test('INJECTED FAULT — a raised noise floor with no tone in it: the upstream gate says '
  + 'go ahead and this one does not', async () => {
    // THE HOLE THIS GATE EXISTS FOR. A worn bearing, a dry damper or a
    // delaminating blade raise the floor rather than adding a line, and the
    // narrowband attention path cannot see a floor. The same flight with quiet
    // noise earns a D recommendation.
    const shaking = buildStopFlight({
      axis: 'yaw', ...STOP_FAULTS.tooMuchD, noiseDps: 26
    });
    const range = {
      startTimeUs: shaking[0].timeUs,
      endTimeUs: shaking[shaking.length - 1].timeUs
    };
    const result = await analyzeMechanicalTimeSeries(seriesOf(shaking), {timeRangeUs: range});

    assert.equal(result.status, 'clear',
      'the upstream analysis must genuinely call this clear, or the test proves nothing');
    assert.equal(result.tuningEvidenceGate.status, 'permitted');
    for (const axis of result.axes) {
      assert.equal(axis.peaks.filter(peak => peak.attentionEligible).length, 0,
        `${axis.axis} must carry no attention-eligible tone: this is a floor, not a line`);
    }

    const gate = assessAirframe(result);
    assert.equal(gate.status, 'blocked');
    assert.ok(gate.codes.includes('BROADBAND_ABOVE_ATTENTION_THRESHOLD'));
    for (const axis of gate.axes) {
      assert.ok(axis.broadbandNoiseRmsDps > gate.attentionThresholdDps,
        `${axis.axis} floor was ${axis.broadbandNoiseRmsDps}`);
    }

    const advice = recommendFor(shaking, 'yaw', result);
    assert.deepEqual(
      advice.findings.filter(entry => entry.kind === 'adjustment').map(entry => entry.id),
      [], 'nothing about the gains may be said over a floor like that'
    );
  });

test('the airframe gate sees BROADBAND vibration, which the upstream gate cannot', () => {
  // The upstream `tuningEvidenceGate` is `permitted` on a "clear" status, and
  // clear means "no persistent NARROWBAND peak reached the attention threshold".
  // A raised noise floor with no tone in it passes it. This is that hole.
  const upstreamPermitted = {
    status: 'clear',
    reasonCodes: [],
    tuningEvidenceGate: {status: 'permitted', reasonCodes: []},
    harmonicCorrelation: {state: 'evaluated'},
    rpmEvidence: {headspeed: {relativeSpread: 0.03, state: 'trustworthy'}},
    attentionThreshold: {bandRmsDps: 8, basis: 'experimental-synthetic-calibration'},
    range: {startTimeUs: 0, endTimeUs: 1e9},
    analyzedBandHz: [5, 450],
    axes: ['roll', 'pitch', 'yaw'].map(axis => ({
      axis, source: 'gyroRAW', available: true,
      // No tone anywhere: zero peaks. The median PSD gives a floor of
      // sqrt(24 * 445) = 103 deg/s across the band — an unflyable machine that
      // the upstream gate calls clear.
      medianNoisePsdDps2PerHz: 24, broadbandRmsDps: 109, peaks: []
    }))
  };
  const gate = assessAirframe(upstreamPermitted);
  assert.equal(gate.upstream.status, 'permitted',
    'the upstream gate must genuinely permit this, or the test proves nothing');
  assert.equal(gate.status, 'blocked');
  assert.ok(gate.codes.includes('BROADBAND_ABOVE_ATTENTION_THRESHOLD'));
  assert.deepEqual([...gate.elevatedAxes], ['roll', 'pitch', 'yaw']);

  // And it must still pass a genuinely quiet airframe, or it is not a gate, it
  // is a refusal.
  assert.equal(assessAirframe(cleanAirframe()).status, 'permitted');
});

test('an axis whose broadband floor was never measured cannot be called clear', () => {
  const gate = assessAirframe(cleanAirframe({
    axes: [
      {axis: 'roll', source: 'gyroRAW', available: true,
        medianNoisePsdDps2PerHz: 0.0002, peaks: []},
      {axis: 'pitch', source: 'gyroADC-filtered', available: false, peaks: []},
      {axis: 'yaw', source: 'gyroRAW', available: true,
        medianNoisePsdDps2PerHz: 0.0002, peaks: []}
    ]
  }));
  assert.equal(gate.status, 'blocked');
  assert.ok(gate.codes.includes('BROADBAND_NOT_MEASURED'));
  assert.deepEqual([...gate.unmeasuredAxes], ['pitch']);
});

/* =========================================================================== */
/* 6. THE OUTPUT CONTRACT — the re-scoped instruction guard                     */
/* =========================================================================== */

/**
 * Every result this engine can produce, across every fixture in this file.
 *
 * Enumerated by construction rather than by reading what happens to fire today,
 * which is how a guard and the thing it guards drift apart.
 */
function everyResult() {
  const results = [];
  for (const fault of Object.values(STOP_FAULTS)) {
    results.push(recommendFor(buildStopFlight({axis: 'yaw', ...fault}), 'yaw'));
  }
  for (const setup of [
    {gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400},
    {gains: HOLD_NOMINAL, disturbanceDps2: 200, actuatorLimit: 0.2},
    {gains: HOLD_SOFT, gustDps2: 2200},
    {gains: HOLD_NOMINAL, disturbanceDps2: 200}
  ]) {
    results.push(recommendFor(simulateHoldFlight(setup), 'yaw'));
  }
  // Blocked airframes, an unmeasurable one, and a flight with no stops at all.
  results.push(recommendFor(
    buildStopFlight({axis: 'yaw', ...STOP_FAULTS.tooMuchD}), 'yaw',
    cleanAirframe({
      axes: cleanAirframe().axes.map(axis => ({...axis, medianNoisePsdDps2PerHz: 4}))
    })
  ));
  results.push(recommendFor(
    buildStopFlight({axis: 'yaw', ...STOP_FAULTS.tooMuchD}), 'yaw',
    cleanAirframe({harmonicCorrelation: {state: 'unavailable'}})
  ));
  results.push(recommendFor(
    buildStopFlight({axis: 'yaw', amplitudeDps: 30, ...STOP_FAULTS.clean}), 'yaw'
  ));
  results.push(recommendFor(
    buildStopFlight({axis: 'yaw', stopCount: 1, ...STOP_FAULTS.tooMuchD}), 'yaw'
  ));
  results.push(recommendFor(buildStopFlight({axis: 'yaw', ...STOP_FAULTS.clean}), 'yaw', null));
  return results;
}

test('only an adjustment may name a direction, and every adjustment is earned', () => {
  // The successor to "nothing this module can say is a tuning instruction". The
  // product decision of 12 August 2026 made that rule wrong as stated — the app's
  // purpose is now to say what to adjust — so the rule becomes: direction is
  // allowed exactly where it has been earned, and nowhere else.
  const directional =
    /\b(increas|decreas|rais|lower|reduc|soften|stiffen)(e|es|ed|ing|s)?\b/i;

  let adjustments = 0;
  let others = 0;
  for (const result of everyResult()) {
    for (const finding of result.findings) {
      if (finding.kind === 'adjustment') {
        adjustments += 1;
        assert.ok(['increase', 'decrease'].includes(finding.direction),
          `${finding.id}: an adjustment must name a direction`);
        assert.ok(finding.adjust, `${finding.id}: an adjustment must name what to adjust`);
        assert.ok(finding.basis.length > 0,
          `${finding.id}: an adjustment must carry the measurements behind it`);
        assert.ok(finding.basis.some(entry => Number.isFinite(entry.value)),
          `${finding.id}: at least one entry in the basis must be a number the pilot `
          + 'can check against the trace');
        assert.ok(['low', 'medium', 'high'].includes(finding.confidence),
          `${finding.id}: an adjustment must carry a confidence, saw ${finding.confidence}`);
        assert.ok(finding.confirm && finding.confirm.length > 40,
          `${finding.id}: an adjustment must say what to fly to confirm it`);
        assert.ok(finding.reasoning.length > 80,
          `${finding.id}: an adjustment must say why`);
      } else {
        others += 1;
        assert.equal(finding.direction, null,
          `${finding.id} is a ${finding.kind} and may not carry a direction`);
        assert.ok(!directional.test(finding.headline),
          `${finding.id} is a ${finding.kind}, so its headline may not read as a gain `
          + `instruction: "${finding.headline}"`);
      }
    }
  }
  assert.ok(adjustments >= 2, `expected earned hold adjustments across the fixtures, saw ${adjustments}`);
  assert.ok(others >= 20, `expected many non-adjustments, saw ${others}`);
});

/**
 * THIS TEST IS NOT ALLOWED TO BE THE ONLY THING SAYING SO.
 *
 * A title that states a limitation as the expected result is the shape this
 * file opens by warning about: green proves only that no fixture reached the
 * code that would lift it. It is kept because the limitation is now the
 * PERMANENT contract of this module rather than a stage it is passing through —
 * `buildRecommendations` takes no history and no model, and there is no
 * parameter by which one could be handed in. The reachable magnitude in this
 * app is `buildMagnitude` in src/analysis/flight-history.mjs, and it is driven
 * over its own release conditions in test/flight-history.test.mjs, where
 * mutating either of the two statistical conditions turns a test red.
 */
test('no finding anywhere carries a magnitude, and the array is empty by contract', () => {
  // A magnitude never lives inside a finding, because a finding persists and a
  // number that cannot disappear cleanly is one that outlives its evidence.
  const forbidden = /\b(by|to)\s+\d+(\.\d+)?\s*(%|percent|points?|steps?)\b/i;
  for (const result of everyResult()) {
    assert.deepEqual([...result.magnitudes], []);
    assert.equal(result.magnitudeBasis, null);
    // The engine takes no model, so there is no refusal channel either. A key
    // that only appears on some runs is a key a caller reads on none of them.
    assert.ok(!Object.hasOwn(result, 'magnitudesRefused'),
      'buildRecommendations must not carry a magnitude refusal channel');
    for (const finding of result.findings) {
      for (const key of Object.keys(finding)) {
        assert.ok(!/magnitude|amount|delta|newValue|setTo/i.test(key),
          `${finding.id} carries a field named ${key}`);
      }
      assert.ok(!forbidden.test(finding.headline + ' ' + (finding.confirm ?? '')),
        `${finding.id} states an amount: "${finding.headline}"`);
    }
  }
});

test('every result is ordered by rung, and at most one finding says act now', () => {
  for (const result of everyResult()) {
    let previous = -1;
    for (const finding of result.findings) {
      assert.ok(RUNGS.includes(finding.rung), `unknown rung ${finding.rung}`);
      assert.ok(finding.rungOrder >= previous,
        `${finding.id} at rung ${finding.rung} came after a lower rung`);
      previous = finding.rungOrder;
    }
    const acting = result.findings.filter(finding => finding.actNow);
    assert.ok(acting.length <= 1,
      `one change at a time: ${acting.map(entry => entry.id).join(', ')}`);
    if (acting.length === 1) {
      assert.ok(['blocker', 'adjustment'].includes(acting[0].kind));
    }
  }
});

test('the ONE-CHANGE latch is reachable: two findings that are both eligible, and only '
  + 'one is told to act on', () => {
    // THE TEST ABOVE CANNOT FAIL, AND THAT IS WHY THIS ONE EXISTS.
    //
    // `at most one finding says act now` sweeps `everyResult()`, and no fixture
    // in this file produces two SIMULTANEOUSLY ELIGIBLE findings. On the stop
    // fixture there genuinely are two same-rung blockers (roll and yaw
    // DIRECTIONAL_ASYMMETRY_MECHANICAL at axis-mechanical), but an airframe
    // blocker at a higher rung caps `lowestBlockerRung` and masks them; on the
    // reference log there is only one blocker at all. So `actNowAssigned = true`
    // — the latch that stops a second finding taking it — could be deleted and
    // the whole suite stayed green. It was deleted, and it did. See the mutation
    // record beside this file.
    //
    // The product promise is ONE CHANGE AT A TIME. It gets a test that can see
    // it fail.
    const twoBlockers = orderFindings([
      {id: 'ROLL_BIND', rung: 'axis-mechanical', rungOrder: RUNGS.indexOf('axis-mechanical'),
        kind: 'blocker', axis: 'roll', sequence: 1},
      {id: 'YAW_BIND', rung: 'axis-mechanical', rungOrder: RUNGS.indexOf('axis-mechanical'),
        kind: 'blocker', axis: 'yaw', sequence: 2}
    ]);
    assert.deepEqual(twoBlockers.map(entry => entry.id), ['ROLL_BIND', 'YAW_BIND'],
      'both blockers must survive — this is about what is ACTED ON, not what is shown');
    assert.deepEqual(twoBlockers.filter(entry => entry.actNow).map(entry => entry.id),
      ['ROLL_BIND'],
      'two blockers on the same rung: exactly the first may be the one change to make');

    // Two adjustments on different axes with nothing blocking anywhere — the
    // case a pilot most plausibly meets, and the one where two act-now marks
    // would send him to change two gains on one flight.
    const twoAdjustments = orderFindings([
      {id: 'ROLL_P', rung: 'gain-P', rungOrder: RUNGS.indexOf('gain-P'), kind: 'adjustment',
        axis: 'roll', sequence: 1},
      {id: 'PITCH_P', rung: 'gain-P', rungOrder: RUNGS.indexOf('gain-P'), kind: 'adjustment',
        axis: 'pitch', sequence: 2},
      {id: 'YAW_D', rung: 'gain-D', rungOrder: RUNGS.indexOf('gain-D'), kind: 'adjustment',
        axis: 'yaw', sequence: 3}
    ]);
    assert.equal(twoAdjustments.length, 1,
      'an unmarked imperative is still an instruction, so only one may be returned');
    assert.deepEqual(twoAdjustments.filter(entry => entry.actNow).map(entry => entry.id),
      ['ROLL_P'], 'three earned adjustments, one instruction');

    // And an observation may never be the one to act on, however early it sorts.
    const observationFirst = orderFindings([
      {id: 'CLEAR', rung: 'airframe', rungOrder: RUNGS.indexOf('airframe'),
        kind: 'observation', axis: null, sequence: 1},
      {id: 'YAW_D', rung: 'gain-D', rungOrder: RUNGS.indexOf('gain-D'), kind: 'adjustment',
        axis: 'yaw', sequence: 2}
    ]);
    assert.deepEqual(observationFirst.filter(entry => entry.actNow).map(entry => entry.id),
      ['YAW_D']);
  });

test('an adjustment never survives a blocker above it, on any axis it shares', () => {
  const blocked = orderFindings([
    {id: 'B', rung: 'airframe', rungOrder: RUNGS.indexOf('airframe'), kind: 'blocker',
      axis: null, sequence: 1},
    {id: 'A', rung: 'gain-D', rungOrder: RUNGS.indexOf('gain-D'), kind: 'adjustment',
      axis: 'yaw', sequence: 2}
  ]);
  assert.deepEqual(blocked.map(entry => entry.id), ['B'],
    'the adjustment must be suppressed by the airframe blocker');

  // A blocker is the one action for this result. Even a different axis must wait
  // or the output again asks for two changes before a confirming flight.
  const perAxis = orderFindings([
    {id: 'BIND', rung: 'axis-mechanical', rungOrder: RUNGS.indexOf('axis-mechanical'),
      kind: 'blocker', axis: 'yaw', sequence: 1},
    {id: 'ROLL_D', rung: 'gain-D', rungOrder: RUNGS.indexOf('gain-D'), kind: 'adjustment',
      axis: 'roll', sequence: 2},
    {id: 'YAW_D', rung: 'gain-D', rungOrder: RUNGS.indexOf('gain-D'), kind: 'adjustment',
      axis: 'yaw', sequence: 3}
  ]);
  assert.deepEqual(perAxis.map(entry => entry.id), ['BIND']);
});

/* =========================================================================== */
/* 7. STABILITY UNDER PERTURBATION                                             */
/* =========================================================================== */

test('the shape sweep crosses both the detector grid and the judgement grid', () => {
  const combinations = shapeSweepCombinations();
  assert.equal(combinations.length,
    SHAPE_SWEEP.ringingDecayFloor.length * SHAPE_SWEEP.ringingFloorHz.length
    * SHAPE_SWEEP.offsetDominantShare.length * SHAPE_SWEEP.plateauShareOfRinging.length);
  // Every shipped default must sit INSIDE its swept range with values on both
  // sides, or the sweep is decoration: it would only ever confirm the default.
  for (const key of Object.keys(SHAPE_SWEEP)) {
    const values = SHAPE_SWEEP[key];
    assert.ok(values.includes(SHAPE_DEFAULTS[key]), `${key} default is not in its sweep`);
    assert.ok(Math.min(...values) < SHAPE_DEFAULTS[key], `${key} has nothing below it`);
    assert.ok(Math.max(...values) > SHAPE_DEFAULTS[key], `${key} has nothing above it`);
  }
});

test('a conclusion that moves across the sweep is not turned into a recommendation', () => {
  // Built to sit exactly on the boundary: an envelope decay near the middle of
  // the swept `ringingDecayFloor` range, so different but equally defensible
  // readings of the same flight disagree about whether it rings.
  const records = buildStopFlight({
    axis: 'yaw',
    zeta: 0.028, frequencyHz: 20, ringAmplitudeDps: 12,
    residualDps: 2, trackingOffsetDps: 1.5, plateauRippleDps: 0.3
  });
  const sweep = sweepStopShapeConclusion(records, 'yaw');
  const unstable = ['positive', 'negative'].some(direction =>
    sweep.directions[direction].classificationsSeen.length > 1);
  assert.ok(unstable,
    'the boundary fixture must actually be unstable, or this test proves nothing; saw '
    + JSON.stringify(sweep.directions.positive.classificationsSeen));

  const result = recommendFor(records, 'yaw');
  assert.deepEqual(
    result.findings.filter(entry => entry.kind === 'adjustment').map(entry => entry.id),
    [], 'a conclusion that flips across the sweep must not become a gain change'
  );
  const attemptedBypass = recommendFor(records, 'yaw', cleanAirframe(), {skipSweeps: true});
  assert.deepEqual(
    attemptedBypass.findings.filter(entry => entry.kind === 'adjustment'),
    [], 'skipSweeps is a legacy input, not a production safety bypass'
  );
});

/* --------------------------------------------------------------------------- */
/* SILENCE IS NOT DISSENT                                                      */
/*                                                                             */
/* WHY THE INJECTED-FAULT TEST ABOVE COULD NOT SEE THIS. It reaches D_TOO_HIGH  */
/* through the whole pipeline, sweep included — but `buildStopFlight` releases  */
/* in 20 ms by default, and 20 ms is shorter than the narrowest tracking window */
/* in the grid (50 ms). So no combination can ever put a window WHOLLY inside   */
/* that ramp, no combination is ever left with nothing to measure, and the      */
/* abstention path is unreachable from it. rf46-gain-fault.TXT releases over    */
/* 60 ms at 500 Hz, which is a realistic stop, and the path opens.              */
/*                                                                             */
/* The first of these therefore runs on a DECODED log, not on records built in  */
/* memory: that is where the defect lived and where the suite was blind to it.  */
/* --------------------------------------------------------------------------- */

test('a sweep combination that cannot MEASURE the hold abstains, and D_TOO_HIGH is '
  + 'reachable from a decoded log', () => {
    // rf46-gain-fault.TXT is written as a textbook too-much-D fault: symmetric
    // both ways, a sustained 25 Hz ring chosen off every rotor order, and a
    // quiet plateau. Before 13 August 2026 it came back RINGING_SOURCE_UNKNOWN,
    // because five of the 270 detector combinations put the tracking window
    // wholly inside the release ramp, measured no hold at all, and had their
    // null counted as a second opinion.
    const session = sessionOf(GAIN_FAULT_FIXTURE);
    for (const axis of ['roll', 'pitch', 'yaw']) {
      const {records} = buildAnalysisRecords(session, {axis});
      const sweep = sweepStopShapeConclusion(records, axis);

      for (const direction of DIRECTIONS) {
        const seen = sweep.directions[direction];

        // WITHOUT THIS THE TEST PROVES NOTHING. If every combination could
        // measure the hold, the abstention rule is never exercised and this
        // test would pass just as happily against the code that counted a null
        // as dissent.
        assert.ok(seen.oscillationSilentEvaluations > 0,
          `${axis} ${direction}: the fixture must contain combinations that cannot `
          + 'measure the hold, or this test does not reach the defect it names; saw '
          + `${seen.oscillationSilentEvaluations} of ${seen.oscillationEvaluations}`);
        assert.ok(seen.oscillationOpinionShare < 1,
          `${axis} ${direction}: share must be short of unanimous coverage, read `
          + `${seen.oscillationOpinionShare}`);

        // And the abstentions must be a minority, or it is the quorum rather
        // than the abstention rule that is being tested.
        assert.ok(seen.oscillationOpinionShare > GAIN_GATE_THRESHOLDS.requiredSweepOpinionShare,
          `${axis} ${direction}: opinion share ${seen.oscillationOpinionShare} must clear `
          + `the quorum ${GAIN_GATE_THRESHOLDS.requiredSweepOpinionShare}`);

        assert.deepEqual([...seen.oscillationSourcesSeen], ['release-only'],
          `${axis} ${direction}: every combination that could measure must agree, and `
          + 'no null may appear among them');
        assert.equal(seen.oscillationSource, 'release-only',
          `${axis} ${direction}: unanimity among the opinions is the conclusion`);
        assert.equal(seen.classification, 'ringing');
      }

      const result = recommendFor(records, axis);
      const ids = result.findings.map(entry => entry.id);
      assert.ok(ids.includes('D_TOO_HIGH'),
        `${axis}: a symmetric sustained ring above the D band, quiet through the hold, `
        + `must name the D term; got ${ids.join(', ')}`);
      assert.ok(!ids.includes('RINGING_SOURCE_UNKNOWN'),
        `${axis}: the source was measurable at ${sweep.directions.positive.oscillationOpinionShare} `
        + 'of the grid and must not be reported as unknown');

      const finding = findingsById(result)[`D_TOO_HIGH:${axis}`];
      assert.equal(finding.kind, 'adjustment');
      assert.equal(finding.direction, 'decrease');
      assert.equal(finding.adjust, `${axis} D`);
    }
  });

test('but a MINORITY of windows that could measure cannot carry the conclusion, however '
  + 'unanimous they are', () => {
    // A 50 ms hold behind a 150 ms ramp: there is barely a plateau to look at, so
    // most of the grid's windows land on moving command and measure nothing. The
    // few that can all say the same thing, and that is still not enough.
    const records = buildStopFlight({
      axis: 'yaw', stopCount: 2, holdS: 0.05, rampS: 0.15, releaseS: 0.02,
      zeta: 0.002, frequencyHz: 30, ringAmplitudeDps: 12, residualDps: 1,
      trackingOffsetDps: 2, plateauRippleDps: 0.05, noiseDps: 0.2
    });
    const sweep = sweepStopShapeConclusion(records, 'yaw');

    for (const direction of DIRECTIONS) {
      const seen = sweep.directions[direction];
      assert.deepEqual([...seen.oscillationSourcesSeen], ['release-only'],
        `${direction}: the opinions must be unanimous, or the quorum is not what is `
        + 'being tested here');
      // Stated as arithmetic rather than against the constant, so that moving the
      // constant makes the CONCLUSION assertion below fail rather than quietly
      // disqualifying the fixture.
      assert.ok(seen.oscillationOpinionShare < 0.5,
        `${direction}: the fixture must leave a MINORITY able to measure, read `
        + `${seen.oscillationOpinionShare}`);
      assert.equal(seen.oscillationSource, null,
        `${direction}: a minority of windows is not a conclusion`);
      assert.equal(seen.classification, 'ringing',
        `${direction}: the ring itself is still measurable, so it is only the SOURCE `
        + 'that is being withheld');
    }

    assert.deepEqual(
      recommendFor(records, 'yaw').findings
        .filter(entry => entry.kind === 'adjustment').map(entry => entry.id),
      [], 'no gain change may be named off a minority of the grid'
    );
  });

test('and a genuine disagreement about WHERE the oscillation lives still vetoes, with '
  + 'nothing silent to blame it on', () => {
    // Plateau ripple a quarter of the ringing, which is exactly where
    // `plateauShareOfRinging` is swept across: 0.15 and 0.2 read it as chattering
    // through the hold, 0.3 and 0.4 as quiet. Two real readings of one flight.
    const records = buildStopFlight({
      axis: 'yaw', stopCount: 2, zeta: 0.002, frequencyHz: 30,
      ringAmplitudeDps: 12, residualDps: 1, trackingOffsetDps: 2,
      plateauRippleDps: 3, plateauRippleHz: 18, noiseDps: 0.2
    });
    const sweep = sweepStopShapeConclusion(records, 'yaw');

    for (const direction of DIRECTIONS) {
      const seen = sweep.directions[direction];
      assert.equal(seen.oscillationSilentEvaluations, 0,
        `${direction}: nothing may be unmeasurable here, or the veto could be coming `
        + 'from silence rather than from disagreement');
      assert.equal(seen.oscillationOpinionShare, 1);
      assert.deepEqual([...seen.oscillationSourcesSeen].sort(),
        ['hold-and-release', 'release-only'],
        `${direction}: both readings must actually appear, or this proves nothing`);
      assert.equal(seen.oscillationSource, null,
        `${direction}: two opinions is no conclusion, and treating silence as an `
        + 'abstention must not have weakened that');
    }

    assert.deepEqual(
      recommendFor(records, 'yaw').findings
        .filter(entry => entry.kind === 'adjustment').map(entry => entry.id),
      [], 'a source that flips across the judgement grid must not become a gain change'
    );
  });

test('the I-term sweep brackets the shipped constants and blocks a verdict that flips',
  () => {
    assert.ok(HOLD_SWEEP.huntingSmoothingUs.includes(148_000),
      'the shipped smoothing length must be inside the sweep');
    assert.ok(Math.min(...HOLD_SWEEP.huntingSmoothingUs) < 148_000);
    assert.ok(Math.max(...HOLD_SWEEP.huntingSmoothingUs) > 148_000);
    assert.ok(HOLD_SWEEP.huntingRippleDps.includes(2));
    assert.ok(Math.min(...HOLD_SWEEP.huntingRippleDps) < 2);
    assert.ok(Math.max(...HOLD_SWEEP.huntingRippleDps) > 2);

    // A hunt just barely over the shipped ripple threshold: the same flight
    // reads as hunting at one threshold and not at another.
    const records = simulateHoldFlight({gains: HOLD_SOFT, gustDps2: 600});
    const hold = assessHoldIndication(records, 'yaw');
    assert.equal(hold.evidence.status, 'captured');
    assert.ok(hold.sweepIndicationsSeen.length > 1,
      'the marginal fixture must actually flip, or this proves nothing; saw '
      + hold.sweepIndicationsSeen.join(', '));
    assert.equal(hold.sweepStable, false);
    assert.equal(hold.indication, 'hold', 'an unstable verdict is not a verdict');
    assert.ok(hold.codes.includes('HOLD_VERDICT_FLIPS_ACROSS_SWEEP'));

    const result = recommendFor(records, 'yaw');
    assert.ok(findingsById(result)['I_TERM_VERDICT_UNSTABLE:yaw'],
      'and the pilot is told that it flipped, not left with silence');
  });

/* =========================================================================== */
/* 8. THE TWO LOGS THIS REPOSITORY ACTUALLY HAS                                */
/* =========================================================================== */

async function analyseSession(session) {
  const bounds = sessionTimeBounds(session);
  const mechanical = await analyzeMechanicalTimeSeries(
    buildMechanicalSeries(session), {timeRangeUs: bounds}
  );
  const axes = {};
  const axisSummaries = {};
  let anyRecords = [];
  for (const axis of ['roll', 'pitch', 'yaw']) {
    const {records, usable} = buildAnalysisRecords(session, {axis});
    if (!usable) {
      continue;
    }
    anyRecords = records;
    axes[axis] = {...analyseAxisEvidence(records, axis), records};
    axisSummaries[axis] = summarizeAxis(session, resolveAxisSignals(session, axis));
  }
  return buildRecommendations({axes, records: anyRecords, mechanical, axisSummaries});
}

test('THE REFERENCE FLIGHT: not one gain change is earned, and the airframe is why',
  {skip: REAL_LOG ? false : 'set ROTORLENS_REAL_LOG'}, async () => {
    const result = await analyseSession(sessionOf(REAL_LOG));

    assert.deepEqual(
      result.findings.filter(entry => entry.kind === 'adjustment').map(entry => entry.id),
      [], 'no gain recommendation is earned by this flight, and that is the right answer'
    );

    const found = findingsById(result);

    // The airframe is blocked, and for the right reason. Over the whole range
    // the head speed spread is 0.621 because the spool-up is inside the
    // selection, so no peak could be tested against a rotor order at all —
    // "no rotor problem found" and "the rotor was never checked" are opposite
    // facts and only the first is about the aircraft.
    const rotor = found.AIRFRAME_ROTOR_NOT_COMPARED;
    assert.ok(rotor, 'expected the rotor-not-compared blocker, got '
      + result.findings.map(entry => entry.id).join(', '));
    assert.equal(rotor.actNow, true, 'and it is what the pilot is told first');
    const spread = rotor.basis
      .find(entry => entry.label.startsWith('head-speed relative spread'));
    assert.ok(Math.abs(spread.value - 0.6211) < 0.001, `spread read ${spread.value}`);

    // And NOT for the wrong reason: the noise floor on this aircraft is 2.24
    // deg/s at worst, well under the 8 deg/s attention level. The total band
    // power reads 10.939 on roll, and an earlier version of this gate blocked on
    // that — which was a mistake, because most of it is the rotor's own orders
    // and the pilot's own inputs, not a floor.
    assert.ok(!found.AIRFRAME_BROADBAND_ELEVATED,
      'the reference aircraft does not have a raised noise floor');
    const floors = result.gates.airframe.axes.map(entry => entry.broadbandNoiseRmsDps);
    assert.ok(Math.max(...floors) < 3, `floors were ${floors.join(', ')}`);
    assert.ok(Math.abs(result.gates.airframe.axes[0].totalBandRmsDps - 10.939) < 0.01,
      'and the total band power is still published beside it, for comparison');

    // Roll and pitch never reached the command threshold; yaw got one stop each
    // way, which is one short.
    assert.equal(found['STOP_EVIDENCE_INCOMPLETE:roll'].basis
      .find(entry => entry.label.startsWith('largest command')).value, 56);
    assert.equal(found['STOP_EVIDENCE_INCOMPLETE:pitch'].basis
      .find(entry => entry.label.startsWith('largest command')).value, 32);
    assert.equal(found['STOP_EVIDENCE_INCOMPLETE:yaw'].basis
      .find(entry => entry.label.startsWith('stops captured one way')).value, 1);
  });

test('THE REFERENCE FLIGHT: the two yaw stops have OPPOSITE shapes, and the engine '
  + 'says so even though it cannot conclude from them',
{skip: REAL_LOG ? false : 'set ROTORLENS_REAL_LOG'}, async () => {
  // This is the single most informative thing this flight can say about yaw, and
  // the plain amplitude metric ranks the two stops backwards.
  const result = await analyseSession(sessionOf(REAL_LOG));
  const shape = findingsById(result)['STOP_SHAPE_PROVISIONAL:yaw'];
  assert.ok(shape, 'expected the provisional shape observation');
  assert.equal(shape.kind, 'observation');

  const what = shape.basis.find(entry => entry.label === 'what each stop did').value;
  assert.match(what, /settled/, `expected one settled stop: ${what}`);
  assert.match(what, /not-stopped/, `expected one failure to arrest: ${what}`);

  const value = label => shape.basis.find(entry => entry.label === label)?.value;
  assert.ok(Math.abs(value('rate still in the commanded direction, positive stop') - 17) < 0.5);
  assert.ok(Math.abs(value('rate still in the commanded direction, negative stop') - 115) < 0.5);
  assert.ok(Math.abs(value('envelope decay, positive stop') - 1.0529) < 0.01);
  assert.ok(Math.abs(value('envelope decay, negative stop') - 0.2045) < 0.01);

  // And the number the shape corrects: the stop that FAILED to arrest scores
  // 4.9x higher on the metric TERM_VIEWS.D points at.
  const plainPositive = value('plain response size, positive stop');
  const plainNegative = value('plain response size, negative stop');
  assert.ok(Math.abs(plainPositive - 7.12) < 0.02, `positive read ${plainPositive}`);
  assert.ok(Math.abs(plainNegative - 34.82) < 0.02, `negative read ${plainNegative}`);
  assert.ok(plainNegative > plainPositive * 4,
    'the amplitude metric ranks the failure to arrest as the worse "ringing"');
});

test('THE STOP FIXTURE: the 2.8x directional asymmetry is recovered, and the airframe '
  + 'gate blocks anyway because the log has no unfiltered gyro', async () => {
    const result = await analyseSession(sessionOf(STOP_FIXTURE));
    const found = findingsById(result);

    // The deliberate asymmetry, on the two axes that carry it.
    const rollRatio = found['DIRECTIONAL_ASYMMETRY_MECHANICAL:roll'].basis
      .find(entry => entry.label.startsWith('how many times worse')).value;
    assert.ok(Math.abs(rollRatio - 2.85) < 0.02,
      `roll should recover the built-in 2.8x asymmetry, read ${rollRatio}`);
    const yawRatio = found['DIRECTIONAL_ASYMMETRY_MECHANICAL:yaw'].basis
      .find(entry => entry.label.startsWith('how many times worse')).value;
    assert.ok(yawRatio > 3.9 && yawRatio < 4.1, `yaw read ${yawRatio}`);
    assert.ok(!found['DIRECTIONAL_ASYMMETRY_MECHANICAL:pitch'],
      'pitch carries no asymmetry and must not be given one');

    // Until 2026-08-13 this asserted AIRFRAME_UNFILTERED_GYRO_MISSING, because
    // the corpus carried only the filtered gyro and the airframe therefore
    // could never be ruled out. The generator now emits gyroRAW, so the gate
    // clears on its merits.
    assert.ok(found.AIRFRAME_CLEAR,
      'the airframe should now clear, got ' + result.findings.map(entry => entry.id).join(', '));
    assert.equal(result.findings[0].rung, 'airframe',
      'the airframe still reports first, cleared or not');

    // Still no gain change, and now for the RIGHT reason. Roll and yaw carry an
    // asymmetry larger than a gain explains, so they are reported as mechanical;
    // pitch is a clean symmetric stop with nothing to fix. Previously all three
    // were withheld for the same unrelated reason — a missing field — which hid
    // that difference completely.
    assert.deepEqual(
      result.findings.filter(entry => entry.kind === 'adjustment').map(entry => entry.id), []
    );

    // THE GAP THIS FIXTURE STILL LEAVES, stated so it is not mistaken for
    // coverage: no fixture in the corpus carries a genuine, symmetric gain
    // fault, so no `kind: 'adjustment'` finding has ever been rendered by the
    // viewer — on a phone or in the browser test. The gain cards are covered by
    // unit tests over synthetic records (see the INJECTED FAULT tests above) and
    // by nothing that draws a screen. A pure-function test does not prove a
    // screen renders.
    assert.equal(found.AIRFRAME_UNFILTERED_GYRO_MISSING, undefined);
  });

/* =========================================================================== */
/* 8b. MECHANICAL FAULTS DRESSED AS GAIN FAULTS                                */
/*                                                                             */
/* Every test in this block reproduces a case an adversarial review found on    */
/* 13 August 2026, where this engine turned a MECHANICAL fault into a confident */
/* gain instruction with actNow set. The rule the product decision left intact  */
/* is that mechanical faults outrank gains; these are the four places it was    */
/* not actually holding. Each has a CONTROL that must still earn its verdict,   */
/* because a guard that blocks everything is not a guard.                       */
/* =========================================================================== */

test('a control run at its TRAVEL LIMIT is not diagnosed as too little P', () => {
  // The fault is physical: the actuator cannot move past a point. Nothing here
  // paints a metric. A saturated actuator produces the most offset-dominant
  // tracking error possible — offsetShare 1.000 — so the old code grew MORE
  // confident about "Raise P" the harder the control was jammed.
  const stops = [];
  for (let n = 0; n < 6; n += 1) {
    stops.push({atS: 2 + n * 4, amplitudeDps: n % 2 === 0 ? 200 : -200, holdS: 1.6});
  }
  const fly = (kp, actuatorLimit) => recommendFor(
    simulateStopLoop({gains: {kp, ki: 0.05, kd: 0.0014}, actuatorLimit, stops}), 'roll'
  );

  // THE CONTROL, first: the same simulator with a healthy actuator invents
  // nothing. Without this the test could pass by blocking everything.
  const healthy = fly(0.105, Infinity);
  assert.deepEqual(
    healthy.findings.filter(entry => entry.kind === 'adjustment').map(entry => entry.id), [],
    'a healthy loop must not be given a gain change either'
  );

  // Now the travel limit, at the gain as flown and at three steps above it. The
  // damage in the reproduction was that the SAME instruction was reissued at
  // every gain, unfalsifiably, while the tracking error moved by 0.16%.
  for (const kp of [0.105, 0.13, 0.17, 0.22, 0.30]) {
    const result = fly(kp, 0.22);
    const ids = result.findings.map(entry => entry.id);
    assert.ok(!ids.includes('P_TOO_LOW:roll') && !ids.includes('P_TOO_LOW'),
      `kp=${kp}: a jammed control must not be answered with "raise P": ${ids.join(', ')}`);
    assert.deepEqual(
      result.findings.filter(entry => entry.kind === 'adjustment').map(entry => entry.id), [],
      `kp=${kp}: no gain change at all is earnable from a saturated actuator`
    );

    const finding = result.findings.find(entry => entry.id === 'AXIS_DOES_NOT_ARREST');
    assert.ok(finding, `kp=${kp}: expected AXIS_DOES_NOT_ARREST, got ${ids.join(', ')}`);
    assert.equal(finding.kind, 'next-flight');
    assert.equal(finding.direction, null);
    assert.ok(finding.candidates.some(entry => /travel|rate limit/i.test(entry)),
      'the travel limit must be named as a candidate');
    assert.ok(finding.basis.some(entry => /share of the rate being asked for/.test(entry.label)),
      'and the number that sent it here must be shown');
  }

  // AND THE DISCRIMINATOR MUST NOT BE A BLANKET REFUSAL. A genuine too-little-P
  // fixture — a real standing offset, small enough that a gain step can close it
  // — still earns its verdict. This is the same fixture section 3 uses.
  const genuine = recommendFor(buildStopFlight({axis: 'yaw', ...STOP_FAULTS.tooLittleP}), 'yaw');
  assert.ok(genuine.withheld.some(entry => entry.findingId === 'P_TOO_LOW'),
    'the guard must preserve the diagnosis even though stability withholds the instruction');
});

test('a bind survives the flight controller clamping its own integrator', () => {
  // `growing`/`woundUp` both require the I term to still be MOVING, so the old
  // bind discriminator switched itself off exactly when the integrator finished
  // winding against something it could not beat — which is what every real FC's
  // `iterm_limit` guarantees. The aircraft is equally bound in every row below;
  // the only thing that changes is a controller setting RotorLens cannot see.
  const bound = integratorLimit => simulateHoldFlight({
    axis: 'yaw', gains: {kp: 0.105, ki: 0.05, kd: 0.0014},
    actuatorLimit: 0.02, integratorLimit, disturbanceDps2: 60, durationS: 30
  });

  const errors = [];
  for (const clamp of [Infinity, 4, 2, 1, 0.5]) {
    const records = bound(clamp);
    const hold = assessHoldIndication(records, 'yaw');
    errors.push(hold.evidence.summary.meanAbsoluteSteadyStateErrorDps);

    assert.equal(hold.bind.suspected, true,
      `iterm_limit=${clamp}: a 22 deg/s standing error with the integrator capped is a bind, `
      + `read travelShare=${hold.iTermAuthority.meanITermTravelShare} `
      + `i/p=${hold.iTermAuthority.meanITermToPTermRatio}`);
    assert.equal(hold.indication, 'hold', `iterm_limit=${clamp}: and no I direction may survive`);

    const result = recommendFor(records, 'yaw');
    assert.deepEqual(
      result.findings.filter(entry => entry.kind === 'adjustment').map(entry => entry.id), [],
      `iterm_limit=${clamp}: "Raise yaw I" at a tail out of authority`
    );
    const finding = result.findings.find(entry => entry.id === 'SUSPECTED_MECHANICAL_BIND');
    assert.ok(finding, `iterm_limit=${clamp}: the bind must be NAMED, not merely withheld`);
    assert.equal(finding.kind, 'blocker');
    assert.equal(finding.actNow, true, 'and it is the one thing to do');
    if (clamp !== Infinity) {
      assert.match(finding.reasoning, /did not move|DID NOT MOVE/,
        'a clamped integrator must be described as clamped, not as winding');
    }
  }

  // The fixture must genuinely be the same aircraft in every row, or the sweep
  // proves nothing about the clamp.
  const spread = Math.max(...errors) - Math.min(...errors);
  assert.ok(spread < 0.5,
    `the standing error must be the same in every row, spread ${spread.toFixed(3)} deg/s`);

  // CONTROL: a healthy linkage on the same simulator is not called a bind.
  const healthy = assessHoldIndication(
    simulateHoldFlight({axis: 'yaw', gains: HOLD_NOMINAL, durationS: 30}), 'yaw');
  assert.equal(healthy.bind.suspected, false,
    'a healthy hold must not be read as a bind, or the guard blocks every flight');
});

test('an external periodic disturbance is not diagnosed as too much I', () => {
  // A hunting governor, a slipping belt, wind. The integral of a periodic error
  // is periodic at the same frequency whoever is driving the aircraft, so the
  // crossing-rate match the old code relied on reads ~1.0 here — and the engine
  // said "Lower yaw I" at every I value down to a tenth of the original.
  const flown = ki => simulateHoldFlight({
    axis: 'yaw', gains: {kp: 0.105, ki, kd: 0.0014},
    externalTorqueDps2: 1000, externalTorqueHz: 0.8, durationS: 30
  });

  const wanders = [];
  for (const ki of [0.05, 0.025, 0.0125, 0.005]) {
    const records = flown(ki);
    const hold = assessHoldIndication(records, 'yaw');
    wanders.push(holdWanderPkPk(records, 2));

    assert.equal(hold.shippedIndication, 'decrease',
      `ki=${ki}: upstream must genuinely say "lower I", or this test proves nothing`);
    assert.ok(Math.abs(hold.iTermCoupling.meanCrossingRateRatio - 1) < 0.4,
      `ki=${ki}: and the crossing rates must genuinely match — that is the trap: `
      + hold.iTermCoupling.meanCrossingRateRatio);
    assert.equal(hold.indication, 'hold', `ki=${ki}: the size test must refuse it`);
    assert.ok(hold.codes.includes('I_TERM_TOO_SMALL_A_SHARE_OF_THE_OUTPUT'));

    const result = recommendFor(records, 'yaw');
    assert.deepEqual(
      result.findings.filter(entry => entry.kind === 'adjustment').map(entry => entry.id), []
    );
    // And the pilot is not left in silence in front of a wander he can see.
    const said = result.findings.find(entry => entry.id === 'SLOW_WANDER_NOT_FROM_THE_I_TERM');
    assert.ok(said, 'the wander must still be reported: '
      + result.findings.map(entry => entry.id).join(', '));
    assert.equal(said.direction, null);
    assert.ok(said.candidates.some(entry => /governor/i.test(entry)));
    assert.ok(said.candidates.some(entry => /belt|drive/i.test(entry)));
  }

  // The fixture's own falsification: the I gain is not what is moving the
  // aircraft, and the numbers say so before any verdict is read.
  const spread = Math.max(...wanders) - Math.min(...wanders);
  assert.ok(spread / Math.max(...wanders) < 0.05,
    `a fourfold change in I must barely move the wander, moved ${spread.toFixed(2)} deg/s`);

  // CONTROL: the genuine over-large I fixture — the same one section 4 uses —
  // still earns "lower I". Its integrator carries a large share of the output's
  // own movement, which is exactly the difference from the rows above.
  const genuine = assessHoldIndication(
    simulateHoldFlight({gains: HOLD_SOFT, gustDps2: 2200, durationS: 28}), 'yaw');
  assert.equal(genuine.indication, 'decrease',
    'the guard must not have swallowed a real integrator hunt: ' + genuine.codes.join(', '));
  assert.ok(genuine.iTermAuthority.meanITermShareOfOutputRipple
    > AUTHORITY_LIMITS.iTermShareOfOutputRipple,
    'and it must clear the size test by measurement, not by luck: '
    + genuine.iTermAuthority.meanITermShareOfOutputRipple);
});

test('a rotor-order tone under the attention threshold is reported, and stops a gain '
  + 'change being read off an oscillation sitting on it', async () => {
    // The spectrum analyser only converts a harmonic match into a reason code
    // when the peak is ALREADY above the attention level, so a tone positively
    // matched to main-rotor order 1 could be measured, named, and discarded —
    // while the pilot was told the airframe was "a positive measurement of
    // absence, not silence".
    const onOrder = buildStopFlight({
      axis: 'yaw', ...STOP_FAULTS.tooMuchD, frequencyHz: 30, headspeedRpm: 1800
    });
    const range = {startTimeUs: onOrder[0].timeUs, endTimeUs: onOrder.at(-1).timeUs};
    const mechanical = await analyzeMechanicalTimeSeries(seriesOf(onOrder), {timeRangeUs: range});

    // The fixture must genuinely produce the situation: a peak the analyser
    // matched to the rotor, below the level it would call attention-worthy.
    assert.equal(mechanical.status, 'clear',
      'the upstream analysis must call this clear, or the test proves nothing');
    const gate = assessAirframe(mechanical);
    assert.equal(gate.status, 'permitted');
    const matched = gate.subThresholdTones.filter(tone => tone.rotor === 'main');
    assert.ok(matched.length > 0,
      'a rotor-matched sub-threshold tone must be present: '
      + JSON.stringify(gate.subThresholdTones));
    assert.ok(matched.every(tone => tone.bandRmsDps < gate.attentionThresholdDps),
      'and it must be BELOW the attention level — that is the case that was lost');

    const result = recommendFor(onOrder, 'yaw', mechanical);
    const ids = result.findings.map(entry => entry.id);

    // 1. The airframe rung must stop claiming absence.
    assert.ok(!ids.includes('AIRFRAME_CLEAR'),
      '"a positive measurement of absence" is false when a tone was measured');
    const airframe = result.findings.find(entry => entry.id === 'AIRFRAME_TONE_BELOW_ATTENTION');
    assert.ok(airframe, `expected the tone observation, got ${ids.join(', ')}`);
    assert.equal(airframe.kind, 'observation', 'a small tone is not a blocker');
    assert.ok(airframe.basis.some(entry => /once-per-rev/.test(entry.label)),
      'and the rotor order must be named: '
      + airframe.basis.map(entry => entry.label).join(' | '));

    // 2. No gain change may be read off an oscillation sitting on that tone.
    assert.deepEqual(
      result.findings.filter(entry => entry.kind === 'adjustment').map(entry => entry.id), [],
      'a loop cannot choose to oscillate at exactly the speed the rotor turns at'
    );
    const refused = result.findings.find(
      entry => entry.id === 'OSCILLATION_MATCHES_AIRFRAME_TONE');
    assert.ok(refused, `expected the coincidence finding, got ${ids.join(', ')}`);
    assert.equal(refused.kind, 'next-flight');
    assert.equal(refused.direction, null);
    assert.match(refused.confirm, /head speed/,
      'and the flight that separates them must be prescribed');

    // 3. THE CONTROL, and it is the one that matters most: the SAME fault at a
    // frequency the analyser can tell apart from the rotor still earns its
    // verdict. A genuine D-term ring IS a persistent narrowband tone — measured
    // on this fixture it reads 4.8 deg/s over 82% of the windows — so a rule
    // that refused on any coincident tone would refuse every D finding forever.
    const offOrder = buildStopFlight({axis: 'yaw', ...STOP_FAULTS.tooMuchD});
    const offRange = {startTimeUs: offOrder[0].timeUs, endTimeUs: offOrder.at(-1).timeUs};
    const offMech = await analyzeMechanicalTimeSeries(seriesOf(offOrder), {timeRangeUs: offRange});
    const offGate = assessAirframe(offMech);
    assert.ok(offGate.subThresholdTones.length > 0,
      'the control must ALSO carry a sub-threshold tone — the loop makes one — '
      + 'or it is not testing the discriminator');
    assert.ok(offGate.subThresholdTones.every(tone => tone.rotor === null),
      'and none of it may match a rotor order: '
      + JSON.stringify(offGate.subThresholdTones));
    assert.ok(recommendFor(offOrder, 'yaw', offMech).withheld
      .some(entry => entry.findingId === 'D_TOO_HIGH'),
    'the same fault off the rotor order must still be diagnosed, then stability-gated');
  });

test('the two limits behind the tone and I-term rules are load-bearing, not decoration',
  () => {
    // Both of these survived their first mutation round: the persistence floor
    // and the requirement that the log actually contain an I term could each be
    // deleted with the whole suite green. A limit no test can falsify is the
    // defect class this file exists for, so each gets one that can.

    // 1. THE PERSISTENCE FLOOR. A peak present in a third of the analysis
    // windows is a moment, not a feature of the flight, and must not be reported
    // as a tone — nor be able to block a gain change by coinciding with an
    // oscillation.
    const withPeaks = persistences => cleanAirframe({
      axes: ['roll', 'pitch', 'yaw'].map(axis => ({
        axis, source: 'gyroRAW', available: true,
        medianNoisePsdDps2PerHz: 0.0002, broadbandRmsDps: 1.2,
        peaks: axis !== 'yaw' ? [] : persistences.map((persistenceRatio, at) => ({
          frequencyHz: 30 + at, bandRmsDps: 3, bandwidthHz: 2, persistenceRatio,
          attentionEligible: false,
          harmonicMatch: {rotor: 'main', order: 1, predictedHz: 30, deltaHz: 0, toleranceHz: 3}
        }))
      }))
    });

    const fleeting = assessAirframe(withPeaks([0.1, 0.3, 0.49]));
    assert.deepEqual([...fleeting.subThresholdTones], [],
      'nothing under the persistence floor may be reported as a tone: '
      + JSON.stringify(fleeting.subThresholdTones));
    assert.deepEqual([...fleeting.observations], []);

    const persistent = assessAirframe(withPeaks([0.1, 0.51, 0.9]));
    assert.equal(persistent.subThresholdTones.length, 2,
      'and everything at or above it must be');
    assert.ok(persistent.observations.includes('PERSISTENT_TONE_BELOW_ATTENTION_THRESHOLD'));

    // The floor decides whether an oscillation can be refused, not merely what
    // is printed, so it is exercised through `coincidentTone` too.
    assert.equal(coincidentTone(fleeting.subThresholdTones, 30), null);
    assert.ok(coincidentTone(persistent.subThresholdTones, 30));
    // And the rotor match is what makes it a match at all.
    assert.equal(
      coincidentTone(persistent.subThresholdTones.map(tone => ({...tone, rotor: null})), 30),
      null, 'a tone matching no rotor order is not evidence and must not block');

    // 2. THE I TERM MUST BE IN THE LOG. Take a fixture that genuinely earns
    // "raise I" and remove only the recorded PID terms — same aircraft, same
    // error, a logging setup that did not record what the integrator did.
    const flown = simulateHoldFlight({
      gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400
    });
    assert.equal(assessHoldIndication(flown, 'yaw').indication, 'increase',
      'the fixture must genuinely earn "raise I" with its terms, or this proves nothing');

    const untermed = flown.map(record => ({...record, terms: [0, 0, 0]}));
    const blind = assessHoldIndication(untermed, 'yaw');
    assert.equal(blind.iTermAuthority.available, false);
    assert.equal(blind.shippedIndication, 'increase',
      'and upstream must still say increase — the error trace has not changed');
    assert.equal(blind.indication, 'hold',
      '"the I term is small and is not winding up" is a claim about a term this log lacks');
    assert.ok(blind.codes.includes('I_TERM_NOT_LOGGED'));

    const result = recommendFor(untermed, 'yaw');
    assert.deepEqual(
      result.findings.filter(entry => entry.kind === 'adjustment').map(entry => entry.id), []);
    const said = result.findings.find(entry => entry.id === 'I_TERM_NOT_LOGGED');
    assert.ok(said, 'and the pilot must be told WHY, and what to turn on: '
      + result.findings.map(entry => entry.id).join(', '));
    assert.match(said.confirm, /axisP|axisI/, 'naming the fields to enable');
    assert.ok(!result.findings.some(entry => entry.id === 'I_TERM_WITHIN_TOLERANCE'),
      '"nothing calls for an I-term change" would be a false negative here');
  });

/* =========================================================================== */
/* 9. SMALL PIECES                                                             */
/* =========================================================================== */

test('the governor rung reports the whole flight and gates where the limit is derived',
  () => {
    // Applying a five-second hold's 5% limit to a whole flight is a category
    // error, and this module made it once: the reference log's spread reads 1.088
    // across the whole range and 0.551 over the spinning samples, because the
    // spool-up is 15% of the recording — while the flight is fine.
    const spoolUp = [];
    for (let step = 0; step < 130_000; step += 1) {
      const t = step / 1000;
      spoolUp.push({
        timeUs: step * 1000,
        headspeed: t < 20 ? Math.max(0, 1705 * (t / 20)) : 1705 + Math.sin(t) * 30
      });
    }
    const assessed = assessHeadspeed(spoolUp);
    assert.ok(assessed.measured.wholeRangeSpanRatio > 0.9, 'the raw span is huge');
    assert.ok(assessed.measured.afterSpoolUpSpreadRatio < 0.06,
      'and once the rotor is up it is fine: '
      + assessed.measured.afterSpoolUpSpreadRatio);
    assert.equal(assessed.status, 'permitted',
      'a recording that starts before the rotor does must not fail the governor rung');

    // What DOES block: the head speed moving during otherwise steady flight, at
    // the scale the 5% limit was actually derived for.
    const blocked = assessHeadspeed(spoolUp, {
      holdRejections: {yaw: {HOLD_HEADSPEED_UNSTABLE: 4, HOLD_OFF_AXIS_INPUT: 1}}
    });
    assert.equal(blocked.status, 'blocked');
    assert.ok(blocked.codes.includes('HEADSPEED_COST_THIS_FLIGHT_ITS_HOLDS'));
  });

test('timesWorse turns the scale-free ratio into something a pilot can picture', () => {
  const random = rng(555);
  for (let draw = 0; draw < 5000; draw += 1) {
    const low = 0.01 + random() * 20;
    const high = low * (1 + random() * 9);
    const ratio = timesWorse(low, high);
    assert.ok(Math.abs(ratio - high / low) < 0.01, `${low} vs ${high} gave ${ratio}`);
    assert.equal(timesWorse(high, low), ratio, 'and it does not care about the order');
    assert.ok(ratio >= 1, 'the poorer side is never better than the better side');
  }
  assert.equal(timesWorse(0, 5), null, 'a zero denominator is not a ratio');
  assert.equal(timesWorse(null, 5), null);
});

test('BIND_LIMITS separate a wound-up integrator from an absent one', () => {
  // A property sweep rather than the two hand-picked simulations above: across
  // thousands of draws, an I term that is large AND growing against a persistent
  // error is a bind, and an I term that is small or static is not.
  const random = rng(8080);
  let binds = 0;
  let notBinds = 0;
  for (let draw = 0; draw < 4000; draw += 1) {
    const winding = draw % 2 === 0;
    const drift = winding
      ? BIND_LIMITS.minimumITermDriftPerSecond * (1.2 + random() * 8)
      : random() * BIND_LIMITS.minimumITermDriftPerSecond * 0.7;
    const rms = winding
      ? Math.abs(drift) * BIND_LIMITS.windUpToDriftRatio * (1.2 + random() * 5)
      : random() * 0.4;
    const error = BIND_LIMITS.errorDpsThreshold * (1.3 + random() * 10);
    const suspected = error > BIND_LIMITS.errorDpsThreshold
      && Math.abs(drift) >= BIND_LIMITS.minimumITermDriftPerSecond
      && Math.abs(drift) > 0
      && rms >= Math.abs(drift) * BIND_LIMITS.windUpToDriftRatio;
    assert.equal(suspected, winding,
      `draw ${draw}: error ${error} drift ${drift} rms ${rms}`);
    if (winding) {
      binds += 1;
    } else {
      notBinds += 1;
    }
  }
  assert.ok(binds > 1500 && notBinds > 1500);
});

/**
 * Every gain verdict that blames an oscillation must admit it cannot exclude
 * the airframe.
 *
 * This is the largest known harm route in the feature and it is not a
 * hypothetical. Measured through the real spectrum analyser, this repository's
 * own genuine too-much-D fixture rings at 25.4 deg/s-band, present in 82% of
 * the analysis windows, matching no rotor order — which is to say it is
 * indistinguishable in every published field from a dry bearing or a loose
 * mount. `coincidentTone` catches only the rotor-order case, because a control
 * loop cannot choose to oscillate at exactly the speed the rotor turns.
 *
 * Off a rotor order the engine still has to name a gain or say nothing useful,
 * so it names one. What it must never do is name one and sound certain, or send
 * a pilot round a loop of lowering D into a fault that is getting worse. The
 * confirming flight is what separates them, and only if the pilot is told what
 * the OTHER outcome means.
 */
test('an unstable oscillation diagnosis never becomes a gain verdict', () => {
  const cases = [
    {fault: 'tooMuchD', axis: 'yaw', id: 'D_TOO_HIGH'},
    {fault: 'tooMuchP', axis: 'yaw', id: 'P_TOO_HIGH'}
  ];

  for (const {fault, axis, id} of cases) {
    const records = buildStopFlight({axis, ...STOP_FAULTS[fault]});
    const result = recommendFor(records, axis);
    assert.ok(result.withheld.some(entry => entry.findingId === id),
      `${fault} should retain ${id} as a withheld diagnosis`);
    assert.deepEqual(result.findings.filter(entry => entry.kind === 'adjustment'), []);
  }
});

test('the ambiguity note names a real tone when one is sitting at that frequency', () => {
  // With no tone measured there, the note still fires but must not invent a
  // sighting — the difference between "nothing was seen" and "something was".
  const quiet = airframeAmbiguity([], 30);
  assert.equal(quiet.code, 'AIRFRAME_MODE_NOT_EXCLUDED');
  assert.match(quiet.sentence, /No airframe tone was measured at that frequency/);
  assert.equal(quiet.tone, null);

  const tones = [{frequencyHz: 31, bandRmsDps: 3.5, bandwidthHz: 2, rotor: null, order: null}];
  const seen = airframeAmbiguity(tones, 30);
  assert.equal(seen.code, 'AIRFRAME_MODE_NOT_EXCLUDED_TONE_PRESENT');
  assert.match(seen.sentence, /31 Hz/);
  assert.match(seen.sentence, /matching no rotor order/);
  assert.equal(seen.tone.frequencyHz, 31);

  // A rotor-matched tone is somebody else's job: coincidentTone refuses the
  // verdict outright, so this helper must not also claim it as an unmatched one.
  const rotorTone = [{frequencyHz: 31, bandRmsDps: 3.5, bandwidthHz: 2, rotor: 'main', order: 1}];
  assert.equal(airframeAmbiguity(rotorTone, 30).tone, null);
  assert.equal(unmatchedTone(rotorTone, 30), null);
});
