import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

/**
 * The direction words on the axis panels name the side of the aircraft a
 * measurement belongs to. A wrong one is worse than no word: it hands a pilot a
 * real, correctly measured number attached to the wrong half of his machine, and
 * nothing on screen looks off.
 *
 * `DIRECTION_WORDS.yaw` was `{positive: 'nose right', negative: 'nose left'}`
 * with no citation and no coverage, and swapping it passed the whole suite. On
 * the reference log a positive `setpoint[2]` rotates the heading NEGATIVE, so the
 * D panel put the 34.82°/s of ringing measured after a nose-LEFT stop under the
 * "nose right" label. This test exists so that swap can never pass again.
 *
 * ## Why this reads the source instead of importing it
 *
 * `ui/app.mjs` wires DOM listeners at module scope, so importing it in bare Node
 * throws before any export is reachable, and the browser test that can import it
 * skips on a machine with no Chromium — which is exactly the machine where a
 * regression would slip through. So the mapping is lifted out of the source text
 * structurally: every axis must be present in the expected shape or the
 * extraction fails loudly rather than vacuously passing.
 *
 * ## Why the expected words are derived rather than restated
 *
 * Restating the constant would only assert that the file says what the file
 * says. Instead the measured firmware relationships are written down as numbers,
 * a yaw manoeuvre is simulated through them into a wrapped heading field, and
 * the word is read off the *compass* rule — a heading that increases is a nose
 * going right, which is the definition of a compass heading rather than anyone's
 * firmware choice. Thousands of randomized manoeuvres are swept, including ones
 * that cross the 0/3599 decidegree seam in both directions.
 */

const APP_PATH = fileURLToPath(new URL('../ui/app.mjs', import.meta.url));

/**
 * The relationships measured on the reference log, `sample-bell-222ut.bbl`
 * (Rotorflight 4.6.0, 134429 samples). Recorded here as numbers so the
 * derivation below runs on measurements rather than on prose.
 *
 * That `attitude[2]` is a true compass heading — increasing as the nose swings
 * right — is anchored on GPS, which carries no firmware convention: with
 * `H = attitude[2] + 8°`, the earth-frame acceleration differenced from
 * `GPS_speed`/`GPS_ground_course` and rotated into the body frame regresses onto
 * the tilt attitudes as a diagonal, +0.157 (pitch→forward) and +0.169
 * (roll→right) m/s² per degree against g·tan(1°) = 0.171, cross terms at
 * corr ≤ 0.07. The mirrored heading fits 8.9× worse in residual sum of squares.
 * A reflection is not a rotation, so no free sign on those slopes can absorb it.
 */
const MEASURED = Object.freeze({
  // slope of d(attitude[2])/dt against gyroADC[2]; corr -0.9997, n=2685
  yawHeadingRatePerGyroDps: -1.0023,
  // slope of gyroADC[2] against setpoint[2]; corr +0.9930
  yawGyroPerSetpoint: 1.010,
  // slope of d(attitude[0])/dt against gyroADC[0]; corr +0.8926
  rollAttitudeRatePerGyroDps: 0.921,
  // positive attitude[0] accelerates the aircraft to its right, m/s² per degree
  rollRightAccelPerDegree: 0.169,

  // --- pitch, re-derived 12 August 2026; see PITCH_ANCHOR below -------------
  // slope of d(attitude[1])/dt against gyroADC[1]; corr +0.842, 1330 blocks
  pitchAttitudeRatePerGyroDps: 0.8526,
  // slope of gyroADC[1] against setpoint[1]; corr +0.630
  pitchGyroPerSetpoint: 0.6658,
  // positive attitude[1] accelerates the aircraft along its own nose,
  // m/s² per degree — the pitch counterpart of rollRightAccelPerDegree
  pitchForwardAccelPerDegree: 0.1567
});

/** g·tan(1°): the acceleration one degree of rotor-disc tilt produces. */
const ACCEL_PER_DEGREE_OF_TILT = 9.80665 * Math.tan(Math.PI / 180);

/**
 * The pitch anchor, measured from the reference log's 675 GPS frames.
 *
 * The shipped mapping said a positive pitch command was "back". It was
 * backwards, and settling it needed one more step than yaw did.
 *
 * **Why a rotation fit alone cannot do it.** Rotating the earth-frame
 * acceleration into the body frame and regressing it on the tilt attitudes has a
 * degeneracy: with free slopes, the residual sum of squares of the diagonal
 * model is IDENTICAL at a heading offset `o` and at `o + 180°`, because both
 * slopes simply negate. Worse, the residual of the FULL 2×2 model (both
 * attitudes predicting both body axes) is invariant under every offset, since
 * rotating the outputs only rotates the fitted matrix. A sweep on that statistic
 * looks flat and settles nothing — which is how "the fit prefers +8°" can be
 * true and still leave the sign open.
 *
 * **What resolves it.** The GPS TRACK frame, which contains no attitude
 * convention whatsoever:
 *
 *     a_along = d(speed)/dt              along the direction of travel
 *     a_cross = speed × d(course)/dt     to the RIGHT of the direction of travel
 *
 * `a_cross` is signed by the definition of a compass course — it increases
 * clockwise — and by nothing else. Against it `attitude[0]` regresses at
 * +0.11…+0.13 m/s² per degree with corr 0.93, so positive `attitude[0]` is
 * rolled right, and the `roll → right > 0` branch of the offset sweep is the
 * physical one. Inside that branch the diagonal model minimises at a heading
 * offset of +4° (range −2…+9 across 30 independent choices of speed gate,
 * differencing lag and heading-steadiness gate) and measures the slopes below.
 */
const PITCH_ANCHOR = Object.freeze({
  // Median across 30 parameter variants; both slopes positive in 30 of 30.
  medianRollRightAccelPerDegree: 0.171,
  medianPitchForwardAccelPerDegree: 0.138,
  // Best-conditioned variant: speed > 2 m/s, lag 1, heading steadiness ≥ 0.995,
  // n = 51 observations, chosen offset +7°.
  bestVariant: Object.freeze({
    n: 51,
    offsetDeg: 7,
    pitchForwardAccelPerDegree: 0.1567,
    pitchCorrelation: 0.86,
    rollRightAccelPerDegree: 0.1706,
    rollCorrelation: 0.97
  }),
  // 20 000 bootstrap resamples of that variant's 51 observations. Zero sign
  // flips on either slope.
  bootstrap: Object.freeze({
    trials: 20_000,
    pitchLow: 0.1268, pitchHigh: 0.1822, pitchSignFlips: 0,
    rollLow: 0.1569, rollHigh: 0.1835, rollSignFlips: 0
  }),
  // Every kP the 30 variants produced, min to max. The word must not depend on
  // which variant anyone happened to run.
  pitchSlopeEnvelope: Object.freeze({low: 0.107, high: 0.182}),
  // MIRRORING the logged heading — a reflection, which no free scale sign can
  // absorb — costs this much in residual sum of squares. Worst case of the 30.
  mirrorResidualPenalty: 3.5,
  // The offset would have to be wrong by this much before kP changes sign.
  offsetMarginBeforeSignFlipsDeg: 85
});

/** The two whole-turn excursions the reference log actually contains. */
const REFERENCE_EXCURSIONS = Object.freeze([
  Object.freeze({setpointSign: 1, gyroIntegralDeg: 345.7, headingChangeDeg: -346.6}),
  Object.freeze({setpointSign: -1, gyroIntegralDeg: -344.1, headingChangeDeg: 343.9})
]);

/**
 * The two largest sustained pitch excursions in the reference log, both signs.
 *
 * A command excursion is a run of same-signed `setpoint[1]` lasting over 0.3 s
 * with a peak of at least 5°/s. The log holds 47; the integrated `gyroADC[1]`
 * agrees with the command sign in 47 of them and the `attitude[1]` change agrees
 * in 45. These two are the largest of each sign.
 */
const REFERENCE_PITCH_EXCURSIONS = Object.freeze([
  Object.freeze({setpointSign: 1, peakSetpointDps: 25, seconds: 0.80,
    gyroIntegralDeg: 12.05, attitudeChangeDeg: 12.80}),
  Object.freeze({setpointSign: -1, peakSetpointDps: -32, seconds: 1.07,
    gyroIntegralDeg: -19.67, attitudeChangeDeg: -22.50})
]);
const REFERENCE_PITCH_EXCURSION_AGREEMENT = Object.freeze({
  total: 47, gyroAgrees: 47, attitudeAgrees: 45
});

// ---------------------------------------------------------------------------
// Lifting the mapping out of the shipped source
// ---------------------------------------------------------------------------

const AXES = ['roll', 'pitch', 'yaw'];

/**
 * Reads `DIRECTION_WORDS` out of `ui/app.mjs`.
 *
 * Deliberately strict: the declaration must be there, and every axis must carry
 * both a positive and a negative word. A rename or a restructure fails here
 * rather than quietly leaving the assertions below with nothing to check.
 */
async function readDirectionWords() {
  const source = await readFile(APP_PATH, 'utf8');
  const block = /const DIRECTION_WORDS = \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(block, 'ui/app.mjs no longer declares a DIRECTION_WORDS object literal');

  const words = {};
  for (const axis of AXES) {
    const entry = new RegExp(
      `\\b${axis}:\\s*\\{\\s*positive:\\s*'([^']+)',\\s*negative:\\s*'([^']+)'\\s*\\}`
    ).exec(block[1]);
    assert.ok(entry, `DIRECTION_WORDS.${axis} is missing or no longer {positive, negative}`);
    words[axis] = {positive: entry[1], negative: entry[2]};
  }
  return words;
}

// ---------------------------------------------------------------------------
// Deriving what the words have to be
// ---------------------------------------------------------------------------

/** Mulberry32: a seeded generator, so a failing sweep is reproducible. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Flies one yaw manoeuvre through the measured relationships and returns the
 * heading field the firmware would log, in wrapped decidegrees.
 *
 * The wrap is the point: `attitude[2]` spans 0..3599, so any real reading of it
 * has to cross the seam, and a derivation that skipped the wrap would agree with
 * a sign bug that only shows up across it.
 */
function flyYaw({commandSign, rateDps, seconds, startDecidegrees, steps}) {
  const setpointDps = commandSign * rateDps;
  const gyroDps = setpointDps * MEASURED.yawGyroPerSetpoint;
  const headingRateDps = gyroDps * MEASURED.yawHeadingRatePerGyroDps;
  const dt = seconds / steps;

  // A sample-to-sample unwrap cannot recover a rotation of more than half a turn
  // between samples, and neither could the log evidence. Keep the simulation
  // inside what a real log can represent, so a failure is a wrong word rather
  // than an aliased premise. The reference log samples at ~1 kHz.
  assert.ok(
    Math.abs(headingRateDps * dt) < 90,
    `simulation step of ${Math.abs(headingRateDps * dt).toFixed(1)}° aliases the heading unwrap`
  );

  const field = [startDecidegrees];
  let exact = startDecidegrees;
  for (let step = 0; step < steps; step += 1) {
    exact += headingRateDps * 10 * dt;
    // Wrapped exactly the way the field is stored: 0..3599 decidegrees.
    field.push(((Math.round(exact) % 3600) + 3600) % 3600);
  }
  return {field, gyroIntegralDeg: gyroDps * seconds};
}

/**
 * Total heading change across a wrapped heading field, in degrees.
 *
 * Sample-to-sample unwrap, the same reduction the log evidence was taken with.
 */
function unwrapDegrees(field) {
  let total = 0;
  for (let i = 1; i < field.length; i += 1) {
    let delta = (field[i] - field[i - 1]) / 10;
    while (delta > 180) {
      delta -= 360;
    }
    while (delta < -180) {
      delta += 360;
    }
    total += delta;
  }
  return total;
}

/**
 * The compass rule. A compass heading increases clockwise seen from above, so a
 * heading that grew is a nose that went right. This is the definition of the
 * field, not a firmware convention — and `attitude[2]` was confirmed to be that
 * field against GPS, see MEASURED above.
 */
function yawWordFromHeadingChange(degrees) {
  assert.notEqual(Math.sign(degrees), 0, 'a manoeuvre that moved no heading names no direction');
  return degrees > 0 ? 'nose right' : 'nose left';
}

/** Positive `attitude[0]` accelerates the aircraft right, so it is rolled right. */
function rollWordFromAttitudeChange(decidegrees) {
  assert.notEqual(Math.sign(decidegrees), 0, 'a manoeuvre that moved no attitude names no direction');
  const rightwardAccel = decidegrees / 10 * MEASURED.rollRightAccelPerDegree;
  return rightwardAccel > 0 ? 'right' : 'left';
}

/**
 * Flies one pitch manoeuvre through the measured relationships.
 *
 * Same shape as `flyYaw`, minus the wrap: `attitude[1]` is a tilt, not a
 * compass bearing, so it has no seam. What it has instead is a physical ceiling
 * — a helicopter that reaches ±90° of pitch is not being tuned — and the
 * simulation is held inside one so a failure is a wrong word rather than a
 * premise no aircraft could satisfy.
 */
function flyPitch({commandSign, rateDps, seconds, startDecidegrees, steps, gyroPerSetpoint,
  attitudeRatePerGyro}) {
  const setpointDps = commandSign * rateDps;
  const gyroDps = setpointDps * (gyroPerSetpoint ?? MEASURED.pitchGyroPerSetpoint);
  const attitudeRateDps = gyroDps * (attitudeRatePerGyro ?? MEASURED.pitchAttitudeRatePerGyroDps);
  const dt = seconds / steps;

  const field = [startDecidegrees];
  let exact = startDecidegrees;
  for (let step = 0; step < steps; step += 1) {
    exact += attitudeRateDps * 10 * dt;
    // A tilt attitude is not wrapped, but it is bounded by the aircraft.
    field.push(Math.round(Math.max(-900, Math.min(900, exact))));
  }
  return {
    field,
    gyroIntegralDeg: gyroDps * seconds,
    attitudeChangeDecidegrees: field[field.length - 1] - field[0]
  };
}

/**
 * The pitch rule, and the reason it is the same rule as roll's.
 *
 * A helicopter accelerates along whichever way its rotor disc is tilted: rolled
 * right, it goes right; nose down, it goes forward. The roll word above is read
 * off exactly that — the sign of the acceleration the attitude produces. The
 * pitch word is read off the same thing, along the nose instead of across it.
 *
 * Positive `attitude[1]` produced a POSITIVE acceleration along the nose in the
 * GPS anchor, so a manoeuvre that raises `attitude[1]` is one that sends the
 * aircraft forward, which is what "forward" names on this panel.
 *
 * `slopePerDegree` is a parameter, not a constant, so the sweeps below can walk
 * it across the whole envelope the 30 measurement variants produced rather than
 * asserting on the single number one of them happened to give.
 */
function pitchWordFromAttitudeChange(decidegrees, slopePerDegree = MEASURED.pitchForwardAccelPerDegree) {
  assert.notEqual(Math.sign(decidegrees), 0, 'a manoeuvre that moved no attitude names no direction');
  const forwardAccel = decidegrees / 10 * slopePerDegree;
  return forwardAccel > 0 ? 'forward' : 'back';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('the direction words are a two-way partition on every axis', async () => {
  const words = await readDirectionWords();
  for (const axis of AXES) {
    assert.notEqual(
      words[axis].positive,
      words[axis].negative,
      `${axis} names both command directions the same way, so the panel says nothing`
    );
  }
});

test('a positive yaw command is named for the way the logged heading actually moves', async () => {
  const words = await readDirectionWords();

  // Both directions have to be checked: a mapping that is right one way and
  // wrong the other is not reachable by a swap, but is reachable by a typo.
  for (const commandSign of [1, -1]) {
    const flight = flyYaw({
      commandSign,
      rateDps: 220,
      seconds: 1.6,
      startDecidegrees: 1200,
      steps: 1600
    });
    const expected = yawWordFromHeadingChange(unwrapDegrees(flight.field));
    const key = commandSign > 0 ? 'positive' : 'negative';
    assert.equal(
      words.yaw[key],
      expected,
      `a ${key} yaw command turns the heading ${unwrapDegrees(flight.field) > 0 ? 'up' : 'down'}, ` +
        `which is "${expected}", not "${words.yaw[key]}"`
    );
  }
});

test('the yaw words survive thousands of randomized manoeuvres across the heading seam', async () => {
  const words = await readDirectionWords();
  const random = makeRandom(0x5eed1);
  let crossedSeam = 0;

  for (let trial = 0; trial < 6000; trial += 1) {
    const commandSign = random() < 0.5 ? 1 : -1;
    // Adversarial spread: from a nudge barely above the detector's floor to a
    // rate no helicopter reaches, and durations from a flick to a long pirouette.
    const rateDps = 5 + random() * 995;
    const seconds = 0.05 + random() * 6;
    const startDecidegrees = Math.floor(random() * 3600);
    // Logging rates from a quarter of the reference log's ~1 kHz up to twice it.
    const sampleRateHz = 250 + Math.floor(random() * 1750);
    const steps = Math.max(4, Math.round(seconds * sampleRateHz));

    const flight = flyYaw({commandSign, rateDps, seconds, startDecidegrees, steps});
    const change = unwrapDegrees(flight.field);
    if (Math.abs(change) < 1) {
      continue; // too small to name a direction; the panel would not either
    }
    // Did this one actually wrap? Worth knowing the sweep exercised the seam.
    if (flight.field.some((value, i) => i > 0 && Math.abs(value - flight.field[i - 1]) > 1800)) {
      crossedSeam += 1;
    }

    const key = commandSign > 0 ? 'positive' : 'negative';
    assert.equal(
      words.yaw[key],
      yawWordFromHeadingChange(change),
      `trial ${trial}: ${key} command at ${rateDps.toFixed(1)}°/s for ${seconds.toFixed(2)}s ` +
        `from ${startDecidegrees} moved the heading ${change.toFixed(1)}°`
    );

    // The gyro and the heading must disagree in sign, or the premise of the
    // whole derivation has been edited away rather than the conclusion tested.
    assert.equal(
      Math.sign(flight.gyroIntegralDeg),
      -Math.sign(change),
      `trial ${trial}: the measured heading/gyro sign relationship no longer holds`
    );
  }

  assert.ok(
    crossedSeam > 500,
    `the sweep only crossed the 0/3599 seam ${crossedSeam} times; it is not exercising the wrap`
  );
});

test('the two whole-turn excursions in the reference log land on the right word', async () => {
  const words = await readDirectionWords();

  for (const excursion of REFERENCE_EXCURSIONS) {
    // These are the measured numbers, not simulated ones: a positive command
    // integrated +345.7° of gyro while the unwrapped heading moved -346.6°.
    assert.equal(
      Math.sign(excursion.gyroIntegralDeg),
      excursion.setpointSign,
      'the recorded excursion no longer matches its own command sign'
    );
    assert.equal(
      Math.sign(excursion.headingChangeDeg),
      -excursion.setpointSign,
      'the recorded excursion no longer shows the heading opposing the command'
    );

    const key = excursion.setpointSign > 0 ? 'positive' : 'negative';
    assert.equal(
      words.yaw[key],
      yawWordFromHeadingChange(excursion.headingChangeDeg),
      `the ${key} excursion moved the heading ${excursion.headingChangeDeg}°, ` +
        `so it belongs under "${yawWordFromHeadingChange(excursion.headingChangeDeg)}"`
    );
  }
});

test('roll is the control: the same derivation reproduces the words already there', async () => {
  const words = await readDirectionWords();
  const random = makeRandom(0xc0ffee);

  for (let trial = 0; trial < 4000; trial += 1) {
    const commandSign = random() < 0.5 ? 1 : -1;
    const rateDps = 5 + random() * 595;
    const seconds = 0.05 + random() * 3;

    // Positive gyroADC[0] drives attitude[0] up at slope +0.921.
    const attitudeChangeDecidegrees =
      commandSign * rateDps * MEASURED.rollAttitudeRatePerGyroDps * seconds * 10;

    const key = commandSign > 0 ? 'positive' : 'negative';
    assert.equal(
      words.roll[key],
      rollWordFromAttitudeChange(attitudeChangeDecidegrees),
      `trial ${trial}: a ${key} roll command at ${rateDps.toFixed(1)}°/s`
    );
  }
});

test('every axis is covered; none may be added without deciding what its words mean', async () => {
  const words = await readDirectionWords();
  assert.deepEqual(
    Object.keys(words).sort(),
    ['pitch', 'roll', 'yaw'],
    'an axis appeared or vanished; decide what its words mean before shipping them'
  );
});

// ---------------------------------------------------------------------------
// Pitch
// ---------------------------------------------------------------------------

/**
 * The premises have to be physics before the conclusion can be.
 *
 * Both tilt slopes are the same physical quantity — the horizontal acceleration
 * one degree of rotor-disc tilt produces, g·tan(1°) = 0.171 m/s² — measured on
 * two different axes. If either had come back at half that or at three times it,
 * the fit would be measuring something other than tilt and the sign it carries
 * would mean nothing. That the ROLL slope lands on 0.171 to three decimal places
 * is what makes the PITCH slope's sign worth reading: it is the same estimator,
 * on the same window, in the same units, validated on the axis nobody disputes.
 */
test('the GPS anchor is measuring tilt, on both axes, at the magnitude physics requires', () => {
  const {bestVariant, bootstrap, pitchSlopeEnvelope} = PITCH_ANCHOR;

  assert.ok(
    Math.abs(PITCH_ANCHOR.medianRollRightAccelPerDegree - ACCEL_PER_DEGREE_OF_TILT) < 0.01,
    `the roll slope is ${PITCH_ANCHOR.medianRollRightAccelPerDegree}, which is not the ` +
      `${ACCEL_PER_DEGREE_OF_TILT.toFixed(4)} m/s² per degree a tilted rotor disc produces; ` +
      'the fit is no longer measuring tilt and no sign it carries can be trusted'
  );

  for (const [name, slope] of [
    ['roll', PITCH_ANCHOR.medianRollRightAccelPerDegree],
    ['pitch', PITCH_ANCHOR.medianPitchForwardAccelPerDegree],
    ['pitch, best variant', bestVariant.pitchForwardAccelPerDegree],
    ['roll, best variant', bestVariant.rollRightAccelPerDegree],
    ['pitch, shipped constant', MEASURED.pitchForwardAccelPerDegree],
    ['roll, shipped constant', MEASURED.rollRightAccelPerDegree]
  ]) {
    const ratio = slope / ACCEL_PER_DEGREE_OF_TILT;
    assert.ok(ratio > 0.55 && ratio < 1.25,
      `the ${name} slope of ${slope} is ${ratio.toFixed(2)}× g·tan(1°); that is not a tilt ` +
        'measurement, so the word derived from it is not a measurement either');
  }

  // The whole envelope, not the convenient end of it.
  assert.ok(pitchSlopeEnvelope.low > 0,
    `the pitch slope reached ${pitchSlopeEnvelope.low} in at least one of the 30 variants, ` +
      'so the direction it names depends on which variant was run — settle that before shipping a word');
  assert.equal(bootstrap.pitchSignFlips, 0,
    `${bootstrap.pitchSignFlips} of ${bootstrap.trials} bootstrap resamples put the pitch ` +
      'slope on the other side of zero');
  assert.equal(bootstrap.rollSignFlips, 0);
  assert.ok(bootstrap.pitchLow > 0 && bootstrap.rollLow > 0,
    'the bootstrap interval crosses zero, so neither word is established');

  // A reflection is not a rotation. If mirroring the logged heading fitted just
  // as well, the heading convention would be undetermined and so would both
  // tilt signs that hang off it.
  assert.ok(PITCH_ANCHOR.mirrorResidualPenalty > 2,
    `mirroring the heading costs only ${PITCH_ANCHOR.mirrorResidualPenalty}× in residual; ` +
      'that is not enough separation to call the heading convention settled');
});

test('a positive pitch command is named for the way the aircraft actually accelerates', async () => {
  const words = await readDirectionWords();

  // Both directions, because a mapping right one way and wrong the other is not
  // reachable by a swap but is reachable by a typo.
  for (const commandSign of [1, -1]) {
    const flight = flyPitch({
      commandSign,
      rateDps: 18,
      seconds: 0.9,
      startDecidegrees: 0,
      steps: 900
    });
    const expected = pitchWordFromAttitudeChange(flight.attitudeChangeDecidegrees);
    const key = commandSign > 0 ? 'positive' : 'negative';
    assert.equal(
      words.pitch[key],
      expected,
      `a ${key} pitch command moves attitude[1] by ` +
        `${(flight.attitudeChangeDecidegrees / 10).toFixed(1)}°, which accelerates the ` +
        `aircraft ${expected === 'forward' ? 'along its nose' : 'backwards'}, so it belongs ` +
        `under "${expected}", not "${words.pitch[key]}"`
    );
  }
});

test('the pitch words survive thousands of randomized manoeuvres across the measured envelope', async () => {
  const words = await readDirectionWords();
  const random = makeRandom(0x91facd);
  let sawSaturation = 0;
  let sawWholeEnvelope = {low: false, high: false};

  for (let trial = 0; trial < 8000; trial += 1) {
    const commandSign = random() < 0.5 ? 1 : -1;
    // Adversarial spread: from a nudge to a rate no helicopter pitches at, and
    // from a flick to a long sustained input.
    const rateDps = 1 + random() * 399;
    const seconds = 0.05 + random() * 6;
    // Start anywhere a real machine can be, including already near the ceiling
    // so the simulation's clamp is exercised in both directions.
    const startDecidegrees = Math.round((random() * 2 - 1) * 850);
    const sampleRateHz = 250 + Math.floor(random() * 1750);
    const steps = Math.max(4, Math.round(seconds * sampleRateHz));

    // Walk the slope across the FULL envelope the 30 measurement variants
    // produced, plus the bootstrap's tails. If the word depended on which
    // variant was run, this is where it shows.
    const {low, high} = PITCH_ANCHOR.pitchSlopeEnvelope;
    const slope = low + random() * (high - low);
    if (slope < low + (high - low) * 0.05) sawWholeEnvelope.low = true;
    if (slope > high - (high - low) * 0.05) sawWholeEnvelope.high = true;

    // The two chain slopes also vary, within the sign the measurement fixed.
    const gyroPerSetpoint = 0.3 + random() * 0.9;
    const attitudeRatePerGyro = 0.5 + random() * 0.8;

    const flight = flyPitch({
      commandSign, rateDps, seconds, startDecidegrees, steps,
      gyroPerSetpoint, attitudeRatePerGyro
    });
    if (Math.abs(flight.attitudeChangeDecidegrees) < 1) {
      continue; // too small to name a direction; the panel would not either
    }
    if (Math.abs(flight.field[flight.field.length - 1]) >= 900) {
      sawSaturation += 1;
    }

    const key = commandSign > 0 ? 'positive' : 'negative';
    assert.equal(
      words.pitch[key],
      pitchWordFromAttitudeChange(flight.attitudeChangeDecidegrees, slope),
      `trial ${trial}: ${key} command at ${rateDps.toFixed(1)}°/s for ${seconds.toFixed(2)}s ` +
        `from ${startDecidegrees} decidegrees moved attitude[1] by ` +
        `${(flight.attitudeChangeDecidegrees / 10).toFixed(2)}° at slope ${slope.toFixed(4)}`
    );

    // The premise, not just the conclusion: the chain must still carry the
    // command's sign all the way to the attitude, or the derivation has been
    // edited away rather than tested.
    assert.equal(
      Math.sign(flight.gyroIntegralDeg),
      commandSign,
      `trial ${trial}: the measured setpoint→gyro relationship no longer holds`
    );
    assert.equal(
      Math.sign(flight.attitudeChangeDecidegrees),
      commandSign,
      `trial ${trial}: the measured gyro→attitude relationship no longer holds`
    );
  }

  assert.ok(sawSaturation > 200,
    `only ${sawSaturation} trials reached the attitude ceiling; the sweep is not ` +
      'exercising the clamp');
  assert.ok(sawWholeEnvelope.low && sawWholeEnvelope.high,
    'the sweep did not reach both ends of the measured slope envelope');
});

test('the sustained pitch excursions in the reference log land on the right word', async () => {
  const words = await readDirectionWords();
  const {total, gyroAgrees, attitudeAgrees} = REFERENCE_PITCH_EXCURSION_AGREEMENT;

  assert.equal(gyroAgrees, total,
    'the log no longer shows the gyro following the pitch command on every excursion');
  assert.ok(attitudeAgrees / total > 0.9,
    `the attitude followed the pitch command in only ${attitudeAgrees} of ${total} excursions`);

  for (const excursion of REFERENCE_PITCH_EXCURSIONS) {
    assert.equal(
      Math.sign(excursion.gyroIntegralDeg),
      excursion.setpointSign,
      'the recorded excursion no longer matches its own command sign'
    );
    assert.equal(
      Math.sign(excursion.attitudeChangeDeg),
      excursion.setpointSign,
      'the recorded excursion no longer shows the attitude following the command'
    );

    const key = excursion.setpointSign > 0 ? 'positive' : 'negative';
    const expected = pitchWordFromAttitudeChange(excursion.attitudeChangeDeg * 10);
    assert.equal(
      words.pitch[key],
      expected,
      `the ${key} excursion (${excursion.peakSetpointDps}°/s peak, ` +
        `${excursion.seconds}s) moved attitude[1] by ${excursion.attitudeChangeDeg}°, ` +
        `so it belongs under "${expected}"`
    );
  }
});

/**
 * The one thing a swap cannot be caught by: pitch and roll read from the same
 * estimator, so their words must be derived by the same rule.
 *
 * If someone "fixes" pitch by special-casing its sign while leaving roll alone,
 * the two axes stop meaning the same thing and this fails.
 */
test('pitch and roll are named by one rule, not two', async () => {
  const words = await readDirectionWords();

  // Same sign of attitude change, same sign of resulting acceleration, so the
  // two axes must both name the positive-acceleration side.
  const rollPositive = rollWordFromAttitudeChange(+100);
  const pitchPositive = pitchWordFromAttitudeChange(+100);
  assert.equal(rollPositive, 'right',
    'positive attitude[0] accelerates the aircraft right; the roll rule has changed');
  assert.equal(pitchPositive, 'forward',
    'positive attitude[1] accelerates the aircraft along its nose; the pitch rule has changed');

  assert.equal(words.roll.positive, rollPositive);
  assert.equal(words.pitch.positive, pitchPositive);
  assert.equal(words.roll.negative, rollWordFromAttitudeChange(-100));
  assert.equal(words.pitch.negative, pitchWordFromAttitudeChange(-100));
});
