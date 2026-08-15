import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {readFile, readdir} from 'node:fs/promises';

import {
  TERM_VIEWS,
  decimate,
  describeHoldCapture,
  describeStopCapture,
  directionalObservations,
  explainHoldRefusal,
  explainStopRefusal,
  holdManoeuvre,
  indexAtOrAfter,
  niceStep,
  resolveAxisSignals,
  stopManoeuvre,
  summarizeAxis
} from '../src/analysis/axis-report.mjs';
import {STOP_DETECTION_DEFAULTS} from '../src/analysis/records.mjs';
import {EVIDENCE_LIMITS} from '../src/analysis/pid-evidence.mjs';

/**
 * Deterministic PRNG, so a sweep that fails fails again on the next run.
 *
 * A randomized test whose seed moves every run reports a different subset of a
 * bug each time, and "it passed on the retry" is how a real failure gets closed.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normals(random) {
  // Box-Muller. Returns one value per call from a cached pair.
  let spare = null;
  return () => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    const u = Math.max(random(), 1e-12);
    const v = random();
    const radius = Math.sqrt(-2 * Math.log(u));
    spare = radius * Math.sin(2 * Math.PI * v);
    return radius * Math.cos(2 * Math.PI * v);
  };
}

/**
 * Builds the shape `decodeLog` returns, from named column generators.
 *
 * Deliberately hand-built rather than decoded from a fixture: this module's job
 * is turning columns into measurements, and a fixture would test the decoder
 * again while making the expected answers impossible to state exactly.
 */
function fakeSession(columns, sampleCount) {
  const names = Object.keys(columns);
  const fields = names.map((name, index) => ({name, index, sampleCount}));
  const samples = [];
  for (let i = 0; i < sampleCount; i += 1) {
    samples.push(names.map(name => columns[name](i)));
  }
  return {fields, samples};
}

const RATE_HZ = 1000;
const DT_US = 1e6 / RATE_HZ;

function baseColumns(extra = {}) {
  return {
    time: i => Math.round(i * DT_US),
    'setpoint[0]': () => 0,
    'setpoint[1]': () => 0,
    'setpoint[2]': () => 0,
    'gyroADC[0]': () => 0,
    'gyroADC[1]': () => 0,
    'gyroADC[2]': () => 0,
    headspeed: () => 1800,
    ...extra
  };
}

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

test('the unfiltered-gyro metric never falls back to debug[]', () => {
  // debug[N] is whatever the flight controller's current debug mode emits. On a
  // real Rotorflight 4.6 log debug[0] carried headspeed — 1710 to 1830 — and
  // differencing it against the gyro would have reported a ~1700 deg/s noise
  // floor with a straight face. A noise number is worthless unless the field
  // behind it is certain.
  const withDebug = fakeSession(baseColumns({
    'debug[0]': () => 1755, 'debug[1]': () => 1755, 'debug[2]': () => 1755
  }), 64);

  for (const axis of ['roll', 'pitch', 'yaw']) {
    const signals = resolveAxisSignals(withDebug, axis);
    assert.equal(signals.usable, true);
    assert.equal(signals.unfilteredIndex, null,
      `${axis}: debug[] must never stand in for an unfiltered gyro`);
    assert.equal(signals.names.unfiltered, null);
  }

  const summary = summarizeAxis(withDebug, resolveAxisSignals(withDebug, 'roll'));
  assert.equal(summary.unfilteredHighFrequencyRmsDps, null,
    'with no unfiltered gyro the app must report that it has none, not a number');
});

test('gyroRAW, gyroUnfilt and gyroADCunfilt are all accepted as the unfiltered gyro', () => {
  for (const prefix of ['gyroRAW', 'gyroUnfilt', 'gyroADCunfilt']) {
    const session = fakeSession(baseColumns({
      [`${prefix}[0]`]: () => 1, [`${prefix}[1]`]: () => 2, [`${prefix}[2]`]: () => 3
    }), 32);
    for (const [index, axis] of ['roll', 'pitch', 'yaw'].entries()) {
      const signals = resolveAxisSignals(session, axis);
      assert.equal(signals.names.unfiltered, `${prefix}[${index}]`);
    }
  }
});

test('a log missing a core signal is reported as unusable rather than guessed at', () => {
  const session = fakeSession({time: i => i * 1000, 'gyroADC[0]': () => 0}, 16);
  const signals = resolveAxisSignals(session, 'roll');
  assert.equal(signals.usable, false);
  assert.deepEqual(signals.missing, ['setpoint[0]']);
  assert.equal(summarizeAxis(session, signals), null);

  const bogus = resolveAxisSignals(session, 'sideways');
  assert.equal(bogus.usable, false);
  assert.deepEqual(bogus.missing, ['axis']);
});

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

test('tracking error and peaks are exact on a signal whose answer is known', () => {
  // gyro trails setpoint by a constant 4 deg/s wherever a rate is commanded, and
  // both sit at zero elsewhere. Every reported quantity then has a closed form.
  const n = 4000;
  const command = i => (i >= 1000 && i < 3000 ? 40 : 0);
  const session = fakeSession(baseColumns({
    'setpoint[0]': command,
    'gyroADC[0]': i => command(i) - (command(i) === 0 ? 0 : 4)
  }), n);

  const summary = summarizeAxis(session, resolveAxisSignals(session, 'roll'));

  assert.equal(summary.peakCommandDps, 40);
  assert.equal(summary.peakMeasuredDps, 36);
  assert.equal(summary.sampleCount, n);
  // 2000 of 4000 samples carry a 4 deg/s error, the rest carry none.
  assert.ok(Math.abs(summary.trackingRmsDps - Math.sqrt(16 * 2000 / 4000)) < 1e-9);
  assert.ok(Math.abs(summary.trackingRmsWhileMovingDps - 4) < 1e-9);
  assert.ok(Math.abs(summary.movingSeconds - 2) < 1e-3);
  assert.ok(Math.abs(summary.sampleRateHz - RATE_HZ) < 1);
  // First sample to last, so n - 1 intervals rather than n.
  assert.ok(Math.abs(summary.durationSeconds - (n - 1) / RATE_HZ) < 1e-9,
    `durationSeconds ${summary.durationSeconds}, expected ${(n - 1) / RATE_HZ}`);
  // 40 deg/s never reaches the stop detector's command threshold.
  assert.equal(summary.commandExcursionCount, 0);
  assert.equal(summary.secondsAboveCommandThreshold, 0);
});

test('a dropped sample is left out of the measurements, not counted as zero', () => {
  // A non-finite field becomes NaN and every accumulator skips it. Mapped to 0
  // instead, a dropout reads as a perfectly tracked sample at rest: it pulls
  // every RMS towards zero, which is the direction that makes a bad flight look
  // good, and it does it without changing the sample count on screen.
  const n = 1000;
  const dropped = i => i % 5 === 0;
  const session = fakeSession(baseColumns({
    'setpoint[0]': i => (dropped(i) ? Number.NaN : 30),
    'gyroADC[0]': i => (dropped(i) ? Number.NaN : 18)
  }), n);

  const summary = summarizeAxis(session, resolveAxisSignals(session, 'roll'));
  assert.equal(summary.sampleCount, n, 'the dropouts are still samples in the log');
  assert.equal(summary.peakCommandDps, 30);
  assert.equal(summary.peakMeasuredDps, 18);
  // 800 finite pairs, each 12 deg/s apart; the 200 dropouts contribute nothing.
  assert.ok(Math.abs(summary.trackingRmsDps - 12) < 1e-9,
    `trackingRmsDps ${summary.trackingRmsDps}: a dropout counted as a zero error ` +
    'would drag this to sqrt(0.8) * 12');
  assert.ok(Math.abs(summary.movingSeconds - 800 / RATE_HZ) < 1e-9);
});

test('a session with fields but no samples produces no summary', () => {
  // A header-only log: every field resolves, so the signals are usable, and
  // there is still nothing to measure. Peaks of zero over an empty flight are a
  // measurement of nothing presented on screen as a measurement.
  const empty = fakeSession(baseColumns(), 0);
  const signals = resolveAxisSignals(empty, 'roll');
  assert.equal(signals.usable, true, 'the fields are all there — only the samples are not');
  assert.equal(summarizeAxis(empty, signals), null);
});

test('the sample rate is the median interval, not the shortest one', () => {
  // Real frame spacing jitters: the reference log carries 993 us across 87 278
  // gaps, 994 across 33 961, and a tail down to 991. Every seconds-valued tile
  // is scaled by this number, so taking the smallest gap would report a rate the
  // logger never ran at and shrink each of them.
  const n = 2000;
  const times = new Float64Array(n);
  let clock = 0;
  for (let i = 0; i < n; i += 1) {
    times[i] = clock;
    // One short frame and one long one among two thousand — enough to move a
    // minimum or a maximum, not enough to move a median.
    clock += i === 700 ? 100 : i === 1500 ? 9000 : 1000;
  }

  const session = fakeSession(baseColumns({time: i => times[i]}), n);
  const summary = summarizeAxis(session, resolveAxisSignals(session, 'roll'));
  assert.ok(Math.abs(summary.sampleRateHz - 1000) < 1e-6,
    `sampleRateHz ${summary.sampleRateHz}: one 100 us gap in two thousand must not ` +
    'become the reported rate');
});

test('a span too short to filter reports no noise figure rather than a junk one', () => {
  // At 1 kHz the 10 ms window is 11 samples. Below window + 2 there is nowhere
  // to centre a full window, and any number squeezed out of a partial one is a
  // property of the span rather than of the signal — printed, on this screen,
  // under the word "vibration".
  const alternating = i => (i % 2 ? 40 : -40);
  const short = fakeSession(baseColumns({'gyroADC[0]': alternating}), 12);
  assert.equal(
    summarizeAxis(short, resolveAxisSignals(short, 'roll')).gyroHighFrequencyRmsDps,
    null, 'twelve samples is not enough to centre an eleven-sample window in');

  const long = fakeSession(baseColumns({'gyroADC[0]': alternating}), 400);
  assert.ok(summarizeAxis(long, resolveAxisSignals(long, 'roll'))
    .gyroHighFrequencyRmsDps > 30, 'and with room, the same signal does measure');
});

test('the summary names the field and the window its numbers came from', () => {
  // The screen has to be able to say which field the noise figure was taken
  // from, because "unfiltered gyro" means a different column on every firmware.
  const session = fakeSession(baseColumns({
    'gyroRAW[0]': () => 0, 'gyroRAW[1]': () => 0, 'gyroRAW[2]': () => 0
  }), 200);
  const summary = summarizeAxis(session, resolveAxisSignals(session, 'roll'));

  assert.equal(summary.unfilteredFieldName, 'gyroRAW[0]');
  assert.equal(summary.highFrequencyWindowUs, 10_000);
  assert.equal(summary.commandThresholdDps, STOP_DETECTION_DEFAULTS.commandThresholdDps);
  assert.equal(summary.minimumCommandHoldUs, STOP_DETECTION_DEFAULTS.minimumCommandHoldUs);
});

// ---------------------------------------------------------------------------
// The moving-command threshold
// ---------------------------------------------------------------------------

/**
 * The threshold, taken from the module's own report of it.
 *
 * Read back rather than written as a literal so this file does not become a
 * second place the number lives. What is pinned below is the *consequence* — the
 * exact set of samples the threshold admits — which is what a silent change to
 * it would move.
 */
const MOVING_DPS = summarizeAxis(
  fakeSession(baseColumns(), 8), resolveAxisSignals(fakeSession(baseColumns(), 8), 'roll')
).movingCommandThresholdDps;

test('the moving-command threshold is 10 deg/s and is reported as such', () => {
  // UNCONSTRAINED BY REAL DATA, and documented as such in the source: the
  // reference log's command distribution falls smoothly through this range and
  // picks out no value in it. It is pinned here because it is load-bearing —
  // 10 → 25 cuts that log's roll movingSeconds tile from 14.55 s to about 3.3 s
  // and moves trackingRmsWhileMovingDps with it — and because a headline number
  // must not change without someone deciding it should.
  assert.equal(MOVING_DPS, 10);
});

test('the moving-command threshold admits exactly the samples it claims to', () => {
  // Four bands, each with its own constant tracking error, chosen so that every
  // way the threshold could move produces a different arithmetic answer:
  //
  //   0 deg/s    error 0   below      — excluded by any threshold
  //   5 deg/s    error 3   below 10   — included only if the threshold drops
  //   10 deg/s   error 6   exactly 10 — included only if the test is >=, not >
  //   20 deg/s   error 8   above 10, below 25 — dropped if the threshold rises
  const n = 4000;
  const band = i => (i < 1000 ? 0 : i < 2000 ? 5 : i < 3000 ? MOVING_DPS : 20);
  const error = i => (i < 1000 ? 0 : i < 2000 ? 3 : i < 3000 ? 6 : 8);
  const session = fakeSession(baseColumns({
    'setpoint[0]': band,
    'gyroADC[0]': i => band(i) - error(i)
  }), n);

  const summary = summarizeAxis(session, resolveAxisSignals(session, 'roll'));

  // 2000 of 4000 samples are "moving": the 10 band and the 20 band.
  assert.ok(Math.abs(summary.movingSeconds - 2) < 1e-9,
    `movingSeconds ${summary.movingSeconds}: raising the threshold past 10 drops the ` +
    '10 band, past 20 drops both; testing > rather than >= drops the 10 band alone');
  assert.ok(Math.abs(summary.trackingRmsWhileMovingDps - Math.sqrt((36 + 64) / 2)) < 1e-9,
    `trackingRmsWhileMovingDps ${summary.trackingRmsWhileMovingDps}, expected sqrt(50)`);

  // The whole-flight figure is unaffected by the threshold, which is the point
  // of reporting both: only one of these two tiles moves when it does.
  assert.ok(Math.abs(summary.trackingRmsDps
    - Math.sqrt((0 + 1000 * 9 + 1000 * 36 + 1000 * 64) / n)) < 1e-9);

  // And the sample exactly on the threshold is inside it. Not a hypothetical:
  // the reference log's setpoints are 100% integer-valued, and |command| lands
  // exactly on 10 in 1139 roll samples and 281 yaw samples.
  const onlyAtThreshold = fakeSession(baseColumns({
    'setpoint[0]': () => MOVING_DPS,
    'gyroADC[0]': () => MOVING_DPS - 7
  }), 500);
  const boundary = summarizeAxis(onlyAtThreshold, resolveAxisSignals(onlyAtThreshold, 'roll'));
  assert.ok(Math.abs(boundary.trackingRmsWhileMovingDps - 7) < 1e-9,
    'a command exactly at the threshold is a command');
  assert.ok(Math.abs(boundary.movingSeconds - 0.5) < 1e-9);

  // Just below it is outside, so the threshold is pinned from both sides.
  const justBelow = fakeSession(baseColumns({
    'setpoint[0]': () => MOVING_DPS - 1,
    'gyroADC[0]': () => 0
  }), 500);
  assert.equal(
    summarizeAxis(justBelow, resolveAxisSignals(justBelow, 'roll'))
      .trackingRmsWhileMovingDps,
    null, 'one degree per second under the threshold is under it');
});

test('the moving-sample count matches an independent tally, over a sweep', () => {
  const random = mulberry32(0x3D0F5);

  for (let c = 0; c < 1500; c += 1) {
    const n = 200 + Math.floor(random() * 800);
    const commands = new Float64Array(n);
    const errors = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      // Concentrated on the threshold, and landing exactly on it often, because
      // that is where a moved threshold shows and a uniform draw does not.
      const draw = random();
      commands[i] = draw < 0.25
        ? Math.round(MOVING_DPS + (random() - 0.5) * 4)
        : (random() - 0.5) * 120;
      if (random() < 0.5) commands[i] = -commands[i];
      errors[i] = (random() - 0.5) * 30;
    }

    const session = fakeSession(baseColumns({
      'setpoint[0]': i => commands[i],
      'gyroADC[0]': i => commands[i] - errors[i]
    }), n);
    const summary = summarizeAxis(session, resolveAxisSignals(session, 'roll'));

    let squares = 0;
    let count = 0;
    for (let i = 0; i < n; i += 1) {
      if (Math.abs(commands[i]) >= MOVING_DPS) {
        squares += errors[i] * errors[i];
        count += 1;
      }
    }

    assert.ok(Math.abs(summary.movingSeconds - count / RATE_HZ) < 1e-9,
      `case ${c}: ${summary.movingSeconds * RATE_HZ} moving samples against ${count}`);
    if (count === 0) {
      assert.equal(summary.trackingRmsWhileMovingDps, null);
    } else {
      assert.ok(Math.abs(summary.trackingRmsWhileMovingDps - Math.sqrt(squares / count)) < 1e-9,
        `case ${c}: moving RMS`);
    }
  }
});

test('command excursions are counted with the detector\'s own hysteresis', () => {
  const high = STOP_DETECTION_DEFAULTS.commandThresholdDps + 20;
  const between = (STOP_DETECTION_DEFAULTS.commandThresholdDps
    + STOP_DETECTION_DEFAULTS.stopThresholdDps) / 2;

  // One excursion: it dips into the band between the two thresholds and climbs
  // again without ever reaching centre. Counting a crossing of the upper
  // threshold alone would call this two.
  const dipping = fakeSession(baseColumns({
    'setpoint[0]': i => (i < 100 ? 0 : i < 300 ? high : i < 400 ? between : i < 600 ? high : 0)
  }), 1000);
  assert.equal(
    summarizeAxis(dipping, resolveAxisSignals(dipping, 'roll')).commandExcursionCount, 1
  );

  // Two excursions: it returns to centre in between.
  const separated = fakeSession(baseColumns({
    'setpoint[0]': i => (i >= 100 && i < 300) || (i >= 600 && i < 800) ? high : 0
  }), 1000);
  const summary = summarizeAxis(separated, resolveAxisSignals(separated, 'roll'));
  assert.equal(summary.commandExcursionCount, 2);
  assert.ok(Math.abs(summary.secondsAboveCommandThreshold - 0.4) < 1e-3);
  assert.ok(Math.abs(summary.longestCommandAboveThresholdUs - 200_000) < 1500);

  // The LOWER threshold is the detector's own too, and the two fixtures above
  // dip to the midpoint of the band, which is far from it — the release
  // threshold could be set to anything below 50 without either of them noticing.
  // These two straddle it by one degree per second each way.
  const excursions = release => {
    const session = fakeSession(baseColumns({
      'setpoint[0]': i => (i < 100 ? 0 : i < 300 ? high : i < 400 ? release : i < 600 ? high : 0)
    }), 1000);
    return summarizeAxis(session, resolveAxisSignals(session, 'roll')).commandExcursionCount;
  };
  assert.equal(excursions(STOP_DETECTION_DEFAULTS.stopThresholdDps + 1), 1,
    'a dip to one degree above the release threshold has not released');
  assert.equal(excursions(STOP_DETECTION_DEFAULTS.stopThresholdDps - 1), 2,
    'a dip to one degree below it has');
});

test('the high-frequency metric measures the noise it was given, across a sweep', () => {
  // A centred box average of w samples removes 1/w of a zero-mean iid signal's
  // own contribution, so the residual RMS is sigma * sqrt(1 - 1/w). At 1 kHz the
  // 10 ms window is 11 samples, which is a prediction precise enough to catch an
  // off-by-one in the window or a partial-window edge leaking in.
  const window = 11;
  const expectedFactor = Math.sqrt(1 - 1 / window);
  const random = mulberry32(0xC0FFEE);
  const gauss = normals(random);

  let worst = 0;
  let totalRelative = 0;
  const cases = 300;

  for (let c = 0; c < cases; c += 1) {
    // The noise floor is swept over more than an order of magnitude. It is not
    // swept below 0.5 deg/s here because a box average leaks a little of any
    // slow signal, and below that the leak — quantified in its own test below —
    // is comparable to the thing being measured. The regime where the closed
    // form is exact is the regime this test is checking.
    const sigma = 0.5 + random() * 20;
    const slowAmplitude = random() * 120;
    const slowHz = 0.2 + random() * 2;
    const n = 3000;

    const noise = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      noise[i] = gauss() * sigma;
    }

    const session = fakeSession(baseColumns({
      'setpoint[0]': () => 0,
      'gyroADC[0]': i => slowAmplitude * Math.sin(2 * Math.PI * slowHz * i / RATE_HZ) + noise[i]
    }), n);

    const measured = summarizeAxis(session, resolveAxisSignals(session, 'roll'))
      .gyroHighFrequencyRmsDps;

    // Compare against the noise actually drawn rather than against sigma: the
    // sample RMS of 3000 draws is what the metric can possibly recover.
    let squares = 0;
    for (let i = 0; i < n; i += 1) {
      squares += noise[i] * noise[i];
    }
    const drawn = Math.sqrt(squares / n);

    const relative = Math.abs(measured - drawn * expectedFactor) / (drawn * expectedFactor);
    totalRelative += relative;
    worst = Math.max(worst, relative);
  }

  assert.ok(worst < 0.05, `worst case off by ${(worst * 100).toFixed(2)}%`);
  assert.ok(totalRelative / cases < 0.015,
    `mean error ${(totalRelative / cases * 100).toFixed(2)}% — the metric is biased`);
});

test('flight is not reported as noise: a slow signal barely leaks into the metric', () => {
  // The number this metric produces is shown to a pilot as vibration. A box
  // average passes a slow sine imperfectly, so some of a real manoeuvre leaks
  // through as "fast content" — this bounds how much, on the most aggressive
  // slow signal a helicopter's rigid body produces. Without the bound the metric
  // is a number nobody can say the meaning of.
  const random = mulberry32(0x1234);
  const window = 11;
  let worstAbsolute = 0;

  for (let c = 0; c < 200; c += 1) {
    const amplitude = 20 + random() * 280;
    // At least eight whole cycles inside the record, so the residual's sample
    // RMS is the sine's RMS and the closed form below is the whole answer.
    const hz = 1 + random() * 4;
    const n = 8000;
    const session = fakeSession(baseColumns({
      'gyroADC[0]': i => amplitude * Math.sin(2 * Math.PI * hz * i / RATE_HZ)
    }), n);

    const leaked = summarizeAxis(session, resolveAxisSignals(session, 'roll'))
      .gyroHighFrequencyRmsDps;

    // A box average of w samples at spacing dt has gain
    //   D(w) = sin(w*W*dt/2) / (w * sin(w*dt/2))
    // so what it leaves of a sine is A*|1 - D| and the RMS of that is over root
    // two. Predicted rather than tolerated: an implementation with the wrong
    // window length fails this even though its leak is still "small".
    const omega = 2 * Math.PI * hz;
    const dt = 1 / RATE_HZ;
    const gain = Math.sin(omega * window * dt / 2) / (window * Math.sin(omega * dt / 2));
    const expected = amplitude * Math.abs(1 - gain) / Math.SQRT2;

    // 5%, because a 4 s record is not a whole number of cycles at 0.4 Hz and the
    // residual's sample RMS is not exactly amplitude over root two. Still tight
    // enough to fail on a window of 9 or 13 samples, which move the leak ~40%.
    assert.ok(Math.abs(leaked - expected) < 0.05 * expected + 1e-6,
      `${hz.toFixed(2)} Hz at ${amplitude.toFixed(0)} deg/s: leaked ${leaked.toFixed(4)}, ` +
      `the 10 ms box average predicts ${expected.toFixed(4)}`);
    worstAbsolute = Math.max(worstAbsolute, leaked);
  }

  // And the consequence a pilot cares about: the worst rigid-body manoeuvre in
  // the sweep contributes about a degree per second to a number labelled noise.
  assert.ok(worstAbsolute < 1.5,
    `a manoeuvre contributed ${worstAbsolute.toFixed(2)} deg/s to the noise metric`);
});

test('the high-frequency metric is not inflated by the edges of a short span', () => {
  // A partial window is a different filter, and averaging over one near an edge
  // leaves a residual that belongs to the edge rather than to the signal. On a
  // pure ramp — which has no high-frequency content at all — an edge-biased
  // implementation reports a noise floor that is not there.
  const n = 400;
  const session = fakeSession(baseColumns({'gyroADC[0]': i => i * 0.5}), n);
  const measured = summarizeAxis(session, resolveAxisSignals(session, 'roll'))
    .gyroHighFrequencyRmsDps;
  assert.ok(measured < 1e-9, `a straight ramp has no fast content; got ${measured}`);
});

// ---------------------------------------------------------------------------
// Headspeed
// ---------------------------------------------------------------------------

/**
 * The plausibility floor the module filters headspeed against.
 *
 * Read from the shared limits, not written here, so a test that says "samples
 * below the floor are excluded" keeps saying that when the floor moves.
 */
const SPIN_FLOOR_RPM = EVIDENCE_LIMITS.minimumPlausibleHeadspeedRpm;

/**
 * The median the module must produce, computed the long way round.
 *
 * `values.length` is kept under the module's 4096-sample decimation cap by every
 * caller below, so the strided subsample is the whole array and this reference
 * owes nothing to the implementation's stride.
 */
function spinningMedian(values) {
  const kept = values.filter(value => Number.isFinite(value) && value >= SPIN_FLOOR_RPM)
    .sort((left, right) => left - right);
  return kept.length === 0 ? null : kept[(kept.length - 1) >> 1];
}

/**
 * Deliberately not pinned: the stride `stridedMedian` decimates a long column
 * with. Widening or narrowing it survives every test here, and that is correct
 * — the contract is "the median of the spinning samples", and a subsample of an
 * evenly spaced 4096 gives the same answer as one of 1365 or of all 134 429 on
 * any real headspeed trace. Pinning the stride would fix a memory optimisation
 * in place while pinning nothing a pilot can see. Audited and accepted, so the
 * next sweep does not report it as a gap.
 */
function headspeedSummary(values) {
  const session = fakeSession(baseColumns({headspeed: i => values[i]}), values.length);
  return summarizeAxis(session, resolveAxisSignals(session, 'roll')).headspeedMedianRpm;
}

test('headspeed ignores the spool-up, which is not flight', () => {
  // The previous fixture here put the spool-up in 2000 of 10 000 samples, which
  // is roughly the reference log's own 4.4%. At that proportion the median is
  // 1800 whether the filter runs or not: it passed with the filter deleted, so
  // it tested nothing. The failure is only reachable when the below-floor
  // samples are a MAJORITY, which is the log shape the filter exists for — a
  // recording that spends most of its length on the ground.
  const n = 3000;
  const spoolUp = 2200;
  const values = Array.from({length: n}, (_, i) =>
    (i < spoolUp ? Math.round(i / spoolUp * 250) : 1800));

  // The unfiltered answer is a spool-up value, and a spool-up value is not a
  // headspeed. This is the number a pilot would otherwise be shown.
  const unfiltered = [...values].sort((left, right) => left - right);
  const unfilteredMedian = unfiltered[(unfiltered.length - 1) >> 1];
  assert.ok(unfilteredMedian < SPIN_FLOOR_RPM,
    `the fixture cannot reach the failure: without the filter the median is ` +
    `${unfilteredMedian}, which the filter would not have changed`);

  assert.equal(headspeedSummary(values), 1800);
});

test('a headspeed exactly at the plausibility floor is spinning, not stopped', () => {
  // The reference log's setpoints are 100% integer-valued and its headspeed is
  // integer-valued too, so a sample landing exactly on a threshold is a normal
  // occurrence rather than a curiosity. `>=` against `>` has to be pinned.
  const atFloor = Array.from({length: 1000}, (_, i) => (i < 700 ? SPIN_FLOOR_RPM : 1800));
  assert.equal(headspeedSummary(atFloor), SPIN_FLOOR_RPM,
    'a sample exactly at the floor is at the floor, not below it');

  const justUnder = Array.from({length: 1000}, (_, i) => (i < 700 ? SPIN_FLOOR_RPM - 1 : 1800));
  assert.equal(headspeedSummary(justUnder), 1800,
    'one rpm under the floor is under the floor');
});

test('a log that never spun up reports no headspeed rather than a spool-up value', () => {
  assert.equal(headspeedSummary(Array.from({length: 500}, (_, i) => i % 200)), null);
  assert.equal(headspeedSummary(Array.from({length: 500}, () => 0)), null);
  assert.equal(headspeedSummary(Array.from({length: 500}, () => Number.NaN)), null);
});

test('the headspeed median is the median of the spinning samples, over a sweep', () => {
  // Randomized because the failure region is a proportion, and the fixture that
  // shipped before this one sat outside it. The spool-up fraction is swept
  // across the whole range, so no run of this test can avoid the majority case.
  const random = mulberry32(0x5C0011);

  for (let c = 0; c < 3000; c += 1) {
    const n = 40 + Math.floor(random() * 1200);
    const spoolFraction = random();
    const spool = Math.floor(n * spoolFraction);
    const flightRpm = 400 + random() * 1600;

    const values = new Array(n);
    for (let i = 0; i < n; i += 1) {
      if (i < spool) {
        // A ramp that may or may not cross the floor, so both sides of the
        // comparison are exercised, and lands exactly on it sometimes.
        values[i] = Math.round(i / Math.max(1, spool) * (150 + random() * 400));
      } else {
        values[i] = Math.round(flightRpm + (random() - 0.5) * 60);
      }
      // Adversarial: a scattering of dropouts, exact-floor values, and negatives.
      const roll = random();
      if (roll < 0.02) values[i] = Number.NaN;
      else if (roll < 0.04) values[i] = SPIN_FLOOR_RPM;
      else if (roll < 0.05) values[i] = -Math.round(random() * 500);
    }

    assert.equal(headspeedSummary(values), spinningMedian(values),
      `case ${c}: n=${n}, spool=${spool}`);
  }
});

// ---------------------------------------------------------------------------
// Decimation and axes
// ---------------------------------------------------------------------------

test('decimation never hides a sample, over a randomized sweep', () => {
  const random = mulberry32(0x5EED);

  for (let c = 0; c < 2000; c += 1) {
    const n = 1 + Math.floor(random() * 400);
    const values = Array.from({length: n}, () => (random() - 0.5) * 2000);
    const samples = values.map(value => [value]);

    const from = Math.floor(random() * n);
    const to = from + Math.floor(random() * (n - from));
    const columns = 1 + Math.floor(random() * 300);

    const trace = decimate(samples, 0, from, to, columns);

    let low = Infinity;
    let high = -Infinity;
    for (let i = from; i <= to; i += 1) {
      low = Math.min(low, values[i]);
      high = Math.max(high, values[i]);
    }

    assert.equal(trace.empty, false);
    assert.ok(Math.abs(trace.low - low) < 1e-9,
      `case ${c}: envelope floor ${trace.low} missed the true minimum ${low}`);
    assert.ok(Math.abs(trace.high - high) < 1e-9,
      `case ${c}: envelope ceiling ${trace.high} missed the true maximum ${high}`);
    assert.ok(trace.columns <= columns && trace.columns >= 1);
    // Never more columns than there are samples to fill them. Asking for 300
    // columns of a 4-sample range must give 4, not 300 — the extra 296 carry no
    // sample and are drawn as gaps in a trace that has none.
    assert.ok(trace.columns <= to - from + 1,
      `case ${c}: ${trace.columns} columns over ${to - from + 1} samples`);

    for (let column = 0; column < trace.columns; column += 1) {
      assert.ok(Number.isFinite(trace.min[column]),
        `case ${c}: column ${column} of ${trace.columns} covered no sample`);
      assert.ok(trace.min[column] <= trace.max[column]);
      assert.ok(trace.min[column] >= low - 1e-9 && trace.max[column] <= high + 1e-9);
    }
  }
});

test('decimation survives a range that is entirely non-finite', () => {
  const samples = [[Number.NaN], [Number.NaN], [Number.NaN]];
  const trace = decimate(samples, 0, 0, 2, 8);
  assert.equal(trace.empty, true);
  assert.equal(trace.low, 0);
  assert.equal(trace.high, 0);
});

// ---------------------------------------------------------------------------
// The binary search the plot seeks with
// ---------------------------------------------------------------------------

/** First index whose time is >= `probe`, by the obvious linear scan. */
function scanAtOrAfter(samples, probe) {
  for (let i = 0; i < samples.length; i += 1) {
    if (samples[i][0] >= probe) {
      return i;
    }
  }
  return samples.length;
}

test('indexAtOrAfter lands on the sample itself, not the one after it', () => {
  // The sweep that shipped before this one drew probes uniformly across the time
  // range, so in 2000 cases it never once landed exactly on a sample time. That
  // is the ONLY input where `<` and `<=` differ, and it is the normal case: the
  // plot seeks to a timestamp it read out of the very same column. The old test
  // passed with the comparison flipped.
  const samples = [[10], [20], [30], [40]];
  for (const [probe, expected] of [[10, 0], [20, 1], [30, 2], [40, 3]]) {
    assert.equal(indexAtOrAfter(samples, 0, probe), expected,
      `seeking to sample time ${probe} must return that sample, not the next one`);
  }

  // With repeated timestamps — which a decoder can emit at a frame boundary —
  // "at or after" means the FIRST of them.
  const repeated = [[5], [5], [5], [9]];
  assert.equal(indexAtOrAfter(repeated, 0, 5), 0,
    'the first sample at that time, not the last');
  assert.equal(indexAtOrAfter(repeated, 0, 9), 3);
  assert.equal(indexAtOrAfter([[7], [7], [7]], 0, 7), 0);
});

test('indexAtOrAfter agrees with a linear scan on the degenerate shapes', () => {
  assert.equal(indexAtOrAfter([], 0, 0), 0, 'an empty column has no index to return but 0');

  const single = [[1234]];
  assert.equal(indexAtOrAfter(single, 0, 1233), 0);
  assert.equal(indexAtOrAfter(single, 0, 1234), 0, 'exactly on the only sample');
  assert.equal(indexAtOrAfter(single, 0, 1235), 1, 'past the only sample is past the end');

  const flat = Array.from({length: 50}, () => [8]);
  assert.equal(indexAtOrAfter(flat, 0, 8), 0);
  assert.equal(indexAtOrAfter(flat, 0, 7), 0);
  assert.equal(indexAtOrAfter(flat, 0, 9), 50);
});

test('indexAtOrAfter agrees with a linear scan, over a randomized sweep', () => {
  const random = mulberry32(0xA11CE);
  let onBoundary = 0;

  for (let c = 0; c < 2000; c += 1) {
    const n = 1 + Math.floor(random() * 200);
    // Roughly a third of the arrays carry duplicate timestamps, and a tenth are
    // entirely one timestamp, so "first of the run" is exercised heavily.
    const duplicateRate = random() < 0.1 ? 1 : random() < 0.45 ? 0.4 : 0;
    let clock = Math.floor(random() * 1000);
    const samples = [];
    for (let i = 0; i < n; i += 1) {
      clock += random() < duplicateRate ? 0 : 1 + Math.floor(random() * 2000);
      samples.push([clock]);
    }
    const first = samples[0][0];
    const last = samples[n - 1][0];

    // Every probe that matters, not a uniform draw over the range: exactly on a
    // sample time, one microsecond either side of one, and outside both ends.
    const pick = samples[Math.floor(random() * n)][0];
    const probes = [
      pick, pick - 1, pick + 1,
      first, first - 1, first - 5000,
      last, last + 1, last + 5000,
      Math.floor(random() * (last - first + 1)) + first
    ];

    for (const probe of probes) {
      const expected = scanAtOrAfter(samples, probe);
      assert.equal(indexAtOrAfter(samples, 0, probe), expected,
        `case ${c}: n=${n}, probe ${probe}, times ` +
        `${samples.slice(0, 6).map(row => row[0]).join(',')}…`);
      if (samples.some(row => row[0] === probe)) {
        onBoundary += 1;
      }
    }
  }

  // The sweep is only a test of the comparison if it actually lands on sample
  // times. The old one never did; this asserts that this one does.
  assert.ok(onBoundary > 5000,
    `only ${onBoundary} probes landed exactly on a sample time — the sweep cannot ` +
    'reach the case that distinguishes < from <=');
});

test('gridline steps stay round and stay in range, over a randomized sweep', () => {
  const random = mulberry32(0xF00D);

  for (let c = 0; c < 5000; c += 1) {
    const range = 10 ** (random() * 12 - 6) * (1 + random() * 9);
    const step = niceStep(range, 4);

    assert.ok(step > 0 && Number.isFinite(step));
    const mantissa = step / 10 ** Math.floor(Math.log10(step) + 1e-9);
    assert.ok([1, 2, 5].some(allowed => Math.abs(mantissa - allowed) < 1e-6),
      `step ${step} for range ${range} is not 1, 2 or 5 times a power of ten ` +
      `(mantissa ${mantissa})`);

    const lines = range / step;
    assert.ok(lines >= 1.5 && lines <= 12,
      `range ${range} would draw ${lines.toFixed(1)} gridlines at step ${step}`);
  }

  assert.equal(niceStep(0), 1);
  assert.equal(niceStep(-5), 1);

  // The default is what the viewer actually calls, so it is the value that has
  // to be pinned — every assertion above passes an explicit 4.
  assert.equal(niceStep(100), niceStep(100, 4));
  assert.notEqual(niceStep(100), niceStep(100, 8));
});

// ---------------------------------------------------------------------------
// Capture briefs
// ---------------------------------------------------------------------------

function diagnostics({events = [], candidates = [], counters = {}} = {}) {
  return {events, candidates, counters};
}

test('a flight with no qualifying manoeuvre is distinguished from one that was refused', () => {
  const summary = {peakCommandDps: 56, commandThresholdDps: 80, minimumCommandHoldUs: 150_000};

  const absent = describeStopCapture(diagnostics({counters: {started: 0}}), {axis: 'roll', summary});
  assert.equal(absent.state, 'absent');
  assert.match(absent.headline, /largest roll command in this flight was 56/);
  assert.match(absent.headline, /contains none on roll/);
  assert.equal(absent.refusals.length, 0);

  const refused = describeStopCapture(diagnostics({
    counters: {started: 5},
    candidates: [
      {accepted: false, reason: 'RELEASE_DWELL'},
      {accepted: false, reason: 'RELEASE_DWELL'},
      {accepted: false, reason: 'HOLD_TOO_SHORT'}
    ]
  }), {axis: 'roll', summary});

  assert.equal(refused.state, 'rejected');
  assert.match(refused.headline, /5 roll commands above 80/);
  assert.deepEqual(refused.refusals.map(entry => [entry.code, entry.count]),
    [['RELEASE_DWELL', 2], ['HOLD_TOO_SHORT', 1]]);
  assert.match(refused.refusals[0].text, /paused part-way back to centre/);

  assert.notEqual(absent.headline, refused.headline,
    'these are different problems and must not read the same');

  // Numbers on screen are rounded, not truncated. Every quantity elsewhere in
  // this file happens to be a whole number, so a floor would have gone unseen.
  const fractional = describeStopCapture(diagnostics({counters: {started: 0}}), {
    axis: 'roll',
    summary: {peakCommandDps: 56.7, commandThresholdDps: 79.6, minimumCommandHoldUs: 150_000}
  });
  assert.match(fractional.headline, /was 57°\/s/);
  assert.match(fractional.headline, /at least 80°\/s/);
});

test('one stop per direction is provisional, not the same answer as none', () => {
  const needed = EVIDENCE_LIMITS.minimumStopsPerDirection;

  const partial = describeStopCapture(diagnostics({
    events: [{commandSign: 'positive'}, {commandSign: 'negative'}],
    counters: {started: 2, emitted: 2}
  }), {axis: 'yaw'});

  assert.equal(partial.state, 'partial');
  assert.deepEqual(partial.captured, {positive: 1, negative: 1});
  assert.equal(partial.needed, needed);
  assert.match(partial.headline, /1 stop one way and 1 the other/);
  assert.match(partial.headline, /nothing is concluded/);

  // The counts are asymmetric on purpose. With one stop each way the headline
  // reads the same whichever direction is which, so a version that counted
  // positives as negatives passed.
  const lopsided = describeStopCapture(diagnostics({
    events: [{commandSign: 'positive'}, {commandSign: 'negative'}, {commandSign: 'negative'}]
  }), {axis: 'roll'});
  assert.deepEqual(lopsided.captured, {positive: 1, negative: 2});
  assert.match(lopsided.headline, /1 stop one way and 2 the other/);

  const enough = Array.from({length: needed}, () => ({commandSign: 'positive'}))
    .concat(Array.from({length: needed}, () => ({commandSign: 'negative'})));
  const captured = describeStopCapture(diagnostics({events: enough}), {axis: 'yaw'});
  assert.equal(captured.state, 'captured');
  assert.deepEqual(captured.captured, {positive: needed, negative: needed});
  // The sentence itself, not just the state behind it. It was the one headline
  // in this module nothing read.
  assert.match(captured.headline,
    new RegExp(`${needed} and ${needed} stops captured, both directions measured separately`));

  // Both directions, not either. The two are never pooled, so a flight with
  // plenty of stops one way and none the other is not a capture — and saying
  // "N and 0 stops captured, both directions measured separately" would be a
  // false sentence about a flight, printed as a headline.
  const oneSided = describeStopCapture(diagnostics({
    events: Array.from({length: needed + 3}, () => ({commandSign: 'positive'}))
  }), {axis: 'yaw'});
  assert.equal(oneSided.state, 'partial',
    'stops in one direction only are not a capture, however many there are');
  assert.deepEqual(oneSided.captured, {positive: needed + 3, negative: 0});
  assert.doesNotMatch(oneSided.headline, /both directions measured separately/);
  assert.match(oneSided.headline, /nothing is concluded/);
});

test('every capture brief names a manoeuvre and marks it as a manoeuvre', () => {
  for (const axis of ['roll', 'pitch', 'yaw']) {
    for (const brief of [
      describeStopCapture(diagnostics(), {axis}),
      describeHoldCapture({status: 'inconclusive', holds: [], rejectedHoldCounts: {}}, {axis})
    ]) {
      assert.ok(brief.manoeuvre, `${axis}: a flyable state must carry a manoeuvre`);
      assert.ok(brief.manoeuvre.steps.length >= 3, `${axis}: a brief with no steps is not a brief`);
      assert.match(brief.manoeuvre.title, new RegExp(axis));
      // The boundary sentence must scope itself to what is on this panel, and
      // must carry the promise that did not move on 12 August 2026.
      assert.match(brief.boundary, /measurement of the flight you opened/);
      assert.match(brief.boundary, /never writes to a flight controller/,
        `${axis}: the one promise that survived the reversal must be on the panel`);
      assert.match(brief.manoeuvre.note, /not a change to your aircraft or your setup/);
    }
  }
});

test('the manoeuvre brief quotes the gates that will actually judge it', () => {
  // A brief that drifts from the detector is worse than none: it sends someone up
  // to fly a manoeuvre that will be refused for the same reason again.
  const stop = stopManoeuvre('roll').steps.join(' ');
  assert.ok(stop.includes(`${STOP_DETECTION_DEFAULTS.commandThresholdDps}°/s`),
    'the command threshold in the brief must be the detector\'s own');
  assert.ok(stop.includes(`${STOP_DETECTION_DEFAULTS.minimumCommandHoldUs / 1e6} s`),
    'the hold floor in the brief must be the detector\'s own');
  assert.ok(stop.includes(`${STOP_DETECTION_DEFAULTS.slowWindowUs[1] / 1e6} s`),
    'the quiet window in the brief must be the detector\'s own');
  assert.ok(stop.includes(`${EVIDENCE_LIMITS.minimumStopsPerDirection} left`)
    && stop.includes(`${EVIDENCE_LIMITS.minimumStopsPerDirection} right`),
    'the brief must ask for the number of stops each direction actually needs');

  // And the control it names is the one the axis actually has. A brief that
  // tells someone to put in a yaw cyclic command describes no helicopter.
  assert.ok(stopManoeuvre('yaw').steps.join(' ').includes('pedal'));
  assert.ok(!stopManoeuvre('yaw').steps.join(' ').includes('cyclic'));
  assert.ok(stopManoeuvre('roll').steps.join(' ').includes('cyclic'));
  assert.ok(stopManoeuvre('pitch').steps.join(' ').includes('cyclic'));

  const hold = holdManoeuvre('pitch').steps.join(' ');
  assert.ok(hold.includes(`${EVIDENCE_LIMITS.minimumHoldDurationUs / 1e6} s`));
  assert.ok(hold.includes(`${EVIDENCE_LIMITS.offAxisCommandLimitDps}°/s`));
  assert.ok(hold.includes(`${EVIDENCE_LIMITS.minimumHolds} such holds`));
});

test('hold capture separates never-flown from set-aside', () => {
  const absent = describeHoldCapture({status: 'inconclusive', holds: [], rejectedHoldCounts: {}},
    {axis: 'roll'});
  assert.equal(absent.state, 'absent');
  assert.match(absent.headline, /no steady roll segment/);

  const rejected = describeHoldCapture({
    status: 'inconclusive', holds: [],
    rejectedHoldCounts: {HOLD_OFF_AXIS_INPUT: 4, HOLD_HEADSPEED_UNSTABLE: 1}
  }, {axis: 'roll'});
  assert.equal(rejected.state, 'rejected');
  assert.deepEqual(rejected.refusals.map(entry => entry.code),
    ['HOLD_OFF_AXIS_INPUT', 'HOLD_HEADSPEED_UNSTABLE']);
  assert.match(rejected.refusals[0].text, /another axis was being commanded/);

  const partial = describeHoldCapture({status: 'inconclusive', holds: [{}], rejectedHoldCounts: {}},
    {axis: 'roll'});
  assert.equal(partial.state, 'partial');
  assert.match(partial.headline, /nothing is concluded/);
  // The count in the sentence is the evidence module's, not a literal here.
  assert.equal(partial.needed, EVIDENCE_LIMITS.minimumHolds);
  assert.match(partial.headline, new RegExp(`${EVIDENCE_LIMITS.minimumHolds} are needed`));
});

test('an unrecognised refusal code degrades to words, not to a shouted enum', () => {
  assert.equal(explainStopRefusal('SOME_NEW_GATE_FIRED'), 'some new gate fired');
  assert.equal(explainHoldRefusal('ANOTHER_NEW_GATE'), 'another new gate');
  assert.match(explainStopRefusal('RELEASE_DWELL'), /paused part-way/);
});

test('the detector\'s own diagnosis decides the state, not a count derived from it', () => {
  // ALL_CANDIDATES_REJECTED and NO_COMMAND_REACHED_THRESHOLD call for opposite
  // responses — a different threshold, or a different flight — and both arrive
  // as an empty event list.
  const rejected = describeStopCapture({
    events: [], candidates: [], counters: {started: 0},
    diagnosis: {
      axis: 'roll', outcome: 'ALL_CANDIDATES_REJECTED', peakCommandDps: 210,
      commandThresholdDps: 80, candidatesOpened: 7,
      rejections: {RELEASE_DWELL: 5, HOLD_TOO_SHORT: 2},
      dominantRejectionReason: 'RELEASE_DWELL'
    }
  }, {axis: 'roll'});

  // The counters say nothing was ever started; the diagnosis is believed anyway.
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.attemptCount, 7);
  assert.match(rejected.headline, /7 roll commands above 80/);
  assert.match(rejected.headline, /Most often, the command paused part-way back to centre/);

  const absent = describeStopCapture({
    events: [], candidates: [], counters: {started: 4},
    diagnosis: {
      axis: 'roll', outcome: 'NO_COMMAND_REACHED_THRESHOLD', peakCommandDps: 56,
      commandThresholdDps: 80, candidatesOpened: 0, rejections: {},
      dominantRejectionReason: null
    }
  }, {axis: 'roll'});

  assert.equal(absent.state, 'absent');
  // Taken from the detector rather than from a second pass over the samples, so
  // the two can never disagree on screen.
  assert.equal(absent.peakCommandDps, 56);
  assert.match(absent.headline, /largest roll command in this flight was 56/);

  // The precedence rule itself, on inputs where the two paths give different
  // answers. Constructed rather than observed: today's detector keeps its
  // counters and its diagnosis in step, so without a deliberate disagreement
  // this test passes just as well against a version that ignores the diagnosis
  // entirely — which is what it did before this case was added. The rule is
  // documented, so it is worth pinning independently of whether anything
  // currently exercises it.
  const disagreeing = describeStopCapture({
    events: [], candidates: [], counters: {started: 0},
    diagnosis: {
      axis: 'roll', outcome: 'ALL_CANDIDATES_REJECTED', peakCommandDps: 210,
      commandThresholdDps: 80, candidatesOpened: 0, rejections: {},
      dominantRejectionReason: null
    }
  }, {axis: 'roll'});

  assert.equal(disagreeing.state, 'rejected',
    'the detector\'s own outcome must win over a state derived from its counters');

  // The same precedence for the two numbers that go into the sentence. Both
  // paths are populated here and they disagree, so a version that read either
  // one from the summary is caught rather than merely unexercised.
  const disagreeingNumbers = describeStopCapture({
    events: [], candidates: [], counters: {},
    diagnosis: {
      axis: 'roll', outcome: 'NO_COMMAND_REACHED_THRESHOLD', peakCommandDps: 56,
      commandThresholdDps: 95, candidatesOpened: 0, rejections: {},
      dominantRejectionReason: null
    }
  }, {axis: 'roll', summary: {peakCommandDps: 12, commandThresholdDps: 80}});

  assert.equal(disagreeingNumbers.commandThresholdDps, 95);
  assert.equal(disagreeingNumbers.peakCommandDps, 56);
  assert.match(disagreeingNumbers.headline, /was 56°\/s/);
  assert.match(disagreeingNumbers.headline, /at least 95°\/s/);
});

test('refusal counts come from the uncapped tally, not the capped candidate list', () => {
  // `candidates` stops at maximumEvents * 8. A log that refuses ten thousand
  // releases must still be able to say how many, and by which gate.
  const brief = describeStopCapture({
    events: [], candidates: [{accepted: false, reason: 'RELEASE_DWELL'}],
    counters: {started: 10_000},
    diagnosis: {
      axis: 'yaw', outcome: 'ALL_CANDIDATES_REJECTED', peakCommandDps: 300,
      commandThresholdDps: 80, candidatesOpened: 10_000,
      rejections: {RELEASE_DWELL: 9_512, RELEASE_TOO_SLOW: 488},
      dominantRejectionReason: 'RELEASE_DWELL'
    }
  }, {axis: 'yaw'});

  assert.deepEqual(brief.refusals.map(entry => [entry.code, entry.count]),
    [['RELEASE_DWELL', 9512], ['RELEASE_TOO_SLOW', 488]]);
});

test('an axis the log does not carry is not treated as a flight that was never flown', () => {
  // Flying the aircraft again does not add a field that was never enabled, so a
  // manoeuvre brief here would waste a flight.
  for (const outcome of ['AXIS_NOT_LOGGED', 'NO_RECORDS', 'UNKNOWN_AXIS']) {
    const brief = describeStopCapture({
      events: [], candidates: [], counters: {},
      diagnosis: {axis: 'pitch', outcome, peakCommandDps: 0, rejections: {}}
    }, {axis: 'pitch'});

    assert.equal(brief.state, 'unavailable', outcome);
    assert.equal(brief.manoeuvre, null, `${outcome} must not offer a manoeuvre to fly`);
    assert.ok(brief.headline.length > 0);
    assert.doesNotMatch(brief.headline, /contains none on pitch/,
      `${outcome} must not read as "you did not fly it"`);
  }
});

test('a detector that stops reporting diagnostics does not crash the panel', () => {
  // The stop detector's diagnostics contract is owned elsewhere and is being
  // changed. Losing a field must cost a sentence, not the screen.
  for (const input of [undefined, null, {}, {events: null, counters: null, candidates: null}]) {
    const brief = describeStopCapture(input, {axis: 'roll'});
    assert.equal(brief.state, 'absent');
    assert.ok(brief.headline.length > 0);
    assert.ok(brief.manoeuvre.steps.length > 0);
  }
});

// ---------------------------------------------------------------------------
// Directional observations
// ---------------------------------------------------------------------------

test('a directional difference is reported with its stop count, over a sweep', () => {
  const random = mulberry32(0xBEEF);

  for (let c = 0; c < 3000; c += 1) {
    const positive = (random() - 0.5) * 200;
    const negative = (random() - 0.5) * 200;
    const positiveCount = 1 + Math.floor(random() * 4);
    const negativeCount = 1 + Math.floor(random() * 4);

    const [observation] = directionalObservations({
      directions: {
        positive: {directionEventCount: positiveCount, metricA: positive},
        negative: {directionEventCount: negativeCount, metricA: negative}
      }
    }, ['metricA']);

    assert.ok(observation, `case ${c}: an observation must exist when both directions have a stop`);
    const large = Math.max(Math.abs(positive), Math.abs(negative));
    const small = Math.min(Math.abs(positive), Math.abs(negative));
    if (small === 0) {
      assert.equal(observation.ratio, null);
    } else {
      assert.ok(Math.abs(observation.ratio - large / small) < 1e-9);
      assert.ok(observation.ratio >= 1 - 1e-12, 'the ratio is always the larger over the smaller');
    }
    assert.equal(observation.higher,
      Math.abs(positive) >= Math.abs(negative) ? 'positive' : 'negative');
    assert.equal(observation.provisional,
      positiveCount < EVIDENCE_LIMITS.minimumStopsPerDirection
      || negativeCount < EVIDENCE_LIMITS.minimumStopsPerDirection);
  }
});

test('no observation is offered when a direction was never flown', () => {
  // The zero-stop direction carries a finite metric here, and that is the whole
  // point. The version of this case that shipped first left the metric off, so
  // the `continue` on a non-finite value did the rejecting and the event-count
  // gate could be deleted outright without anything failing. A zeroed
  // accumulator with no stops behind it is exactly what produces a left-against-
  // right ratio out of one direction's data.
  assert.deepEqual(directionalObservations({
    directions: {
      positive: {directionEventCount: 3, metricA: 10},
      negative: {directionEventCount: 0, metricA: 0.001}
    }
  }, ['metricA']), []);

  assert.deepEqual(directionalObservations({
    directions: {
      positive: {directionEventCount: 0, metricA: 4},
      negative: {directionEventCount: 5, metricA: 9}
    }
  }, ['metricA']), [], 'neither direction may stand in for the other');

  assert.deepEqual(directionalObservations(undefined, ['metricA']), []);
});

// ---------------------------------------------------------------------------
// The line, as the owner moved it on 12 August 2026
//
// PRODUCT REVERSAL, decided by the owner (Michael Wallace), recorded in
// CLAUDE.md and docs/AXIS_VIEW_AND_CAPTURE.md. Until that date this repository's
// rule was "the analysis reports MEASUREMENTS, never instructions", and the
// guard below was named "nothing this module can say is a tuning instruction".
// The owner reversed it: "i would like the app to analize the flight log the end
// user selects and recommend what to adjust, thats always been my plan for the
// app because a lot of people have no clue what they are looking at when they
// see all the info and graphs."
//
// The guard was therefore REPOINTED rather than deleted. It used to answer "did
// anyone sneak an instruction in?" — a question with no correct answer any more.
// It now answers "did anyone sneak an instruction PAST THE GATES?", which is
// three separate invariants:
//
//   1. Advice reaches a pilot only through the gated recommendation path. Every
//      other module in `src/` — this one included — stays measurement-only, so
//      the raw number behind any claim is always findable in a place that is
//      not itself arguing for a conclusion.
//   2. A recommendation exists only where the gates let one through, and the
//      gates answer no until evidence makes them answer yes.
//   3. Nothing implies RotorLens can write to a flight controller. That did not
//      move, and is not behind a confirmation dialog either.
//
// The tests below are one guard in six pieces: the rule set and its two-sided
// self-test; the sweep over every sentence this module assembles at run time;
// the static sweep over every string literal in every other module in `src/`;
// the gates' default-deny; the recommendation surface's default-deny; and the
// absence of any write path.
//
// KNOWN BOUNDARY, stated rather than hidden: this guard reads `src/`, not
// `ui/`. Rendering advice is what a recommendation panel is for, so a rule
// applied to `ui/` would be measuring the wrong thing, and `ui/legal-data.mjs`
// carries the Apache licence text, which trips any reasonable phrasing rule.
// The equivalent check against what a browser actually paints lives in
// `test/ui-browser.test.mjs`.
// ---------------------------------------------------------------------------

/**
 * A tunable: the thing a pilot would go and change on the aircraft.
 *
 * Deliberately case-sensitive on the single letters. `[PID]` under `/i` matches
 * the `i` in "i.e." and the `d` in a hundred ordinary words, which turns every
 * rule built on it into noise, and a noisy guard gets its rules loosened until
 * it guards nothing.
 */
const TUNABLE_SOURCE =
  '(?:\\bgains?\\b|\\bterms?\\b|\\bpids?\\b|\\bsettings?\\b|\\bfilters?\\b|\\b[PID]\\b)';
const TUNABLE = new RegExp(TUNABLE_SOURCE);

/** Verbs of change, in every inflection, capitalised or not. */
const CHANGE_VERB =
  '(?:[Ii]ncreas|[Dd]ecreas|[Rr]ais|[Ll]ower|[Rr]educ|[Ss]often|[Ss]tiffen'
  + '|[Ss]horten|[Ll]engthen|[Bb]ump|[Tt]rim|[Aa]djust)(?:e|es|ed|ing|s)?';

/**
 * What counts as telling a pilot to change a setting.
 *
 * NARROWER than the list this replaced, and narrowed on purpose. The old rules
 * banned the bare words `increase`, `reduce`, `should` and `too much` anywhere,
 * which is right for a product that never advises and wrong for one that does:
 * "Your head speed moved too much across the stops to compare them" is a
 * measurement, and a rule that flags it gets deleted rather than fixed. Each
 * rule now requires the sentence to be about a TUNABLE, or to be an unambiguous
 * instruction on its own. `PERMITTED_SENTENCES` is the other half of that
 * bargain: it fails if the rules are ever tightened back into noise.
 */
const INSTRUCTION_RULES = [
  {
    label: 'a verb of change aimed at a tunable',
    matches: new RegExp(`\\b${CHANGE_VERB}\\b[^.!?]{0,60}${TUNABLE_SOURCE}`)
  },
  {
    label: 'a tunable followed by a verb of change',
    matches: new RegExp(`${TUNABLE_SOURCE}[^.!?]{0,60}\\b${CHANGE_VERB}\\b`)
  },
  {
    // The verb forms only. "no recommendation is made without it" is the app
    // declining to advise and must stay sayable; "we recommend" is advice.
    label: 'the module recommending, suggesting or advising',
    matches: /\b(?:recommend|suggest|advise)(?:s|ed|ing)?\b/i
  },
  {
    label: 'dial it up, bump it, back off, turn it down',
    matches: /\b(?:dial|bump|back off|turn)\s+(?:it|them|the|your|up|down)\b/i
  },
  {label: 'more or less of a term', matches: /\b(?:more|less|higher|lower)\s+[PID]\b/},
  {label: 'gains up or down', matches: /\b(?:gain|pid)s?\s+(?:up|down)\b/i},
  {label: 'telling the pilot what he should do', matches: /\byou\s+(?:should|need to|must|want to)\b/i},
  {
    label: 'a tunable judged too high, too low, too much',
    matches: text => /\btoo\s+(?:high|low|much|little|many|fast|slow|soft|stiff|aggressive)\b/i
      .test(text) && TUNABLE.test(text)
  }
];

/** Every rule that fires on `text`, by label. */
function instructionsIn(text) {
  return INSTRUCTION_RULES
    .filter(rule => (typeof rule.matches === 'function'
      ? rule.matches(text)
      : rule.matches.test(text)))
    .map(rule => rule.label);
}

/**
 * Sentences a measurement surface must never be able to emit.
 *
 * The guard is worth exactly as much as its rules, and its rules are where it
 * has silently failed before: the original list was `raise|lower|…` with no
 * endings, and "Consider raising the gain." — the single sentence it existed to
 * stop — went straight through it.
 */
const BANNED_SENTENCES = [
  'Consider raising the gain.',
  'Try lowering P a little.',
  'Increasing D would help here.',
  'We recommend reducing your I term.',
  'This suggests your P is too high.',
  'Back off the D gain.',
  'You should decrease it.',
  'Dial the gains down.',
  'Your D is too aggressive.',
  'You need to turn it down.',
  // Sneakier forms, added with the reversal: an instruction phrased as an
  // observation, and one phrased as a plan.
  'The evidence suggests a smaller D term.',
  'Trim the yaw gain a little and fly it again.',
  'Your pitch P looks too soft for this head speed.',
  'Next flight, try the I term reduced by ten percent.'
];

/**
 * Sentences a measurement surface must stay ABLE to emit.
 *
 * Every one of these is measurement or capture guidance, which the product has
 * always been allowed to say and now needs more than ever: a blocked gate has
 * to explain what to fly next. If a future tightening of the rules flags one of
 * these, the rules have stopped separating advice from measurement and the
 * honest fix is the rule, not the sentence.
 */
const PERMITTED_SENTENCES = [
  'Your head speed moved too much across the stops in this flight to compare them.',
  'The largest roll command in this flight was 56°/s, and a stop needs at least 80°/s.',
  'Hold the command steady, release it to centre in one movement, then keep hands off.',
  'This range shows vibration that has to be explained before any gain is worth changing.',
  'The stability check has not been run for this axis, and no recommendation is made without it.',
  'Fly the manoeuvre a few more times, each way, and this becomes answerable.',
  'Everything above is a measurement of the flight you opened.',
  'Nothing in this flight is a stop, and nothing is wrong with the aircraft.'
];

test('the instruction rules catch every instruction and clear every measurement', () => {
  // Two-sided on purpose. A guard that only proves it catches bad sentences can
  // be satisfied by a rule that matches everything, and the way THAT fails is
  // that someone deletes a true sentence to get the build green.
  for (const banned of BANNED_SENTENCES) {
    assert.ok(instructionsIn(banned).length > 0,
      `the rules no longer catch "${banned}", so they are not guarding anything`);
  }

  for (const permitted of PERMITTED_SENTENCES) {
    assert.deepEqual(instructionsIn(permitted), [],
      `"${permitted}" is a measurement and the rules now read it as an instruction`);
  }
});

test('every sentence this measurement module can assemble is free of instructions', () => {
  // This module is a MEASUREMENT surface: it is where a pilot goes to find the
  // raw number behind whatever the recommendation panel claims, so it may tell
  // him what to FLY and never what to CHANGE. The sweep covers every branch of
  // every sentence, including the ones assembled from thresholds at run time.
  // "Every branch" is load-bearing and was once false: six headline branches sat
  // outside the sweep — the peak-less `absent` stop headline, all three
  // UNAVAILABLE_OUTCOMES, and the hold `partial` and `rejected` headlines. A
  // real tuning instruction written into any one of them left this test green,
  // measured one branch at a time. Each branch below is reached by a named
  // input; if you add a branch, add its input here or this guard quietly stops
  // covering it.
  const sentences = [];
  for (const axis of ['roll', 'pitch', 'yaw']) {
    for (const brief of [stopManoeuvre(axis), holdManoeuvre(axis)]) {
      sentences.push(brief.title, brief.note, ...brief.steps);
    }
    for (const state of [
      // Both arms of `absent`. The one WITH a peak was already here; the one
      // WITHOUT was not, and a tuning instruction appended to it left this
      // whole test green — the guard's own comment claimed a completeness it
      // did not have. Every branch of both describers is now named explicitly
      // so the next branch added is a visibly missing line rather than a
      // silent hole.
      describeStopCapture(diagnostics(), {axis, summary: {peakCommandDps: 12}}),
      describeStopCapture(diagnostics(), {axis}),
      describeStopCapture(diagnostics({counters: {started: 3}}), {axis}),
      describeStopCapture(diagnostics({events: [{commandSign: 'positive'}]}), {axis}),
      describeStopCapture(diagnostics({
        events: [
          {commandSign: 'positive'}, {commandSign: 'positive'},
          {commandSign: 'negative'}, {commandSign: 'negative'}
        ]
      }), {axis}),
      // `unavailable` short-circuits every other branch and returns a canned
      // sentence per outcome, so each outcome is its own piece of copy.
      ...['NO_RECORDS', 'AXIS_NOT_LOGGED', 'UNKNOWN_AXIS'].map(outcome =>
        describeStopCapture({...diagnostics(), diagnosis: {outcome, axis}}, {axis})),
      describeHoldCapture({status: 'inconclusive', holds: [], rejectedHoldCounts: {}}, {axis}),
      describeHoldCapture({status: 'inconclusive', holds: [{}], rejectedHoldCounts: {}}, {axis}),
      describeHoldCapture({
        status: 'inconclusive', holds: [],
        rejectedHoldCounts: {HOLD_TOO_SHORT_AFTER_SETTLE: 3}
      }, {axis}),
      describeHoldCapture({status: 'captured', holds: [{}, {}], rejectedHoldCounts: {}}, {axis})
    ]) {
      sentences.push(state.headline, state.boundary);
    }
  }

  for (const code of Object.keys({
    HOLD_TOO_SHORT: 1, RELEASE_DWELL: 1, RELEASE_TOO_SLOW: 1, RELEASE_NOT_MONOTONE: 1,
    RELEASE_REVERSED: 1, COMMANDED_AGAIN_INSIDE_RESPONSE_WINDOW: 1,
    RESPONSE_WINDOW_PAST_END_OF_LOG: 1, TOO_SOON_AFTER_PREVIOUS_STOP: 1,
    MEASUREMENT_WINDOW_EMPTY: 1, EVENT_CAP_REACHED: 1
  })) {
    sentences.push(explainStopRefusal(code));
  }
  for (const view of Object.values(TERM_VIEWS)) {
    sentences.push(view.description, view.metricLabel);
  }

  assert.ok(sentences.length > 50, 'the sweep must actually cover the module\'s copy');
  for (const sentence of sentences) {
    const fired = instructionsIn(sentence);
    assert.deepEqual(fired, [],
      `"${sentence}" reads as an instruction (${fired.join(', ')}). This is a `
      + 'measurement surface: advice belongs in the gated recommendation path, '
      + 'not here.');
  }
});

/**
 * Files allowed to tell a pilot to change a setting.
 *
 * One path, named, so that "where does advice come from?" has a checkable
 * answer. A module not on this list may opt in by carrying `ADVICE_MARKER` in
 * its own source, and either way it has to consult the gates — asserted below,
 * so an exemption cannot be taken without the interlock that earns it.
 */
const ADVICE_SURFACES = Object.freeze(['src/analysis/recommendations.mjs']);
const ADVICE_MARKER = 'RECOMMENDATION SURFACE: gated by evaluateGainRecommendationGates';
const GATE_MODULE = 'src/analysis/advisor/recommendation-gates.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every ES module under `src/`, which is everything the engine ships. */
async function engineModules(directory = path.join(projectRoot, 'src'), collected = []) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await engineModules(full, collected);
    } else if (entry.name.endsWith('.mjs')) {
      collected.push(full);
    }
  }
  return collected;
}

/**
 * The prose a module can put on a screen.
 *
 * Comments are stripped first, or the paragraph above explaining that this file
 * must never say "lower the D gain" would fail the test forbidding it, and the
 * cheap fix would be deleting the explanation. Adjacent concatenated literals
 * are then glued: our copy is hard-wrapped as `'…before the ' + 'gain.'`, and a
 * rule looking for a verb near a tunable sees neither half on its own. Finally
 * only multi-word strings are considered — a bare `"increase"` is an enum value
 * that no pilot ever reads, and the policy for those is asserted separately by
 * the capability declarations below.
 */
function screenProse(source) {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const glued = withoutComments
    .replace(/(['"`])\s*\+\s*(['"`])/g, (match, open, close) => (open === close ? '' : match));
  const literals = [];
  for (const match of glued.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)) {
    const text = match[0].slice(1, -1);
    if (text.trim().split(/\s+/).length >= 3) {
      literals.push(text);
    }
  }
  return literals;
}

test('advice reaches a pilot only through the gated recommendation path', async () => {
  // The reversal of 12 August 2026 gave this repository a place where telling a
  // pilot to change a setting is the whole point. It gave it exactly ONE such
  // place. Everywhere else in the engine stays measurement-only, because the
  // value of a recommendation panel is that the pilot can go and read the raw
  // number somewhere that is not arguing with him.
  //
  // Static rather than behavioural, deliberately: a run-time sweep can only
  // reach the branches someone remembered to list, and this repository has
  // shipped that failure five times. Every string in every engine module is
  // read, whether or not any test calls the code around it.
  const files = await engineModules();
  assert.ok(files.length > 10, `only ${files.length} engine modules found — the walk is broken`);

  const advising = [];
  const exempt = [];

  for (const file of files) {
    const relative = path.relative(projectRoot, file).replace(/\\/g, '/');
    const source = await readFile(file, 'utf8');
    const declared = ADVICE_SURFACES.includes(relative) || source.includes(ADVICE_MARKER);
    if (declared) {
      exempt.push({relative, source});
      continue;
    }

    for (const text of screenProse(source)) {
      const fired = instructionsIn(text);
      if (fired.length > 0) {
        advising.push(`${relative}\n    (${fired.join(', ')}) ${text.slice(0, 180)}`);
      }
    }
  }

  assert.deepEqual(advising, [],
    'a module that is not a declared recommendation surface tells a pilot to change '
    + `something:\n  ${advising.join('\n  ')}\n`
    + `Advice belongs in ${ADVICE_SURFACES.join(', ')}. A different module may take `
    + `the exemption by carrying the line "${ADVICE_MARKER}" in its source, and it `
    + `must then import ${GATE_MODULE}.`);

  // An exemption that has stopped being used is an exemption someone else will
  // find and reuse for something that was never gated.
  for (const {relative, source} of exempt) {
    assert.ok(/recommendation-gates\.mjs/.test(source),
      `${relative} is exempt from the instruction rules but never consults `
      + `${GATE_MODULE}. The exemption is the gates; without them it is just a `
      + 'module allowed to say anything.');
  }
});

test('the gates answer no until the evidence makes them answer yes', async () => {
  // Default-deny, checked from the outside. Every gate is an interlock, and an
  // interlock that opens when it is handed nothing is not an interlock — it is
  // a formality that fires only on inputs someone remembered to construct.
  const {evaluateGainRecommendationGates, GATE_WORDING} =
    await import('../src/analysis/advisor/recommendation-gates.mjs');

  for (const input of [
    undefined, null, {}, {axis: 'yaw'},
    {axis: 'yaw', metric: 'trackingRmsDps', mechanical: null, capture: null, evidence: null},
    // The shapes an empty analysis actually produces, rather than the shapes a
    // test author finds convenient: a capture with no events, evidence with no
    // directions, an empty sweep.
    {axis: 'roll', capture: {state: 'absent'}, evidence: {directions: {}}, events: [], sweep: []},
    {axis: 'pitch', capture: {state: 'partial'}, evidence: {directions: {}}, events: []}
  ]) {
    const verdict = evaluateGainRecommendationGates(input);
    assert.equal(verdict.mayRecommend, false,
      `the gates let a recommendation through on ${JSON.stringify(input)}`);
    assert.ok(verdict.blockedBy.length > 0, 'a refusal must name the gate that refused');
    assert.ok(verdict.sentences.length > 0,
      'a refusal must carry the sentence that says what to fly instead — silence '
      + 'on a screen reads as a broken app, which is what capture briefs exist for');
    for (const entry of verdict.sentences) {
      assert.ok(typeof entry.sentence === 'string' && entry.sentence.length > 0,
        `blocked code ${entry.code} has no sentence behind it`);
    }
  }

  // And the interlock's own copy is held to the measurement rules, because a
  // gate that blocks a recommendation and then advises in the refusal has
  // routed around itself. This is the same sweep as the static one above — the
  // gate module is not exempt — restated here against the exported wording so
  // that a sentence added to `GATE_WORDING` from another module is still read.
  for (const [code, sentence] of Object.entries(GATE_WORDING)) {
    const fired = instructionsIn(sentence);
    assert.deepEqual(fired, [],
      `GATE_WORDING.${code} advises (${fired.join(', ')}) while refusing to advise: `
      + `"${sentence}"`);
  }
});

test('the recommendation surface itself says nothing advisory without evidence', async () => {
  // The one module exempt from the static rules is exempt in its SOURCE. At run
  // time, handed nothing, it must still produce nothing advisory — otherwise
  // the exemption is a hole rather than a door, and every empty log opens the
  // app on a sentence telling someone to change his helicopter.
  //
  // Walked as a string tree rather than by field name, so this keeps holding
  // while the module's shape is still moving: wherever the advice ends up
  // living, it is a string somewhere in this object.
  const {buildRecommendations} = await import('../src/analysis/recommendations.mjs');

  for (const input of [undefined, {}, {axis: 'yaw'}, {records: null, mechanical: null}]) {
    const strings = [];
    (function walk(value) {
      if (typeof value === 'string') {
        strings.push(value);
      } else if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value && typeof value === 'object') {
        Object.values(value).forEach(walk);
      }
    })(buildRecommendations(input));

    assert.ok(strings.length > 10,
      `only ${strings.length} strings came back for ${JSON.stringify(input)} — an empty `
      + 'result would pass this test without the module having to behave');

    for (const text of strings) {
      const fired = instructionsIn(text);
      assert.deepEqual(fired, [],
        `with no evidence at all, the recommendation surface said "${text}" `
        + `(${fired.join(', ')})`);
    }
  }
});

test('nothing in the engine can write to a flight controller', async () => {
  // The one promise the reversal did not touch, and the one a pilot cannot
  // verify for himself. RotorLens reads logs. Not behind a confirmation, not
  // "with explicit per-action consent" — there is no write path at all, so
  // there is no dialog anyone can be talked through.
  //
  // Checked as a capability rather than as prose: a sentence promising not to
  // write is exactly what a build that could write would still contain.
  const transports = [
    'navigator.serial', 'navigator.usb', 'navigator.bluetooth', 'navigator.hid',
    'SerialPort', 'requestPort', 'requestDevice', 'WebUSB', 'RTCPeerConnection'
  ];

  for (const file of await engineModules()) {
    const relative = path.relative(projectRoot, file).replace(/\\/g, '/');
    const code = (await readFile(file, 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const transport of transports) {
      assert.ok(!code.includes(transport),
        `${relative} reaches for ${transport}; RotorLens has no path to a flight controller`);
    }
  }

  // The declarations the packaged output carries, from the modules that build
  // it. `directSettingWrites` is the flag a downstream consumer reads, and it
  // is false on every surface that publishes one.
  const {makePackage} = await import('../src/analysis/advisor/evidence-contract.mjs');
  const evidencePackage = makePackage({});
  assert.equal(evidencePackage.capabilities.directSettingWrites, false);
  assert.equal(evidencePackage.recommendationPolicy.directSettingWrites, false);
  assert.equal(evidencePackage.recommendationPolicy.finalTuneClaims, false,
    'a log tells you what one flight did, never that the tune is finished');

  // Every declaration of it anywhere in the engine, not just the two above.
  // `mechanical-spectrum.mjs` publishes its own copy of this flag, and a third
  // module adding one is exactly how a "no" becomes a "yes on this path".
  let declarations = 0;
  for (const file of await engineModules()) {
    const relative = path.relative(projectRoot, file).replace(/\\/g, '/');
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/directSettingWrites\s*:\s*([A-Za-z0-9_.]+)/g)) {
      declarations += 1;
      assert.equal(match[1], 'false',
        `${relative} declares directSettingWrites: ${match[1]}`);
    }
  }
  assert.ok(declarations >= 3,
    `only ${declarations} directSettingWrites declarations found; the engine had three, `
    + 'so either a surface stopped declaring it or this scan stopped reading them');

  const {evaluateGainRecommendationGates} =
    await import('../src/analysis/advisor/recommendation-gates.mjs');
  assert.match(evaluateGainRecommendationGates({}).boundary, /never writes to a flight controller/,
    'every gate verdict restates it, so a caller cannot hold a permitted verdict '
    + 'without the constraint that made it one');
});

test('P and D are pointed at different measured quantities', () => {
  // Selecting P and selecting D used to render byte-identical output.
  assert.notEqual(TERM_VIEWS.P.metric, TERM_VIEWS.D.metric);
  assert.notEqual(TERM_VIEWS.P.description, TERM_VIEWS.D.description);
  assert.equal(TERM_VIEWS.P.metric, 'trackingRmsDps');
  assert.equal(TERM_VIEWS.D.metric, 'fastRingingRmsDps');
  assert.equal(TERM_VIEWS.I.evidenceKind, 'hold');
  assert.equal(TERM_VIEWS.P.evidenceKind, 'stop');
  assert.equal(TERM_VIEWS.D.evidenceKind, 'stop');

  // The supporting lists are part of what the viewer renders under each term,
  // and they are what stops P and D looking alike a second time.
  assert.deepEqual([...TERM_VIEWS.P.supporting], ['slowOscillationRmsDps']);
  assert.deepEqual([...TERM_VIEWS.D.supporting], ['trackingRmsDps']);
  assert.deepEqual([...TERM_VIEWS.I.supporting], []);
  assert.equal(TERM_VIEWS.I.metric, null, 'I has no stop metric — that is the point of it');
});
