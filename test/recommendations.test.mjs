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
  TONE_LIMITS,
  airframeAmbiguity,
  analyseAxisEvidence,
  assessAirframe,
  assessHeadspeed,
  assessHoldIndication,
  buildRecommendations,
  classifyStopShape,
  coincidentTone,
  earnsITermAllClear,
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
import {describeHoldCapture, holdManoeuvre, resolveAxisSignals, summarizeAxis}
  from '../src/analysis/axis-report.mjs';
// By namespace: a named import of an export a module lacks is a link error that
// takes every test in this file down with it, not only the one that reads it.
import * as pidEvidence from '../src/analysis/pid-evidence.mjs';
import {
  analyzeMechanicalTimeSeries,
  analyzeMechanicalWindow,
  buildMechanicalSeries,
  MECHANICAL_CONSTANTS,
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
  // Where in its cycle that torque starts, in radians. A slow torque's phase
  // decides how much of a part-cycle each hold's mean is left holding, so a
  // sweep that never moves it is one flight flown many times.
  externalTorquePhase = 0,
  // More periodic torques beside that one, `[{dps2, hz, phase}]`: a slow wander
  // with a fast vibration on top of it, say (round three).
  extraTorques = [],
  // Stop manoeuvres instead of one split pulse, for the stop-shape path.
  stops = null,
  // A piecewise-constant command schedule, `[{atS, untilS, dps}]`, instead of
  // either of the above: any number of holds, at zero or at a rate, of any
  // length (2 October 2026, round three — see `holdLayout`).
  commands = null,
  noiseDps = 0.8,
  headspeedRpm = 1800,
  // A static feedforward: this much of the COMMAND added straight to the output
  // (3 October 2026). Set too high, it carries every turn past the commanded
  // rate, whichever way the aircraft turns.
  feedforward = 0,
  // A constant added to the output by another path — a tail precompensation or
  // a mixer offset (round seven, 3 October 2026). The I term then carries the
  // difference as a TRIM, of either sign, rather than sitting near zero.
  outputBias = 0,
  // The I term at the first sample: the trim it already carried when the log
  // began. With `outputBias`, an integrator trimmed for a free linkage.
  iTermStart = 0,
  // The firmware's own scaling of the logged P, I and D terms, which RotorLens
  // does not know. The loop runs on the unscaled terms; only the log is scaled.
  loggedTermScale = 1
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
  let integral = gains.ki ? iTermStart / gains.ki : 0;
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
    if (commands) {
      for (const segment of commands) {
        if (t >= segment.atS && t < segment.untilS) {
          command = segment.dps;
        }
      }
    } else if (stops) {
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
    const output = Math.max(-actuatorLimit, Math.min(actuatorLimit,
      pTerm + iTerm + dTerm + feedforward * command + outputBias));

    delayLine.push(output);
    const delayed = delayLine.shift();
    actuator += (delayed - actuator) * (plant.dt / plant.actuatorTau);
    gust += ((random() - 0.5) * 2 * gustDps2 - gust) * (plant.dt / gustTauS);
    let external = externalTorqueDps2 === 0
      ? 0 : externalTorqueDps2 * Math.sin(2 * Math.PI * externalTorqueHz * t + externalTorquePhase);
    for (const torque of extraTorques) {
      external += torque.dps2 * Math.sin(2 * Math.PI * torque.hz * t + (torque.phase ?? 0));
    }
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
      terms: [pTerm * loggedTermScale, iTerm * loggedTermScale, dTerm * loggedTermScale],
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

/**
 * The default 28 s hold flight with a third hold — a second split pulse at 20 s
 * — for `simulateHoldFlight({...THREE_HOLDS})`. Since round three a standing
 * error is read only from three holds or more, because two on the same side is
 * also what half a slow wander looks like. Every fixture whose point is that
 * "Raise I" IS reached flies this.
 */
const THREE_HOLDS = Object.freeze({
  durationS: 28,
  commands: Object.freeze([{atS: 1, untilS: 1.4, dps: 120}, {atS: 12, untilS: 12.4, dps: 120},
    {atS: 20, untilS: 20.4, dps: 120}])
});

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
    // Three holds since round three: two on the same side is not enough to call
    // a standing error (see 'too little I still earns "Raise I" ...').
    const records = simulateHoldFlight({
      gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400, ...THREE_HOLDS
    });
    const hold = assessHoldIndication(records, 'yaw');
    assert.equal(hold.evidence.status, 'captured', 'the fixture must yield its holds');
    assert.equal(hold.holdCount, 3);
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
    // Three holds since round three, so that upstream still reads the standing
    // error at all — this test is about what overrides that reading.
    const records = simulateHoldFlight({
      gains: HOLD_NOMINAL, disturbanceDps2: 200, actuatorLimit: 0.2, ...THREE_HOLDS
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
    // Three holds since round three, the fewest a standing error is read from.
    tooLittleI: {gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400, ...THREE_HOLDS},
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
  // Three holds since round three: with two this fixture no longer earned "Raise
  // I" at all, and refusing what was never reached would prove nothing.
  const records = simulateHoldFlight({
    gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400, ...THREE_HOLDS
  });
  assert.deepEqual(adjustmentIds(recommendFor(records, 'yaw')), ['I_TOO_LOW'],
    'over the right seconds, this flight earns "Raise I"');
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
    // Three holds, which earns "Raise I" (round three) ...
    {gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400, ...THREE_HOLDS},
    // ... and two, which since round three is a next flight, I_TERM_NOT_JUDGED.
    {gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400},
    {gains: HOLD_NOMINAL, disturbanceDps2: 200, actuatorLimit: 0.2},
    {gains: HOLD_SOFT, gustDps2: 2200},
    {gains: HOLD_NOMINAL, disturbanceDps2: 200},
    // A fast oscillation that hides the band under it (round three).
    {gains: HOLD_NOMINAL, externalTorqueDps2: 3000, externalTorqueHz: 4, durationS: 30}
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
  // Added 2 October 2026, so the guards below also read the three roads that
  // replaced unearned output: a healthy tail's tiny shortfall, holds of two
  // kinds, and a head-speed reading that dropped out. See section 8d.
  results.push(recommendFor(laggedLoopFlight(), 'yaw'));
  results.push(recommendFor(simulateHoldFlight({
    gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400, durationS: 60,
    stops: [{atS: 1, amplitudeDps: 120, holdS: 0.3}, {atS: 13, amplitudeDps: 60, holdS: 11},
      {atS: 37, amplitudeDps: -60, holdS: 11}]
  }), 'yaw'));
  results.push(recommendFor(simulateHoldFlight({
    gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400, durationS: 46,
    stops: [1, 12, 23, 34].map(atS => ({atS, amplitudeDps: 120, holdS: 0.3}))
  }).map((record, at) => (at === 18_000 ? {...record, headspeed: Number.NaN} : record)), 'yaw'));
  // And the roads added in round two (section 8e): both hold signatures at once,
  // a slow wander below the band, an in-band wobble the I term does not carry,
  // and a head speed that moved in too few segments, or in some of enough.
  results.push(recommendFor(simulateHoldFlight({
    gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400, externalTorqueDps2: 1000,
    externalTorqueHz: 1.0, durationS: 30
  }), 'yaw'));
  results.push(recommendFor(simulateHoldFlight({
    gains: HOLD_NOMINAL, externalTorqueDps2: 6000, externalTorqueHz: 0.16, durationS: 40
  }), 'yaw'));
  results.push(recommendFor(simulateHoldFlight({
    gains: {...HOLD_NOMINAL, ki: 0}, externalTorqueDps2: 1200, externalTorqueHz: 1.0,
    durationS: 30
  }), 'yaw'));
  const wobbling = seconds => 1800 * (1 + 0.08 * Math.sin(2 * Math.PI * 0.2 * seconds));
  results.push(recommendFor(simulateHoldFlight({
    gains: HOLD_NOMINAL, disturbanceDps2: 400, durationS: 14,
    stops: [{atS: 1, amplitudeDps: 120, holdS: 0.3}]
  }).map(record => (record.timeUs > 3e6 && record.timeUs < 13e6
    ? {...record, headspeed: wobbling(record.timeUs / 1e6)} : record)), 'yaw'));
  results.push(recommendFor(simulateHoldFlight({
    gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400, durationS: 46,
    stops: [1, 12, 23, 34].map(atS => ({atS, amplitudeDps: 120, holdS: 0.3}))
  }).map(record => (record.timeUs > 14e6 && record.timeUs < 22e6
    ? {...record, headspeed: wobbling(record.timeUs / 1e6)} : record)), 'yaw'));
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
  const seen = new Set();
  for (const result of everyResult()) {
    for (const finding of result.findings) {
      seen.add(finding.id);
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
  // The roads added on 2 October 2026 must actually be among what was read.
  for (const id of ['AXIS_DOES_NOT_ARREST', 'I_TERM_HOLDS_MIXED', 'HEADSPEED_READING_DROPPED_OUT',
    'I_TERM_SIGNATURES_CONFLICT', 'SLOW_WANDER_NOT_FROM_THE_I_TERM',
    'HEADSPEED_TOO_FEW_SEGMENTS_TO_JUDGE', 'HEADSPEED_MOVED_IN_SOME_SEGMENTS', 'I_TOO_LOW',
    'I_TERM_NOT_JUDGED']) {
    assert.ok(seen.has(id), `${id} is not reached by everyResult(), so this guard does not read it`);
  }
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
    // passes on its merits.
    //
    // UPDATED in Stage 2d: this pinned AIRFRAME_CLEAR, and that pin was item 1's
    // bug. The fixture's 25.4 Hz pitch ring after its stops measures 9.9 deg/s
    // in 2 of its 70 analysis windows — above the attention level while it was
    // there — so "a positive measurement of absence" is false of it. It is
    // reported as not ruled out instead, and holds nothing back on its own.
    assert.equal(result.gates.airframe.status, 'permitted', `${result.gates.airframe.codes}`);
    assert.ok(!found.AIRFRAME_CLEAR, 'a tone above the level in part is not an all-clear');
    const inPart = found.AIRFRAME_TONE_ABOVE_LEVEL_IN_PART;
    assert.ok(inPart, 'expected the tone above the level in part, got '
      + result.findings.map(entry => entry.id).join(', '));
    assert.match(inPart.headline, /25\.4 Hz/, inPart.headline);
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
    // UPDATED in Stage 2d. This pinned the tone as "sub-threshold", and that pin
    // was item 1's bug: the ring after each release measures 8.6 deg/s in 8 of the
    // 72 analysis windows, so it was above the level while it was there, and the
    // card below listed it "below the attention level" under "quiet enough". It
    // is a tone above the level for part of the range now — its AVERAGE is still
    // under the level, which is the case that was lost.
    const matched = gate.tonesAboveLevelInPart.filter(tone => tone.rotor === 'main');
    assert.ok(matched.length > 0,
      'a rotor-matched tone above the level for part of the range must be present: '
      + JSON.stringify(gate.tonesAboveLevelInPart));
    assert.ok(matched.every(tone => tone.bandRmsDps < gate.attentionThresholdDps
      && tone.aboveLevelBandRmsDps >= gate.attentionThresholdDps),
    'and it must average BELOW the attention level while reaching it — that is the case that was lost');
    assert.ok(!gate.subThresholdTones.some(tone => tone.rotor === 'main'),
      'a tone that reached the level is never also listed below it');

    const result = recommendFor(onOrder, 'yaw', mechanical);
    const ids = result.findings.map(entry => entry.id);

    // 1. The airframe rung must stop claiming absence.
    assert.ok(!ids.includes('AIRFRAME_CLEAR'),
      '"a positive measurement of absence" is false when a tone was measured');
    assert.ok(!ids.includes('AIRFRAME_TONE_BELOW_ATTENTION'),
      `"quiet enough" is false of a tone above the level while it was there: ${ids.join(', ')}`);
    const airframe = result.findings.find(entry => entry.id === 'AIRFRAME_TONE_ABOVE_LEVEL_IN_PART');
    assert.ok(airframe, `expected the tone observation, got ${ids.join(', ')}`);
    assert.equal(airframe.kind, 'next-flight', 'a tone not ruled out is not a blocker, nor clear');
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
    // Stage 2d: the loop's ring reaches the level in some windows, so it is a
    // tone above the level for part of the range rather than a sub-threshold one
    // (see above); either way it is a tone the control must carry.
    const offTones = [...offGate.subThresholdTones, ...offGate.tonesAboveLevelInPart];
    assert.equal(offGate.status, 'permitted', `${offGate.codes}`);
    assert.ok(offTones.length > 0,
      'the control must ALSO carry a tone — the loop makes one — '
      + 'or it is not testing the discriminator');
    assert.ok(offTones.every(tone => tone.rotor === null),
      'and none of it may match a rotor order: ' + JSON.stringify(offTones));
    assert.ok(recommendFor(offOrder, 'yaw', offMech).withheld
      .some(entry => entry.findingId === 'D_TOO_HIGH'),
    'the same fault off the rotor order must still be diagnosed, then stability-gated');
  });

/* =========================================================================== */
/* 8c. WHAT THE VIBRATION CHECK MEASURED, SAID AS WHAT IT MEASURED             */
/*                                                                             */
/* Audit of 2 October 2026. A 40 Hz log, or one with logging dropouts, could   */
/* not be measured at all — and the pilot was told "could not be read" AND, on */
/* the next card, that his helicopter was shaking. A head speed that was never */
/* read was blamed for moving. And the 8 deg/s threshold, calibrated only on   */
/* synthetic signals, refused every gain on 32 of 33 real flights because of   */
/* the main rotor's own once- and twice-per-rev (owner decision, same day).    */
/* =========================================================================== */

/** Every word a finding puts in front of a pilot, basis included. */
function findingText(finding) {
  return [finding.headline, finding.reasoning, finding.confirm ?? '',
    ...finding.basis.map(entry => `${entry.label} ${entry.value} ${entry.source ?? ''}`)]
    .join(' ');
}

const adjustmentIds = result =>
  result.findings.filter(entry => entry.kind === 'adjustment').map(entry => entry.id);

/**
 * The four numbers a rotor-order card's headline states, or null when it does
 * not state all four: the tone's size while above the level, that size over
 * the level, the share of the range (or of its stretch) it was above it for,
 * and its average over all of it.
 */
function rotorToneHeadline(headline) {
  const said = new RegExp('measured (?:at least )?([\\d.]+) deg/s on (?:roll|pitch|yaw)(?: at \\d+ rpm)? while it '
    + 'was above (?:an|the) experimental 8 deg/s level[,—\\s]+([\\d.]+) times that level\\b.*?'
    + 'for (\\d+)% of (?:the range|the stretch it was (?:worst|measured) in), and averaged '
    + '([\\d.]+) deg/s')
    .exec(headline);
  return said
    ? {size: Number(said[1]), ratio: Number(said[2]), share: Number(said[3]), average: Number(said[4])}
    : null;
}

/** The same flight's gyro, thinned to 40 Hz or punched with logging dropouts. */
function degradedSeries(records, kind) {
  const keep = kind === 'low-rate'
    ? (record, index) => index % 25 === 0
    // Keep 15 samples, drop 10: an 11 ms hole every 25 ms.
    : (record, index) => index % 25 < 15;
  return seriesOf(records.filter(keep));
}

const wholeRangeOf = series => ({
  timeRangeUs: {startTimeUs: series.timeUs[0], endTimeUs: series.timeUs.at(-1)}
});

test('an unmeasured vibration check says why, and never says the helicopter is shaking',
  async () => {
    const records = buildStopFlight({axis: 'yaw', ...STOP_FAULTS.tooMuchD});
    for (const [kind, reason, says] of [
      ['low-rate', 'SAMPLE_RATE_UNAVAILABLE', /sample rate/i],
      ['gaps', 'TIMING_GAPS_EXCESSIVE', /\bgaps?\b/i]
    ]) {
      const series = degradedSeries(records, kind);
      const mechanical = await analyzeMechanicalTimeSeries(series, wholeRangeOf(series));
      assert.equal(mechanical.status, 'insufficient',
        `${kind}: the fixture must be unmeasurable, got ${mechanical.status}`);
      assert.ok(mechanical.reasonCodes.includes(reason),
        `${kind}: expected ${reason}, got ${mechanical.reasonCodes}`);

      const result = recommendFor(records, 'yaw', mechanical);
      const ids = result.findings.map(entry => entry.id);

      assert.ok(!ids.includes('AIRFRAME_VIBRATION_PRESENT'),
        `${kind}: nothing was measured, so "vibration present" is false: ${ids.join(', ')}`);

      const missing = result.findings.find(entry => entry.id === 'AIRFRAME_BROADBAND_NOT_MEASURED');
      assert.ok(missing, `${kind}: expected the not-measured blocker, got ${ids.join(', ')}`);
      assert.equal(missing.kind, 'blocker');
      assert.ok(missing.basis.some(entry => String(entry.value).includes(reason)),
        `${kind}: the basis must name why: `
        + JSON.stringify(missing.basis.map(entry => [entry.label, entry.value])));
      assert.match(missing.headline, says, `${kind}: the headline must say why: ${missing.headline}`);

      // The head speed in this fixture is rock steady, and nothing was measured.
      for (const finding of result.findings.filter(entry => entry.rung === 'airframe')) {
        const text = findingText(finding);
        assert.doesNotMatch(text, /shaking|shows vibration|vibration (?:is )?present/i,
          `${kind}: ${finding.id} claims vibration nobody measured: ${text.slice(0, 300)}`);
        assert.doesNotMatch(text, /moved too much|spool-up is inside/i,
          `${kind}: ${finding.id} blames a head speed that never moved: ${text.slice(0, 300)}`);
      }
      const rotor = result.findings.find(entry => entry.id === 'AIRFRAME_ROTOR_NOT_COMPARED');
      if (rotor) {
        assert.match(`${rotor.headline} ${rotor.reasoning}`, /could not measure|never got as far/i,
          `${kind}: the rotor was not compared because nothing was measured: ${rotor.reasoning}`);
      }

      // And it still blocks: unmeasured is not clear.
      assert.equal(result.gates.airframe.status, 'blocked');
      assert.deepEqual(adjustmentIds(result), []);
    }
  });

test('the rotor-not-compared finding names the reason the rotor was not compared',
  async () => {
    const records = buildStopFlight({axis: 'yaw', ...STOP_FAULTS.tooMuchD});
    const count = records.length;
    const cases = [
      {name: 'no head-speed column', reason: 'FIELD_MISSING',
        headspeed: () => Number.NaN, says: /does not record head speed/i, never: /moved/i},
      {name: 'a rotor that was not turning', reason: 'NO_VALID_RPM_IN_RANGE',
        headspeed: () => 0, says: /no usable rotor speed/i, never: /moved/i},
      // 1500 -> 2400 rpm across the flight: a spread of about 0.41 against 0.12.
      {name: 'a head speed that really moved', reason: 'RPM_UNSTABLE_IN_SELECTION',
        headspeed: index => 1500 + (900 * index) / (count - 1), says: /moved/i, never: null}
    ];

    for (const {name, reason, headspeed, says, never} of cases) {
      const series = {
        ...seriesOf(records),
        headspeedRpm: Float64Array.from(records.map((record, index) => headspeed(index)))
      };
      const mechanical = await analyzeMechanicalTimeSeries(series, wholeRangeOf(series));
      assert.equal(mechanical.rpmEvidence.headspeed.reasonCode, reason,
        `${name}: the fixture must produce ${reason}`);
      assert.notEqual(mechanical.harmonicCorrelation.state, 'evaluated');

      const result = recommendFor(records, 'yaw', mechanical);
      const rotor = result.findings.find(entry => entry.id === 'AIRFRAME_ROTOR_NOT_COMPARED');
      assert.ok(rotor, `${name}: expected the rotor-not-compared blocker`);
      assert.ok(rotor.codes.includes(reason), `${name}: codes ${rotor.codes}`);
      const words = `${rotor.headline} ${rotor.reasoning} ${rotor.confirm}`;
      assert.match(words, says, `${name}: ${words}`);
      if (never) {
        assert.doesNotMatch(words, never, `${name} must not be blamed on movement: ${words}`);
      }
    }
  });

test('a main-rotor once- or twice-per-rev above the experimental level is reported as a '
  + 'measurement, and the gains are still read', async () => {
  for (const [order, frequencyHz, named] of [[1, 30, /once-per-rev/], [2, 60, /twice-per-rev/]]) {
    const records = buildStopFlight({
      axis: 'yaw', ...STOP_FAULTS.tooMuchD, vibration: {frequencyHz, amplitudeDps: 20}
    });
    const mechanical = await analyzeMechanicalTimeSeries(
      seriesOf(records), wholeRangeOf(seriesOf(records)));

    // The fixture must be exactly the case the owner decided: attention, and every
    // attention-level peak on main-rotor order 1 or 2, on all three axes.
    assert.equal(mechanical.status, 'attention', `order ${order}: ${mechanical.reasonCodes}`);
    const attention = mechanical.axes.flatMap(axis =>
      axis.peaks.filter(peak => peak.attentionEligible));
    assert.ok(attention.length >= 3, `order ${order}: ${attention.length} attention peaks`);
    assert.ok(attention.every(peak =>
      peak.harmonicMatch?.rotor === 'main' && peak.harmonicMatch.order === order),
    `order ${order}: ${JSON.stringify(attention.map(peak => peak.harmonicMatch))}`);

    const result = recommendFor(records, 'yaw', mechanical);
    const ids = result.findings.map(entry => entry.id);
    assert.equal(result.gates.airframe.status, 'permitted',
      `order ${order}: blocked by ${result.gates.airframe.codes.join(', ')}`);
    assert.ok(!ids.includes('AIRFRAME_VIBRATION_PRESENT'), `order ${order}: ${ids}`);
    assert.ok(!ids.includes('AIRFRAME_CLEAR'),
      `order ${order}: a tone above the threshold is not "a positive measurement of absence"`);

    const tone = result.findings.find(entry => entry.id === 'AIRFRAME_ROTOR_ORDER_TONE');
    assert.ok(tone, `order ${order}: expected the rotor-order observation, got ${ids}`);
    assert.equal(tone.rung, 'airframe');
    assert.equal(tone.kind, 'observation', 'never a blocker');
    assert.equal(tone.confidence, 'low');
    assert.equal(tone.actNow, false, 'never START HERE');
    assert.equal(tone.direction, null);
    assert.match(tone.headline, named, `order ${order}: ${tone.headline}`);
    // The size and how far past the level it is, as numbers — never "a little
    // above", which the tone's own value contradicts as it grows.
    // Round 3: the size is the tone's size WHILE PRESENT, beside the share of the
    // range it was present for and its flight average — the three numbers that
    // together say how big it is; for a tone present throughout the first and
    // last agree.
    const loudest = attention.reduce((best, peak) =>
      (peak.attentionWindowBandRmsDps > best.attentionWindowBandRmsDps ? peak : best));
    const strongest = loudest.attentionWindowBandRmsDps;
    const said = rotorToneHeadline(tone.headline);
    assert.ok(said, `order ${order}: the headline must state the value and the ratio: `
      + tone.headline);
    assert.equal(said.size, Math.round(strongest * 10) / 10, tone.headline);
    assert.equal(said.ratio, Math.round((strongest / 8) * 10) / 10, tone.headline);
    assert.equal(said.share, Math.round(loudest.attentionPersistenceRatio * 100), tone.headline);
    assert.equal(said.average, Math.round(loudest.bandRmsDps * 10) / 10, tone.headline);
    assert.doesNotMatch(findingText(tone), /a little|slightly|just above/i);
    // Measurement, with its basis: axis, order, size, head speed, and the threshold.
    assert.ok(tone.basis.some(entry => /roll|pitch|yaw/.test(entry.label)
      && entry.unit === 'deg/s' && entry.value >= 8),
    JSON.stringify(tone.basis.map(entry => [entry.label, entry.value, entry.unit])));
    assert.ok(tone.basis.some(entry => entry.unit === 'rpm' && Math.abs(entry.value - 1800) < 30),
      'the head speed the tone was matched against');
    assert.ok(tone.basis.some(entry => /threshold/.test(entry.label) && entry.value === 8));
    assert.match(tone.reasoning, /experimental/i);
    assert.match(tone.reasoning, /not (?:yet )?been validated|not yet validated/i);
    // Stage 2d follow-up, item 5: the tolerance the identity rule applied is the
    // head speed's own spread PLUS half an analysis bin, as the basis row says —
    // the reasoning used to name the spread alone.
    assert.match(tone.reasoning, /within the head speed's own spread at that order plus half an analysis bin/,
      tone.reasoning);
    assert.ok(tone.basis.some(entry => /plus half an analysis bin/.test(entry.source ?? '')),
      JSON.stringify(tone.basis.map(entry => entry.source)));
    assert.match(tone.confirm, /tracking/i);
    assert.match(tone.confirm, /balance/i);
    assert.match(tone.confirm, /drops/i);

    // The gains are still read. The 36 Hz D fault is diagnosed and held back by
    // the stability gate alone, exactly as it is on a quiet airframe.
    const withheld = result.withheld.find(entry => entry.findingId === 'D_TOO_HIGH');
    assert.ok(withheld, `order ${order}: the D diagnosis must still be reached`);
    assert.equal(withheld.gateStatus.airframe, 'permitted',
      `order ${order}: ${JSON.stringify(withheld.gateStatus)}`);
  }
});

test('vibration the main rotor\'s 1/rev and 2/rev do not explain still blocks every gain',
  async () => {
    const cases = [
      ['main-rotor order 3', {frequencyHz: 90, amplitudeDps: 20}, series => series,
        'NOT_EXPLAINED_BY_MAIN_ROTOR_ORDER'],
      ['a tone on the tail rotor', {frequencyHz: 71, amplitudeDps: 26},
        series => ({...series, tailspeedRpm: new Float64Array(series.timeUs.length).fill(4260)}),
        'NOT_EXPLAINED_BY_MAIN_ROTOR_ORDER'],
      // Never compared: "the rotor does not explain it" would be a claim nobody
      // measured, and must not be made.
      ['a once-per-rev nothing was compared against', {frequencyHz: 30, amplitudeDps: 20},
        series => ({...series, headspeedRpm: new Float64Array(series.timeUs.length).fill(Number.NaN)}),
        'VIBRATION_NOT_COMPARED_WITH_ROTOR']
    ];
    for (const [name, vibration, adapt, cause] of cases) {
      const records = buildStopFlight({axis: 'yaw', ...STOP_FAULTS.tooMuchD, vibration});
      const series = adapt(seriesOf(records));
      const mechanical = await analyzeMechanicalTimeSeries(series, wholeRangeOf(series));
      assert.equal(mechanical.status, 'attention', `${name}: ${mechanical.reasonCodes}`);

      const result = recommendFor(records, 'yaw', mechanical);
      const ids = result.findings.map(entry => entry.id);
      assert.equal(result.gates.airframe.status, 'blocked', `${name} must still block`);
      assert.ok(ids.includes('AIRFRAME_VIBRATION_PRESENT'), `${name}: ${ids}`);
      assert.ok(!ids.includes('AIRFRAME_ROTOR_ORDER_TONE'), `${name}: ${ids}`);
      assert.deepEqual(adjustmentIds(result), []);
      const vibrationFinding = result.findings.find(entry => entry.id === 'AIRFRAME_VIBRATION_PRESENT');
      assert.ok(vibrationFinding.basis.some(entry => /above the attention level/.test(entry.label)),
        `${name}: the tone that blocked must be in the basis`);
      assert.ok(vibrationFinding.codes.includes(cause), `${name}: ${vibrationFinding.codes}`);
      if (cause === 'VIBRATION_NOT_COMPARED_WITH_ROTOR') {
        assert.doesNotMatch(`${vibrationFinding.headline} ${vibrationFinding.reasoning}`,
          /do not explain|matches no rotor order/,
          `${name}: nothing was compared, so nothing may be ruled out`);
      }
    }

    // Broadband is held separately, and a rotor-order-only spectrum does not
    // excuse a raised floor. (The tone's size while present travels with it: the
    // rotor-order rule refuses a tone without one. Since Stage 2d so do the head
    // speed's spread at that order and the resolution, which identity is judged
    // from.)
    const peaks = [{frequencyHz: 29.3, bandRmsDps: 13.8, attentionWindowBandRmsDps: 13.8,
      attentionPersistenceRatio: 1, bandwidthHz: 2, persistenceRatio: 1,
      attentionEligible: true,
      harmonicMatch: {rotor: 'main', order: 1, predictedHz: 30, deltaHz: 0.7, toleranceHz: 2.9,
        spreadHz: 0.45, frequencyResolutionHz: 1.953}}];
    const noisyRotorOnly = assessAirframe(cleanAirframe({
      status: 'attention',
      reasonCodes: ['PERSISTENT_NARROWBAND_ENERGY', 'MAIN_ROTOR_HARMONIC_CORRELATION'],
      tuningEvidenceGate: {status: 'blocked',
        reasonCodes: ['PERSISTENT_NARROWBAND_ENERGY', 'MAIN_ROTOR_HARMONIC_CORRELATION']},
      axes: ['roll', 'pitch', 'yaw'].map(axis => ({
        axis, source: 'gyroRAW', available: true, attentionEligibleUnlistedCount: 0,
        medianNoisePsdDps2PerHz: 24, broadbandRmsDps: 109, peaks
      }))
    }));
    assert.equal(noisyRotorOnly.upstream.status, 'permitted',
      'the rotor-order rule must have applied, or this proves nothing about broadband');
    assert.equal(noisyRotorOnly.status, 'blocked');
    assert.ok(noisyRotorOnly.codes.includes('BROADBAND_ABOVE_ATTENTION_THRESHOLD'));
  });

test('a long flight whose rotor tone is clean but whose last stretch could not be measured '
  + 'is not waved through', async () => {
    // 300 s at Rotorflight's own 993 us interval, so it is measured in two
    // stretches. A main-rotor once-per-rev at 20 deg/s throughout; from 250 s the
    // logger keeps one sample in six. The first stretch alone would pass the
    // rotor-order rule. The flight must not, because a sixth of it was never
    // measured — and it must say so as that, not as an unexplained tone.
    const rateHz = 1007;
    const random = rng(77);
    const timeUs = [];
    const gyro = [];
    const head = [];
    for (let index = 0; index < rateHz * 300; index += 1) {
      const stamp = Math.round((index * 1e6) / rateHz);
      if (stamp >= 250e6 && index % 6 !== 0) {
        continue;
      }
      timeUs.push(stamp);
      gyro.push(20 * Math.sin(2 * Math.PI * 30 * stamp / 1e6) + (random() - 0.5));
      head.push(1800 + (random() - 0.5) * 8);
    }
    const values = Float64Array.from(gyro);
    const series = {
      timeUs: Float64Array.from(timeUs),
      gyro: {roll: values, pitch: values, yaw: values},
      gyroSources: {roll: 'gyroRAW', pitch: 'gyroRAW', yaw: 'gyroRAW'},
      headspeedRpm: Float64Array.from(head),
      tailspeedRpm: new Float64Array(timeUs.length).fill(Number.NaN)
    };
    const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
    assert.deepEqual(mechanical.chunks.map(chunk => chunk.status), ['attention', 'insufficient'],
      'the fixture must put a measured rotor tone in one stretch and a gap in the other');
    assert.equal(mechanical.status, 'attention');

    const result = buildRecommendations({mechanical});
    const ids = result.findings.map(entry => entry.id);
    assert.equal(result.gates.airframe.status, 'blocked');
    assert.ok(!ids.includes('AIRFRAME_ROTOR_ORDER_TONE'), `${ids}`);

    const vibration = result.findings.find(entry => entry.id === 'AIRFRAME_VIBRATION_PRESENT');
    assert.ok(vibration, `${ids}`);
    assert.ok(vibration.codes.includes('ROTOR_ORDER_NOT_ESTABLISHED'), `${vibration.codes}`);
    assert.match(vibration.headline, /could not establish/);
    assert.doesNotMatch(vibration.headline, /do not explain/,
      'every tone measured here IS the rotor; what is missing is the rest of the flight');

    const missing = result.findings.find(entry => entry.id === 'AIRFRAME_BROADBAND_NOT_MEASURED');
    assert.ok(missing, `${ids}`);
    assert.match(missing.headline, /part of this range/);
    assert.match(missing.headline, /\bgaps\b/);
    // The cue the plain copy reads, so it can say "part of" as well.
    assert.ok(missing.codes.includes('VIBRATION_PARTLY_MEASURED'), `${missing.codes}`);

    // Why "only the rotor" was not established is the stretch that was not
    // measured, and the card says that rather than listing every possibility.
    assert.match(vibration.reasoning, /part of the range could not be measured/,
      vibration.reasoning);
    assert.doesNotMatch(vibration.reasoning, /unfiltered/, vibration.reasoning);

    // The rotor WAS compared over the stretch that was measured — its tone is
    // named as the once-per-rev on the card beside this one — so "never
    // compared" and "could not measure this range" are both false.
    const rotor = result.findings.find(entry => entry.id === 'AIRFRAME_ROTOR_NOT_COMPARED');
    assert.ok(rotor, `${ids}`);
    assert.ok(rotor.codes.includes('ROTOR_CORRELATION_PARTIAL'), `${rotor.codes}`);
    assert.match(rotor.headline, /\bpart of\b/, rotor.headline);
    assert.doesNotMatch(findingText(rotor), /never compared|could not measure this range|never got as far/,
      findingText(rotor));
  });

test('an unmatched tone compared in one stretch is not called uncompared because another '
  + 'stretch\'s head speed moved', async () => {
    // 300 s, so two stretches. In the first the head holds 1800 rpm and roll
    // carries 71 Hz at 26 deg/s — no order of that head. In the second the head
    // ramps 1500 to 2200 rpm, too far to compare against. The 71 Hz tone WAS
    // compared, in the stretch it was measured in, and matched nothing.
    const rateHz = 1007;
    const random = rng(91);
    const count = rateHz * 300;
    const timeUs = new Float64Array(count);
    const roll = new Float64Array(count);
    const quiet = new Float64Array(count);
    const head = new Float64Array(count);
    for (let index = 0; index < count; index += 1) {
      const stamp = Math.round((index * 1e6) / rateHz);
      const at = stamp / 1e6;
      timeUs[index] = stamp;
      roll[index] = (at < 140 ? 26 * Math.sin(2 * Math.PI * 71 * at) : 0) + (random() - 0.5);
      quiet[index] = random() - 0.5;
      head[index] = at < 150 ? 1800 + (random() - 0.5) * 8 : 1500 + 700 * (at - 150) / 150;
    }
    const series = {
      timeUs, gyro: {roll, pitch: quiet, yaw: quiet},
      gyroSources: {roll: 'gyroRAW', pitch: 'gyroRAW', yaw: 'gyroRAW'},
      headspeedRpm: head, tailspeedRpm: new Float64Array(count).fill(Number.NaN)
    };
    const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
    assert.deepEqual(mechanical.chunks.map(chunk => chunk.harmonicCorrelationState),
      ['evaluated', 'unavailable'], 'the fixture must compare one stretch and not the other');
    assert.equal(mechanical.status, 'attention');

    const result = buildRecommendations({mechanical});
    const vibration = result.findings.find(entry => entry.id === 'AIRFRAME_VIBRATION_PRESENT');
    assert.ok(vibration, `${result.findings.map(entry => entry.id)}`);
    assert.ok(vibration.codes.includes('NOT_EXPLAINED_BY_MAIN_ROTOR_ORDER'), `${vibration.codes}`);
    assert.match(vibration.reasoning, /matches no rotor order/, vibration.reasoning);
    assert.doesNotMatch(findingText(vibration), /could not be compared against the rotor/,
      findingText(vibration));
    const rotor = result.findings.find(entry => entry.id === 'AIRFRAME_ROTOR_NOT_COMPARED');
    assert.ok(rotor.codes.includes('ROTOR_CORRELATION_PARTIAL'), `${rotor.codes}`);
    assert.match(rotor.headline, /\bpart of\b/, rotor.headline);
    assert.match(findingText(rotor), /moved too much/, 'the rest is said for what it was');
    assert.deepEqual(adjustmentIds(result), []);
  });

test('a once-per-rev measured in two stretches is reported once, at its worst, with its stretch',
  async () => {
    // 300 s at 1007 Hz: two stretches, the same 30 Hz once-per-rev in both.
    const rateHz = 1007;
    const random = rng(23);
    const count = rateHz * 300;
    const timeUs = new Float64Array(count);
    const roll = new Float64Array(count);
    const quiet = new Float64Array(count);
    const head = new Float64Array(count);
    for (let index = 0; index < count; index += 1) {
      const stamp = Math.round((index * 1e6) / rateHz);
      timeUs[index] = stamp;
      roll[index] = 20 * Math.sin(2 * Math.PI * 30 * stamp / 1e6) + (random() - 0.5);
      quiet[index] = random() - 0.5;
      head[index] = 1800 + (random() - 0.5) * 8;
    }
    const mechanical = await analyzeMechanicalWindow({
      timeUs, gyro: {roll, pitch: quiet, yaw: quiet},
      gyroSources: {roll: 'gyroRAW', pitch: 'gyroRAW', yaw: 'gyroRAW'},
      headspeedRpm: head, tailspeedRpm: new Float64Array(count).fill(Number.NaN)
    }, {timeRangeUs: {startTimeUs: timeUs[0], endTimeUs: timeUs[count - 1]}});
    assert.equal(mechanical.chunks.length, 2);

    const result = buildRecommendations({mechanical});
    const tone = result.findings.find(entry => entry.id === 'AIRFRAME_ROTOR_ORDER_TONE');
    assert.ok(tone, `${result.findings.map(entry => entry.id)}`);
    assert.doesNotMatch(tone.headline, /more main-rotor tone/,
      `one tone measured twice is not two tones: ${tone.headline}`);
    const rows = tone.basis.filter(entry => /^roll: main rotor once-per-rev/.test(entry.label));
    assert.equal(rows.length, 1, JSON.stringify(tone.basis.map(entry => entry.label)));
    // The row states the tone's size while above the level (round 3: the size the
    // ceiling is judged on), and the worst stretch's speaks for it.
    const worst = Math.max(...mechanical.axes.find(axis => axis.axis === 'roll').peaks
      .filter(peak => peak.attentionEligible).map(peak => peak.attentionWindowBandRmsDps));
    assert.equal(rows[0].value, Math.round(worst * 1000) / 1000, 'the worst stretch speaks for it');
    assert.match(rows[0].label, /\d+.\d+ s/, `the stretch it was worst in is named: ${rows[0].label}`);
  });

test('a main-rotor tone past three times the attention level blocks every gain, said as its size',
  async () => {
    for (const [order, frequencyHz, named] of [[1, 30, /once-per-rev/], [2, 60, /twice-per-rev/]]) {
      const records = buildStopFlight({
        axis: 'yaw', ...STOP_FAULTS.tooMuchD, vibration: {frequencyHz, amplitudeDps: 60}
      });
      const mechanical = await analyzeMechanicalWindow(seriesOf(records), wholeRangeOf(seriesOf(records)));
      const attention = mechanical.axes.flatMap(axis =>
        axis.peaks.filter(peak => peak.attentionEligible));
      assert.ok(attention.every(peak =>
        peak.harmonicMatch?.rotor === 'main' && peak.harmonicMatch.order === order),
      `order ${order}: the fixture must be rotor-order only`);
      const loudest = attention.reduce((best, peak) =>
        (peak.attentionWindowBandRmsDps > best.attentionWindowBandRmsDps ? peak : best));
      const strongest = loudest.attentionWindowBandRmsDps;
      assert.ok(strongest > 24, `order ${order}: the fixture must cross the ceiling (${strongest})`);

      const result = recommendFor(records, 'yaw', mechanical);
      const ids = result.findings.map(entry => entry.id);
      assert.equal(result.gates.airframe.status, 'blocked', `order ${order}`);
      assert.ok(!ids.includes('AIRFRAME_ROTOR_ORDER_TONE'), `order ${order}: ${ids}`);
      assert.ok(!ids.includes('AIRFRAME_VIBRATION_PRESENT'),
        `order ${order}: this is the rotor's own tone, measured and matched, not "unexplained"`);
      assert.deepEqual(adjustmentIds(result), []);

      const large = result.findings.find(entry => entry.id === 'AIRFRAME_ROTOR_ORDER_TONE_LARGE');
      assert.ok(large, `order ${order}: ${ids}`);
      assert.equal(large.kind, 'blocker');
      assert.equal(large.adjust, 'airframe');
      assert.ok(large.codes.includes('MAIN_ROTOR_ORDER_TONE_LARGE'), `${large.codes}`);
      assert.match(large.headline, named, large.headline);
      const said = rotorToneHeadline(large.headline);
      assert.ok(said, `the size and the ratio, as numbers: ${large.headline}`);
      assert.equal(said.size, Math.round(strongest * 10) / 10, large.headline);
      assert.equal(said.ratio, Math.round((strongest / 8) * 10) / 10, large.headline);
      assert.equal(said.share, Math.round(loudest.attentionPersistenceRatio * 100), large.headline);
      assert.equal(said.average, Math.round(loudest.bandRmsDps * 10) / 10, large.headline);
      assert.match(large.confirm, /tracking/i);
      assert.match(large.confirm, /balance/i);
      assert.ok(large.basis.some(entry => /ceiling/.test(entry.label) && entry.value === 24),
        JSON.stringify(large.basis.map(entry => [entry.label, entry.value])));
      // Mechanical faults outrank gains: this is where a pilot starts.
      assert.equal(result.findings.find(entry => entry.actNow)?.id,
        'AIRFRAME_ROTOR_ORDER_TONE_LARGE', `order ${order}`);
      const withheld = result.withheld.find(entry => entry.findingId === 'D_TOO_HIGH');
      if (withheld) {
        assert.equal(withheld.gateStatus.airframe, 'blocked', JSON.stringify(withheld.gateStatus));
      }
    }
  });

test('a rotor-order tone beside another airframe blocker never says the rest of the advice is '
  + 'unaffected', () => {
    const peaks = [{frequencyHz: 29.3, bandRmsDps: 13.8, attentionWindowBandRmsDps: 13.8,
      attentionPersistenceRatio: 1, bandwidthHz: 2, persistenceRatio: 1,
      attentionEligible: true,
      harmonicMatch: {rotor: 'main', order: 1, predictedHz: 30, deltaHz: 0.7, toleranceHz: 2.9,
        spreadHz: 0.45, frequencyResolutionHz: 1.953}}];
    const rotorOnly = overrides => cleanAirframe({
      status: 'attention',
      reasonCodes: ['PERSISTENT_NARROWBAND_ENERGY', 'MAIN_ROTOR_HARMONIC_CORRELATION'],
      tuningEvidenceGate: {status: 'blocked',
        reasonCodes: ['PERSISTENT_NARROWBAND_ENERGY', 'MAIN_ROTOR_HARMONIC_CORRELATION']},
      axes: ['roll', 'pitch', 'yaw'].map(axis => ({
        axis, source: 'gyroRAW', available: true, attentionEligibleUnlistedCount: 0,
        medianNoisePsdDps2PerHz: 0.0002, broadbandRmsDps: 12, peaks
      })),
      ...overrides
    });
    const records = buildStopFlight({axis: 'yaw', ...STOP_FAULTS.tooMuchD});
    const cases = [
      ['a raised broadband floor', rotorOnly({axes: ['roll', 'pitch', 'yaw'].map(axis => ({
        axis, source: 'gyroRAW', available: true, attentionEligibleUnlistedCount: 0,
        medianNoisePsdDps2PerHz: 24, broadbandRmsDps: 109, peaks
      }))}), 'BROADBAND_ABOVE_ATTENTION_THRESHOLD'],
      ['a vibration check over other seconds',
        rotorOnly({range: {startTimeUs: 0, endTimeUs: 1_000}}), 'MECHANICAL_RANGE_EXCLUDES_EVENTS']
    ];
    // The control: on its own, the tone is reported and the rung passes.
    const alone = recommendFor(records, 'yaw', rotorOnly({}));
    assert.equal(alone.gates.airframe.status, 'permitted', `${alone.gates.airframe.codes}`);
    assert.ok(alone.findings.some(entry => entry.id === 'AIRFRAME_ROTOR_ORDER_TONE'));

    for (const [name, mechanical, code] of cases) {
      const result = recommendFor(records, 'yaw', mechanical);
      assert.equal(result.gates.airframe.status, 'blocked', name);
      assert.ok(result.gates.airframe.codes.includes(code), `${name}: ${result.gates.airframe.codes}`);
      assert.equal(result.gates.airframe.upstream.measured.rotorOrderTonesOnly, true,
        `${name}: the rotor-order rule itself must have applied, or this proves nothing`);
      const ids = result.findings.map(entry => entry.id);
      assert.ok(!ids.includes('AIRFRAME_ROTOR_ORDER_TONE'),
        `${name}: the card that says the tone does not hold the advice back must not show: ${ids}`);
      const airframe = result.findings.filter(entry => entry.rung === 'airframe');
      for (const finding of airframe) {
        assert.doesNotMatch(findingText(finding),
          /(?:does not|doesn't) (?:stop|hold back)|rather than holding back|not holding back/i,
          `${name}: ${finding.id} says the rest is unaffected`);
      }
      // The measurement is still on screen, in the basis of what does block.
      assert.ok(airframe.some(finding => finding.basis.some(entry =>
        /main rotor once-per-rev/.test(entry.label) && entry.value === 13.8)),
      `${name}: the measured tone vanished: ${JSON.stringify(airframe.map(finding =>
        finding.basis.map(entry => entry.label)))}`);
    }
  });

test('an attention-level rotor tone reaches the coincidence rule whatever its persistence',
  () => {
    // The persistence floor keeps a fleeting sub-threshold bump out of a
    // sentence. An attention-level peak is sustained by construction, and now
    // that a main-rotor one no longer blocks the airframe rung, the coincidence
    // rule is the only thing between it and a gain change — so it must see it.
    const peak = {frequencyHz: 30, bandRmsDps: 11, attentionWindowBandRmsDps: 13.9,
      attentionPersistenceRatio: 0.3, bandwidthHz: 2, persistenceRatio: 0.3,
      attentionEligible: true,
      harmonicMatch: {rotor: 'main', order: 1, predictedHz: 30, deltaHz: 0, toleranceHz: 3,
        spreadHz: 0.45, frequencyResolutionHz: 1.953}};
    const gate = assessAirframe(cleanAirframe({
      status: 'attention',
      reasonCodes: ['PERSISTENT_NARROWBAND_ENERGY', 'MAIN_ROTOR_HARMONIC_CORRELATION'],
      tuningEvidenceGate: {status: 'blocked',
        reasonCodes: ['PERSISTENT_NARROWBAND_ENERGY', 'MAIN_ROTOR_HARMONIC_CORRELATION']},
      axes: ['roll', 'pitch', 'yaw'].map(axis => ({
        axis, source: 'gyroRAW', available: true, attentionEligibleUnlistedCount: 0,
        medianNoisePsdDps2PerHz: 0.0002, broadbandRmsDps: 12, peaks: [peak]
      }))
    }));
    assert.equal(gate.status, 'permitted', `${gate.codes}`);
    assert.ok(peak.persistenceRatio < TONE_LIMITS.persistenceRatioFloor,
      'the peak must sit under the persistence floor, or this proves nothing');
    const yaw = gate.axes.find(entry => entry.axis === 'yaw');
    assert.ok(coincidentTone(yaw.tones, 30),
      'a once-per-rev above the attention level was hidden from the coincidence rule');
  });

test('a D ring sitting on a main-rotor tone above the experimental level is still refused',
  async () => {
    // The tone-coincidence rule used to be reachable only below the threshold,
    // because anything above it blocked the whole airframe rung. Now that a
    // rotor-order tone above it does not, the coincidence rule is what stands
    // between a pilot and "lower D" at a blade that is out of track.
    const records = buildStopFlight({
      axis: 'yaw', ...STOP_FAULTS.tooMuchD, frequencyHz: 30,
      vibration: {frequencyHz: 30, amplitudeDps: 20}
    });
    const mechanical = await analyzeMechanicalTimeSeries(
      seriesOf(records), wholeRangeOf(seriesOf(records)));
    assert.equal(mechanical.status, 'attention');
    assert.ok(mechanical.axes.flatMap(axis => axis.peaks.filter(peak => peak.attentionEligible))
      .every(peak => peak.harmonicMatch?.rotor === 'main' && peak.harmonicMatch.order === 1));

    const result = recommendFor(records, 'yaw', mechanical);
    assert.equal(result.gates.airframe.status, 'permitted',
      'the airframe rung must let this through, or this says nothing about the coincidence rule');
    const ids = result.findings.map(entry => entry.id);
    const refused = result.findings.find(entry => entry.id === 'OSCILLATION_MATCHES_AIRFRAME_TONE');
    assert.ok(refused, `expected the coincidence refusal, got ${ids.join(', ')}`);
    assert.equal(refused.axis, 'yaw');
    assert.equal(refused.kind, 'next-flight');
    assert.equal(refused.direction, null);
    assert.doesNotMatch(refused.reasoning, /did not reach the level worth chasing/,
      'this tone is ABOVE the attention level and the refusal must not say otherwise');
    assert.deepEqual(adjustmentIds(result), []);
    assert.ok(!result.withheld.some(entry => entry.findingId === 'D_TOO_HIGH'),
      'a ring on a rotor order is refused, not diagnosed as D and merely held back');
  });

/* --------------------------------------------------------------------------- */
/* Round 3 of the airframe review of 2 October 2026.                           */
/* --------------------------------------------------------------------------- */

/**
 * Tones added to a flight's UNFILTERED gyro on all three axes — where the
 * vibration check looks, and where no filter chain has taken them out. A tone
 * may be present only until `untilS`, or for `onS` of every `periodS`.
 */
function withRawTones(records, tones) {
  return records.map(record => {
    const at = record.timeUs / 1e6;
    let added = 0;
    for (const tone of tones) {
      if (at <= (tone.untilS ?? Infinity) && (!tone.periodS || at % tone.periodS < tone.onS)) {
        added += tone.amp * Math.sin(2 * Math.PI * tone.hz * at + (tone.phase ?? 0));
      }
    }
    return {...record, raw: record.raw.map(value => value + added)};
  });
}

/** Every axis analysed from the same records and handed over together, as ui/app.mjs does. */
function recommendThreeAxes(records, mechanical) {
  const axes = {};
  const axisSummaries = {};
  for (const axis of ['roll', 'pitch', 'yaw']) {
    axes[axis] = {...analyseAxisEvidence(records, axis), records};
    axisSummaries[axis] = {gyroHighFrequencyRmsDps: 0.5};
  }
  return buildRecommendations({records, mechanical, axes, axisSummaries});
}

/**
 * A gyro window with no manoeuvres in it: `tones` on roll (on every axis with
 * `allAxes`, or on a tone's own `axes`), each present throughout, for `onS` of
 * every `periodS`, or wherever its `on(at)` says, over a head at `headspeed(at)`
 * rpm. From `thinFromS` on, one sample in six survives, which is a logger falling
 * behind.
 */
function gyroWindow({seconds, rateHz = 1000, tones, seed, headspeed = () => 1800,
  thinFromS = Infinity, allAxes = false}) {
  const random = rng(seed);
  const timeUs = [];
  const roll = [];
  // Pitch and yaw carry only tones given their own `axes`, over their own noise.
  const others = {pitch: [], yaw: []};
  const head = [];
  for (let index = 0; index < Math.round(rateHz * seconds); index += 1) {
    const stamp = Math.round((index * 1e6) / rateHz);
    const at = stamp / 1e6;
    if (at >= thinFromS && index % 6 !== 0) {
      continue;
    }
    const values = {roll: 0, pitch: 0, yaw: 0};
    for (const tone of tones) {
      if (tone.on ? tone.on(at) : (!tone.periodS || at % tone.periodS < tone.onS)) {
        const value = tone.amp * Math.sin(2 * Math.PI * tone.hz * at + (tone.phase ?? 0));
        for (const axis of tone.axes ?? ['roll']) {
          values[axis] += value;
        }
      }
    }
    timeUs.push(stamp);
    roll.push(values.roll + (random() - 0.5));
    const quiet = random() - 0.5;
    others.pitch.push(values.pitch + quiet);
    others.yaw.push(values.yaw + quiet);
    head.push(headspeed(at) + (random() - 0.5) * 4);
  }
  const rollSeries = Float64Array.from(roll);
  const other = axis => (allAxes ? rollSeries : Float64Array.from(others[axis]));
  return {
    timeUs: Float64Array.from(timeUs),
    gyro: {roll: rollSeries, pitch: other('pitch'), yaw: other('yaw')},
    gyroSources: {roll: 'gyroRAW', pitch: 'gyroRAW', yaw: 'gyroRAW'},
    headspeedRpm: Float64Array.from(head),
    tailspeedRpm: new Float64Array(timeUs.length).fill(Number.NaN)
  };
}

const tenths = value => Math.round(value * 10) / 10;
const isMainOrder = (peak, orders = [1, 2]) =>
  peak.harmonicMatch?.rotor === 'main' && orders.includes(peak.harmonicMatch.order);

test('an attention-level tone never pushes a small rotor order off the list, and a ring sitting on '
  + 'that order is still refused, in the app\'s three-axis shape', async () => {
    // Round-2 review: attention-level peaks were listed first and the rest were
    // capped at five MINUS their number, so a 1/rev present for most of the
    // flight cost the small 2/rev the list used to hold. The rotor-order rule
    // then passed the airframe, the 2/rev was gone from the only list the
    // tone-coincidence rule reads, and D was diagnosed on a ring sitting exactly
    // on a measured rotor order. 900 rpm: 1/rev 15 Hz, 2/rev 30 Hz; the D ring
    // is at 30 Hz, on the 2/rev; orders 3-6 are small and steady throughout.
    let configuration = 0;
    for (const ringAmplitudeDps of [10, 14]) {
      for (const twoRevDps of [1, 3]) {
        for (const harmonicDps of [6, 10]) {
          for (const untilShare of [0.6, 0.75]) {
            configuration += 1;
            const plain = buildStopFlight({axis: 'yaw', ...STOP_FAULTS.tooMuchD, ringAmplitudeDps,
              frequencyHz: 30, headspeedRpm: 900, seed: 4242 + configuration});
            const records = withRawTones(plain, [
              {hz: 15, amp: 20, untilS: (plain.at(-1).timeUs / 1e6) * untilShare},
              {hz: 30, amp: twoRevDps, phase: 0.3},
              ...[45, 60, 75, 90].map(hz => ({hz, amp: harmonicDps, phase: hz}))
            ]);
            const series = seriesOf(records);
            const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
            const yaw = mechanical.axes.find(axis => axis.axis === 'yaw');
            const label = `ring ${ringAmplitudeDps}, 2/rev ${twoRevDps}, orders 3-6 at `
              + `${harmonicDps}, 1/rev until ${untilShare}: yaw lists ${JSON.stringify(yaw.peaks.map(
                peak => [peak.frequencyHz, peak.attentionEligible, peak.harmonicMatch?.order ?? null]))}`;

            // The fixture is the case: an attention-level 1/rev, and nothing above
            // the level that is not a main-rotor 1/rev or 2/rev.
            assert.ok(yaw.peaks.some(peak => peak.attentionEligible && isMainOrder(peak, [1])), label);
            assert.ok(mechanical.axes.every(axis => axis.peaks
              .filter(peak => peak.attentionEligible).every(peak => isMainOrder(peak))), label);
            // The guarded property: the small 2/rev is still listed, and the small
            // tones are all listed — none paid for the attention-level one.
            assert.ok(yaw.peaks.some(peak => !peak.attentionEligible && isMainOrder(peak, [2])),
              `${label}: the small 2/rev was pushed off the list`);
            assert.equal(yaw.peaks.filter(peak => !peak.attentionEligible).length, 5, label);

            const result = recommendThreeAxes(records, mechanical);
            assert.equal(result.gates.airframe.status, 'permitted', `${label}: ${result.gates.airframe.codes}`);
            assert.equal(result.gates.airframe.upstream.measured.rotorOrderTonesOnly, true, label);
            const refused = result.findings.find(entry =>
              entry.id === 'OSCILLATION_MATCHES_AIRFRAME_TONE' && entry.axis === 'yaw');
            assert.ok(refused, `${label}: the ring on the 2/rev was not refused: `
              + `${result.findings.map(entry => entry.id)}`);
            assert.equal(refused.kind, 'next-flight');
            assert.deepEqual(adjustmentIds(result), [], label);
            assert.ok(!result.withheld.some(entry => entry.findingId === 'D_TOO_HIGH'),
              `${label}: D was diagnosed on a ring sitting on a measured rotor order`);
          }
        }
      }
    }

    // The same displacement for a small tone matching NO rotor order — 37 Hz is
    // no order of a 900 rpm head. The ambiguity note must name it rather than say
    // no airframe tone was measured there.
    for (const smallDps of [2.5, 3, 4]) {
      for (const untilShare of [0.6, 0.75]) {
        const plain = buildStopFlight({axis: 'yaw', headspeedRpm: 900, seed: 70 + smallDps * 10});
        const records = withRawTones(plain, [
          {hz: 15, amp: 20, untilS: (plain.at(-1).timeUs / 1e6) * untilShare},
          {hz: 37, amp: smallDps, phase: 0.2},
          ...[45, 60, 75, 90].map(hz => ({hz, amp: 6, phase: hz}))
        ]);
        const mechanical = await analyzeMechanicalWindow(seriesOf(records),
          wholeRangeOf(seriesOf(records)));
        const airframe = assessAirframe(mechanical);
        const label = `37 Hz at ${smallDps}, 1/rev until ${untilShare}`;
        assert.equal(airframe.status, 'permitted', `${label}: ${airframe.codes}`);
        const yawTones = airframe.axes.find(entry => entry.axis === 'yaw').tones;
        assert.equal(airframeAmbiguity(yawTones, 37).code, 'AIRFRAME_MODE_NOT_EXCLUDED_TONE_PRESENT',
          `${label}: ${JSON.stringify(yawTones.map(tone => tone.frequencyHz))}`);
      }
    }
  });

test('a main-rotor tone is judged on its size while present: an intermittent one past three times '
  + 'the level blocks, and no card states a ratio under one', async () => {
    // Round-2 review: the ceiling was judged on the Welch average over every
    // window, while attention needs a quarter of them. A once-per-rev at 3.5-5.3
    // times the level, present for 30-60% of the flight, averaged under 24 deg/s
    // and was waved through; one present a third of the time at 1.25 times the
    // level was described as "0.6 times" a level it was above.
    const run = async ({hz, strength, presence, periodS, seed}) => {
      const tone = {hz, amp: strength * 8 * Math.SQRT2};
      const series = gyroWindow({seconds: 60, seed,
        tones: [presence < 1 ? {...tone, onS: presence * periodS, periodS} : tone]});
      const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
      assert.equal(mechanical.attentionThreshold.bandRmsDps, 8);
      const attention = mechanical.axes.flatMap(axis =>
        axis.peaks.filter(peak => peak.attentionEligible));
      return {mechanical, attention, result: buildRecommendations({mechanical})};
    };
    let hidden = 0;
    let underOneOnAverage = 0;
    let justPast = 0;
    for (const [order, hz] of [[1, 30], [2, 60]]) {
      // 1. Past three times the level while present: every one blocks, as LARGE.
      for (const strength of [3.5, 4.5, 5.5]) {
        for (const presence of [0.3, 0.45, 0.6]) {
          for (const periodS of [6, 10]) {
            const {attention, result} = await run({hz, strength, presence, periodS,
              seed: 300 + order * 50 + strength * 10 + presence * 10 + periodS});
            const label = `order ${order} at ${strength}x, present ${presence * 100}% in `
              + `${periodS} s cycles: ${JSON.stringify(attention)}`;
            assert.ok(attention.length === 1 && isMainOrder(attention[0], [order]), label);
            const [peak] = attention;
            if (peak.bandRmsDps <= 24) {
              hidden += 1;
            }
            assert.ok(peak.attentionWindowBandRmsDps > 24, label);
            assert.equal(result.gates.airframe.status, 'blocked', `${label} passed the airframe`);
            assert.deepEqual([...result.gates.airframe.codes], ['MAIN_ROTOR_ORDER_TONE_LARGE'], label);
            const ids = result.findings.map(entry => entry.id);
            assert.ok(!ids.includes('AIRFRAME_ROTOR_ORDER_TONE'), `${label}: ${ids}`);
            const card = result.findings.find(entry => entry.id === 'AIRFRAME_ROTOR_ORDER_TONE_LARGE');
            assert.ok(card, `${label}: ${ids}`);
            const said = rotorToneHeadline(card.headline);
            assert.ok(said, card.headline);
            assert.equal(said.size, tenths(peak.attentionWindowBandRmsDps), card.headline);
            assert.ok(said.ratio > 3, card.headline);
            assert.equal(said.share, Math.round(peak.attentionPersistenceRatio * 100), card.headline);
            assert.equal(said.average, tenths(peak.bandRmsDps), card.headline);
          }
        }
      }
      // 2. Under three times the level while present — steady or not — reported,
      // and stated as a size that agrees with "above the level".
      for (const strength of [1.25, 2, 2.6]) {
        for (const presence of [0.3, 0.45, 0.6, 1]) {
          const {attention, result} = await run({hz, strength, presence, periodS: 10,
            seed: 500 + order * 50 + strength * 10 + presence * 10});
          const label = `order ${order} at ${strength}x, present ${presence * 100}%: `
            + JSON.stringify(attention);
          assert.ok(attention.length === 1 && isMainOrder(attention[0], [order]), label);
          const [peak] = attention;
          if (peak.bandRmsDps < 8) {
            underOneOnAverage += 1;
          }
          assert.equal(result.gates.airframe.status, 'permitted', `${label}: ${result.gates.airframe.codes}`);
          const card = result.findings.find(entry => entry.id === 'AIRFRAME_ROTOR_ORDER_TONE');
          assert.ok(card, `${label}: ${result.findings.map(entry => entry.id)}`);
          assert.doesNotMatch(card.headline, /\b0(?:\.\d+)? times/, card.headline);
          const said = rotorToneHeadline(card.headline);
          assert.ok(said, card.headline);
          assert.ok(said.size >= 8 && said.ratio >= 1, card.headline);
          assert.equal(said.size, tenths(peak.attentionWindowBandRmsDps), card.headline);
          assert.equal(said.ratio, tenths(peak.attentionWindowBandRmsDps / 8), card.headline);
          assert.equal(said.share, Math.round(peak.attentionPersistenceRatio * 100), card.headline);
          assert.equal(said.average, tenths(peak.bandRmsDps), card.headline);
          const ratioRow = card.basis.find(entry =>
            entry.label === 'strongest tone against the experimental level');
          assert.ok(ratioRow.value >= 1, JSON.stringify(ratioRow));
        }
      }
      // 3. Stage 2d, item 3: either side of the ceiling, 3.0-3.4 times the level.
      // A window that straddled the tone switching on or off held it for part of
      // its length and was averaged in at that partial power, so a tone just past
      // the ceiling read 7% under its size and was reported. Its size while
      // present is now what the same tone measures steady, and the ceiling is
      // decided on that.
      for (const strength of [3.0, 3.1, 3.2, 3.3, 3.4]) {
        const steady = (await run({hz, strength, presence: 1, seed: 700 + order + strength * 10}))
          .attention[0].attentionWindowBandRmsDps;
        for (const [presence, periodS] of [[0.3, 10], [0.45, 6], [0.5, 9]]) {
          const {attention, result} = await run({hz, strength, presence, periodS,
            seed: 800 + order * 50 + strength * 10 + presence * 10 + periodS});
          const label = `order ${order} at ${strength}x (steady ${steady}), present `
            + `${presence * 100}% in ${periodS} s cycles: ${JSON.stringify(attention)}`;
          assert.ok(attention.length === 1 && isMainOrder(attention[0], [order]), label);
          const [peak] = attention;
          assert.equal(peak.attentionWindowSizeIsLowerBound, false, label);
          assert.ok(Math.abs(peak.attentionWindowBandRmsDps / steady - 1) <= 0.01, label);
          if (peak.attentionWindowBandRmsDps > 24) {
            justPast += 1;
            assert.deepEqual([...result.gates.airframe.codes], ['MAIN_ROTOR_ORDER_TONE_LARGE'], label);
          } else {
            assert.equal(result.gates.airframe.status, 'permitted', label);
            assert.ok(result.findings.some(entry => entry.id === 'AIRFRAME_ROTOR_ORDER_TONE'), label);
          }
        }
      }
    }
    // The sweep reached both holes: tones the flight average hid under the
    // ceiling, and tones above the level that averaged under it.
    assert.ok(hidden >= 12, `only ${hidden} configurations averaged under the ceiling`);
    assert.ok(underOneOnAverage >= 3, `only ${underOneOnAverage} averaged under the level`);
    assert.ok(justPast >= 9, `only ${justPast} tones at 3.0-3.4 times the level were past the ceiling`);
  });

test('a rotor tone past the ceiling is named as large even where the window was measured only in '
  + 'part, and leads the airframe rung', async () => {
    // Round-2 review: the ceiling was checked only after every completeness
    // refusal, so a 40 deg/s once-per-rev on a long flight with one stretch the
    // analyser could not measure read exactly like a 13.6 deg/s one. It blocks
    // either way; now the pilot is told the measured thing that blocks it.
    for (const [amp, thinFromS] of [[20, 250], [44, 250], [52, 200], [60, 250]]) {
      const series = gyroWindow({seconds: 300, rateHz: 1007, tones: [{hz: 30, amp}],
        seed: 77 + amp, thinFromS, allAxes: true});
      const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
      assert.deepEqual(mechanical.chunks.map(chunk => chunk.status), ['attention', 'insufficient'],
        `${amp}: the fixture must measure the tone in one stretch and not the other`);
      const attention = mechanical.axes.flatMap(axis => axis.peaks.filter(peak => peak.attentionEligible));
      assert.ok(attention.length > 0 && attention.every(peak => isMainOrder(peak, [1])), `${amp}`);
      const loudest = attention.reduce((best, peak) =>
        (peak.attentionWindowBandRmsDps > best.attentionWindowBandRmsDps ? peak : best));
      const result = buildRecommendations({mechanical});
      const codes = result.gates.airframe.codes;
      const ids = result.findings.filter(entry => entry.rung === 'airframe').map(entry => entry.id);
      const label = `1/rev at ${amp} (${loudest.attentionWindowBandRmsDps} deg/s while present), `
        + `thinned from ${thinFromS} s: [${codes}] ${ids}`;
      assert.equal(result.gates.airframe.status, 'blocked', label);
      assert.deepEqual(adjustmentIds(result), [], label);
      // The other blockers stand, and say what they always said.
      for (const code of ['MECHANICAL_EVIDENCE_GATE_BLOCKED', 'ROTOR_CORRELATION_PARTIAL',
        'BROADBAND_NOT_MEASURED']) {
        assert.ok(codes.includes(code), `${label}: ${code}`);
      }
      const vibration = result.findings.find(entry => entry.id === 'AIRFRAME_VIBRATION_PRESENT');
      assert.ok(vibration?.codes.includes('ROTOR_ORDER_NOT_ESTABLISHED')
        && vibration.codes.includes('STRETCH_NOT_MEASURED'), `${label}: ${vibration?.codes}`);
      if (loudest.attentionWindowBandRmsDps <= 24) {
        assert.ok(!codes.includes('MAIN_ROTOR_ORDER_TONE_LARGE'), label);
        assert.ok(!ids.includes('AIRFRAME_ROTOR_ORDER_TONE_LARGE'), label);
        continue;
      }
      assert.equal(codes[0], 'MAIN_ROTOR_ORDER_TONE_LARGE', label);
      assert.equal(ids[0], 'AIRFRAME_ROTOR_ORDER_TONE_LARGE', label);
      assert.equal(result.findings.find(entry => entry.actNow)?.id,
        'AIRFRAME_ROTOR_ORDER_TONE_LARGE', label);
      const large = result.findings.find(entry => entry.id === 'AIRFRAME_ROTOR_ORDER_TONE_LARGE');
      const said = rotorToneHeadline(large.headline);
      assert.ok(said, large.headline);
      assert.equal(said.size, tenths(loudest.attentionWindowBandRmsDps), large.headline);
      assert.match(large.headline, /of the stretch it was measured in/, large.headline);
      assert.ok(!ids.includes('AIRFRAME_ROTOR_ORDER_TONE'), label);
    }
  });

test('a window compared against the rotor in part counts only the stretches that were measured',
  async () => {
    // Round-2 review: the headline said "1 of the 2 stretches it was measured in"
    // when the second stretch was never measured, and then said so itself.
    for (const [name, options, expected] of [
      ['the last stretch unmeasured', {thinFromS: 250}, {compared: 1, measured: 1, of: 2}],
      ['the head speed moving through the second stretch',
        {headspeed: at => (at < 150 ? 1800 : 1500 + (700 * (at - 150)) / 150)},
        {compared: 1, measured: 2, of: 2}]
    ]) {
      const series = gyroWindow({seconds: 300, rateHz: 1007, tones: [{hz: 30, amp: 20}], seed: 31,
        allAxes: true, ...options});
      const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
      const chunks = mechanical.chunks;
      assert.equal(chunks.length, expected.of, name);
      assert.equal(chunks.filter(chunk => chunk.status === 'attention' || chunk.status === 'clear')
        .length, expected.measured, `${name}: ${chunks.map(chunk => chunk.status)}`);
      assert.equal(chunks.filter(chunk => chunk.harmonicCorrelationState === 'evaluated').length,
        expected.compared, name);

      const result = buildRecommendations({mechanical});
      const rotor = result.findings.find(entry => entry.id === 'AIRFRAME_ROTOR_NOT_COMPARED');
      assert.ok(rotor?.codes.includes('ROTOR_CORRELATION_PARTIAL'), `${name}: ${rotor?.codes}`);
      const said = /\((\d+) of the (\d+) measured stretch(?:es)?, of (\d+) in all\)/.exec(rotor.headline);
      assert.ok(said, `${name}: ${rotor.headline}`);
      assert.deepEqual(said.slice(1).map(Number), [expected.compared, expected.measured, expected.of],
        rotor.headline);
      const row = label => rotor.basis.find(entry => entry.label === label)?.value;
      assert.equal(row('stretches compared against the rotor'), expected.compared, name);
      assert.equal(row('stretches the vibration check could measure'), expected.measured, name);
      assert.equal(row('stretches the range was split into'), expected.of, name);
    }
  });

test('attention-level peaks the analyser merged are counted, and the count blocks the rotor-order '
  + 'rule end to end', async () => {
    // Round-2 review: ATTENTION_PEAK_LIST_INCOMPLETE was only ever reached from a
    // hand-set count, so deleting the counter left every test green. Two
    // attention-level tones closer than the analyser separates are listed as one,
    // and that only happens above about 160 Hz, where 2.5% of the frequency is
    // wider than two bins — so the 2/rev it hides behind is a fast head's.
    let merged = 0;
    let onlyRotorListed = 0;
    for (const rpm of [5400, 6000, 6600, 7200]) {
      for (const offsetShare of [0.02, 0.025]) {
        for (const seed of [1, 2]) {
          const twoRevHz = (2 * rpm) / 60;
          const series = gyroWindow({seconds: 20, seed: 600 + seed, headspeed: () => rpm, tones: [
            {hz: rpm / 60, amp: 18}, {hz: twoRevHz, amp: 20},
            {hz: twoRevHz * (1 + offsetShare), amp: 20, phase: 1}]});
          const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
          const roll = mechanical.axes.find(axis => axis.axis === 'roll');
          const listed = roll.peaks.filter(peak => peak.attentionEligible);
          const label = `${rpm} rpm, a tone ${offsetShare * 100}% above the 2/rev, seed ${seed}: `
            + `${roll.attentionEligibleUnlistedCount} of ${roll.attentionEligibleCandidateCount} unlisted, `
            + `listed ${JSON.stringify(listed.map(peak => [peak.frequencyHz, peak.harmonicMatch?.order ?? null]))}`;
          // All three tones were found, and the count is exactly the ones not listed.
          assert.equal(roll.attentionEligibleCandidateCount, 3, label);
          assert.equal(roll.attentionEligibleUnlistedCount, 3 - listed.length, label);

          const result = buildRecommendations({mechanical});
          const ids = result.findings.map(entry => entry.id);
          const refusal = result.gates.airframe.upstream.measured.rotorOrderRefusal;
          assert.equal(result.gates.airframe.status, 'blocked', label);
          assert.ok(!ids.includes('AIRFRAME_ROTOR_ORDER_TONE'), `${label}: ${ids}`);
          if (roll.attentionEligibleUnlistedCount === 0) {
            assert.equal(refusal, 'ATTENTION_PEAK_NOT_MAIN_ORDER_1_OR_2', label);
            continue;
          }
          merged += 1;
          assert.equal(refusal, 'ATTENTION_PEAK_LIST_INCOMPLETE', label);
          const vibration = result.findings.find(entry => entry.id === 'AIRFRAME_VIBRATION_PRESENT');
          assert.ok(vibration, `${label}: ${ids}`);
          if (listed.every(peak => isMainOrder(peak))) {
            // Read off the list alone, this flight is the rotor's own tones; only
            // the count stands between it and the rotor-order rule, and the card
            // says that is why "only the rotor" is not established.
            onlyRotorListed += 1;
            assert.ok(vibration.codes.includes('ROTOR_ORDER_NOT_ESTABLISHED')
              && vibration.codes.includes('ATTENTION_PEAK_LIST_INCOMPLETE'),
            `${label}: ${vibration.codes}`);
          }
        }
      }
    }
    assert.ok(merged >= 8, `the sweep must reach merged peaks: ${merged}`);
    assert.ok(onlyRotorListed >= 6, `and ones the list alone would pass: ${onlyRotorListed}`);
  });

test('a tone measured in two stretches is one row on the vibration cards, at its worst', async () => {
  // Round-2 review: `distinctTones` merges the copies a window measured in
  // stretches lists of one tone, and nothing tested it.
  for (const [name, tones, id, row] of [
    ['an unmatched tone above the level', [{hz: 71, amp: 26}, {hz: 30, amp: 4}],
      'AIRFRAME_VIBRATION_PRESENT', /^persistent tone above the attention level: 7\d\.\d Hz on roll/],
    ['a once-per-rev below the level', [{hz: 30, amp: 4}], 'AIRFRAME_TONE_BELOW_ATTENTION',
      /^persistent tone below the attention level: [\d.]+ Hz on roll, which is the main rotor's once/]
  ]) {
    const series = gyroWindow({seconds: 300, rateHz: 1007, tones, seed: 5});
    const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
    assert.equal(mechanical.chunks.length, 2, name);
    const toneHz = tones[0].hz;
    const copies = mechanical.axes.find(axis => axis.axis === 'roll').peaks
      .filter(peak => Math.abs(peak.frequencyHz - toneHz) <= 2);
    assert.equal(copies.length, 2, `${name}: the fixture must list the tone in each stretch`);

    const result = buildRecommendations({mechanical});
    const card = result.findings.find(entry => entry.id === id);
    assert.ok(card, `${name}: ${result.findings.map(entry => entry.id)}`);
    const rows = card.basis.filter(entry => row.test(entry.label));
    assert.equal(rows.length, 1, `${name}: ${JSON.stringify(card.basis.map(entry => entry.label))}`);
    assert.match(rows[0].label, /worst in the stretch/, rows[0].label);
    assert.equal(rows[0].value, Math.max(...copies.map(peak => peak.bandRmsDps)), name);
  }
});

/* --------------------------------------------------------------------------- */
/* Stage 2d: the airframe review of 3 October 2026.                            */
/* --------------------------------------------------------------------------- */

/** Every airframe basis row that says its tone was below the attention level. */
const belowLevelRows = result => result.findings.filter(entry => entry.rung === 'airframe')
  .flatMap(entry => entry.basis.filter(row => /below the attention level/.test(row.label)));

/** Every airframe basis row that says its tone was above the attention level. */
const aboveLevelRows = result => result.findings.filter(entry => entry.rung === 'airframe')
  .flatMap(entry => entry.basis.filter(row =>
    /above the attention level(?: for part of the range)?:/.test(row.label)));

test('a tone above the attention level for only part of the flight is never an all-clear, and '
  + 'blocks past the ceiling', async () => {
    // Stage 2d, item 1 — pre-existing on main. A tone above the level in some
    // windows but not attention-eligible (too few windows, too short a span, too
    // few quarters of the flight or too long a gap) left the analyser reading
    // "clear", and the airframe rung read that as AIRFRAME_CLEAR — "a positive
    // measurement of absence" — or listed the tone "below the attention level"
    // under "quiet enough to judge the tune over", while it measured three to six
    // times the level whenever it was there. Swept over where the tone sits, how
    // long it lasts and how often it comes back.
    const shapes = [
      ['the first quarter', at => at < 15],
      ['the first 40%', at => at < 24],
      ['a block in the middle', at => at >= 20 && at < 38],
      ['the last 30%', at => at >= 42],
      ['2 s in every 10', at => at % 10 < 2],
      ['1.5 s in every 6', at => at % 6 < 1.5]
    ];
    const kinds = [['the once-per-rev', 30, 1], ['the twice-per-rev', 60, 2], ['a 47 Hz tone', 47, null]];
    // Stage 2d follow-up: and SHORT BURSTS, 1.5-15 s in ranges of 40 s to five
    // minutes. A peak present in under a quarter of the analysis windows was
    // dropped before its size in each was measured, so a burst at three to seven
    // times the level was never listed, and the rung read AIRFRAME_CLEAR over it.
    // Every burst here is longer than the gap between analysed windows plus one
    // window (see the analyser's own sweep), so a window holds each one whole.
    const ranges = shapes.map(([shape, on]) => [shape, on, 60, [1.6, 2.6, 4.2]]);
    for (const [seconds, burstS, fromShare] of [[40, 1.5, 0.3], [90, 15, 0.6], [150, 4, 0.2],
      [300, 3, 0.7]]) {
      const fromS = seconds * fromShare;
      ranges.push([`a ${burstS} s burst of ${seconds} s`, at => at >= fromS && at < fromS + burstS,
        seconds, [2.2, 4.2]]);
    }
    const seen = {clear: 0, reported: 0, large: 0, unexplained: 0, eligible: 0, burst: 0};
    let configuration = 0;
    for (const [shape, on, seconds, strengths] of ranges) {
      for (const [kind, hz, order] of kinds) {
        for (const strength of strengths) {
          configuration += 1;
          const series = gyroWindow({seconds, seed: 900 + configuration,
            tones: [{hz, amp: strength * 8 * Math.SQRT2, on, phase: configuration}]});
          const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
          const inPart = mechanical.axes.flatMap(axis => axis.peaks
            .filter(peak => peak.attentionEligible !== true && peak.attentionWindowBandRmsDps >= 8)
            .map(peak => ({...peak, axis: axis.axis})));
          const label = `${kind} at ${strength}x over ${shape}: ${mechanical.status}, `
            + JSON.stringify(inPart.map(peak => [peak.frequencyHz, peak.bandRmsDps,
              peak.attentionWindowBandRmsDps, peak.attentionPersistenceRatio]));
          // Every tone here reached the level in a window that held it whole, so
          // it is on the list — never skipped because the analyser dropped it.
          const listed = mechanical.axes.find(axis => axis.axis === 'roll').peaks
            .find(peak => Math.abs(peak.frequencyHz - hz) <= 2 && peak.attentionWindowBandRmsDps >= 8);
          assert.ok(listed, `${label}: a tone at ${strength} times the level was never listed`);
          if (listed.attentionEligible) {
            // Above the level across enough of the flight: the persistent rules,
            // tested on their own above.
            seen.eligible += 1;
            continue;
          }
          if (seconds !== 60) {
            seen.burst += 1;
          }
          if (mechanical.status === 'clear') {
            seen.clear += 1;
          }
          const result = buildRecommendations({mechanical});
          const ids = result.findings.filter(entry => entry.rung === 'airframe').map(entry => entry.id);
          // The guarded property: no all-clear, and the tone is never listed as
          // below the level it was above.
          assert.ok(!ids.includes('AIRFRAME_CLEAR') && !ids.includes('AIRFRAME_TONE_BELOW_ATTENTION'),
            `${label}: ${ids}`);
          for (const peak of inPart) {
            assert.ok(!belowLevelRows(result).some(row =>
              row.label.includes(`: ${tenths(peak.frequencyHz)} Hz on ${peak.axis}`)),
            `${label}: listed below the level: ${JSON.stringify(belowLevelRows(result))}`);
          }
          assert.ok(aboveLevelRows(result).every(row => row.value >= 8),
            `${label}: ${JSON.stringify(aboveLevelRows(result))}`);
          const loudest = inPart.reduce((best, peak) =>
            (peak.attentionWindowBandRmsDps > best.attentionWindowBandRmsDps ? peak : best));
          if (loudest.attentionWindowBandRmsDps <= 24) {
            // Up to the ceiling: not ruled out, said as its size while present, how
            // long it was there for and its average — and not a reason on its own
            // to hold the rest back.
            seen.reported += 1;
            assert.equal(result.gates.airframe.status, 'permitted', `${label}: ${result.gates.airframe.codes}`);
            const card = result.findings.find(entry => entry.id === 'AIRFRAME_TONE_ABOVE_LEVEL_IN_PART');
            assert.ok(card, `${label}: ${ids}`);
            assert.equal(card.kind, 'next-flight', label);
            assert.match(card.headline, /not ruled out/, card.headline);
            const said = rotorToneHeadline(card.headline);
            assert.ok(said, card.headline);
            assert.equal(said.size, tenths(loudest.attentionWindowBandRmsDps), card.headline);
            assert.equal(said.ratio, tenths(loudest.attentionWindowBandRmsDps / 8), card.headline);
            assert.equal(said.share, Math.round(loudest.attentionPersistenceRatio * 100), card.headline);
            assert.equal(said.average, tenths(loudest.bandRmsDps), card.headline);
            assert.ok(card.confirm && /fly/i.test(card.confirm), card.confirm);
            continue;
          }
          // Past it: blocks, as the rotor's own large tone or as vibration nothing
          // explains.
          assert.equal(result.gates.airframe.status, 'blocked', label);
          assert.deepEqual(adjustmentIds(result), [], label);
          if (order !== null) {
            seen.large += 1;
            assert.equal(result.gates.airframe.codes[0], 'MAIN_ROTOR_ORDER_TONE_LARGE', label);
            assert.equal(ids[0], 'AIRFRAME_ROTOR_ORDER_TONE_LARGE', `${label}: ${ids}`);
            const said = rotorToneHeadline(result.findings[0].headline);
            assert.equal(said?.size, tenths(loudest.attentionWindowBandRmsDps), result.findings[0].headline);
          } else {
            seen.unexplained += 1;
            assert.ok(result.gates.airframe.codes.includes('MECHANICAL_EVIDENCE_GATE_BLOCKED'), label);
            const vibration = result.findings.find(entry => entry.id === 'AIRFRAME_VIBRATION_PRESENT');
            assert.ok(vibration?.codes.includes('NOT_EXPLAINED_BY_MAIN_ROTOR_ORDER'), `${label}: ${ids}`);
          }
        }
      }
    }
    // The sweep reached the hole — the analyser reading "clear" over a tone above
    // the level — and both sides of the ceiling, for the rotor and for not, and
    // every burst, at every strength.
    assert.ok(seen.clear >= 20, JSON.stringify(seen));
    assert.ok(seen.reported >= 12 && seen.large >= 4 && seen.unexplained >= 2, JSON.stringify(seen));
    assert.equal(seen.burst, 24, JSON.stringify(seen));
  });

test('a tone above the attention level for part of the flight is never an all-clear in the app\'s '
  + 'three-axis shape', async () => {
    // Stage 2d, item 1, end to end: a stop flight whose once-per-rev is there only
    // over its first stops — 22-30% of the flight — handed over with all three
    // axes as ui/app.mjs hands it. It used to read "quiet enough to judge the
    // tune over".
    for (const [amp, untilShare] of [[20, 0.22], [20, 0.3], [40, 0.22], [60, 0.3]]) {
      const plain = buildStopFlight({axis: 'yaw', ...STOP_FAULTS.tooMuchD, seed: 4243});
      const records = withRawTones(plain, [
        {hz: 30, amp: amp * Math.SQRT2, untilS: (plain.at(-1).timeUs / 1e6) * untilShare}]);
      const series = seriesOf(records);
      const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
      const oneRev = mechanical.axes.flatMap(axis => axis.peaks.filter(peak =>
        isMainOrder(peak, [1]) && peak.attentionWindowBandRmsDps >= 8));
      const label = `a ${amp} deg/s once-per-rev over the first ${untilShare * 100}%: `
        + `${mechanical.status} ${JSON.stringify(oneRev.map(peak => [peak.attentionEligible,
          peak.bandRmsDps, peak.attentionWindowBandRmsDps]))}`;
      assert.ok(oneRev.length > 0 && oneRev.every(peak => !peak.attentionEligible), label);
      const result = recommendThreeAxes(records, mechanical);
      const ids = result.findings.filter(entry => entry.rung === 'airframe').map(entry => entry.id);
      assert.ok(!ids.includes('AIRFRAME_CLEAR') && !ids.includes('AIRFRAME_TONE_BELOW_ATTENTION'),
        `${label}: ${ids}`);
      const largest = Math.max(...oneRev.map(peak => peak.attentionWindowBandRmsDps));
      if (largest > 24) {
        assert.equal(result.gates.airframe.status, 'blocked', label);
        assert.ok(ids.includes('AIRFRAME_ROTOR_ORDER_TONE_LARGE'), `${label}: ${ids}`);
        assert.deepEqual(adjustmentIds(result), [], label);
        assert.equal(result.findings.find(entry => entry.actNow)?.id, 'AIRFRAME_ROTOR_ORDER_TONE_LARGE',
          label);
      } else if (result.gates.airframe.status === 'permitted') {
        assert.ok(ids.includes('AIRFRAME_TONE_ABOVE_LEVEL_IN_PART'), `${label}: ${ids}`);
      } else {
        // Something else stops the airframe here; the tone is still on screen,
        // above the level, in the basis of what does.
        assert.ok(aboveLevelRows(result).some(row => row.value >= 8), `${label}: ${ids}`);
      }
    }
  });

test('a size the analyser could only bound from below is said as "at least"', () => {
  // Stage 2d, item 3: where no analysis window held the tone whole, its size
  // while present is published as a lower bound, and no card may state it as
  // the size.
  const peak = {frequencyHz: 47, bandRmsDps: 5.2, attentionWindowBandRmsDps: 12.4,
    attentionWindowSizeIsLowerBound: true, attentionPersistenceRatio: 0.12, bandwidthHz: 2,
    persistenceRatio: 0.3, attentionEligible: false, harmonicMatch: null};
  const result = buildRecommendations({mechanical: cleanAirframe({
    axes: ['roll', 'pitch', 'yaw'].map(axis => ({axis, source: 'gyroRAW', available: true,
      medianNoisePsdDps2PerHz: 0.0002, broadbandRmsDps: 1.2, peaks: axis === 'roll' ? [peak] : []}))
  })});
  const card = result.findings.find(entry => entry.id === 'AIRFRAME_TONE_ABOVE_LEVEL_IN_PART');
  assert.ok(card, `${result.findings.map(entry => entry.id)}`);
  assert.match(card.headline, /measured at least 12\.4 deg\/s on roll/, card.headline);
  const rows = card.basis.filter(row => /above the attention level for part of the range:/.test(row.label));
  assert.equal(rows.length, 1, JSON.stringify(card.basis.map(row => row.label)));
  assert.match(rows[0].label, /at least 12\.4 deg\/s while above it/, rows[0].label);
  assert.match(rows[0].source, /lower bound/, rows[0].source);
});

test('every "above the attention level" row on the vibration card states the size the tone had '
  + 'while it was above it', async () => {
    // Stage 2d, item 5. The row printed the tone's flight average, so a tone above
    // the level for a third of the flight read "persistent tone above the
    // attention level ... at 4.4 deg/s" beside an 8 deg/s level.
    let underOnAverage = 0;
    for (const strength of [1.25, 1.5, 2]) {
      for (const [onS, periodS] of [[3, 10], [4, 10], [6, 10]]) {
        const series = gyroWindow({seconds: 60, seed: 5 + onS + strength * 10,
          tones: [{hz: 47, amp: strength * 8 * Math.SQRT2, onS, periodS}]});
        const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
        const peak = mechanical.axes.find(axis => axis.axis === 'roll').peaks
          .find(entry => Math.abs(entry.frequencyHz - 47) <= 2);
        const label = `47 Hz at ${strength}x for ${onS} s in ${periodS}: ${JSON.stringify(peak)}`;
        assert.ok(peak?.attentionEligible, label);
        if (peak.bandRmsDps < 8) {
          underOnAverage += 1;
        }
        const result = buildRecommendations({mechanical});
        const vibration = result.findings.find(entry => entry.id === 'AIRFRAME_VIBRATION_PRESENT');
        assert.ok(vibration, `${label}: ${result.findings.map(entry => entry.id)}`);
        const rows = vibration.basis.filter(row => /above the attention level:/.test(row.label));
        assert.equal(rows.length, 1, JSON.stringify(vibration.basis.map(row => row.label)));
        const [row] = rows;
        // Its size while present, as the value and in the words; how long it was
        // there for; and its average beside them, named as the average.
        assert.equal(row.value, Math.round(peak.attentionWindowBandRmsDps * 1000) / 1000, row.label);
        assert.ok(row.value >= 8, row.label);
        const stated = /at ([\d.]+) deg\/s while above it, for (\d+)% of the range \(([\d.]+) deg\/s averaged over all of it\)/
          .exec(row.label);
        assert.ok(stated, row.label);
        assert.equal(Number(stated[1]), tenths(peak.attentionWindowBandRmsDps), row.label);
        assert.ok(Number(stated[1]) >= 8, row.label);
        assert.equal(Number(stated[2]), Math.round(peak.attentionPersistenceRatio * 100), row.label);
        assert.equal(Number(stated[3]), tenths(peak.bandRmsDps), row.label);
      }
    }
    assert.ok(underOnAverage >= 5, `only ${underOnAverage} averaged under the level they were above`);

    // Measured in two stretches, the row speaks for the stretch the tone was
    // largest in WHILE PRESENT: steady at 14 deg/s in the first, 22 deg/s for
    // 30% of the second — the larger average is the first stretch's.
    const series = gyroWindow({seconds: 300, rateHz: 1007, seed: 17, tones: [
      {hz: 71, amp: 14 * Math.SQRT2, on: at => at < 150},
      {hz: 71, amp: 22 * Math.SQRT2, on: at => at >= 150 && at % 10 < 3}]});
    const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
    const copies = mechanical.axes.find(axis => axis.axis === 'roll').peaks
      .filter(peak => Math.abs(peak.frequencyHz - 71) <= 2 && peak.attentionEligible);
    const label = JSON.stringify(copies.map(peak => [peak.chunkRangeUs, peak.bandRmsDps,
      peak.attentionWindowBandRmsDps]));
    assert.equal(copies.length, 2, label);
    const louder = copies.reduce((best, peak) =>
      (peak.attentionWindowBandRmsDps > best.attentionWindowBandRmsDps ? peak : best));
    const higherAverage = copies.reduce((best, peak) => (peak.bandRmsDps > best.bandRmsDps ? peak : best));
    assert.notEqual(louder, higherAverage, `the fixture must order the two each way: ${label}`);
    const vibration = buildRecommendations({mechanical}).findings
      .find(entry => entry.id === 'AIRFRAME_VIBRATION_PRESENT');
    const rows = vibration.basis.filter(row => /^persistent tone above the attention level:/.test(row.label));
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0].value, louder.attentionWindowBandRmsDps, `${rows[0].label}: ${label}`);
    assert.match(rows[0].label, /of the stretch it was worst in/, rows[0].label);
  });

test('the strongest of two rotor tones is the one largest while present, whatever their averages',
  async () => {
    // Stage 2d, item 6 (case S). A once-per-rev steady on roll and a twice-per-rev
    // on pitch three times larger while present but there a third of the time:
    // sorted by average, the large-tone card named the roll tone at 2.7 times the
    // level "past the 24 deg/s up to which a main-rotor tone is only reported".
    for (const [steady, loud, share] of [[23, 32, 0.3], [22, 30, 0.3], [23, 34, 0.25]]) {
      const series = gyroWindow({seconds: 60, seed: 61 + steady, tones: [
        {hz: 30, amp: steady * Math.SQRT2, axes: ['roll']},
        {hz: 60, amp: loud * Math.SQRT2, onS: share * 10, periodS: 10, axes: ['pitch']}]});
      const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
      const peakOf = (axis, order) => mechanical.axes.find(entry => entry.axis === axis).peaks
        .find(peak => isMainOrder(peak, [order]));
      const roll = peakOf('roll', 1);
      const pitch = peakOf('pitch', 2);
      const label = `roll 1/rev ${JSON.stringify(roll)}, pitch 2/rev ${JSON.stringify(pitch)}`;
      // The fixture is the case: the averages order the two one way, the sizes
      // while present the other, and only the pitch tone is past the ceiling.
      assert.ok(roll.bandRmsDps > pitch.bandRmsDps, label);
      assert.ok(pitch.attentionWindowBandRmsDps > 24 && roll.attentionWindowBandRmsDps <= 24, label);
      const result = buildRecommendations({mechanical});
      const card = result.findings.find(entry => entry.id === 'AIRFRAME_ROTOR_ORDER_TONE_LARGE');
      assert.ok(card, `${label}: ${result.findings.map(entry => entry.id)}`);
      assert.match(card.headline, /twice-per-rev measured [\d.]+ deg\/s on pitch/, card.headline);
      const said = rotorToneHeadline(card.headline);
      assert.equal(said.size, tenths(pitch.attentionWindowBandRmsDps), card.headline);
      assert.ok(said.ratio > 3, card.headline);
      assert.equal(said.average, tenths(pitch.bandRmsDps), card.headline);
    }
  });

test('a once-per-rev measured in two stretches is judged on the stretch it was largest in while '
  + 'present', async () => {
    // Stage 2d, item 6 (case W), end to end: steady at 21 deg/s in the first
    // stretch of a five-minute window, 31 deg/s for a third of the second. Judged
    // on the larger average it read 21, under the ceiling, and was passed.
    const series = gyroWindow({seconds: 300, rateHz: 1007, seed: 13, tones: [
      {hz: 30, amp: 21 * Math.SQRT2, on: at => at < 150},
      {hz: 30, amp: 31 * Math.SQRT2, on: at => at >= 150 && at % 10 < 3.5}]});
    const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
    assert.equal(mechanical.chunks.length, 2);
    const copies = mechanical.axes.find(axis => axis.axis === 'roll').peaks
      .filter(peak => isMainOrder(peak, [1]) && peak.attentionEligible);
    const label = JSON.stringify(copies.map(peak => [peak.bandRmsDps, peak.attentionWindowBandRmsDps]));
    assert.equal(copies.length, 2, label);
    const [first, second] = [...copies].sort((left, right) => left.chunkRangeUs[0] - right.chunkRangeUs[0]);
    assert.ok(first.bandRmsDps > second.bandRmsDps, `the averages point the wrong way: ${label}`);
    assert.ok(second.attentionWindowBandRmsDps > 24 && first.attentionWindowBandRmsDps <= 24, label);
    const result = buildRecommendations({mechanical});
    assert.equal(result.gates.airframe.status, 'blocked', label);
    assert.deepEqual([...result.gates.airframe.codes], ['MAIN_ROTOR_ORDER_TONE_LARGE'], label);
    const card = result.findings.find(entry => entry.id === 'AIRFRAME_ROTOR_ORDER_TONE_LARGE');
    const said = rotorToneHeadline(card.headline);
    assert.equal(said.size, tenths(second.attentionWindowBandRmsDps), card.headline);
    assert.equal(said.average, tenths(second.bandRmsDps), card.headline);
    // Item 4: its share and its average are of the stretch it was worst in, and
    // the card says so, in the basis the plain copy is read from as well.
    assert.match(card.headline, /of the stretch it was worst in, and averaged/, card.headline);
    const share = card.basis.find(row => row.unit === '%' && /^strongest tone, share of/.test(row.label));
    assert.match(share.label, /the stretch it was worst in/, share.label);
  });

/* --------------------------------------------------------------------------- */
/* Stage 2d follow-up, airframe review of 3 October 2026.                      */
/* --------------------------------------------------------------------------- */

/** A peak above the attention level in 11% of the windows, at `whilePresent` deg/s while there. */
const inPartPeak = (frequencyHz, harmonicMatch, whilePresent = 15.2) => ({
  frequencyHz, interpolatedFrequencyHz: frequencyHz, bandRmsDps: 4.7,
  attentionWindowBandRmsDps: whilePresent, attentionWindowSizeIsLowerBound: false,
  attentionPersistenceRatio: 0.11, bandwidthHz: 2, persistenceRatio: 0.3, attentionEligible: false,
  harmonicMatch});
const ONCE_PER_REV = Object.freeze({rotor: 'main', order: 1, predictedHz: 30, deltaHz: 0.4,
  toleranceHz: 2.9, spreadHz: 0.15, frequencyResolutionHz: 1.953});
/** A clean three-axis result whose roll axis lists `peaks`. */
const rollPeaks = peaks => cleanAirframe({axes: ['roll', 'pitch', 'yaw'].map(axis => ({
  axis, source: 'gyroRAW', available: true, attentionEligibleUnlistedCount: 0,
  medianNoisePsdDps2PerHz: 0.0002, broadbandRmsDps: 1.2, peaks: axis === 'roll' ? peaks : []}))});

test('the card for a tone above the level in part claims a refusal only where the coincidence rule '
  + 'makes one, and the gain verdict beside it names that tone at its size while present', () => {
    // Stage 2d follow-up, item 2. The card said an oscillation sitting on the tone
    // "is refused on its own card rather than blamed on a gain". `coincidentTone`
    // refuses only on a tone matched to a rotor order, so for one matching none
    // the sentence was false — on the committed gain-fault fixtures the D card
    // beside it blamed exactly that oscillation on D. Refusing on an unmatched
    // tone instead would refuse the loop's own ring, which is what that tone is
    // there (see `coincidentTone`), so the gain stands with the warning that one
    // flight cannot rule out the airframe, and the card says that instead.
    const cases = [
      ['matching no rotor order', [inPartPeak(25.4, null)], {refused: false, caveat: true}],
      ['the main rotor\'s once-per-rev', [inPartPeak(29.6, ONCE_PER_REV)], {refused: true, caveat: false}],
      ['one of each', [inPartPeak(29.6, ONCE_PER_REV, 18), inPartPeak(47, null)],
        {refused: true, caveat: true}]
    ];
    for (const [name, peaks, says] of cases) {
      const mechanical = rollPeaks(peaks);
      const result = buildRecommendations({mechanical});
      const card = result.findings.find(entry => entry.id === 'AIRFRAME_TONE_ABOVE_LEVEL_IN_PART');
      assert.ok(card, `${name}: ${result.findings.map(entry => entry.id)}`);
      const label = `${name}: ${card.reasoning}`;
      // What the card claims is what the rule does, tone by tone.
      const tones = assessAirframe(mechanical).axes.find(entry => entry.axis === 'roll').tones;
      assert.deepEqual(peaks.map(peak => coincidentTone(tones, peak.frequencyHz) !== null),
        peaks.map(peak => peak.harmonicMatch !== null), name);
      assert.equal(/refused on its own card/.test(card.reasoning), says.refused, label);
      assert.equal(/one flight cannot rule out the airframe/i.test(card.reasoning), says.caveat, label);
      if (says.refused && says.caveat) {
        // Each claim is said of the tones it is true of.
        assert.match(card.reasoning, /one at or near a rotor order/, label);
        assert.match(card.reasoning, /one matching no rotor order/, label);
      }
    }

    // The caveat on the gain verdict names an unmatched tone above the level for
    // part of the flight as what it measured — its size while there, for how
    // long, and its average — never as "persistent" at its average.
    const inPart = assessAirframe(rollPeaks([inPartPeak(25.4, null)])).axes
      .find(entry => entry.axis === 'roll').tones;
    const ambiguity = airframeAmbiguity(inPart, 25.9);
    assert.equal(ambiguity.code, 'AIRFRAME_MODE_NOT_EXCLUDED_TONE_PRESENT');
    assert.doesNotMatch(ambiguity.sentence, /persistent/, ambiguity.sentence);
    assert.match(ambiguity.sentence, new RegExp('a tone at 25\\.4 Hz, matching no rotor order, at 15\\.2 '
      + 'deg/s while it was above the attention level, for 11% of the range \\(4\\.7 deg/s averaged '
      + 'over all of it\\)'), ambiguity.sentence);
    // A steady tone that never reached the level is still the persistent tone it is.
    const steady = assessAirframe(rollPeaks([{...inPartPeak(25.4, null), attentionWindowBandRmsDps: null,
      attentionPersistenceRatio: 0, persistenceRatio: 0.8}])).axes.find(entry => entry.axis === 'roll').tones;
    assert.match(airframeAmbiguity(steady, 25.9).sentence, /a persistent tone at 25\.4 Hz \(4\.7 deg\/s\)/);
  });

test('a tone near the main rotor\'s order but outside what the logged head speed allows is never '
  + 'called the rotor\'s own, on any card', async () => {
    // Stage 2d follow-up, item 3. Identity was required of the rotor-order
    // EXEMPTION only. Past the ceiling, a tone the analyser merely named the
    // once-per-rev — 1.5 Hz off it with the head logged steady at 1800 rpm — was
    // still judged the rotor's own large tone: "This is the main rotor's own tone
    // ... matched against the logged head speed", "Sort the tracking and balance",
    // beside a card saying it was not established as the rotor's. It blocks, as
    // vibration not established as the rotor's, and is said as near the order.
    const near = /near the main rotor's once-per-rev, outside what the logged head speed allows/;
    const ownTone = /main rotor's own tone|which is the main rotor's|Sort the tracking/;
    for (const [shape, on, strength] of [['steady', null, 4], ['over the first 30%', at => at < 18, 4],
      ['over the first 30%', at => at < 18, 2.5]]) {
      for (const [offsetHz, established] of [[1.5, false], [0.2, true]]) {
        const series = gyroWindow({seconds: 60, seed: 3, tones: [{hz: 30 + offsetHz,
          amp: strength * 8 * Math.SQRT2, phase: 1, ...(on ? {on} : {})}]});
        const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
        const peak = mechanical.axes.find(axis => axis.axis === 'roll').peaks
          .find(entry => isMainOrder(entry, [1]));
        const label = `${30 + offsetHz} Hz at ${strength}x ${shape}: ${JSON.stringify(peak)}`;
        // The fixture is the case: the analyser names it the once-per-rev, sized past
        // or under the ceiling as intended.
        assert.ok(peak && peak.attentionWindowBandRmsDps >= 8, label);
        assert.equal(peak.attentionEligible, on === null, label);
        assert.equal(peak.attentionWindowBandRmsDps > 24, strength > 3, label);
        const result = buildRecommendations({mechanical});
        const airframe = result.findings.filter(entry => entry.rung === 'airframe');
        const ids = airframe.map(entry => entry.id);
        const text = airframe.map(findingText).join(' ');
        if (established) {
          // The control: on the order, it is the rotor's own, large or reported.
          assert.ok(ids.includes(strength > 3 ? 'AIRFRAME_ROTOR_ORDER_TONE_LARGE'
            : 'AIRFRAME_TONE_ABOVE_LEVEL_IN_PART'), `${label}: ${ids}`);
          assert.doesNotMatch(text, near, label);
          continue;
        }
        assert.ok(!ids.includes('AIRFRAME_ROTOR_ORDER_TONE_LARGE'), `${label}: ${ids}`);
        assert.deepEqual([...result.gates.airframe.upstream.measured.rotorOrderTonesLarge], [], label);
        assert.doesNotMatch(text, ownTone, `${label}: ${text}`);
        assert.match(text, near, `${label}: ${text}`);
        if (strength > 3) {
          // Past the ceiling: it blocks every gain, as vibration not established as
          // the rotor's — and says which condition did not hold.
          assert.equal(result.gates.airframe.status, 'blocked', label);
          const vibration = airframe.find(entry => entry.id === 'AIRFRAME_VIBRATION_PRESENT');
          assert.ok(vibration, `${label}: ${ids}`);
          assert.ok(vibration.codes.includes('ROTOR_ORDER_NOT_ESTABLISHED')
            && vibration.codes.includes('ROTOR_ORDER_MATCH_NOT_ESTABLISHED'), `${label}: ${vibration.codes}`);
          assert.match(vibration.reasoning, /outside what the logged head speed allows/, vibration.reasoning);
          assert.ok(vibration.basis.some(row => near.test(row.label)
            && row.value === Math.round(peak.attentionWindowBandRmsDps * 1000) / 1000),
          JSON.stringify(vibration.basis.map(row => [row.label, row.value])));
        } else {
          // Under it: reported as near the order, and the codes the plain copy reads
          // do not name it the rotor's — "Your main rotor shook" would.
          const card = airframe.find(entry => entry.id === 'AIRFRAME_TONE_ABOVE_LEVEL_IN_PART');
          assert.ok(card, `${label}: ${ids}`);
          assert.match(card.headline, near, card.headline);
          assert.ok(!card.codes.includes('MAIN_ROTOR_ORDER_1'), `${label}: ${card.codes}`);
          assert.ok(card.codes.includes('ROTOR_ORDER_MATCH_NOT_ESTABLISHED'), `${label}: ${card.codes}`);
        }
      }
    }
  });

test('a tone above the level in part is on screen beside a permitted rotor-order card, and in the '
  + 'basis of another blocker, as itself', async () => {
    // Stage 2d follow-up, item 4: two mutants survived every test. Dropping the
    // not-ruled-out card pushed beside a permitted AIRFRAME_ROTOR_ORDER_TONE —
    // the most common real shape, 20 of the 43 corpus windows — and dropping the
    // tone's own rows from another airframe blocker's basis.
    //
    // A steady once-per-rev under the ceiling, which the rotor-order rule passes,
    // and a 47 Hz tone matching no rotor order above the level for part of it.
    for (const strength of [1.6, 2.4]) {
      for (const [shape, on] of [['the first quarter', at => at < 15], ['2 s in every 10',
        at => at % 10 < 2], ['the last third', at => at >= 40]]) {
        const series = gyroWindow({seconds: 60, seed: 90 + strength * 10, tones: [
          {hz: 30, amp: 12 * Math.SQRT2}, {hz: 47, amp: strength * 8 * Math.SQRT2, phase: 0.7, on}]});
        const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
        const peak = mechanical.axes.find(axis => axis.axis === 'roll').peaks
          .find(entry => Math.abs(entry.frequencyHz - 47) <= 2);
        const label = `47 Hz at ${strength}x over ${shape}: ${JSON.stringify(peak)}`;
        assert.ok(peak && !peak.attentionEligible && peak.attentionWindowBandRmsDps >= 8, label);
        const result = buildRecommendations({mechanical});
        const ids = result.findings.filter(entry => entry.rung === 'airframe').map(entry => entry.id);
        assert.equal(result.gates.airframe.status, 'permitted', `${label}: ${result.gates.airframe.codes}`);
        assert.deepEqual([...ids].sort(), ['AIRFRAME_ROTOR_ORDER_TONE', 'AIRFRAME_TONE_ABOVE_LEVEL_IN_PART'],
          label);
        const rotorCard = result.findings.find(entry => entry.id === 'AIRFRAME_ROTOR_ORDER_TONE');
        assert.match(rotorCard.reasoning, /on a card of its own/, rotorCard.reasoning);
        const card = result.findings.find(entry => entry.id === 'AIRFRAME_TONE_ABOVE_LEVEL_IN_PART');
        assert.match(card.headline, new RegExp(`^A tone at ${tenths(peak.frequencyHz)} Hz, matching no rotor `
          + `order, measured (?:at least )?${tenths(peak.attentionWindowBandRmsDps)} deg/s on roll`),
        card.headline);
      }
    }

    // The same tone where the head speed moved too much for the rotor to be
    // compared: the airframe is blocked for that, and the tone is in that card's
    // basis as its own row, at its size while present.
    for (const [shape, on] of [['the first quarter', at => at < 15], ['2 s in every 10', at => at % 10 < 2]]) {
      const series = gyroWindow({seconds: 60, seed: 121, headspeed: at => 1500 + 8 * at,
        tones: [{hz: 47, amp: 2.2 * 8 * Math.SQRT2, on}]});
      const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
      const peak = mechanical.axes.find(axis => axis.axis === 'roll').peaks
        .find(entry => Math.abs(entry.frequencyHz - 47) <= 2);
      const label = `47 Hz at 2.2x over ${shape}, head speed ramping: ${JSON.stringify(peak)}`;
      assert.ok(peak && !peak.attentionEligible && peak.attentionWindowBandRmsDps >= 8, label);
      const result = buildRecommendations({mechanical});
      const ids = result.findings.filter(entry => entry.rung === 'airframe').map(entry => entry.id);
      assert.deepEqual(ids, ['AIRFRAME_ROTOR_NOT_COMPARED'], label);
      const blocker = result.findings.find(entry => entry.id === 'AIRFRAME_ROTOR_NOT_COMPARED');
      const rows = blocker.basis.filter(row =>
        row.label.startsWith('tone above the attention level for part of the range: ')
        && row.label.includes(`${tenths(peak.frequencyHz)} Hz on roll`));
      assert.equal(rows.length, 1, `${label}: ${JSON.stringify(blocker.basis.map(row => row.label))}`);
      assert.equal(rows[0].value, Math.round(peak.attentionWindowBandRmsDps * 1000) / 1000, rows[0].label);
    }
  });

/* --------------------------------------------------------------------------- */
/* Stage 2d follow-up, copy review of 3 October 2026, findings 2-8: what each  */
/* card says about a tone is what was measured, and what the card beside it    */
/* says about the same tone.                                                   */
/* --------------------------------------------------------------------------- */

const escapeForRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "29.3 Hz on yaw" as a card writes it, ready for a RegExp. */
const toneOn = (frequencyHz, axis) => `${escapeForRegExp(tenths(frequencyHz))} Hz on ${axis}`;

/**
 * One tone above the attention level for part of the range, as a card states it
 * in running text: "<f> Hz on <axis>..., at [least ]X deg/s while [it was ]above
 * [it|the attention level], for S% of SCOPE (A deg/s averaged over all of it)".
 * Null when the text does not state all of that for that tone.
 */
function aboveLevelStated(text, frequencyHz, axis) {
  const said = new RegExp(`${toneOn(frequencyHz, axis)}(?:(?!Hz on ).)*?, at (least )?([\\d.]+) deg/s `
    + 'while (?:it was )?above (?:it|the attention level), for (\\d+)% of (the range|the stretch it '
    + 'was (?:worst|measured) in) \\(([\\d.]+) deg/s averaged over all of it\\)').exec(text);
  return said
    ? {atLeast: Boolean(said[1]), size: Number(said[2]), share: Number(said[3]), scope: said[4],
      average: Number(said[5])}
    : null;
}

/**
 * The words of a card that say why a tone was not judged a steady one, up to and
 * including "to judge it as a steady tone", or null.
 */
function steadyToneSentence(text) {
  const ending = 'to judge it as a steady tone';
  const sentence = text.split('. ').find(entry => entry.includes(ending));
  return sentence ? sentence.slice(0, sentence.indexOf(ending) + ending.length) : null;
}

test('a ring sitting on a tone above the level for part of the flight names that tone as measured, '
  + 'and agrees with the airframe card on the same page, in the app\'s three-axis shape', async () => {
    // Finding 2. `tonesOf` admits a tone above the level for part of the range,
    // and a short burst, so the coincidence rule can see it — but the card that
    // refused the gain still said the axis "carries a persistent tone", gave the
    // tone's flight average as its size, and said "It did not reach the level
    // worth chasing on its own", beside the airframe card saying the same tone
    // measured at least 8.6 deg/s while it was there. Swept over the order the
    // ring sits on, its size and the seed, through the real analyser.
    let reached = 0;
    for (const [frequencyHz, headspeedRpm] of [[30, 1800], [25, 1500], [35, 2100]]) {
      for (const ringAmplitudeDps of [12, 14, 16]) {
        for (const seed of [4242, 7, 99]) {
          const records = buildStopFlight({axis: 'yaw', ...STOP_FAULTS.tooMuchD, frequencyHz,
            headspeedRpm, ringAmplitudeDps, seed});
          const series = seriesOf(records);
          const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
          const result = recommendThreeAxes(records, mechanical);
          const yawTones = assessAirframe(mechanical).axes.find(entry => entry.axis === 'yaw').tones;
          for (const card of result.findings.filter(entry => entry.id === 'OSCILLATION_MATCHES_AIRFRAME_TONE')) {
            const ringHz = card.basis.find(row => row.label === 'oscillation frequency after release').value;
            const tone = coincidentTone(yawTones, ringHz);
            const label = `${frequencyHz} Hz ring of ${ringAmplitudeDps} deg/s, seed ${seed}: `
              + `${JSON.stringify(tone)}\n${card.headline}\n${card.reasoning}`;
            assert.ok(tone, label);
            if (!tone.aboveLevelInPart) {
              continue;
            }
            reached += 1;
            assertSaidAsMeasured(card, tone, result, label);
          }
        }
      }
    }
    assert.ok(reached >= 12, `only ${reached} rings sat on a tone above the level in part`);

    // The ring sitting on a once-per-rev above the level in enough windows but
    // bunched into the first part of the flight: the reason the two cards give is
    // that one, not "too little of the flight". On yaw's unfiltered gyro only,
    // where the vibration check looks; the stop measurement reads the filtered one.
    // A ring small enough never to reach the level on its own, so the windows
    // that do are the block's.
    let bunched = 0;
    for (const strength of [2, 2.4]) {
      for (const untilShare of [0.3, 0.4]) {
        const plain = buildStopFlight({axis: 'yaw', ...STOP_FAULTS.tooMuchD, frequencyHz: 30,
          ringAmplitudeDps: 10, seed: 4242});
        const untilS = (plain.at(-1).timeUs / 1e6) * untilShare;
        const records = plain.map(record => {
          const at = record.timeUs / 1e6;
          const added = at < untilS ? strength * 8 * Math.SQRT2 * Math.sin(2 * Math.PI * 30 * at + 0.6) : 0;
          return {...record, raw: [record.raw[0], record.raw[1], record.raw[2] + added]};
        });
        const series = seriesOf(records);
        const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
        const result = recommendThreeAxes(records, mechanical);
        const yawTones = assessAirframe(mechanical).axes.find(entry => entry.axis === 'yaw').tones;
        const card = result.findings.find(entry => entry.id === 'OSCILLATION_MATCHES_AIRFRAME_TONE');
        const label = `a once-per-rev at ${strength}x over the first ${untilShare * 100}% under the ring: `
          + `${result.findings.map(entry => entry.id)}`;
        assert.ok(card, label);
        const tone = coincidentTone(yawTones,
          card.basis.find(row => row.label === 'oscillation frequency after release').value);
        assert.ok(tone?.aboveLevelInPart && !tone.aboveLevelCriteriaUnmet.includes('window-count'),
          `${label}: ${JSON.stringify(tone)}`);
        bunched += 1;
        assertSaidAsMeasured(card, tone, result, `${label}\n${card.headline}\n${card.reasoning}`);
        assert.match(card.reasoning, /too bunched together/, card.reasoning);
      }
    }
    assert.equal(bunched, 4);

    // A short BURST of the once-per-rev, under the persistence a steady tone needs,
    // with the D ring sitting on it on roll — sizes either side of "at least".
    let bursts = 0;
    for (const [whilePresent, atLeast] of [[16.4, false], [22, true], [9.1, false]]) {
      const records = buildStopFlight({axis: 'roll', ...STOP_FAULTS.tooMuchD, frequencyHz: 30, seed: 31});
      const mechanical = rollPeaks([{frequencyHz: 29.3, interpolatedFrequencyHz: 30.02, bandRmsDps: 2.3,
        attentionWindowBandRmsDps: whilePresent, attentionWindowSizeIsLowerBound: atLeast,
        attentionPersistenceRatio: 0.05, attentionSupportingWindowCount: 4, evaluatedWindowCount: 72,
        supportingWindowCount: 10, persistenceRatio: 0.14, attentionTemporalSpanRatio: 0.06,
        attentionOccupiedBucketCount: 1, attentionMaximumGapRatio: 0,
        attentionCriteriaUnmet: ['window-count', 'span', 'quarters'], attentionEligible: false,
        bandwidthHz: 2, harmonicMatch: ONCE_PER_REV}]);
      const result = recommendThreeAxes(records, mechanical);
      const card = result.findings.find(entry => entry.id === 'OSCILLATION_MATCHES_AIRFRAME_TONE'
        && entry.axis === 'roll');
      const label = `a burst at ${whilePresent} deg/s while present: ${result.findings.map(entry => entry.id)}`;
      assert.ok(card, label);
      const tone = assessAirframe(mechanical).axes.find(entry => entry.axis === 'roll').tones[0];
      assert.ok(tone.aboveLevelInPart && tone.persistenceRatio < TONE_LIMITS.persistenceRatioFloor, label);
      bursts += 1;
      assertSaidAsMeasured(card, tone, result, `${label}\n${card.headline}\n${card.reasoning}`);
    }
    assert.equal(bursts, 3);
  });

/**
 * The coincidence card about a tone above the level for part of the range says
 * what was measured — its size while there, for how long, its average — and the
 * same as the airframe card about that tone: the same numbers, and the same reason
 * it was not judged a steady tone.
 */
function assertSaidAsMeasured(card, tone, result, label) {
  const axis = card.axis;
  assert.doesNotMatch(`${card.headline} ${card.reasoning}`, /did not reach the level|persistent tone/i, label);
  const said = aboveLevelStated(card.headline, tone.frequencyHz, axis);
  assert.ok(said, `${label}: the headline does not state the tone as measured`);
  assert.equal(said.size, tenths(tone.aboveLevelBandRmsDps), label);
  assert.equal(said.atLeast, tone.sizeIsLowerBound, label);
  assert.equal(said.share, Math.round(tone.aboveLevelShare * 100), label);
  assert.equal(said.average, tenths(tone.bandRmsDps), label);
  const whilePresent = card.basis.find(row =>
    row.label === 'how large that tone was while above the attention level');
  assert.equal(whilePresent?.value, Math.round(tone.aboveLevelBandRmsDps * 1000) / 1000, label);

  // The airframe rung states the same tone, on its own card or in the basis of
  // whatever blocks there, and its numbers are the coincidence card's.
  const airframe = result.findings.filter(entry => entry.rung === 'airframe');
  const rows = airframe.flatMap(entry => entry.basis.map(row => row.label)).join(' | ');
  const there = aboveLevelStated(rows, tone.frequencyHz, axis);
  assert.ok(there, `${label}: the airframe rung does not list it: ${rows}`);
  assert.deepEqual(said, there, label);
  const inPart = airframe.find(entry => entry.id === 'AIRFRAME_TONE_ABOVE_LEVEL_IN_PART');
  if (inPart && new RegExp(`^A tone at ${escapeForRegExp(tenths(tone.frequencyHz))} Hz\\b.*? on ${axis}`
    + '(?: at \\d+ rpm)? while it was above').test(inPart.headline)) {
    const headline = rotorToneHeadline(inPart.headline);
    assert.deepEqual([headline.size, headline.share, headline.average], [said.size, said.share, said.average],
      `${label}\n${inPart.headline}`);
    // The same claim about why it is not a steady tone, in the same words.
    const why = steadyToneSentence(inPart.headline);
    assert.ok(why, inPart.headline);
    assert.ok(card.reasoning.includes(why), `${label}\nthe airframe card says: ${why}`);
  }
}

test('a tone matched to the tail rotor is judged against the logged tail speed, and said so on '
  + 'every card', async () => {
    // Finding 4. "outside what the logged head speed allows" was said of a tone
    // the analyser matched to the TAIL rotor, whose identity is judged against the
    // tail speed's own spread — on the coincidence card, on the airframe card's
    // headline and rows, and in the app's plain line read from its codes. A head
    // at 1300 rpm puts no main-rotor order near 30 Hz; the tail is swept across
    // and off its once-per-rev at the D ring's 30 Hz.
    const seen = {near: 0, established: 0};
    for (const tailRpm of [1795, 1800, 1805, 1885, 1890, 1895, 1900]) {
      for (const seed of [4242, 11]) {
        const records = buildStopFlight({axis: 'yaw', ...STOP_FAULTS.tooMuchD, frequencyHz: 30,
          ringAmplitudeDps: 14, headspeedRpm: 1300, seed});
        const series = seriesOf(records);
        const random = rng(seed + tailRpm);
        series.tailspeedRpm = Float64Array.from(records.map(() => tailRpm + (random() - 0.5) * 8));
        const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
        const tones = assessAirframe(mechanical).axes.find(entry => entry.axis === 'yaw').tones;
        const label = `tail at ${tailRpm} rpm, seed ${seed}: ${JSON.stringify(tones)}`;
        // The fixture is the case: the ring's tone is matched to the tail rotor,
        // above the level for part of the range, and to nothing on the main rotor.
        assert.ok(tones.length > 0 && tones.every(tone => tone.rotor === 'tail' && tone.aboveLevelInPart),
          label);
        const result = recommendThreeAxes(records, mechanical);
        const shape = result.findings.find(entry => entry.id === 'OSCILLATION_MATCHES_AIRFRAME_TONE');
        const inPart = result.findings.find(entry => entry.id === 'AIRFRAME_TONE_ABOVE_LEVEL_IN_PART');
        assert.ok(shape && inPart, `${label}: ${result.findings.map(entry => entry.id)}`);
        const text = [shape, inPart].map(findingText).join(' ');
        assert.doesNotMatch(text, /logged head speed/, `${label}\n${text}`);
        if (tones[0].orderEstablished === false) {
          seen.near += 1;
          assert.match(inPart.headline,
            /near the tail rotor's once-per-rev, outside what the logged tail speed allows/, inPart.headline);
          assert.match(shape.headline,
            /near the tail rotor's once-per-rev, outside what the logged tail speed allows/, shape.headline);
          assert.match(shape.reasoning, /outside what the logged tail speed allows/, shape.reasoning);
          // The cue the plain copy reads to say "tail" rather than "your rotor".
          assert.ok(inPart.codes.includes('ROTOR_ORDER_MATCH_NOT_ESTABLISHED')
            && inPart.codes.includes('NEAR_TAIL_ROTOR_ORDER'), `${label}: ${inPart.codes}`);
        } else {
          seen.established += 1;
          assert.doesNotMatch(text, /outside what the logged/, `${label}\n${text}`);
          assert.ok(!inPart.codes.includes('NEAR_TAIL_ROTOR_ORDER'), `${label}: ${inPart.codes}`);
        }
      }
    }
    assert.ok(seen.near >= 6 && seen.established >= 4, JSON.stringify(seen));
  });

test('the vibration card says a tone sits near the rotor\'s order only of the tones that do',
  async () => {
    // Finding 5. Where any one tone above the level was near the main rotor's
    // once- or twice-per-rev but outside what the logged head speed allows, the
    // card said "What it measured sits near the main rotor's once- or
    // twice-per-rev" of everything it measured — beside a once-per-rev on another
    // axis sitting exactly where the head speed puts it.
    const seen = {mixed: 0, allNear: 0};
    let configuration = 0;
    for (const [nearHz, nearAxis] of [[61.8, 'pitch'], [58.3, 'pitch'], [31.6, 'pitch'], [61.8, 'yaw'],
      [28.4, 'yaw']]) {
      for (const withOnOrder of [true, false]) {
        configuration += 1;
        const tones = [{hz: nearHz, amp: 1.8 * 8 * Math.SQRT2, axes: [nearAxis], phase: 0.5}];
        if (withOnOrder) {
          tones.push({hz: 30, amp: 2 * 8 * Math.SQRT2, axes: ['roll']});
        }
        const series = gyroWindow({seconds: 60, seed: 12 + configuration, tones});
        const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
        const attention = assessAirframe(mechanical).axes.flatMap(entry =>
          entry.tones.filter(tone => tone.attentionEligible));
        const label = `${nearHz} Hz on ${nearAxis}${withOnOrder ? ' beside a once-per-rev on roll' : ''}: `
          + JSON.stringify(attention.map(tone => [tone.axis, tone.frequencyHz, tone.order, tone.orderEstablished]));
        // The fixture is the case: everything above the level is named a main-rotor
        // 1/rev or 2/rev, the swept tone outside what the head speed allows.
        assert.ok(attention.every(tone => tone.rotor === 'main' && tone.order <= 2), label);
        const near = attention.filter(tone => tone.orderEstablished === false);
        const onOrder = attention.filter(tone => tone.orderEstablished === true);
        assert.ok(near.length > 0 && onOrder.length > 0 === withOnOrder, label);
        const card = buildRecommendations({mechanical}).findings
          .find(entry => entry.id === 'AIRFRAME_VIBRATION_PRESENT');
        assert.ok(card?.codes.includes('ROTOR_ORDER_NOT_ESTABLISHED'), `${label}: ${card?.codes}`);
        if (!withOnOrder) {
          // True of everything it measured, so said of everything.
          seen.allNear += 1;
          assert.match(card.reasoning, /^What it measured sits near the main rotor's once- or twice-per-rev, but outside what the logged head speed allows/,
            card.reasoning);
          continue;
        }
        seen.mixed += 1;
        assert.doesNotMatch(card.reasoning, /What it measured sits near/, `${label}\n${card.reasoning}`);
        assert.match(card.reasoning, /lines up with the main rotor's once- or twice-per-rev/, card.reasoning);
        // Each tone that is only near its order is named as near it; none that
        // sits on its order is.
        for (const tone of near) {
          assert.match(card.reasoning, new RegExp(`${toneOn(tone.frequencyHz, tone.axis)}, near the main rotor's `
            + '(?:once|twice)-per-rev'), `${label}\n${card.reasoning}`);
        }
        for (const tone of onOrder) {
          assert.doesNotMatch(card.reasoning, new RegExp(`${toneOn(tone.frequencyHz, tone.axis)}, near`),
            `${label}\n${card.reasoning}`);
        }
      }
    }
    assert.deepEqual(seen, {mixed: 5, allNear: 5});
  });

test('a tone above the level for part of the flight is said not to be steady for the reason it '
  + 'was not', async () => {
    // Finding 6. Every such tone was said to be "too little of the flight to judge
    // it as a steady tone" — including tones above the level in a quarter or more
    // of the analysis windows, which met the count and failed only on being
    // bunched into one part of the range. The reason is read from the criteria the
    // analyser published, and checked here against its published counts.
    const {minimumWelchWindows, minimumPersistenceRatio, minimumAttentionOccupiedBuckets,
      maximumAttentionUnsupportedGapRatio} = MECHANICAL_CONSTANTS;
    const shapes = [
      ['the first quarter', at => at < 15],
      ['the first 40%', at => at < 24],
      ['a block in the middle', at => at >= 20 && at < 38],
      ['the last 30%', at => at >= 42],
      ['2 s in every 10', at => at % 10 < 2],
      ['1.5 s in every 6', at => at % 6 < 1.5],
      ['a 3 s burst', at => at >= 20 && at < 23],
      ['a 5 s burst', at => at >= 30 && at < 35]
    ];
    const seen = {fewWindows: 0, bunched: 0};
    let configuration = 0;
    for (const [shape, on] of shapes) {
      for (const hz of [30, 31.6, 47]) {
        for (const strength of [1.4, 2.2]) {
          configuration += 1;
          const series = gyroWindow({seconds: 60, seed: 600 + configuration,
            tones: [{hz, amp: strength * 8 * Math.SQRT2, on, phase: configuration}]});
          const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
          const peak = mechanical.axes.find(axis => axis.axis === 'roll').peaks
            .find(entry => Math.abs(entry.frequencyHz - hz) <= 2 && entry.attentionWindowBandRmsDps >= 8);
          const label = `${hz} Hz at ${strength}x over ${shape}: ${JSON.stringify(peak)}`;
          assert.ok(peak, label);
          if (peak.attentionEligible) {
            continue;
          }
          const result = buildRecommendations({mechanical});
          const card = result.findings.find(entry => entry.id === 'AIRFRAME_TONE_ABOVE_LEVEL_IN_PART');
          assert.ok(card, `${label}: ${result.findings.map(entry => entry.id)}`);
          const row = card.basis.find(entry => entry.label.startsWith('tone above the attention level for '
            + 'part of the range: ') && entry.label.includes(`${tenths(peak.frequencyHz)} Hz on roll`));
          assert.ok(row, `${label}: ${card.basis.map(entry => entry.label)}`);
          const required = Math.max(minimumWelchWindows,
            Math.ceil(peak.evaluatedWindowCount * minimumPersistenceRatio));
          const unmet = {
            span: peak.attentionTemporalSpanRatio < 0.5,
            quarters: peak.attentionOccupiedBucketCount < minimumAttentionOccupiedBuckets,
            gap: peak.attentionMaximumGapRatio > maximumAttentionUnsupportedGapRatio
          };
          const why = steadyToneSentence(card.headline);
          if (peak.attentionSupportingWindowCount < required) {
            // Too few windows: "too little of the flight" is the reason, and it is true.
            seen.fewWindows += 1;
            assert.equal(why, 'That is too little of the flight to judge it as a steady tone', label);
            assert.match(row.source, /too few of them/, row.source);
            assert.doesNotMatch(row.source, /bunched/, row.source);
            assert.ok(card.codes.includes('TONE_ABOVE_LEVEL_IN_TOO_FEW_WINDOWS'), `${label}: ${card.codes}`);
            continue;
          }
          // Enough windows, bunched: said as that, naming each way it was bunched.
          seen.bunched += 1;
          assert.ok(unmet.span || unmet.quarters || unmet.gap, label);
          assert.doesNotMatch(card.headline, /too little of the flight/, `${label}\n${card.headline}`);
          assert.match(why ?? '', /^It was above that level in enough of the analysis windows, but they were too bunched together/,
            `${label}\n${card.headline}`);
          assert.equal(/spanning under half of the range/.test(why), unmet.span, `${label}\n${why}`);
          assert.equal(/fewer than three of its four quarters/.test(why), unmet.quarters, `${label}\n${why}`);
          assert.equal(/long gap/.test(why), unmet.gap, `${label}\n${why}`);
          assert.match(row.source, /bunched/, row.source);
          assert.doesNotMatch(row.source, /too few of them/, row.source);
          assert.ok(card.codes.includes('TONE_ABOVE_LEVEL_TOO_BUNCHED'), `${label}: ${card.codes}`);
        }
      }
    }
    assert.ok(seen.fewWindows >= 6 && seen.bunched >= 12, JSON.stringify(seen));
  });

test('every code the airframe gate blocks on is named on a card, and every tone above the level in '
  + 'part is on screen, when one stretch\'s copy of a tone is not the rotor\'s own', async () => {
    // Finding 7, fail-safe. In a window measured in stretches, the copies of one
    // tone were merged BEFORE the gate's outcome for each was read: a copy named
    // the once-per-rev but outside what the logged head speed allows — past the
    // ceiling, so the gate blocked on it as MECHANICAL_EVIDENCE_GATE_BLOCKED —
    // merged into a louder copy from the other stretch that IS the rotor's own, and
    // the result still blocked, with no card naming that code or the tone behind
    // it. Under the ceiling the same merge left the near copy on no card at all.
    const named = {MECHANICAL_EVIDENCE_NOT_MEASURED: 'BROADBAND_NOT_MEASURED'};
    const seen = {nearBlocks: 0, nearReported: 0};
    let configuration = 0;
    for (const nearHz of [28.4, 31.6]) {
      for (const [nearX, ownX] of [[2.4, 4.6], [3.6, 4.6], [4, 5.5]]) {
        for (const nearFirst of [true, false]) {
          configuration += 1;
          const first = at => at < 30;
          const second = at => at >= 150 && at < 180;
          const series = gyroWindow({seconds: 300, rateHz: 1007, seed: 30 + configuration, tones: [
            {hz: nearHz, amp: nearX * 8 * Math.SQRT2, on: nearFirst ? first : second, phase: 0.4},
            {hz: 30, amp: ownX * 8 * Math.SQRT2, on: nearFirst ? second : first, phase: 1.1}]});
          const mechanical = await analyzeMechanicalWindow(series, wholeRangeOf(series));
          const airframe = assessAirframe(mechanical);
          const copies = airframe.tonesAboveLevelInPart.filter(tone => tone.axis === 'roll');
          const label = `${nearHz} Hz at ${nearX}x, 30 Hz at ${ownX}x, the near one ${nearFirst ? 'first' : 'second'}: `
            + JSON.stringify(copies.map(tone => [tone.chunkRangeUs?.[0], tone.frequencyHz,
              tone.aboveLevelBandRmsDps, tone.order, tone.orderEstablished, tone.blocks]));
          // The fixture is the case: one copy of the once-per-rev per stretch, the
          // louder one the rotor's own, the other only near it.
          assert.equal(mechanical.chunks.length, 2, label);
          const near = copies.find(tone => tone.orderEstablished === false);
          const own = copies.find(tone => tone.orderEstablished === true);
          assert.ok(copies.length === 2 && near && own && near.order === 1 && own.order === 1
            && own.aboveLevelBandRmsDps > near.aboveLevelBandRmsDps, label);
          if (near.blocks === 'MECHANICAL_EVIDENCE_GATE_BLOCKED') {
            seen.nearBlocks += 1;
          } else {
            seen.nearReported += 1;
          }
          const result = buildRecommendations({mechanical});
          const cards = result.findings.filter(entry => entry.rung === 'airframe');
          const codes = new Set(cards.flatMap(entry => entry.codes));
          // The guarded property: every blocking code is named on a card...
          for (const code of result.gates.airframe.codes) {
            assert.ok(codes.has(named[code] ?? code), `${label}: the gate blocks on ${code} and no card `
              + `names it: ${cards.map(entry => `${entry.id} ${entry.codes}`).join(' | ')}`);
          }
          // ...and the copy only near the order is on screen as itself, never
          // spoken for by the rotor's own copy from the other stretch.
          const text = cards.map(findingText).join(' ');
          assert.match(text, new RegExp(`${toneOn(near.frequencyHz, 'roll')}, near the main rotor's once-per-rev, `
            + 'outside what the logged head speed allows'), `${label}\n${text}`);
        }
      }
    }
    assert.ok(seen.nearBlocks >= 4 && seen.nearReported >= 2, JSON.stringify(seen));
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
    // Three holds since round three, the fewest that earn it.
    const flown = simulateHoldFlight({
      gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400, ...THREE_HOLDS
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
/* 8d. HOLDS, SHAPES AND UNITS                                                 */
/*                                                                             */
/* Audit of 2 October 2026, stage 2. Four places this engine said something    */
/* the evidence had not earned: "Raise P" on a healthy tail whose 1% shortfall */
/* was a clean offset only because it was tiny; "the head speed wandered" for  */
/* one dropped RPM sample; a hunting band compared against a rate counted in   */
/* half-cycles; and "nothing calls for an I-term change" on a flight whose      */
/* holds were never judged at all.                                             */
/* =========================================================================== */

/**
 * A HEALTHY loop flown as big, fast stops.
 *
 * The gyro follows the command through a first-order lag and settles a small
 * fixed share short of it — per direction, because no real tail is perfectly
 * symmetric. Nothing here is a gain fault. What makes it a trap is arithmetic:
 * 20 ms after the stick reaches centre, a loop with a 40 ms lag is still turning
 * at exp(-20/40) of the command — about 200 deg/s of a 350 deg/s stop — so every
 * stop reads "did not stop", and a 1% shortfall is a perfectly CLEAN standing
 * offset, most of the tracking error, precisely because there is so little error.
 */
function laggedLoopFlight({
  amplitudesDps = [300, 350], lagsMs = [36, 40], shortfalls = [0.01, 0.012],
  stopsEachWay = 4, noiseDps = 0.3, seed = 7
} = {}) {
  const random = rng(seed);
  const index = AXIS_INDEX.yaw;
  const leadMs = 3000;
  const periodMs = 100 + 1500 + 20 + 2600;
  const totalMs = leadMs + periodMs * stopsEachWay * 2 + 1000;
  const records = [];
  let rate = 0;
  let side = 0;
  for (let ms = 0; ms < totalMs; ms += 1) {
    const which = Math.floor((ms - leadMs) / periodMs);
    const local = ms - leadMs - which * periodMs;
    let command = 0;
    if (ms >= leadMs && which < stopsEachWay * 2) {
      side = which % 2;
      const peak = (side === 0 ? 1 : -1) * amplitudesDps[side];
      if (local < 100) {
        command = peak * (local / 100);
      } else if (local < 1600) {
        command = peak;
      } else if (local < 1620) {
        command = peak * (1 - (local - 1600) / 20);
      }
    }
    // One sample of a first-order lag (time constant lagsMs, 1 ms steps) towards
    // the command less this direction's standing shortfall.
    rate += (command * (1 - shortfalls[side]) - rate) / lagsMs[side];

    const setpoint = [0, 0, 0];
    const gyro = [0, 0, 0];
    setpoint[index] = command;
    gyro[index] = rate + (random() - 0.5) * 2 * noiseDps;
    records.push({
      timeUs: ms * 1000, setpoint, gyro, raw: [...gyro], terms: [0, 0, 0],
      headspeed: 1800, collective: 0, vbat: 24
    });
  }
  return records;
}

test('a healthy, lagging tail with a 1% shortfall is not told to raise P', () => {
  // THE CONTROLS FIRST, because a refusal proves nothing if the fixture could
  // never have reached the instruction. The same lag and the same stops with a
  // shortfall of 6% — a twentieth of the command and more — still earn "Raise
  // P", with every gate passing. So does 8-9%, and the same 8-9% stops earning
  // it the moment the offset is buried under a gyro noise floor larger than it.
  const sixPercent = recommendFor(
    laggedLoopFlight({shortfalls: [0.06, 0.06]}), 'yaw');
  assert.deepEqual(adjustmentIds(sixPercent), ['P_TOO_LOW'],
    'the 6% control must earn "Raise P", or nothing below can fail: '
    + sixPercent.findings.map(entry => entry.id).join(', '));

  const eightPercent = laggedLoopFlight({shortfalls: [0.08, 0.09]});
  assert.deepEqual(adjustmentIds(recommendFor(eightPercent, 'yaw')), ['P_TOO_LOW']);

  // THE DEFECT. Healthy loops at the lags a real tail has, stopped hard. The
  // first four are the cases the audit reproduced as "Raise yaw P", actNow, with
  // all five gates passing. 4.5% is just under the floor; 6%/4% is a tail whose
  // WORSE side clears it and whose better side does not — the smallest side is
  // the one that has to carry the claim, because "it sat below the command"
  // must be true in both directions.
  const healthy = [
    ['36/40 ms lag, 1.0/1.2%', {lagsMs: [36, 40], shortfalls: [0.01, 0.012]}, true],
    ['30/36 ms lag, 1.0/1.2%', {lagsMs: [30, 36], shortfalls: [0.01, 0.012]}, true],
    ['25/30 ms lag, 1.0/1.2%', {lagsMs: [25, 30], shortfalls: [0.01, 0.012]}, true],
    ['40/44 ms lag, 1%, 350 both ways',
      {lagsMs: [40, 44], shortfalls: [0.01, 0.01], amplitudesDps: [350, 350]}, true],
    ['36/40 ms lag, 4.5% both ways', {shortfalls: [0.045, 0.045]}, true],
    ['36/40 ms lag, 6% one way and 4% the other', {shortfalls: [0.06, 0.04]}, false]
  ];
  for (const [label, setup, gatesPass] of healthy) {
    const result = recommendFor(laggedLoopFlight(setup), 'yaw');
    const ids = result.findings.map(entry => entry.id);
    if (gatesPass) {
      assert.equal(result.gates.axes.yaw.gates.gainInterlocks.tracking.mayRecommend, true,
        `${label}: the gates must pass, or the refusal below is the gates and not the rule`);
    }
    assert.deepEqual(adjustmentIds(result), [], `${label}: ${ids.join(', ')}`);
    assert.ok(!result.withheld.some(entry => entry.findingId === 'P_TOO_LOW'),
      `${label}: not even as a diagnosis held back by a gate`);

    const finding = result.findings.find(entry => entry.id === 'AXIS_DOES_NOT_ARREST');
    assert.ok(finding, `${label}: expected the next-flight finding, got ${ids.join(', ')}`);
    assert.equal(finding.kind, 'next-flight');
    assert.equal(finding.confidence, 'low');
    assert.equal(finding.direction, null);
    assert.equal(finding.actNow, false);
    assert.ok(finding.codes.includes('STANDING_OFFSET_TOO_SMALL_FOR_P'),
      `${label}: ${finding.codes}`);
    // The offset IS clean here, so the sentence for the other road would be false.
    assert.doesNotMatch(finding.reasoning, /not a clean standing offset/,
      `${label}: ${finding.reasoning}`);
    const smallest = finding.basis.find(entry => /smallest shortfall/.test(entry.label));
    assert.ok(smallest && smallest.value < 0.05,
      `${label}: the number that sent it here must be shown: `
      + JSON.stringify(finding.basis.map(entry => [entry.label, entry.value])));
  }

  // AND THE OFFSET MUST STAND ABOVE THE NOISE. The 8-9% control above, flown
  // over a gyro whose own noise floor is larger than the offset: the same
  // stops, and nothing about them can now be read as a measured shortfall.
  const buried = buildRecommendations({
    records: eightPercent,
    mechanical: cleanAirframe(),
    axes: {yaw: {...analyseAxisEvidence(eightPercent, 'yaw'), records: eightPercent}},
    axisSummaries: {yaw: {gyroHighFrequencyRmsDps: 40}}
  });
  assert.deepEqual(adjustmentIds(buried), [],
    'a standing offset smaller than the gyro noise floor is not a measured offset');
  assert.ok(!buried.withheld.some(entry => entry.findingId === 'P_TOO_LOW'));
  const buriedFinding = buried.findings.find(entry => entry.id === 'AXIS_DOES_NOT_ARREST');
  assert.ok(buriedFinding, buried.findings.map(entry => entry.id).join(', '));
  assert.ok(buriedFinding.codes.includes('STANDING_OFFSET_WITHIN_NOISE_FLOOR'),
    `${buriedFinding.codes}`);
  assert.ok(!buriedFinding.codes.includes('STANDING_OFFSET_TOO_SMALL_FOR_P'),
    'an 8-9% shortfall is over the floor; only the noise sent it here');

  // EACH ROAD SAYS ITS OWN THING (round two of the review). The noise road is
  // an 8-9% shortfall of 24-31 deg/s; "it followed the stick too closely" and "a
  // shortfall that small" are false about it, and its own basis says so.
  const buriedText = `${buriedFinding.headline} ${buriedFinding.reasoning}`;
  assert.doesNotMatch(buriedText, /too closely|that small|so little error/i, buriedText);
  const smallest = buriedFinding.basis.find(entry => /smallest shortfall/.test(entry.label));
  const percent = Math.round(smallest.value * 1000) / 10;
  assert.ok(buriedText.includes(`${percent}%`),
    `the noise road must state the shortfall it measured (${percent}%): ${buriedText}`);
  assert.match(buriedText, /\b40 deg\/s\b/, 'and the noise it was compared with');
  // The offset is an average over the held part of each stop; the noise floor is
  // a sample-to-sample spread. Saying so is the honest form of that comparison.
  assert.match(buriedFinding.reasoning, /averag/i, buriedFinding.reasoning);
  assert.match(buriedFinding.reasoning, /sample/i, buriedFinding.reasoning);

  // The too-small road keeps its own words, which ARE true of a 1% shortfall.
  const tiny = recommendFor(laggedLoopFlight(), 'yaw').findings
    .find(entry => entry.id === 'AXIS_DOES_NOT_ARREST');
  assert.match(tiny.headline, /too closely/, tiny.headline);
  assert.match(tiny.reasoning, /only (?:0\.\d|1(?:\.\d)?)% below/, tiny.reasoning);
  assert.doesNotMatch(tiny.reasoning, /noise on this axis/, tiny.reasoning);

  // Both at once: a 1% shortfall under a 40 deg/s floor says both, too-small first.
  const tinyRecords = laggedLoopFlight();
  const both = buildRecommendations({
    records: tinyRecords,
    mechanical: cleanAirframe(),
    axes: {yaw: {...analyseAxisEvidence(tinyRecords, 'yaw'), records: tinyRecords}},
    axisSummaries: {yaw: {gyroHighFrequencyRmsDps: 40}}
  }).findings.find(entry => entry.id === 'AXIS_DOES_NOT_ARREST');
  assert.deepEqual(both.codes.filter(code => code.startsWith('STANDING_OFFSET_')),
    ['STANDING_OFFSET_TOO_SMALL_FOR_P', 'STANDING_OFFSET_WITHIN_NOISE_FLOOR']);
  assert.match(both.reasoning, /only (?:0\.\d|1(?:\.\d)?)% below/, both.reasoning);
  assert.match(both.reasoning, /noise/, both.reasoning);
});

test('one dropped head-speed sample is a logging fault, not a wandering governor', () => {
  // A closed loop with no integrator against a standing torque — the fixture
  // that earns "Raise yaw I" — flown as four long hovers split by short pulses.
  const stops = [1, 12, 23, 34].map(atS => ({atS, amplitudeDps: 120, holdS: 0.3}));
  const flown = simulateHoldFlight({
    gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400, durationS: 46, stops
  });
  const steady = recommendFor(flown, 'yaw');
  assert.equal(steady.gates.holds.yaw.holdCount, 4, 'the fixture must yield four holds');
  assert.deepEqual(adjustmentIds(steady), ['I_TOO_LOW'],
    'with the rotor steady the fixture must earn "Raise yaw I", or this proves nothing');

  // One RPM sample lost inside the second hold. Three holds measured, one
  // refused for a reading that was not there.
  const glitch = flown.map((record, at) => (at === 18_000
    ? {...record, headspeed: Number.NaN} : record));
  const result = recommendFor(glitch, 'yaw');
  const ids = result.findings.map(entry => entry.id);
  assert.equal(result.gates.holds.yaw.holdCount, 3);
  assert.deepEqual({...result.gates.holds.yaw.evidence.rejectedHoldCounts},
    {HOLD_HEADSPEED_INVALID: 1}, 'the fixture must lose exactly one hold, to the reading');

  assert.ok(!ids.includes('HEADSPEED_MOVED_DURING_STEADY_FLIGHT'),
    `one missing sample is not the head speed moving: ${ids.join(', ')}`);
  assert.equal(result.gates.headspeed.status, 'permitted', `${result.gates.headspeed.codes}`);
  assert.ok(!result.findings.some(entry => entry.rung === 'headspeed' && entry.kind === 'blocker'));
  // And it does not suppress what the other three holds earned.
  assert.deepEqual(adjustmentIds(result), ['I_TOO_LOW'], ids.join(', '));
  assert.ok(!result.withheld.some(entry => entry.reason === 'BLOCKER_ABOVE'));

  // Reported, as what it is.
  assert.equal(result.gates.headspeed.measured.holdsRejectedForHeadspeed, 0,
    'a dropout is not counted as the head speed moving');
  assert.equal(result.gates.headspeed.measured.holdsRejectedForHeadspeedReading, 1);
  const dropout = result.findings.find(entry => entry.id === 'HEADSPEED_READING_DROPPED_OUT');
  assert.ok(dropout, `the dropout must be reported separately: ${ids.join(', ')}`);
  assert.equal(dropout.kind, 'observation');
  assert.equal(dropout.direction, null);
  assert.doesNotMatch(`${dropout.headline} ${dropout.reasoning}`, /wander|was (?:still )?moving/i);
  assert.match(`${dropout.headline} ${dropout.reasoning}`, /sensor|logging|reading/i);

  // CONTROL: the governor really moving through three of the four holds still
  // blocks every gain, through the same entry point.
  const hunting = flown.map(record => {
    const seconds = record.timeUs / 1e6;
    const inside = (seconds > 14 && seconds < 22) || (seconds > 25 && seconds < 33)
      || (seconds > 36 && seconds < 45);
    return inside
      ? {...record, headspeed: 1800 * (1 + 0.08 * Math.sin(2 * Math.PI * 0.2 * seconds))}
      : record;
  });
  const blocked = recommendFor(hunting, 'yaw');
  assert.deepEqual({...blocked.gates.holds.yaw.evidence.rejectedHoldCounts},
    {HOLD_HEADSPEED_UNSTABLE: 3});
  const moved = blocked.findings.find(entry => entry.id === 'HEADSPEED_MOVED_DURING_STEADY_FLIGHT');
  assert.ok(moved, blocked.findings.map(entry => entry.id).join(', '));
  assert.equal(moved.kind, 'blocker');
  assert.match(moved.headline, /3 of the 4/,
    'the share it claims must be the share it measured: ' + moved.headline);
});

test('the head-speed cost counts the holds that were measured, and needs more than one', () => {
  const records = [];
  for (let step = 0; step < 20_000; step += 1) {
    records.push({timeUs: step * 1000, headspeed: 1800 + Math.sin(step / 500) * 5});
  }
  const verdict = (rejected, accepted) => assessHeadspeed(records, {
    holdRejections: {yaw: rejected}, acceptedHolds: {yaw: accepted}
  });

  // One segment is not "most" of anything.
  assert.equal(verdict({HOLD_HEADSPEED_UNSTABLE: 1}, 0).status, 'permitted');
  // A moving head speed in one hold of four did not cost the flight its holds.
  assert.equal(verdict({HOLD_HEADSPEED_UNSTABLE: 1}, 3).status, 'permitted');
  // A reading that dropped out says nothing about the governor, however many.
  assert.equal(verdict({HOLD_HEADSPEED_INVALID: 4}, 0).status, 'permitted');
  // Three of four is the governor.
  const most = verdict({HOLD_HEADSPEED_UNSTABLE: 3}, 1);
  assert.equal(most.status, 'blocked');
  assert.ok(most.codes.includes('HEADSPEED_COST_THIS_FLIGHT_ITS_HOLDS'));
  assert.equal(most.measured.holdsEvaluated, 4);
  // Added in round two: a segment refused for the other axes moving was refused
  // BEFORE its head speed was looked at, so it is not a segment that held. One
  // that moved beside one refused for off-axis input is one segment read —
  // under the minimum, and never "half of them moved".
  const offAxis = verdict({HOLD_HEADSPEED_UNSTABLE: 1, HOLD_OFF_AXIS_INPUT: 1}, 0);
  assert.equal(offAxis.status, 'permitted', `${offAxis.codes}`);
  assert.equal(offAxis.measured.holdsEvaluated, 1);

  // The same, through the window-shaped call buildRecommendations makes: one
  // hover all three axes refused for the head speed moving, then a pirouette
  // that roll and pitch refused for the yaw input before reading the head speed,
  // and a third stretch whose only reading was missing. One segment read.
  const windows = [
    ...['roll', 'pitch', 'yaw'].map(axis => ({axis, startTimeUs: 1_000_000, endTimeUs: 9_000_000,
      outcome: 'HOLD_HEADSPEED_UNSTABLE'})),
    {axis: 'roll', startTimeUs: 10_000_000, endTimeUs: 16_000_000, outcome: 'HOLD_OFF_AXIS_INPUT'},
    {axis: 'pitch', startTimeUs: 10_000_000, endTimeUs: 16_000_000, outcome: 'HOLD_OFF_AXIS_INPUT'},
    {axis: 'yaw', startTimeUs: 17_000_000, endTimeUs: 19_500_000, outcome: 'HOLD_HEADSPEED_INVALID'}
  ];
  const located = assessHeadspeed(records, {holdWindows: windows});
  assert.equal(located.measured.segmentCounting, 'physical');
  assert.equal(located.measured.holdsEvaluated, 1, JSON.stringify(located.measured));
  assert.equal(located.measured.holdsRejectedForHeadspeed, 1);
  assert.equal(located.measured.holdsRejectedForHeadspeedReading, 1);
  assert.equal(located.status, 'permitted',
    'a hover and a pirouette whose head speed was never read are not two segments of evidence');
  // And with a second hover that held, it IS two segments read, half moved: blocked.
  const twoHovers = assessHeadspeed(records, {holdWindows: [...windows,
    ...['roll', 'pitch', 'yaw'].map(axis => ({axis, startTimeUs: 21_000_000, endTimeUs: 29_000_000,
      outcome: 'accepted'}))]});
  assert.equal(twoHovers.measured.holdsEvaluated, 2);
  assert.equal(twoHovers.status, 'blocked');
});

test('an I-term oscillation the bluntest filter can still see is voted on by every filter',
  () => {
    // A box average of length L passes an oscillation well below 0.443/L — the
    // 300 ms filter's corner is 1.48 Hz. The crossing rate counts HALF-cycles, so
    // a 1.2 Hz oscillation crosses 2.4 times a second, and comparing that count
    // with the corner made filters abstain from oscillations they could see.
    for (const hz of [0.8, 1.0, 1.2, 1.4]) {
      const hold = assessHoldIndication(simulateHoldFlight({
        axis: 'yaw', gains: {kp: 0.105, ki: 0.05, kd: 0.0014},
        externalTorqueDps2: 1000, externalTorqueHz: hz, durationS: 30
      }), 'yaw');
      assert.equal(hold.shippedIndication, 'decrease',
        `${hz} Hz: the fixture must reach the abstention rule at all`);
      assert.ok(Math.abs(hold.observedCrossingRateHz / 2 - hz) < 0.15,
        `${hz} Hz: the crossing rate must be two per cycle, read ${hold.observedCrossingRateHz}`);
      assert.equal(hold.sweepAbstainedFilterCount, 0,
        `${hz} Hz is below every corner in HOLD_SWEEP, so no filter may abstain`);
      assert.equal(hold.sweepRunCount,
        HOLD_SWEEP.huntingSmoothingUs.length * HOLD_SWEEP.huntingRippleDps.length);
    }

    // And a 2.5 Hz oscillation, inside the 0.3-3 Hz band, is read as one — and
    // the two filters whose corners sit below it (222 and 300 ms) abstain.
    const fast = assessHoldIndication(simulateHoldFlight({
      axis: 'yaw', gains: {kp: 0.105, ki: 0.05, kd: 0.0014},
      externalTorqueDps2: 1000, externalTorqueHz: 2.5, durationS: 30
    }), 'yaw');
    assert.equal(fast.shippedIndication, 'decrease',
      '2.5 Hz is inside the band an I term can hunt in: ' + fast.codes.join(', '));
    assert.equal(fast.sweepAbstainedFilterCount, 2);
  });

test('an error that swings outside the I-term band is not described as one that did not move',
  () => {
    // With the band in the right units a 0.2 Hz wander is BELOW it — the pilot,
    // the wind, a governor — and is rightly not blamed on the I term. A 3.6 Hz
    // one is above it. But the all-clear both reach said the aircraft "neither
    // sat off the commanded rate nor wandered slowly either side of it", over
    // holds whose error swung several deg/s. That sentence cannot stand on the
    // trace.
    //
    // UPDATED in round two of the review. This test first pinned the 0.2 Hz
    // wander to I_TERM_WITHIN_TOLERANCE with reworded reasoning — an all-clear
    // card with nothing to fly, over a wobble the pilot can see, where before
    // the units fix the same flight reached SLOW_WANDER_NOT_FROM_THE_I_TERM with
    // the governor, the belt and the wind named and a calm hold to fly. The pin
    // was the defect. A wander BELOW the band is now that next-flight finding; a
    // fast oscillation ABOVE it averages out of a hold's mean, leaves the I term
    // positively judged, and keeps the all-clear with the true sentence.
    for (const [hz, torque] of [[0.12, 1000], [0.2, 1000], [0.2, 3000], [0.26, 1000]]) {
      const records = simulateHoldFlight({
        axis: 'yaw', gains: {kp: 0.105, ki: 0.05, kd: 0.0014},
        externalTorqueDps2: torque, externalTorqueHz: hz, durationS: 30
      });
      const result = recommendFor(records, 'yaw');
      const hold = result.gates.holds.yaw;
      assert.ok(hold.evidence.summary.meanErrorRippleRmsDps > 4,
        `${hz} Hz: the fixture must genuinely swing, read ${hold.evidence.summary.meanErrorRippleRmsDps}`);
      assert.ok(hold.codes.includes('SLOW_MOVEMENT_BELOW_I_TERM_BAND'), `${hz} Hz: ${hold.codes}`);
      const ids = result.findings.map(entry => entry.id);
      assert.ok(!ids.includes('I_TERM_WITHIN_TOLERANCE'), `${hz} Hz: ${ids.join(', ')}`);
      const said = result.findings.find(entry => entry.id === 'SLOW_WANDER_NOT_FROM_THE_I_TERM');
      assert.ok(said, `${hz} Hz: ${ids.join(', ')}`);
      assert.equal(said.kind, 'next-flight');
      assert.match(said.reasoning, /slower than the 0\.3.3 Hz band/, `${hz} Hz: ${said.reasoning}`);
      assert.match(said.reasoning, /\d+(?:\.\d+)? Hz/, said.reasoning);
      assert.deepEqual(adjustmentIds(result), []);
    }
    // UPDATED AGAIN in round three: the pin above it was the defect too. A fast
    // oscillation dominates the crossing count, so whatever moved slower under
    // it was never measured, and the all-clear these flights reached said
    // "Underneath it there was no standing error and no slow wander" about a
    // band nobody had looked at. They are now not judged, and say why.
    for (const [hz, torque] of [[3.6, 3000], [4.5, 3000]]) {
      const records = simulateHoldFlight({
        axis: 'yaw', gains: {kp: 0.105, ki: 0.05, kd: 0.0014},
        externalTorqueDps2: torque, externalTorqueHz: hz, durationS: 30
      });
      const result = recommendFor(records, 'yaw');
      const hold = result.gates.holds.yaw;
      assert.ok(hold.evidence.summary.meanErrorRippleRmsDps > 4,
        `${hz} Hz: the fixture must genuinely swing, read ${hold.evidence.summary.meanErrorRippleRmsDps}`);
      const ids = result.findings.map(entry => entry.id);
      assert.ok(!ids.includes('I_TERM_WITHIN_TOLERANCE'), `${hz} Hz: ${ids.join(', ')}`);
      const said = result.findings.find(entry => entry.id === 'I_TERM_NOT_JUDGED');
      assert.ok(said, `${hz} Hz: ${ids.join(', ')}`);
      assert.ok(said.codes.includes('OSCILLATION_ABOVE_I_TERM_BAND'), `${hz} Hz: ${said.codes}`);
      assert.equal(said.kind, 'next-flight');
      assert.doesNotMatch(said.reasoning, /nor wandered|no slow wander/, `${hz} Hz: ${said.reasoning}`);
      assert.match(said.reasoning, /faster than the 0\.3.3 Hz band/, `${hz} Hz: ${said.reasoning}`);
      assert.deepEqual(adjustmentIds(result), []);
    }

    // CONTROL: a nominal loop whose error really is quiet keeps the plain sentence.
    const quiet = recommendFor(simulateHoldFlight({gains: HOLD_NOMINAL, disturbanceDps2: 200}), 'yaw');
    const plain = quiet.findings.find(entry => entry.id === 'I_TERM_WITHIN_TOLERANCE');
    assert.match(plain.reasoning, /neither sat off the commanded rate nor wandered/);
    assert.ok(!plain.codes.includes('SLOW_MOVEMENT_BELOW_I_TERM_BAND'));
  });

test('a flight whose holds mix hover and steady turns is not given an I-term all-clear', () => {
  // The aircraft has NO integrator and a standing torque to hold against —
  // the fixture that earns "Raise yaw I" — and the pilot flew it the way
  // pilots fly: hovers, and two steady pirouettes. Zero-rate holds and
  // steady-rate holds test the I term in different regimes, so the engine
  // judges neither, which is right. Saying "nothing calls for an I-term
  // change" about holds it never judged is not.
  const lead = {atS: 1, amplitudeDps: 120, holdS: 0.3};
  const mixed = simulateHoldFlight({
    gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400, durationS: 60,
    stops: [lead, {atS: 13, amplitudeDps: 60, holdS: 11}, {atS: 37, amplitudeDps: -60, holdS: 11}]
  });
  const result = recommendFor(mixed, 'yaw');
  const ids = result.findings.map(entry => entry.id);
  const summary = result.gates.holds.yaw.evidence.summary;
  assert.ok(summary.zeroHoldCount >= 2 && summary.sustainedHoldCount >= 2,
    `the fixture must mix the two kinds: ${summary.zeroHoldCount} zero, `
    + `${summary.sustainedHoldCount} sustained`);
  assert.ok(result.gates.holds.yaw.codes.includes('HOLD_KIND_MISMATCH'));

  assert.ok(!ids.includes('I_TERM_WITHIN_TOLERANCE'),
    `an all-clear without a judgement: ${ids.join(', ')}`);
  assert.deepEqual(adjustmentIds(result), []);
  const said = result.findings.find(entry => entry.id === 'I_TERM_HOLDS_MIXED');
  assert.ok(said, `the pilot must be told why, and what to fly: ${ids.join(', ')}`);
  assert.equal(said.kind, 'next-flight');
  assert.equal(said.confidence, 'low');
  assert.equal(said.direction, null);
  assert.equal(said.actNow, false);
  assert.match(said.headline, /hover|zero rate|still/i);
  assert.match(said.headline, /turn|pirouette|steady rate/i);
  assert.doesNotMatch(`${said.headline} ${said.reasoning}`, /nothing .*calls for/i);
  // What to fly: two or more of ONE kind, each long enough to measure.
  assert.match(said.confirm, /\b2\b|two/i);
  assert.match(said.confirm, /hover/i);
  assert.match(said.confirm, /pirouette|turn/i);
  assert.match(said.confirm, /5 s/);
  assert.ok(said.basis.some(entry => /zero rate/.test(entry.label)
    && entry.value === summary.zeroHoldCount), JSON.stringify(said.basis));
  assert.ok(said.basis.some(entry => /steady rate/.test(entry.label)
    && entry.value === summary.sustainedHoldCount));

  // CONTROL: the same aircraft, same schedule, with the pirouettes cut to short
  // pulses so every hold is a hover, earns "Raise yaw I". That is what the mixed
  // flight's all-clear was hiding.
  const hovers = simulateHoldFlight({
    gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400, durationS: 60,
    stops: [lead, {atS: 13, amplitudeDps: 120, holdS: 0.3}, {atS: 37, amplitudeDps: -120, holdS: 0.3}]
  });
  assert.deepEqual(adjustmentIds(recommendFor(hovers, 'yaw')), ['I_TOO_LOW']);
});

/* =========================================================================== */
/* 8e. HOLDS, ROUND TWO                                                        */
/*                                                                             */
/* Adversarial review of 8d, 2 October 2026. Halving the crossing rate was     */
/* right, and it opened four new ways to say something unearned: "Raise I" on  */
/* a healthy integrator pushed by a slow torque, "nothing calls for an I-term  */
/* change" over both hold signatures at once, a head-speed share that counted  */
/* one hover three times, and "the head speed held" over the one segment that  */
/* said it did not.                                                            */
/* =========================================================================== */

/** Every code that says the I-term question was NOT answered with an all-clear. */
const I_TERM_TROUBLE_CODES = Object.freeze([
  'STEADY_STATE_ERROR_PRESENT',
  'STEADY_STATE_ERROR_DRIFTING',
  'LOW_FREQUENCY_HUNTING',
  'CONFLICTING_HOLD_SIGNATURES',
  'SLOW_MOVEMENT_BELOW_I_TERM_BAND',
  'STANDING_ERROR_NOT_CLEAR_OF_SLOW_MOVEMENT',
  'I_TERM_DOES_NOT_OSCILLATE_WITH_THE_ERROR',
  'I_TERM_TOO_SMALL_A_SHARE_OF_THE_OUTPUT',
  'I_TERM_NOT_LOGGED',
  'HOLD_KIND_MISMATCH',
  'HOLD_VERDICT_FLIPS_ACROSS_SWEEP',
  'HOLD_SWEEP_COULD_NOT_OBSERVE_THE_OSCILLATION',
  'STANDING_ERROR_WITH_WOUND_UP_I_TERM',
  'STANDING_ERROR_WITH_A_PINNED_I_TERM',
  'INSUFFICIENT_HOLD_SEGMENTS',
  // Round three. A fast oscillation dominates the crossing count, so nothing
  // slower was measured under it; a slow ripple no larger than the noise was
  // not separated from it; and a standing error is read only when it sits on
  // the same side, clear of its own movement, in three or more holds.
  'OSCILLATION_ABOVE_I_TERM_BAND',
  'SLOW_RIPPLE_NOT_CLEAR_OF_NOISE',
  'STANDING_ERROR_NOT_CLEAR_IN_EVERY_HOLD',
  'STANDING_ERROR_CHANGES_SIDE_BETWEEN_HOLDS',
  'STANDING_ERROR_FOLLOWS_COMMAND_DIRECTION',
  'TOO_FEW_HOLDS_FOR_A_STANDING_ERROR',
  // Re-review of round three, 3 October 2026: a standing error beside a band a
  // cover hid, and the side a turn-following error was on.
  'STANDING_ERROR_WITH_UNMEASURED_BAND',
  'RATE_SHORT_OF_COMMAND_IN_EVERY_TURN',
  'RATE_PAST_COMMAND_IN_EVERY_TURN'
]);

/** The finding the I-term question produced on `axis`, whatever it was. */
function iTermFinding(result, axis) {
  return result.findings.find(entry => entry.axis === axis
    && (entry.rung === 'gain-I' || entry.id === 'SUSPECTED_MECHANICAL_BIND'
      || /^(?:I_TERM_|HOLD_EVIDENCE_|NO_HOLD_)/.test(entry.id))) ?? null;
}

/**
 * A hold layout as a command schedule, for `simulateHoldFlight({commands})`
 * (2 October 2026, round three). `holdsS` are the hold lengths in seconds,
 * after a lead-in pulse at 1 s. At zero rate the holds are separated by 0.4 s
 * pulses at 120 deg/s — a pilot blipping the stick between still hovers. At a
 * steady rate each hold is a turn at `rateDps` in `directions[i]`, with 0.4 s
 * back at zero between them.
 */
function holdLayout({holdsS, kind = 'zero', directions = null, rateDps = 60}) {
  const commands = [{atS: 1, untilS: 1.4, dps: 120}];
  let atS = kind === 'sustained' ? 1.8 : 1.4;
  let durationS = atS;
  holdsS.forEach((lengthS, at) => {
    const endS = atS + lengthS;
    if (kind === 'sustained') {
      commands.push({atS, untilS: endS, dps: (directions?.[at] ?? 1) * rateDps});
      durationS = endS + 0.4;
    } else {
      if (at < holdsS.length - 1) {
        commands.push({atS: endS, untilS: endS + 0.4, dps: 120});
      }
      durationS = endS;
    }
    atS = endS + 0.4;
  });
  return {commands, durationS};
}

/**
 * One flight on all three axes, in the shape `ui/app.mjs` hands the engine:
 * each axis its own closed loop with its own gains and disturbances, and each
 * axis's records carrying THAT axis's P/I/D terms, as `buildAnalysisRecords`
 * builds them per axis. `setups[axis]` is passed to `simulateHoldFlight`.
 */
function threeAxisRecords(setups, durationS, headspeed = null) {
  const per = {};
  for (const axis of AXES_IN_ORDER) {
    per[axis] = simulateHoldFlight({axis, durationS, ...setups[axis]});
  }
  const byAxis = {};
  for (const axis of AXES_IN_ORDER) {
    byAxis[axis] = per[axis].map((record, at) => ({
      ...record,
      setpoint: [per.roll[at].setpoint[0], per.pitch[at].setpoint[1], per.yaw[at].setpoint[2]],
      gyro: [per.roll[at].gyro[0], per.pitch[at].gyro[1], per.yaw[at].gyro[2]],
      raw: [per.roll[at].raw[0], per.pitch[at].raw[1], per.yaw[at].raw[2]],
      headspeed: headspeed ? headspeed(record.timeUs / 1e6) : record.headspeed
    }));
  }
  return byAxis;
}

/** `buildRecommendations` over `threeAxisRecords`, every axis, as the app calls it. */
function recommendEachAxis(byAxis, mechanical = cleanAirframe()) {
  const axes = {};
  const axisSummaries = {};
  for (const axis of AXES_IN_ORDER) {
    axes[axis] = {...analyseAxisEvidence(byAxis[axis], axis), records: byAxis[axis]};
    axisSummaries[axis] = {gyroHighFrequencyRmsDps: 0.5};
  }
  return buildRecommendations({records: byAxis.yaw, mechanical, axes, axisSummaries});
}

/** Whether "Raise I" was reached on `axis`, shown or held back behind another change. */
function raisedIOn(result, axis) {
  return result.findings.some(entry => entry.id === 'I_TOO_LOW' && entry.axis === axis)
    || result.withheld.some(entry => entry.findingId === 'I_TOO_LOW' && entry.axis === axis);
}

test('a slow torque on a healthy integrator is never told to raise I, however the holds are flown',
  () => {
    // A governor hunting, a slipping belt, wind: a torque slower than the 0.3 Hz
    // floor of the band an integrator can cause. A slow wander does not average
    // out of a hold, so each hold's mean keeps part of a cycle — several deg/s
    // of "standing error" on an aircraft whose integrator is fine.
    //
    // REPLACED in round three. This test flew only two long holds, and every
    // false "Raise I" left after round two needed holds of 8 s or less: over a
    // short hold a slice of a slow cycle has a mean larger than its own ripple,
    // so the rule round two added passed it. What a slow wander cannot do is
    // stay on ONE SIDE of the command from hold to hold — the review measured
    // [19.8, -26.0, 25.2, -23.0, 18.6, -13.1] on a healthy loop against
    // [-4.7 x6] with no integrator. So the flights here are flown the way pilots
    // fly them, on all three axes at once as the app analyses them: 3-8 holds,
    // a pulse every 6.5-12 s, holds of 5.5-14 s, every axis its own torque at
    // 0.03-0.30 Hz and 1000-6000 deg/s², at random phase, gust and seed — and
    // the review's own short-hold cells.
    const random = rng(20261003);
    const between = (low, high) => low + random() * (high - low);
    const slowTorque = () => ({
      gains: HOLD_NOMINAL,
      externalTorqueHz: between(0.03, 0.30),
      externalTorqueDps2: between(1000, 6000),
      externalTorquePhase: between(0, 2 * Math.PI),
      gustDps2: between(0, 300),
      seed: 1 + Math.floor(random() * 1e6)
    });
    const cell = (hz, dps2, phase) => ({gains: HOLD_NOMINAL, externalTorqueHz: hz,
      externalTorqueDps2: dps2, externalTorquePhase: phase, seed: 9001});

    const flights = [
      // The review: six ordinary holds, a pulse every 6.5 s ...
      {label: 'review, a pulse every 6.5 s', layout: holdLayout({holdsS: Array(6).fill(6.1)}),
        setups: {roll: cell(0.08, 4000, Math.PI / 3), pitch: cell(0.06, 2000, 0),
          yaw: cell(0.07, 4000, 2.09)}},
      // ... and every 5.6 s, the layout that gave roll 54 of 90.
      {label: 'review, a pulse every 5.6 s', layout: holdLayout({holdsS: Array(7).fill(5.2)}),
        setups: {roll: cell(0.06, 2000, 2.09), pitch: cell(0.06, 2508, 2.22),
          yaw: cell(0.079, 6000, 2.84)}},
      // A wander whose half period IS the hold spacing: every hold's mean stands
      // well clear of its own ripple, and the means alternate side. Only the
      // side tells this from a standing error.
      {label: 'a wander in step with the holds', layout: holdLayout({holdsS: Array(6).fill(6.1)}),
        setups: {roll: cell(1 / 13, 2000, 1.57), pitch: cell(1 / 13, 4000, 4.71),
          yaw: cell(1 / 13, 2000, 2.09)}}
    ];
    for (let draw = 0; draw < 10; draw += 1) {
      const count = 3 + Math.floor(random() * 6);
      const spacingS = between(6.5, 12);
      const holdsS = Array.from({length: count}, (_, at) => (at === count - 1
        ? between(5.5, 14)
        : Math.min(14, Math.max(5.5, spacingS - 0.4 + between(-0.5, 0.5)))));
      flights.push({label: `draw ${draw}: ${count} holds ${spacingS.toFixed(1)} s apart`,
        layout: holdLayout({holdsS}),
        setups: {roll: slowTorque(), pitch: slowTorque(), yaw: slowTorque()}});
    }
    // NOR A BIND (round three, re-reviewed 3 October 2026). Under a 0.03-0.035
    // Hz torque, flown as three ordinary holds of 6.1 s, a healthy integrator
    // follows the torque — "winding", by the bind discriminator's own numbers —
    // and the |mean| over the holds read 10-17 deg/s, so the flight was called
    // SUSPECTED_MECHANICAL_BIND, a blocker on every gain on the axis, although the
    // per-hold test had already refused that error as a standing one. 10 of the
    // review's 192 cells; all ten are flown here, with two neighbours.
    const bindCell = (hz, k) => ({gains: HOLD_NOMINAL, externalTorqueHz: hz,
      externalTorqueDps2: 6000, externalTorquePhase: (2 * Math.PI * k) / 16, seed: 50 + k,
      reviewBindCell: true});
    const threeShortHolds = holdLayout({holdsS: [6.1, 6.1, 6.1]});
    for (const cells of [[[0.03, 2], [0.03, 3], [0.03, 4]], [[0.03, 10], [0.03, 11], [0.03, 12]],
      [[0.035, 2], [0.035, 3], [0.035, 10]], [[0.035, 11], [0.03, 5], [0.035, 4]]]) {
      flights.push({label: `the review's bind cells ${cells.map(cell => cell.join('/')).join(', ')}`,
        layout: threeShortHolds,
        setups: Object.fromEntries(AXES_IN_ORDER.map((axis, at) => [axis, bindCell(...cells[at])]))});
    }
    // The same with the flight controller's own `iterm_limit` set low, which every
    // real one has: the integrator follows the torque to its limit and sits there,
    // so the SECOND bind signature, the pinned one, read the wander as a control
    // out of travel — found beside the review's cells, 18 of 96 such cells.
    const pinnedCell = (limit, hz, k) => ({...bindCell(hz, k), integratorLimit: limit,
      reviewBindCell: false, pinnedCell: true});
    flights.push({label: 'a low iterm_limit under the same torque', layout: threeShortHolds,
      setups: {roll: pinnedCell(1, 0.03, 4), pitch: pinnedCell(1, 0.08, 6),
        yaw: pinnedCell(2, 0.08, 12)}});
    // A large trim — a standing torque the integrator CAN hold — under a wander
    // (re-review of 3 October 2026). The I term sits on one side in every hold
    // with its drift pointing outward, the bind signature fires and the error is
    // refused hold by hold; what keeps it from reading as an integrator held
    // against an obstacle is only that it FELL BACK between two holds. Where such
    // an integrator happens to keep growing across the holds instead, it is read
    // as a bind — 3 of 200 trim-heavy healthy flights in a sweep — which fails
    // safe, a linkage checked by hand.
    const trimCell = setup => ({gains: HOLD_NOMINAL, ...setup, trimCell: true});
    flights.push({label: 'a large trim under a wander', layout: threeShortHolds, setups: {
      roll: trimCell({disturbanceDps2: 3835, externalTorqueHz: 0.08, externalTorqueDps2: 2091,
        externalTorquePhase: 5.64, gustDps2: 41, seed: 92823}),
      pitch: trimCell({disturbanceDps2: -1757, externalTorqueHz: 0.184, externalTorqueDps2: 7795,
        externalTorquePhase: 2.82, gustDps2: 131, seed: 757987}),
      yaw: bindCell(0.03, 2)}});
    // Steady turns on ONE axis — the other two cannot hold while it turns — one
    // way, both ways at random, and both ways IN STEP with a wander whose half
    // period is the hold spacing: there the error's side follows the stick
    // exactly, which is the trap normalising each hold to its own direction
    // would walk into.
    const turning = [
      {axis: 'yaw', layout: holdLayout({holdsS: Array(5).fill(8), kind: 'sustained'})},
      {axis: 'roll', layout: holdLayout({holdsS: Array(6).fill(7), kind: 'sustained',
        directions: [1, 1, -1, 1, -1, -1]})},
      {axis: 'pitch', lockStep: true, layout: holdLayout({holdsS: Array(6).fill(7),
        kind: 'sustained', directions: [1, -1, 1, -1, 1, -1]})}
    ];
    for (const {axis, layout, lockStep} of turning) {
      const setups = {};
      for (const other of AXES_IN_ORDER) {
        setups[other] = {gains: HOLD_NOMINAL, commands: [], seed: 7};
      }
      // In step, and phased so every hold's mean stands clear of its own
      // movement: only the side rule stands between this and "Raise I".
      setups[axis] = lockStep
        ? cell(1 / (2 * 7.4), 4000, 1.57)
        : slowTorque();
      flights.push({label: `${axis} turning${lockStep ? ' in step' : ''}`, layout, setups,
        only: axis, lockStep});
    }

    const raised = [];
    const cleared = [];
    const bound = [];
    let windingCells = 0;
    let pinnedCells = 0;
    let trimCells = 0;
    let slippedThrough = 0;
    let wanderNamed = 0;
    let changedSide = 0;
    let trials = 0;
    let lockStepTrapped = false;
    for (const {label, layout, setups, only, lockStep} of flights) {
      const withCommands = {};
      for (const axis of AXES_IN_ORDER) {
        withCommands[axis] = {commands: layout.commands, ...setups[axis]};
      }
      const result = recommendEachAxis(threeAxisRecords(withCommands, layout.durationS));
      for (const axis of only ? [only] : AXES_IN_ORDER) {
        const hold = result.gates.holds[axis];
        assert.equal(hold.evidence.status, 'captured',
          `${label}, ${axis}: the layout must give the engine holds to read: ${hold.codes}`);
        trials += 1;
        const said = iTermFinding(result, axis);
        const signed = hold.evidence.holds.map(entry => entry.steadyStateErrorDps.toFixed(1));
        const line = `${label}, ${axis} ${setups[axis].externalTorqueHz?.toFixed(3)} Hz `
          + `${Math.round(setups[axis].externalTorqueDps2)} deg/s²: ${said?.id} `
          + `[${signed.join(' ')}] [${hold.codes.join(',')}]`;
        // The hole this closes: a standing error the round-two rule let through,
        // because its mean over the holds stood clear of the mean ripple.
        if (hold.codes.includes('STEADY_STATE_ERROR_PRESENT')
            && !hold.codes.includes('STANDING_ERROR_NOT_CLEAR_OF_SLOW_MOVEMENT')
            && !hold.codes.includes('LOW_FREQUENCY_HUNTING')) {
          slippedThrough += 1;
        }
        if (raisedIOn(result, axis)) {
          raised.push(line);
        }
        if (said?.id === 'I_TERM_WITHIN_TOLERANCE'
            && hold.codes.some(code => I_TERM_TROUBLE_CODES.includes(code))) {
          cleared.push(line);
        }
        if (hold.bind?.suspected
            || result.findings.some(entry => entry.id === 'SUSPECTED_MECHANICAL_BIND'
              && entry.axis === axis)) {
          bound.push(line);
        }
        if (setups[axis].reviewBindCell) {
          // Not vacuous: by the discriminator's own numbers this integrator WAS
          // winding against an error over the holds above its threshold, so only
          // the per-hold refusal stands between it and a bind.
          const drift = Math.abs(hold.bind?.meanITermDriftPerSecond ?? 0);
          if (hold.bind?.meanAbsoluteSteadyStateErrorDps > BIND_LIMITS.errorDpsThreshold
              && drift >= BIND_LIMITS.minimumITermDriftPerSecond
              && Math.abs(hold.bind?.meanITermRms ?? 0) >= drift * BIND_LIMITS.windUpToDriftRatio) {
            windingCells += 1;
          }
        }
        if (setups[axis].trimCell) {
          // Not vacuous: the signature fired, the error was refused, and the I
          // term sat on one side drifting outward — only its falling back
          // between holds says it followed the wander.
          const means = hold.evidence.holds.map(entry => entry.iTermMean);
          const side = Math.sign(means[0]);
          const drift = hold.bind?.meanITermDriftPerSecond ?? 0;
          const signature = hold.bind?.meanAbsoluteSteadyStateErrorDps > BIND_LIMITS.errorDpsThreshold
            && ((Math.abs(drift) >= BIND_LIMITS.minimumITermDriftPerSecond
              && Math.abs(hold.bind.meanITermRms) >= Math.abs(drift) * BIND_LIMITS.windUpToDriftRatio)
              || (hold.bind.meanITermTravelShare <= AUTHORITY_LIMITS.iTermTravelShare
                && hold.bind.meanITermToPTermRatio >= AUTHORITY_LIMITS.iTermToPTermRatio));
          assert.ok(signature && hold.bind.standingErrorRefusal && side !== 0
            && means.every(value => Math.sign(value) === side) && Math.sign(drift) === side
            && means.some((value, at) => at > 0 && Math.abs(value) < Math.abs(means[at - 1])),
          `${line}: the trim cell must stand where only the I term falling back keeps it from a `
            + `bind: ${JSON.stringify(hold.bind)} [${means}]`);
          trimCells += 1;
        }
        if (setups[axis].pinnedCell
            && hold.bind?.meanAbsoluteSteadyStateErrorDps > BIND_LIMITS.errorDpsThreshold
            && hold.bind?.meanITermTravelShare <= AUTHORITY_LIMITS.iTermTravelShare
            && hold.bind?.meanITermToPTermRatio >= AUTHORITY_LIMITS.iTermToPTermRatio) {
          // Pinned by the discriminator's own numbers, likewise.
          pinnedCells += 1;
        }
        if (lockStep) {
          // The fixture IS the trap: normalised to its own turn direction, every
          // hold's error sits on one side.
          const normalised = hold.evidence.holds.map(entry =>
            Math.sign(entry.setpointMedianDps) * entry.steadyStateErrorDps);
          lockStepTrapped = normalised.every(value => value > 0)
            || normalised.every(value => value < 0);
          assert.ok(lockStepTrapped, `${line}: the in-step wander must look one-sided once `
            + `normalised, or it tests nothing: ${normalised.map(value => value.toFixed(1))}`);
          assert.ok(hold.codes.includes('STANDING_ERROR_FOLLOWS_COMMAND_DIRECTION'),
            `${line}: and it must reach the side rule, every hold clear of its own movement`);
        }
        if (said?.id === 'SLOW_WANDER_NOT_FROM_THE_I_TERM') {
          wanderNamed += 1;
          assert.equal(said.kind, 'next-flight', line);
          assert.equal(said.direction, null, line);
          assert.ok(said.candidates.some(entry => /governor/i.test(entry)), line);
          assert.ok(said.candidates.some(entry => /belt|drive/i.test(entry)), line);
          assert.ok(said.candidates.some(entry => /wind/i.test(entry)), line);
          assert.match(said.confirm, /calm/i, line);
          assert.match(said.confirm, /head.speed/i, line);
          if (hold.codes.includes('STANDING_ERROR_CHANGES_SIDE_BETWEEN_HOLDS')) {
            // Said as what was measured: the side, hold by hold.
            changedSide += 1;
            assert.match(said.reasoning, /one side in \d+ and on the other in \d+/,
              `${line}: ${said.reasoning}`);
            assert.ok(said.candidates.some(entry => /too little I/i.test(entry)), line);
          }
        }
      }
    }
    // Not vacuous: the sweep reached the hole, several times, and the in-step trap.
    assert.ok(slippedThrough >= 6,
      `only ${slippedThrough} of ${trials} trials carried a standing error the round-two rule `
      + 'let through, so refusing "Raise I" proves little');
    assert.ok(lockStepTrapped);
    assert.ok(changedSide >= 3, `the in-step wander must be named by its side: ${changedSide}`);
    assert.deepEqual(raised, [], `${raised.length} of ${trials} healthy integrators were told to `
      + `raise I:\n${raised.join('\n')}`);
    assert.deepEqual(cleared, [], `${cleared.length} wanders were given the all-clear`);
    assert.ok(wanderNamed >= trials / 2,
      `the slow wander must be named and a flight given to settle it: ${wanderNamed} of ${trials}`);
    assert.ok(windingCells >= 10,
      `the review's bind cells must still wind the I term up, or they test nothing: ${windingCells}`);
    assert.ok(pinnedCells >= 3,
      `the iterm_limit cells must still pin the I term, or they test nothing: ${pinnedCells}`);
    assert.equal(trimCells, 2, 'both trim cells must be flown');
    assert.deepEqual(bound, [], `${bound.length} of ${trials} healthy integrators under a slow torque `
      + `were called a bind:\n${bound.join('\n')}`);

    // The reviewer's round-one cells at 0.22 and 0.28 Hz, two long holds, still
    // reach SLOW_WANDER_NOT_FROM_THE_I_TERM.
    for (const [hz, torque] of [[0.22, 3000], [0.28, 6000]]) {
      const result = recommendFor(simulateHoldFlight({
        axis: 'yaw', gains: HOLD_NOMINAL, externalTorqueDps2: torque, externalTorqueHz: hz,
        durationS: 40
      }), 'yaw');
      assert.equal(iTermFinding(result, 'yaw')?.id, 'SLOW_WANDER_NOT_FROM_THE_I_TERM',
        `${hz} Hz at ${torque}: ${result.findings.map(entry => entry.id).join(', ')}`);
    }

    // CONTROLS: A GENUINE BIND STILL BLOCKS IN MOVING AIR, and outranks a "Raise
    // I" on another axis (re-review of 3 October 2026). These replace controls
    // flown in still air only, which passed while the gate above switched a real
    // bind off whenever anything else moved the aircraft too: a governor
    // hunting, or wind, under a control that cannot move far enough against a
    // standing torque larger than it can hold. That error is refused hold by
    // hold, as an error that moved, and the axis fell to a next-flight card about
    // a slow wander — so a gain change on another axis became the one
    // instruction while the linkage bound (12 of 12 such flights in the review).
    //
    // Each flight: two axes bound in moving air, the third with no integrator
    // against a torque, which on its own earns "Raise I". First two flights drawn
    // from the review's ranges, rotating the axes; then one flight with a bind
    // only each half of the integrator test keeps (see `integratorHeldAgainst` in
    // the module): roll's error stays on one side with the I term on it, but
    // the I term falls back between two holds; yaw's error changes side
    // between holds while the I term grows outward on one side through every one.
    const boundInMovingAir = () => {
      const limit = between(0.15, 0.25);
      return {gains: HOLD_NOMINAL, actuatorLimit: limit,
        disturbanceDps2: (random() < 0.5 ? -1 : 1) * limit * 800 * between(1.15, 1.5),
        gustDps2: between(80, 300), externalTorqueHz: between(0.05, 0.25),
        externalTorqueDps2: between(40, 200), externalTorquePhase: between(0, 2 * Math.PI),
        seed: 1 + Math.floor(random() * 1e6)};
    };
    const noIntegrator = () => ({gains: {...HOLD_NOMINAL, ki: 0},
      disturbanceDps2: (random() < 0.5 ? -1 : 1) * between(300, 600),
      seed: 1 + Math.floor(random() * 1e6)});
    const movingAirFlights = [0, 1].map(at => {
      const noI = AXES_IN_ORDER[at];
      const layout = holdLayout({holdsS: Array.from({length: 3 + at}, () => between(6, 9))});
      return {label: `moving-air binds, draw ${at}`, layout, noI, setups: Object.fromEntries(
        AXES_IN_ORDER.map(axis => [axis, axis === noI ? noIntegrator() : boundInMovingAir()]))};
    });
    movingAirFlights.push({label: 'a bind each half of the integrator test keeps alone',
      layout: holdLayout({holdsS: [7, 7.5, 8, 7]}), noI: 'pitch', setups: {
        roll: {gains: HOLD_NOMINAL, actuatorLimit: 0.19, disturbanceDps2: -181, gustDps2: 354,
          externalTorqueHz: 0.061, externalTorqueDps2: 107, externalTorquePhase: 4.69, seed: 532121},
        pitch: {gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 450, seed: 77},
        yaw: {gains: HOLD_NOMINAL, actuatorLimit: 0.194, disturbanceDps2: 165, gustDps2: 139,
          externalTorqueHz: 0.065, externalTorqueDps2: 349, externalTorquePhase: 2.46, seed: 351443}
      }});
    let boundOverARefusal = 0;
    const heldBy = new Set();
    for (const {label, layout, noI, setups} of movingAirFlights) {
      const withCommands = {};
      for (const axis of AXES_IN_ORDER) {
        withCommands[axis] = {commands: layout.commands, ...setups[axis]};
      }
      const result = recommendEachAxis(threeAxisRecords(withCommands, layout.durationS));
      for (const axis of AXES_IN_ORDER.filter(entry => entry !== noI)) {
        const hold = result.gates.holds[axis];
        const signed = hold.evidence.holds.map(entry =>
          `${entry.steadyStateErrorDps.toFixed(1)}/I ${entry.iTermMean.toFixed(2)}`);
        const line = `${label}, ${axis}: ${iTermFinding(result, axis)?.id} [${signed.join(' ')}] `
          + `[${hold.codes.join(',')}] ${JSON.stringify(hold.bind)}`;
        const said = result.findings.find(entry => entry.id === 'SUSPECTED_MECHANICAL_BIND'
          && entry.axis === axis);
        assert.ok(said, `${line}: a genuine bind in moving air must still be named`);
        assert.equal(said.kind, 'blocker', line);
        assert.equal(said.rung, 'axis-mechanical', line);
        assert.ok(!raisedIOn(result, axis), line);
        if (hold.bind.standingErrorRefusal) {
          // The case the gate lost: the error moved, and only the integrator,
          // still held against it, says this is a bind and not a wander.
          boundOverARefusal += 1;
          heldBy.add(hold.bind.integratorHeldAgainstTheError);
          assert.match(said.reasoning, /moved/, `${line}: said as what was measured`);
        }
      }
      // The bind is THE instruction; the axis with no integrator does earn "Raise
      // I" — the competition is real — but it waits behind the linkage.
      const actNow = result.findings.filter(entry => entry.actNow);
      assert.equal(actNow.length, 1, `${label}: ${actNow.map(entry => entry.id)}`);
      assert.equal(actNow[0].id, 'SUSPECTED_MECHANICAL_BIND',
        `${label}: the one instruction must be the linkage, not ${actNow[0].id}:${actNow[0].axis}`);
      assert.ok(raisedIOn(result, noI), `${label}, ${noI}: no integrator must still reach "Raise I", `
        + `or the bind outranks nothing: ${iTermFinding(result, noI)?.id}`);
      assert.ok(!result.findings.some(entry => entry.id === 'I_TOO_LOW' && entry.actNow), label);
    }
    // Not vacuous: the binds reached the per-hold refusal that switched them off,
    // and each half of the integrator test carried one on its own.
    assert.ok(boundOverARefusal >= 4,
      `only ${boundOverARefusal} moving-air binds were refused hold by hold, so this proves little`);
    assert.deepEqual([...heldBy].sort(), ['growing-on-one-side', 'on-the-error-side'],
      'each half of the integrator test must carry a bind');
  });

/**
 * A control that cannot move past a stop, against a standing torque just past
 * what that stop allows, so a bind holds the error at about `errorDps` on
 * `side` — on an aircraft whose I term carries a trim of `trimLogged`, because
 * another path adds a constant to the output (round seven, 3 October 2026).
 * Logged terms are scaled so the I term winds at about `windingLogged` a second.
 * 800 and 2 are `simulateHoldFlight`'s control authority and damping: the stop
 * at `side * limit` leaves the rate short by `errorDps`, and with a free linkage
 * the I term would sit at its trim.
 */
function boundAgainstATrim({side, errorDps, windingLogged, trimLogged, limit}) {
  const loggedTermScale = windingLogged / (HOLD_NOMINAL.ki * errorDps);
  const iTermStart = trimLogged / loggedTermScale;
  const needed = side * (limit + (2 * errorDps) / 800);
  return {gains: HOLD_NOMINAL, actuatorLimit: limit, disturbanceDps2: -side * (800 * limit + 2 * errorDps),
    outputBias: needed - iTermStart, iTermStart, loggedTermScale};
}

test('a bind still blocks where the I term carries a trim opposite the error, in moving air, '
  + 'and a working integrator closing its error is not one', () => {
  // THE HOLE (code review of round six, 3 October 2026). A per-hold refusal keeps
  // a bind only where the integrator still looks held against the error: its
  // mean on the error's side in every hold, or on one side and growing. Both
  // read WHERE the I term sits, and an I term carrying a trim sits wherever the
  // trim puts it. Twelve of fifty real axes with holds had it opposite the error.
  // So a tail linkage binding with the error at +5 deg/s, on an I term trimmed at
  // -40 and winding up through -30, neither sat on the error's side nor grew —
  // and in moving air the bind was switched off, the axis read as a slow wander,
  // and "Raise I" on another axis became the one instruction.
  //
  // Each flight here: one axis bound in moving air with its I term trimmed
  // against the error, blipped away from the trim between holds so the trim
  // lasts the flight; one with no integrator against a torque, which earns
  // "Raise I" on its own; the third quiet. Drawn from the opposite-trim family's
  // ranges (trims up to 60, bind errors 5-9 deg/s, winding 1-1.8 a second,
  // a wander of 20-60 deg/s² and gusts), axes and sides rotating.
  const random = rng(117);
  const between = (low, high) => low + random() * (high - low);
  const flights = [];
  for (let at = 0; at < 4; at += 1) {
    const holdsS = Array.from({length: 3 + (at % 2)}, () => between(6, 7.5));
    const layout = holdLayout({holdsS});
    const bound = AXES_IN_ORDER[at % 3];
    const noI = AXES_IN_ORDER[(at + 1) % 3];
    const side = at % 2 === 0 ? -1 : 1;
    const windingLogged = between(1, 1.8);
    const setups = {};
    for (const axis of AXES_IN_ORDER) {
      setups[axis] = {commands: layout.commands, gains: HOLD_NOMINAL, seed: 1 + Math.floor(random() * 1e6)};
    }
    setups[noI] = {commands: layout.commands, gains: {...HOLD_NOMINAL, ki: 0},
      disturbanceDps2: (random() < 0.5 ? -1 : 1) * between(300, 600), seed: 1 + Math.floor(random() * 1e6)};
    const errorDps = between(5, 9);
    const span = windingLogged * layout.durationS;
    const trimLogged = -side * Math.min(60, between(span + 5, span + 20));
    const limit = between(0.15, 0.25);
    const externalTorqueDps2 = between(20, 60);
    const externalTorqueHz = between(0.05, 0.25);
    const externalTorquePhase = between(0, 2 * Math.PI);
    const gustDps2 = between(80, 250);
    const seed = 1 + Math.floor(random() * 1e6);
    setups[bound] = {...boundAgainstATrim({side, errorDps, windingLogged, trimLogged, limit}),
      externalTorqueDps2, externalTorqueHz, externalTorquePhase, gustDps2, seed,
      commands: layout.commands.map(segment => ({...segment, dps: -side * segment.dps}))};
    flights.push({label: `opposite trim, draw ${at}: ${bound} bound on side ${side}, trim `
      + `${trimLogged.toFixed(0)}`, layout, bound, noI, side, setups});
  }

  let oppositeEveryHold = 0;
  const refusals = new Set();
  for (const {label, layout, bound, noI, side, setups} of flights) {
    const result = recommendEachAxis(threeAxisRecords(setups, layout.durationS));
    const hold = result.gates.holds[bound];
    const holds = hold.evidence.holds;
    const line = `${label}: ${iTermFinding(result, bound)?.id} [${holds.map(entry =>
      `${entry.steadyStateErrorDps.toFixed(1)}/I ${entry.iTermMean.toFixed(1)}/dI `
      + `${entry.iTermDriftPerSecond.toFixed(2)}`).join(' ')}] [${hold.codes}] ${JSON.stringify(hold.bind)}`;

    // Not vacuous: the error stood on the bind's side in every hold and was
    // refused hold by hold, and neither reading of where the I term sat keeps it.
    assert.equal(hold.evidence.status, 'captured', line);
    assert.ok(holds.every(entry => Math.sign(entry.steadyStateErrorDps) === side), line);
    assert.ok(hold.bind.standingErrorRefusal, `${line}: the error must be refused hold by hold`);
    refusals.add(hold.bind.standingErrorRefusal);
    const onErrorSide = holds.every(entry => Math.sign(entry.iTermMean) === side);
    const iSide = Math.sign(holds[0].iTermMean);
    const growing = holds.every(entry => Math.sign(entry.iTermMean) === iSide)
      && holds.every((entry, at) => at === 0
        || Math.abs(entry.iTermMean) >= Math.abs(holds[at - 1].iTermMean))
      && Math.sign(hold.bind.meanITermDriftPerSecond) === iSide;
    assert.ok(!onErrorSide && !growing, `${line}: where the I term sat must not decide this one`);
    if (holds.every(entry => Math.sign(entry.iTermMean) === -side)) {
      oppositeEveryHold += 1;
    }

    // The bind is named, as a blocker, read through the movement, and said as
    // what was measured: the I term wound toward the error, and the error stood.
    const said = result.findings.find(entry => entry.id === 'SUSPECTED_MECHANICAL_BIND'
      && entry.axis === bound);
    assert.ok(said, `${line}: a genuine bind against an opposite trim must still be named`);
    assert.equal(said.kind, 'blocker', line);
    assert.equal(said.rung, 'axis-mechanical', line);
    assert.ok(!raisedIOn(result, bound), line);
    assert.equal(hold.bind.integratorHeldAgainstTheError, 'winding-toward-the-error', line);
    assert.match(said.reasoning, /moved/, line);
    assert.match(said.reasoning, /wound toward that error in every hold/, `${line}: ${said.reasoning}`);
    assert.doesNotMatch(said.reasoning, /wound up large/,
      `${line}: an I term unwinding toward zero did not wind up large: ${said.reasoning}`);

    // THE instruction is the linkage. The axis with no integrator still earns
    // "Raise I" — the competition is real — but waits behind it.
    const actNow = result.findings.filter(entry => entry.actNow);
    assert.equal(actNow.length, 1, `${label}: ${actNow.map(entry => `${entry.id}:${entry.axis}`)}`);
    assert.equal(`${actNow[0].id}:${actNow[0].axis}`, `SUSPECTED_MECHANICAL_BIND:${bound}`,
      `${label}: the one instruction must be the linkage`);
    assert.ok(raisedIOn(result, noI), `${label}, ${noI}: no integrator must still reach "Raise I": `
      + `${iTermFinding(result, noI)?.id}`);
    assert.ok(!result.findings.some(entry => entry.id === 'I_TOO_LOW' && entry.actNow), label);
  }
  // Not vacuous: the trim was opposite the error through every hold of most of
  // them, and both per-hold refusals were met.
  assert.ok(oppositeEveryHold >= 3, `the trim stayed opposite in only ${oppositeEveryHold}`);
  assert.deepEqual([...refusals].sort(),
    ['STANDING_ERROR_NOT_CLEAR_IN_EVERY_HOLD', 'STANDING_ERROR_NOT_CLEAR_OF_SLOW_MOVEMENT']);

  // CONTROL: A WORKING INTEGRATOR CLOSING ITS ERROR IS NOT A BIND. A soft one
  // (ki a quarter of nominal), trimmed opposite the error, catching up with a
  // torque that stepped in at the start, in moving air: it winds toward the
  // error in every hold, faster than the winding floor, exactly as the bind
  // above does — but the error SHRINKS across the holds as it winds, which a
  // bound control cannot do. Only that keeps it from being called a bind.
  const layout = holdLayout({holdsS: [7.5, 6.4, 7.4, 7.8]});
  const setups = {};
  for (const axis of AXES_IN_ORDER) {
    setups[axis] = {commands: layout.commands, gains: HOLD_NOMINAL, seed: 5};
  }
  const loggedTermScale = 11.7;
  const iTermStart = 72 / loggedTermScale;
  setups.pitch = {commands: layout.commands, gains: {...HOLD_NOMINAL, ki: 0.0124},
    disturbanceDps2: 4047, outputBias: -iTermStart, iTermStart, loggedTermScale,
    externalTorqueHz: 0.131, externalTorqueDps2: 585, externalTorquePhase: 2.81, gustDps2: 87,
    seed: 22930};
  const result = recommendEachAxis(threeAxisRecords(setups, layout.durationS));
  const hold = result.gates.holds.pitch;
  const holds = hold.evidence.holds;
  const side = Math.sign(holds[0].steadyStateErrorDps);
  const line = `catching up: ${iTermFinding(result, 'pitch')?.id} [${holds.map(entry =>
    `${entry.steadyStateErrorDps.toFixed(1)}/I ${entry.iTermMean.toFixed(1)}/dI `
    + `${entry.iTermDriftPerSecond.toFixed(2)}`).join(' ')}] ${JSON.stringify(hold.bind)}`;
  const drift = Math.abs(hold.bind.meanITermDriftPerSecond);
  assert.ok(hold.bind.meanAbsoluteSteadyStateErrorDps > BIND_LIMITS.errorDpsThreshold
    && drift >= BIND_LIMITS.minimumITermDriftPerSecond
    && Math.abs(hold.bind.meanITermRms) >= drift * BIND_LIMITS.windUpToDriftRatio,
  `${line}: the winding signature must fire, or this tests nothing`);
  assert.ok(hold.bind.standingErrorRefusal, line);
  assert.ok(side !== 0 && holds.every(entry => Math.sign(entry.steadyStateErrorDps) === side
    && Math.sign(entry.iTermMean) === -side && Math.sign(entry.iTermDriftPerSecond) === side
    && Math.abs(entry.iTermDriftPerSecond) >= BIND_LIMITS.minimumITermDriftPerSecond),
  `${line}: it must wind toward the error in every hold, past the floor, from the far side`);
  const meanOf = list => list.reduce((total, entry) =>
    total + side * entry.steadyStateErrorDps * entry.measuredDurationUs, 0)
    / list.reduce((total, entry) => total + entry.measuredDurationUs, 0);
  assert.ok(meanOf(holds.slice(2)) < 0.5 * meanOf(holds.slice(0, 2)),
    `${line}: the error must close across the holds, or this tests nothing`);
  assert.ok(!hold.bind.suspected
    && !result.findings.some(entry => entry.id === 'SUSPECTED_MECHANICAL_BIND'), line);
});

test('on a real log the I term winds toward setpoint minus gyro, the side the bind gate reads',
  {skip: REAL_LOG ? false : 'set ROTORLENS_REAL_LOG'}, () => {
    // `integratorHeldAgainst` reads an I term on the error's side as one wound
    // against it. That rests on a sign convention RotorLens does not set: the
    // error is computed here as setpoint minus gyro, and the I term is whatever
    // the firmware logged. Any PID has dI/dt = ki * error, so over a short window
    // the I term must move the way the window's error points. Checked on the app's
    // own records, axis by axis; were a decoder or a field map ever to flip one,
    // the gate would read a wound integrator as a following one.
    const session = sessionOf(REAL_LOG);
    for (const axis of AXES_IN_ORDER) {
      const {records, usable} = buildAnalysisRecords(session, {axis});
      assert.ok(usable, axis);
      const index = AXES_IN_ORDER.indexOf(axis);
      let withError = 0;
      let againstError = 0;
      let start = 0;
      while (start < records.length) {
        let end = start;
        while (end < records.length && records[end].timeUs - records[start].timeUs < 50_000) {
          end += 1;
        }
        if (end >= records.length) {
          break;
        }
        let sum = 0;
        for (let at = start; at < end; at += 1) {
          sum += records[at].setpoint[index] - records[at].gyro[index];
        }
        const meanError = sum / (end - start);
        const change = records[end].terms[1] - records[start].terms[1];
        // Only where the error was large enough to move an integrator visibly.
        if (Math.abs(meanError) > 5 && Number.isFinite(change) && change !== 0) {
          if (Math.sign(change) === Math.sign(meanError)) {
            withError += 1;
          } else {
            againstError += 1;
          }
        }
        start = end;
      }
      const windows = withError + againstError;
      assert.ok(windows >= 50, `${axis}: only ${windows} windows with an error to read`);
      assert.ok(withError >= 0.9 * windows,
        `${axis}: the I term moved with setpoint minus gyro in ${withError} of ${windows} windows`);
    }
  });

test('too little I still earns "Raise I" from three ordinary holds, and two are a next flight',
  () => {
    // THE CONTROLS for the test above: the rule separates a standing error from
    // a wander, it does not silence the branch. No integrator, and one far too
    // small, against a steady torque, flown as ordinary holds on all three axes.
    const flights = [
      // The shortest layout the rule accepts: three holds of 5.5 s.
      {label: 'three holds of 5.5 s', holdsS: [5.5, 5.5, 5.5], setups: {
        roll: {gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: -500, seed: 31},
        pitch: {gains: {...HOLD_NOMINAL, ki: 0.001}, disturbanceDps2: 700, seed: 32},
        yaw: {gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 600, gustDps2: 300, seed: 33}}},
      // Five holds of 6-8 s, the sortie the pilot guide asks for.
      {label: 'five holds of 6-8 s', holdsS: [6, 7.5, 8, 6.5, 7], setups: {
        roll: {gains: {...HOLD_NOMINAL, ki: 0.001}, disturbanceDps2: 650, gustDps2: 200, seed: 34},
        pitch: {gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: -350, gustDps2: 300, seed: 35},
        yaw: {gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400, seed: 36}}}
    ];
    for (const {label, holdsS, setups} of flights) {
      const layout = holdLayout({holdsS});
      const withCommands = {};
      for (const axis of AXES_IN_ORDER) {
        withCommands[axis] = {commands: layout.commands, ...setups[axis]};
      }
      const result = recommendEachAxis(threeAxisRecords(withCommands, layout.durationS));
      for (const axis of AXES_IN_ORDER) {
        assert.ok(raisedIOn(result, axis), `${label}, ${axis}: `
          + `${iTermFinding(result, axis)?.id} [${result.gates.holds[axis].codes}]`);
      }
      // One change at a time: exactly one of them is the instruction.
      const raise = result.findings.filter(entry => entry.id === 'I_TOO_LOW');
      assert.equal(raise.length, 1, label);
      // Said as what was measured (re-review of 3 October 2026). The side rule
      // does not refuse a slow wander — one slow enough keeps its side through
      // three holds — and the card credited it with that; what refuses it is the
      // per-hold clearance, and the card now says both, in the hold count read.
      const holdCount = result.gates.holds[raise[0].axis].holdCount;
      assert.match(raise[0].reasoning, new RegExp(`on the same side in every one of the ${holdCount} `
        + 'holds, and larger than its own movement in each'), raise[0].reasoning);
      assert.doesNotMatch(raise[0].reasoning, /a slow wander does not do/, raise[0].reasoning);
    }

    // Turns both ways under the tail's own torque: the standing error stays on
    // one side of the command whichever way the aircraft turns. Still too little I.
    const bothWays = holdLayout({holdsS: [7, 7, 7, 7], kind: 'sustained',
      directions: [1, -1, -1, 1]});
    const turnSetups = {};
    for (const axis of AXES_IN_ORDER) {
      turnSetups[axis] = {gains: HOLD_NOMINAL, commands: [], seed: 40};
    }
    turnSetups.yaw = {gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 600,
      commands: bothWays.commands, seed: 41};
    const turned = recommendEachAxis(threeAxisRecords(turnSetups, bothWays.durationS));
    assert.ok(raisedIOn(turned, 'yaw'),
      `${iTermFinding(turned, 'yaw')?.id} [${turned.gates.holds.yaw.codes}]`);

    // TWO HOLDS ARE A NEXT FLIGHT. Two holds on the same side is what too little
    // I looks like and also what half a slow wander looks like, and two cannot
    // tell them apart. Not an all-clear and not an instruction: what to fly.
    const two = holdLayout({holdsS: [10, 12]});
    const twoSetups = {};
    for (const axis of AXES_IN_ORDER) {
      twoSetups[axis] = {gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 500,
        commands: two.commands, seed: 50};
    }
    const short = recommendEachAxis(threeAxisRecords(twoSetups, two.durationS));
    for (const axis of AXES_IN_ORDER) {
      const hold = short.gates.holds[axis];
      assert.equal(hold.holdCount, 2, `${axis}: the fixture must be two holds`);
      assert.ok(!raisedIOn(short, axis), `${axis}: two holds earned "Raise I"`);
      const said = iTermFinding(short, axis);
      assert.equal(said?.id, 'I_TERM_NOT_JUDGED', `${axis}: ${said?.id} [${hold.codes}]`);
      assert.ok(said.codes.includes('TOO_FEW_HOLDS_FOR_A_STANDING_ERROR'), `${said.codes}`);
      assert.equal(said.kind, 'next-flight');
      assert.equal(said.direction, null);
      assert.match(said.reasoning, /same side/i, said.reasoning);
      assert.match(said.reasoning, /\b2\b|two/i, said.reasoning);
      assert.ok(said.candidates.some(entry => /too little I/i.test(entry)), `${said.candidates}`);
      assert.ok(said.candidates.some(entry => /wander/i.test(entry)), `${said.candidates}`);
      assert.match(said.confirm, /\b3\b|three/i, said.confirm);
      assert.doesNotMatch(`${said.headline} ${said.reasoning}`, /nothing .*calls for/i);
    }

    // TURNS WHOSE ERROR FLIPS WITH THE STICK. A lagging loop with no standing
    // torque sits behind the command whichever way it turns — and so does a
    // wander that happens to be in step with the turns. The two cannot be told
    // apart from these holds, so neither is read: what to fly instead.
    const flips = holdLayout({holdsS: [7, 7, 7, 7], kind: 'sustained', rateDps: 200,
      directions: [1, -1, 1, -1]});
    const flipSetups = {};
    for (const axis of AXES_IN_ORDER) {
      flipSetups[axis] = {gains: HOLD_NOMINAL, commands: [], seed: 60};
    }
    flipSetups.yaw = {gains: {...HOLD_NOMINAL, ki: 0}, commands: flips.commands, seed: 61};
    const flipped = recommendEachAxis(threeAxisRecords(flipSetups, flips.durationS));
    const flipHold = flipped.gates.holds.yaw;
    assert.ok(!raisedIOn(flipped, 'yaw'), `[${flipHold.codes}]`);
    const flipSaid = iTermFinding(flipped, 'yaw');
    assert.equal(flipSaid?.id, 'I_TERM_NOT_JUDGED', `${flipSaid?.id} [${flipHold.codes}]`);
    assert.ok(flipSaid.codes.includes('STANDING_ERROR_FOLLOWS_COMMAND_DIRECTION'),
      `${flipSaid.codes}`);
    assert.match(flipSaid.confirm, /one direction|one way/i, flipSaid.confirm);
    // Said with its side (re-review of 3 October 2026): this loop falls SHORT of
    // the command in every turn, measured in each turn's own direction.
    assert.ok(flipSaid.codes.includes('RATE_SHORT_OF_COMMAND_IN_EVERY_TURN'), `${flipSaid.codes}`);
    assert.match(flipSaid.reasoning, /fell short of the command/, flipSaid.reasoning);
    assert.match(flipSaid.reasoning, /lags behind every turn/, flipSaid.reasoning);
    assert.ok(flipSaid.candidates.some(entry => /too little I/i.test(entry)), `${flipSaid.candidates}`);

    // AND THE OTHER SIDE. The card said "a loop that lags behind every turn does
    // that" whichever side the error was on — including for an aircraft turning
    // FASTER than commanded both ways, which is what a feedforward set too high
    // does. Swept over the review's two settings: every turn past the command,
    // said so, with feedforward named, and still nothing read about the I term.
    for (const feedforward of [0.01, 0.02]) {
      const leadSetups = {...flipSetups, yaw: {...flipSetups.yaw, feedforward}};
      const led = recommendEachAxis(threeAxisRecords(leadSetups, flips.durationS));
      const hold = led.gates.holds.yaw;
      const normalised = hold.evidence.holds.map(entry =>
        Math.sign(entry.setpointMedianDps) * entry.steadyStateErrorDps);
      const label = `feedforward ${feedforward}: [${normalised.map(value => value.toFixed(1))}] `
        + `[${hold.codes}]`;
      // The fixture: past the command in every turn, by more than a standing error.
      assert.ok(normalised.every(value => value < -pidEvidence.HOLD_READING_THRESHOLDS.errorDps),
        label);
      assert.ok(!raisedIOn(led, 'yaw'), label);
      const said = iTermFinding(led, 'yaw');
      assert.equal(said?.id, 'I_TERM_NOT_JUDGED', `${label}: ${said?.id}`);
      assert.ok(said.codes.includes('STANDING_ERROR_FOLLOWS_COMMAND_DIRECTION'), label);
      assert.ok(said.codes.includes('RATE_PAST_COMMAND_IN_EVERY_TURN'), label);
      assert.ok(!said.codes.includes('RATE_SHORT_OF_COMMAND_IN_EVERY_TURN'), label);
      assert.equal(said.direction, null);
      assert.match(said.reasoning, /ran past the command/, said.reasoning);
      assert.doesNotMatch(spokenText(said), /lags? behind|fell short/i, spokenText(said));
      assert.ok(said.candidates.some(entry => /feedforward/i.test(entry)), `${said.candidates}`);
      // What to fly separates them: a still hover commands nothing for a
      // feedforward to add to.
      assert.match(said.confirm, /still hovers?/i, said.confirm);
    }
  });

test('the I-term all-clear rests on a measurement that could have seen trouble, never elimination',
  () => {
    // ROUND THREE. Two roads still reached "Nothing in the holds calls for an
    // I-term change" with nothing measured:
    //  - a fast oscillation above the band dominates the crossing count, so a
    //    hunt or a wander under it is never measured — and the card added
    //    "Underneath it there was no standing error and no slow wander";
    //  - a slow ripple above the threshold, refused as hunting only because it
    //    was no larger than the noise, carried no code at all.
    // Each is now I_TERM_NOT_JUDGED, reached through the one door to the
    // all-clear (`earnsITermAllClear` in holdFindings): open that door and
    // every flight here is cleared again.
    const random = rng(20261004);
    const between = (low, high) => low + random() * (high - low);
    const families = [
      ['a hunt under a fast oscillation', () => ({gains: HOLD_SOFT, gustDps2: 2200,
        externalTorqueHz: between(3.5, 12), externalTorqueDps2: between(2000, 20000)})],
      ['a slow wander under a fast oscillation', () => ({gains: HOLD_NOMINAL,
        externalTorqueHz: 0.2, externalTorqueDps2: 3000, externalTorquePhase: between(0, 6.28),
        extraTorques: [{hz: between(3.5, 12), dps2: between(2000, 20000)}]})],
      ['a fast oscillation on a healthy loop', () => ({gains: HOLD_NOMINAL,
        externalTorqueHz: between(3.6, 4.5), externalTorqueDps2: 3000})],
      ['a hunt under heavy noise', () => ({gains: HOLD_SOFT, gustDps2: 2200,
        noiseDps: between(100, 400)})],
      ['a slow wander under heavy noise', () => ({gains: HOLD_NOMINAL, externalTorqueHz: 0.2,
        externalTorqueDps2: 3000, externalTorquePhase: between(0, 6.28), noiseDps: 400})],
      ['an in-band wobble under heavy noise', () => ({gains: {...HOLD_NOMINAL, ki: 0},
        disturbanceDps2: 400, externalTorqueHz: between(0.5, 1.2), externalTorqueDps2: 3000,
        noiseDps: 300})],
      // Both I-term signatures — a standing error and an in-band wobble, which is
      // refused — under a vibration that hides the wobble. The review had "Raise
      // I" here: the standing error was read, and the hunt beside it was not seen.
      //
      // FIXED in the re-review of 3 October 2026. This family laid a 12 Hz,
      // 20000 deg/s² torque over a 4.7 deg/s standing error: a per-hold ripple of
      // about 24 deg/s, which the per-hold rule refuses every time, so it never
      // met a cover SMALLER than the error — which is where "Raise I" was still
      // given (2 of 40 flights with a fast torque, 10 of 40 under gyro noise).
      // Both covers are now drawn from the review's own ranges, and each family
      // flies the review's two flights that reached "Raise I" first.
      ['both signatures under a fast oscillation', coverDraw([
        {standing: -1436, wobbleHz: 1.196, wobble: 1283, fastHz: 9.97, fast: 2158, seed: 749740},
        {standing: -1169, wobbleHz: 1.142, wobble: 973, fastHz: 14.54, fast: 1677, seed: 161966}
      ], false)],
      ['both signatures under gyro noise', coverDraw([
        {standing: -1275, wobbleHz: 0.84, wobble: 1397, noise: 391.9, seed: 46946},
        {standing: 909, wobbleHz: 0.781, wobble: 880, noise: 200.2, seed: 474000}
      ], true)]
    ];
    /**
     * No integrator, a standing torque, an in-band wobble beside it, and a cover
     * over both: the listed flights first, then draws from the review's ranges.
     */
    function coverDraw(cells, noisy) {
      let used = 0;
      return () => {
        const cell = cells[used] ?? {
          standing: (random() < 0.5 ? -1 : 1) * between(600, 1500),
          wobbleHz: between(0.5, 1.4), wobble: between(800, 3000),
          fastHz: between(6, 15), fast: between(1000, 8000), noise: between(50, 400)
        };
        used += 1;
        return {gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: cell.standing,
          externalTorqueHz: cell.wobbleHz, externalTorqueDps2: cell.wobble,
          ...(noisy ? {noiseDps: cell.noise} : {extraTorques: [{hz: cell.fastHz, dps2: cell.fast}]}),
          ...(cell.seed ? {seed: cell.seed} : {})};
      };
    }
    const covered = new Set(['both signatures under a fast oscillation',
      'both signatures under gyro noise']);
    const layout = holdLayout({holdsS: [8, 8, 8]});
    const cleared = [];
    const reached = {masked: 0, noisy: 0};
    let inBandSeen = 0;
    let standingUnderCover = 0;
    let noiseCheckedFirst = 0;
    let noiseCheckedFirstUnderABranch = 0;
    for (let flight = 0; flight < families.length; flight += 1) {
      const setups = {};
      const names = {};
      AXES_IN_ORDER.forEach((axis, at) => {
        const [name, make] = families[(flight + at) % families.length];
        names[axis] = name;
        setups[axis] = {commands: layout.commands, seed: 70 + flight * 3 + at, ...make()};
      });
      const result = recommendEachAxis(threeAxisRecords(setups, layout.durationS));
      for (const axis of AXES_IN_ORDER) {
        const hold = result.gates.holds[axis];
        const said = iTermFinding(result, axis);
        const summary = hold.evidence.summary;
        const line = `${names[axis]} on ${axis}: ${said?.id} ripple ${summary?.meanErrorRippleRmsDps} `
          + `noise ${summary?.meanErrorNoiseRmsDps} crossings ${summary?.meanErrorCrossingRateHz} `
          + `[${hold.codes.join(',')}]`;
        if (said?.id === 'I_TERM_WITHIN_TOLERANCE') {
          cleared.push(line);
          continue;
        }
        // Nor is anything under the cover read as a standing error: a hunt the
        // cover hid beside it would make it the conflicting signature.
        assert.ok(!raisedIOn(result, axis), `${line}: "Raise I" under the cover`);
        // THE HOLE the re-review found: under a cover, every hold's mean clear of
        // what moved in it, on one side, in enough holds — so only the cover
        // stood between the error and "increase". It is refused by name, and
        // said: a next flight, never a reading of the I term.
        const holds = hold.evidence.holds ?? [];
        if (covered.has(names[axis])
            && (hold.codes.includes('OSCILLATION_ABOVE_I_TERM_BAND')
              || hold.codes.includes('SLOW_RIPPLE_NOT_CLEAR_OF_NOISE'))
            && holds.length >= pidEvidence.EVIDENCE_LIMITS.minimumHoldsForStandingError
            && holds.every(entry => Math.abs(entry.steadyStateErrorDps) > entry.errorRippleRmsDps)
            && (holds.every(entry => entry.steadyStateErrorDps > 0)
              || holds.every(entry => entry.steadyStateErrorDps < 0))) {
          standingUnderCover += 1;
          assert.ok(hold.codes.includes('STANDING_ERROR_WITH_UNMEASURED_BAND'), line);
          assert.ok(['I_TERM_NOT_JUDGED', 'I_TERM_VERDICT_UNSTABLE'].includes(said?.id), line);
          assert.equal(said.kind, 'next-flight', line);
          if (said.id === 'I_TERM_NOT_JUDGED') {
            assert.match(said.reasoning, /same side in every one of the \d+ holds/, said.reasoning);
            assert.match(said.reasoning, /could not|hid whether/i, said.reasoning);
            assert.ok(said.candidates.some(entry => /too little I/i.test(entry)), `${said.candidates}`);
            if (hold.codes.includes('OSCILLATION_ABOVE_I_TERM_BAND')) {
              assert.match(said.confirm, /^Settle what is shaking first/, said.confirm);
            }
          }
        }
        // An in-band movement is never described as slower than the band
        // (item 3), whichever card it reached.
        const oscillationHz = (summary?.meanErrorCrossingRateHz ?? 0) / 2;
        const inBand = oscillationHz >= 0.3 && oscillationHz <= 3;
        if (inBand && said) {
          assert.doesNotMatch(said.reasoning, /slower than the/, `${line}: ${said.reasoning}`);
          if (!hold.codes.includes('STANDING_ERROR_CHANGES_SIDE_BETWEEN_HOLDS')) {
            assert.doesNotMatch(said.headline, /slower than an integrator/,
              `${line}: ${said.headline}`);
          }
        }
        if (said?.id !== 'I_TERM_NOT_JUDGED') {
          continue;
        }
        assert.equal(said.kind, 'next-flight', line);
        assert.equal(said.direction, null, line);
        assert.doesNotMatch(`${said.headline} ${said.reasoning}`,
          /nothing .*calls for|no standing error and no slow wander/i, line);
        if (hold.codes.includes('OSCILLATION_ABOVE_I_TERM_BAND')) {
          reached.masked += 1;
          assert.match(said.reasoning, /faster than the 0\.3.3 Hz band/, `${line}: ${said.reasoning}`);
          assert.match(said.reasoning, /could not be (?:seen|measured)/i, said.reasoning);
        }
        if (hold.codes.includes('SLOW_RIPPLE_NOT_CLEAR_OF_NOISE')) {
          reached.noisy += 1;
          assert.match(said.reasoning, /noise/i, `${line}: ${said.reasoning}`);
          assert.match(said.reasoning, /\d+(?:\.\d+)? deg\/s RMS/, said.reasoning);
          // WHAT HID THE BAND IS DEALT WITH FIRST, whatever the card goes on to ask
          // (re-review of 3 October 2026): the noise is checked before any hold is
          // flown again, including where a branch replaced the confirm with its
          // own — a standing error beside the band, here. A shake above the band
          // comes first when there is one.
          if (!hold.codes.includes('OSCILLATION_ABOVE_I_TERM_BAND')) {
            assert.match(said.confirm, /^Check the gyro mounting and the vibration findings on this flight first\. Then fly \d+ or more /,
              `${line}: ${said.confirm}`);
            noiseCheckedFirst += 1;
            if (hold.codes.includes('STANDING_ERROR_WITH_UNMEASURED_BAND')) {
              noiseCheckedFirstUnderABranch += 1;
            }
          }
        }
        // An in-band movement the noise hid is said to be inside the band.
        if (inBand && hold.codes.includes('SLOW_RIPPLE_NOT_CLEAR_OF_NOISE')) {
          inBandSeen += 1;
          assert.match(said.reasoning, /inside the 0\.3.3 Hz band/, `${line}: ${said.reasoning}`);
        }
      }
    }
    assert.deepEqual(cleared, [], `${cleared.length} all-clears were reached by elimination:\n`
      + cleared.join('\n'));
    assert.ok(reached.masked >= 3, `the fast-oscillation road must be reached: ${reached.masked}`);
    assert.ok(reached.noisy >= 3, `the noisy-ripple road must be reached: ${reached.noisy}`);
    assert.ok(inBandSeen >= 2, `an in-band ripple under the noise must be reached: ${inBandSeen}`);
    assert.ok(noiseCheckedFirst >= 3 && noiseCheckedFirstUnderABranch >= 1,
      `the noise check must be reached, and beside a standing error: ${noiseCheckedFirst}, `
      + `${noiseCheckedFirstUnderABranch}`);
    // And ahead of a branch that writes its own confirm, which is where it was
    // being lost: a wander in step with three holds, under gyro noise, changes
    // side between them — the calm-air hold is asked for only after the noise.
    const inStep = holdLayout({holdsS: [6.1, 6.1, 6.1]});
    const noisySides = recommendFor(simulateHoldFlight({axis: 'yaw', gains: HOLD_NOMINAL,
      externalTorqueHz: 1 / 13, externalTorqueDps2: 2000, externalTorquePhase: 2.09, noiseDps: 100,
      commands: inStep.commands, durationS: inStep.durationS}), 'yaw');
    const sidesCodes = noisySides.gates.holds.yaw.codes;
    assert.ok(sidesCodes.includes('SLOW_RIPPLE_NOT_CLEAR_OF_NOISE')
      && sidesCodes.includes('STANDING_ERROR_CHANGES_SIDE_BETWEEN_HOLDS')
      && !sidesCodes.includes('OSCILLATION_ABOVE_I_TERM_BAND'), `[${sidesCodes}]`);
    const sidesSaid = iTermFinding(noisySides, 'yaw');
    assert.equal(sidesSaid?.id, 'I_TERM_NOT_JUDGED', `[${sidesCodes}]`);
    assert.match(sidesSaid.confirm, /^Check the gyro mounting and the vibration findings on this flight first\. Then fly \d+ or more still holds .* in calm air, with the other two axes quiet, and watch the head-speed trace/,
      sidesSaid.confirm);
    // Not vacuous: the review's four flights stand in the hole on this layout,
    // and nothing but the cover stood between each and "Raise I".
    assert.ok(standingUnderCover >= 4,
      `a standing error clear in every hold under a cover must be there to misread: ${standingUnderCover}`);

    // CONTROL: a quiet, healthy loop still earns the all-clear, and the card says
    // what was measured and the size it would have seen.
    const quietSetups = {};
    for (const axis of AXES_IN_ORDER) {
      quietSetups[axis] = {commands: layout.commands, gains: HOLD_NOMINAL, disturbanceDps2: 200,
        seed: 90};
    }
    const quiet = recommendEachAxis(threeAxisRecords(quietSetups, layout.durationS));
    for (const axis of AXES_IN_ORDER) {
      const said = iTermFinding(quiet, axis);
      assert.equal(said?.id, 'I_TERM_WITHIN_TOLERANCE', `${axis}: ${quiet.gates.holds[axis].codes}`);
      assert.match(said.reasoning, /neither sat off the commanded rate nor wandered/);
      assert.match(said.reasoning, /under the 2 deg\/s/, said.reasoning);
    }

    // CONTROL: no integrator against the review's standing torques still earns
    // "Raise I" — bare, and under a fast oscillation too small to register (its
    // slow part under the 2 deg/s read as movement, so no code): a measurement
    // that would have seen a hunt of that size beside it. Too small at every
    // filter length and threshold the sweep tries, too: one that registers at
    // some of them (9.97 Hz at 600 deg/s², 1.2 deg/s RMS) now reads "increase"
    // at some sweep points and is refused at others, which is
    // I_TERM_VERDICT_UNSTABLE, not "Raise I".
    const lowSetups = {
      roll: {commands: layout.commands, gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: -1436,
        seed: 91},
      pitch: {commands: layout.commands, gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 1169,
        extraTorques: [{hz: 12, dps2: 400}], seed: 92},
      yaw: {commands: layout.commands, gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 909,
        extraTorques: [{hz: 9.97, dps2: 300}], seed: 93}
    };
    const low = recommendEachAxis(threeAxisRecords(lowSetups, layout.durationS));
    for (const axis of AXES_IN_ORDER) {
      const codes = low.gates.holds[axis].codes;
      assert.ok(raisedIOn(low, axis), `${axis}: ${iTermFinding(low, axis)?.id} [${codes}]`);
      assert.ok(!codes.includes('OSCILLATION_ABOVE_I_TERM_BAND')
        && !codes.includes('STANDING_ERROR_WITH_UNMEASURED_BAND'), `${axis}: [${codes}]`);
    }
    for (const axis of ['pitch', 'yaw']) {
      const ripple = low.gates.holds[axis].evidence.summary.meanErrorRippleRmsDps;
      assert.ok(ripple > 0.2 && ripple < pidEvidence.HOLD_READING_THRESHOLDS.huntingRippleDps,
        `${axis}: the small fast oscillation must be there and under the threshold, or the `
        + `control tests nothing: ${ripple}`);
    }
  });

test('a standing error with in-band hunting over it is a next flight, never an all-clear', () => {
  // No integrator, a standing torque, and an external wobble inside the band:
  // both I-term signatures at once, which `interpretHoldEvidence` itself refuses
  // as CONFLICTING_HOLD_SIGNATURES. With the band in the right units every filter
  // in the sweep now agrees on that refusal — and the refusal fell through to
  // "Nothing in the yaw holds calls for an I-term change", about an aircraft
  // with no integrator at all.
  for (const hz of [0.5, 0.8, 1.0, 1.2, 1.4]) {
    const result = recommendFor(simulateHoldFlight({
      axis: 'yaw', gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400,
      externalTorqueDps2: 1000, externalTorqueHz: hz, durationS: 30
    }), 'yaw');
    const ids = result.findings.map(entry => entry.id);
    const hold = result.gates.holds.yaw;
    assert.ok(hold.codes.includes('CONFLICTING_HOLD_SIGNATURES'),
      `${hz} Hz: the fixture must carry both signatures: ${hold.codes}`);
    assert.ok(!ids.includes('I_TERM_WITHIN_TOLERANCE'), `${hz} Hz: ${ids.join(', ')}`);
    assert.deepEqual(adjustmentIds(result), [], `${hz} Hz: ${ids.join(', ')}`);

    const said = result.findings.find(entry => entry.id === 'I_TERM_SIGNATURES_CONFLICT');
    assert.ok(said, `${hz} Hz: the pilot must be told both were seen: ${ids.join(', ')}`);
    assert.equal(said.kind, 'next-flight');
    assert.equal(said.confidence, 'low');
    assert.equal(said.direction, null);
    assert.equal(said.actNow, false);
    assert.doesNotMatch(`${said.headline} ${said.reasoning}`, /neither sat off|nothing .*calls for/i);
    assert.ok(said.candidates.some(entry => /bind|linkage/i.test(entry)), `${said.candidates}`);
    assert.ok(said.candidates.some(entry => /authority/i.test(entry)), `${said.candidates}`);
    assert.ok(said.candidates.some(entry => /governor/i.test(entry)), `${said.candidates}`);
    assert.match(said.confirm, /calm/i);
    assert.match(said.confirm, /still/i);
    assert.match(said.confirm, /head.speed/i);
  }
});

test('the I-term all-clear never co-occurs with a sign of trouble in the holds', () => {
  // A property, over every kind of hold this simulator can fly: whenever the
  // engine says "nothing in the holds calls for an I-term change", the holds
  // carried a positive measurement of nothing wrong (HOLD_EVIDENCE_WITHIN_
  // TOLERANCE) and none of the codes that say something was wrong or was not
  // judged. Each family is drawn several times at random.
  const families = {
    standingNoI: r => ({gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 250 + r() * 700,
      gustDps2: r() * 400}),
    slowOnHealthy: r => ({gains: HOLD_NOMINAL, externalTorqueDps2: 1000 + r() * 5000,
      externalTorqueHz: 0.06 + r() * 0.23, externalTorquePhase: r() * 6.28}),
    inBandOnHealthy: r => ({gains: HOLD_NOMINAL, externalTorqueDps2: 600 + r() * 1500,
      externalTorqueHz: 0.5 + r() * 1.5}),
    inBandNoI: r => ({gains: {...HOLD_NOMINAL, ki: 0}, externalTorqueDps2: 600 + r() * 1500,
      externalTorqueHz: 0.5 + r() * 1.5}),
    bothSignatures: r => ({gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 300 + r() * 400,
      externalTorqueDps2: 800 + r() * 800, externalTorqueHz: 0.5 + r() * 1.0}),
    tooMuchI: r => ({gains: HOLD_SOFT, gustDps2: 1500 + r() * 1500}),
    bind: r => ({gains: HOLD_NOMINAL, disturbanceDps2: 150 + r() * 150,
      actuatorLimit: 0.15 + r() * 0.1}),
    nominal: r => ({gains: HOLD_NOMINAL, disturbanceDps2: r() * 300, gustDps2: r() * 300}),
    fastOnHealthy: r => ({gains: HOLD_NOMINAL, externalTorqueDps2: 2000 + r() * 2000,
      externalTorqueHz: 3.5 + r() * 2}),
    mixedKinds: r => ({gains: {...HOLD_NOMINAL, ki: r() < 0.5 ? 0 : 0.05},
      disturbanceDps2: 200 + r() * 300, durationS: 60,
      stops: [{atS: 1, amplitudeDps: 120, holdS: 0.3}, {atS: 13, amplitudeDps: 60, holdS: 11},
        {atS: 37, amplitudeDps: -60, holdS: 11}]}),
    // Round three: trouble under something that hides it. The review put 24 of
    // 24 of the first, and 6 of the second, on the all-clear.
    huntUnderFast: r => ({gains: HOLD_SOFT, gustDps2: 2200,
      externalTorqueDps2: 2000 + r() * 18000, externalTorqueHz: 3.5 + r() * 8.5}),
    huntUnderNoise: r => ({gains: HOLD_SOFT, gustDps2: 2200, noiseDps: 100 + r() * 300}),
    wanderUnderFast: r => ({gains: HOLD_NOMINAL, externalTorqueDps2: 3000, externalTorqueHz: 0.2,
      externalTorquePhase: r() * 6.28,
      extraTorques: [{dps2: 2000 + r() * 18000, hz: 3.5 + r() * 8.5}]})
  };
  const random = rng(4321);
  const violations = [];
  const reached = new Set();
  let cleared = 0;
  let runs = 0;
  for (const [name, make] of Object.entries(families)) {
    // Six quiet flights, since round three: a fast oscillation on a healthy loop
    // no longer earns the all-clear, and the property must still be shown to
    // hold where the all-clear IS reached, not only where it is refused.
    for (let draw = 0; draw < (name === 'nominal' ? 6 : 3); draw += 1) {
      const setup = make(random);
      const seed = 1 + Math.floor(random() * 1e6);
      const records = simulateHoldFlight({axis: 'yaw', durationS: 30, seed, ...setup});
      const result = recommendFor(records, 'yaw');
      runs += 1;
      const hold = result.gates.holds.yaw;
      for (const code of hold.codes) {
        reached.add(code);
      }
      if (!result.findings.some(entry => entry.id === 'I_TERM_WITHIN_TOLERANCE')) {
        continue;
      }
      cleared += 1;
      const trouble = hold.codes.filter(code => I_TERM_TROUBLE_CODES.includes(code));
      if (trouble.length > 0 || !hold.codes.includes('HOLD_EVIDENCE_WITHIN_TOLERANCE')) {
        violations.push(`${name} #${draw}: all-clear over [${hold.codes.join(',')}]`);
      }
    }
  }
  // The flight whose log lost its PID terms, and a run of the same one with them.
  // Three holds since round three, which a standing error needs before it is read
  // at all — and the I term's absence is only reached once it is.
  const threeHolds = holdLayout({holdsS: [9, 9, 9]});
  const untermed = simulateHoldFlight({gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400,
    commands: threeHolds.commands, durationS: threeHolds.durationS})
    .map(record => ({...record, terms: [0, 0, 0]}));
  const blind = recommendFor(untermed, 'yaw');
  for (const code of blind.gates.holds.yaw.codes) {
    reached.add(code);
  }
  if (blind.findings.some(entry => entry.id === 'I_TERM_WITHIN_TOLERANCE')) {
    violations.push(`no PID terms: all-clear over [${blind.gates.holds.yaw.codes.join(',')}]`);
  }

  assert.deepEqual(violations, [], `${violations.length} of ${runs} all-clears were unearned`);
  // Not vacuous: the all-clear was reached, and so was every kind of trouble
  // it must never sit on.
  assert.ok(cleared >= 6, `the all-clear must actually be reached, saw ${cleared}`);
  for (const code of ['STEADY_STATE_ERROR_PRESENT', 'LOW_FREQUENCY_HUNTING',
    'CONFLICTING_HOLD_SIGNATURES', 'SLOW_MOVEMENT_BELOW_I_TERM_BAND',
    'I_TERM_DOES_NOT_OSCILLATE_WITH_THE_ERROR', 'I_TERM_TOO_SMALL_A_SHARE_OF_THE_OUTPUT',
    'HOLD_KIND_MISMATCH', 'I_TERM_NOT_LOGGED', 'OSCILLATION_ABOVE_I_TERM_BAND',
    'SLOW_RIPPLE_NOT_CLEAR_OF_NOISE', 'TOO_FEW_HOLDS_FOR_A_STANDING_ERROR']) {
    assert.ok(reached.has(code), `the sweep never reached ${code}, so it proves nothing about it`);
  }
});

test('the I-term all-clear is earned by a positive measurement, never by elimination', () => {
  // `earnsITermAllClear` is the one door to "nothing in the holds calls for an
  // I-term change". Every code that says something was wrong, or was not
  // judged, must shut it — checked against this file's own list, so a code
  // dropped from the module's list is caught here rather than on a pilot's
  // flight — and an absence of codes must not open it.
  //
  // That holdFindings still asks it is shown by flights since round three: the
  // fast-oscillation, noisy-ripple and two-hold roads reach I_TERM_NOT_JUDGED
  // only through it ('the I-term all-clear rests on a measurement ...', and
  // 'too little I still earns "Raise I" ...').
  assert.equal(earnsITermAllClear(['HOLD_EVIDENCE_WITHIN_TOLERANCE']), true);
  assert.equal(earnsITermAllClear(['HOLD_EVIDENCE_WITHIN_TOLERANCE',
    'DRIFT_NOT_SEPARABLE_FROM_ERROR', 'CLIPPED_BY_WINDOW']), true);
  // UPDATED in round three: this pinned OSCILLATION_ABOVE_I_TERM_BAND as
  // compatible with the all-clear, "because a fast oscillation averages out of
  // a hold". Its mean does; but it also dominates the crossing count, so a hunt
  // or a wander under it is never measured. The pin was the defect.
  assert.equal(earnsITermAllClear(['HOLD_EVIDENCE_WITHIN_TOLERANCE',
    'DRIFT_NOT_SEPARABLE_FROM_ERROR', 'OSCILLATION_ABOVE_I_TERM_BAND', 'CLIPPED_BY_WINDOW']), false,
  'a fast oscillation hides whatever moved more slowly under it');
  assert.equal(earnsITermAllClear([]), false, 'nothing measured is not nothing wrong');
  assert.equal(earnsITermAllClear(['DRIFT_NOT_SEPARABLE_FROM_ERROR']), false);
  assert.equal(earnsITermAllClear(undefined), false);
  for (const code of I_TERM_TROUBLE_CODES) {
    assert.equal(earnsITermAllClear(['HOLD_EVIDENCE_WITHIN_TOLERANCE', code]), false,
      `${code} must rule out the all-clear`);
  }
});

test('an I-term reading that will not settle names the readings it flipped between', () => {
  // Found while sweeping round two: no integrator against a standing torque,
  // with a small wobble over it, reads "raise I" at a high ripple threshold and
  // CONFLICTING at a low one. A flip is rightly not a verdict — but the card
  // listed "the I term is slightly high" and "the I term is fine" as the
  // candidates, about an aircraft with no I term, because both were written in
  // for the one flip this card was first built for.
  for (const torque of [200, 400]) {
    for (const hz of [0.8, 1.4]) {
      // Three holds since round three, or "raise I" is not read at any point
      // of the sweep and there is no flip to name.
      const result = recommendFor(simulateHoldFlight({
        gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400, externalTorqueDps2: torque,
        externalTorqueHz: hz, ...THREE_HOLDS
      }), 'yaw');
      const hold = result.gates.holds.yaw;
      const label = `${torque} at ${hz} Hz: [${hold.sweepIndicationsSeen}]`;
      assert.deepEqual([...hold.sweepIndicationsSeen].sort(), ['hold', 'increase'], label);
      const said = result.findings.find(entry => entry.id === 'I_TERM_VERDICT_UNSTABLE');
      assert.ok(said, `${label}: ${result.findings.map(entry => entry.id).join(', ')}`);
      assert.ok(said.candidates.some(entry => /too little|slightly low/i.test(entry)),
        `${label}: ${said.candidates}`);
      assert.ok(!said.candidates.some(entry => /slightly high|too much/i.test(entry)),
        `${label}: nothing read "too much I": ${said.candidates}`);
    }
  }
  // CONTROL: the flip this card was built for still names "slightly high".
  const marginal = recommendFor(simulateHoldFlight({gains: HOLD_SOFT, gustDps2: 600}), 'yaw');
  const flipped = marginal.findings.find(entry => entry.id === 'I_TERM_VERDICT_UNSTABLE');
  assert.ok(flipped, marginal.findings.map(entry => entry.id).join(', '));
  assert.ok(marginal.gates.holds.yaw.sweepIndicationsSeen.includes('decrease'));
  assert.ok(flipped.candidates.some(entry => /slightly high/.test(entry)), `${flipped.candidates}`);
  assert.ok(!flipped.candidates.some(entry => /slightly low/.test(entry)), `${flipped.candidates}`);
});

test('an in-band wobble the I term does not carry is named, not cleared', () => {
  // No integrator at all, and a wobble inside the band: the error hunts, and the
  // I term — zero — does not move with it, so the engine rightly refuses "lower
  // I" (I_TERM_DOES_NOT_OSCILLATE_WITH_THE_ERROR). That refusal fell through to
  // "nothing in the holds calls for an I-term change" over an error swinging
  // several deg/s.
  for (const hz of [0.6, 1.0, 1.6]) {
    const result = recommendFor(simulateHoldFlight({
      axis: 'yaw', gains: {...HOLD_NOMINAL, ki: 0}, externalTorqueDps2: 1200,
      externalTorqueHz: hz, durationS: 30
    }), 'yaw');
    const hold = result.gates.holds.yaw;
    assert.ok(hold.codes.includes('I_TERM_DOES_NOT_OSCILLATE_WITH_THE_ERROR'),
      `${hz} Hz: the fixture must reach the refusal: ${hold.codes}`);
    const said = iTermFinding(result, 'yaw');
    assert.equal(said?.id, 'SLOW_WANDER_NOT_FROM_THE_I_TERM',
      `${hz} Hz: ${result.findings.map(entry => entry.id).join(', ')}`);
    assert.match(said.reasoning, /does not move with|did not move with/i, said.reasoning);
    assert.equal(said.direction, null);
  }
});

/**
 * One physical flight, flown on all three axes the way `ui/app.mjs` analyses it:
 * each axis a closed loop with its own short pulses, the same records handed to
 * every axis. A still hover between pulses is a hold on roll, pitch AND yaw.
 */
function threeAxisHoldFlight({stops, durationS, headspeed = () => 1800, ki = 0}) {
  const per = ['roll', 'pitch', 'yaw'].map((axis, at) => simulateHoldFlight({
    axis, gains: {...HOLD_NOMINAL, ki}, disturbanceDps2: 400, durationS, stops, seed: 11 + at
  }));
  return per[0].map((record, at) => ({
    ...record,
    setpoint: [per[0][at].setpoint[0], per[1][at].setpoint[1], per[2][at].setpoint[2]],
    gyro: [per[0][at].gyro[0], per[1][at].gyro[1], per[2][at].gyro[2]],
    raw: [per[0][at].raw[0], per[1][at].raw[1], per[2][at].raw[2]],
    // buildAnalysisRecords gives each axis its own P/I/D terms. One axis's are
    // carried here because the head-speed question never reads them.
    terms: per[2][at].terms,
    headspeed: headspeed(record.timeUs / 1e6, at)
  }));
}

/** Every axis analysed from the same records, exactly as ui/app.mjs passes them. */
function recommendAllAxes(records) {
  const axes = {};
  const axisSummaries = {};
  for (const axis of AXES_IN_ORDER) {
    axes[axis] = {...analyseAxisEvidence(records, axis), records};
    axisSummaries[axis] = {gyroHighFrequencyRmsDps: 0.5};
  }
  return buildRecommendations({records, mechanical: cleanAirframe(), axes, axisSummaries});
}
const AXES_IN_ORDER = Object.freeze(['roll', 'pitch', 'yaw']);

test('one hover is one steady segment, however many axes are analysed through it', () => {
  // ONE hover, the head speed moving 8% through it. Every axis sees it as a
  // hold and refuses it for HOLD_HEADSPEED_UNSTABLE, so counted per axis it was
  // "3 of the 3 steady segments" — the two-segment minimum defeated in the app's
  // own shape, and the same flight read differently with one axis analysed.
  const pulse = [{atS: 1, amplitudeDps: 120, holdS: 0.3}];
  const wandering = (seconds, from, to) => (seconds > from && seconds < to
    ? 1800 * (1 + 0.08 * Math.sin(2 * Math.PI * 0.2 * seconds)) : 1800);
  const one = threeAxisHoldFlight({
    stops: pulse, durationS: 14, headspeed: seconds => wandering(seconds, 3, 13)
  });
  const all = recommendAllAxes(one);
  const perAxisRefusals = AXES_IN_ORDER.map(axis =>
    all.gates.holds[axis].evidence.rejectedHoldCounts.HOLD_HEADSPEED_UNSTABLE ?? 0);
  assert.deepEqual(perAxisRefusals, [1, 1, 1],
    'the fixture must be one hover that every axis saw and refused');
  assert.equal(all.gates.headspeed.measured.holdsRejectedForHeadspeed, 1,
    'one hover is one segment, however many axes were analysed through it');
  assert.equal(all.gates.headspeed.measured.holdsEvaluated, 1);
  assert.equal(all.gates.headspeed.status, 'permitted',
    'one segment is under the two the governor is judged on');
  const ids = all.findings.map(entry => entry.id);
  assert.ok(!ids.includes('HEADSPEED_STEADY_ENOUGH'), ids.join(', '));
  assert.ok(!ids.includes('HEADSPEED_MOVED_DURING_STEADY_FLIGHT'), ids.join(', '));
  const tooFew = all.findings.find(entry => entry.id === 'HEADSPEED_TOO_FEW_SEGMENTS_TO_JUDGE');
  assert.ok(tooFew, ids.join(', '));
  assert.match(tooFew.headline, /\b1 of the 1\b/, tooFew.headline);

  // FOUR hovers, the head speed moving through three of them: blocked, and the
  // count it prints is of hovers, not of axis-hovers.
  const fourPulses = [1, 12, 23, 34].map(atS => ({atS, amplitudeDps: 120, holdS: 0.3}));
  const governor = threeAxisHoldFlight({
    stops: fourPulses, durationS: 46,
    headspeed: seconds => (seconds > 14 && seconds < 45 ? wandering(seconds, 14, 45) : 1800)
  });
  const blocked = recommendAllAxes(governor);
  assert.equal(blocked.gates.headspeed.status, 'blocked', `${blocked.gates.headspeed.codes}`);
  assert.equal(blocked.gates.headspeed.measured.holdsEvaluated, 4);
  assert.equal(blocked.gates.headspeed.measured.holdsRejectedForHeadspeed, 3);
  const moved = blocked.findings.find(entry => entry.id === 'HEADSPEED_MOVED_DURING_STEADY_FLIGHT');
  assert.ok(moved, blocked.findings.map(entry => entry.id).join(', '));
  assert.match(moved.headline, /\b3 of the 4\b/, moved.headline);
  // The same flight through one axis reads the same: the verdict does not depend
  // on how many axes the app had memory for.
  const yawOnly = recommendFor(governor, 'yaw');
  assert.equal(yawOnly.gates.headspeed.status, 'blocked');
  assert.equal(yawOnly.gates.headspeed.measured.holdsEvaluated, 4);

  // One dropped RPM sample in one hover, every axis analysed: ONE segment lost.
  const glitch = threeAxisHoldFlight({
    stops: fourPulses, durationS: 46,
    headspeed: (seconds, at) => (at === 18_000 ? Number.NaN : 1800)
  });
  const dropped = recommendAllAxes(glitch);
  assert.equal(dropped.gates.headspeed.measured.holdsRejectedForHeadspeedReading, 1);
  const dropout = dropped.findings.find(entry => entry.id === 'HEADSPEED_READING_DROPPED_OUT');
  assert.ok(dropout, dropped.findings.map(entry => entry.id).join(', '));
  assert.match(dropout.headline, /during 1 steady segment\b/, dropout.headline);
});

test('a head speed that moved where it was measured is never called steady', () => {
  // One hover, the head speed moving 8% through it: the only measurement says
  // the head speed moved, and it is under the two segments the governor is
  // judged on. That is "too few to judge", with the count — not "the head speed
  // held well enough".
  const one = simulateHoldFlight({
    gains: HOLD_NOMINAL, disturbanceDps2: 400, durationS: 14,
    stops: [{atS: 1, amplitudeDps: 120, holdS: 0.3}]
  }).map(record => {
    const seconds = record.timeUs / 1e6;
    return seconds > 3 && seconds < 13
      ? {...record, headspeed: 1800 * (1 + 0.08 * Math.sin(2 * Math.PI * 0.2 * seconds))}
      : record;
  });
  const result = recommendFor(one, 'yaw');
  assert.deepEqual({...result.gates.holds.yaw.evidence.rejectedHoldCounts},
    {HOLD_HEADSPEED_UNSTABLE: 1}, 'the fixture must be one hover, refused for head speed');
  assert.equal(result.gates.headspeed.status, 'permitted');
  const ids = result.findings.map(entry => entry.id);
  assert.ok(!ids.includes('HEADSPEED_STEADY_ENOUGH'), ids.join(', '));
  const said = result.findings.find(entry => entry.id === 'HEADSPEED_TOO_FEW_SEGMENTS_TO_JUDGE');
  assert.ok(said, ids.join(', '));
  assert.equal(said.kind, 'next-flight');
  assert.equal(said.direction, null);
  assert.match(said.headline, /\b1 of the 1\b/, said.headline);
  assert.match(`${said.headline} ${said.reasoning}`, /too few/i);
  assert.doesNotMatch(`${said.headline} ${said.reasoning}`, /held (?:well|steady)/i);
  // UPDATED 3 October 2026 (re-review of round three): this pinned the confirm
  // to 2 hovers, the governor rung's own minimum. Those hovers are holds, and 2
  // is a count a standing error cannot be read from; every hold count the copy
  // asks for is now the one a full reading needs, which also covers the governor.
  assert.match(said.confirm, new RegExp(`\\bFly ${pidEvidence.HOLDS_FOR_A_FULL_READING} or more `
    + 'still hovers'), said.confirm);
  assert.match(said.reasoning, new RegExp(`judged over ${pidEvidence.EVIDENCE_LIMITS.minimumHolds} `
    + 'or more steady segments'), said.reasoning);
  assert.match(said.confirm, /5 s/, said.confirm);

  // Four hovers, the head speed moving through only the second: enough
  // segments, under half lost. Not a blocker — and not "steady" either.
  const stops = [1, 12, 23, 34].map(atS => ({atS, amplitudeDps: 120, holdS: 0.3}));
  const flown = simulateHoldFlight({
    gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400, durationS: 46, stops
  }).map(record => {
    const seconds = record.timeUs / 1e6;
    return seconds > 14 && seconds < 22
      ? {...record, headspeed: 1800 * (1 + 0.08 * Math.sin(2 * Math.PI * 0.2 * seconds))}
      : record;
  });
  const some = recommendFor(flown, 'yaw');
  assert.deepEqual({...some.gates.holds.yaw.evidence.rejectedHoldCounts},
    {HOLD_HEADSPEED_UNSTABLE: 1});
  assert.equal(some.gates.headspeed.status, 'permitted');
  const someIds = some.findings.map(entry => entry.id);
  assert.ok(!someIds.includes('HEADSPEED_STEADY_ENOUGH'), someIds.join(', '));
  const partly = some.findings.find(entry => entry.id === 'HEADSPEED_MOVED_IN_SOME_SEGMENTS');
  assert.ok(partly, someIds.join(', '));
  assert.equal(partly.kind, 'observation');
  assert.match(partly.headline, /\b1 of the 4\b/, partly.headline);
  // And the three holds that were measured still earn what they earn.
  assert.deepEqual(adjustmentIds(some), ['I_TOO_LOW'], someIds.join(', '));

  // CONTROL: a rock-steady head speed is still called steady, with its count.
  const steady = recommendFor(simulateHoldFlight({
    gains: {...HOLD_NOMINAL, ki: 0}, disturbanceDps2: 400, durationS: 46, stops
  }), 'yaw');
  assert.ok(steady.findings.some(entry => entry.id === 'HEADSPEED_STEADY_ENOUGH'),
    steady.findings.map(entry => entry.id).join(', '));
});

test('a segment where the head speed moved on one axis\'s hold and held on another\'s is said as it was',
  () => {
    // ROUND THREE. A merged segment counts as one in which the head speed MOVED
    // if any axis refused its hold for that, while another axis may have measured
    // a hold inside the same segment over a stretch where it held — and used it.
    // The card said "only segments that held were used", which that flight
    // contradicts (found on the reference log's whole session). What IS true is
    // per hold: every hold that was used held its head speed all the way through.
    //
    // Yaw holds still from 1.4 to 20 s while the head speed moves 8% between 12
    // and 18 s, so yaw refuses it. Roll and pitch blip their sticks by 20 deg/s
    // (inside the other axes' 30 deg/s, outside their own 15 deg/s band) from
    // 8 s, so their first hold ends before the head speed moves, and is used.
    const yawCommands = [{atS: 1, untilS: 1.4, dps: 120}, {atS: 20, untilS: 20.4, dps: 120},
      {atS: 34, untilS: 34.4, dps: 120}];
    const blips = [8, 11, 14, 17].map(atS => ({atS, untilS: atS + 0.4, dps: 20}));
    const cyclicCommands = [{atS: 1, untilS: 1.4, dps: 120}, ...blips,
      {atS: 20, untilS: 20.4, dps: 120}, {atS: 34, untilS: 34.4, dps: 120}];
    const setups = {
      roll: {gains: HOLD_NOMINAL, disturbanceDps2: 200, commands: cyclicCommands, seed: 81},
      pitch: {gains: HOLD_NOMINAL, disturbanceDps2: 200, commands: cyclicCommands, seed: 82},
      yaw: {gains: HOLD_NOMINAL, disturbanceDps2: 200, commands: yawCommands, seed: 83}
    };
    const moving = seconds => (seconds > 12 && seconds < 18
      ? 1800 * (1 + 0.08 * Math.sin(2 * Math.PI * 0.2 * seconds)) : 1800);
    const result = recommendEachAxis(threeAxisRecords(setups, 46, moving));
    // The fixture: yaw refused its first hold for the head speed; roll and pitch
    // measured theirs, in the same stretch of flight.
    assert.equal(result.gates.holds.yaw.evidence.rejectedHoldCounts.HOLD_HEADSPEED_UNSTABLE, 1);
    for (const axis of ['roll', 'pitch']) {
      const first = result.gates.holds[axis].evidence.holds[0];
      assert.ok(first && first.startTimeUs < 2_000_000 && first.endTimeUs <= 8_000_000,
        `${axis}: its first hold must be measured inside the yaw hold: ${JSON.stringify(first)}`);
    }
    const measured = result.gates.headspeed.measured;
    assert.equal(measured.holdsEvaluated, 3, JSON.stringify(measured));
    // Since 3 October 2026 the mixed segment is not LOST — a hold was measured in
    // it — so it is reported on its own and kept out of the governor's count.
    assert.equal(measured.holdsRejectedForHeadspeed, 0);
    assert.equal(measured.holdsMovedWithAHoldUsedInside, 1,
      'the mixed segment is counted, so moved and measured can both be true of it');

    const said = result.findings.find(entry =>
      entry.id === 'HEADSPEED_MOVED_WHERE_A_HOLD_WAS_STILL_MEASURED');
    assert.ok(said, result.findings.map(entry => entry.id).join(', '));
    assert.equal(said.kind, 'observation');
    const text = `${said.headline} ${said.reasoning}`;
    assert.match(said.headline, /\b1 of the 3\b/, said.headline);
    assert.doesNotMatch(text, /only segments that held were used/, text);
    // Every hold that was used held its head speed all the way through it.
    assert.match(text, /held its head speed all the way through|head speed held all the way/i, text);
    assert.match(said.reasoning, /another axis/i, said.reasoning);
    // And that sentence is TRUE: every hold the engine used kept within the limit.
    for (const axis of AXES_IN_ORDER) {
      for (const hold of result.gates.holds[axis].evidence.holds) {
        assert.ok(hold.headspeedVariationRatio <= 0.05, `${axis}: ${hold.headspeedVariationRatio}`);
      }
    }
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

/* =========================================================================== */
/* 10. REVIEW OF 3 OCTOBER 2026                                                */
/* =========================================================================== */

/** Every sentence a finding speaks, joined, for checks that no word leaks into any of them. */
function spokenText(finding) {
  return [finding.headline, finding.reasoning, finding.confirm, ...(finding.candidates ?? [])]
    .filter(part => typeof part === 'string').join(' ');
}

test('a hover where one axis lost its hold to head speed and another measured one is not lost',
  () => {
    // THE REVIEW'S SCENARIO, in the app's three-axis shape. Two hovers. In each,
    // roll and pitch measure a hold over the first part, where the head speed is
    // steady, and blip their sticks inside the other axes' band so it ends there;
    // yaw holds through the whole hover and is refused because the head speed
    // moved later in it. Counted as "moved" whenever any axis was refused, that
    // was 2 of the 2 segments read — and every gain on the flight was blocked
    // over two hovers that each had a hold measured at a steady head speed.
    const yawCommands = [{atS: 1, untilS: 1.4, dps: 120}, {atS: 20, untilS: 20.4, dps: 120},
      {atS: 34, untilS: 34.4, dps: 120}];
    const blips = [8, 11, 14, 17, 27, 30, 33].map(atS => ({atS, untilS: atS + 0.4, dps: 20}));
    const cyclicCommands = [...yawCommands, ...blips];
    const setups = {
      roll: {gains: HOLD_NOMINAL, disturbanceDps2: 200, commands: cyclicCommands, seed: 91},
      pitch: {gains: HOLD_NOMINAL, disturbanceDps2: 200, commands: cyclicCommands, seed: 92},
      yaw: {gains: HOLD_NOMINAL, disturbanceDps2: 200, commands: yawCommands, seed: 93}
    };
    const moving = seconds => ((seconds > 12 && seconds < 18) || (seconds > 28 && seconds < 33.8)
      ? 1800 * (1 + 0.08 * Math.sin(2 * Math.PI * 0.2 * seconds)) : 1800);
    const result = recommendEachAxis(threeAxisRecords(setups, 34.3, moving));

    // The fixture: yaw refused both hovers for the head speed, and roll and pitch
    // each measured a hold inside both, before the head speed moved.
    assert.equal(result.gates.holds.yaw.evidence.rejectedHoldCounts.HOLD_HEADSPEED_UNSTABLE, 2,
      JSON.stringify(result.gates.holds.yaw.evidence.rejectedHoldCounts));
    for (const axis of ['roll', 'pitch']) {
      const starts = result.gates.holds[axis].evidence.holds.map(hold => hold.startTimeUs / 1e6);
      assert.ok(starts.some(at => at < 8) && starts.some(at => at > 20 && at < 27),
        `${axis}: a hold must be measured inside each hover: ${starts}`);
    }

    const measured = result.gates.headspeed.measured;
    assert.equal(measured.holdsEvaluated, 2, JSON.stringify(measured));
    assert.equal(measured.holdsRejectedForHeadspeed, 0,
      'a segment with a hold measured at a steady head speed was not lost to head speed');
    assert.equal(measured.holdsMovedWithAHoldUsedInside, 2, JSON.stringify(measured));
    assert.equal(measured.headspeedShareOfEvaluatedHolds, 0);
    assert.equal(result.gates.headspeed.status, 'permitted', `${result.gates.headspeed.codes}`);
    const ids = result.findings.map(entry => entry.id);
    assert.ok(!ids.includes('HEADSPEED_MOVED_DURING_STEADY_FLIGHT'), ids.join(', '));
    assert.ok(!ids.includes('HEADSPEED_TOO_FEW_SEGMENTS_TO_JUDGE'), ids.join(', '));
    assert.ok(!ids.includes('HEADSPEED_STEADY_ENOUGH'),
      'the head speed did move, and that is said rather than called steady');

    // Said as it was, and not as a blocker.
    const said = result.findings.find(entry => entry.rung === 'headspeed'
      && /moved/.test(entry.headline));
    assert.ok(said, ids.join(', '));
    assert.equal(said.kind, 'observation');
    assert.equal(said.adjust ?? null, null);
    assert.match(said.headline, /\b2 of the 2\b/, said.headline);
    assert.match(spokenText(said), /another axis|other ax[ie]s/i, said.headline);
    assert.doesNotMatch(spokenText(said), /cost it|lost to head speed in 2/i, spokenText(said));
    // The headline's count is the one the basis publishes.
    const mixedBasis = said.basis.find(entry => /another axis/.test(entry.label));
    assert.equal(mixedBasis?.value, 2, JSON.stringify(said.basis));

    // CONTROL: the same hovers with yaw ALONE analysed. Nothing measured a hold
    // in either hover, so both really were lost to head speed, and it blocks.
    const yawOnly = recommendFor(threeAxisRecords(setups, 34.3, moving).yaw, 'yaw');
    assert.equal(yawOnly.gates.headspeed.measured.holdsRejectedForHeadspeed, 2);
    assert.equal(yawOnly.gates.headspeed.status, 'blocked');
    const blocker = yawOnly.findings.find(entry => entry.id === 'HEADSPEED_MOVED_DURING_STEADY_FLIGHT');
    assert.ok(blocker, yawOnly.findings.map(entry => entry.id).join(', '));
    assert.match(blocker.headline, /cost it 2 of the 2\b/, blocker.headline);
  });

test('an in-band movement that changed side between holds is never called slower than the band',
  () => {
    // No integrator, and a torque at 0.04 Hz whose peaks and troughs fall on
    // alternate holds, with a small 1.1 Hz torque on top: each hold's error
    // stands clear of its own movement and changes side from hold to hold, and
    // the slow part of the error crosses its own average INSIDE the 0.3-3 Hz
    // band. That flight used to read "wandered slowly ... slower than an
    // integrator makes an aircraft hunt" — false of the movement it measured.
    const commands = [{atS: 1, untilS: 1.4, dps: 120}];
    const holdS = 5.5;
    const halfPeriodS = 12.5;
    let durationS = 0;
    for (let index = 0; index < 4; index += 1) {
      const start = 1.4 + halfPeriodS * index;
      durationS = start + holdS;
      // Between holds, stick blips every second: nothing there is long enough to
      // be a hold, so only the peaks and troughs are held.
      for (let at = durationS; index < 3 && at < start + halfPeriodS - 0.5; at += 1) {
        commands.push({atS: at, untilS: at + 0.4, dps: 120});
      }
    }
    const peakPhase = Math.PI / 2 - 2 * Math.PI * 0.04 * (1.4 + holdS / 2);
    const setups = {};
    for (const axis of AXES_IN_ORDER) {
      setups[axis] = {commands, gains: {...HOLD_NOMINAL, ki: 0}, seed: 9001,
        externalTorqueHz: 0.04, externalTorqueDps2: axis === 'yaw' ? 1200 : 0,
        externalTorquePhase: peakPhase,
        extraTorques: axis === 'yaw' ? [{dps2: 100, hz: 1.1}] : []};
    }
    const result = recommendEachAxis(threeAxisRecords(setups, durationS));
    const hold = result.gates.holds.yaw;
    assert.ok(hold.codes.includes('STANDING_ERROR_CHANGES_SIDE_BETWEEN_HOLDS'), `${hold.codes}`);
    assert.ok(!hold.codes.includes('SLOW_MOVEMENT_BELOW_I_TERM_BAND'), `${hold.codes}`);
    const [bandLow, bandHigh] = hold.evidence.measurement?.huntingBandHz ?? [0.3, 3];
    const oscillationHz = hold.evidence.summary.meanErrorCrossingRateHz / 2;
    assert.ok(oscillationHz >= bandLow && oscillationHz <= bandHigh,
      `the fixture's movement must be in band: ${oscillationHz} Hz`);

    const said = iTermFinding(result, 'yaw');
    assert.equal(said?.id, 'I_TERM_NOT_JUDGED', `${said?.id}: ${said?.headline}`);
    assert.equal(said.direction, null);
    const text = spokenText(said);
    assert.doesNotMatch(text, /slower than/i, text);
    // Said as what was measured: the side, hold by hold.
    assert.match(said.reasoning, /one side in \d+ and on the other in \d+/, said.reasoning);
    assert.match(said.reasoning, /inside the [\d.]+-[\d.]+ Hz band/, said.reasoning);
    assert.ok(said.candidates.some(entry => /too little I/i.test(entry)), said.candidates);
    assert.ok(!raisedIOn(result, 'yaw'));

    // CONTROL: a movement below the band (the reviewer's round-one 0.22 Hz cell)
    // still reads as a slow wander, and still says it was slower than the band.
    const slow = recommendFor(simulateHoldFlight({
      axis: 'yaw', gains: HOLD_NOMINAL, externalTorqueDps2: 3000, externalTorqueHz: 0.22,
      durationS: 40
    }), 'yaw');
    const wander = iTermFinding(slow, 'yaw');
    assert.equal(wander?.id, 'SLOW_WANDER_NOT_FROM_THE_I_TERM', wander?.id);
    assert.match(spokenText(wander), /slower than/, spokenText(wander));
  });

test('a stop direction whose commanded rate was not measured is not a small shortfall', () => {
  // `meanCommandAmplitudeDps` null or zero on one side leaves the shortfall as
  // a share of the command unknown there. It used to fall to the too-small-for-P
  // road and print "only null% below the rate asked for". Driven through the
  // engine in the app's three-axis shape, with one direction's commanded rate
  // removed from the evidence it is handed.
  const withoutCommand = (records, value, sides) => {
    const axes = {};
    const axisSummaries = {};
    for (const axis of AXES_IN_ORDER) {
      const material = analyseAxisEvidence(records, axis);
      axes[axis] = axis === 'yaw'
        ? {...material, records, shapes: material.shapes.map(entry => (sides.includes(entry.commandSign)
          ? {...entry, event: {...entry.event, commandAmplitudeDps: value}} : entry))}
        : {...material, records};
      axisSummaries[axis] = {gyroHighFrequencyRmsDps: 0.5};
    }
    return buildRecommendations({records, mechanical: cleanAirframe(), axes, axisSummaries});
  };

  // 1% (the too-small road when measured) and 6% (which earns "Raise P" when
  // measured): neither may become a small shortfall, or a P change, when one
  // side's command is missing.
  for (const [label, setup] of [['1%', {}], ['6%', {shortfalls: [0.06, 0.06]}]]) {
    const records = laggedLoopFlight(setup);
    for (const [value, sides] of [[null, ['negative']], [0, ['negative']],
      [null, ['positive', 'negative']]]) {
      const result = withoutCommand(records, value, sides);
      const where = `${label}, command ${value} on ${sides.join(' and ')}`;
      assert.ok(!result.findings.some(entry => entry.id === 'P_TOO_LOW'), where);
      assert.ok(!result.withheld.some(entry => entry.findingId === 'P_TOO_LOW'), where);
      const finding = result.findings.find(entry => entry.id === 'AXIS_DOES_NOT_ARREST'
        && entry.axis === 'yaw');
      assert.ok(finding, `${where}: ${result.findings.map(entry => entry.id).join(', ')}`);
      assert.ok(!finding.codes.includes('STANDING_OFFSET_TOO_SMALL_FOR_P'),
        `${where}: ${finding.codes}`);
      assert.ok(finding.codes.includes('COMMANDED_RATE_NOT_MEASURED'), `${where}: ${finding.codes}`);
      assert.match(spokenText(finding), /not measured|could not be measured/i, spokenText(finding));
      assert.doesNotMatch(spokenText(finding), /too closely|that small/i, spokenText(finding));
      for (const entry of result.findings) {
        assert.doesNotMatch(spokenText(entry), /\bnull\b|\bNaN\b|undefined/,
          `${where}, ${entry.id}: ${spokenText(entry)}`);
      }
    }
  }
});

/* =========================================================================== */
/* 11. HOLDS, ROUND THREE RE-REVIEWED (3 OCTOBER 2026)                          */
/* =========================================================================== */

/** Number words a sentence might spell a count of holds in. */
const COUNT_WORDS = Object.freeze({one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10});
const COUNT = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)';

/**
 * Every count of holds a sentence ASKS a pilot to fly: "fly 3 or more still
 * holds", "fly two long still holds", "until you have 2 such holds", "2 are
 * needed", "takes 3 holds". A count of holds that WERE measured ("1 usable steady
 * hold", "in every one of the 3 holds") is not a request and is not read, and
 * neither is a count of stops ("fly two or three more stops each way").
 */
const HOLD_NOUN = '(?=[^.;:]{0,40}?\\b(?:holds?|hovers?|segments?|turns?)\\b)';
const HOLD_REQUESTS = Object.freeze([
  new RegExp(`\\bfly\\s+(?:the same\\s+|another\\s+|at least\\s+)?${COUNT}\\b${HOLD_NOUN}`, 'gi'),
  new RegExp(`\\buntil you have\\s+${COUNT}\\s+such\\s+holds\\b`, 'gi'),
  new RegExp(`\\b${COUNT}\\s+(?:are|is)\\s+needed\\b`, 'gi'),
  new RegExp(`\\btakes\\s+${COUNT}\\s+holds?\\b`, 'gi')
]);

function requestedHoldCounts(text) {
  const counts = [];
  for (const pattern of HOLD_REQUESTS) {
    for (const match of String(text ?? '').matchAll(pattern)) {
      const word = match[1].toLowerCase();
      counts.push(COUNT_WORDS[word] ?? Number(word));
    }
  }
  return counts;
}

test('every count of holds the copy asks a pilot to fly is the count a full reading needs', () => {
  // Round three made three holds the fewest a standing error is read from, and
  // the copy went on asking for two: the manoeuvre brief ("Repeat until you have
  // 2 such holds"), the not-enough-yet card ("2 are needed before the I term can
  // be called"), and the confirms of I_TOO_LOW, I_TOO_HIGH,
  // I_TERM_SIGNATURES_CONFLICT and I_TERM_NOT_LOGGED ("fly two long still
  // holds"). A pilot with too little I who flew what he was told came back to "2
  // holds are too few to call that a standing error"; and after "Raise I", a
  // two-hold re-fly could not confirm the error had closed.
  //
  // Every count is now HOLDS_FOR_A_FULL_READING, derived from both minimums, so
  // the two cannot drift apart again. The flights below reach every card that
  // asks for holds, through the real engine, and every count they ask for is
  // read back out of what they say.
  const needed = pidEvidence.HOLDS_FOR_A_FULL_READING;
  const limits = pidEvidence.EVIDENCE_LIMITS;
  assert.equal(needed, Math.max(limits.minimumHolds, limits.minimumHoldsForStandingError));

  // The reader catches every sentence that drifted, or it proves nothing.
  for (const sentence of ['and fly two long still holds again.',
    'Repeat until you have 2 such holds.',
    '1 usable steady hold on yaw, and 2 are needed before the I term can be called.',
    'Turn the PID term fields on, and fly the same two long, still holds again.',
    'Fly two or three more long, still holds on this axis.',
    'Fly 2 or more still hovers, each held for 5 s or more.',
    'Fly 2 or more steady yaw segments of ONE kind.']) {
    assert.deepEqual(requestedHoldCounts(sentence), [2], sentence);
  }
  assert.deepEqual(requestedHoldCounts('on the same side in every one of the 3 holds, and 1 usable '
    + 'steady hold on yaw; fly the same hold again with the other two axes quiet. Fly two or three '
    + 'more stops each way. Repeat until you have 2 nose left and 2 nose right.'), []);

  const one = holdLayout({holdsS: [9]});
  const two = holdLayout({holdsS: [10, 12]});
  const noI = {...HOLD_NOMINAL, ki: 0};
  const flights = [
    ['one hold', 'HOLD_EVIDENCE_PROVISIONAL',
      simulateHoldFlight({gains: noI, disturbanceDps2: 500, ...one})],
    ['too little I', 'I_TOO_LOW', simulateHoldFlight({gains: noI, disturbanceDps2: 400, ...THREE_HOLDS})],
    ['too much I', 'I_TOO_HIGH', simulateHoldFlight({gains: HOLD_SOFT, gustDps2: 2200})],
    ['both signatures', 'I_TERM_SIGNATURES_CONFLICT', simulateHoldFlight({gains: noI,
      disturbanceDps2: 400, externalTorqueDps2: 1000, externalTorqueHz: 1.0, durationS: 30})],
    ['no PID terms', 'I_TERM_NOT_LOGGED', simulateHoldFlight({gains: noI, disturbanceDps2: 400,
      ...THREE_HOLDS}).map(record => ({...record, terms: [0, 0, 0]}))],
    ['two holds', 'I_TERM_NOT_JUDGED', simulateHoldFlight({gains: noI, disturbanceDps2: 500, ...two})],
    ['hovers and turns', 'I_TERM_HOLDS_MIXED', simulateHoldFlight({gains: noI, disturbanceDps2: 300,
      durationS: 60, stops: [{atS: 1, amplitudeDps: 120, holdS: 0.3},
        {atS: 13, amplitudeDps: 60, holdS: 11}, {atS: 37, amplitudeDps: -60, holdS: 11}]})],
    ['a reading that flips', 'I_TERM_VERDICT_UNSTABLE',
      simulateHoldFlight({gains: HOLD_SOFT, gustDps2: 600})],
    // One hover, its head speed wandering: the hold is lost, and the governor
    // cannot be judged from one segment.
    ['one hover, the head speed moving', 'HEADSPEED_TOO_FEW_SEGMENTS_TO_JUDGE',
      simulateHoldFlight({gains: HOLD_NOMINAL, ...one}).map(record => ({...record,
        headspeed: 1800 * (1 + 0.08 * Math.sin(2 * Math.PI * 0.2 * record.timeUs / 1e6))}))]
  ];
  const mustAsk = new Set(['HOLD_EVIDENCE_PROVISIONAL', 'I_TOO_LOW', 'I_TOO_HIGH',
    'I_TERM_SIGNATURES_CONFLICT', 'I_TERM_NOT_LOGGED', 'I_TERM_NOT_JUDGED', 'I_TERM_HOLDS_MIXED',
    'I_TERM_VERDICT_UNSTABLE', 'NO_HOLD_EVIDENCE', 'HEADSPEED_TOO_FEW_SEGMENTS_TO_JUDGE']);
  const disagree = [];
  const asked = new Set();
  for (const [label, id, records] of flights) {
    const result = recommendFor(records, 'yaw');
    const ids = result.findings.map(entry => entry.id);
    assert.ok(ids.includes(id), `${label}: the flight must reach ${id}: ${ids.join(', ')}`);
    for (const finding of result.findings) {
      const counts = requestedHoldCounts(spokenText(finding));
      if (counts.length > 0) {
        asked.add(finding.id);
      }
      if (counts.some(count => count !== needed)) {
        disagree.push(`${label}, ${finding.id}: asks for [${counts}]: ${spokenText(finding)}`);
      }
    }
  }
  // The measurement panel's own brief and headline, which the cards above quote.
  for (const axis of AXES_IN_ORDER) {
    const brief = [...holdManoeuvre(axis).steps, holdManoeuvre(axis).note].join(' ');
    const partial = describeHoldCapture({status: 'inconclusive', holds: [{}], rejectedHoldCounts: {}},
      {axis});
    for (const [where, text] of [['holdManoeuvre', brief], ['describeHoldCapture', partial.headline]]) {
      const counts = requestedHoldCounts(text);
      assert.ok(counts.length > 0, `${where}(${axis}) must ask for a count: ${text}`);
      if (counts.some(count => count !== needed)) {
        disagree.push(`${where}(${axis}): asks for [${counts}]: ${text}`);
      }
    }
    assert.equal(partial.needed, needed);
  }
  assert.deepEqual(disagree, [], `${disagree.length} sentences ask for a count of holds other than `
    + `the ${needed} a full reading needs:\n${disagree.join('\n')}`);
  // Not vacuous: every card that sends a pilot to fly holds was reached and asked.
  assert.deepEqual([...mustAsk].filter(id => !asked.has(id)), [],
    `cards that never asked for a count: ${[...asked].join(', ')}`);
});

test('a fast shake over holds whose error changed side says to settle the shake first', () => {
  // Re-review of 3 October 2026. A healthy integrator under a slow wander, with a
  // 5-11 Hz torque over it, flown as five ordinary holds: the error changes side
  // from hold to hold, and the movement inside each is faster than the band. The
  // 3 October routing already sends that to I_TERM_NOT_JUDGED, which names the
  // shake — but the changed-side branch then replaced its confirm with a calm-air
  // hold, and "settle what is shaking first" was lost. The review's own flights,
  // all three on one layout, in the app's three-axis shape.
  const layout = holdLayout({holdsS: [6.582, 5.995, 6.327, 6.244, 6.389]});
  const cell = ({slowHz, slow, phase, fastHz, fast, seed}) => ({commands: layout.commands,
    gains: HOLD_NOMINAL, seed, externalTorqueHz: slowHz, externalTorqueDps2: slow,
    externalTorquePhase: phase, extraTorques: [{hz: fastHz, dps2: fast}]});
  const result = recommendEachAxis(threeAxisRecords({
    roll: cell({slowHz: 0.0694, slow: 5233, phase: 2.136, fastHz: 8.349, fast: 6608, seed: 521211}),
    pitch: cell({slowHz: 0.0767, slow: 3523, phase: 4.966, fastHz: 4.847, fast: 3737, seed: 273269}),
    yaw: cell({slowHz: 0.0775, slow: 5599, phase: 4.006, fastHz: 11.113, fast: 7051, seed: 29559})
  }, layout.durationS));
  for (const axis of AXES_IN_ORDER) {
    const hold = result.gates.holds[axis];
    const said = iTermFinding(result, axis);
    const line = `${axis}: ${said?.id} [${hold.codes}]`;
    // The fixture: both codes, or this tests nothing.
    assert.ok(hold.codes.includes('OSCILLATION_ABOVE_I_TERM_BAND')
      && hold.codes.includes('STANDING_ERROR_CHANGES_SIDE_BETWEEN_HOLDS'), line);
    assert.equal(said?.id, 'I_TERM_NOT_JUDGED', line);
    assert.equal(said.direction, null);
    assert.ok(!raisedIOn(result, axis), line);
    // The shake first, and then what the changed side asks for.
    assert.match(said.confirm, /^Settle what is shaking first/, `${line}: ${said.confirm}`);
    assert.match(said.confirm, /calm air/, `${line}: ${said.confirm}`);
    assert.match(said.reasoning, /faster than the [\d.]+-[\d.]+ Hz band/, said.reasoning);
    assert.match(said.reasoning, /one side in \d+ and on the other in \d+/, said.reasoning);
    assert.doesNotMatch(spokenText(said), /wandered slowly|slower than/i, spokenText(said));
  }
});
