/**
 * The metrics ported from the fork.
 *
 * The originals were covered by `test/advisor_metrics.js` over there, which
 * cannot come with them: it loads the GPL viewer's parser through `vm` to build
 * its inputs, and pulling that in is the one thing this repository exists to
 * avoid. These are written here instead, against the same functions.
 *
 * The conversion from UMD to an ES module was mechanical, so what needs proving
 * is that the arithmetic survived it — every expected value below is computed by
 * hand, never by running the code and pasting what it said.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildActiveRanges,
  mean,
  quantile,
  rms,
  summarizeTracking
} from '../src/analysis/advisor/deterministic-metrics.mjs';

import {
  EvidenceBuilder,
  SCHEMA_VERSION,
  compact,
  makePackage,
  roundNumber
} from '../src/analysis/advisor/evidence-contract.mjs';

test('mean, rms and quantile agree with hand arithmetic', () => {
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(mean([-5, 5]), 0);

  // sqrt((9 + 16) / 2) = sqrt(12.5)
  assert.ok(Math.abs(rms([3, 4]) - Math.sqrt(12.5)) < 1e-12);
  assert.equal(rms([0, 0, 0]), 0);

  assert.equal(quantile([1, 2, 3, 4], 0), 1, 'the 0th quantile is the minimum');
  assert.equal(quantile([1, 2, 3, 4], 1), 4, 'the 1st quantile is the maximum');
  // Interpolated: index = (4 - 1) * 0.5 = 1.5, so halfway between 2 and 3.
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([10, 20, 30], 0.5), 20);
});

test('quantile takes a fraction, and clamps anything larger to the maximum', () => {
  // Pinning the convention deliberately. `quantile(values, 95)` reads like a
  // 95th percentile and silently returns the maximum instead, because the input
  // is clamped to 1. Callers must pass 0.95. This matches src/analysis/
  // pid-evidence.mjs, so the two agree — but the trap is real and undocumented
  // behaviour is how it gets sprung.
  assert.equal(quantile([1, 2, 3, 4], 95), 4, 'a percentile-looking argument clamps to the max');
  assert.equal(quantile([1, 2, 3, 4], -5), 1, 'and a negative one clamps to the min');
  // index = 3 * 0.95 = 2.85, so 3 + (4 - 3) * 0.85. Compared with a tolerance
  // because 3 * 0.95 is 2.8499999999999996 in binary floating point, and an
  // exact comparison here would be asserting the arithmetic of the machine
  // rather than the behaviour of the function.
  assert.ok(Math.abs(quantile([1, 2, 3, 4], 0.95) - 3.85) < 1e-9);
});

test('the numeric helpers refuse to invent a value', () => {
  // A flight log is full of gaps: a field that was not logged, a frame that was
  // skipped. Returning 0 for "no data" would put a confident number on a screen
  // that describes nothing.
  for (const empty of [[], [NaN], [undefined], [null]]) {
    assert.equal(mean(empty), null, `mean(${JSON.stringify(empty)})`);
    assert.equal(rms(empty), null, `rms(${JSON.stringify(empty)})`);
    assert.equal(quantile(empty, 0.5), null, `quantile(${JSON.stringify(empty)})`);
  }

  assert.equal(mean([1, NaN, 3]), 2, 'non-finite samples are skipped, not counted');
});

test('active ranges cover armed flight and nothing else', () => {
  // `state === 4` is armed. A range opens when the aircraft arms and closes when
  // it stops being armed; anything logged on the bench must not become one.
  const ranges = buildActiveRanges([
    {timeUs: 1_000_000, state: 4},
    {timeUs: 5_000_000, state: 0},
    {timeUs: 7_000_000, state: 4}
  ], 10_000_000);

  assert.deepEqual(ranges, [[1_000_000, 5_000_000], [7_000_000, 10_000_000]],
    'the second range runs to the end of the log because it never disarmed');

  for (const [startUs, endUs] of ranges) {
    assert.ok(endUs > startUs, 'a range must have width');
    assert.ok(endUs <= 10_000_000, 'a range cannot end after the log');
  }
});

test('a log that never armed produces no active range', () => {
  // The failure this prevents is analysing bench stick movement as if it were
  // flight, which produces confident tuning evidence from an aircraft that
  // never left the ground.
  assert.deepEqual(buildActiveRanges([{timeUs: 1_000, state: 0}], 10_000), []);
  assert.deepEqual(buildActiveRanges([], 10_000), []);
  assert.deepEqual(buildActiveRanges(null, 10_000), []);
});

test('tracking is summarized per axis, in axis order, without pooling', () => {
  // The input is one accumulator per axis, indexed roll, pitch, yaw. Roll and
  // yaw are not the same measurement on a single-rotor helicopter, and a summary
  // that averaged them would describe neither.
  const accumulator = () => ({
    count: 20,
    errorSum: 0,
    errorSquaredSum: 20,
    absErrorSum: 20,
    absSetpointSum: 200,
    setpointSamples: Array.from({length: 20}, () => 10)
  });

  const summary = summarizeTracking([
    {all: accumulator(), commanded: accumulator()},
    {all: accumulator(), commanded: accumulator()},
    {all: accumulator(), commanded: accumulator()}
  ]);

  assert.equal(summary.length, 3);
  assert.deepEqual(summary.map(entry => entry.axis), ['roll', 'pitch', 'yaw']);
});

test('an axis with too little commanded motion is reported unavailable', () => {
  // Fewer than ten commanded samples is not tuning evidence, and saying so is
  // the difference between silence and a number nobody should act on.
  const thin = {count: 3, errorSum: 0, errorSquaredSum: 3, absErrorSum: 3, absSetpointSum: 30};
  const summary = summarizeTracking([{all: thin, commanded: thin}]);

  assert.equal(summary[0].available, false);
});

test('rounding keeps a measurement honest about its precision', () => {
  assert.equal(roundNumber(1.23456, 2), 1.23);
  assert.equal(roundNumber(1.0, 2), 1);
  assert.equal(roundNumber(null, 2), null, 'absent stays absent');
  assert.equal(roundNumber(NaN, 2), null, 'not-a-number is not a number');
});

test('compact turns a non-finite number into absent, not into zero', () => {
  // Infinity is what a ratio with a zero denominator produces. Rendering that as
  // a value would be worse than rendering nothing.
  assert.equal(compact(Infinity), null);
  assert.equal(compact(NaN), null);
  assert.equal(compact(0), 0, 'zero is a measurement');
  assert.equal(compact(undefined), undefined);

  assert.deepEqual(compact({a: 1, b: NaN, c: 0}), {a: 1, b: null, c: 0});
});

test('evidence must carry a stable, unique id', () => {
  // Findings reference evidence by id. A duplicate would silently repoint a
  // finding at the wrong measurement.
  const builder = new EvidenceBuilder();
  builder.add({id: 'gyro-noise', value: 1});

  assert.throws(() => builder.add({id: 'gyro-noise', value: 2}), /Duplicate evidence id/);
  assert.throws(() => builder.add({value: 3}), /stable non-empty id/);
  assert.equal(builder.items.length, 1);
});

test('an evidence package carries its schema version', () => {
  const builder = new EvidenceBuilder();
  builder.add({id: 'headspeed', value: 2000});

  const packaged = makePackage({evidence: builder.items, findings: []});

  assert.equal(packaged.schemaVersion, SCHEMA_VERSION);
  assert.ok(Number.isInteger(SCHEMA_VERSION), 'the version must be one a consumer can compare');
});
