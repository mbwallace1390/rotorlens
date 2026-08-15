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
import {makePackage} from '../src/analysis/advisor/evidence-contract.mjs';
import {detectPitchPumps} from '../src/analysis/advisor/deterministic-metrics.mjs';

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
        assert.ok(['explained', 'not-explained', 'not-checked']
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
