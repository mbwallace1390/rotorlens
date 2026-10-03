/**
 * Mechanical spectrum: numerical verification, boundary contract, safety gates.
 *
 * The spectral estimator is the part of this port that can be wrong quietly. A
 * sign flip in the butterfly, a bit-reversal that no longer reverses, a twiddle
 * that drifts — none of those throw. They report a peak at the wrong frequency,
 * which the harmonic matcher then dutifully lines up against a rotor order, and
 * the aircraft is told its main rotor is fine while the number came from
 * somewhere else entirely.
 *
 * So the FFT is checked against a naive DFT rather than against itself, over
 * thousands of randomised vectors, and the pipeline is checked by injecting
 * sinusoids of known frequency and known amplitude and asking what comes back.
 * Every numeric expectation below is either hand-derived from the DFT
 * definition, derived from the Hann kernel, or measured independently from the
 * real log inside the test. None is pasted from what the code prints.
 *
 * Two expectations worth naming because they look like magic numbers:
 *
 *   sum(w^2) for a symmetric Hann of length N is exactly 3(N-1)/8. The window
 *   divides by N-1, so it is the N-1 periodic identity 3M/8 with M = N-1.
 *
 *   A pure tone landing exactly on a bin, Hann-windowed, puts amplitude 0.5A on
 *   that bin and 0.25A on each neighbour, so power splits 0.25 : 0.0625 : 0.0625
 *   of A^2. The half-power rule admits only bins at or above half the peak, and
 *   0.0625 < 0.125, so it admits the centre bin alone: 0.25/0.375 = 2/3 of the
 *   power, and sqrt(2/3) = 0.8165 of the RMS. That is the expected on-bin band
 *   RMS ratio, and it is a property of the window and the rule, not of this
 *   implementation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import {
  analyzeMechanicalSpectrum,
  analyzeMechanicalTimeSeries,
  buildMechanicalSeries,
  chooseWindowSize,
  fftInPlace,
  hannWindow,
  MECHANICAL_CONSTANTS,
  MECHANICAL_SOURCES,
  resampleLinear,
  sessionTimeBounds,
  summarizeMechanicalVibration,
  VIBRATION_SUMMARY_SCHEMA_VERSION
} from '../src/analysis/advisor/mechanical-spectrum.mjs';
// The whole-window entry points, reached through the namespace so that a module
// missing one fails the tests that need it rather than every test in this file.
import * as spectrum from '../src/analysis/advisor/mechanical-spectrum.mjs';
import {makePackage} from '../src/analysis/advisor/evidence-contract.mjs';
import {detectPitchPumps} from '../src/analysis/advisor/deterministic-metrics.mjs';
import {
  evaluateAirframeGate,
  rotorOrderMatchDistance,
  rotorOrderMatchEstablished
} from '../src/analysis/advisor/recommendation-gates.mjs';

/**
 * The real log is never committed — it declares GPS home coordinates — so it is
 * named by environment variable rather than by a workstation-specific path.
 * A former `existsSync` guard meant that on every other machine the only
 * real-log check in this file skipped in silence and the suite went green having
 * seen nothing but synthetic fixtures. Unset is a skip; set but missing is a
 * failure, because someone who asked for the real log and did not get it must be
 * told rather than reassured.
 */
const REAL_LOG = process.env.ROTORLENS_REAL_LOG;

const MODULE_PATH = new URL(
  '../src/analysis/advisor/mechanical-spectrum.mjs',
  import.meta.url
);

const METRICS_PATH = new URL(
  '../src/analysis/advisor/deterministic-metrics.mjs',
  import.meta.url
);

/* ------------------------------------------------------------------ helpers */

/** Deterministic PRNG. Seeded per case so a failure is reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The DFT, straight from its definition. Slow on purpose: it is the oracle. */
function naiveDft(values) {
  const n = values.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    for (let t = 0; t < n; t += 1) {
      const angle = (-2 * Math.PI * k * t) / n;
      re[k] += values[t] * Math.cos(angle);
      im[k] += values[t] * Math.sin(angle);
    }
  }
  return {re, im};
}

const UNFILTERED = Object.freeze({roll: 'gyroRAW', pitch: 'gyroRAW', yaw: 'gyroRAW'});

/**
 * Builds a synthetic gyro series from a tone list.
 *
 * `jitterFraction` perturbs the timestamps, `gaps` blanks whole spans, so the
 * resampler and the window-validity gate are exercised rather than assumed.
 */
function toneSeries({
  rateHz, seconds, tones, seed = 1, jitterFraction = 0, noiseDps = 0.4, gaps = []
}) {
  const count = Math.round(rateHz * seconds);
  const intervalUs = 1e6 / rateHz;
  const next = rng(seed);
  const timeUs = new Float64Array(count);
  const roll = new Float64Array(count);

  for (let index = 0; index < count; index += 1) {
    let stamp = Math.round(index * intervalUs
      + (next() - 0.5) * intervalUs * jitterFraction);
    if (index > 0 && stamp <= timeUs[index - 1]) {
      stamp = timeUs[index - 1] + 1;
    }
    timeUs[index] = stamp;

    const seconds_ = stamp / 1e6;
    let value = 0;
    for (const tone of tones) {
      value += tone.amp * Math.sin(2 * Math.PI * tone.hz * seconds_ + (tone.phase ?? 0));
    }
    value += (next() - 0.5) * noiseDps;

    const inGap = gaps.some(gap => stamp >= gap[0] && stamp <= gap[1]);
    roll[index] = inGap ? Number.NaN : value;
  }

  return {
    timeUs,
    gyro: {roll, pitch: roll, yaw: roll},
    gyroSources: UNFILTERED,
    headspeedRpm: new Float64Array(count).fill(Number.NaN),
    tailspeedRpm: new Float64Array(count).fill(Number.NaN)
  };
}

function wholeRange(series) {
  return {
    timeRangeUs: {
      startTimeUs: series.timeUs[0],
      endTimeUs: series.timeUs[series.timeUs.length - 1]
    }
  };
}

/**
 * Headspeed relative spread over a time range, computed here from the column.
 *
 * (p95 - p05) / median, with the same admission filter and the same linear
 * quantile interpolation `rpmEvidence` uses, so this is the quantity the 0.12
 * gate is applied to and not a lookalike. Measured independently of the
 * analysis so a claim about the analysis can be checked against it.
 */
function headspeedSpread(built, startUs, endUs) {
  const values = [];
  for (let index = 0; index < built.timeUs.length; index += 1) {
    const stamp = built.timeUs[index];
    if (stamp < startUs) continue;
    if (stamp > endUs) break;
    const rpm = built.headspeedRpm[index];
    if (Number.isFinite(rpm) && rpm > 0 && rpm <= 50_000) values.push(rpm);
  }
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  values.sort((left, right) => left - right);
  const at = fraction => {
    const position = (values.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return values[lower] + (values[upper] - values[lower]) * (position - lower);
  };
  return (at(0.95) - at(0.05)) / at(0.5);
}

/** A decoded-session shape, as `decodeLog` returns one. */
function fakeSession(fieldNames, rows) {
  return {
    index: 0,
    fields: fieldNames.map((name, index) => ({name, index, sampleCount: rows.length})),
    samples: rows
  };
}

/* ------------------------------------------------- the FFT, against the DFT */

test('fftInPlace matches a naive DFT across thousands of randomised vectors', () => {
  let worstError = 0;
  let worstScale = 0;
  let cases = 0;

  for (const size of [2, 4, 8, 16, 32, 64, 128, 256]) {
    for (let trial = 0; trial < 400; trial += 1) {
      const next = rng(size * 7919 + trial);
      // Adversarial as well as random: impulses, alternating signs, ramps and
      // constants all have exactly known transforms and all are easy to get
      // wrong in a way that noise hides.
      const shape = trial % 5;
      const source = Float64Array.from({length: size}, (unused, index) => {
        if (shape === 1) return index === 0 ? 1 : 0;
        if (shape === 2) return index % 2 === 0 ? 1 : -1;
        if (shape === 3) return index;
        if (shape === 4) return 1;
        return (next() - 0.5) * 2000;
      });

      const real = Float64Array.from(source);
      const imaginary = new Float64Array(size);
      fftInPlace(real, imaginary);
      const reference = naiveDft(source);

      for (let bin = 0; bin < size; bin += 1) {
        worstError = Math.max(
          worstError,
          Math.abs(real[bin] - reference.re[bin]),
          Math.abs(imaginary[bin] - reference.im[bin])
        );
        worstScale = Math.max(worstScale, Math.abs(reference.re[bin]), Math.abs(reference.im[bin]));
      }
      cases += 1;
    }
  }

  assert.equal(cases, 3200);
  // Floating-point accumulation only. A structural error — a butterfly sign, a
  // missing bit-reversal, a twiddle rotated the wrong way — lands orders of
  // magnitude above this.
  assert.ok(
    worstError / worstScale < 1e-12,
    `FFT disagrees with the DFT: worst absolute error ${worstError} against scale ${worstScale}`
  );
});

test('fftInPlace reproduces transforms that can be written down by hand', () => {
  const near = (actual, expected, what) => assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `${what}: expected ${expected}, got ${actual}`
  );

  // A unit impulse at t=0 transforms to a flat 1 across every bin.
  {
    const real = Float64Array.from([1, 0, 0, 0]);
    const imaginary = new Float64Array(4);
    fftInPlace(real, imaginary);
    for (let bin = 0; bin < 4; bin += 1) {
      near(real[bin], 1, `impulse bin ${bin} real`);
      near(imaginary[bin], 0, `impulse bin ${bin} imaginary`);
    }
  }

  // A constant transforms to all its energy in DC.
  {
    const real = Float64Array.from([1, 1, 1, 1]);
    const imaginary = new Float64Array(4);
    fftInPlace(real, imaginary);
    near(real[0], 4, 'constant DC');
    for (let bin = 1; bin < 4; bin += 1) {
      near(real[bin], 0, `constant bin ${bin} real`);
      near(imaginary[bin], 0, `constant bin ${bin} imaginary`);
    }
  }

  // Nyquist alternation puts all its energy in bin N/2 and nowhere else. This
  // is the case a butterfly sign flip cannot survive.
  {
    const real = Float64Array.from([1, -1, 1, -1]);
    const imaginary = new Float64Array(4);
    fftInPlace(real, imaginary);
    near(real[2], 4, 'alternating Nyquist bin');
    near(real[0], 0, 'alternating DC');
    near(real[1], 0, 'alternating bin 1');
    near(real[3], 0, 'alternating bin 3');
  }

  // A single cycle of a sine over N samples: X[1] = -i·N/2, X[N-1] = +i·N/2.
  {
    const size = 8;
    const source = Float64Array.from(
      {length: size},
      (unused, index) => Math.sin((2 * Math.PI * index) / size)
    );
    const real = Float64Array.from(source);
    const imaginary = new Float64Array(size);
    fftInPlace(real, imaginary);
    near(imaginary[1], -size / 2, 'sine bin 1 imaginary');
    near(imaginary[size - 1], size / 2, 'sine conjugate bin imaginary');
    near(real[1], 0, 'sine bin 1 real');
  }
});

test('fftInPlace conserves energy (Parseval) and rejects a length it cannot transform', () => {
  const size = 512;
  const next = rng(4242);
  const source = Float64Array.from({length: size}, () => (next() - 0.5) * 50);
  const real = Float64Array.from(source);
  const imaginary = new Float64Array(size);
  fftInPlace(real, imaginary);

  let timeEnergy = 0;
  let frequencyEnergy = 0;
  for (let index = 0; index < size; index += 1) {
    timeEnergy += source[index] * source[index];
    frequencyEnergy += real[index] * real[index] + imaginary[index] * imaginary[index];
  }
  assert.ok(
    Math.abs(frequencyEnergy / size / timeEnergy - 1) < 1e-12,
    `Parseval violated: ratio ${frequencyEnergy / size / timeEnergy}`
  );

  // The source silently produced garbage for a non-power-of-two length, and its
  // only caller lives 300 lines away.
  assert.throws(
    () => fftInPlace(new Float64Array(6), new Float64Array(6)),
    error => error.code === 'FFT_LENGTH_NOT_POWER_OF_TWO'
  );
  assert.throws(
    () => fftInPlace(new Float64Array(8), new Float64Array(4)),
    error => error.code === 'FFT_LENGTH_MISMATCH'
  );
});

test('hannWindow is symmetric and its sum of squares is exactly 3(N-1)/8', () => {
  for (const size of [8, 16, 64, 512, 4096]) {
    const window = hannWindow(size);
    assert.equal(window.values[0], 0, `Hann must start at zero for N=${size}`);
    assert.ok(
      Math.abs(window.values[size - 1]) < 1e-12,
      `Hann must end at zero for N=${size}`
    );
    for (let index = 0; index < size; index += 1) {
      assert.ok(
        Math.abs(window.values[index] - window.values[size - 1 - index]) < 1e-12,
        `Hann must be symmetric for N=${size}`
      );
    }
    // Symmetric Hann divides by N-1, so this is the periodic identity 3M/8 at
    // M = N-1. Stated here so nobody "fixes" the convention to periodic without
    // this test noticing; the change would shift every PSD by 8/7 at N=8.
    assert.ok(
      Math.abs(window.sumSquares - (3 * (size - 1)) / 8) < 1e-9,
      `sum(w^2) for N=${size}: expected ${(3 * (size - 1)) / 8}, got ${window.sumSquares}`
    );
  }
});

test('chooseWindowSize stays a power of two and honours the resolution target', () => {
  for (let rateHz = 100; rateHz <= 8000; rateHz += 37) {
    const size = chooseWindowSize(rateHz, 262144);
    assert.ok((size & (size - 1)) === 0, `window size ${size} is not a power of two`);
    assert.ok(size >= 256 && size <= 4096, `window size ${size} outside its clamp`);
  }
  // The whole DSP chain rests on the invariant fftInPlace now asserts, so check
  // the two agree at the sample rate the real log actually produces.
  assert.equal(chooseWindowSize(1e6 / 993.3333333333334, 20137), 512);
});

test('resampleLinear refuses to interpolate across a gap wider than its limit', () => {
  const timeUs = Float64Array.from([0, 1000, 2000, 20000, 21000]);
  const values = Float64Array.from([0, 10, 20, 30, 40]);
  const output = resampleLinear(timeUs, values, 0, 1000, 22, 4000);

  assert.equal(output[0], 0);
  assert.equal(output[1], 10);
  assert.equal(output[2], 20);
  // 3 ms onward spans an 18 ms hole against a 4 ms limit: NaN, not a ramp. A
  // ramp here would be a fabricated signal the peak detector has to explain.
  //
  // Index 20 is the far edge of the gap and is NaN too, even though a real
  // sample sits at exactly 20 ms. The cursor advances only while the NEXT
  // timestamp is strictly below the target, so at t=20000 it still points at
  // the 2 ms sample and the 18 ms span it would have to cross fails the limit.
  // That is one lost sample per gap edge, in the conservative direction. It is
  // recorded here rather than tidied, because a port is not the place to change
  // where an estimator decides it has no data.
  for (let index = 3; index <= 20; index += 1) {
    assert.ok(Number.isNaN(output[index]), `expected a gap at index ${index}`);
  }
  assert.equal(output[21], 40, 'the first target past the gap interpolates normally');
});

/* ------------------------------------------- the pipeline, on known signals */

test('a tone landing exactly on a bin returns sqrt(2/3) of its RMS in the band', async () => {
  // 1000 Hz, window 512 -> 1.953125 Hz bins; 250 Hz is bin 128 exactly.
  const series = toneSeries({
    rateHz: 1000, seconds: 30, tones: [{hz: 250, amp: 30, phase: 0.4}], seed: 11, noiseDps: 0
  });
  const result = await analyzeMechanicalTimeSeries(series, wholeRange(series));

  assert.equal(result.quality.windowSize, 512);
  assert.ok(
    Math.abs(result.quality.frequencyResolutionHz - 1000 / 512) < 0.01,
    `resolution ${result.quality.frequencyResolutionHz}`
  );

  const axis = result.axes.find(entry => entry.axis === 'roll');
  const peak = axis.peaks[0];
  assert.equal(peak.frequencyHz, 250, 'an on-bin tone must land on its own bin');

  const expectedRatio = Math.sqrt(2 / 3);
  const actualRatio = peak.bandRmsDps / (30 / Math.SQRT2);
  assert.ok(
    Math.abs(actualRatio - expectedRatio) < 0.01,
    `on-bin band RMS ratio: expected ${expectedRatio.toFixed(4)}, got ${actualRatio.toFixed(4)}`
  );
});

test('recovered frequency is within one bin over a randomised sweep', async () => {
  let worstBinError = 0;
  let evaluated = 0;
  let withinHalfBin = 0;

  for (let trial = 0; trial < 240; trial += 1) {
    const next = rng(90000 + trial);
    const rateHz = 400 + Math.floor(next() * 1700);
    const seconds = 6 + next() * 6;
    const hz = 20 + next() * (rateHz * 0.4 - 20);
    const amp = 5 + next() * 45;
    const phase = next() * Math.PI * 2;
    const jitterFraction = next() * 0.15;

    const series = toneSeries({
      rateHz, seconds, tones: [{hz, amp, phase}], seed: trial + 1, jitterFraction
    });
    const result = await analyzeMechanicalTimeSeries(series, wholeRange(series));
    assert.notEqual(
      result.status, 'insufficient',
      `trial ${trial} produced no spectrum: ${result.reasonCodes.join(',')}`
    );

    const axis = result.axes.find(entry => entry.axis === 'roll');
    assert.ok(axis.peaks.length > 0, `trial ${trial} found no peak for a ${amp} dps tone`);

    const resolutionHz = result.quality.frequencyResolutionHz;
    const errorHz = Math.abs(axis.peaks[0].frequencyHz - hz);
    const binError = errorHz / resolutionHz;

    // The guaranteed bound is one bin, not half of one. Peaks are reported at
    // bin centres, so a tone sitting almost exactly between two bins produces
    // two near-equal local maxima and noise decides which one wins — that
    // legitimately puts the answer just over half a bin away. What cannot
    // happen is landing on a bin that is not adjacent to the tone: a butterfly
    // sign, a lost bit-reversal, or a bin-to-hertz mapping that has drifted all
    // move the answer by many bins, not by 0.03 of one.
    assert.ok(
      errorHz < resolutionHz,
      `trial ${trial}: ${hz.toFixed(3)} Hz at ${rateHz} Hz reported as `
        + `${axis.peaks[0].frequencyHz} Hz, ${binError.toFixed(3)} bins away`
    );
    if (errorHz <= resolutionHz / 2 + 0.005) {
      withinHalfBin += 1;
    }
    worstBinError = Math.max(worstBinError, binError);
    evaluated += 1;
  }

  assert.equal(evaluated, 240);
  // The straddling case is rare; almost every tone should land on its nearest
  // bin. If that stops being true, the estimator has lost accuracy long before
  // it starts failing the one-bin assertion above.
  assert.ok(
    withinHalfBin / evaluated >= 0.98,
    `only ${withinHalfBin}/${evaluated} tones landed on their nearest bin`
  );
  // A sweep that never approaches the bound is a sweep that never tested it.
  assert.ok(worstBinError > 0.4, `sweep never neared the half-bin bound: ${worstBinError}`);
});

test('band RMS tracks injected amplitude over a well-conditioned sweep', async () => {
  let minimumRatio = Infinity;
  let maximumRatio = -Infinity;

  for (let trial = 0; trial < 160; trial += 1) {
    const next = rng(31337 + trial);
    const rateHz = 500 + Math.floor(next() * 1500);
    const hz = 20 + next() * (rateHz * 0.12 - 20);
    const amp = 5 + next() * 45;
    const phase = next() * Math.PI * 2;

    // Uniform grid and well below the resampler's roll-off, so what is measured
    // is the estimator's amplitude calibration and not linear interpolation's
    // low-pass. Frequency recovery above is where the hostile grids live.
    const series = toneSeries({
      rateHz, seconds: 10, tones: [{hz, amp, phase}], seed: trial + 500
    });
    const result = await analyzeMechanicalTimeSeries(series, wholeRange(series));
    const axis = result.axes.find(entry => entry.axis === 'roll');
    assert.ok(axis.peaks.length > 0, `trial ${trial} found no peak`);

    const ratio = axis.peaks[0].bandRmsDps / (amp / Math.SQRT2);
    // Bounded by the half-power rule: sqrt(2/3) = 0.8165 when the tone sits on a
    // bin and only the centre bin clears half power, rising toward 1 when it
    // straddles two bins that both clear. Anything outside means the PSD
    // normalisation, not the scalloping, has moved.
    assert.ok(
      ratio > 0.72 && ratio < 1.02,
      `trial ${trial}: ${amp.toFixed(2)} dps at ${hz.toFixed(2)} Hz recovered as `
        + `${axis.peaks[0].bandRmsDps} dps, ratio ${ratio.toFixed(4)}`
    );
    minimumRatio = Math.min(minimumRatio, ratio);
    maximumRatio = Math.max(maximumRatio, ratio);
  }

  assert.ok(minimumRatio < 0.85, `sweep never hit the on-bin case: ${minimumRatio}`);
  assert.ok(maximumRatio > 0.9, `sweep never hit the straddling case: ${maximumRatio}`);
});

test('two tones at known frequencies are both recovered and neither is invented', async () => {
  const series = toneSeries({
    rateHz: 1000,
    seconds: 30,
    tones: [{hz: 62.5, amp: 18, phase: 0.1}, {hz: 187.5, amp: 11, phase: 2.2}],
    seed: 77,
    noiseDps: 0.5
  });
  const result = await analyzeMechanicalTimeSeries(series, wholeRange(series));
  const axis = result.axes.find(entry => entry.axis === 'roll');
  const found = axis.peaks.map(peak => peak.frequencyHz).sort((a, b) => a - b);

  // 62.5 and 187.5 Hz are bins 32 and 96 at 1000 Hz / 512.
  assert.ok(found.some(hz => Math.abs(hz - 62.5) < 1), `62.5 Hz missing from ${found}`);
  assert.ok(found.some(hz => Math.abs(hz - 187.5) < 1), `187.5 Hz missing from ${found}`);
  // The louder tone must carry the larger band RMS. Getting this backwards is
  // how a spectrum ends up naming the wrong rotor order as the strongest.
  const lower = axis.peaks.find(peak => Math.abs(peak.frequencyHz - 62.5) < 1);
  const upper = axis.peaks.find(peak => Math.abs(peak.frequencyHz - 187.5) < 1);
  assert.ok(
    lower.bandRmsDps > upper.bandRmsDps,
    `18 dps tone (${lower.bandRmsDps}) should exceed 11 dps tone (${upper.bandRmsDps})`
  );
});

test('a transient burst does not reach the attention gate; a sustained tone does', async () => {
  const rateHz = 1000;
  const seconds = 30;
  const count = rateHz * seconds;
  const build = sustained => {
    const timeUs = new Float64Array(count);
    const roll = new Float64Array(count);
    const next = rng(2024);
    for (let index = 0; index < count; index += 1) {
      timeUs[index] = index * 1000;
      const t = index / rateHz;
      // 20 dps is comfortably over the 8 dps gate, so the only thing deciding
      // the outcome is whether the energy persists across the selection.
      const active = sustained || (t > 12 && t < 14);
      roll[index] = (active ? 20 * Math.sin(2 * Math.PI * 125 * t) : 0)
        + (next() - 0.5) * 0.4;
    }
    return {
      timeUs,
      gyro: {roll, pitch: roll, yaw: roll},
      gyroSources: UNFILTERED,
      headspeedRpm: new Float64Array(count).fill(Number.NaN),
      tailspeedRpm: new Float64Array(count).fill(Number.NaN)
    };
  };

  const burst = await analyzeMechanicalTimeSeries(build(false), wholeRange(build(false)));
  assert.equal(burst.status, 'clear', 'a two-second burst must not raise attention');
  assert.equal(burst.tuningEvidenceGate.status, 'permitted');

  const sustained = await analyzeMechanicalTimeSeries(build(true), wholeRange(build(true)));
  assert.equal(sustained.status, 'attention');
  assert.equal(
    sustained.tuningEvidenceGate.status, 'blocked',
    'measured vibration must suppress gain guidance'
  );
  assert.ok(sustained.reasonCodes.includes('PERSISTENT_NARROWBAND_ENERGY'));
});

test('windows containing a gap are excluded rather than interpolated over', async () => {
  const series = toneSeries({
    rateHz: 1000,
    seconds: 30,
    tones: [{hz: 125, amp: 6}],
    seed: 5,
    gaps: [[6_000_000, 14_000_000]]
  });
  const result = await analyzeMechanicalTimeSeries(series, wholeRange(series));

  // Eight seconds missing from thirty is well past the 0.75 coverage minimum,
  // so this returns no conclusion rather than a spectrum of the surviving 22 s
  // presented as if it described the range that was asked about.
  assert.equal(result.status, 'insufficient');
  assert.equal(result.tuningEvidenceGate.status, 'blocked');
  assert.ok(
    result.reasonCodes.some(code => code.includes('COVERAGE')),
    `expected a coverage reason, got ${result.reasonCodes.join(',')}`
  );
});

/* ------------------------------------------------- the honest-label contract */

test('an unlabelled or mislabelled gyro series is rejected, never defaulted', async () => {
  const series = toneSeries({rateHz: 1000, seconds: 20, tones: [{hz: 100, amp: 4}], seed: 3});
  const range = wholeRange(series);

  await assert.rejects(
    () => analyzeMechanicalTimeSeries({...series, gyroSources: undefined}, range),
    error => error.code === 'MECHANICAL_GYRO_SOURCES_REQUIRED',
    'omitting gyroSources must throw, not silently claim gyroRAW'
  );
  await assert.rejects(
    () => analyzeMechanicalTimeSeries(
      {...series, gyroSources: {roll: 'gyroRAW', pitch: 'gyroRAW'}}, range
    ),
    error => error.code === 'MECHANICAL_GYRO_SOURCE_INVALID'
  );
  await assert.rejects(
    () => analyzeMechanicalTimeSeries(
      {...series, gyroSources: {roll: 'gyro', pitch: 'gyro', yaw: 'gyro'}}, range
    ),
    error => error.code === 'MECHANICAL_GYRO_SOURCE_INVALID'
  );
});

test('identical samples labelled filtered cannot produce a clear result', async () => {
  const series = toneSeries({rateHz: 1000, seconds: 25, tones: [{hz: 100, amp: 3}], seed: 8});
  const range = wholeRange(series);

  const unfiltered = await analyzeMechanicalTimeSeries(series, range);
  assert.equal(unfiltered.status, 'clear');
  assert.equal(unfiltered.tuningEvidenceGate.status, 'permitted');

  const filtered = await analyzeMechanicalTimeSeries({
    ...series,
    gyroSources: {
      roll: 'gyroADC-filtered', pitch: 'gyroADC-filtered', yaw: 'gyroADC-filtered'
    }
  }, range);

  // Same numbers, opposite verdict, and that is the point: filtering removed the
  // evidence before it could be measured, so quiet is not the same as sound.
  assert.equal(filtered.status, 'insufficient');
  assert.equal(filtered.tuningEvidenceGate.status, 'blocked');
  assert.ok(filtered.reasonCodes.includes('FILTERED_GYRO_SOURCE_USED'));
  assert.ok(filtered.reasonCodes.includes('UNFILTERED_GYRO_REQUIRED_FOR_CLEAR_GATE'));
  assert.deepEqual(
    filtered.axes.flatMap(axis => axis.peaks), [],
    'a filtered source must publish no peaks'
  );
});

test('the tuning gate is permitted only on a clear result', async () => {
  const clean = toneSeries({rateHz: 1000, seconds: 25, tones: [{hz: 90, amp: 2}], seed: 12});
  const loud = toneSeries({rateHz: 1000, seconds: 25, tones: [{hz: 90, amp: 40}], seed: 12});

  const clear = await analyzeMechanicalTimeSeries(clean, wholeRange(clean));
  const attention = await analyzeMechanicalTimeSeries(loud, wholeRange(loud));

  assert.equal(clear.status, 'clear');
  assert.equal(clear.tuningEvidenceGate.status, 'permitted');
  assert.deepEqual(clear.tuningEvidenceGate.reasonCodes, []);

  assert.equal(attention.status, 'attention');
  assert.equal(attention.tuningEvidenceGate.status, 'blocked');
  assert.ok(attention.tuningEvidenceGate.reasonCodes.length > 0);

  // Both of these gate RotorLens' own downstream output. Neither writes
  // anything, and the module says so.
  assert.equal(clear.capabilities.tuningRecommendations, false);
  assert.equal(clear.capabilities.settingDirectionAdvice, false);
  assert.equal(clear.capabilities.directSettingWrites, false);
  assert.equal(clear.capabilities.componentDiagnosis, false);
});

test('no finding carries an instruction, a recommendation, or composed prose', async () => {
  const cases = [
    toneSeries({rateHz: 1000, seconds: 25, tones: [{hz: 90, amp: 2}], seed: 21}),
    toneSeries({rateHz: 1000, seconds: 25, tones: [{hz: 90, amp: 45}], seed: 22}),
    toneSeries({rateHz: 1000, seconds: 25, tones: [], seed: 23, noiseDps: 1})
  ];
  const results = [];
  for (const series of cases) {
    results.push(await analyzeMechanicalTimeSeries(series, wholeRange(series)));
  }
  results.push(await analyzeMechanicalTimeSeries({
    ...cases[0],
    gyroSources: {
      roll: 'gyroADC-filtered', pitch: 'gyroADC-filtered', yaw: 'gyroADC-filtered'
    }
  }, wholeRange(cases[0])));

  const banned = /recommend|you should|adjust|increase|decrease|reduce|raise|lower|inspect|replace|enable |set the/i;
  let findingCount = 0;

  for (const result of results) {
    assert.ok(result.findings.length > 0, 'every result must say something');
    for (const finding of result.findings) {
      findingCount += 1;
      assert.ok(!('action' in finding), `finding ${finding.id} still carries an action`);
      assert.ok(!('summary' in finding), `finding ${finding.id} still carries prose`);
      assert.ok(!('title' in finding), `finding ${finding.id} still carries a title`);
      assert.ok(finding.measurement, `finding ${finding.id} carries no measurement`);

      const text = JSON.stringify(finding);
      assert.ok(
        !banned.test(text),
        `finding ${finding.id} contains instruction vocabulary: ${text}`
      );
      // Prose composed from measured numbers is what the analysis layer must
      // not be able to grow. Nothing in a finding may be a sentence.
      for (const value of Object.values(finding.measurement)) {
        if (typeof value === 'string') {
          assert.ok(
            !/\s\w+\s\w+\s\w+\s/.test(value),
            `finding ${finding.id} contains a sentence: ${value}`
          );
        }
      }
    }
  }
  assert.ok(findingCount >= 4);
});

test('the attention threshold and the analysed band travel with the result', async () => {
  const series = toneSeries({rateHz: 1000, seconds: 25, tones: [{hz: 90, amp: 40}], seed: 31});
  const result = await analyzeMechanicalTimeSeries(series, wholeRange(series));

  assert.equal(result.attentionThreshold.bandRmsDps, 8);
  assert.equal(result.attentionThreshold.basis, 'experimental-synthetic-calibration');
  assert.equal(result.attentionThreshold.officialLimit, false);

  // 0.45 * 1000 Hz, since that is below the 1000 Hz absolute cap.
  assert.deepEqual(result.analyzedBandHz, [5, 450]);
  assert.equal(result.aliasingFoldFrequencyHz, 500);
  for (const finding of result.findings) {
    assert.deepEqual(finding.measurement.analyzedBandHz, [5, 450]);
  }

  assert.equal(MECHANICAL_CONSTANTS.attentionBandRmsThresholdDps, 8);
  assert.ok(!('collectionWindowUs' in MECHANICAL_CONSTANTS));
  assert.equal(MECHANICAL_SOURCES.length, 2);
  for (const source of MECHANICAL_SOURCES) {
    assert.match(source.url, /^https:\/\/rotorflight\.org\//);
  }
});

/* ------------------------------------------- rotor correlation availability */

/**
 * A gyro series with a real rotor-speed column.
 *
 * `toneSeries` fills headspeed with NaN, which is the one case where rotor
 * correlation was never possible in the first place. Every interesting case
 * needs a headspeed that is present and either steady or not.
 */
function rotorSeries({
  rateHz = 1000, seconds = 8, toneHz, ampDps, headspeedRpm, rpmDriftRatio = 0, seed = 1
}) {
  const count = Math.round(rateHz * seconds);
  const next = rng(seed);
  const timeUs = new Float64Array(count);
  const roll = new Float64Array(count);
  const quiet = new Float64Array(count);
  const rpm = new Float64Array(count);

  for (let index = 0; index < count; index += 1) {
    timeUs[index] = Math.round((index * 1e6) / rateHz);
    const t = timeUs[index] / 1e6;
    roll[index] = ampDps * Math.sin(2 * Math.PI * toneHz * t) + (next() - 0.5) * 0.4;
    quiet[index] = (next() - 0.5) * 0.4;
    // A linear ramp across the range. rpmEvidence measures (p95 - p05) / median,
    // so a ramp of total fraction f gives a spread of about 0.9 * f.
    rpm[index] = headspeedRpm * (1 + rpmDriftRatio * ((index / (count - 1)) - 0.5));
  }

  return {
    timeUs,
    gyro: {roll, pitch: quiet, yaw: quiet},
    gyroSources: UNFILTERED,
    headspeedRpm: rpm,
    tailspeedRpm: new Float64Array(count).fill(Number.NaN)
  };
}

/**
 * The distinction this module exists to make, swept.
 *
 * `bestHarmonicMatch` returns null both when the rotor speed was trustworthy and
 * nothing lined up, and when no rotor speed was trustworthy at all. The finding
 * used to call both of those "persistent-narrowband-energy-uncorrelated", which
 * on a range where the rotor was never checked tells a pilot his main rotor is
 * ruled out and sends him to look at the tail, the frame, or the servos.
 *
 * Frequencies here are chosen so the expected answer is derivable rather than
 * observed. On-harmonic tones sit exactly on k*f0. Off-harmonic tones sit at
 * 3.5*f0, which is f0/2 from the nearest order; the matcher's tolerance is
 * max(1.5*resolution, 0.025*predicted, spread*predicted/2), and with f0 >= 25 Hz,
 * spread <= 0.05 and resolution ~1.95 Hz every one of those terms is under f0/2.
 */
test('a rotor that was never checked is not reported as a rotor that was cleared',
  async () => {
    const trials = [];
    const next = rng(90210);
    for (let index = 0; index < 1200; index += 1) {
      const f0 = 25 + next() * 35;                       // 25..60 Hz, 1500..3600 rpm
      const order = 1 + Math.floor(next() * 6);          // 1..6, all inside the band
      const onHarmonic = index % 2 === 0;
      const toneHz = onHarmonic ? order * f0 : 3.5 * f0;
      // 0 = steady, 1 = drifting past the 12% gate, 2 = no rotor column at all.
      const rotorState = index % 3;
      if (toneHz < 10 || toneHz > 440) continue;
      trials.push({f0, toneHz, onHarmonic, rotorState, seed: index + 1});
    }
    assert.ok(trials.length > 900, `expected a full sweep, got ${trials.length}`);

    let correlated = 0;
    let uncorrelated = 0;
    let unavailable = 0;

    for (const trial of trials) {
      const series = rotorSeries({
        toneHz: trial.toneHz,
        // Well over the 8 dps attention gate, so the caution finding — the one
        // that carries the correlation conclusion — is the one produced.
        ampDps: 25,
        headspeedRpm: trial.f0 * 60,
        rpmDriftRatio: trial.rotorState === 1 ? 0.6 : 0.02,
        seed: trial.seed
      });
      if (trial.rotorState === 2) {
        series.headspeedRpm = new Float64Array(series.timeUs.length).fill(Number.NaN);
      }

      const result = await analyzeMechanicalTimeSeries(series, wholeRange(series));
      assert.equal(result.status, 'attention', `25 dps must reach attention (${trial.toneHz} Hz)`);
      const finding = result.findings.find(item => item.severity === 'caution');
      assert.ok(finding, 'an attention result must carry a caution finding');

      const rotorEvaluable = trial.rotorState === 0;
      assert.equal(
        result.harmonicCorrelation.evaluated, rotorEvaluable,
        `rotorState ${trial.rotorState} should ${rotorEvaluable ? '' : 'not '}be evaluable`
      );

      if (!rotorEvaluable) {
        unavailable += 1;
        // The property under test. Not "uncorrelated", not a rotor named, and
        // no conclusion at all.
        assert.equal(
          finding.measurement.conclusion, null,
          `rotor never checked, yet conclusion ${JSON.stringify(finding.measurement.conclusion)}`
        );
        assert.equal(finding.id, 'mechanical-persistent-narrowband-peak-rotor-correlation-unavailable');
        assert.equal(finding.measurement.correlatedRotor, null);
        assert.ok(result.reasonCodes.includes('ROTOR_HARMONIC_CORRELATION_UNAVAILABLE'));
        assert.equal(finding.measurement.harmonicCorrelation.evaluated, false);
        assert.ok(
          finding.measurement.harmonicCorrelation.unavailableRotors
            .some(rotor => rotor.field === 'headspeed'),
          'the reason the rotor could not be checked must be attached'
        );
      } else if (trial.onHarmonic) {
        correlated += 1;
        assert.equal(
          finding.measurement.conclusion,
          'persistent-narrowband-energy-correlated-with-rotor-harmonic'
        );
        assert.equal(finding.measurement.correlatedRotor, 'main');
        assert.ok(result.reasonCodes.includes('MAIN_ROTOR_HARMONIC_CORRELATION'));
      } else {
        // The other half of the fix: a checked rotor that genuinely does not
        // explain the peak must still say so. Turning every null into "no
        // conclusion" would pass the test above and destroy the measurement.
        uncorrelated += 1;
        assert.equal(
          finding.measurement.conclusion, 'persistent-narrowband-energy-uncorrelated',
          `steady rotor, off-harmonic tone at ${trial.toneHz} Hz should be uncorrelated`
        );
        assert.equal(finding.measurement.correlatedRotor, null);
        assert.ok(!result.reasonCodes.includes('ROTOR_HARMONIC_CORRELATION_UNAVAILABLE'));
      }
    }

    assert.ok(correlated > 100, `expected correlated cases, got ${correlated}`);
    assert.ok(uncorrelated > 100, `expected uncorrelated cases, got ${uncorrelated}`);
    assert.ok(unavailable > 300, `expected unavailable cases, got ${unavailable}`);
  });

/**
 * "Nothing was checked" is not a reason code about the log.
 *
 * A result that stops before the rotor-speed step used to publish
 * `FIELD_MISSING` on both rotors. That is not the absence of a reading, it is
 * the specific claim that the log carries no `headspeed` column — and the
 * reference log carries one on all 134,429 samples. It is the same substitution
 * of a named negative for an absent measurement that the three-outcome
 * correlation above exists to prevent, one layer down, and it defeated it:
 * a caller shown FIELD_MISSING has been told the log is at fault.
 */
test('a result that never reached the rotor step says so, and names no missing field',
  async () => {
    // Too short to reach a spectrum, so nothing downstream of the coverage gates
    // ever ran — including everything that reads a rotor speed.
    const series = toneSeries({rateHz: 1000, seconds: 0.2, tones: [{hz: 90, amp: 20}], seed: 41});
    const short = await analyzeMechanicalTimeSeries(series, wholeRange(series));
    assert.equal(short.status, 'insufficient');
    assert.deepEqual(short.reasonCodes, ['INSUFFICIENT_TIMESTAMPED_SAMPLES']);

    assert.equal(short.harmonicCorrelation.state, 'not-evaluated');
    assert.equal(short.harmonicCorrelation.evaluated, false);
    assert.deepEqual(short.harmonicCorrelation.evaluatedRotors, []);
    assert.deepEqual(
      short.harmonicCorrelation.unavailableRotors,
      [
        {field: 'headspeed', reasonCode: 'NOT_EVALUATED'},
        {field: 'tailspeed', reasonCode: 'NOT_EVALUATED'}
      ],
      'an unread column must not be reported as a missing one'
    );

    for (const rotor of ['headspeed', 'tailspeed']) {
      assert.equal(short.rpmEvidence[rotor].state, 'not-evaluated');
      assert.equal(short.rpmEvidence[rotor].reasonCode, 'NOT_EVALUATED');
      assert.notEqual(
        short.rpmEvidence[rotor].reasonCode, 'FIELD_MISSING',
        `${rotor} was never read; FIELD_MISSING is a claim about the log`
      );
    }

    // Every path that returns without measuring a rotor speed, not just the one
    // above. Each of these is a different early return inside the module.
    const gapless = toneSeries({rateHz: 1000, seconds: 25, tones: [{hz: 90, amp: 4}], seed: 42});
    const earlyReturns = [
      // no gyro columns at all
      await analyzeMechanicalSpectrum(
        fakeSession(['time', 'debug[0]'], [[0, 1], [1000, 2]]),
        {timeRangeUs: {startTimeUs: 0, endTimeUs: 1000}}
      ),
      // over the selection cap
      await (async () => {
        const capUs = MECHANICAL_CONSTANTS.maximumSelectionDurationUs;
        const long = toneSeries({
          rateHz: 60, seconds: capUs / 1e6 + 10, tones: [{hz: 10, amp: 5}], seed: 43
        });
        return analyzeMechanicalTimeSeries(long, wholeRange(long));
      })(),
      // gyro present and unfiltered, but coverage too poor to publish
      await analyzeMechanicalTimeSeries({
        ...gapless,
        gyro: {
          roll: gapless.gyro.roll.map((value, index) => (index % 3 ? Number.NaN : value)),
          pitch: gapless.gyro.pitch,
          yaw: gapless.gyro.yaw
        }
      }, wholeRange(gapless))
    ];

    for (const result of earlyReturns) {
      assert.equal(result.status, 'insufficient');
      assert.equal(
        result.harmonicCorrelation.state, 'not-evaluated',
        `reason codes ${result.reasonCodes.join(',')} reached the rotor step unexpectedly`
      );
      for (const entry of result.harmonicCorrelation.unavailableRotors) {
        assert.equal(entry.reasonCode, 'NOT_EVALUATED');
      }
      assert.equal(result.rpmEvidence.headspeed.reasonCode, 'NOT_EVALUATED');
    }
  });

/**
 * And when the rotor speed WAS read, the reason must be the measured one.
 *
 * Six outcomes, swept adversarially, because the failure this guards is a
 * specific wrong reason rather than a missing one and a hand-picked case picks
 * the reason it expects. `FIELD_MISSING` in particular must survive meaning
 * exactly one thing — no finite cell anywhere in the column — so that a UI can
 * keep telling a pilot his log does not record head speed and be right.
 */
test('every rotor-speed reason code is the one that was measured, swept', async () => {
  const gyroSources = UNFILTERED;
  const rateHz = 500;
  const seconds = 4;
  const count = rateHz * seconds;

  /** Rotor columns whose expected verdict is derivable from how they are built. */
  const shapes = [
    {
      name: 'absent',
      expected: {reasonCode: 'FIELD_MISSING', state: 'unavailable', available: false},
      fill: () => new Float64Array(count).fill(Number.NaN)
    },
    {
      name: 'stopped-rotor-zeros',
      expected: {reasonCode: 'NO_VALID_RPM_IN_RANGE', state: 'unavailable', available: false},
      fill: () => new Float64Array(count).fill(0)
    },
    {
      name: 'one-finite-zero-rest-absent',
      expected: {reasonCode: 'NO_VALID_RPM_IN_RANGE', state: 'unavailable', available: false},
      fill: () => {
        const rpm = new Float64Array(count).fill(Number.NaN);
        rpm[Math.floor(count / 2)] = 0;
        return rpm;
      }
    },
    {
      name: 'negative',
      expected: {reasonCode: 'NO_VALID_RPM_IN_RANGE', state: 'unavailable', available: false},
      fill: next => Float64Array.from({length: count}, () => -1 - next() * 1000)
    },
    {
      name: 'above-the-admission-ceiling',
      expected: {reasonCode: 'NO_VALID_RPM_IN_RANGE', state: 'unavailable', available: false},
      fill: next => Float64Array.from({length: count}, () => 50_001 + next() * 1000)
    },
    {
      name: 'half-absent',
      expected: {reasonCode: 'INSUFFICIENT_COVERAGE', state: 'unavailable', available: true},
      fill: () => Float64Array.from(
        {length: count}, (unused, index) => (index % 2 ? Number.NaN : 1800)
      )
    },
    {
      name: 'too-slow-to-be-a-head',
      expected: {reasonCode: 'RPM_OUT_OF_RANGE', state: 'unavailable', available: true},
      fill: next => Float64Array.from({length: count}, () => 40 + next() * 10)
    },
    {
      name: 'drifting',
      expected: {reasonCode: 'RPM_UNSTABLE_IN_SELECTION', state: 'unavailable', available: true},
      fill: () => Float64Array.from(
        {length: count},
        (unused, index) => 1800 * (1 + 0.6 * (index / (count - 1) - 0.5))
      )
    },
    {
      name: 'steady',
      expected: {reasonCode: null, state: 'trustworthy', available: true},
      fill: next => Float64Array.from({length: count}, () => 1800 + (next() - 0.5) * 4)
    }
  ];

  let trials = 0;
  for (let trial = 0; trial < 360; trial += 1) {
    const next = rng(trial * 31 + 7);
    const shape = shapes[trial % shapes.length];

    const timeUs = new Float64Array(count);
    const roll = new Float64Array(count);
    for (let index = 0; index < count; index += 1) {
      timeUs[index] = Math.round((index * 1e6) / rateHz);
      roll[index] = 3 * Math.sin(2 * Math.PI * 61 * timeUs[index] / 1e6)
        + (next() - 0.5) * 0.4;
    }

    const series = {
      timeUs,
      gyro: {roll, pitch: roll, yaw: roll},
      gyroSources,
      headspeedRpm: shape.fill(next),
      tailspeedRpm: new Float64Array(count).fill(Number.NaN)
    };

    const result = await analyzeMechanicalTimeSeries(series, wholeRange(series));
    const evidence = result.rpmEvidence.headspeed;
    trials += 1;

    assert.equal(
      evidence.reasonCode, shape.expected.reasonCode,
      `${shape.name}: expected ${shape.expected.reasonCode}, got ${evidence.reasonCode}`
    );
    assert.equal(evidence.state, shape.expected.state, shape.name);
    assert.equal(evidence.available, shape.expected.available, shape.name);
    assert.equal(evidence.trustworthy, shape.expected.reasonCode === null, shape.name);

    // The rotor WAS read in every one of these, so the correlation state is
    // never "not-evaluated" — that word is reserved for having read nothing.
    assert.notEqual(result.harmonicCorrelation.state, 'not-evaluated', shape.name);
    assert.equal(
      result.harmonicCorrelation.state,
      shape.expected.reasonCode === null ? 'evaluated' : 'unavailable',
      shape.name
    );
    if (shape.expected.reasonCode !== null) {
      const entry = result.harmonicCorrelation.unavailableRotors
        .find(rotor => rotor.field === 'headspeed');
      assert.equal(entry.reasonCode, shape.expected.reasonCode, shape.name);
    }

    // A tailspeed column is absent on every Rotorflight 4.6.0 log, and absent
    // is the one thing FIELD_MISSING may mean.
    assert.equal(result.rpmEvidence.tailspeed.reasonCode, 'FIELD_MISSING', shape.name);
  }
  assert.equal(trials, 360);
});

/* --------------------------------------------- no wording from the GPL viewer */

test('the range errors state a fact in this repository\'s vocabulary', async () => {
  const series = toneSeries({rateHz: 1000, seconds: 10, tones: [{hz: 50, amp: 5}], seed: 57});
  const messages = [];
  for (const timeRangeUs of [undefined, {startTimeUs: -1, endTimeUs: 5_000_000}]) {
    await assert.rejects(
      () => analyzeMechanicalTimeSeries(series, {timeRangeUs}),
      error => {
        messages.push(error.message);
        return true;
      }
    );
  }
  assert.equal(messages.length, 2);

  for (const message of messages) {
    // "Graph In and Out markers" names a control on the GPL viewer's screen.
    // Nothing in RotorLens has one.
    assert.ok(
      !/\bgraph\b|\bin and out\b|\bin\/out\b|\bmarkers?\b/i.test(message),
      `range error carries viewer UI vocabulary: ${message}`
    );
    // And an imperative is an instruction, which this layer does not issue.
    assert.ok(
      !/^(set|select|choose|click|move|adjust|drag|pick)\b/i.test(message),
      `range error is phrased as an instruction: ${message}`
    );
  }
});

test('no message anywhere in the module is phrased as an instruction', () => {
  // The two range errors were not the only strings converted by script, so the
  // whole module is swept rather than the two that were known to be wrong.
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const literals = withoutComments.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  assert.ok(literals.length > 50, 'expected the module to contain string literals');

  for (const literal of literals) {
    const text = literal.slice(1, -1);
    assert.ok(
      !/\bgraph\b|\bin and out\b|\bin\/out\b|\bmarkers?\b|\bflightlog\b/i.test(text),
      `module string carries viewer vocabulary: ${literal}`
    );
    assert.ok(
      !/^(set|select|choose|click|move|adjust|drag|pick|enable|disable|check)\s+\w/i.test(text),
      `module string is phrased as an instruction: ${literal}`
    );
  }
});

/* --------------------------------------------------- the session boundary */

test('buildMechanicalSeries walks the gyro ladder and labels what it found', () => {
  const rows = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1000, 1, 2, 3, 4, 5, 6, 7, 8, 9]];

  const raw = buildMechanicalSeries(fakeSession([
    'time', 'gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]',
    'gyroADC[0]', 'gyroADC[1]', 'gyroADC[2]', 'headspeed', 'debug[0]', 'debug[1]'
  ], rows));
  assert.deepEqual(raw.gyroSources, {roll: 'gyroRAW', pitch: 'gyroRAW', yaw: 'gyroRAW'});
  assert.equal(raw.resolved['gyro.roll'], 'gyroRAW[0]');
  assert.equal(raw.usable, true);
  assert.deepEqual(raw.missing, ['tailspeed']);

  const unfilt = buildMechanicalSeries(fakeSession([
    'time', 'gyroUnfilt[0]', 'gyroUnfilt[1]', 'gyroUnfilt[2]',
    'gyroADC[0]', 'gyroADC[1]', 'gyroADC[2]', 'headspeed', 'x', 'y'
  ], rows));
  assert.deepEqual(unfilt.gyroSources, {roll: 'gyroUnfilt', pitch: 'gyroUnfilt', yaw: 'gyroUnfilt'});

  const filtered = buildMechanicalSeries(fakeSession([
    'time', 'gyroADC[0]', 'gyroADC[1]', 'gyroADC[2]', 'headspeed', 'a', 'b', 'c', 'd', 'e'
  ], rows));
  assert.deepEqual(filtered.gyroSources, {
    roll: 'gyroADC-filtered', pitch: 'gyroADC-filtered', yaw: 'gyroADC-filtered'
  });
  assert.equal(filtered.usable, true);

  // debug[n] is not a gyro. `records.mjs` FIELD_MAP.raw would resolve to it on a
  // 4.6.0 log; this module must not, because a debug channel FFT'd and labelled
  // unfiltered gyro is a confident spectrum of whatever the debug mode was.
  const debugOnly = buildMechanicalSeries(fakeSession([
    'time', 'debug[0]', 'debug[1]', 'debug[2]', 'headspeed', 'a', 'b', 'c', 'd', 'e'
  ], rows));
  assert.deepEqual(debugOnly.gyroSources, {roll: 'missing', pitch: 'missing', yaw: 'missing'});
  assert.equal(debugOnly.usable, false);
  assert.ok(debugOnly.missing.includes('gyro.roll'));

  // Headspeed has no alias. `rpm[0]` is a motor speed on most machines and the
  // gear ratio would move the reported rotor fundamental by an order.
  const noHeadspeed = buildMechanicalSeries(fakeSession([
    'time', 'gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]', 'rpm[0]', 'a', 'b', 'c', 'd', 'e'
  ], rows));
  assert.ok(noHeadspeed.missing.includes('headspeed'));
  assert.ok(Number.isNaN(noHeadspeed.headspeedRpm[0]));
});

test('buildMechanicalSeries turns non-finite cells into gaps, never zeros', () => {
  const rows = [[0, 1], [1000, Number.NaN], [2000, null], [3000, 4]];
  const built = buildMechanicalSeries(fakeSession(['time', 'gyroRAW[0]'], rows));
  assert.equal(built.gyro.roll[0], 1);
  assert.ok(Number.isNaN(built.gyro.roll[1]));
  assert.ok(Number.isNaN(built.gyro.roll[2]), 'null must become a gap, not 0');
  assert.equal(built.gyro.roll[3], 4);
});

test('sessionTimeBounds reads the ends of the time column', () => {
  const bounds = sessionTimeBounds(fakeSession(['time', 'gyroRAW[0]'], [
    [80_983_942, 1], [80_984_935, 2], [214_505_747, 3]
  ]));
  assert.deepEqual(bounds, {
    startTimeUs: 80_983_942, endTimeUs: 214_505_747, durationUs: 133_521_805
  });
  assert.deepEqual(
    sessionTimeBounds(fakeSession(['gyroRAW[0]'], [[1]])),
    {startTimeUs: null, endTimeUs: null, durationUs: null}
  );
  assert.deepEqual(
    sessionTimeBounds({fields: [], samples: []}),
    {startTimeUs: null, endTimeUs: null, durationUs: null}
  );
});

test('a session without gyro returns insufficient evidence rather than throwing', async () => {
  const session = fakeSession(['time', 'debug[0]'], [[0, 1], [1000, 2]]);
  const result = await analyzeMechanicalSpectrum(session, {
    timeRangeUs: {startTimeUs: 0, endTimeUs: 1000}
  });
  assert.equal(result.status, 'insufficient');
  assert.equal(result.tuningEvidenceGate.status, 'blocked');
  assert.ok(result.reasonCodes.includes('GYRO_FIELDS_MISSING'));
  assert.deepEqual(result.quality.gyroSources, ['missing', 'missing', 'missing']);
});

/**
 * The selection cap, and what it is allowed to claim.
 *
 * It was 120 s, carried from the source, and the derivation written to justify
 * keeping it said 120 s was where stationarity ends on the reference log. That
 * did not reproduce: the longest range inside the 12% headspeed gate on that log
 * is 120.781805 s, it is bounded by the last sample rather than by the gate, and
 * the old cap rejected it by 0.78 s. See the real-log case below, which measures
 * that from the log rather than restating it, and the constant's own comment.
 *
 * What the cap is now is a span ceiling with a basis that reproduces, and this
 * test holds it to exactly that and no more.
 */
test('the selection cap is a span ceiling with a basis that reproduces', async () => {
  const capUs = MECHANICAL_CONSTANTS.maximumSelectionDurationUs;

  assert.equal(
    MECHANICAL_CONSTANTS.maximumSelectionDurationBasis,
    'input-sample-cap-at-nominal-1khz-log-rate'
  );
  // The basis is checkable arithmetic, not a story: the input-sample cap
  // expressed as a duration at Rotorflight's nominal 1 kHz logging rate.
  assert.equal(capUs, MECHANICAL_CONSTANTS.maximumInputSamples * 1000);

  // Whatever else it is, it must not be a number that rejects the only real log
  // this project owns, whose longest stationary range is 120.781805 s.
  assert.ok(
    capUs > 120_781_805,
    `the cap rejects the reference log's own longest stationary range: ${capUs} us`
  );

  const overSeconds = capUs / 1e6 + 10;
  const long = toneSeries({
    rateHz: 60, seconds: overSeconds, tones: [{hz: 10, amp: 5}], seed: 45
  });
  const capped = await analyzeMechanicalTimeSeries(long, wholeRange(long));
  assert.equal(capped.status, 'insufficient');
  assert.ok(capped.reasonCodes.includes('SELECTION_DURATION_LIMIT_EXCEEDED'));
  assert.equal(capped.quality.maximumSelectionDurationUs, capUs);
  assert.equal(
    capped.quality.maximumSelectionDurationBasis,
    'input-sample-cap-at-nominal-1khz-log-rate'
  );

  // And a range that fits is analysed rather than refused, so the cap is a
  // ceiling and not a target.
  const under = toneSeries({
    rateHz: 60, seconds: capUs / 1e6, tones: [{hz: 10, amp: 5}], seed: 46
  });
  const admitted = await analyzeMechanicalTimeSeries(under, wholeRange(under));
  assert.ok(
    !admitted.reasonCodes.includes('SELECTION_DURATION_LIMIT_EXCEEDED'),
    `a range of exactly the cap must be admitted, got ${admitted.reasonCodes.join(',')}`
  );
});

test('the selection cap is not a stationarity gate and does not pretend to be', async () => {
  // 150 s: over the cap this module used to carry, under the one it carries now.
  // A rotor drifting 60% across it is nowhere near the 12% correlation gate, and
  // the cap admitting the range must not be mistaken for the range being usable
  // for rotor correlation. Those are separate measurements and this pins that.
  const drifting = rotorSeries({
    rateHz: 100, seconds: 150, toneHz: 30, ampDps: 25,
    headspeedRpm: 900, rpmDriftRatio: 0.6, seed: 77
  });
  assert.ok(
    150e6 > 120e6 && 150e6 < MECHANICAL_CONSTANTS.maximumSelectionDurationUs,
    'this case must straddle the old cap and sit under the new one'
  );

  const result = await analyzeMechanicalTimeSeries(drifting, wholeRange(drifting));
  assert.ok(!result.reasonCodes.includes('SELECTION_DURATION_LIMIT_EXCEEDED'));

  // Admitted by the cap, and still explicitly not correlatable.
  assert.equal(result.harmonicCorrelation.state, 'unavailable');
  assert.equal(result.harmonicCorrelation.evaluated, false);
  assert.equal(
    result.rpmEvidence.headspeed.reasonCode, 'RPM_UNSTABLE_IN_SELECTION',
    'stationarity is measured per range, and reported per range'
  );
  assert.ok(result.rpmEvidence.headspeed.relativeSpread > 0.12);
});

/* ------------------------------------------- a whole flight, longer than one cap */

/**
 * A long three-axis flight at a real logging rate.
 *
 * Audit of 2 October 2026: the analyser caps one analysis at 262,144 samples
 * and 262.144 s, and the app clamped by DURATION alone. A Rotorflight log at its
 * own 993 us interval (1007 Hz) over 4m20s, or a 2 kHz log over 2m11s, came
 * back SELECTION_SAMPLE_LIMIT_EXCEEDED — "not measured" — and every gain on an
 * ordinary pack was blocked. Long flights are now measured whole, in stretches.
 *
 * `tones` carry their own `fromS`/`toS`, and `thin` drops samples from `fromS`
 * on (keeping every `every`-th), which is what a logger that cannot keep up
 * produces.
 */
function longFlight({rateHz, seconds, tones = [], thin = null, headspeedRpm = 1800, seed = 11}) {
  const next = rng(seed);
  const intervalUs = 1e6 / rateHz;
  const total = Math.round(rateHz * seconds);
  const timeUs = [];
  const roll = [];
  const pitch = [];
  const yaw = [];
  const head = [];
  for (let index = 0; index < total; index += 1) {
    const stamp = Math.round(index * intervalUs);
    const at = stamp / 1e6;
    if (thin && at >= thin.fromS && index % thin.every !== 0) {
      continue;
    }
    let tone = 0;
    for (const entry of tones) {
      if (at >= (entry.fromS ?? 0) && at <= (entry.toS ?? Infinity)) {
        tone += entry.amp * Math.sin(2 * Math.PI * entry.hz * at);
      }
    }
    timeUs.push(stamp);
    roll.push(tone + (next() - 0.5));
    pitch.push(tone * 0.5 + (next() - 0.5));
    yaw.push(next() - 0.5);
    head.push(headspeedRpm + (next() - 0.5) * 8);
  }
  return {
    timeUs: Float64Array.from(timeUs),
    gyro: {roll: Float64Array.from(roll), pitch: Float64Array.from(pitch), yaw: Float64Array.from(yaw)},
    gyroSources: UNFILTERED,
    headspeedRpm: Float64Array.from(head),
    tailspeedRpm: new Float64Array(timeUs.length).fill(Number.NaN)
  };
}

test('a flight longer than one analysis accepts is measured whole, not refused', async () => {
  const caps = MECHANICAL_CONSTANTS;
  for (const [rateHz, seconds] of [[1007, 300], [2000, 150]]) {
    const series = longFlight({rateHz, seconds});
    const whole = wholeRange(series);
    const label = `${rateHz} Hz for ${seconds} s (${series.timeUs.length} samples)`;
    assert.ok(series.timeUs.length > caps.maximumInputSamples,
      `${label}: the fixture must be over the per-analysis sample cap, or this proves nothing`);

    // The panel's entry point.
    const view = await summarizeMechanicalVibration(series, whole);
    assert.notEqual(view.status, 'insufficient',
      `${label}: the vibration panel refused a whole flight: ${view.reasonCodes}`);
    assert.ok(!view.reasonCodes.some(code => /LIMIT_EXCEEDED/.test(code)), `${label}: ${view.reasonCodes}`);
    assert.equal(view.range.startTimeUs, whole.timeRangeUs.startTimeUs);
    assert.equal(view.range.endTimeUs, whole.timeRangeUs.endTimeUs,
      `${label}: the measurement must cover the whole window, not its first 262 s`);

    // The recommendation path's entry point: a real verdict on the whole window.
    const result = await spectrum.analyzeMechanicalWindow(series, whole);
    assert.equal(result.status, 'clear', `${label}: ${result.reasonCodes}`);
    assert.equal(result.tuningEvidenceGate.status, 'permitted');
    assert.equal(result.harmonicCorrelation.state, 'evaluated');
    assert.equal(result.range.startTimeUs, whole.timeRangeUs.startTimeUs);
    assert.equal(result.range.endTimeUs, whole.timeRangeUs.endTimeUs);

    // The fewest stretches that fit, each inside BOTH caps, contiguous, covering it all.
    assert.equal(result.chunks.length, 2, `${label}: ${result.chunks.length} stretches`);
    for (const chunk of result.chunks) {
      assert.ok(chunk.sampleCount <= caps.maximumInputSamples, `${label}: ${chunk.sampleCount}`);
      assert.ok(chunk.endTimeUs - chunk.startTimeUs <= caps.maximumSelectionDurationUs);
      assert.equal(chunk.status, 'clear', `${label}: ${chunk.reasonCodes}`);
    }
    assert.equal(result.chunks[0].startTimeUs, whole.timeRangeUs.startTimeUs);
    assert.equal(result.chunks.at(-1).endTimeUs, whole.timeRangeUs.endTimeUs);
    for (let index = 1; index < result.chunks.length; index += 1) {
      assert.equal(result.chunks[index].startTimeUs, result.chunks[index - 1].endTimeUs,
        `${label}: stretch ${index} does not start where the one before it ended`);
    }
    // Shared boundary samples are counted once.
    assert.equal(result.range.sampleCount, series.timeUs.length);

    // And the airframe gate now covers a stop five seconds before the end.
    const gate = evaluateAirframeGate(result, {eventTimesUs: [whole.timeRangeUs.endTimeUs - 5e6]});
    assert.ok(!gate.codes.includes('MECHANICAL_RANGE_EXCLUDES_EVENTS'), `${label}: ${gate.codes}`);
    assert.equal(gate.status, 'permitted', `${label}: ${gate.codes}`);
  }
});

test('vibration found only in the LAST stretch of a long flight still blocks it', async () => {
  // 71 Hz is no order of a 1800 rpm head, and 26 deg/s is well over the
  // threshold: unexplained vibration, present only after 160 s.
  const series = longFlight({
    rateHz: 1007, seconds: 300, tones: [{hz: 71, amp: 26, fromS: 160}], seed: 12
  });
  const result = await spectrum.analyzeMechanicalWindow(series, wholeRange(series));
  assert.deepEqual(result.chunks.map(chunk => chunk.status), ['clear', 'attention'],
    'the fixture must put the vibration in the last stretch only');
  assert.equal(result.status, 'attention', 'attention anywhere is attention for the flight');
  assert.equal(result.tuningEvidenceGate.status, 'blocked');
  const gate = evaluateAirframeGate(result);
  assert.equal(gate.status, 'blocked');
  assert.ok(gate.codes.includes('MECHANICAL_EVIDENCE_GATE_BLOCKED'), `${gate.codes}`);

  // The peak is kept, with the stretch it was measured in.
  const roll = result.axes.find(axis => axis.axis === 'roll');
  const peak = roll.peaks.find(entry => Math.abs(entry.frequencyHz - 71) < 2 && entry.attentionEligible);
  assert.ok(peak, `the 71 Hz peak was dropped: ${JSON.stringify(roll.peaks.map(p => p.frequencyHz))}`);
  assert.deepEqual(peak.chunkRangeUs,
    [result.chunks[1].startTimeUs, result.chunks[1].endTimeUs]);

  const view = await summarizeMechanicalVibration(series, wholeRange(series));
  assert.equal(view.status, 'attention');
  assert.ok(view.axes.find(axis => axis.axis === 'roll').peaks
    .some(entry => entry.aboveAttentionThreshold && entry.chunkRangeUs));
});

test('a logging gap only in the LAST stretch still makes the flight unmeasured', async () => {
  // From 250 s the logger keeps one sample in six: a ~6 ms interval against a
  // ~1 ms median, which no spectrum may be transformed across.
  const series = longFlight({rateHz: 1007, seconds: 300, thin: {fromS: 250, every: 6}, seed: 13});
  const result = await spectrum.analyzeMechanicalWindow(series, wholeRange(series));
  assert.equal(result.chunks.length, 2);
  assert.equal(result.chunks[0].status, 'clear', `${result.chunks[0].reasonCodes}`);
  assert.equal(result.chunks[1].status, 'insufficient', `${result.chunks[1].reasonCodes}`);
  assert.equal(result.status, 'insufficient', 'a stretch that could not be measured is not clear');
  assert.ok(result.reasonCodes.includes('TIMING_GAPS_EXCESSIVE'), `${result.reasonCodes}`);
  assert.equal(result.tuningEvidenceGate.status, 'blocked');
  assert.notEqual(result.harmonicCorrelation.state, 'evaluated',
    'the rotor was not compared over the stretch that was not measured');
  const gate = evaluateAirframeGate(result);
  assert.equal(gate.status, 'blocked');
  assert.ok(gate.codes.includes('MECHANICAL_EVIDENCE_NOT_MEASURED'), `${gate.codes}`);
});

test('a window one analysis accepts is analysed exactly as before', async () => {
  // Single stretch: byte-for-byte the result the single analysis returns, and
  // no stretch bookkeeping added to it or to the summary.
  for (const [rateHz, seconds] of [[1000, 20], [1007, 260]]) {
    const series = longFlight({
      rateHz, seconds, tones: [{hz: 30, amp: 14}, {hz: 83, amp: 6}], seed: 14
    });
    const whole = wholeRange(series);
    const direct = await analyzeMechanicalTimeSeries(series, whole);
    const windowed = await spectrum.analyzeMechanicalWindow(series, whole);
    assert.notEqual(direct.status, 'insufficient', `${rateHz}/${seconds}: ${direct.reasonCodes}`);
    assert.deepEqual(windowed, direct, `${rateHz} Hz for ${seconds} s`);
    assert.equal(windowed.chunks, undefined);

    const view = await summarizeMechanicalVibration(series, whole);
    assert.ok(!('chunks' in view));
    assert.ok(view.axes.every(axis => axis.peaks.every(peak => !('chunkRangeUs' in peak))));
  }
});

test('stretches combine conservatively: worst measurement, weakest correlation', async () => {
  // 40 s: a steady head and a quiet airframe for 20 s, then a head speed that
  // ramps 30% and a noisier airframe. Each half is analysed on its own and the
  // two are combined; every field must take the worse of the two.
  const rateHz = 1000;
  const count = rateHz * 40;
  const next = rng(15);
  const timeUs = new Float64Array(count);
  const roll = new Float64Array(count);
  const head = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    timeUs[index] = index * 1000;
    const late = index >= count / 2;
    roll[index] = (next() - 0.5) * (late ? 6 : 1) + 3 * Math.sin(2 * Math.PI * 47 * index / rateHz);
    head[index] = late ? 1800 * (1 + 0.3 * (index - count / 2) / (count / 2)) : 1800;
  }
  const series = {
    timeUs, gyro: {roll, pitch: roll, yaw: roll}, gyroSources: UNFILTERED,
    headspeedRpm: head, tailspeedRpm: new Float64Array(count).fill(Number.NaN)
  };
  const early = await analyzeMechanicalTimeSeries(series,
    {timeRangeUs: {startTimeUs: 0, endTimeUs: 20_000_000}});
  const late = await analyzeMechanicalTimeSeries(series,
    {timeRangeUs: {startTimeUs: 20_000_000, endTimeUs: timeUs[count - 1]}});
  assert.equal(early.harmonicCorrelation.state, 'evaluated');
  assert.equal(late.harmonicCorrelation.state, 'unavailable');

  const combined = spectrum.combineMechanicalResults(
    [early, late], {startTimeUs: 0, endTimeUs: timeUs[count - 1]});
  assert.equal(combined.range.startTimeUs, 0);
  assert.equal(combined.range.endTimeUs, timeUs[count - 1]);
  assert.equal(combined.harmonicCorrelation.evaluated, false,
    'correlation is evaluated for the flight only if it was for every stretch');
  assert.equal(combined.rpmEvidence.headspeed.reasonCode, 'RPM_UNSTABLE_IN_SELECTION');
  // Never steadier than either stretch, and never steadier than the window
  // itself, measured from the column. This used to pin the spread EQUAL to the
  // larger stretch's, which is the understatement: two steady stretches at two
  // different head speeds each have a tiny spread, and the window does not.
  assert.ok(combined.rpmEvidence.headspeed.relativeSpread >= Math.max(
    early.rpmEvidence.headspeed.relativeSpread, late.rpmEvidence.headspeed.relativeSpread));
  assert.ok(combined.rpmEvidence.headspeed.relativeSpread
    >= headspeedSpread(series, 0, timeUs[count - 1]) - 1e-12);
  for (const axis of combined.axes) {
    const parts = [early, late].map(result => result.axes.find(entry => entry.axis === axis.axis));
    assert.equal(axis.medianNoisePsdDps2PerHz,
      Math.max(...parts.map(part => part.medianNoisePsdDps2PerHz)), 'the worse noise floor');
    assert.equal(axis.broadbandRmsDps, Math.max(...parts.map(part => part.broadbandRmsDps)));
    assert.equal(axis.windowCoverageRatio, Math.min(...parts.map(part => part.windowCoverageRatio)));
  }
  // Status precedence: attention over insufficient over clear.
  const statusOf = (...statuses) => spectrum.combineMechanicalResults(
    statuses.map(status => (status === 'attention' ? {...early, status: 'attention',
      tuningEvidenceGate: {status: 'blocked', reasonCodes: ['PERSISTENT_NARROWBAND_ENERGY']}}
      : status === 'insufficient' ? {...early, status: 'insufficient',
        tuningEvidenceGate: {status: 'blocked', reasonCodes: ['TIMING_GAPS_EXCESSIVE']}}
        : early)),
    {startTimeUs: 0, endTimeUs: timeUs[count - 1]});
  assert.equal(statusOf('clear', 'clear').status, 'clear');
  assert.equal(statusOf('clear', 'clear').tuningEvidenceGate.status, 'permitted');
  assert.equal(statusOf('clear', 'insufficient').status, 'insufficient');
  assert.equal(statusOf('insufficient', 'attention').status, 'attention');
  assert.equal(statusOf('attention', 'clear').tuningEvidenceGate.status, 'blocked');
  assert.equal(statusOf('clear', 'insufficient').tuningEvidenceGate.status, 'blocked');
});

test('a head speed combined from stretches is none that no stretch had, and never steadier '
  + 'than the window', async () => {
  // Review of 2 October 2026: one stretch at 1500 rpm and the next at 1800 came
  // back as a "trustworthy" 1650 rpm with a spread of 0.0024 — a head speed the
  // rotor never turned at, and a steadiness the window never had. Swept over
  // random stretch counts, head speeds, and jitter.
  const random = rng(31);
  for (let trial = 0; trial < 24; trial += 1) {
    const stretches = 2 + (trial % 2);
    const perStretchS = 6;
    const rateHz = 1000;
    const count = rateHz * perStretchS * stretches;
    const sameSpeed = trial % 4 === 0;
    const base = 1400 + random() * 800;
    const medians = Array.from({length: stretches}, () => (sameSpeed ? base : 1400 + random() * 800));
    const jitters = Array.from({length: stretches}, () => 2 + random() * 40);
    const timeUs = new Float64Array(count);
    const roll = new Float64Array(count);
    const head = new Float64Array(count);
    for (let index = 0; index < count; index += 1) {
      timeUs[index] = index * 1000;
      const stretch = Math.min(stretches - 1, Math.floor(index / (rateHz * perStretchS)));
      roll[index] = 3 * Math.sin(2 * Math.PI * 47 * index / rateHz) + (random() - 0.5);
      head[index] = medians[stretch] + (random() - 0.5) * 2 * jitters[stretch];
    }
    const series = {
      timeUs, gyro: {roll, pitch: roll, yaw: roll}, gyroSources: UNFILTERED,
      headspeedRpm: head, tailspeedRpm: new Float64Array(count).fill(Number.NaN)
    };
    const results = [];
    for (let stretch = 0; stretch < stretches; stretch += 1) {
      const startTimeUs = stretch * perStretchS * 1e6;
      const endTimeUs = stretch === stretches - 1
        ? timeUs[count - 1] : (stretch + 1) * perStretchS * 1e6;
      results.push(await analyzeMechanicalTimeSeries(series, {timeRangeUs: {startTimeUs, endTimeUs}}));
    }
    const whole = {startTimeUs: 0, endTimeUs: timeUs[count - 1]};
    const combined = spectrum.combineMechanicalResults(results, whole);
    const headspeed = combined.rpmEvidence.headspeed;
    const label = `trial ${trial}: medians ${medians.map(value => Math.round(value))}`;
    const stretchMedians = results.map(result => result.rpmEvidence.headspeed.medianRpm);
    assert.ok(stretchMedians.every(Number.isFinite), label);

    // Never steadier than the window, measured independently from the column.
    const windowSpread = headspeedSpread(series, whole.startTimeUs, whole.endTimeUs);
    assert.ok(headspeed.relativeSpread >= windowSpread - 1e-9,
      `${label}: published spread ${headspeed.relativeSpread} understates the window's ${windowSpread}`);
    for (const result of results) {
      assert.ok(headspeed.relativeSpread >= result.rpmEvidence.headspeed.relativeSpread - 1e-12,
        `${label}: steadier than one of its own stretches`);
    }
    // No single head speed was measured across the window, so none is published:
    // the stretches' own medians are, beside their range.
    assert.equal(headspeed.medianRpm, null, `${label}: ${headspeed.medianRpm}`);
    assert.equal(headspeed.fundamentalHz, null, label);
    assert.deepEqual(headspeed.stretchMedianRpm, stretchMedians, label);
    assert.deepEqual(headspeed.medianRpmRange,
      [Math.min(...stretchMedians), Math.max(...stretchMedians)], label);
    // Each stretch was still compared against its OWN head speed, and was steady
    // enough to be: the matching per stretch is unchanged by any of this.
    assert.ok(results.every(result => result.harmonicCorrelation.state === 'evaluated'), label);
    assert.equal(combined.harmonicCorrelation.state, 'evaluated', label);

    // And the panel says the same.
    const view = spectrum.summarizeMechanicalResult(combined).rotorCorrelation.headspeed;
    assert.equal(view.medianRpm, null, label);
    assert.equal(view.fundamentalHz, null, label);
    assert.deepEqual(view.stretchMedianRpm, stretchMedians, label);
    assert.equal(view.relativeSpread, headspeed.relativeSpread, label);
  }
});

/** MAX_PEAKS_PER_AXIS in mechanical-spectrum.mjs, which caps sub-threshold peaks only. */
const SUB_THRESHOLD_PEAK_CAP = 5;

test('an attention-level tone crowded by small whole-flight tones is never read as clear',
  async () => {
    // Review of 2 October 2026: five peaks per axis were kept on persistence and
    // prominence before attention was judged, so enough small, steady tones
    // pushed an attention-level tone off the list and the flight read clear.
    const random = rng(44);
    const small = [60, 90, 120, 150, 180, 210, 240, 255, 285, 315, 345];
    const uncounted = [];
    for (let crowd = 0; crowd <= small.length; crowd += 1) {
      for (const loudHz of [30, 75]) {
        const tones = [{hz: loudHz, amp: 20}];
        for (let index = 0; index < crowd; index += 1) {
          tones.push({hz: small[index], amp: 3 + random() * 3, phase: random() * 6});
        }
        const series = toneSeries({rateHz: 1000, seconds: 20, tones, seed: 900 + crowd});
        series.headspeedRpm = new Float64Array(series.timeUs.length).fill(1800);
        const result = await spectrum.analyzeMechanicalWindow(series, wholeRange(series));
        const label = `${loudHz} Hz at 20 deg/s among ${crowd} small tones`;
        assert.equal(result.status, 'attention', `${label}: read ${result.status}`);
        assert.equal(result.tuningEvidenceGate.status, 'blocked', label);
        for (const axis of result.axes) {
          assert.ok(axis.peaks.some(peak => peak.attentionEligible === true
            && Math.abs(peak.frequencyHz - loudHz) <= 3), `${label}: ${axis.axis} lost it`);
          // Small tones keep a cap of their own. UPDATED in round 3: this line
          // used to pin "small tones fill only the room the cap leaves", which was
          // the bug — every attention-level peak listed cost a small tone the old
          // list held, and a small tone is the only thing the tone-coincidence
          // rule can see a rotor order by. Every small tone here is steady and
          // well clear of its neighbours, so the list holds each of them, up to
          // the cap, however many attention-level peaks are listed beside them.
          const smallListed = axis.peaks.filter(peak => peak.attentionEligible !== true);
          assert.equal(smallListed.length, Math.min(SUB_THRESHOLD_PEAK_CAP, crowd),
            `${label}: ${axis.axis} lists ${smallListed.length} small tones `
            + `${JSON.stringify(smallListed.map(peak => peak.frequencyHz))}`);
          if (axis.attentionEligibleUnlistedCount !== 0 || !(axis.attentionEligibleCandidateCount >= 1)) {
            uncounted.push(`${label}: ${axis.axis} ${axis.attentionEligibleUnlistedCount}`
              + `/${axis.attentionEligibleCandidateCount}`);
          }
        }
      }
    }
    // Every axis says of its own list that it is complete, as a measured count.
    assert.deepEqual(uncounted, []);
  });

test('a tone\'s size while present is measured window by window, and its flight average never '
  + 'stands in for it', async () => {
    // Round-2 review: `bandRmsDps` is the Welch average over every window, while
    // attention is judged window by window. A once-per-rev at four times the
    // level, present for a third of the flight, averages under three times it.
    // `attentionWindowBandRmsDps` is the RMS over the windows in which the tone
    // reached the attention level: its size while present.
    const rateHz = 1000;
    const seconds = 60;
    const build = ({hz, amp, onS, periodS, seed}) => {
      const next = rng(seed);
      const count = rateHz * seconds;
      const timeUs = new Float64Array(count);
      const roll = new Float64Array(count);
      const quiet = new Float64Array(count);
      for (let index = 0; index < count; index += 1) {
        const at = index / rateHz;
        timeUs[index] = Math.round(at * 1e6);
        const on = (at % periodS) < onS;
        roll[index] = (on ? amp * Math.sin(2 * Math.PI * hz * at) : 0) + (next() - 0.5);
        quiet[index] = next() - 0.5;
      }
      return {timeUs, gyro: {roll, pitch: quiet, yaw: quiet}, gyroSources: UNFILTERED,
        headspeedRpm: new Float64Array(count).fill(1800),
        tailspeedRpm: new Float64Array(count).fill(Number.NaN)};
    };
    const peakAt = async (options, hz) => {
      const series = build(options);
      const result = await spectrum.analyzeMechanicalWindow(series, wholeRange(series));
      return result.axes.find(axis => axis.axis === 'roll').peaks
        .find(peak => Math.abs(peak.frequencyHz - hz) <= 3) ?? null;
    };
    let intermittent = 0;
    for (const hz of [30, 75]) {
      for (const amp of [20, 42]) {
        // The same tone present throughout: what it measures while present.
        const steady = await peakAt({hz, amp, onS: 1, periodS: 1, seed: 3 + amp}, hz);
        assert.ok(steady?.attentionEligible, `${hz} Hz at ${amp}: steady reference`);
        assert.ok(Math.abs(steady.attentionWindowBandRmsDps - steady.bandRmsDps) <= 0.002,
          `${hz} Hz at ${amp}: a tone above the level throughout is its own average: `
          + `${steady.attentionWindowBandRmsDps} vs ${steady.bandRmsDps}`);
        for (const presence of [0.3, 0.45, 0.6]) {
          for (const periodS of [6, 10]) {
            const label = `${hz} Hz at ${amp} (steady ${steady.bandRmsDps} deg/s), present `
              + `${presence * 100}% in ${periodS} s cycles`;
            const peak = await peakAt({hz, amp, onS: presence * periodS, periodS,
              seed: 11 + amp + periodS}, hz);
            assert.ok(peak?.attentionEligible, `${label}: ${JSON.stringify(peak)}`);
            intermittent += 1;
            // The fixture is the hole: its flight average is well under its size.
            assert.ok(peak.bandRmsDps <= 0.85 * steady.bandRmsDps, `${label}: ${peak.bandRmsDps}`);
            // Its size while present is the size it has while present — within
            // the share the half-second windows at each switch take off it — and
            // never less than its average, nor under the level it was above.
            const size = peak.attentionWindowBandRmsDps;
            assert.ok(size >= 0.85 * steady.bandRmsDps && size <= 1.02 * steady.bandRmsDps,
              `${label}: size while present ${size}`);
            assert.ok(size >= peak.bandRmsDps, `${label}: ${size} under its average ${peak.bandRmsDps}`);
            assert.ok(size >= 8, `${label}: ${size} is under the level it was above`);
          }
        }
      }
    }
    assert.equal(intermittent, 24);

    // Pulses shorter than one analysis window: no window sees the tone whole, so
    // the size while present is what the windows saw — never above the truth,
    // never under the average, never under the level it was above.
    for (const amp of [20, 42]) {
      const peak = await peakAt({hz: 30, amp, onS: 0.3, periodS: 1, seed: 71 + amp}, 30);
      const truth = amp / Math.SQRT2;
      assert.ok(peak?.attentionEligible, `pulsed ${amp}: ${JSON.stringify(peak)}`);
      assert.ok(peak.attentionWindowBandRmsDps <= truth
        && peak.attentionWindowBandRmsDps >= peak.bandRmsDps
        && peak.attentionWindowBandRmsDps >= 8, `pulsed ${amp}: ${JSON.stringify(peak)}`);
    }

    // A tone that never reached the level in any window has no size while present.
    const quietPeak = await peakAt({hz: 30, amp: 4, onS: 1, periodS: 1, seed: 5}, 30);
    assert.ok(quietPeak && quietPeak.attentionEligible === false, JSON.stringify(quietPeak));
    assert.equal(quietPeak.attentionWindowBandRmsDps, null);
  });

/* ---------------------------------------------------------------------------
 * Stage 2d, airframe review of 3 October 2026.
 * ------------------------------------------------------------------------- */

/**
 * Roll carries `tones`, each present while `on(at)` says so (throughout when it
 * has none); pitch and yaw are quiet; the head turns at 1800 rpm. The real
 * analyser's input, built in memory.
 */
function gatedToneSeries({rateHz = 1000, seconds = 60, tones, seed}) {
  const next = rng(seed);
  const count = Math.round(rateHz * seconds);
  const timeUs = new Float64Array(count);
  const roll = new Float64Array(count);
  const quiet = new Float64Array(count);
  const head = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    const at = index / rateHz;
    timeUs[index] = Math.round(at * 1e6);
    let value = 0;
    for (const tone of tones) {
      if (!tone.on || tone.on(at)) {
        value += tone.amp * Math.sin(2 * Math.PI * tone.hz * at + (tone.phase ?? 0));
      }
    }
    roll[index] = value + (next() - 0.5);
    quiet[index] = next() - 0.5;
    head[index] = 1800 + (next() - 0.5) * 4;
  }
  return {timeUs, gyro: {roll, pitch: quiet, yaw: quiet}, gyroSources: UNFILTERED,
    headspeedRpm: head, tailspeedRpm: new Float64Array(count).fill(Number.NaN)};
}

/** The listed roll peak within 3 Hz of `hz`, or null. */
async function rollPeakNear(series, hz) {
  const result = await spectrum.analyzeMechanicalWindow(series, wholeRange(series));
  return result.axes.find(axis => axis.axis === 'roll').peaks
    .find(peak => Math.abs(peak.frequencyHz - hz) <= 3) ?? null;
}

test('a tone above the attention level for only part of the range is listed whatever outranks '
  + 'it, and never as a small tone', async () => {
    // Stage 2d, item 1. Small peaks are capped at five, ranked on persistence. A
    // tone above the level for a quarter of the flight is not attention-eligible
    // (too few windows, too short a span, or too few quarters of the flight), so
    // it competed for those five places on persistence it does not have, and
    // five small steady harmonics were enough to push it off the list. The
    // airframe rung then read the flight as clear, over a tone measured at three
    // to six times the level while it was there.
    const shapes = [
      ['the first quarter', at => at < 15],
      ['the first 40%', at => at < 24],
      ['a block in the middle', at => at >= 20 && at < 36],
      ['the last third', at => at >= 40],
      ['2 s in every 10', at => at % 10 < 2],
      ['1.5 s in every 6', at => at % 6 < 1.5]
    ];
    const random = rng(2026);
    const steadyHz = [60, 90, 120, 150, 180, 210, 240, 270];
    let reached = 0;
    let outranked = 0;
    for (const [shape, on] of shapes) {
      for (const hz of [30, 47]) {
        for (const crowd of [0, 6, 8]) {
          const amp = (24 + random() * 24) * Math.SQRT2;
          const tones = [{hz, amp, on}];
          for (let index = 0; index < crowd; index += 1) {
            tones.push({hz: steadyHz[index], amp: 3 + random() * 3, phase: random() * 6});
          }
          const series = gatedToneSeries({tones, seed: 31 + reached + crowd});
          const result = await spectrum.analyzeMechanicalWindow(series, wholeRange(series));
          const roll = result.axes.find(axis => axis.axis === 'roll');
          const label = `${hz} Hz at ${(amp / Math.SQRT2).toFixed(1)} deg/s over ${shape}, among `
            + `${crowd} small steady tones: ${JSON.stringify(roll.peaks.map(peak => [peak.frequencyHz,
              peak.persistenceRatio, peak.attentionWindowBandRmsDps, peak.attentionEligible]))}`;
          const peak = roll.peaks.find(entry => Math.abs(entry.frequencyHz - hz) <= 3);
          // The guarded property: it is on the list, as what it is.
          assert.ok(peak, `${label}: the tone was cut from the list`);
          assert.ok(peak.attentionWindowBandRmsDps >= 8, label);
          if (peak.attentionEligible) {
            continue;
          }
          reached += 1;
          // And the cap on SMALL tones still holds: the tone is not one of them, so
          // it neither takes a small tone's place nor is counted among them.
          const small = roll.peaks.filter(entry => entry.attentionWindowBandRmsDps === null);
          assert.ok(small.length <= SUB_THRESHOLD_PEAK_CAP, label);
          assert.equal(small.length, Math.min(SUB_THRESHOLD_PEAK_CAP, crowd), label);
          if (crowd >= SUB_THRESHOLD_PEAK_CAP
              && small.every(entry => entry.persistenceRatio > peak.persistenceRatio)) {
            outranked += 1;
          }
        }
      }
    }
    // The sweep reached the hole: tones that were not attention-eligible, and ones
    // that every small tone outranked with enough of them to fill the cap.
    assert.ok(reached >= 24, `only ${reached} configurations were above the level in part`);
    assert.ok(outranked >= 12, `only ${outranked} were outranked by a full cap of small tones`);
  });

test('a short burst of a large tone is listed as above the level in part, however little of the '
  + 'range it fills', async () => {
    // Stage 2d follow-up, item 1 — pre-existing on main. A peak present in fewer
    // than a quarter of the analysis windows (MIN_PERSISTENCE_RATIO) was dropped
    // before its size in each window was measured, so a burst of a few seconds at
    // three to seven times the level was never listed at all, and the airframe
    // rung read AIRFRAME_CLEAR over it. Swept over 40 s to five-minute ranges —
    // five minutes is two stretches — and bursts of 1.5 to 15 seconds.
    //
    // A burst can only be seen by a window that holds it. At 1000 Hz a window is
    // 512 samples, the windows step by half of one, and at most
    // MECHANICAL_CONSTANTS.maximumWelchWindows of them are analysed per stretch,
    // evenly spread. Every burst below is longer than the widest step between
    // analysed windows plus a window, which is asserted from the published
    // counts, so each one is held whole by at least one analysed window: a burst
    // that is not listed is the analyser dropping it, never the sampling missing it.
    const windowS = 0.512;
    const grid = [[40, [1.5, 3, 6, 15]], [90, [1.5, 4, 10]], [150, [3, 8]], [300, [3, 6, 15]]];
    const random = rng(1503);
    let configuration = 0;
    let underPresence = 0;
    let inPart = 0;
    for (const [seconds, bursts] of grid) {
      for (const burstS of bursts) {
        configuration += 1;
        const hz = configuration % 2 === 0 ? 30 : 47;
        const strength = 1.5 + random() * 5.5;
        // Clear of the middle, where a five-minute range is split in two.
        const fromS = (0.08 + random() * 0.3) * seconds;
        const series = gatedToneSeries({seconds, seed: 1500 + configuration, tones: [{hz,
          amp: strength * 8 * Math.SQRT2, phase: configuration, on: at => at >= fromS && at < fromS + burstS}]});
        const result = await spectrum.analyzeMechanicalWindow(series, wholeRange(series));
        const roll = result.axes.find(axis => axis.axis === 'roll');
        const stretches = Array.isArray(result.chunks) ? result.chunks.length : 1;
        const stepS = Math.ceil((roll.candidateWindowCount / stretches - 1)
          / (roll.windowCount / stretches - 1)) * windowS / 2;
        const label = `${hz} Hz at ${(strength * 8).toFixed(1)} deg/s for ${burstS} s of ${seconds} s `
          + `(analysed windows ${stepS.toFixed(3)} s apart): ${JSON.stringify(roll.peaks.map(peak =>
            [peak.frequencyHz, peak.persistenceRatio, peak.attentionWindowBandRmsDps, peak.attentionEligible]))}`;
        // Some analysed window starts in every stretch of `stepS`, so one starts in
        // the first (burst - window) of the burst, and ends inside it.
        assert.ok(burstS >= stepS + windowS + 0.01, `the sweep must hold only bursts a window `
          + `can see whole: ${label}`);
        const peak = roll.peaks.find(entry => Math.abs(entry.frequencyHz - hz) <= 2);
        // The guarded property: it is on the list, at its size while present.
        assert.ok(peak, `${label}: the burst was cut from the list`);
        assert.ok(peak.attentionWindowBandRmsDps >= 8, label);
        assert.ok(peak.attentionWindowBandRmsDps <= strength * 8 * 1.02, label);
        // Nothing else reached the level: the burst is listed as one tone, and no
        // stray neighbour of it is listed beside it as a second one.
        assert.deepEqual(roll.peaks.filter(entry => entry.attentionWindowBandRmsDps !== null)
          .map(entry => entry.frequencyHz), [peak.frequencyHz], label);
        const required = Math.max(MECHANICAL_CONSTANTS.minimumWelchWindows,
          Math.ceil(peak.evaluatedWindowCount * MECHANICAL_CONSTANTS.minimumPersistenceRatio));
        if (peak.supportingWindowCount < required) {
          underPresence += 1;
        }
        // A burst is never one the analyser calls worth attention on its own —
        // what keeps one bump from stopping a tune — so it is listed in part.
        if (!peak.attentionEligible) {
          inPart += 1;
        }
        // Not persistent, so the result says nothing persistent was found — the
        // burst is the airframe rung's to judge, as a tone above the level in part.
        if (peak.supportingWindowCount < required && result.status === 'clear') {
          assert.ok(!result.reasonCodes.includes('PERSISTENT_NARROWBAND_ENERGY_BELOW_ATTENTION_THRESHOLD'),
            `${label}: ${result.reasonCodes}`);
          assert.deepEqual(result.findings.map(finding => finding.id),
            Array(stretches).fill('mechanical-no-persistent-narrowband-peak'), label);
        }
      }
    }
    // The sweep reached the hole: bursts under the persistence the list used to
    // demand — 7 of the 12 when this was written, in every range length. (White
    // noise alone is "present" in a sixth to a fifth of the windows, so longer
    // bursts in short ranges clear the floor.)
    assert.ok(underPresence >= 6, `only ${underPresence} bursts were under the persistence floor`);
    assert.equal(inPart, configuration);
  });

test('a tone\'s size while present leaves out the windows that straddle it switching on or off',
  async () => {
    // Stage 2d, item 3. A window that straddles a switch holds the tone for part
    // of its length, still passes the level, and was averaged in at that partial
    // power: the size while present read 7-13% low at on-times of 1-3 s, and a
    // tone just past three times the level was waved under the ceiling. Windows
    // with no above-level window a whole window length before and after them are
    // left out; where that leaves none, the size is published as a lower bound.
    const steadyCache = new Map();
    const steadyOf = async (rateHz, seconds, amp) => {
      const key = `${rateHz}/${seconds}/${amp}`;
      if (!steadyCache.has(key)) {
        const peak = await rollPeakNear(gatedToneSeries({rateHz, seconds, seed: 1,
          tones: [{hz: 30, amp}]}), 30);
        steadyCache.set(key, peak.bandRmsDps);
      }
      return steadyCache.get(key);
    };
    let exact = 0;
    let bounded = 0;
    let configuration = 0;
    for (const [rateHz, seconds] of [[1000, 20], [500, 60], [1000, 60], [1000, 120]]) {
      // Three to three and a half times the level: either side of the ceiling.
      for (const strength of [3.0, 3.2, 3.4]) {
        const amp = strength * 8 * Math.SQRT2;
        const steady = await steadyOf(rateHz, seconds, amp);
        for (const [onS, offS] of [[2.5, 7.5], [3, 3], [5, 5], [1.5, 4], [0.6, 3]]) {
          if (seconds === 20 && onS + offS > 8) {
            continue;
          }
          configuration += 1;
          const peak = await rollPeakNear(gatedToneSeries({rateHz, seconds, seed: 200 + configuration,
            tones: [{hz: 30, amp, phase: configuration, on: at => at % (onS + offS) < onS}]}), 30);
          const label = `${rateHz} Hz, ${seconds} s, ${strength}x on ${onS} s off ${offS} s `
            + `(steady ${steady}): ${JSON.stringify(peak)}`;
          assert.ok(peak && Number.isFinite(peak.attentionWindowBandRmsDps), label);
          const size = peak.attentionWindowBandRmsDps;
          assert.equal(typeof peak.attentionWindowSizeIsLowerBound, 'boolean', label);
          // Never above what the tone measures while it is there, never under its
          // average or the level it was above.
          assert.ok(size <= steady * 1.01, label);
          assert.ok(size >= peak.bandRmsDps && size >= 8, label);
          if (peak.attentionWindowSizeIsLowerBound) {
            bounded += 1;
            continue;
          }
          // Not a bound: then it is the tone's size, to within one percent.
          assert.ok(Math.abs(size / steady - 1) <= 0.01, `${label}: ${(size / steady).toFixed(3)}`);
          exact += 1;
        }
      }
    }
    // Both halves were exercised: on-times long enough to be measured whole, at
    // every rate and length — 60 s and 120 s windows sample rather than tile —
    // and pulses shorter than a window, which can only be a bound.
    assert.ok(exact >= 30, `only ${exact} configurations were measured whole`);
    assert.ok(bounded >= 6, `only ${bounded} were published as a lower bound`);
    // A pulse shorter than one analysis window is never seen whole.
    const pulse = await rollPeakNear(gatedToneSeries({rateHz: 1000, seconds: 60, seed: 9,
      tones: [{hz: 30, amp: 4 * 8 * Math.SQRT2, on: at => at % 3 < 0.35}]}), 30);
    assert.ok(pulse?.attentionWindowSizeIsLowerBound === true, JSON.stringify(pulse));
    // Leaving the edges out may only ever raise the size. A tone that announces
    // each stretch with a burst ten times the level, too short to have anything
    // but edges, then holds just over the level, is loudest in exactly the
    // windows left out: its size is still never under its average.
    const burst = await rollPeakNear(gatedToneSeries({rateHz: 1000, seconds: 30, seed: 12, tones: [
      {hz: 30, amp: 80 * Math.SQRT2, on: at => at % 4 < 0.2},
      {hz: 30, amp: 9.5 * Math.SQRT2, on: at => at % 4 >= 0.8 && at % 4 < 3}]}), 30);
    assert.ok(burst && burst.attentionWindowBandRmsDps >= burst.bandRmsDps
      && burst.attentionWindowBandRmsDps >= 8, JSON.stringify(burst));
    // A tone above the level throughout has no switch to straddle.
    const steady = await rollPeakNear(gatedToneSeries({rateHz: 1000, seconds: 60, seed: 10,
      tones: [{hz: 30, amp: 20}]}), 30);
    assert.equal(steady.attentionWindowSizeIsLowerBound, false);
    assert.ok(Math.abs(steady.attentionWindowBandRmsDps - steady.bandRmsDps) <= 0.002,
      JSON.stringify(steady));
  });

test('a peak\'s frequency is interpolated between bins, and its rotor match carries what a '
  + 'tolerance would be built from', async () => {
    // Stage 2d, item 2. The bin a tone lands in is up to half a bin (about 1 Hz
    // at the 2 Hz resolution) from the tone, so "matched to the rotor" could only
    // ever be judged to within a bin and a half. The interpolated frequency is
    // the log-parabola through the peak bin and its neighbours.
    let binWorst = 0;
    let index = 0;
    for (const rateHz of [500, 1000, 2000]) {
      for (let hz = 28; hz <= 32.001; hz += 0.25) {
        index += 1;
        const series = gatedToneSeries({rateHz, seconds: 20, seed: 400 + index,
          tones: [{hz, amp: 14, phase: index}]});
        const result = await spectrum.analyzeMechanicalWindow(series, wholeRange(series));
        const peak = result.axes.find(axis => axis.axis === 'roll').peaks
          .find(entry => Math.abs(entry.frequencyHz - hz) <= 2);
        const label = `${hz.toFixed(2)} Hz at ${rateHz} Hz: ${JSON.stringify(peak)}`;
        assert.ok(peak, label);
        binWorst = Math.max(binWorst, Math.abs(peak.frequencyHz - hz));
        assert.ok(Math.abs(peak.interpolatedFrequencyHz - hz) <= 0.1, label);
        // The match carries the head speed's own spread at that order and the
        // analysis resolution, as measured, so a caller can build a tolerance from
        // them rather than from the analyser's wider naming tolerance.
        const match = peak.harmonicMatch;
        assert.ok(match && match.rotor === 'main' && match.order === 1, label);
        const headspeed = result.rpmEvidence.headspeed;
        assert.ok(Math.abs(match.spreadHz - headspeed.relativeSpread * match.predictedHz / 2) <= 0.001,
          `${label}: spread ${match.spreadHz} vs ${headspeed.relativeSpread}`);
        assert.ok(Math.abs(match.frequencyResolutionHz - result.quality.frequencyResolutionHz) <= 0.001,
          label);
      }
    }
    // The bin alone was half a bin out somewhere in the sweep, or this proves nothing.
    assert.ok(binWorst >= 0.8, `the bin was never far from the tone: ${binWorst}`);
  });

test('a missing or out-of-bounds range is refused, never guessed', async () => {
  const series = toneSeries({rateHz: 1000, seconds: 10, tones: [{hz: 50, amp: 5}], seed: 55});
  await assert.rejects(
    () => analyzeMechanicalTimeSeries(series, {}),
    error => error.code === 'ANALYSIS_RANGE_REQUIRED'
  );
  await assert.rejects(
    () => analyzeMechanicalTimeSeries(series, {
      timeRangeUs: {startTimeUs: -1, endTimeUs: 5_000_000}
    }),
    error => error.code === 'ANALYSIS_RANGE_INVALID'
  );
});

/* --------------------------------------------------------- the UI boundary */

/** The vocabulary no output of this directory may contain. */
const BANNED_VOCABULARY =
  /recommend|you should|adjust|increase|decrease|reduce|raise|lower|inspect|replace|enable |set the/i;

test('summarizeMechanicalVibration answers the three rotor questions distinctly',
  async () => {
    const capUs = MECHANICAL_CONSTANTS.maximumSelectionDurationUs;
    assert.ok(capUs > 0);

    // 1500 rpm = 25 Hz fundamental. A tone on 3/rev is explained; a tone at
    // 3.5/rev is half a fundamental from the nearest order and the tolerance
    // — max(1.5*1.966, 0.025*87.5, 0.02*87.5/2) = 2.95 Hz — cannot reach it.
    const explained = await summarizeMechanicalVibration(rotorSeries({
      toneHz: 75, ampDps: 25, headspeedRpm: 1500, rpmDriftRatio: 0.02, seed: 101
    }), {timeRangeUs: {startTimeUs: 0, endTimeUs: 7_990_000}});

    const notExplained = await summarizeMechanicalVibration(rotorSeries({
      toneHz: 87.5, ampDps: 25, headspeedRpm: 1500, rpmDriftRatio: 0.02, seed: 102
    }), {timeRangeUs: {startTimeUs: 0, endTimeUs: 7_990_000}});

    const noRotor = rotorSeries({
      toneHz: 75, ampDps: 25, headspeedRpm: 1500, rpmDriftRatio: 0.02, seed: 103
    });
    noRotor.headspeedRpm = new Float64Array(noRotor.timeUs.length).fill(Number.NaN);
    const notChecked = await summarizeMechanicalVibration(
      noRotor, {timeRangeUs: {startTimeUs: 0, endTimeUs: 7_990_000}}
    );

    const strongestOf = view => {
      const peaks = view.axes.flatMap(axis => axis.peaks);
      peaks.sort((left, right) => right.amplitudeDps - left.amplitudeDps);
      return peaks[0];
    };

    const yes = strongestOf(explained);
    assert.equal(yes.rotorHarmonic.state, 'explained');
    assert.equal(yes.rotorHarmonic.rotor, 'main');
    assert.equal(yes.rotorHarmonic.order, 3, '75 Hz against a 25 Hz fundamental is 3/rev');
    assert.ok(Math.abs(yes.frequencyHz - 75) <= 2);
    assert.equal(explained.rotorCorrelation.state, 'evaluated');

    const no = strongestOf(notExplained);
    assert.equal(no.rotorHarmonic.state, 'not-explained');
    assert.equal(no.rotorHarmonic.rotor, null);
    assert.equal(no.rotorHarmonic.order, null);
    // The rotor that could not be compared is still named, so "the main rotor
    // does not explain this" is never read as "no rotor explains this".
    assert.deepEqual(
      no.rotorHarmonic.unavailableRotors, [{field: 'tailspeed', reasonCode: 'FIELD_MISSING'}]
    );
    assert.equal(notExplained.rotorCorrelation.state, 'evaluated');

    const unknown = strongestOf(notChecked);
    assert.equal(
      unknown.rotorHarmonic.state, 'not-checked',
      'the same 3/rev tone with no rotor column must not read as unexplained'
    );
    assert.equal(unknown.rotorHarmonic.rotor, null);
    assert.equal(notChecked.rotorCorrelation.state, 'unavailable');
    assert.equal(notChecked.rotorCorrelation.headspeed.reasonCode, 'FIELD_MISSING');

    // The three are genuinely three. Collapsing any pair is the defect.
    const states = [
      yes.rotorHarmonic.state, no.rotorHarmonic.state, unknown.rotorHarmonic.state
    ];
    assert.equal(new Set(states).size, 3, `states collapsed: ${states.join(',')}`);
  });

test('summarizeMechanicalVibration returns a plain, JSON-safe, measurement-only object',
  async () => {
    const session = fakeSession(
      ['time', 'gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]', 'headspeed'],
      Array.from({length: 12_000}, (unused, index) => {
        const timeUs = index * 1000;
        const value = 12 * Math.sin(2 * Math.PI * 60 * timeUs / 1e6);
        return [timeUs, value, value, value, 1800];
      })
    );

    const view = await summarizeMechanicalVibration(session, {
      timeRangeUs: {startTimeUs: 0, endTimeUs: 11_999_000}
    });

    assert.equal(view.schemaVersion, VIBRATION_SUMMARY_SCHEMA_VERSION);
    assert.equal(view.measurementsOnly, true);
    assert.equal(view.axes.length, 3);
    assert.deepEqual(view.axes.map(axis => axis.axis), ['roll', 'pitch', 'yaw']);
    for (const axis of view.axes) {
      assert.equal(axis.gyroSource, 'gyroRAW');
      assert.equal(axis.amplitudeKind, 'unfiltered-gyro-output');
      assert.equal(axis.available, true);
      assert.ok(axis.peaks.length > 0, `${axis.axis} should show the injected 60 Hz tone`);
      for (const peak of axis.peaks) {
        assert.ok(Number.isFinite(peak.frequencyHz));
        assert.ok(Number.isFinite(peak.amplitudeDps));
        assert.equal(typeof peak.aboveAttentionThreshold, 'boolean');
        assert.ok(['explained', 'near-order', 'not-explained', 'not-checked']
          .includes(peak.rotorHarmonic.state));
      }
    }

    // Plain data. A UI must be able to post it to a worker or store it.
    assert.deepEqual(JSON.parse(JSON.stringify(view)), view);

    // And nothing in it tells anybody to change anything. Constraint 4.
    const text = JSON.stringify(view);
    assert.ok(
      !BANNED_VOCABULARY.test(text),
      `summary carries instruction vocabulary: ${text.slice(0, 400)}`
    );
    assert.ok(!/"direction"/.test(text));
    assert.ok(!/"recommendation"/.test(text));

    // No string field is a sentence, so nothing here can grow prose either.
    const walk = value => {
      if (typeof value === 'string') {
        assert.ok(!/\s\w+\s\w+\s\w+\s/.test(value), `composed prose: ${value}`);
      } else if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value && typeof value === 'object') {
        Object.values(value).forEach(walk);
      }
    };
    walk(view);
  });

test('summarizeMechanicalVibration reports what it could not measure, and throws only for caller bugs',
  async () => {
    // A filtered gyro source: quiet is not evidence of a quiet aircraft, so no
    // peaks are published and the axes say why.
    const filtered = toneSeries({
      rateHz: 1000, seconds: 25, tones: [{hz: 100, amp: 3}], seed: 8
    });
    const view = await summarizeMechanicalVibration({
      ...filtered,
      gyroSources: {
        roll: 'gyroADC-filtered', pitch: 'gyroADC-filtered', yaw: 'gyroADC-filtered'
      }
    }, wholeRange(filtered));
    assert.equal(view.status, 'insufficient');
    assert.equal(view.available, false);
    assert.ok(view.reasonCodes.includes('UNFILTERED_GYRO_REQUIRED_FOR_CLEAR_GATE'));
    for (const axis of view.axes) {
      assert.equal(axis.available, false);
      assert.equal(axis.amplitudeKind, null);
      assert.deepEqual(axis.peaks, []);
    }

    // A log with no gyro column is a fact about the log, not a crash.
    const noGyro = await summarizeMechanicalVibration(
      fakeSession(['time', 'debug[0]'], [[0, 1], [1000, 2]]),
      {timeRangeUs: {startTimeUs: 0, endTimeUs: 1000}}
    );
    assert.equal(noGyro.status, 'insufficient');
    assert.ok(noGyro.reasonCodes.includes('GYRO_FIELDS_MISSING'));
    assert.deepEqual(noGyro.axes, []);
    assert.equal(noGyro.rotorCorrelation.state, 'not-evaluated');

    // A caller bug is a caller bug, and must not arrive dressed as a safety word.
    const series = toneSeries({rateHz: 1000, seconds: 10, tones: [{hz: 50, amp: 5}], seed: 55});
    await assert.rejects(
      () => summarizeMechanicalVibration(series, {}),
      error => error.code === 'ANALYSIS_RANGE_REQUIRED'
    );
    await assert.rejects(
      () => summarizeMechanicalVibration(series, {
        timeRangeUs: {startTimeUs: -1, endTimeUs: 5_000_000}
      }),
      error => error.code === 'ANALYSIS_RANGE_INVALID'
    );
    await assert.rejects(
      () => summarizeMechanicalVibration(
        {...series, gyroSources: {roll: 'gyro', pitch: 'gyro', yaw: 'gyro'}},
        wholeRange(series)
      ),
      error => error.code === 'MECHANICAL_GYRO_SOURCE_INVALID'
    );
  });

/* ---------------------------------------------------------------------------
 * Stage 2d follow-up, copy review of 3 October 2026, findings 3, 6 and 8.
 * ------------------------------------------------------------------------- */

test('the vibration summary calls a peak its rotor\'s order only where the logged speed puts it, '
  + 'and "near" that order otherwise', async () => {
    // Finding 3. `peakRotorAttribution` published every peak the analyser NAMED a
    // rotor order — by its wide match, a bin and a half or 2.5% — as "explained",
    // so the panel drew a green "main 1/rev" and "its order 1 lands on this
    // frequency" over a tone 1.6 Hz off the once-per-rev of a head logged steady,
    // while the airframe gate, judging identity on the logged speed's own spread
    // plus half a bin, called the same tone not the rotor's own. The summary's
    // answer must be the gate's answer, peak by peak, swept across the order.
    const seen = {explained: 0, near: 0, tailNear: 0, tailExplained: 0};
    const round3 = value => Math.round(value * 1000) / 1000;
    let configuration = 0;
    const check = (result, label) => {
      const summary = spectrum.summarizeMechanicalResult(result);
      const raw = result.axes.find(axis => axis.axis === 'roll').peaks;
      const view = summary.axes.find(axis => axis.axis === 'roll').peaks;
      assert.equal(view.length, raw.length, label);
      return raw.map((peak, index) => {
        const harmonic = view[index].rotorHarmonic;
        const where = `${label}: ${JSON.stringify(peak)} -> ${JSON.stringify(harmonic)}`;
        if (!peak.harmonicMatch) {
          assert.ok(['not-explained', 'not-checked'].includes(harmonic.state), where);
          return null;
        }
        const established = rotorOrderMatchEstablished(peak);
        const distance = rotorOrderMatchDistance(peak);
        assert.equal(harmonic.state, established ? 'explained' : 'near-order', where);
        assert.equal(harmonic.rotor, peak.harmonicMatch.rotor, where);
        assert.equal(harmonic.order, peak.harmonicMatch.order, where);
        // How far, and how far the logged speed allows: the gate's own numbers.
        assert.equal(harmonic.offsetFromOrderHz, round3(distance.offsetHz), where);
        assert.equal(harmonic.offsetAllowedHz, round3(distance.toleranceHz), where);
        return {rotor: peak.harmonicMatch.rotor, established};
      }).filter(Boolean);
    };
    for (const order of [1, 2]) {
      for (const offsetHz of [-2.6, -1.8, -1.2, -0.6, -0.2, 0, 0.3, 0.8, 1.4, 2.0, 2.6]) {
        configuration += 1;
        const series = gatedToneSeries({seconds: 30, seed: 3000 + configuration,
          tones: [{hz: 30 * order + offsetHz, amp: 2 * 8 * Math.SQRT2, phase: configuration}]});
        const result = await spectrum.analyzeMechanicalWindow(series, wholeRange(series));
        for (const match of check(result, `${30 * order + offsetHz} Hz`)) {
          seen[match.established ? 'explained' : 'near'] += 1;
        }
      }
    }
    // The tail rotor, judged against the logged TAIL speed: 6500 rpm is 108.3 Hz,
    // and no main-rotor order of 1800 rpm is near it.
    for (const offsetHz of [0, 0.2, 1.6, -1.8, -1.4]) {
      configuration += 1;
      const series = gatedToneSeries({seconds: 30, seed: 3000 + configuration,
        tones: [{hz: 6500 / 60 + offsetHz, amp: 2 * 8 * Math.SQRT2, phase: configuration}]});
      const next = rng(configuration);
      series.tailspeedRpm = Float64Array.from(series.timeUs, () => 6500 + (next() - 0.5) * 4);
      const result = await spectrum.analyzeMechanicalWindow(series, wholeRange(series));
      const matches = check(result, `tail, ${offsetHz} Hz off its once-per-rev`);
      assert.ok(matches.length > 0 && matches.every(match => match.rotor === 'tail'),
        `${offsetHz} Hz off the tail's once-per-rev: ${JSON.stringify(matches)}`);
      for (const match of matches) {
        seen[match.established ? 'tailExplained' : 'tailNear'] += 1;
      }
    }
    assert.ok(seen.explained >= 6 && seen.near >= 6 && seen.tailNear >= 2 && seen.tailExplained >= 2,
      JSON.stringify(seen));
  });

/** The criteria a peak above the level in some window failed, recomputed from its published counts. */
function attentionCriteriaFailed(peak) {
  const required = Math.max(MECHANICAL_CONSTANTS.minimumWelchWindows,
    Math.ceil(peak.evaluatedWindowCount * MECHANICAL_CONSTANTS.minimumPersistenceRatio));
  return [
    ...(peak.attentionSupportingWindowCount < required ? ['window-count'] : []),
    ...(peak.attentionTemporalSpanRatio < 0.5 ? ['span'] : []),
    ...(peak.attentionOccupiedBucketCount < MECHANICAL_CONSTANTS.minimumAttentionOccupiedBuckets
      ? ['quarters'] : []),
    ...(peak.attentionMaximumGapRatio > MECHANICAL_CONSTANTS.maximumAttentionUnsupportedGapRatio
      ? ['gap'] : [])
  ];
}

const ABOVE_LEVEL_SHAPES = Object.freeze([
  ['throughout', () => true],
  ['the first quarter', at => at < 15],
  ['the first 40%', at => at < 24],
  ['a block in the middle', at => at >= 20 && at < 38],
  ['2 s in every 10', at => at % 10 < 2],
  ['1.5 s in every 6', at => at % 6 < 1.5],
  ['the first and last fifths', at => at < 12 || at >= 48],
  ['three stretches with a long gap', at => at < 8 || (at >= 30 && at < 34) || at >= 52],
  ['a 3 s burst', at => at >= 20 && at < 23]
]);

test('a peak publishes which attention criteria it did not meet, and is attention-eligible exactly '
  + 'when it met them all', async () => {
    // Finding 6. A tone above the level for part of the range was said to be "too
    // little of the flight to judge it as a steady tone" whichever criterion it
    // failed — including tones above the level in a quarter or more of the windows
    // that failed only on being bunched together. Only the analyser applies the
    // criteria, so it publishes which failed; checked here against its published
    // counts and its own constants, in one analysis and in two stretches.
    const seen = new Set();
    let eligible = 0;
    let configuration = 0;
    for (const [shape, on] of ABOVE_LEVEL_SHAPES) {
      for (const hz of [30, 47]) {
        for (const strength of [1.4, 2.6]) {
          configuration += 1;
          const series = gatedToneSeries({seed: 4000 + configuration,
            tones: [{hz, amp: strength * 8 * Math.SQRT2, phase: configuration, on}]});
          const result = await spectrum.analyzeMechanicalWindow(series, wholeRange(series));
          for (const peak of result.axes.find(axis => axis.axis === 'roll').peaks) {
            const label = `${hz} Hz at ${strength}x over ${shape}: ${JSON.stringify(peak)}`;
            const expected = attentionCriteriaFailed(peak);
            assert.deepEqual(peak.attentionCriteriaUnmet, expected, label);
            assert.equal(peak.attentionEligible, expected.length === 0, label);
            expected.forEach(code => seen.add(code));
            eligible += expected.length === 0 ? 1 : 0;
          }
        }
      }
    }
    // Two stretches: each copy carries its own stretch's criteria.
    const series = gatedToneSeries({seconds: 300, seed: 4999, tones: [
      {hz: 47, amp: 2.6 * 8 * Math.SQRT2, on: at => at < 40 || (at >= 150 && at % 10 < 3)}]});
    const result = await spectrum.analyzeMechanicalWindow(series, wholeRange(series));
    assert.equal(result.chunks.length, 2);
    const copies = result.axes.find(axis => axis.axis === 'roll').peaks
      .filter(peak => Math.abs(peak.frequencyHz - 47) <= 2);
    assert.equal(copies.length, 2, JSON.stringify(copies));
    for (const peak of copies) {
      assert.deepEqual(peak.attentionCriteriaUnmet, attentionCriteriaFailed(peak), JSON.stringify(peak));
    }
    assert.deepEqual([...seen].sort(), ['gap', 'quarters', 'span', 'window-count']);
    assert.ok(eligible >= 4, `${eligible}`);
  });

test('the vibration summary says which listed tones are persistent and which are short bursts',
  async () => {
    // Finding 8. Since the Stage 2d follow-up a burst in too few windows to be a
    // persistent tone is listed when it reached the attention level, and the
    // panel counted it under "Persistent tones". The summary says which each peak
    // is, by the presence rule the analyser applies to its own findings.
    const seen = {persistent: 0, burst: 0};
    let configuration = 0;
    const shapes = [...ABOVE_LEVEL_SHAPES,
      ['a 1.5 s burst', at => at >= 41 && at < 42.5], ['a 2 s burst', at => at >= 9 && at < 11]];
    for (const [shape, on] of shapes) {
      for (const strength of [0.6, 2.2, 4]) {
        configuration += 1;
        const series = gatedToneSeries({seed: 5000 + configuration,
          tones: [{hz: 47, amp: strength * 8 * Math.SQRT2, phase: configuration, on}]});
        const result = await spectrum.analyzeMechanicalWindow(series, wholeRange(series));
        const view = spectrum.summarizeMechanicalResult(result);
        const raw = result.axes.find(axis => axis.axis === 'roll').peaks;
        const listed = view.axes.find(axis => axis.axis === 'roll').peaks;
        raw.forEach((peak, index) => {
          const required = Math.max(MECHANICAL_CONSTANTS.minimumWelchWindows,
            Math.ceil(peak.evaluatedWindowCount * MECHANICAL_CONSTANTS.minimumPersistenceRatio));
          const persistent = peak.attentionEligible || peak.supportingWindowCount >= required;
          assert.equal(listed[index].persistent, persistent,
            `${strength}x over ${shape}: ${JSON.stringify(peak)}`);
          seen[persistent ? 'persistent' : 'burst'] += 1;
        });
      }
    }
    assert.ok(seen.persistent >= 10 && seen.burst >= 3, JSON.stringify(seen));
  });

/* ------------------------------------ the unresolved product decision, pinned */

/**
 * Three files in this directory disagree about whether RotorLens gives setting
 * direction advice, and no test asserted on any of it.
 *
 * This test does not resolve the disagreement — that is the owner's product
 * decision, recorded as open in docs/ARCHITECTURE_AND_PROVENANCE.md. It pins
 * the current state of all three so the disagreement cannot quietly become a
 * different disagreement, and so that whoever settles it has to come here and
 * say what they settled it to.
 */
test('the settingDirectionAdvice conflict is pinned exactly as it stands', async () => {
  // 1. mechanical-spectrum.mjs: no direction advice, on every result.
  const clean = toneSeries({rateHz: 1000, seconds: 25, tones: [{hz: 90, amp: 2}], seed: 12});
  const mechanical = await analyzeMechanicalTimeSeries(clean, wholeRange(clean));
  assert.equal(mechanical.capabilities.settingDirectionAdvice, false);
  assert.equal(mechanical.capabilities.tuningRecommendations, false);
  assert.equal(mechanical.capabilities.directSettingWrites, false);

  // 2. evidence-contract.mjs: direction advice, with a one-setting allowlist.
  const evidencePackage = makePackage({});
  assert.equal(
    evidencePackage.capabilities.settingDirectionAdvice, true,
    'evidence-contract still claims the opposite of mechanical-spectrum'
  );
  assert.deepEqual(evidencePackage.recommendationPolicy.settingAllowlist, ['gov_f_gain']);
  assert.equal(evidencePackage.recommendationPolicy.directSettingWrites, false);
  assert.equal(evidencePackage.recommendationPolicy.finalTuneClaims, false);

  // 3. deterministic-metrics.mjs: a field literally named `direction`.
  const pumps = detectPitchPumps([], {});
  assert.ok('direction' in pumps, 'detectPitchPumps still publishes a `direction` field');
  assert.equal(pumps.direction, null, 'with no events there is no direction to publish');

  // Reaching a non-null `direction` needs a full pitch-pump event set, which
  // this file has no fixture for, so the two values it can take are pinned from
  // the source instead. Stated plainly because a source-text pin is weaker than
  // a behavioural one: it proves the words are still there, not that they fire.
  const metricsSource = fs.readFileSync(METRICS_PATH, 'utf8');
  assert.ok(
    metricsSource.includes(
      'direction: sufficient ? (dominant === "droop" ? "increase" : "decrease") : null,'
    ),
    'the `direction` expression in deterministic-metrics.mjs has changed; '
      + 'if the product decision was settled, settle it in the docs too'
  );

  // The conflict itself, asserted as a conflict. This is the line that goes red
  // when somebody resolves it, which is the point.
  assert.notEqual(
    mechanical.capabilities.settingDirectionAdvice,
    evidencePackage.capabilities.settingDirectionAdvice,
    'the two capability declarations now agree — update '
      + 'docs/ARCHITECTURE_AND_PROVENANCE.md, which records this as open'
  );
});

/* ------------------------------------------------------------- the real log */

test('the real Rotorflight 4.6.0 log',
  {skip: !REAL_LOG && 'set ROTORLENS_REAL_LOG to a .bbl path to run this'},
  async t => {
    const {decodeLog} = await import('../src/blackbox/decode.mjs');
    const session = decodeLog(new Uint8Array(fs.readFileSync(REAL_LOG))).sessions[0];

    await t.test('resolves gyroRAW, not a debug channel', () => {
      const built = buildMechanicalSeries(session);
      assert.deepEqual(built.gyroSources, {
        roll: 'gyroRAW', pitch: 'gyroRAW', yaw: 'gyroRAW'
      });
      assert.equal(built.resolved['gyro.roll'], 'gyroRAW[0]');
      assert.equal(built.resolved['gyro.pitch'], 'gyroRAW[1]');
      assert.equal(built.resolved['gyro.yaw'], 'gyroRAW[2]');
      assert.equal(built.resolved.headspeed, 'headspeed');
      // Rotorflight 4.6.0 does not log a tail speed. Its absence is reported so
      // a UI cannot let "no tail correlation" read as "the tail is fine".
      assert.deepEqual(built.missing, ['tailspeed']);
      assert.equal(built.usable, true);

      // Measured independently here, not asserted from the analysis: the flat
      // sample array is strictly monotonic, which is why the viewer's
      // chunk-seam dedupe machinery was deleted rather than ported.
      let nonMonotonic = 0;
      let duplicates = 0;
      for (let index = 1; index < built.timeUs.length; index += 1) {
        if (built.timeUs[index] < built.timeUs[index - 1]) nonMonotonic += 1;
        if (built.timeUs[index] === built.timeUs[index - 1]) duplicates += 1;
      }
      assert.equal(built.timeUs.length, 134_429);
      assert.equal(nonMonotonic, 0);
      assert.equal(duplicates, 0);
    });

    await t.test('the rotor spools inside the recording, so most ranges cannot be '
      + 'correlated against it', async () => {
      const built = buildMechanicalSeries(session);
      const bounds = sessionTimeBounds(session);

      const wholeLogSpread = headspeedSpread(built, bounds.startTimeUs, bounds.endTimeUs);
      assert.ok(
        wholeLogSpread > 0.12,
        `the whole log should be too non-stationary to correlate, spread ${wholeLogSpread}`
      );
      assert.ok(
        Math.abs(wholeLogSpread - 0.6211) < 0.01,
        `whole-log headspeed spread has moved: ${wholeLogSpread}`
      );

      const early = await analyzeMechanicalTimeSeries(built, {
        timeRangeUs: {startTimeUs: bounds.startTimeUs, endTimeUs: bounds.startTimeUs + 20e6}
      });
      // The rotor is spinning up here. Nothing about it has been established, and
      // the result must not let that read as a rotor that was checked.
      assert.equal(early.harmonicCorrelation.evaluated, false);
      assert.equal(early.harmonicCorrelation.state, 'unavailable');
      assert.deepEqual(early.harmonicCorrelation.evaluatedRotors, []);
      for (const finding of early.findings) {
        assert.notEqual(
          finding.measurement.conclusion, 'persistent-narrowband-energy-uncorrelated'
        );
      }

      const stationaryStartUs = bounds.startTimeUs + 13e6;
      const stationaryEndUs = stationaryStartUs + 120e6;
      const stationary = await analyzeMechanicalTimeSeries(built, {
        timeRangeUs: {startTimeUs: stationaryStartUs, endTimeUs: stationaryEndUs}
      });
      assert.equal(stationary.harmonicCorrelation.evaluated, true);
      assert.equal(stationary.harmonicCorrelation.state, 'evaluated');
      assert.deepEqual(stationary.harmonicCorrelation.evaluatedRotors, ['headspeed']);
      assert.equal(stationary.rpmEvidence.headspeed.trustworthy, true);
      // Tail correlation is never available on a 4.6.0 log, and the reason must
      // travel with the result rather than being inferred from a null.
      assert.deepEqual(
        stationary.harmonicCorrelation.unavailableRotors,
        [{field: 'tailspeed', reasonCode: 'FIELD_MISSING'}]
      );
    });

    /**
     * The defect that made the old cap wrong, measured rather than asserted.
     *
     * The comment on MAX_SELECTION_DURATION_US used to claim 120 s was where
     * stationarity ends on this log. It was a 1 s search-grid artefact of a
     * search that never looked past 120 s because 120 s was already the cap.
     * This finds the real boundary at 0.01 s resolution and holds the constant
     * to admitting it.
     */
    await t.test('the longest stationary range is bounded by the end of the log, '
      + 'and the cap admits it', async () => {
      const built = buildMechanicalSeries(session);
      const bounds = sessionTimeBounds(session);
      const {startTimeUs: logStart, endTimeUs: logEnd} = bounds;

      // Extending the end of a window can only add plateau samples, which push
      // the 5th percentile up and the spread down, so the longest window ends at
      // the last sample. Asserted, not assumed: shortening the end of the
      // winning window must break it.
      const passes = startUs => headspeedSpread(built, startUs, logEnd) <= 0.12;

      let coarse = null;
      for (let offset = 0; offset <= 30e6; offset += 500_000) {
        if (passes(logStart + offset)) { coarse = offset; break; }
      }
      assert.ok(coarse !== null && coarse > 0, `no stationary window found: ${coarse}`);

      let boundary = coarse;
      for (let offset = coarse - 500_000 + 10_000; offset <= coarse; offset += 10_000) {
        if (passes(logStart + offset)) { boundary = offset; break; }
      }

      const longestUs = logEnd - (logStart + boundary);
      const spreadAtBoundary = headspeedSpread(built, logStart + boundary, logEnd);

      assert.ok(passes(logStart + boundary), 'the boundary must itself be stationary');
      assert.ok(
        !passes(logStart + boundary - 10_000),
        'one 0.01 s step earlier must fail, or this is not the boundary'
      );
      assert.equal(boundary, 12_740_000, `stationary boundary moved to ${boundary} us`);
      assert.equal(longestUs, 120_781_805, `longest stationary range moved to ${longestUs} us`);
      assert.ok(
        Math.abs(spreadAtBoundary - 0.11914) < 0.0005,
        `spread at the boundary moved: ${spreadAtBoundary}`
      );

      // The far edge is the recording, not the gate: cutting 5 s off the end
      // makes the same start non-stationary, so nothing about the aircraft
      // stopped the search — it ran out of log.
      assert.ok(
        headspeedSpread(built, logStart + boundary, logEnd - 5e6) > 0.12,
        'shortening the end should break stationarity, proving the end bounds it'
      );

      // The regression pin. A cap of 120 s rejects this window by 0.78 s.
      assert.ok(
        longestUs > 120e6,
        'the longest stationary range on this log is longer than 120 s'
      );
      assert.ok(
        MECHANICAL_CONSTANTS.maximumSelectionDurationUs >= longestUs,
        `the cap (${MECHANICAL_CONSTANTS.maximumSelectionDurationUs} us) rejects this `
          + `log's own longest stationary range (${longestUs} us)`
      );

      // And it is analysable, end to end, with the rotor correlated.
      const result = await analyzeMechanicalTimeSeries(built, {
        timeRangeUs: {startTimeUs: logStart + boundary, endTimeUs: logEnd}
      });
      assert.notEqual(result.status, 'insufficient');
      assert.equal(result.harmonicCorrelation.state, 'evaluated');
      assert.equal(result.rpmEvidence.headspeed.trustworthy, true);
      assert.ok(
        result.rpmEvidence.headspeed.relativeSpread <= 0.12,
        `the analysis measures the same spread the search did: ${
          result.rpmEvidence.headspeed.relativeSpread}`
      );
    });

    await t.test('the whole log is admitted and reports what it cannot conclude',
      async () => {
        const bounds = sessionTimeBounds(session);
        assert.ok(
          bounds.durationUs < MECHANICAL_CONSTANTS.maximumSelectionDurationUs,
          'this 133.5 s log is expected to fit under the selection cap'
        );
        const whole = await analyzeMechanicalSpectrum(session, {
          timeRangeUs: {startTimeUs: bounds.startTimeUs, endTimeUs: bounds.endTimeUs}
        });
        assert.ok(!whole.reasonCodes.includes('SELECTION_DURATION_LIMIT_EXCEEDED'));

        // Admitted, and still not correlatable: the spool-up and spool-down are
        // both inside it. The cap and the stationarity gate are different things
        // and this is the range that shows it.
        assert.equal(whole.harmonicCorrelation.state, 'unavailable');
        assert.equal(
          whole.rpmEvidence.headspeed.reasonCode, 'RPM_UNSTABLE_IN_SELECTION'
        );
        assert.notEqual(
          whole.rpmEvidence.headspeed.reasonCode, 'FIELD_MISSING',
          'the log carries headspeed on every sample'
        );
      });

    await t.test('a range where the rotor was stopped is not a range with no rotor column',
      async () => {
        // The first 4 s of this log carry 4,028 finite headspeed cells and not
        // one admissible rotor speed — the head is stopped. Reporting that as
        // FIELD_MISSING describes a column the log demonstrably has.
        const built = buildMechanicalSeries(session);
        const bounds = sessionTimeBounds(session);

        let finiteCells = 0;
        let admissibleCells = 0;
        for (let index = 0; index < built.timeUs.length; index += 1) {
          if (built.timeUs[index] > bounds.startTimeUs + 4e6) break;
          const rpm = built.headspeedRpm[index];
          if (Number.isFinite(rpm)) finiteCells += 1;
          if (Number.isFinite(rpm) && rpm > 0 && rpm <= 50_000) admissibleCells += 1;
        }
        assert.equal(finiteCells, 4028, `finite headspeed cells moved: ${finiteCells}`);
        assert.equal(admissibleCells, 0, 'the head is stopped across the first 4 s');

        const stopped = await analyzeMechanicalTimeSeries(built, {
          timeRangeUs: {startTimeUs: bounds.startTimeUs, endTimeUs: bounds.startTimeUs + 4e6}
        });
        assert.equal(
          stopped.rpmEvidence.headspeed.reasonCode, 'NO_VALID_RPM_IN_RANGE',
          'a stopped rotor is a fact about the range, not about the log'
        );
        assert.notEqual(stopped.rpmEvidence.headspeed.reasonCode, 'FIELD_MISSING');
        assert.equal(stopped.harmonicCorrelation.state, 'unavailable');
        // The absent column, on the same result, still says FIELD_MISSING.
        assert.equal(stopped.rpmEvidence.tailspeed.reasonCode, 'FIELD_MISSING');
      });

    await t.test('runs fast enough for a phone', async t2 => {
      const built = buildMechanicalSeries(session);
      const bounds = sessionTimeBounds(session);

      const timeRange = seconds => ({
        timeRangeUs: {
          startTimeUs: bounds.startTimeUs + 12.74e6,
          endTimeUs: Math.min(bounds.endTimeUs, bounds.startTimeUs + 12.74e6 + seconds * 1e6)
        }
      });

      const timed = async (label, work) => {
        const runs = [];
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const started = performance.now();
          await work();
          runs.push(performance.now() - started);
        }
        runs.sort((left, right) => left - right);
        t2.diagnostic(`${label}: median ${runs[2].toFixed(1)} ms `
          + `(min ${runs[0].toFixed(1)}, max ${runs[4].toFixed(1)})`);
        return runs[2];
      };

      const decodeMs = await timed('decode',
        async () => decodeLog(new Uint8Array(fs.readFileSync(REAL_LOG))));
      const shortMs = await timed('analyse 20 s',
        () => analyzeMechanicalTimeSeries(built, timeRange(20)));
      const longMs = await timed('analyse to the end of the log (120.8 s)',
        () => analyzeMechanicalTimeSeries(built, timeRange(1000)));
      const summaryMs = await timed('summarizeMechanicalVibration, 30 s',
        () => summarizeMechanicalVibration(built, timeRange(30)));

      // Generous ceilings: this is desktop Node and a phone WebView is several
      // times slower, so these catch an order-of-magnitude regression and
      // nothing subtler. The measured numbers are in the diagnostics above.
      assert.ok(decodeMs < 5000, `decode took ${decodeMs} ms`);
      assert.ok(shortMs < 1000, `a 20 s range took ${shortMs} ms`);
      assert.ok(longMs < 3000, `a 120.8 s range took ${longMs} ms`);
      assert.ok(summaryMs < 1000, `a 30 s summary took ${summaryMs} ms`);
    });

    await t.test('puts 2/rev where the logged headspeed predicts it', async () => {
      const bounds = sessionTimeBounds(session);
      const startTimeUs = bounds.startTimeUs + 40e6;
      const endTimeUs = startTimeUs + 20e6;
      const result = await analyzeMechanicalSpectrum(session, {
        timeRangeUs: {startTimeUs, endTimeUs}
      });

      assert.equal(result.status, 'clear');
      assert.equal(result.tuningEvidenceGate.status, 'permitted');
      assert.equal(result.axes.length, 3);

      // Frequency resolution is a derivation, not a constant: the log's median
      // interval sets the rate, chooseWindowSize sets the window.
      const {frequencyResolutionHz, resampledRateHz, windowSize} = result.quality;
      assert.equal(windowSize, 512);
      assert.ok(
        Math.abs(frequencyResolutionHz - resampledRateHz / windowSize) < 1e-3,
        `resolution ${frequencyResolutionHz} is not rate/window`
      );
      assert.ok(
        Math.abs(resampledRateHz - 1006.711) < 0.01,
        `993.33 us median interval implies ~1006.71 Hz, got ${resampledRateHz}`
      );

      // The rotor fundamental, computed here from the log's own headspeed
      // column over exactly this range, not read out of the analysis.
      const timeIndex = session.fields.find(field => field.name === 'time').index;
      const headspeedIndex = session.fields.find(field => field.name === 'headspeed').index;
      const inRange = session.samples
        .filter(row => row[timeIndex] >= startTimeUs && row[timeIndex] <= endTimeUs)
        .map(row => row[headspeedIndex])
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      const medianHeadspeedRpm = inRange[Math.floor(inRange.length / 2)];
      const fundamentalHz = medianHeadspeedRpm / 60;

      assert.ok(inRange.length > 19_000, `expected ~20k headspeed samples, got ${inRange.length}`);
      assert.ok(
        Math.abs(result.rpmEvidence.headspeed.fundamentalHz - fundamentalHz) < 0.05,
        `analysis fundamental ${result.rpmEvidence.headspeed.fundamentalHz} vs `
          + `independently measured ${fundamentalHz}`
      );
      assert.equal(result.rpmEvidence.tailspeed.available, false);
      assert.equal(result.rpmEvidence.tailspeed.reasonCode, 'FIELD_MISSING');

      const twoPerRevHz = 2 * fundamentalHz;
      for (const axis of result.axes) {
        assert.equal(axis.source, 'gyroRAW');

        // Every reported frequency must be a bin centre. Anything else means
        // the mapping from bin index to hertz has drifted.
        for (const peak of axis.peaks) {
          const bin = peak.frequencyHz / frequencyResolutionHz;
          assert.ok(
            Math.abs(bin - Math.round(bin)) < 0.01,
            `${axis.axis} peak ${peak.frequencyHz} Hz is not a bin centre`
          );
        }

        const twoPerRev = axis.peaks.find(
          peak => Math.abs(peak.frequencyHz - twoPerRevHz) <= frequencyResolutionHz
        );
        assert.ok(
          twoPerRev,
          `${axis.axis}: no peak within one bin of 2/rev (${twoPerRevHz.toFixed(2)} Hz); `
            + `peaks at ${axis.peaks.map(peak => peak.frequencyHz).join(', ')}`
        );
        assert.equal(
          twoPerRev.persistenceRatio, 1,
          `${axis.axis}: 2/rev should be present in every evaluated window`
        );
        assert.equal(twoPerRev.harmonicMatch.rotor, 'main');
        assert.equal(twoPerRev.harmonicMatch.order, 2);
      }

      // The Bell 222 is two-bladed, so the rotor's dominant vibration order is
      // 2/rev rather than 1/rev. This is a physical prediction about the
      // aircraft, checkable against the spectrum rather than copied from it.
      const roll = result.axes.find(axis => axis.axis === 'roll');
      const onePerRev = roll.peaks.find(
        peak => Math.abs(peak.frequencyHz - fundamentalHz) <= frequencyResolutionHz
      );
      const twoPerRevRoll = roll.peaks.find(
        peak => Math.abs(peak.frequencyHz - twoPerRevHz) <= frequencyResolutionHz
      );
      assert.ok(onePerRev, 'roll should also show 1/rev');
      assert.ok(
        twoPerRevRoll.bandRmsDps > onePerRev.bandRmsDps,
        `two-bladed head: 2/rev (${twoPerRevRoll.bandRmsDps}) should exceed `
          + `1/rev (${onePerRev.bandRmsDps})`
      );

      // Absolute band-RMS values on this log are not independently derivable,
      // so they are not asserted as constants. What is asserted is the gate
      // relation the status depends on.
      const strongest = Math.max(
        ...result.axes.flatMap(axis => axis.peaks.map(peak => peak.bandRmsDps))
      );
      assert.ok(
        strongest < MECHANICAL_CONSTANTS.attentionBandRmsThresholdDps,
        `status is clear, so every band RMS must be under the ${
          MECHANICAL_CONSTANTS.attentionBandRmsThresholdDps} dps gate; strongest ${strongest}`
      );

      // The analysed band is published, and it stops well short of where
      // bearing and gear-mesh signatures live on a 1 kHz log.
      assert.equal(result.analyzedBandHz[0], 5);
      assert.ok(
        Math.abs(result.analyzedBandHz[1] - resampledRateHz * 0.45) < 0.02,
        `analysed band should top out at 0.45*fs, got ${result.analyzedBandHz[1]}`
      );
      assert.ok(result.analyzedBandHz[1] < 460);
    });
  });
