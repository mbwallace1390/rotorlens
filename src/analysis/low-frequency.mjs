/**
 * Low-frequency relationships between two logged signals: Welch magnitude-
 * squared coherence at one frequency, and a correlation whose significance is
 * judged on an effective sample count.
 *
 * Added for Stage 5b (4 October 2026), for two questions the hold analysis
 * could not ask before:
 *
 *   - Is a slow wobble in the rate error COHERENT WITH THE STICK? An integrator
 *     that hunts on its own makes an oscillation the stick did not; a pilot
 *     making small corrections makes one the stick did. On the 31 admissible
 *     real flights, 66-76 % of the cyclic hover wobble was coherent with the
 *     stick (the Stage 5 lag-and-wobble study), and the shipped hunting tests
 *     — a crossing rate in band, an I-term share of the ripple — passed in 94
 *     and 107 of 108 quiet windows, so neither could tell the two apart.
 *   - Does a slow signal MOVE WITH another one inside the holds — the yaw
 *     integrator with the collective, say — by more than two slowly varying
 *     signals drift together by chance?
 *
 * MEASUREMENT ONLY. Nothing here reads a gain or says what any number means for
 * one; `src/analysis/recommendations.mjs` decides that, behind its gates. The
 * cut-offs a caller compares these numbers with are null-hypothesis levels — the
 * value a quantity reaches by chance at a stated false-alarm rate alpha when the
 * two signals are unrelated — computed here from alpha and the evidence count.
 * They are not thresholds tuned on any flight.
 *
 * Written from the published definitions (Welch 1967; Bartlett 1946; Bretherton
 * et al. 1999; Fisher's z; Abramowitz and Stegun 7.1.26), not taken from another
 * module's private code or
 * from any other project. Platform-neutral: Math, Number, Array and Object only.
 * Explicit loops throughout — a two-minute hover is a hundred thousand samples
 * and nothing here spreads an array into an argument list.
 */

/**
 * Correlation between two Hann windows that overlap by half their length.
 *
 * DERIVED, not chosen. With w(t) = sin^2(pi t / L) on [0, L], the overlap
 * integral of w(t) w(t + L/2) over [0, L/2] is L/16 and the integral of w(t)^2
 * over [0, L] is 3L/8, so the ratio is (L/16) / (3L/8) = 1/6. For a stationary
 * Gaussian signal the correlation between the two segments' spectral estimates
 * is the SQUARE of this (Welch 1967), and it is what makes overlapping segments
 * worth less than independent ones; see `effectiveWelchSegments`.
 */
export const HANN_HALF_OVERLAP_CORRELATION = 1 / 6;

/**
 * Fewest samples a Welch segment may hold and still be measured. Four points
 * fix a line and leave two to carry anything about it; under that the detrend
 * has eaten the segment. Segments from a log are thousands of samples long, so
 * this only ever refuses a broken input.
 */
const MINIMUM_SEGMENT_SAMPLES = 8;

/**
 * Lowest frequency a Welch segment of `segmentUs` can resolve: two full cycles.
 *
 * DERIVED. A Hann window's spectral main lobe reaches 2/L either side of the
 * frequency it is evaluated at. Below 2/L that lobe takes in zero frequency,
 * which the per-segment detrend has just removed, so the estimate there is
 * of whatever the detrend left behind rather than of the frequency asked for.
 */
export function lowestResolvedFrequencyHz(segmentUs) {
  return segmentUs > 0 ? 2 / (segmentUs / 1_000_000) : Number.POSITIVE_INFINITY;
}

/**
 * Effective number of independent segments in a run of `count` Hann segments
 * overlapping by half.
 *
 * Welch (1967): adjacent half-overlapping segments' estimates are correlated by
 * rho^2, with rho = HANN_HALF_OVERLAP_CORRELATION, and segments further apart
 * do not overlap. The variance of their average is that of
 * count / (1 + 2 (1 - 1/count) rho^2) independent segments.
 */
export function effectiveWelchSegments(count) {
  if (!(count >= 1)) {
    return 0;
  }
  const rhoSquared = HANN_HALF_OVERLAP_CORRELATION * HANN_HALF_OVERLAP_CORRELATION;
  return count / (1 + 2 * (1 - 1 / count) * rhoSquared);
}

/**
 * The magnitude-squared coherence that two UNRELATED signals exceed with
 * probability `alpha`, from `effectiveSegments` averaged segments.
 *
 * For n independent segments of Gaussian signals with no common component, the
 * estimated coherence C satisfies P(C > c) = (1 - c)^(n - 1), so the level
 * exceeded by chance with probability alpha is 1 - alpha^(1 / (n - 1)). An
 * effective count from `effectiveWelchSegments` stands in for n, which is the
 * usual approximation for overlapping segments. One segment's coherence is
 * identically 1, so with n <= 1 the level is 1 and nothing can be shown.
 */
export function coherenceNullLevel(alpha, effectiveSegments) {
  if (!(alpha > 0 && alpha < 1) || !(effectiveSegments > 1)) {
    return 1;
  }
  return 1 - alpha ** (1 / (effectiveSegments - 1));
}

/** Least-squares line through (time, value) pairs; times in seconds. */
function lineThrough(times, values, from, to) {
  let count = 0;
  let timeTotal = 0;
  let valueTotal = 0;
  for (let index = from; index < to; index += 1) {
    count += 1;
    timeTotal += times[index];
    valueTotal += values[index];
  }
  const timeMean = timeTotal / count;
  const valueMean = valueTotal / count;
  let covariance = 0;
  let variance = 0;
  for (let index = from; index < to; index += 1) {
    const dt = times[index] - timeMean;
    covariance += dt * (values[index] - valueMean);
    variance += dt * dt;
  }
  const slope = variance > 0 ? covariance / variance : 0;
  return {timeMean, valueMean, slope};
}

/**
 * Windowed, detrended Fourier coefficient of one segment at `frequencyHz`.
 *
 * Evaluated directly at the one frequency asked for rather than on an FFT grid,
 * on the samples' own timestamps, each weighted by the time it stands for, so a
 * log whose sample interval jitters is not treated as evenly spaced.
 */
function segmentCoefficient(seconds, values, from, to, startSeconds, lengthSeconds, frequencyHz) {
  const line = lineThrough(seconds, values, from, to);
  let real = 0;
  let imaginary = 0;
  for (let index = from; index < to; index += 1) {
    const local = seconds[index] - startSeconds;
    const previous = index > from ? seconds[index - 1] : seconds[index];
    const next = index < to - 1 ? seconds[index + 1] : seconds[index];
    const weight = (next - previous) / 2 || 0;
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * local) / lengthSeconds);
    const detrended = values[index] - (line.valueMean + line.slope * (seconds[index] - line.timeMean));
    const amplitude = window * weight * detrended;
    const phase = 2 * Math.PI * frequencyHz * local;
    real += amplitude * Math.cos(phase);
    imaginary -= amplitude * Math.sin(phase);
  }
  return {real, imaginary};
}

/**
 * Welch magnitude-squared coherence between `x` and `y` at one frequency,
 * pooled over every segment of every stretch.
 *
 * @param {{timesUs: number[], x: number[], y: number[]}[]} stretches
 *   time-aligned samples, timestamps increasing within each stretch. Stretches
 *   are never joined: a segment never spans two of them.
 * @param {{segmentUs: number, frequencyHz: number}} options
 * @returns {{state: string, coherence: number|null, segmentCount: number,
 *   effectiveSegments: number, frequencyHz: number, segmentUs: number}}
 *
 * Each stretch is cut into segments of `segmentUs` overlapping by half; each
 * segment has its own least-squares line removed from both signals and a Hann
 * window applied; the cross- and auto-spectra at `frequencyHz` are summed over
 * all segments, and the coherence is |Sxy|^2 / (Sxx Syy).
 *
 * `state` says what was measured:
 *   'measured'                    a coherence from two or more segments
 *   'frequency-below-resolution'  under two cycles per segment; see
 *                                 `lowestResolvedFrequencyHz`
 *   'too-few-segments'            fewer than two segments fitted in the stretches
 *   'x-still' / 'y-still'         one signal had nothing at all at that
 *                                 frequency, so nothing could be common to both;
 *                                 the coherence is reported as 0
 */
export function welchCoherence(stretches, {segmentUs, frequencyHz} = {}) {
  const base = {segmentUs, frequencyHz};
  if (!(segmentUs > 0) || !(frequencyHz > 0)) {
    return Object.freeze({...base, state: 'frequency-below-resolution', coherence: null,
      segmentCount: 0, effectiveSegments: 0});
  }
  if (frequencyHz < lowestResolvedFrequencyHz(segmentUs)) {
    return Object.freeze({...base, state: 'frequency-below-resolution', coherence: null,
      segmentCount: 0, effectiveSegments: 0});
  }

  const lengthSeconds = segmentUs / 1_000_000;
  let sxx = 0;
  let syy = 0;
  let sxyReal = 0;
  let sxyImaginary = 0;
  let segmentCount = 0;
  let effectiveSegments = 0;

  for (const stretch of Array.isArray(stretches) ? stretches : []) {
    const times = stretch?.timesUs ?? [];
    const length = Math.min(times.length, stretch?.x?.length ?? 0, stretch?.y?.length ?? 0);
    if (length < MINIMUM_SEGMENT_SAMPLES) {
      continue;
    }
    // Only samples where all three are numbers, in order.
    const seconds = [];
    const xs = [];
    const ys = [];
    for (let index = 0; index < length; index += 1) {
      if (Number.isFinite(times[index]) && Number.isFinite(stretch.x[index])
          && Number.isFinite(stretch.y[index])) {
        seconds.push(times[index] / 1_000_000);
        xs.push(stretch.x[index]);
        ys.push(stretch.y[index]);
      }
    }
    if (seconds.length < MINIMUM_SEGMENT_SAMPLES) {
      continue;
    }
    const first = seconds[0];
    const span = seconds[seconds.length - 1] - first;
    if (span < lengthSeconds) {
      continue;
    }
    const count = Math.floor((span - lengthSeconds) / (lengthSeconds / 2)) + 1;
    let used = 0;
    let cursor = 0;
    for (let segment = 0; segment < count; segment += 1) {
      const startSeconds = first + segment * (lengthSeconds / 2);
      const endSeconds = startSeconds + lengthSeconds;
      while (cursor < seconds.length && seconds[cursor] < startSeconds) {
        cursor += 1;
      }
      let stop = cursor;
      while (stop < seconds.length && seconds[stop] < endSeconds) {
        stop += 1;
      }
      if (stop - cursor < MINIMUM_SEGMENT_SAMPLES) {
        continue;
      }
      const cx = segmentCoefficient(seconds, xs, cursor, stop, startSeconds, lengthSeconds, frequencyHz);
      const cy = segmentCoefficient(seconds, ys, cursor, stop, startSeconds, lengthSeconds, frequencyHz);
      sxx += cx.real * cx.real + cx.imaginary * cx.imaginary;
      syy += cy.real * cy.real + cy.imaginary * cy.imaginary;
      // X times the conjugate of Y.
      sxyReal += cx.real * cy.real + cx.imaginary * cy.imaginary;
      sxyImaginary += cx.imaginary * cy.real - cx.real * cy.imaginary;
      used += 1;
    }
    segmentCount += used;
    effectiveSegments += effectiveWelchSegments(used);
  }

  const result = state => Object.freeze({
    ...base,
    state,
    coherence: state === 'measured'
      ? Math.round(((sxyReal * sxyReal + sxyImaginary * sxyImaginary) / (sxx * syy)) * 1e4) / 1e4
      : (state === 'x-still' || state === 'y-still' ? 0 : null),
    segmentCount,
    effectiveSegments: Math.round(effectiveSegments * 1e4) / 1e4
  });

  if (segmentCount < 2) {
    return result('too-few-segments');
  }
  if (!(sxx > 0)) {
    return result('x-still');
  }
  if (!(syy > 0)) {
    return result('y-still');
  }
  return result('measured');
}

/**
 * Two-sided tail probability of a standard normal variate: P(|Z| > |z|).
 *
 * Abramowitz and Stegun 7.1.26 for erfc(|z| / sqrt 2), absolute error under
 * 1.5e-7 — far finer than any significance level this is compared with. The
 * handbook is a US government publication.
 */
export function normalTwoSidedP(z) {
  if (!Number.isFinite(z)) {
    return Number.isNaN(z) ? null : 0;
  }
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741
    + t * (-1.453152027 + t * 1.061405429))));
  return Math.min(1, Math.max(0, polynomial * Math.exp(-x * x)));
}

/** Block means of `values`, `size` samples a block; a partial last block is dropped. */
function blockMeans(values, size) {
  if (!(size > 1)) {
    return [...values];
  }
  const out = [];
  for (let start = 0; start + size <= values.length; start += size) {
    let total = 0;
    for (let index = start; index < start + size; index += 1) {
      total += values[index];
    }
    out.push(total / size);
  }
  return out;
}

/**
 * Pearson correlation of two signals pooled over several stretches, with its
 * significance judged on an EFFECTIVE sample count.
 *
 * Two slowly varying signals are correlated by chance far more often than
 * their raw sample count suggests: a thousand samples of a signal that changes
 * once a second are a handful of independent observations. Bartlett (1946)
 * gives the variance of the sample correlation of two independent
 * autocorrelated series as (1 + 2 sum_k rho_x(k) rho_y(k)) / n. For series
 * whose autocorrelation falls off as a first-order process, rho(k) = phi^k, the
 * sum closes to the count Bretherton et al. (1999) give,
 *
 *   n_eff = n (1 - phi_x phi_y) / (1 + phi_x phi_y),
 *
 * with phi each series' lag-one autocorrelation. That form is used, per
 * stretch, rather than the lag-by-lag sum, and the choice was MEASURED, not
 * assumed (4 October 2026). Over pairs of UNRELATED first-order series with
 * time constants of 0.5, 2 and 5 s, in three stretches of 5-17 s at 148 ms
 * blocks, 2,000 draws each, the lag-by-lag sum (truncated where its products
 * stop being positive) called them related at alpha 0.05 in 7.3 %, 12.9 % and
 * 21.4 % of draws; this form in 6.5 %, 10.0 % and 15.1 %. Neither reaches alpha
 * for signals nearly as slow as the stretches, because a lag-one autocorrelation
 * taken over a stretch only a few time constants long reads low; this one is
 * closer, and it errs toward calling slow signals related — for a guard that
 * refuses a verdict, the side to err on. `test/low-frequency.test.mjs` sweeps
 * it. The count is never allowed to exceed the raw one.
 *
 * Each stretch's own mean is removed before pooling, so two stretches flown at
 * different levels cannot manufacture a correlation between them.
 *
 * @param {{x: number[], y: number[]}[]} stretches sample-aligned pairs
 * @param {{blockSize?: number}} [options] samples averaged per point before
 *   anything is computed; 1 (the default) uses every sample
 * @returns {{state: string, correlation: number|null, sampleCount: number,
 *   effectiveCount: number|null, fisherZ: number|null, pValue: number|null}}
 *
 * `state`: 'measured'; 'x-still' or 'y-still' when one signal never moved, so
 * nothing about it can move with the other (correlation 0, pValue 1); or
 * 'too-few-effective-samples' when the effective count is 3 or fewer, which
 * Fisher's z cannot test. pValue is two-sided, from Fisher's z on the effective
 * count, for the hypothesis that the signals are unrelated.
 */
export function effectiveCorrelation(stretches, {blockSize = 1} = {}) {
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  let sampleCount = 0;
  let effectiveCount = 0;

  for (const stretch of Array.isArray(stretches) ? stretches : []) {
    const length = Math.min(stretch?.x?.length ?? 0, stretch?.y?.length ?? 0);
    const xRaw = [];
    const yRaw = [];
    for (let index = 0; index < length; index += 1) {
      if (Number.isFinite(stretch.x[index]) && Number.isFinite(stretch.y[index])) {
        xRaw.push(stretch.x[index]);
        yRaw.push(stretch.y[index]);
      }
    }
    const xs = blockMeans(xRaw, blockSize);
    const ys = blockMeans(yRaw, blockSize);
    const n = xs.length;
    if (n < 2) {
      continue;
    }
    let xMean = 0;
    let yMean = 0;
    for (let index = 0; index < n; index += 1) {
      xMean += xs[index];
      yMean += ys[index];
    }
    xMean /= n;
    yMean /= n;
    let ownXX = 0;
    let ownYY = 0;
    let xLagOne = 0;
    let yLagOne = 0;
    for (let index = 0; index < n; index += 1) {
      xs[index] -= xMean;
      ys[index] -= yMean;
    }
    for (let index = 0; index < n; index += 1) {
      sxy += xs[index] * ys[index];
      ownXX += xs[index] * xs[index];
      ownYY += ys[index] * ys[index];
      if (index + 1 < n) {
        xLagOne += xs[index] * xs[index + 1];
        yLagOne += ys[index] * ys[index + 1];
      }
    }
    sxx += ownXX;
    syy += ownYY;
    sampleCount += n;

    // The effective count for this stretch; see the docstring.
    const product = ownXX > 0 && ownYY > 0 ? (xLagOne / ownXX) * (yLagOne / ownYY) : 0;
    const bounded = Math.max(-0.999, Math.min(0.999, product));
    effectiveCount += Math.min(n, (n * (1 - bounded)) / (1 + bounded));
  }

  const rounded = (value, places) => (Number.isFinite(value)
    ? Math.round(value * 10 ** places) / 10 ** places : null);
  const out = (state, correlation, fisherZ, pValue) => Object.freeze({
    state,
    correlation: rounded(correlation, 4),
    sampleCount,
    effectiveCount: rounded(effectiveCount, 2),
    fisherZ: rounded(fisherZ, 4),
    pValue: rounded(pValue, 6)
  });

  if (sampleCount < 2) {
    return out('too-few-effective-samples', null, null, null);
  }
  if (!(sxx > 0)) {
    return out('x-still', 0, 0, 1);
  }
  if (!(syy > 0)) {
    return out('y-still', 0, 0, 1);
  }
  const correlation = Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
  if (!(effectiveCount > 3)) {
    return out('too-few-effective-samples', correlation, null, null);
  }
  // Fisher's z: atanh(r) is close to normal with variance 1 / (n - 3).
  const clipped = Math.max(-0.999999, Math.min(0.999999, correlation));
  const fisherZ = 0.5 * Math.log((1 + clipped) / (1 - clipped)) * Math.sqrt(effectiveCount - 3);
  return out('measured', correlation, fisherZ, normalTwoSidedP(fisherZ));
}
