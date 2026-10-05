/**
 * The low-frequency measurements Stage 5b's two hold guards rest on: Welch
 * coherence at one frequency, and a correlation judged on an effective sample
 * count.
 *
 * What these tests prove is that the NULL LEVELS ARE RIGHT: that two unrelated
 * signals cross the alpha level about alpha of the time, swept over thousands of
 * random draws, and that related ones cross it. That is the whole claim a
 * "statistical null, not a tuned threshold" makes, so it is what is measured.
 * Nothing here is calibrated on a flight.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HANN_HALF_OVERLAP_CORRELATION,
  coherenceNullLevel,
  effectiveCorrelation,
  effectiveWelchSegments,
  lowestResolvedFrequencyHz,
  normalTwoSidedP,
  welchCoherence
} from '../src/analysis/low-frequency.mjs';
import {COLLECTIVE_GUARD_FALSE_ALARM} from '../src/analysis/recommendations.mjs';

/** Deterministic PRNG, so a sweep is the same sweep every run. */
function rng(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Standard normal draws, Box-Muller. */
function gaussian(random) {
  return () => {
    const u = Math.max(random(), 1e-12);
    const v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

/** One stretch sampled at `rateHz` for `seconds`, starting at `startUs`. */
function stretchOf(seconds, rateHz, xOf, yOf, startUs = 0) {
  const timesUs = [];
  const x = [];
  const y = [];
  const count = Math.round(seconds * rateHz);
  for (let index = 0; index < count; index += 1) {
    const t = index / rateHz;
    timesUs.push(startUs + Math.round(t * 1e6));
    x.push(xOf(t, index));
    y.push(yOf(t, index));
  }
  return {timesUs, x, y};
}

test('the Hann half-overlap correlation is derived, and overlap is counted at its worth', () => {
  // Numerical check of the 1/6 derived in the module, on a fine grid.
  const steps = 200_000;
  let overlap = 0;
  let energy = 0;
  for (let index = 0; index < steps; index += 1) {
    const t = (index + 0.5) / steps;
    const w = Math.sin(Math.PI * t) ** 2;
    energy += w * w;
    if (t < 0.5) {
      overlap += w * Math.sin(Math.PI * (t + 0.5)) ** 2;
    }
  }
  assert.ok(Math.abs(overlap / energy - HANN_HALF_OVERLAP_CORRELATION) < 1e-6);
  assert.equal(effectiveWelchSegments(1), 1);
  assert.ok(effectiveWelchSegments(7) < 7 && effectiveWelchSegments(7) > 6.5);
  assert.equal(effectiveWelchSegments(0), 0);
});

test('a common component reads as coherent whatever its phase, and noise does not', () => {
  const draw = gaussian(rng(7));
  const f = 1.2;
  for (const lagS of [0, 0.05, 0.2, 0.4]) {
    const stretches = [0, 1, 2].map(at => stretchOf(9, 200,
      t => Math.sin(2 * Math.PI * f * t) + 0.2 * draw(),
      t => 0.7 * Math.sin(2 * Math.PI * f * (t - lagS)) + 0.2 * draw(), at * 20e6));
    const result = welchCoherence(stretches, {segmentUs: 2_560_000, frequencyHz: f});
    assert.equal(result.state, 'measured');
    assert.ok(result.coherence > 0.9, `lag ${lagS}: ${result.coherence}`);
    assert.ok(result.coherence > coherenceNullLevel(0.01, result.effectiveSegments));
  }
});

test('two unrelated signals cross the alpha level about alpha of the time', () => {
  // The claim behind calling the cut-off a null level: swept over 1,200 random
  // flights of three holds each, the coherence of two independent noises at a
  // hunting frequency exceeds the alpha level close to alpha of the time, at
  // both segment lengths and both alphas the hold sweep uses.
  // The level itself, from P(C > c) = (1 - c)^(n - 1): five segments at alpha
  // 0.05 is 1 - 0.05^(1/4).
  assert.ok(Math.abs(coherenceNullLevel(0.05, 5) - (1 - 0.05 ** 0.25)) < 1e-12);
  assert.ok(Math.abs((1 - coherenceNullLevel(0.01, 9)) ** 8 - 0.01) < 1e-12);

  const random = rng(20261004);
  const draw = gaussian(random);
  for (const segmentUs of [2_560_000, 5_120_000]) {
    const hits = {0.01: 0, 0.05: 0};
    const trials = 1200;
    for (let trial = 0; trial < trials; trial += 1) {
      const lengths = [6 + random() * 8, 6 + random() * 8, 6 + random() * 8];
      const stretches = lengths.map((seconds, at) => stretchOf(seconds, 100,
        () => draw(), () => draw(), at * 30e6));
      const f = 0.8 + random() * 2;
      const result = welchCoherence(stretches, {segmentUs, frequencyHz: f});
      if (result.state !== 'measured') {
        continue;
      }
      for (const alpha of [0.01, 0.05]) {
        if (result.coherence > coherenceNullLevel(alpha, result.effectiveSegments)) {
          hits[alpha] += 1;
        }
      }
    }
    const rate05 = hits[0.05] / trials;
    const rate01 = hits[0.01] / trials;
    assert.ok(rate05 > 0.025 && rate05 < 0.07, `segment ${segmentUs}: alpha 0.05 fired ${rate05}`);
    assert.ok(rate01 < 0.02, `segment ${segmentUs}: alpha 0.01 fired ${rate01}`);
  }
});

test('coherence is refused where it cannot be measured, and never invented', () => {
  const sine = t => Math.sin(2 * Math.PI * 1 * t);
  // Under two cycles a segment: the detrend removed what is there.
  assert.equal(lowestResolvedFrequencyHz(2_560_000), 2 / 2.56);
  const slow = welchCoherence([stretchOf(20, 100, sine, sine)],
    {segmentUs: 2_560_000, frequencyHz: 0.5});
  assert.equal(slow.state, 'frequency-below-resolution');
  assert.equal(slow.coherence, null);

  // Two stretches each shorter than a segment: a segment never spans a gap
  // between holds, so nothing is measured even though their total is long.
  const short = welchCoherence([stretchOf(2, 100, sine, sine), stretchOf(2, 100, sine, sine, 10e6)],
    {segmentUs: 2_560_000, frequencyHz: 1});
  assert.equal(short.state, 'too-few-segments');
  assert.equal(short.coherence, null);

  // One segment's coherence is 1 by construction, so one is not enough.
  const one = welchCoherence([stretchOf(2.7, 100, sine, t => Math.cos(t))],
    {segmentUs: 2_560_000, frequencyHz: 1});
  assert.equal(one.state, 'too-few-segments');
  assert.equal(coherenceNullLevel(0.05, 1), 1);

  // A stick that never moved has nothing in common with anything.
  const still = welchCoherence([stretchOf(12, 100, () => 0, sine)],
    {segmentUs: 2_560_000, frequencyHz: 1});
  assert.equal(still.state, 'x-still');
  assert.equal(still.coherence, 0);
});

test('a slow drift both signals share is not read as coherence at a hunting frequency', () => {
  // Each Welch segment has its own line removed before the window. Without it a
  // ramp both signals ride — a stick and an error both drifting through a hold —
  // leaks into every frequency, and two signals that share nothing at 1.3 Hz
  // read as coherent there.
  const draw = gaussian(rng(31));
  const stretches = [0, 1, 2].map(at => stretchOf(10, 200,
    t => 40 * t + draw(), t => -30 * t + draw(), at * 20e6));
  const result = welchCoherence(stretches, {segmentUs: 2_560_000, frequencyHz: 1.3});
  assert.equal(result.state, 'measured');
  assert.ok(result.coherence < coherenceNullLevel(0.05, result.effectiveSegments),
    `drift read as coherence: ${result.coherence}`);
});

test('jittered sample times are measured on their own clock', () => {
  // A real log's interval wanders. The same signals sampled unevenly must give
  // the same answer as evenly.
  const random = rng(11);
  const draw = gaussian(rng(12));
  const f = 1.5;
  const even = stretchOf(12, 250, t => Math.sin(2 * Math.PI * f * t), t => Math.sin(2 * Math.PI * f * t));
  const timesUs = [];
  const x = [];
  const y = [];
  let t = 0;
  while (t < 12) {
    timesUs.push(Math.round(t * 1e6));
    x.push(Math.sin(2 * Math.PI * f * t) + 0.3 * draw());
    y.push(Math.sin(2 * Math.PI * f * t + 0.5) + 0.3 * draw());
    t += 0.002 + random() * 0.006;
  }
  const evenResult = welchCoherence([even], {segmentUs: 2_560_000, frequencyHz: f});
  const jittered = welchCoherence([{timesUs, x, y}], {segmentUs: 2_560_000, frequencyHz: f});
  assert.ok(evenResult.coherence > 0.99);
  assert.ok(jittered.coherence > 0.95, String(jittered.coherence));
});

test('the normal tail matches its tabulated values', () => {
  assert.ok(Math.abs(normalTwoSidedP(1.959964) - 0.05) < 1e-5);
  assert.ok(Math.abs(normalTwoSidedP(2.575829) - 0.01) < 1e-5);
  assert.ok(Math.abs(normalTwoSidedP(-1.644854) - 0.10) < 1e-5);
  assert.equal(normalTwoSidedP(0) > 0.999999, true);
  assert.equal(normalTwoSidedP(Number.POSITIVE_INFINITY), 0);
});

/** A slowly varying random series: AR(1) at `rateHz` with time constant `tauS`. */
function slowSeries(count, rateHz, tauS, draw) {
  const a = Math.exp(-1 / (rateHz * tauS));
  const out = [];
  let value = 0;
  for (let index = 0; index < count; index += 1) {
    value = a * value + Math.sqrt(1 - a * a) * draw();
    out.push(value);
  }
  return out;
}

test('two slow, unrelated signals are not called correlated more than alpha of the time', () => {
  // Raw sample counts make slow signals look related: on these series the
  // naive test (n - 3 in Fisher's z) fires on most draws. The effective count
  // brings the false-alarm rate back near alpha. Swept over 1,000 draws a time
  // constant, three stretches of 5-17 s averaged into 148 ms blocks — the shape
  // of the yaw holds the collective guard reads.
  const random = rng(4242);
  const draw = gaussian(random);
  const blockRateHz = 1 / 0.148;
  const rates = {};
  for (const tauS of [0.5, 2, 5]) {
    let effectiveHits = 0;
    let naiveHits = 0;
    const trials = 1000;
    for (let trial = 0; trial < trials; trial += 1) {
      const stretches = [0, 1, 2].map(() => {
        const n = Math.round((5 + random() * 12) * blockRateHz);
        return {x: slowSeries(n, blockRateHz, tauS, draw), y: slowSeries(n, blockRateHz, tauS, draw)};
      });
      const result = effectiveCorrelation(stretches);
      assert.ok(result.effectiveCount <= result.sampleCount);
      if (result.state === 'measured' && result.pValue < 0.05) {
        effectiveHits += 1;
      }
      const naiveZ = Math.atanh(result.correlation) * Math.sqrt(result.sampleCount - 3);
      if (normalTwoSidedP(naiveZ) < 0.05) {
        naiveHits += 1;
      }
    }
    rates[tauS] = {effective: effectiveHits / trials, naive: naiveHits / trials};
  }
  assert.ok(rates[2].naive > 0.4, `the naive test must be the failure it is: ${JSON.stringify(rates)}`);
  assert.ok(rates[0.5].effective < 0.08, JSON.stringify(rates));
  // Signals nearly as slow as the stretches themselves: their lag-one
  // autocorrelation reads low over so few time constants, and the test runs
  // high — toward calling them related, which for a guard that refuses a
  // verdict is the side to err on. Measured, and bounded so a change that makes
  // it worse is seen; the module's docstring has the numbers.
  assert.ok(rates[2].effective < 0.13, JSON.stringify(rates));
  assert.ok(rates[5].effective < 0.18, JSON.stringify(rates));
  // The collective guard's card quotes this rate, not alpha, for signals as slow
  // as the holds it reads (review of round one; COLLECTIVE_GUARD_FALSE_ALARM).
  // The 2 s and 5 s series must sit in the range it quotes, or the card is wrong.
  const quoted = COLLECTIVE_GUARD_FALSE_ALARM ?? {};
  assert.equal(quoted.alpha, 0.05);
  assert.ok(rates[2].effective >= quoted.low - 0.03 && rates[2].effective <= quoted.high + 0.03,
    JSON.stringify({rates, quoted}));
  assert.ok(rates[5].effective >= quoted.low - 0.03 && rates[5].effective <= quoted.high + 0.03,
    JSON.stringify({rates, quoted}));
  for (const tauS of [0.5, 2, 5]) {
    assert.ok(rates[tauS].effective < rates[tauS].naive / 2, JSON.stringify(rates));
  }
});

test('a signal that moves with another is called correlated, with its sign', () => {
  const random = rng(77);
  const draw = gaussian(random);
  const stretches = [0, 1, 2].map(() => {
    const x = slowSeries(500, 50, 0.6, draw);
    return {x, y: x.map(value => -0.6 * value + 0.3 * draw())};
  });
  const result = effectiveCorrelation(stretches);
  assert.equal(result.state, 'measured');
  assert.ok(result.correlation < -0.8, String(result.correlation));
  assert.ok(result.pValue < 0.01, String(result.pValue));

  // Averaging into blocks keeps the answer and the count honest.
  const blocked = effectiveCorrelation(stretches, {blockSize: 10});
  assert.ok(blocked.correlation < -0.8);
  assert.equal(blocked.sampleCount, 150);
});

test('a correlation is refused where it cannot be tested', () => {
  const still = effectiveCorrelation([{x: [1, 1, 1, 1, 1, 1], y: [1, 2, 3, 4, 5, 6]}]);
  assert.equal(still.state, 'x-still');
  assert.equal(still.correlation, 0);
  assert.equal(still.pValue, 1);

  const few = effectiveCorrelation([{x: [1, 2, 3], y: [2, 1, 3]}]);
  assert.equal(few.state, 'too-few-effective-samples');
  assert.equal(few.pValue, null);

  // Stretches at different levels do not correlate merely by being apart.
  const draw = gaussian(rng(5));
  const levels = [0, 100, 200].map(level => ({
    x: Array.from({length: 200}, () => level + draw()),
    y: Array.from({length: 200}, () => level + draw())
  }));
  assert.ok(Math.abs(effectiveCorrelation(levels).correlation) < 0.2);
});
