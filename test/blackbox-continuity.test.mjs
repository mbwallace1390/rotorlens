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

function headerLines({incrementStep}) {
  // A step other than 1 is declared the way real firmware declares it: keyframe
  // spacing in loop iterations over keyframe spacing in logged frames.
  return [
    'H Product:Blackbox flight data recorder by Nicholas Sherlock',
    'H Data version:2',
    `H Field I name:${FIELDS.map(field => field.name).join(',')}`,
    `H Field I signed:${FIELDS.map(field => field.signed).join(',')}`,
    `H Field I predictor:${intraFields.map(field => field.predictor).join(',')}`,
    `H Field I encoding:${intraFields.map(field => field.encoding).join(',')}`,
    `H Field P predictor:${interFields.map(field => field.predictor).join(',')}`,
    `H Field P encoding:${interFields.map(field => field.encoding).join(',')}`,
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
