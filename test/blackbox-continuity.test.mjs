/**
 * Regression tests for the bug class that survived every other guard.
 *
 * Two encodings (TAG8_4S16, then TAG2_3S32 selector 3) shipped reading their
 * per-field byte widths from the wrong end of the lead byte, and a predictor
 * (INCREMENT) shipped with the wrong step. A third encoding, TAG8_8SVB, turns
 * out to belong to the same class even though it looks like it cannot: reversing
 * its selector bits within a group preserves their popcount, so the same number
 * of varints is read and the byte count does not move either. All of them are
 * invisible to the tests that existed:
 *
 *   - round-trip cannot see a permuted width slot, because our own writer packs
 *     the byte the same way our reader unpacks it. Both halves agree and both are
 *     wrong. That is structural: no round-trip test can ever settle a slot order.
 *   - `verify:log` could not see it either, because permuting widths leaves their
 *     SUM unchanged. The group consumes the same bytes, the stream stays aligned,
 *     the error count stays at zero and the sample interval stays perfect.
 *
 * What does see it is continuity across I-frame boundaries. These tests build
 * logs whose keyframe phase is known, deliberately mis-pack them, and require the
 * check to notice — and require it to stay quiet on correctly packed ones.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {decodeLog} from '../src/blackbox/decode.mjs';
import {measureIntraFrameContinuity} from '../src/blackbox/continuity.mjs';
import {Encoding} from '../src/blackbox/encodings.mjs';
import {Predictor} from '../src/blackbox/predictors.mjs';
import {parseSessions} from '../src/blackbox/headers.mjs';
import {writeSession} from '../tools/blackbox-writer.mjs';

const INTRA_INTERVAL = 32;

/**
 * Field table built so that the width slots inside each grouped encoding are all
 * DIFFERENT. That is the whole design constraint: a group whose fields happen to
 * need the same width is permutation-invariant, which is exactly why three
 * third-party synthetic logs could not adjudicate either bug. A corpus that
 * cannot distinguish the orders is not evidence that the order is right.
 */
const FIELDS = [
  {name: 'loopIteration', signed: 0, i: [Predictor.NONE, Encoding.UNSIGNED_VB], p: [Predictor.INCREMENT, Encoding.NULL]},
  {name: 'time', signed: 0, i: [Predictor.NONE, Encoding.UNSIGNED_VB], p: [Predictor.STRAIGHT_LINE, Encoding.SIGNED_VB]},

  // TAG8_4S16: nibble widths 1, 2, 0 and 4 per frame — every slot distinct.
  ...['quad[0]', 'quad[1]', 'quad[2]', 'quad[3]'].map(name => ({
    name, signed: 1, i: [Predictor.NONE, Encoding.SIGNED_VB], p: [Predictor.PREVIOUS, Encoding.TAG8_4S16]
  })),

  // TAG2_3S32 selector 3: byte widths 1, 2 and 3 per frame — every slot distinct.
  ...['trio[0]', 'trio[1]', 'trio[2]'].map(name => ({
    name, signed: 1, i: [Predictor.NONE, Encoding.SIGNED_VB], p: [Predictor.PREVIOUS, Encoding.TAG2_3S32]
  })),

  // TAG8_8SVB: half the fields are constant zero, in an asymmetric pattern
  // (1, 0, 1, 0, 1, 0, 0, 1), so reversing the selector bits within the group
  // maps every varint onto a different field. The popcount is unchanged, so the
  // byte count does not move — this encoding is silently permutable too.
  ...Array.from({length: 8}, (unused, index) => ({
    name: `octet[${index}]`,
    signed: 1,
    i: [Predictor.NONE, Encoding.SIGNED_VB],
    p: [Predictor.PREVIOUS, Encoding.TAG8_8SVB]
  }))
];

/** Which TAG8_8SVB fields carry a moving signal; the rest stay at zero. */
const OCTET_ACTIVE = [true, false, true, false, true, false, false, true];

const intraFields = FIELDS.map(field => ({name: field.name, predictor: field.i[0], encoding: field.i[1]}));
const interFields = FIELDS.map(field => ({name: field.name, predictor: field.p[0], encoding: field.p[1]}));

function headerLines({incrementStep, fields = FIELDS}) {
  // A step other than 1 is declared the way real firmware declares it: keyframe
  // spacing in loop iterations over keyframe spacing in logged frames.
  return [
    'H Product:Blackbox flight data recorder by Nicholas Sherlock',
    'H Data version:2',
    `H Field I name:${fields.map(field => field.name).join(',')}`,
    `H Field I signed:${fields.map(field => field.signed).join(',')}`,
    `H Field I predictor:${fields.map(field => field.i[0]).join(',')}`,
    `H Field I encoding:${fields.map(field => field.i[1]).join(',')}`,
    `H Field P predictor:${fields.map(field => field.p[0]).join(',')}`,
    `H Field P encoding:${fields.map(field => field.p[1]).join(',')}`,
    'H Firmware type:Rotorflight',
    'H Firmware revision:Rotorflight 4.6.0 (continuity fixture) STM32H743',
    `H I interval:${INTRA_INTERVAL * incrementStep}`,
    `H P interval:${incrementStep}`,
    `H P ratio:${INTRA_INTERVAL}`,
    'H minthrottle:1070',
    'H vbatref:380'
  ];
}

/** Deterministic 32-bit LCG; integer-only so the corpus cannot drift. */
function createNoise(seed) {
  let state = seed >>> 0;
  return function next(range) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return ((state >>> 16) % (range * 2 + 1)) - range;
  };
}

/**
 * A flight whose per-frame deltas sit in a different width band per field, so
 * every slot in every group is occupied by a different width.
 */
function buildFrames({frameCount, seed, incrementStep}) {
  const noise = createNoise(seed);
  const frames = [];

  // Running absolutes; the deltas are what the width bands are chosen for.
  let quad0 = 0;
  let quad1 = 0;
  let quad3 = 0;
  let trio0 = 0;
  let trio1 = 0;
  let trio2 = 0;
  const octet = new Array(8).fill(0);

  for (let step = 0; step < frameCount; step += 1) {
    quad0 += noise(3);                            // fits one nibble
    quad1 += (noise(50) < 0 ? -1 : 1) * (8 + Math.abs(noise(110)));   // two nibbles
    quad3 += (noise(50) < 0 ? -1 : 1) * (200 + Math.abs(noise(20_000))); // four nibbles

    trio0 += (noise(50) < 0 ? -1 : 1) * (1 + Math.abs(noise(120)));      // one byte
    trio1 += (noise(50) < 0 ? -1 : 1) * (200 + Math.abs(noise(30_000))); // two bytes
    trio2 += (noise(50) < 0 ? -1 : 1) * (40_000 + Math.abs(noise(4_000_000))); // three bytes

    // Each active field moves by a different magnitude, so a reversed selector
    // bit lands a visibly wrong signal on a visibly wrong field.
    OCTET_ACTIVE.forEach((active, index) => {
      if (active) {
        octet[index] += (noise(50) < 0 ? -1 : 1) * ((index + 1) * 40 + Math.abs(noise(300)));
      }
    });

    frames.push([
      step * incrementStep,
      step * 500,
      quad0, quad1, 0, quad3,
      trio0, trio1, trio2,
      ...octet
    ].map(value => value | 0));
  }

  return frames;
}

function buildLog({frameCount = 1024, seed = 1, incrementStep = 1, reverseSlotOrder = false} = {}) {
  const frames = buildFrames({frameCount, seed, incrementStep});
  const bytes = new Uint8Array(writeSession({
    headerLines: headerLines({incrementStep}),
    intraFields,
    interFields,
    frames,
    intraInterval: INTRA_INTERVAL,
    constants: {minthrottle: 1070, vbatref: 380, incrementStep},
    reverseSlotOrder
  }));

  return {frames, bytes};
}

function continuityOf(session, options) {
  return measureIntraFrameContinuity({
    samples: session.samples,
    intraSampleIndices: session.intraSampleIndices,
    fields: session.fields
  }, options);
}

function decodeSingleSession(bytes) {
  const result = decodeLog(bytes);
  assert.equal(result.sessions.length, 1);
  return result.sessions[0];
}

test('the increment step is derived from the session headers, not assumed to be 1', () => {
  for (const step of [1, 2, 4, 8]) {
    const [session] = parseSessions(buildLog({incrementStep: step, frameCount: 64}).bytes);
    assert.equal(session.constants.incrementStep, step,
      `I interval ${INTRA_INTERVAL * step} over P ratio ${INTRA_INTERVAL} must give step ${step}`);
  }

  // Firmware that writes `P interval` as a ratio string and omits `P ratio`.
  const [fallback] = parseSessions(new Uint8Array(Buffer.from(
    ['H Product:x', 'H Field I name:time', 'H Field I signed:0',
      'H Field I predictor:0', 'H Field I encoding:1',
      'H Field P predictor:0', 'H Field P encoding:0',
      'H P interval:1/1', 'H end:1', ''].join('\n'), 'ascii')));
  assert.equal(fallback.constants.incrementStep, 1);
});

test('an INCREMENT field logged every other loop iteration decodes to the truth', () => {
  // With a hardcoded step of 1 this ramps 1 per delta frame and is yanked forward
  // 33 at every keyframe — forward both times, so the monotonicity guard is
  // satisfied and no frame is ever rejected. The value is simply wrong.
  for (const step of [1, 2, 4]) {
    const {frames, bytes} = buildLog({incrementStep: step, frameCount: 1024});
    const session = decodeSingleSession(bytes);

    assert.deepEqual(session.errors, [], `step ${step} decoded with errors`);
    assert.equal(session.samples.length, frames.length);
    frames.forEach((expected, index) => {
      assert.equal(session.samples[index][0], expected[0],
        `step ${step} frame ${index}: loopIteration`);
    });

    const report = continuityOf(session);
    const iteration = report.fields.find(entry => entry.name === 'loopIteration');
    assert.ok(iteration.ratio < 2,
      `step ${step}: loopIteration ratio ${iteration.ratio} — a wrong step is a keyframe sawtooth`);
  }
});

test('a correctly packed log is continuous across every I-frame boundary', () => {
  // Sweep, not a hand-picked case: a single seed can be quiet by luck.
  for (let seed = 1; seed <= 120; seed += 1) {
    const {frames, bytes} = buildLog({seed, frameCount: 1024});
    const session = decodeSingleSession(bytes);

    assert.deepEqual(session.errors, [], `seed ${seed} decoded with errors`);

    // Continuity first, deliberately: if only the decoder's slot order is
    // disturbed, round-trip would also fail and would hide which check did the
    // work. This assertion is the one that has to hold on its own.
    const report = continuityOf(session);
    assert.equal(report.measured, true);
    assert.deepEqual(
      report.flagged.map(entry => entry.name), [],
      `seed ${seed} flagged a correctly decoded field: ` +
      report.flagged
        .map(entry => `${entry.name}=${entry.ratio === Infinity ? 'inf' : `${entry.ratio.toFixed(2)}x`}`)
        .join(', ')
    );

    assert.deepEqual(session.samples, frames, `seed ${seed} did not round-trip`);
  }
});

test('permuted width slots are invisible to every alignment check', () => {
  // The premise of the whole bug class, asserted rather than described: the
  // mis-packed log is the same LENGTH, decodes the same NUMBER of frames, raises
  // the same (zero) errors and resyncs the same (zero) bytes. Sum of widths is
  // unchanged, so nothing about the stream's shape moves. Only the values do.
  for (let seed = 1; seed <= 60; seed += 1) {
    const correct = buildLog({seed, frameCount: 1024});
    const permuted = buildLog({seed, frameCount: 1024, reverseSlotOrder: true});

    assert.equal(permuted.bytes.length, correct.bytes.length,
      `seed ${seed}: a permuted layout must consume identical bytes`);

    const good = decodeSingleSession(correct.bytes);
    const bad = decodeSingleSession(permuted.bytes);

    assert.deepEqual(bad.errors, [], `seed ${seed}: the bug must not raise an error`);
    assert.equal(bad.frameCounts.resyncBytes, 0, `seed ${seed}: the bug must not cost sync`);
    assert.equal(bad.frameCounts.rejected, 0, `seed ${seed}: no frame is rejected`);
    assert.equal(bad.samples.length, good.samples.length);
    assert.equal(bad.frameCounts.I, good.frameCounts.I);
    assert.equal(bad.frameCounts.P, good.frameCounts.P);

    // …and yet the values are wrong, which is the part nothing else could see.
    assert.notDeepEqual(bad.samples, good.samples, `seed ${seed}: expected corrupted values`);
  }
});

test('the continuity check catches permuted width slots on every seed', () => {
  // Every field inside a grouped encoding is fair game — including quad[2] and
  // the constant octet fields, which hold zero when packed correctly and receive
  // another field's slot when permuted. `loopIteration` and `time` are not
  // grouped, so blaming either would be the check pointing at the wrong place.
  const affected = [
    'quad[0]', 'quad[1]', 'quad[2]', 'quad[3]',
    'trio[0]', 'trio[1]', 'trio[2]',
    ...Array.from({length: 8}, (unused, index) => `octet[${index}]`)
  ];

  for (let seed = 1; seed <= 120; seed += 1) {
    const {bytes} = buildLog({seed, frameCount: 1024, reverseSlotOrder: true});
    const session = decodeSingleSession(bytes);
    const report = continuityOf(session);

    assert.equal(report.measured, true);
    const flagged = new Set(report.flagged.map(entry => entry.name));
    assert.ok(flagged.size > 0, `seed ${seed}: mis-packed widths were not detected at all`);

    // Both grouped encodings must be implicated, not just whichever one happens
    // to carry the largest numbers.
    assert.ok([...flagged].some(name => name.startsWith('quad')),
      `seed ${seed}: TAG8_4S16 corruption went unnoticed (flagged: ${[...flagged].join(', ')})`);
    assert.ok([...flagged].some(name => name.startsWith('trio')),
      `seed ${seed}: TAG2_3S32 corruption went unnoticed (flagged: ${[...flagged].join(', ')})`);
    assert.ok([...flagged].some(name => name.startsWith('octet')),
      `seed ${seed}: TAG8_8SVB corruption went unnoticed (flagged: ${[...flagged].join(', ')})`);

    for (const name of flagged) {
      assert.ok(affected.includes(name),
        `seed ${seed}: ${name} is not width-packed and must not be blamed`);
    }
  }
});

test('a signal with no keyframe structure never trips the check, over thousands of cases', () => {
  // The measurement has to be quiet on ordinary data or it is worthless as a
  // gate. Random walks, constants, steps, and heavy-tailed noise all qualify.
  const fields = [{name: 'a'}, {name: 'b'}, {name: 'c'}];
  let cases = 0;

  for (let seed = 1; seed <= 2000; seed += 1) {
    const noise = createNoise(seed * 2654435761);
    const length = 800 + (seed % 400);
    const amplitude = 1 + (seed % 500);
    const samples = [];
    let walk = [0, 0, 0];

    for (let index = 0; index < length; index += 1) {
      walk = [
        walk[0] + noise(amplitude),
        // A constant field, and a field that occasionally takes a large step at
        // a position unrelated to the keyframe phase.
        0,
        walk[2] + (index % 37 === 0 ? noise(amplitude * 20) : noise(amplitude))
      ];
      samples.push([...walk]);
    }

    const intraSampleIndices = [];
    for (let index = 0; index < length; index += INTRA_INTERVAL) {
      intraSampleIndices.push(index);
    }

    const report = measureIntraFrameContinuity({samples, intraSampleIndices, fields});
    assert.equal(report.measured, true, `seed ${seed}: not measured`);
    assert.deepEqual(report.flagged.map(entry => entry.name), [],
      `seed ${seed}: false positive on a signal with no keyframe structure`);
    cases += 1;
  }

  assert.equal(cases, 2000);
});

test('an injected keyframe sawtooth is caught across its whole magnitude range', () => {
  // The complement: whatever the drift rate, a field that is pulled back to truth
  // at each keyframe must be flagged. Sweeps drift rates spanning four orders of
  // magnitude against signal amplitudes spanning three.
  const fields = [{name: 'drifting'}];
  let cases = 0;

  for (let seed = 1; seed <= 1500; seed += 1) {
    const noise = createNoise(seed * 40_503);
    const length = 800 + (seed % 400);
    const amplitude = 1 + (seed % 300);
    // Drift must exceed the signal for the sawtooth to be the dominant motion —
    // below that the check is honestly unable to tell, and says so by staying
    // quiet rather than guessing.
    const drift = amplitude * (3 + (seed % 40));

    const samples = [];
    const intraSampleIndices = [];
    let truth = 0;
    let error = 0;

    for (let index = 0; index < length; index += 1) {
      truth += noise(amplitude);
      if (index % INTRA_INTERVAL === 0) {
        intraSampleIndices.push(index);
        error = 0; // the keyframe is absolute: the accumulated error snaps away
      } else {
        error += drift;
      }
      samples.push([truth + error]);
    }

    const report = measureIntraFrameContinuity({samples, intraSampleIndices, fields});
    assert.equal(report.measured, true);
    assert.deepEqual(report.flagged.map(entry => entry.name), ['drifting'],
      `seed ${seed}: a sawtooth of ${drift} per frame against ${amplitude} of signal was missed`);
    cases += 1;
  }

  assert.equal(cases, 1500);
});

test('a field that barely moves is reported as unmeasurable, not as a fault', () => {
  // Both false positives seen on real logs were this shape: a ratio between two
  // near-zero means. An ESC capacity counter that ticks 28 times in a flight read
  // 1.59x, and a 0..5 field that moved five times in 30,000 samples read 7.75x.
  const fields = [{name: 'barely'}];
  const samples = [];
  const intraSampleIndices = [];

  for (let index = 0; index < 1600; index += 1) {
    if (index % INTRA_INTERVAL === 0) {
      intraSampleIndices.push(index);
    }
    // Moves exactly once, and that once lands on a keyframe: ratio is infinite,
    // movement is one count in fifty keyframes.
    samples.push([index >= 320 ? 1 : 0]);
  }

  const report = measureIntraFrameContinuity({samples, intraSampleIndices, fields});
  const [entry] = report.fields;
  assert.equal(entry.ratio, Infinity);
  assert.equal(entry.belowMovementFloor, true);
  assert.deepEqual(report.flagged, []);
});

test('a log with no delta frames is reported as unmeasured rather than passing silently', () => {
  const fields = [{name: 'a'}];
  const samples = Array.from({length: 40}, (unused, index) => [index]);
  const report = measureIntraFrameContinuity({
    samples,
    intraSampleIndices: samples.map((unused, index) => index),
    fields
  });

  assert.equal(report.measured, false);
  assert.match(report.reason, /transitions/);
});

/*
 * A flight has moments in it, and a moment does not know where the keyframes
 * are either.
 *
 * Measured 2026-10-03 on the two private dataflash dumps: 32 of 109 sessions
 * failed this check under the original rule, and not one of them was a decoding
 * fault. Every flag was carried by one or two keyframes on which something
 * genuinely changed — the governor engaging (govI 0 -> 450), a throttle cut
 * (throttle, governor target, motor and govP all stepping at the same sample,
 * with the firmware writing a governor-state event immediately before it), an
 * ESC telemetry update, a heading wrapping 3599 -> 0. Across 112,517 such step
 * moments in 109 sessions, 3.10% and 3.14% landed on a keyframe against 3.13%
 * by chance. A step on a keyframe has 31x the leverage of the same step on a
 * delta frame, so on a field that otherwise barely moves, one lucky moment is
 * the whole ratio.
 *
 * The obvious fix — set the largest few keyframes aside — would have hidden a
 * real shipped defect: TAG2_3S32 selector 3 mis-read its widths on only seven
 * groups of the reference log, so its excess was carried by two keyframes too.
 * What separates the two is what the keyframe does. A mis-read delta is
 * UNDONE by the next keyframe; a genuine step is not.
 */

/** Field table shaped like the real firmware's, so a moment crosses the same encodings. */
const MOMENT_FIELDS = [
  FIELDS[0],
  FIELDS[1],
  {name: 'roll', signed: 1, i: [Predictor.NONE, Encoding.SIGNED_VB], p: [Predictor.PREVIOUS, Encoding.SIGNED_VB]},
  // Governor terms grouped exactly as Rotorflight 4.6 groups them.
  ...['govP', 'govI', 'govD', 'govF'].map(name => ({
    name, signed: 1, i: [Predictor.NONE, Encoding.SIGNED_VB], p: [Predictor.PREVIOUS, Encoding.TAG8_4S16]
  })),
  {name: 'throttle', signed: 0, i: [Predictor.NONE, Encoding.UNSIGNED_VB], p: [Predictor.PREVIOUS, Encoding.SIGNED_VB]},
  {name: 'motor', signed: 1, i: [Predictor.NONE, Encoding.SIGNED_VB], p: [Predictor.AVERAGE_2, Encoding.SIGNED_VB]},
  {name: 'escRpm', signed: 0, i: [Predictor.NONE, Encoding.UNSIGNED_VB], p: [Predictor.PREVIOUS, Encoding.SIGNED_VB]}
];

/**
 * Spool-up, a long steady stretch, then a throttle cut at `cutAt`: the moment
 * that failed the real sessions, rebuilt field by field. Arming happens eight
 * keyframe periods earlier and every ramp has settled before the cut's period
 * begins, so the cut is a step out of a steady state.
 */
function buildMomentFrames({frameCount, seed, cutAt}) {
  const noise = createNoise(seed);
  const armAt = cutAt - 8 * INTRA_INTERVAL - 7;
  const frames = [];
  let roll = 0;
  let govP = 0;
  let govI = 0;
  let throttle = 0;
  let motor = 0;
  let escRpm = 0;

  for (let step = 0; step < frameCount; step += 1) {
    roll += noise(40);

    if (step === armAt) {
      throttle = 498;
      govI = 450;
    } else if (step > armAt && step < cutAt) {
      motor = Math.min(90, motor + 1);
      if ((step - armAt) % 20 === 0) escRpm = Math.min(4800, escRpm + 480);
      govP = noise(3);
    } else if (step === cutAt) {
      // Everything the cut touches changes on the same sample.
      throttle = 0;
      govI = 0;
      motor = 0;
      escRpm = 0;
      govP = -207;
    } else if (step > cutAt) {
      govP = Math.trunc(govP * 0.97); // the governor's error decays with the rotor
    }

    frames.push([step, step * 500, roll, govP, govI, 0, 0, throttle, motor, escRpm].map(value => value | 0));
  }

  return frames;
}

function buildMomentLog({seed, cutAt, frameCount = 1024}) {
  const frames = buildMomentFrames({frameCount, seed, cutAt});
  const bytes = new Uint8Array(writeSession({
    headerLines: headerLines({incrementStep: 1, fields: MOMENT_FIELDS}),
    intraFields: MOMENT_FIELDS.map(field => ({name: field.name, predictor: field.i[0], encoding: field.i[1]})),
    interFields: MOMENT_FIELDS.map(field => ({name: field.name, predictor: field.p[0], encoding: field.p[1]})),
    frames,
    intraInterval: INTRA_INTERVAL,
    constants: {minthrottle: 1070, vbatref: 380, incrementStep: 1}
  }));
  return {frames, bytes};
}

test('a throttle cut that lands on a keyframe is a moment in the flight, not a decoding fault', () => {
  // Every keyframe phase, so the one phase that used to fail is surrounded by the
  // 31 that never did. Encoded by our writer and decoded by the real decoder: the
  // same path a dump takes through `verify:log`.
  let reachedOldFailure = 0;

  for (let seed = 1; seed <= 8; seed += 1) {
    for (let phase = 0; phase < INTRA_INTERVAL; phase += 1) {
      const cutAt = INTRA_INTERVAL * (20 + (seed % 8)) + phase;
      const {frames, bytes} = buildMomentLog({seed, cutAt});
      const session = decodeSingleSession(bytes);
      assert.deepEqual(session.errors, [], `seed ${seed} phase ${phase} decoded with errors`);
      assert.deepEqual(session.samples, frames, `seed ${seed} phase ${phase} did not round-trip`);

      const report = continuityOf(session);
      assert.equal(report.measured, true);
      assert.deepEqual(
        report.flagged.map(entry => entry.name), [],
        `seed ${seed}, cut at keyframe phase ${phase}: a genuine step was called a decoding fault (` +
        report.flagged.map(entry => `${entry.name} ${entry.ratio.toFixed(1)}x`).join(', ') + ')'
      );

      if (phase === 0) {
        // The case has to reach the failure it guards, or it agrees with the bug:
        // under the original rule — mean jump into a keyframe over mean jump
        // elsewhere, above the movement floor — this cut DID fail.
        const throttle = report.fields.find(entry => entry.name === 'throttle');
        const motor = report.fields.find(entry => entry.name === 'motor');
        for (const entry of [throttle, motor]) {
          assert.ok(entry.ratio >= 2 && !entry.belowMovementFloor,
            `seed ${seed}: ${entry.name} at ${entry.ratio.toFixed(2)}x does not reproduce the original failure`);
        }
        reachedOldFailure += 1;

        // With no keyframes set aside the check IS the original rule, and fails.
        const original = continuityOf(session, {concentrationKeyframes: 0});
        assert.ok(original.flagged.some(entry => entry.name === 'throttle'),
          `seed ${seed}: concentrationKeyframes 0 no longer reproduces the ratio-only rule`);

        // …and it is still reported, as a measurement a person can go and look at.
        const concentrated = report.concentrated.find(entry => entry.name === 'throttle');
        assert.ok(concentrated, `seed ${seed}: the keyframe step was not reported at all`);
        assert.equal(concentrated.largestKeyframeJumps[0].sampleIndex, cutAt);
        assert.equal(concentrated.largestKeyframeJumps[0].size, 498);
      }
    }
  }

  assert.equal(reachedOldFailure, 8);
});

test('genuine steps landing on up to three keyframes are never called a fault, over thousands of cases', () => {
  // Adversarial by construction: between one and three steps are FORCED onto
  // keyframes, alone or coinciding across fields, against random walks and
  // further steps on delta frames. The one thing excluded is a delta-frame step
  // that the keyframe then reverses within the same period — that shape is
  // indistinguishable from a mis-read delta, and the next test requires it to be
  // caught.
  const fields = [{name: 'walk'}, {name: 'sparse'}, {name: 'coupled'}];
  let cases = 0;
  let originalRuleWouldHaveFailed = 0;

  for (let seed = 1; seed <= 3000; seed += 1) {
    const noise = createNoise(seed * 2246822519);
    const length = 800 + (seed % 400);
    const amplitude = 1 + (seed % 200);
    const keyframes = [];
    for (let index = 0; index < length; index += INTRA_INTERVAL) keyframes.push(index);

    // Distinct keyframes for the forced steps, never the first.
    const forced = new Set();
    while (forced.size < 1 + (seed % 3)) {
      forced.add(keyframes[1 + Math.abs(noise(1000)) % (keyframes.length - 1)]);
    }
    // Delta-frame steps outside every forced keyframe's own period.
    const isForcedPeriod = index => [...forced].some(key => index > key - INTRA_INTERVAL && index < key);
    const loose = new Set();
    while (loose.size < seed % 4) {
      const index = 1 + Math.abs(noise(100_000)) % (length - 1);
      if (index % INTRA_INTERVAL !== 0 && !isForcedPeriod(index)) loose.add(index);
    }

    const samples = [];
    let walk = 0;
    let sparse = 0;
    let coupled = 0;
    for (let index = 0; index < length; index += 1) {
      walk += noise(amplitude);
      if (forced.has(index) || loose.has(index)) {
        const size = (noise(10) < 0 ? -1 : 1) * (1 + Math.abs(noise(amplitude * 50)));
        sparse += size;
        // Half the time a second field steps on the same sample, as the throttle,
        // governor and motor all did at once on the real cut.
        if (seed % 2 === 0) coupled -= size * 3;
      }
      samples.push([walk, sparse, coupled]);
    }

    const report = measureIntraFrameContinuity({samples, intraSampleIndices: keyframes, fields});
    assert.equal(report.measured, true, `seed ${seed}: not measured`);
    assert.deepEqual(report.flagged.map(entry => entry.name), [],
      `seed ${seed}: ${forced.size} genuine keyframe step(s) called a fault: ` +
      report.flagged.map(entry => `${entry.name} ${entry.ratio.toFixed(1)}x`).join(', '));

    if (report.fields.some(entry => entry.ratio >= 2 && !entry.belowMovementFloor)) {
      originalRuleWouldHaveFailed += 1;
    }
    cases += 1;
  }

  assert.equal(cases, 3000);
  // Not a sweep of easy cases: nearly all of them (2,951 when written) failed
  // the check as it was.
  assert.ok(originalRuleWouldHaveFailed >= 2800,
    `only ${originalRuleWouldHaveFailed} of 3000 cases reach the original false positive`);
});

test('a delta error confined to one or two keyframe periods is still caught when the keyframe undoes it', () => {
  // The shape of the TAG2_3S32 selector-3 defect on the reference log: a mis-read
  // delta in one period, carried forward by the PREVIOUS predictor, snapped back
  // by the next keyframe — and nowhere else. Narrow, so setting the largest few
  // keyframes aside would erase it; this is what that fix would have missed.
  const fields = [{name: 'misread'}];
  let cases = 0;

  for (let seed = 1; seed <= 1500; seed += 1) {
    const noise = createNoise(seed * 3266489917);
    const length = 800 + (seed % 400);
    const amplitude = 1 + (seed % 300);
    const keyframes = [];
    for (let index = 0; index < length; index += INTRA_INTERVAL) keyframes.push(index);

    // Below roughly one signal amplitude per keyframe in total, a single mis-read
    // is smaller than the flight's own movement and the check honestly cannot
    // tell; it stays quiet rather than guessing.
    const error = (noise(10) < 0 ? -1 : 1) * amplitude * keyframes.length * (2 + (seed % 30));
    const periods = new Set();
    while (periods.size < 1 + (seed % 2)) {
      periods.add(1 + Math.abs(noise(1000)) % (keyframes.length - 2));
    }
    // Where inside each period the bad group sits: any delta frame.
    const misreadAt = new Map([...periods].map(period =>
      [keyframes[period] + 1 + Math.abs(noise(1000)) % (INTRA_INTERVAL - 1), keyframes[period + 1]]));

    const samples = [];
    let truth = 0;
    let offset = 0;
    let clearsAt = -1;
    for (let index = 0; index < length; index += 1) {
      truth += noise(amplitude);
      if (misreadAt.has(index)) {
        offset = error;
        clearsAt = misreadAt.get(index);
      }
      if (index === clearsAt) offset = 0; // the keyframe is absolute
      samples.push([truth + offset]);
    }

    const report = measureIntraFrameContinuity({samples, intraSampleIndices: keyframes, fields});
    assert.equal(report.measured, true);
    assert.deepEqual(report.flagged.map(entry => entry.name), ['misread'],
      `seed ${seed}: a mis-read of ${error} undone at ${periods.size} keyframe(s) was missed`);
    cases += 1;
  }

  assert.equal(cases, 1500);
});

/** Only `trio` moves through TAG2_3S32; nothing else in this table can be mis-packed. */
const NARROW_FIELDS = [
  FIELDS[0],
  FIELDS[1],
  {name: 'roll', signed: 1, i: [Predictor.NONE, Encoding.SIGNED_VB], p: [Predictor.PREVIOUS, Encoding.SIGNED_VB]},
  ...['trio[0]', 'trio[1]', 'trio[2]'].map(name => ({
    name, signed: 1, i: [Predictor.NONE, Encoding.SIGNED_VB], p: [Predictor.PREVIOUS, Encoding.TAG2_3S32]
  }))
];

test('selector-3 widths mis-packed in only one or two groups are caught at the real entry point', () => {
  // Reproduces the reference log's situation exactly: every TAG2_3S32 group fits
  // selectors 0-2 except one or two, which need selector 3 with three DIFFERENT
  // byte widths. Written with the slots reversed, those groups alone are mis-read;
  // the stream stays aligned and nothing but continuity can see it.
  for (let seed = 1; seed <= 40; seed += 1) {
    const noise = createNoise(seed * 668265263);
    const frameCount = 1024;
    // Never in the final period: with no keyframe after it, nothing undoes the
    // mis-read and no measurement of keyframes can see it.
    const wide = new Set();
    while (wide.size < 1 + (seed % 2)) {
      const index = 1 + Math.abs(noise(100_000)) % (frameCount - INTRA_INTERVAL - 1);
      if (index % INTRA_INTERVAL !== 0) wide.add(index);
    }

    const frames = [];
    let roll = 0;
    const trio = [0, 0, 0];
    for (let step = 0; step < frameCount; step += 1) {
      roll += noise(40);
      if (wide.has(step)) {
        // One byte, two bytes, three bytes: every slot needs a different width.
        trio[0] += 5;
        trio[1] += 300;
        trio[2] += 70_000;
      } else {
        // Inside six signed bits, so selector 3 is never chosen here.
        for (let index = 0; index < 3; index += 1) trio[index] += noise(20);
      }
      frames.push([step, step * 500, roll, ...trio]);
    }

    for (const reverseSlotOrder of [false, true]) {
      const bytes = new Uint8Array(writeSession({
        headerLines: headerLines({incrementStep: 1, fields: NARROW_FIELDS}),
        intraFields: NARROW_FIELDS.map(field => ({name: field.name, predictor: field.i[0], encoding: field.i[1]})),
        interFields: NARROW_FIELDS.map(field => ({name: field.name, predictor: field.p[0], encoding: field.p[1]})),
        frames,
        intraInterval: INTRA_INTERVAL,
        constants: {minthrottle: 1070, vbatref: 380, incrementStep: 1},
        reverseSlotOrder
      }));
      const session = decodeSingleSession(bytes);
      assert.deepEqual(session.errors, []);
      assert.equal(session.frameCounts.resyncBytes, 0);
      assert.equal(session.samples.length, frames.length);

      const report = continuityOf(session);
      const flagged = report.flagged.map(entry => entry.name);
      if (!reverseSlotOrder) {
        // The genuine 70,000-count step on a delta frame is just a step.
        assert.deepEqual(session.samples, frames);
        assert.deepEqual(flagged, [], `seed ${seed}: correctly packed log flagged ${flagged.join(', ')}`);
        continue;
      }

      // The case must be the narrow one: wrong only in the affected periods,
      // right at every keyframe.
      assert.notDeepEqual(session.samples, frames, `seed ${seed}: the mis-pack changed nothing`);
      for (const index of session.intraSampleIndices) {
        assert.deepEqual(session.samples[index], frames[index], `seed ${seed}: keyframe ${index} is not absolute`);
      }

      assert.ok(flagged.some(name => name.startsWith('trio')),
        `seed ${seed}: ${wide.size} mis-read group(s) went unnoticed`);
      assert.ok(flagged.every(name => name.startsWith('trio')),
        `seed ${seed}: blamed a field that is not width-packed: ${flagged.join(', ')}`);
    }
  }
});
