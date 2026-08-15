#!/usr/bin/env node

/**
 * Deterministically generates RotorLens' own Blackbox test corpus.
 *
 * Every byte is produced here, so the corpus carries no third-party copyright
 * and needs no third-party notice. Regeneration must be byte-identical;
 * `test/provenance.test.mjs` enforces that, which makes provenance reproducible
 * rather than merely asserted.
 *
 * Unlike the first version of this file, the logs contain real encoded frames
 * written by `tools/blackbox-writer.mjs`. That is what lets the decoder be
 * round-trip tested against known sample values with no external log file.
 *
 * All arithmetic below is integer-only so output cannot drift between platforms
 * or JS engines.
 */

import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {sha256Hex} from '../src/integrity.mjs';
import {Encoding} from '../src/blackbox/encodings.mjs';
import {Predictor} from '../src/blackbox/predictors.mjs';
import {writeSession} from './blackbox-writer.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(projectRoot, 'fixtures', 'synthetic');

/**
 * Field table for the generated logs.
 *
 * Chosen to exercise every encoding and predictor the decoder implements, in the
 * grouped arrangements that are easiest to get wrong: a 3-field TAG2_3S32 run,
 * a 4-field TAG8_4S16 run, and an 8-field TAG8_8SVB run containing constant-zero
 * fields so the sparse-bitmap path is covered too.
 */
const FIELDS = [
  {name: 'loopIteration', signed: 0, i: [Predictor.NONE, Encoding.UNSIGNED_VB], p: [Predictor.INCREMENT, Encoding.NULL]},
  {name: 'time', signed: 0, i: [Predictor.NONE, Encoding.UNSIGNED_VB], p: [Predictor.STRAIGHT_LINE, Encoding.SIGNED_VB]},

  // Commanded rate per axis, then the pilot's raw stick input. Both are grouped
  // into nibble-packed runs of four, which is the encoding most likely to be
  // wrong against real firmware and therefore most worth exercising.
  ...['setpoint[0]', 'setpoint[1]', 'setpoint[2]', 'setpoint[3]'].map(name => ({
    name, signed: 1, i: [Predictor.NONE, Encoding.SIGNED_VB], p: [Predictor.PREVIOUS, Encoding.TAG8_4S16]
  })),
  ...['rcCommand[0]', 'rcCommand[1]', 'rcCommand[2]', 'rcCommand[3]'].map(name => ({
    name, signed: 1, i: [Predictor.NONE, Encoding.SIGNED_VB], p: [Predictor.PREVIOUS, Encoding.TAG8_4S16]
  })),

  // Controller contributions. The analysis reads these per axis to measure the
  // I term, so a corpus without them cannot exercise the tuning path at all.
  ...['axisP', 'axisI', 'axisD'].flatMap(term => [0, 1, 2].map(axis => ({
    name: `${term}[${axis}]`,
    signed: 1,
    i: [Predictor.NONE, Encoding.SIGNED_VB],
    p: [Predictor.PREVIOUS, Encoding.TAG2_3S32]
  }))),

  ...['gyroADC[0]', 'gyroADC[1]', 'gyroADC[2]'].map(name => ({
    name, signed: 1, i: [Predictor.NONE, Encoding.SIGNED_VB], p: [Predictor.PREVIOUS, Encoding.TAG2_3S32]
  })),

  // The UNFILTERED gyro, without which the corpus cannot exercise the tuning
  // path at all. Vibration is judged on the raw signal, because the filter chain
  // removes the evidence before it can be measured — so on a log carrying only
  // gyroADC the airframe gate refuses to clear, and every gain finding sits
  // behind that gate.
  //
  // The consequence was not theoretical. rf46-stop-manoeuvres.TXT was built to
  // reach a captured directional result, and on a real handset it produced no
  // gain card at all: "This log has no unfiltered gyro, so the airframe cannot
  // be ruled out from it at all." The browser test's change-box assertion
  // filters findings on `kind === 'adjustment'`, so it was comparing two empty
  // lists and could not fail. A gain card had never rendered anywhere.
  ...['gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]'].map(name => ({
    name, signed: 1, i: [Predictor.NONE, Encoding.SIGNED_VB], p: [Predictor.PREVIOUS, Encoding.TAG2_3S32]
  })),

  {name: 'Vbat', signed: 0, i: [Predictor.VBAT_REF, Encoding.SIGNED_VB], p: [Predictor.PREVIOUS, Encoding.SIGNED_VB]},
  {name: 'headspeed', signed: 0, i: [Predictor.NONE, Encoding.UNSIGNED_VB], p: [Predictor.AVERAGE_2, Encoding.SIGNED_VB]},
  {name: 'tailspeed', signed: 0, i: [Predictor.NONE, Encoding.UNSIGNED_VB], p: [Predictor.AVERAGE_2, Encoding.SIGNED_VB]},
  {name: 'motor[0]', signed: 0, i: [Predictor.NONE, Encoding.UNSIGNED_VB], p: [Predictor.PREVIOUS, Encoding.SIGNED_VB]},

  ...Array.from({length: 8}, (unused, index) => ({
    name: `debug[${index}]`,
    signed: 1,
    i: [Predictor.NONE, Encoding.SIGNED_VB],
    p: [Predictor.PREVIOUS, Encoding.TAG8_8SVB]
  }))
];

const VBAT_REF = 380;
const MIN_THROTTLE = 1070;

const intraFields = FIELDS.map(field => ({name: field.name, predictor: field.i[0], encoding: field.i[1]}));
const interFields = FIELDS.map(field => ({name: field.name, predictor: field.p[0], encoding: field.p[1]}));

function headerLines({revision, craftName, includeGps}) {
  const names = FIELDS.map(field => field.name).join(',');
  const lines = [
    'H Product:Blackbox flight data recorder by Nicholas Sherlock',
    'H Data version:2',
    `H Field I name:${names}`,
    `H Field I signed:${FIELDS.map(field => field.signed).join(',')}`,
    `H Field I predictor:${intraFields.map(field => field.predictor).join(',')}`,
    `H Field I encoding:${intraFields.map(field => field.encoding).join(',')}`,
    `H Field P predictor:${interFields.map(field => field.predictor).join(',')}`,
    `H Field P encoding:${interFields.map(field => field.encoding).join(',')}`,
    'H Field S name:flightModeFlags,stateFlags,failsafePhase',
    'H Field S signed:0,0,0',
    'H Field S predictor:0,0,0',
    'H Field S encoding:1,1,1'
  ];

  if (includeGps) {
    // Declared but never emitted: enough to exercise location-field detection
    // without putting a single coordinate in the repository.
    lines.push(
      'H Field G name:time,GPS_numSat,GPS_coord[0],GPS_coord[1],GPS_altitude',
      'H Field G signed:0,0,1,1,1',
      'H Field G predictor:0,0,0,0,0',
      'H Field G encoding:1,1,0,0,0'
    );
  }

  lines.push(
    'H Firmware type:Rotorflight',
    `H Firmware revision:${revision}`,
    'H Firmware date:Jan  1 2026 00:00:00',
    'H Board information:ROTORLENS SYNTHETIC',
    'H Log start datetime:0000-01-01T00:00:00.000+00:00',
    `H Craft name:${craftName}`,
    'H I interval:32',
    'H P interval:1',
    `H minthrottle:${MIN_THROTTLE}`,
    'H maxthrottle:2000',
    'H gyro_scale:0x3f800000',
    'H acc_1G:2048',
    `H vbatref:${VBAT_REF}`,
    'H vbatcellvoltage:330,350,430',
    'H looptime:125',
    'H pid_process_denom:4',
    'H rollPID:60,120,0',
    'H pitchPID:50,110,0',
    'H yawPID:40,50,50',
    'H debug_mode:31'
  );

  return lines;
}

/** Integer triangle wave; no floating point, so output cannot drift. */
function triangle(step, period, amplitude) {
  const phase = step % period;
  const half = period >> 1;
  const rising = phase < half ? phase : period - phase;
  return Math.trunc((rising * 2 * amplitude) / half) - amplitude;
}

/** Deterministic 32-bit LCG standing in for sensor noise. */
function createNoise(seed) {
  let state = seed >>> 0;
  return function next(range) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return ((state >>> 16) % (range * 2 + 1)) - range;
  };
}

/**
 * Builds a plausible flight: gyro traces on three axes, stick movement, a
 * sagging pack, governor-held headspeed, and debug channels of which several
 * stay at zero.
 */
function buildFrames({frameCount, seed, headspeedTarget}) {
  const noise = createNoise(seed);
  const frames = [];

  for (let step = 0; step < frameCount; step += 1) {
    // Commanded rate per axis, and the measured rate lagging it by a small
    // tracking error — a command and a gyro trace that ignore each other would
    // make the analysis path untestable.
    const command = [
      triangle(step, 120, 500),
      triangle(step, 160, 400),
      triangle(step, 200, 300)
    ];
    const trackingError = [
      triangle(step, 17, 35) + noise(6),
      triangle(step, 19, 30) + noise(6),
      triangle(step, 23, 25) + noise(5)
    ];
    const measured = command.map((value, axis) => value - trackingError[axis]);

    // Every Blackbox field is an integer, and `| 0` also folds -0 into 0.
    // Math.trunc can produce -0, which compares unequal to 0 under strict deep
    // equality and would fail round-trip for a value the decoder reads as 0.
    frames.push([
      step,                                            // loopIteration
      step * 500,                                      // time (µs)

      command[0], command[1], command[2],              // setpoint[0..2]
      triangle(step, 240, 180),                        // setpoint[3] (collective rate)

      command[0], command[1], command[2],              // rcCommand[0..2]
      1200 + triangle(step, 240, 180),                 // rcCommand[3] (collective)

      // P follows the error, I integrates slowly, D follows its rate of change.
      Math.trunc(trackingError[0] * 2),
      Math.trunc(trackingError[1] * 2),
      Math.trunc(trackingError[2] * 2),
      triangle(step, 300, 60),
      triangle(step, 320, 55),
      triangle(step, 340, 45),
      Math.trunc(trackingError[0] / 2),
      Math.trunc(trackingError[1] / 2),
      Math.trunc(trackingError[2] / 2),

      measured[0], measured[1], measured[2],           // gyroADC[0..2]

      // Unfiltered gyro: the filtered signal plus a small broadband dither, so
      // the airframe reads clear rather than shaking. Deliberately noise rather
      // than a repeating shape — a periodic offset here would appear as a
      // persistent narrowband tone and block the very findings this exists to
      // let through.
      measured[0] + noise(3), measured[1] + noise(3), measured[2] + noise(3),

      VBAT_REF - Math.trunc(step / 24),                // Vbat sags over the flight
      headspeedTarget + triangle(step, 64, 45),        // headspeed
      Math.trunc(headspeedTarget * 3) + triangle(step, 48, 90), // tailspeed
      MIN_THROTTLE + 300 + triangle(step, 96, 120),    // motor[0]

      triangle(step, 32, 250),                         // debug[0]
      triangle(step, 44, 180),                         // debug[1]
      0,                                               // debug[2] — sparse path
      0,                                               // debug[3] — sparse path
      noise(60),                                       // debug[4]
      0,                                               // debug[5] — sparse path
      triangle(step, 72, 90),                          // debug[6]
      0                                                // debug[7] — sparse path
    ].map(value => value | 0));
  }

  return frames;
}

// ---------------------------------------------------------------------------
// The stop-manoeuvre fixture
//
// Everything above produces a fifth of a second of flight. That is enough to
// round-trip every encoding and nowhere near enough to contain a STOP: the
// detector in src/analysis/records.mjs requires a command held past
// `minimumCommandHoldUs`, released faster than `minimumReleaseRateDpsPerSecond`
// without dwelling longer than `releasePlateauMaxUs`, and then a full
// `quietWindowUs` (1 s) of hands-off flight inside the log. So `describeStopCapture`
// returning 'captured', and the whole non-provisional directional table behind
// it, were reachable only from hand-fabricated evidence objects in unit tests.
// Nothing rendered them from bytes.
//
// This session is flown to those gates deliberately. Twelve stops — two per
// direction on each of roll, pitch and yaw — each one a ramp on, a hold, a clean
// release and 1.1 s of quiet, at 500 Hz over 18.4 s.
//
// It carries a DELIBERATE, KNOWN directional asymmetry so a test can assert the
// analysis recovers the thing that was injected rather than merely producing
// output. The two asymmetries point in OPPOSITE directions on the same axis:
//
//   axis   tracking error (deg/s)   ringing amplitude (deg/s)
//   roll   +4  vs  −12              +30 vs −10
//   pitch  +6  vs  −6  (symmetric)  +12 vs −36
//   yaw    +6  vs  −24              +15 vs −45
//
// so roll tracks worse to the left while ringing worse to the right, and pitch
// tracks identically both ways while ringing three times harder one way. A test
// that merely checked "some asymmetry came out" would pass on the transpose of
// any of these; one that checks which direction is worse, per metric, per axis,
// cannot.
//
// WHAT THIS FIXTURE IS NOT EVIDENCE FOR. The numbers below are chosen, not
// measured from an aircraft. Recovering them proves the analysis pipeline carries
// an injected asymmetry from bytes to conclusion without losing or inverting it.
// It says nothing about whether a real helicopter behaves this way, and no
// threshold in src/analysis/ may be calibrated against it.
// ---------------------------------------------------------------------------

/** 500 Hz. Real logs run 250 Hz to 1 kHz; the gates below are all in seconds. */
const MANOEUVRE_INTERVAL_US = 2000;

/**
 * One stop cycle, in samples. Every span is set by a detector gate, not by taste:
 *
 *   ramp     40 ms   sweeps up through the 80 deg/s command threshold
 *   hold    300 ms   twice `minimumCommandHoldUs`, and long enough to contain the
 *                    whole 150 ms `trackingWindowUs` that ends at plateau departure
 *   release  60 ms   strictly decreasing, so no dwell can approach the 117.9 ms
 *                    `releasePlateauMaxUs` and the transit rate is ~4000 deg/s/s
 *                    against a 38 deg/s/s floor
 *   quiet  1100 ms   longer than the 1000 ms `quietWindowUs` the response is
 *                    measured over, so the next input cannot contaminate it
 *
 * Cycle total 1500 ms, comfortably past the 1050 ms `minimumEventSpacingUs`.
 */
const CYCLE = Object.freeze({ramp: 20, hold: 150, release: 30, quiet: 550});
const CYCLE_SAMPLES = CYCLE.ramp + CYCLE.hold + CYCLE.release + CYCLE.quiet;

/** Lead-in before the first command, and tail after the last quiet period. */
const MANOEUVRE_LEAD = 100;
const MANOEUVRE_TAIL = 100;

/**
 * Per-axis command size and the injected asymmetries.
 *
 * `peakDps` is equal in both directions on purpose: `commandAmplitudeDps` then
 * comes out symmetric, so a test can require that the tracking and ringing
 * asymmetries are large WHILE the command asymmetry is not. An analysis that
 * simply passed the command through would fail that pair.
 */
const MANOEUVRE_AXES = Object.freeze([
  Object.freeze({
    axis: 'roll',
    peakDps: 180,
    trackingErrorDps: Object.freeze({positive: 4, negative: 12}),
    ringingDps: Object.freeze({positive: 30, negative: 10})
  }),
  Object.freeze({
    axis: 'pitch',
    peakDps: 140,
    // Symmetric tracking on purpose: this axis is the one that must come out
    // `directionsComparable`, because that flag reads trackingRmsDps alone. Its
    // ringing is still 3x apart, which the directional table must still show.
    trackingErrorDps: Object.freeze({positive: 6, negative: 6}),
    ringingDps: Object.freeze({positive: 12, negative: 36})
  }),
  Object.freeze({
    axis: 'yaw',
    peakDps: 260,
    trackingErrorDps: Object.freeze({positive: 6, negative: 24}),
    ringingDps: Object.freeze({positive: 15, negative: 45})
  })
]);

/** Two stops per direction per axis, one axis at a time. */
const MANOEUVRE_SCHEDULE = Object.freeze([
  ...[0, 1, 2].flatMap(axisIndex => [1, -1, 1, -1].map(sign => ({axisIndex, sign})))
]);

const MANOEUVRE_FRAME_COUNT =
  MANOEUVRE_LEAD + MANOEUVRE_SCHEDULE.length * CYCLE_SAMPLES + MANOEUVRE_TAIL;

/** Post-release ringing envelopes, in samples: 300 ms fast, 900 ms slow. */
const FAST_RING_DECAY = 150;
const SLOW_RING_DECAY = 450;
/**
 * Ring periods, in samples: 40 ms (25 Hz) and 240 ms (~4 Hz).
 *
 * Phase-shifted by a quarter period at k = 0 so the ring starts at zero rather
 * than at full deflection, which would put a step into the gyro exactly where the
 * aircraft was released.
 */
const FAST_RING_PERIOD = 20;
const SLOW_RING_PERIOD = 120;

/**
 * The knobs a second manoeuvre session needs, defaulted to the first one.
 *
 * Defaults reproduce `rf46-stop-manoeuvres.TXT` byte for byte — the corpus is
 * hash-checked, so a refactor that shifted an existing fixture by one sample
 * would look exactly like corruption.
 */
const MANOEUVRE_DEFAULTS = Object.freeze({
  axes: MANOEUVRE_AXES,
  fastRingDecay: FAST_RING_DECAY,
  slowRingDecay: SLOW_RING_DECAY,
  cycle: CYCLE,
  plateauJitterDps: 3,

  /**
   * Governor-held head speed, rpm. 2050 puts 1/rev at 34.2 Hz and 2/rev at
   * 68.3 Hz, both clear of the 25 Hz ring, which is why the gain fault earns a
   * verdict rather than being refused one by `coincidentTone`.
   *
   * This is a knob rather than a literal so a TWIN can be built: the same flight
   * with the head speed moved onto the ring's own frequency. Nothing else about
   * the aircraft changes, so a test that passes on both is not reading the tone.
   */
  headspeedRpm: 2050,

  /**
   * Head-speed sag, rpm, at full collective. Zero is a governor that holds.
   *
   * Applied against the collective demand rather than against time, so what it
   * models is droop under load, not drift: the head speed comes back when the
   * collective does. `assessHeadspeed` reads it through the holds it costs.
   */
  collectiveDroopRpm: 0,

  /** Collective cycle length, samples. */
  collectivePeriod: 431,

  /**
   * A CONTINUOUS 25 Hz tone in the UNFILTERED gyro only, deg/s amplitude.
   *
   * Zero is an airframe with nothing ringing in it, which is every fixture
   * committed before the fault library.
   *
   * It goes in `gyroRAW` and not in `gyroADC` deliberately, and that is the
   * physical story rather than a convenience: the filter chain is what removes
   * a structural tone from the signal the loop flies on, which is the entire
   * reason the airframe has to be judged on the unfiltered trace. Putting it in
   * the filtered signal too would land it inside the plateau ripple and turn
   * every one of these fixtures into a too-much-P case.
   *
   * A post-release ring is present for about a third of the analysis windows,
   * which is under `TONE_LIMITS.persistenceRatioFloor` — measured, not assumed:
   * the gain-fault fixture's 25.39 Hz peak reads persistenceRatio 0.27 to 0.33
   * on the three axes. So a ring alone is NOT a persistent airframe tone and
   * `coincidentTone` never sees it. A mode that is always there is.
   */
  airframeToneDps: 0
});

/** Samples per stop cycle, and total session length, for a given cycle shape. */
const cycleSamplesOf = cycle => cycle.ramp + cycle.hold + cycle.release + cycle.quiet;
const frameCountOf = cycle =>
  MANOEUVRE_LEAD + MANOEUVRE_SCHEDULE.length * cycleSamplesOf(cycle) + MANOEUVRE_TAIL;

/**
 * A symmetric, sustained oscillation on every axis: what too much D looks like.
 *
 * The corpus had no fixture carrying a genuine gain fault, so no
 * `kind: 'adjustment'` finding had ever been rendered by the viewer — the gain
 * cards were covered by unit tests over synthetic records and by nothing that
 * drew a screen. `rf46-stop-manoeuvres.TXT` cannot fill that gap: its
 * deliberate 2.8x directional asymmetry is larger than a gain explains, so the
 * engine correctly calls it mechanical and refuses a gain verdict.
 *
 * What `D_TOO_HIGH` requires, and this builds:
 *
 *   BOTH DIRECTIONS THE SAME. Equal tracking error and equal ringing, so the
 *   agreement gate permits instead of reporting an asymmetry.
 *   AN ENVELOPE THAT BARELY FALLS. A decay of 6000 samples against a ring
 *   period of 20 leaves the amplitude essentially flat across the measured
 *   window — a sustained oscillation rather than a transient dying away, which
 *   is the distinction the finding rests on.
 *   FAST. 25 Hz at this sample rate, far above the 0.3-3 Hz band an I term or a
 *   tail hunt lives in.
 *   QUIET WHILE HELD. The plateau carries only the shared 3 deg/s stick jitter,
 *   because a fault that also oscillates during the hold is too much P, not
 *   too much D — and that is exactly what separates the two findings.
 *
 * 25 Hz is chosen to sit off every rotor order. The head runs at 2050 rpm here,
 * so 1/rev is 34.2 Hz and 2/rev is 68.3 Hz; a ring landing on one of those is
 * refused a verdict by `coincidentTone`, which is correct behaviour and would
 * make this fixture prove nothing.
 */
const GAIN_FAULT_AXES = Object.freeze([
  Object.freeze({
    axis: 'roll',
    peakDps: 180,
    trackingErrorDps: Object.freeze({positive: 5, negative: 5}),
    ringingDps: Object.freeze({positive: 34, negative: 34})
  }),
  Object.freeze({
    axis: 'pitch',
    peakDps: 140,
    trackingErrorDps: Object.freeze({positive: 5, negative: 5}),
    ringingDps: Object.freeze({positive: 30, negative: 30})
  }),
  Object.freeze({
    axis: 'yaw',
    peakDps: 260,
    trackingErrorDps: Object.freeze({positive: 6, negative: 6}),
    ringingDps: Object.freeze({positive: 38, negative: 38})
  })
]);

const GAIN_FAULT_CONFIG = Object.freeze({
  axes: GAIN_FAULT_AXES,
  // Effectively flat over the response window; the finding tests the envelope's
  // fall across two cycles, and 40 of 6000 samples is not a fall.
  fastRingDecay: 6000,
  slowRingDecay: 6000,
  // A TWO-SECOND HOLD, against 300 ms in the first fixture, and the fixture is
  // useless without it. Too much P and too much D both ring after a release;
  // what separates them is whether the axis was ALSO oscillating while the
  // command was held steady. With a 150-sample plateau that could not be
  // measured, and the engine correctly returned RINGING_SOURCE_UNKNOWN with
  // "the command was never flat for long enough" — its own confirm text asks
  // for "a full two seconds before each release", which is what this is.
  cycle: Object.freeze({ramp: 20, hold: 1000, release: 30, quiet: 550}),
  // A PERFECTLY FLAT PLATEAU. With the shared 3 deg/s stick jitter only 37 of
  // 76 samples in the tracking window counted as flat, and across the
  // 270-combination stability sweep some settings then found no measurable
  // plateau at all: oscillationSourcesSeen came back [null, 'release-only'],
  // two members, so the sweep correctly refused to conclude anything and the
  // engine reported RINGING_SOURCE_UNKNOWN. A fixture whose job is to prove the
  // gain path must not also be testing the detector's tolerance for stick
  // wobble; the ringing after the release is the signal here.
  plateauJitterDps: 0
});

// ---------------------------------------------------------------------------
// THE FAULT LIBRARY
//
// Seven sessions built from the gain-fault flight, each one a NAMED FAULT WITH
// A NAMED CONTROL that differs from it in exactly ONE term. A control that
// differs in several proves only that the engine can tell two flights apart.
//
//   fault                          control                    the one term
//   ---------------------------------------------------------------------------
//   tone-on-rotor-order            tone-off-rotor-order       head speed column
//   p-too-high                     rf46-gain-fault            plateau amplitude
//   ringing-source-unknown         p-too-high                 plateau amplitude
//   governor-droop                 rf46-gain-fault            head speed column
//   travel-limit                   p-too-low                  the settled rate
//
// WHAT THESE ARE NOT EVIDENCE FOR, and it is the same warning
// `rf46-stop-manoeuvres.TXT` already carries. Every number below is CHOSEN, not
// measured from an aircraft. Recovering a verdict from one proves the pipeline
// carries an injected fault from bytes to conclusion without losing or
// inverting it, and proves the twin does NOT reach that verdict. It says
// nothing about whether a real helicopter behaves this way, and NO THRESHOLD IN
// src/analysis/ MAY BE CALIBRATED AGAINST ANY OF THEM.
// ---------------------------------------------------------------------------

/**
 * The airframe tone amplitude, deg/s, shared by the twin pair.
 *
 * Measured across 4, 6 and 9 deg/s: all three give the same verdict on both
 * halves of the pair, so the pair is not balanced on a cliff edge. 6 sits in
 * the middle. It stays well under the 8 deg/s attention threshold, so the
 * airframe rung reports the tone and does not block on it — which is the case
 * worth building, because a tone loud enough to block would never reach the
 * gain rungs at all and the coincidence test would go unexercised.
 */
const AIRFRAME_TONE_DPS = 6;

/**
 * TWIN PAIR. The same flight, the same gyro, one column apart.
 *
 * `rf46-tone-off-rotor-order.TXT` runs the head at 2050 rpm, putting 1/rev at
 * 34.2 Hz and 3/rev at 102.5 Hz, both clear of the 25 Hz ring. The 25 Hz tone
 * matches no rotor order, `coincidentTone` returns null, and the engine names
 * the gain: D_TOO_HIGH on all three axes.
 *
 * `rf46-tone-on-rotor-order.TXT` runs it at 1500 rpm, putting 1/rev at exactly
 * 25.0 Hz. Every gyro, setpoint and PID-term sample in the two files is
 * IDENTICAL — only `headspeed` and the tail speed derived from it differ — and
 * the engine must now refuse the gain and say OSCILLATION_MATCHES_AIRFRAME_TONE
 * instead. A test that passes on both is not reading the tone at all, and that
 * is the point of building the control this way rather than as another flight.
 *
 * WHY THE TONE HAD TO BE ADDED AT ALL, measured rather than assumed: the ring
 * after a release is present in only 27-33% of the analysis windows on the
 * gain-fault fixture, under the 50% `TONE_LIMITS.persistenceRatioFloor`, so it
 * is not a persistent tone and moving the head speed alone changes nothing. A
 * structural mode is always there. It goes in `gyroRAW` only, because the
 * filter chain is exactly what hides such a mode from the signal the loop flies
 * on — put it in `gyroADC` too and it lands in the plateau ripple and turns the
 * fixture into a too-much-P case.
 */
const TONE_OFF_ROTOR_CONFIG = Object.freeze({
  ...GAIN_FAULT_CONFIG,
  airframeToneDps: AIRFRAME_TONE_DPS,
  headspeedRpm: 2050
});
const TONE_ON_ROTOR_CONFIG = Object.freeze({
  ...GAIN_FAULT_CONFIG,
  airframeToneDps: AIRFRAME_TONE_DPS,
  headspeedRpm: 1500
});

/**
 * Too much P, and the refusal that sits between it and too much D.
 *
 * `plateauRingDps` is the ONLY term that differs from `rf46-gain-fault.TXT` —
 * same seed, same schedule, same ring, same tracking error, same everything
 * else — because `oscillationSource` divides the plateau ripple by the
 * post-release ringing and compares it to `SHAPE_DEFAULTS.plateauShareOfRinging`
 * (0.25). Nothing else in the engine separates the two findings.
 *
 * HALF the ringing amplitude, twice the gate: P_TOO_HIGH. Measured at half and
 * at three quarters, both give P_TOO_HIGH, so it is not balanced on the gate.
 *
 * A QUARTER of it: RINGING_SOURCE_UNKNOWN, and this one is the more interesting
 * fixture. A quarter lands INSIDE the swept range `[0.15, 0.2, 0.25, 0.3, 0.4]`,
 * so some points in the 270-combination stability sweep call the axis
 * hold-and-release and others call it release-only. The engine is required to
 * refuse a verdict that depends on which unconstrained constant it happened to
 * use, and this is what that refusal looks like from bytes. It is not a fixture
 * balanced on a threshold by accident — it is one built to sit inside the range
 * the sweep exists to explore.
 */
const withPlateauRing = divisor => Object.freeze(GAIN_FAULT_AXES.map(profile => Object.freeze({
  ...profile,
  plateauRingDps: Math.trunc(profile.ringingDps.positive / divisor)
})));

const P_TOO_HIGH_CONFIG = Object.freeze({
  ...GAIN_FAULT_CONFIG,
  axes: withPlateauRing(2)   // 17 / 15 / 19 deg/s
});
const RINGING_UNKNOWN_CONFIG = Object.freeze({
  ...GAIN_FAULT_CONFIG,
  axes: withPlateauRing(4)   // 8 / 7 / 9 deg/s
});

/**
 * A governor that does not hold, and nothing else changed.
 *
 * The head speed sags 200 rpm as the collective comes up and recovers as it
 * goes down — droop under load rather than drift, because it tracks the
 * collective column rather than time. Every other column, including the twelve
 * stops that earn three D_TOO_HIGH adjustments in `rf46-gain-fault.TXT`, is
 * byte-identical.
 *
 * WHAT IT MUST DO IS SUPPRESS. A tune taken on a drooping machine is wrong at
 * every other collective setting, which is why `RUNGS` puts head speed above
 * every gain rung. A blocker that does not actually suppress the rungs below it
 * is the whole reason that list is ordered, and this fixture is what would
 * notice if it stopped.
 *
 * 200 rpm on 2050 is a spread of about 9.5%, against a 12% limit on the range
 * the rotor-harmonic check needs — so the airframe rung still clears and the
 * suppression is unambiguously the head speed rather than a second fault
 * arriving with it.
 */
const GOVERNOR_DROOP_CONFIG = Object.freeze({
  ...GAIN_FAULT_CONFIG,
  collectiveDroopRpm: 200
});

/**
 * Too little P, and a control at its travel limit, separated by one number.
 *
 * Both are the same shape: a standing rate shortfall in the commanded direction
 * with `offsetShare` above `SHAPE_DEFAULTS.offsetDominantShare`, no ringing at
 * all, and a residual rate after the release above the detector's own stop
 * threshold. Neither is an oscillation, and reading either as one would lower
 * the very gain meant to stop the aircraft.
 *
 * What differs is HOW MUCH of the commanded rate is missing.
 * `AUTHORITY_LIMITS.standingOffsetShareOfCommand` is 0.35 — a shortfall of that
 * size is a loop gain of about 1.9, which one step can move. `rf46-p-too-low`
 * is short by 19% of the command and earns P_TOO_LOW. `rf46-travel-limit` is
 * short by 50% and must NOT: a loop that far from following is not one gain
 * step away from following, and the shape is what a servo horn on the wrong
 * hole or a swashplate on its stop produces. That constant exists because the
 * old engine grew MORE confident about "raise P" the harder the control was
 * jammed, and this pair is what would notice it coming back.
 *
 * Measured at 0.19 / 0.30 / 0.50 / 0.60: the first two give P_TOO_LOW and the
 * last two give AXIS_DOES_NOT_ARREST, so both fixtures sit a clear factor
 * either side of the limit rather than on it.
 *
 * WHAT THIS PAIR DOES NOT CONTAIN. `AXIS_DOES_NOT_ARREST` asks the pilot to fly
 * the same stop from half the command, because a travel limit leaves the same
 * ABSOLUTE shortfall at both sizes while a soft loop halves it. That confirming
 * flight is not in the fixture — both sessions carry one command size — so what
 * is pinned here is the engine's own rule, the shortfall as a share of the
 * command, and not the physics that motivates it.
 */
const authorityAxes = share => Object.freeze([
  {axis: 'roll', peakDps: 180, residualDps: 40},
  {axis: 'pitch', peakDps: 140, residualDps: 34},
  {axis: 'yaw', peakDps: 260, residualDps: 46}
].map(profile => {
  const shortfall = Math.round(profile.peakDps * share);
  return Object.freeze({
    ...profile,
    trackingErrorDps: Object.freeze({positive: shortfall, negative: shortfall}),
    ringingDps: Object.freeze({positive: 0, negative: 0})
  });
}));

const P_TOO_LOW_CONFIG = Object.freeze({
  ...GAIN_FAULT_CONFIG,
  axes: authorityAxes(0.19)   // 34 / 27 / 49 deg/s short
});
const TRAVEL_LIMIT_CONFIG = Object.freeze({
  ...GAIN_FAULT_CONFIG,
  axes: authorityAxes(0.5)    // 90 / 70 / 130 deg/s short
});

/**
 * Builds the setpoint and gyro series for one axis, over the whole session.
 *
 * Returns absolute deg/s per sample. Everything is integer: `triangle` truncates
 * and the envelopes divide with `Math.trunc`, so no float rounding can differ
 * between engines and change the committed bytes.
 */
function buildAxisManoeuvre(axisIndex, seed, config = MANOEUVRE_DEFAULTS) {
  const profile = config.axes[axisIndex];
  const CYCLE = config.cycle;
  const CYCLE_SAMPLES = cycleSamplesOf(CYCLE);
  const MANOEUVRE_FRAME_COUNT = frameCountOf(CYCLE);
  const setpoint = new Array(MANOEUVRE_FRAME_COUNT).fill(0);
  const gyro = new Array(MANOEUVRE_FRAME_COUNT).fill(0);
  // Sensor ripple on the tracking error, ±1 deg/s, zero-mean and its own stream
  // per axis. A triangle wave here instead biased the window mean by up to half a
  // count, which moved the recovered trackingRmsDps by 0.5 deg/s and left a test
  // no room to tell 6 from 7. Uniform noise leaves the recovered value within
  // 0.2 deg/s of the injected one.
  const ripple = createNoise(seed);

  // Which cycle, if any, owns each sample. Walking the whole session in one pass
  // keeps the ripple stream advancing once per sample regardless of where this
  // axis' cycles fall, so its values do not depend on the schedule order.
  const owner = new Array(MANOEUVRE_FRAME_COUNT).fill(null);
  MANOEUVRE_SCHEDULE.forEach((entry, cycle) => {
    if (entry.axisIndex !== axisIndex) {
      return;
    }
    const start = MANOEUVRE_LEAD + cycle * CYCLE_SAMPLES;
    for (let offset = 0; offset < CYCLE_SAMPLES; offset += 1) {
      owner[start + offset] = {entry, offset};
    }
  });

  const releaseFrom = CYCLE.ramp + CYCLE.hold;
  const settleFrom = releaseFrom + CYCLE.release;

  for (let step = 0; step < MANOEUVRE_FRAME_COUNT; step += 1) {
    const jitter = ripple(1);
    const active = owner[step];
    if (!active) {
      continue;
    }

    const {entry, offset} = active;
    const direction = entry.sign > 0 ? 'positive' : 'negative';
    const trackingError = profile.trackingErrorDps[direction];
    const fastAmplitude = profile.ringingDps[direction];
    const slowAmplitude = Math.trunc(fastAmplitude / 3);
    let magnitude;

    if (offset < CYCLE.ramp) {
      magnitude = Math.trunc((profile.peakDps * offset) / CYCLE.ramp);
    } else if (offset < releaseFrom) {
      // Stick jitter on the plateau. Bounded well inside the 10% band that
      // `plateauFraction` allows, so plateau departure stays at the hold's end.
      magnitude = config.plateauJitterDps === 0
        ? profile.peakDps
        : profile.peakDps + triangle(offset, 37, config.plateauJitterDps);
    } else if (offset < settleFrom) {
      const released = offset - releaseFrom;
      magnitude = Math.trunc(
        (profile.peakDps * (CYCLE.release - 1 - released)) / (CYCLE.release - 1)
      );
    } else {
      magnitude = 0;
    }

    setpoint[step] = magnitude * entry.sign;

    if (offset < settleFrom) {
      // The gyro lags the command by a fixed error — what a steady tracking
      // error looks like — plus a little sensor ripple.
      //
      // OSCILLATION DURING THE HOLD, when the profile asks for it, is the ONE
      // term that separates too much P from too much D. Both ring after a
      // release; only a proportional loop with no margin left also chatters
      // while the command is being held steady, because D acts on the change in
      // error and during a steady hold there is none. `oscillationSource`
      // divides the plateau ripple by the post-release ringing and compares it
      // to `SHAPE_DEFAULTS.plateauShareOfRinging`, so this amplitude is the
      // whole difference between the two fixtures.
      //
      // It rides on the plateau only. The ramp and the release must stay clean
      // or the release-rate and plateau-departure gates start seeing it instead.
      const plateauRing = (profile.plateauRingDps ?? 0) !== 0
        && offset >= CYCLE.ramp && offset < releaseFrom
        ? triangle(offset + FAST_RING_PERIOD / 4, FAST_RING_PERIOD, profile.plateauRingDps)
        : 0;
      gyro[step] = setpoint[step] - trackingError * entry.sign - jitter + plateauRing;
    } else if ((profile.residualDps ?? 0) !== 0) {
      // AN AXIS THAT DOES NOT ARREST. The stick is at centre and the aircraft is
      // still turning the way it was pushed, above `SHAPE_DEFAULTS
      // .residualStoppedDps` — which is the detector's own stop threshold, so
      // this is the level at which the command has stopped and the machine has
      // not. No ringing at all: a failure to arrest is not an oscillation, and
      // reading it as one would lower the very gain meant to stop the aircraft.
      gyro[step] = profile.residualDps * entry.sign - jitter;
    } else {
      const since = offset - settleFrom;
      const fastEnvelope = Math.max(
        0, Math.trunc((fastAmplitude * (config.fastRingDecay - since)) / config.fastRingDecay)
      );
      const slowEnvelope = Math.max(
        0, Math.trunc((slowAmplitude * (config.slowRingDecay - since)) / config.slowRingDecay)
      );
      gyro[step] =
        triangle(since + FAST_RING_PERIOD / 4, FAST_RING_PERIOD, fastEnvelope)
        + triangle(since + SLOW_RING_PERIOD / 4, SLOW_RING_PERIOD, slowEnvelope);
    }
  }

  return {setpoint, gyro};
}

/**
 * Deliberate one-sample offsets on `axisI[0..2]`, to force TAG2_3S32 selector 3
 * with UNEQUAL per-field widths.
 *
 * Measured 2026-08-12: across all six committed fixtures and the reference 4.6
 * log, every TAG2_3S32 selector-3 group our own corpus produces has three EQUAL
 * widths — 87 of 87 in `rf43-single-session`, and the same everywhere else. A
 * corpus like that cannot tell any of the six width-slot permutations apart,
 * which means nothing in this repository would notice a decoder that read
 * selector 3's widths in a different order.
 *
 * These offsets fix that for our own pair. Each entry puts one field's residual
 * above 127 while the other two stay under it, so the group encodes widths of
 * (1,2,1), (2,1,1) and (1,1,2) — three patterns that between them give a
 * different byte layout under every one of the six permutations, INCLUDING the
 * field-0/field-1 transposition that no real log we hold can separate.
 *
 * WHAT THIS IS AND IS NOT. It pins our decoder against our writer, so the two
 * cannot drift apart unnoticed. It is NOT evidence about the layout itself:
 * both halves are ours and both would move together if the assumption is wrong.
 * Only firmware output can settle that — see docs/BLACKBOX_FORMAT_NOTES.md.
 *
 * Steps are chosen inside the lead-in, before the first command, and none is a
 * multiple of the 32-frame I interval, so every one of these residuals lands on
 * a P frame and outside every measurement window.
 */
const ENCODING_PROBE = new Map([
  [12, [40, 200, 40]],
  [20, [200, 40, 40]],
  [28, [40, 40, 200]]
]);

/** The full frame table for the stop-manoeuvre session. */
function buildManoeuvreFrames(seed, config = MANOEUVRE_DEFAULTS) {
  const MANOEUVRE_FRAME_COUNT = frameCountOf(config.cycle);
  const noise = createNoise(seed);
  const axes = [0, 1, 2].map(
    axisIndex => buildAxisManoeuvre(axisIndex, seed + axisIndex * 0x9e37, config)
  );
  const frames = [];

  for (let step = 0; step < MANOEUVRE_FRAME_COUNT; step += 1) {
    const setpoint = axes.map(series => series.setpoint[step]);
    const gyro = axes.map(series => series.gyro[step]);
    // Tracking error per axis, and its one-sample change: what P and D act on.
    const error = [0, 1, 2].map(axis => setpoint[axis] - gyro[axis]);
    const previousError = [0, 1, 2].map(axis => (
      step === 0 ? 0 : axes[axis].setpoint[step - 1] - axes[axis].gyro[step - 1]
    ));
    const collective = triangle(step, config.collectivePeriod ?? 431, 60);
    const probe = ENCODING_PROBE.get(step) ?? [0, 0, 0];

    // Head speed, governor-held, minus whatever the collective pulls out of it.
    // `collective` runs -60..+60, so `(collective + 60) / 120` is the share of
    // full pitch being demanded and the sag tracks it exactly. Integer division
    // throughout, so the committed bytes cannot drift between engines.
    const headspeedRpm = config.headspeedRpm ?? 2050;
    const droopRpm = config.collectiveDroopRpm ?? 0;
    const droop = droopRpm === 0
      ? 0
      : Math.trunc((droopRpm * (collective + 60)) / 120);

    // The airframe's own tone, at the ring's frequency, running the whole flight.
    const airframeToneDps = config.airframeToneDps ?? 0;
    const airframeTone = airframeToneDps === 0
      ? 0
      : triangle(step, FAST_RING_PERIOD, airframeToneDps);

    frames.push([
      step,                                            // loopIteration
      step * MANOEUVRE_INTERVAL_US,                    // time (µs)

      setpoint[0], setpoint[1], setpoint[2],           // setpoint[0..2]
      collective,                                      // setpoint[3]

      setpoint[0], setpoint[1], setpoint[2],           // rcCommand[0..2]
      1200 + collective,                               // rcCommand[3]

      // P on the present error, I wandering slowly on its own timescale, D on the
      // rate of change of the error.
      error[0] * 2, error[1] * 2, error[2] * 2,
      triangle(step, 811, 30) + probe[0],
      triangle(step, 858, 38) + probe[1],
      triangle(step, 905, 46) + probe[2],
      (error[0] - previousError[0]) * 2,
      (error[1] - previousError[1]) * 2,
      (error[2] - previousError[2]) * 2,

      gyro[0], gyro[1], gyro[2],                       // gyroADC[0..2]

      // Unfiltered gyro — see the field table. Small broadband dither only, so
      // the airframe gate clears and the gain findings this fixture exists to
      // produce can actually be reached. Plus, when the config asks for one, a
      // continuous narrowband tone: an airframe mode the filter chain hides.
      gyro[0] + noise(3) + airframeTone,
      gyro[1] + noise(3) + airframeTone,
      gyro[2] + noise(3) + airframeTone,

      VBAT_REF - Math.trunc(step / 920),               // Vbat sags 38.0 V to 37.0 V
      headspeedRpm - droop + triangle(step, 641, 20),  // headspeed, governor-held
      headspeedRpm * 3 + triangle(step, 457, 60),      // tailspeed
      MIN_THROTTLE + 300 + triangle(step, 683, 90),    // motor[0]

      triangle(step, 113, 250),                        // debug[0]
      triangle(step, 151, 180),                        // debug[1]
      0,                                               // debug[2] — sparse path
      0,                                               // debug[3] — sparse path
      noise(60),                                       // debug[4]
      0,                                               // debug[5] — sparse path
      triangle(step, 199, 90),                         // debug[6]
      0                                                // debug[7] — sparse path
    ].map(value => value | 0));
  }

  return frames;
}

/**
 * Event records matching what a real Rotorflight 4.6 log carries.
 *
 * Values are passed to the typed writer rather than pre-encoded as bytes. That
 * keeps the fixture generator from sharing the decoder's old mistake of treating
 * variable-byte values as fixed one-byte payloads.
 */
function eventRecords(frameCount) {
  return [
    {afterFrame: Math.trunc(frameCount * 0.20), type: 13,
      function: 0x01, value: 2, valueType: 'integer'},
    {afterFrame: Math.trunc(frameCount * 0.21), type: 13,
      function: 0x02, value: 2, valueType: 'integer'},
    {afterFrame: Math.trunc(frameCount * 0.45), type: 50, state: 1},
    {afterFrame: Math.trunc(frameCount * 0.60), type: 52, state: 1},
    {afterFrame: Math.trunc(frameCount * 0.80), type: 52, state: 0}
  ];
}

function session({revision, craftName, includeGps = false, frameCount, seed, headspeedTarget, frames: prebuilt}) {
  // `prebuilt` lets a caller supply its own flight; everything else keeps the
  // original generator untouched, so the committed fixtures stay byte-identical.
  const frames = prebuilt ?? buildFrames({frameCount, seed, headspeedTarget});

  return {
    frames,
    bytes: writeSession({
      headerLines: headerLines({revision, craftName, includeGps}),
      intraFields,
      interFields,
      frames,
      intraInterval: 32,
      events: eventRecords(frameCount),
      constants: {minthrottle: MIN_THROTTLE, vbatref: VBAT_REF, minmotor: MIN_THROTTLE}
    })
  };
}

/**
 * One manoeuvre session, from a config, as bytes. Exported so a fault-library
 * variant can be built and measured without being committed first.
 */
export function manoeuvreSession(config, {seed, craftName}) {
  return session({
    revision: 'Rotorflight 4.6.0 (synthetic) STM32H743',
    craftName,
    frameCount: frameCountOf(config.cycle),
    frames: buildManoeuvreFrames(seed, config)
  });
}

/**
 * Builds every fixture in memory, returning the expected sample values alongside
 * the bytes so round-trip tests can assert exact equality without a side file.
 */
export function buildFixtures() {
  const single = session({
    revision: 'Rotorflight 4.3.0 (synthetic) STM32F411',
    craftName: 'RL-SYNTH-1',
    frameCount: 320,
    seed: 0x52_4c_01_01,
    headspeedTarget: 2100
  });

  const first = session({
    revision: 'Rotorflight 4.6.0 (synthetic) STM32H743',
    craftName: 'RL-SYNTH-2',
    frameCount: 160,
    seed: 0x52_4c_02_01,
    headspeedTarget: 1800
  });
  const second = session({
    revision: 'Rotorflight 4.6.0 (synthetic) STM32H743',
    craftName: 'RL-SYNTH-2',
    frameCount: 192,
    seed: 0x52_4c_02_02,
    headspeedTarget: 2400
  });

  const gps = session({
    revision: 'Rotorflight 4.6.0 (synthetic) STM32H743',
    craftName: 'RL-SYNTH-4',
    includeGps: true,
    frameCount: 96,
    seed: 0x52_4c_04_01,
    headspeedTarget: 2000
  });

  // A log whose free-text headers are hostile. `H Craft name:` is everything
  // after the first colon to end of line, so a craft name can contain markup —
  // and the viewer puts it in the DOM. This fixture is what stops the escaping
  // from silently regressing.
  const hostile = session({
    revision: 'Rotorflight 4.6.0 <script>window.__rotorlensPwned = 1;</script>',
    craftName: 'R&D <img src=x onerror="window.__rotorlensPwned=1">',
    frameCount: 64,
    seed: 0x52_4c_05_01,
    headspeedTarget: 2000
  });

  const manoeuvre = session({
    revision: 'Rotorflight 4.6.0 (synthetic) STM32H743',
    craftName: 'RL-SYNTH-STOPS',
    frameCount: MANOEUVRE_FRAME_COUNT,
    frames: buildManoeuvreFrames(0x52_4c_06_01)
  });

  const gainFault = session({
    revision: 'Rotorflight 4.6.0 (synthetic) STM32H743',
    craftName: 'RL-SYNTH-GAIN',
    frameCount: frameCountOf(GAIN_FAULT_CONFIG.cycle),
    frames: buildManoeuvreFrames(0x52_4c_06_02, GAIN_FAULT_CONFIG)
  });

  // The fault library. The three that vary the gain-fault flight share its seed
  // on purpose: with the same seed the ONLY difference between the bytes is the
  // one term the fixture is named for.
  const pTooHigh = manoeuvreSession(P_TOO_HIGH_CONFIG,
    {seed: 0x52_4c_06_02, craftName: 'RL-SYNTH-P-HIGH'});
  const ringingUnknown = manoeuvreSession(RINGING_UNKNOWN_CONFIG,
    {seed: 0x52_4c_06_02, craftName: 'RL-SYNTH-P-EDGE'});
  const governorDroop = manoeuvreSession(GOVERNOR_DROOP_CONFIG,
    {seed: 0x52_4c_06_02, craftName: 'RL-SYNTH-DROOP'});

  // The twin pair. Same seed as each other, and nothing but the head speed
  // column between them.
  const toneOffOrder = manoeuvreSession(TONE_OFF_ROTOR_CONFIG,
    {seed: 0x52_4c_06_05, craftName: 'RL-SYNTH-TONE-OFF'});
  const toneOnOrder = manoeuvreSession(TONE_ON_ROTOR_CONFIG,
    {seed: 0x52_4c_06_05, craftName: 'RL-SYNTH-TONE-ON'});

  // The authority pair. Same seed as each other, and nothing but the rate the
  // aircraft settles at.
  const pTooLow = manoeuvreSession(P_TOO_LOW_CONFIG,
    {seed: 0x52_4c_06_06, craftName: 'RL-SYNTH-P-LOW'});
  const travelLimit = manoeuvreSession(TRAVEL_LIMIT_CONFIG,
    {seed: 0x52_4c_06_06, craftName: 'RL-SYNTH-TRAVEL'});

  const truncatedSource = single.bytes;
  const corruptSource = Buffer.from(single.bytes);
  // Overwrite a run of frame bytes well past the header: the decoder must lose
  // the damaged span, resync on a later frame marker, and keep the rest.
  const damageStart = Math.trunc(corruptSource.length * 2 / 3);
  for (let index = 0; index < 64; index += 1) {
    corruptSource[damageStart + index] = (index * 37) & 0xff;
  }

  return [
    {
      file: 'rf43-single-session.TXT',
      description: 'One Rotorflight 4.3 session, 320 frames, all encodings exercised.',
      bytes: single.bytes,
      expected: [single.frames]
    },
    {
      file: 'rf46-two-sessions.TXT',
      description: 'Two concatenated Rotorflight 4.6 sessions with different field data.',
      bytes: Buffer.concat([first.bytes, second.bytes]),
      expected: [first.frames, second.frames]
    },
    {
      file: 'rf46-gps-declared.TXT',
      description: 'Declares a GPS frame group but emits no coordinates.',
      bytes: gps.bytes,
      expected: [gps.frames]
    },
    {
      file: 'rf46-stop-manoeuvres.TXT',
      description:
        'Twelve deliberate stops — two per direction on roll, pitch and yaw — flown to ' +
        'the gates in STOP_DETECTION_DEFAULTS, at 500 Hz over 18.4 s, carrying a known ' +
        'directional asymmetry in tracking error and post-release ringing.',
      bytes: manoeuvre.bytes,
      expected: [manoeuvre.frames]
    },
    {
      file: 'rf46-gain-fault.TXT',
      description:
        'The same twelve stops, but symmetric and ringing on: equal tracking error and ' +
        'equal post-release oscillation both ways, an envelope that barely falls across ' +
        'the response window, and a quiet plateau. What too much D looks like, and the ' +
        'only fixture that can put a gain recommendation on a screen.',
      bytes: gainFault.bytes,
      expected: [gainFault.frames]
    },
    {
      file: 'rf46-p-too-high.TXT',
      description:
        'The gain-fault flight with ONE term changed: the axis also oscillates while the ' +
        'command is held, at half the post-release amplitude. That is what separates too ' +
        'much P from too much D, and it is the only difference between this file and ' +
        'rf46-gain-fault.TXT.',
      bytes: pTooHigh.bytes,
      expected: [pTooHigh.frames]
    },
    {
      file: 'rf46-ringing-source-unknown.TXT',
      description:
        'The same flight with the plateau oscillation at a QUARTER of the ringing — inside ' +
        'the range the stability sweep explores, so the sweep disagrees with itself about ' +
        'whether the axis was already oscillating. The engine must decline rather than pick ' +
        'a side.',
      bytes: ringingUnknown.bytes,
      expected: [ringingUnknown.frames]
    },
    {
      file: 'rf46-governor-droop.TXT',
      description:
        'The gain-fault flight with the head speed sagging 200 rpm under collective and ' +
        'recovering as it comes off. Every other column is identical, so the three gain ' +
        'adjustments it would otherwise earn must be suppressed by the head-speed rung ' +
        'above them and by nothing else.',
      bytes: governorDroop.bytes,
      expected: [governorDroop.frames]
    },
    {
      file: 'rf46-tone-off-rotor-order.TXT',
      description:
        'A too-much-D ring at 25 Hz with a persistent 6 deg/s airframe tone at the same ' +
        'frequency, at 2050 rpm — where 25 Hz is on no rotor order. The gain is named.',
      bytes: toneOffOrder.bytes,
      expected: [toneOffOrder.frames]
    },
    {
      file: 'rf46-tone-on-rotor-order.TXT',
      description:
        'Its twin at 1500 rpm, where 25 Hz is exactly 1/rev. Every gyro, setpoint and PID ' +
        'sample is identical to rf46-tone-off-rotor-order.TXT; only the head speed differs. ' +
        'The gain must be refused and the coincidence named instead.',
      bytes: toneOnOrder.bytes,
      expected: [toneOnOrder.frames]
    },
    {
      file: 'rf46-p-too-low.TXT',
      description:
        'A standing rate shortfall of 19% of the commanded rate, no ringing, and a residual ' +
        'in the commanded direction after the release. Too little P, and one gain step from ' +
        'following.',
      bytes: pTooLow.bytes,
      expected: [pTooLow.frames]
    },
    {
      file: 'rf46-travel-limit.TXT',
      description:
        'The same shape short by 50% instead of 19% — past what a gain step can close. What ' +
        'a control at its travel limit looks like from inside a log, and the fixture that ' +
        'stops "raise P" being aimed at a mechanical stop.',
      bytes: travelLimit.bytes,
      expected: [travelLimit.frames]
    },
    {
      file: 'rf46-hostile-strings.TXT',
      description:
        'Craft name and firmware revision contain HTML and script; the viewer must render them as text.',
      bytes: hostile.bytes,
      expected: [hostile.frames]
    },
    {
      file: 'rf46-truncated-header.TXT',
      description: 'Header block cut mid-line; exercises fail-closed header handling.',
      bytes: Buffer.from(
        truncatedSource.subarray(0, truncatedSource.indexOf('H Craft name:') + 11)
      ),
      expected: null
    },
    {
      file: 'rf46-corrupt-frames.TXT',
      description: 'Valid log with a damaged 64-byte span; exercises resync and error reporting.',
      bytes: corruptSource,
      expected: null
    }
  ];
}

export async function generateFixtures() {
  await mkdir(outputDir, {recursive: true});

  const built = buildFixtures();
  const entries = [];

  for (const fixture of built) {
    await writeFile(path.join(outputDir, fixture.file), fixture.bytes);
    entries.push({
      file: fixture.file,
      description: fixture.description,
      byteLength: fixture.bytes.length,
      sha256: sha256Hex(fixture.bytes)
    });
  }

  const manifest = {
    origin: 'generated',
    generator: 'tools/generate-fixtures.mjs',
    reproducible: true,
    copyright: 'Copyright (c) 2026 Michael Wallace',
    license: 'MPL-2.0',
    thirdPartyMaterial: 'none',
    containsRealFlightData: false,
    payloadNote:
      'Frames are real encoded Blackbox frames written by tools/blackbox-writer.mjs. ' +
      'They validate the decoder against our own encoder, which proves internal ' +
      'consistency but not conformance with flight-controller output. Use ' +
      '`npm run verify:log` against a real log for that.',
    fixtures: entries
  };

  await writeFile(
    path.join(outputDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  return manifest;
}

// process.argv[1] is a Windows path (C:...) while import.meta.url is a file:// URL,
// so comparing them as strings made every one of these CLIs a silent no-op on
// Windows: `npm run fixtures:generate` printed nothing and wrote nothing.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await generateFixtures();
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
