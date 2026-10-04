/**
 * A capture that stops part-way through a frame, with erased flash after it.
 *
 * Flash reads back 0xFF where nothing was written. The real Rotorflight 4.6
 * reference log ends exactly that way: its final P frame has 13 bytes written
 * (30 of its 89 fields, carrying the same 994 us time step and 2-iteration loop
 * step as the frames before it) and then 512 bytes of 0xFF to the end of the
 * file. The decoder read the frame's next variable-byte field into the 0xFF run,
 * the run never terminates a varint, and the frame failed as `corrupt-frame`
 * with "Variable-byte integer exceeded 32 bits". The integrity judgment counts
 * only `truncated` errors as the capture's tail, so a flight that was simply cut
 * off was reported as damaged in its body — the class of misreport this
 * project has already had to fix once.
 *
 * What makes this safe to call truncation, and what these tests pin:
 *   - the failing frame read into a run of erased bytes that continues
 *     unbroken to the end of its session, so nothing decodable follows it;
 *   - no committed sample consumed any of those bytes;
 *   - an erased run anywhere else — mid-log, or followed by anything that is
 *     not erased — is still damage, and is still resynced past as damage.
 *
 * Everything here is built in memory from the committed synthetic fixtures.
 */

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

import {captureSessionIntegrityEvidence, decodeLog} from '../src/blackbox/decode.mjs';
import {findSessionStarts, parseSession} from '../src/blackbox/headers.mjs';
import {sessionEndOffset, sessionIntegrity} from '../src/blackbox/log-integrity.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(projectRoot, 'fixtures', 'synthetic');
const ERASED = 0xff;

async function loadFixture(file) {
  return new Uint8Array(await readFile(path.join(fixtureDir, file)));
}

function concat(...parts) {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function filled(length, value) {
  return new Uint8Array(length).fill(value);
}

function integrityOf(result, bytes, index = 0) {
  return sessionIntegrity(
    result.sessions[index],
    sessionEndOffset(result, index, bytes.length)
  );
}

/** Where session `index`'s frame stream begins. */
function dataOffsetOf(bytes, index = 0) {
  const starts = findSessionStarts(bytes);
  return parseSession(bytes, starts[index], index).dataOffset;
}

/** Deterministic PRNG so a failing sweep case can be replayed. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

test('a frame cut off by erased flash is the end of the capture, not damage', async () => {
  const full = await loadFixture('rf43-single-session.TXT');
  const cut = full.subarray(0, Math.trunc(full.length * 0.6));
  const plain = decodeLog(cut);
  // Precondition: this cut really does stop part-way through a frame.
  assert.deepEqual(plain.sessions[0].errors.map(error => error.code), ['truncated']);

  // The reference log's shape: a partial frame, then 512 erased bytes to EOF.
  const bytes = concat(cut, filled(512, ERASED));
  const result = decodeLog(bytes);
  const [session] = result.sessions;
  const integrity = integrityOf(result, bytes);

  assert.equal(integrity.state, 'truncated',
    `a cut capture was called ${integrity.state}: ${JSON.stringify(session.errors)}`);
  assert.deepEqual(integrity.bodyErrors, []);
  assert.deepEqual(session.errors.map(error => error.code), ['truncated']);
  assert.equal(session.errors[0].erasedBytes, 512,
    'the error must say how much erased flash followed the cut');
  assert.equal(session.truncated, true);
  assert.equal(session.reachedLogEnd, false);
  assert.equal(session.frameCounts.resyncBytes, 0,
    'erased flash is not lost alignment, and must not be counted as skipped');
  assert.equal(session.frameCounts.rejected, 0);
  assert.deepEqual(session.samples, plain.sessions[0].samples,
    'the erased bytes must not change a single sample');

  // The categorical evidence a stricter consumer reads must agree.
  const evidence = captureSessionIntegrityEvidence(result, 0, bytes.length);
  assert.equal(evidence.truncated, true);
  assert.equal(evidence.bodyEndOffset, evidence.sessionEnd);
  assert.deepEqual(evidence.errors.map(error => error.code), ['truncated']);
  assert.equal(evidence.frameCounts.resyncBytes, 0);
});

test('every cut followed by erased flash is truncation with the cut\'s own samples', async () => {
  // Randomised over cut position and fill length, across three field tables
  // (Rotorflight 4.3, 4.6 with GPS frames, 4.6 wide). A hand-picked cut proves
  // one layout; the property has to hold wherever the capture happened to stop,
  // including inside the log-end event and inside a G or H frame.
  const sources = [
    await loadFixture('rf43-single-session.TXT'),
    await loadFixture('rf46-gps-declared.TXT'),
    (await loadFixture('rf46-p-too-high.TXT')).subarray(0, 24_000)
  ];
  const fills = [5, 64, 512, 2048];
  const random = mulberry32(0x5eed_2026);
  const tally = {truncated: 0, ambiguousBoundary: 0, fillDecodedAsSample: 0};

  for (const full of sources) {
    const dataOffset = dataOffsetOf(full);
    for (let trial = 0; trial < 90; trial += 1) {
      const cutAt = dataOffset + 1 + Math.floor(random() * (full.length - dataOffset - 1));
      const cut = full.subarray(0, cutAt);
      const plain = decodeLog(cut).sessions[0];

      for (const fillLength of fills) {
        const bytes = concat(cut, filled(fillLength, ERASED));
        const result = decodeLog(bytes);
        const session = result.sessions[0];
        const integrity = integrityOf(result, bytes);
        const where = `cut at ${cutAt} of ${full.length}, ${fillLength} erased bytes`;

        // Nothing written before the cut may change, whatever follows it.
        assert.deepEqual(session.samples.slice(0, plain.samples.length), plain.samples, where);

        if (session.samples.length > plain.samples.length) {
          // A frame decoded erased bytes as values and was committed. That is
          // indistinguishable from data, so it must not be blessed as a clean
          // cut when anything after it failed.
          tally.fillDecodedAsSample += 1;
          if (session.errors.length > 0) {
            assert.equal(integrity.state, 'damaged', where);
          }
          continue;
        }

        if (cut[cut.length - 1] === ERASED && plain.errors.length === 0) {
          // The capture stopped exactly on a frame boundary and the last
          // written byte happens to be 0xFF: the decoder cannot tell where the
          // data ends and the erased flash begins, so it does not claim to.
          tally.ambiguousBoundary += 1;
          assert.notEqual(integrity.state, 'clean', where);
          continue;
        }

        tally.truncated += 1;
        assert.equal(integrity.state, 'truncated',
          `${where}: ${JSON.stringify(session.errors)}`);
        assert.deepEqual(session.errors.map(error => error.code),
          session.errors.length === 0 ? [] : ['truncated'], where);
        assert.equal(session.frameCounts.resyncBytes, 0, where);
        assert.equal(session.frameCounts.rejected, 0, where);
        assert.equal(session.truncated, true, where);
        assert.deepEqual(session.samples, plain.samples, where);
      }
    }
  }

  // The sweep must mostly exercise the case it exists for, not pass vacuously
  // through its exemptions.
  const total = tally.truncated + tally.ambiguousBoundary + tally.fillDecodedAsSample;
  assert.ok(tally.truncated >= total * 0.9, `sweep coverage: ${JSON.stringify(tally)}`);
});

/** A one-field (`time`, unsigned varint) session with `body` as its frames. */
function timeOnlyLog(body) {
  const header = new TextEncoder().encode([
    'H Product:Blackbox flight data recorder by Nicholas Sherlock',
    'H Data version:2',
    'H Field I name:time',
    'H Field I signed:0',
    'H Field I predictor:0',
    'H Field I encoding:1',
    'H Field P predictor:1',
    'H Field P encoding:0',
    'H Firmware type:Rotorflight',
    'H Firmware revision:Rotorflight 4.6.0 (erased-tail fixture) STM32H743',
    ''
  ].join('\n'));
  return concat(header, Uint8Array.from(body));
}

test('a frame that fails on its own written bytes is damage even if erased flash follows', () => {
  const sample = [0x49, 0xe8, 0x07]; // 'I', time = 1000
  const erased = new Array(512).fill(ERASED);

  // Five written bytes that are already an over-wide varint: the frame is
  // corrupt before it ever reaches the erased run.
  const corrupt = timeOnlyLog([...sample, 0x49, 0x80, 0x80, 0x80, 0x80, 0x10, ...erased]);
  const corruptResult = decodeLog(corrupt);
  assert.deepEqual(corruptResult.sessions[0].samples, [[1000]]);
  assert.equal(integrityOf(corruptResult, corrupt).state, 'damaged');
  assert.deepEqual(corruptResult.sessions[0].errors.map(error => error.code), ['corrupt-frame']);

  // Two written continuation bytes, and the varint runs on into the erased run:
  // that one was cut off.
  const cut = timeOnlyLog([...sample, 0x49, 0x80, 0x80, ...erased]);
  const cutResult = decodeLog(cut);
  assert.deepEqual(cutResult.sessions[0].samples, [[1000]]);
  assert.equal(integrityOf(cutResult, cut).state, 'truncated');
  assert.deepEqual(cutResult.sessions[0].errors.map(error => error.code), ['truncated']);
});

test('a sample decoded out of erased bytes is never passed off as a clean cut', () => {
  // TAG2_3S32 reads a lead byte of 0xFF as three four-byte values, so a frame
  // of it decodes 13 erased bytes "successfully" to [-1, -1, -1] and is
  // committed. The erased run then starts BEFORE the frame that finally fails.
  // An erased byte and a data byte of 0xFF look identical, so the decoder
  // cannot vouch for that sample and must not call the session merely cut.
  const header = new TextEncoder().encode([
    'H Product:Blackbox flight data recorder by Nicholas Sherlock',
    'H Data version:2',
    'H Field I name:a,b,c',
    'H Field I signed:1,1,1',
    'H Field I predictor:0,0,0',
    'H Field I encoding:7,7,7',
    'H Field P predictor:0,0,0',
    'H Field P encoding:7,7,7',
    'H Firmware type:Rotorflight',
    'H Firmware revision:Rotorflight 4.6.0 (erased-tail fixture) STM32H743',
    ''
  ].join('\n'));
  // 'I' with selector 0 (three zero values), then 'I' and nothing but 0xFF.
  const bytes = concat(header, Uint8Array.from([0x49, 0x00, 0x49]), filled(64, ERASED));
  const result = decodeLog(bytes);
  const [session] = result.sessions;

  assert.deepEqual(session.samples, [[0, 0, 0], [-1, -1, -1]],
    'precondition: the second frame was decoded from erased bytes');
  assert.equal(integrityOf(result, bytes).state, 'damaged', JSON.stringify(session.errors));
});

test('an erased run inside the log, with frames after it, is still damage', async () => {
  const full = await loadFixture('rf43-single-session.TXT');
  const cutAt = Math.trunc(full.length * 0.4);
  const bytes = concat(full.subarray(0, cutAt), filled(64, ERASED), full.subarray(cutAt));
  const result = decodeLog(bytes);
  const [session] = result.sessions;
  const plain = decodeLog(full.subarray(0, cutAt)).sessions[0];

  assert.equal(integrityOf(result, bytes).state, 'damaged');
  assert.ok(session.errors.some(error => error.code === 'corrupt-frame'),
    JSON.stringify(session.errors));
  assert.ok(session.frameCounts.resyncBytes > 0, 'the decoder must resync past the run');
  assert.ok(session.samples.length > plain.samples.length + 50,
    'frames after the erased run must still be decoded');
  assert.equal(session.reachedLogEnd, true);
});

test('erased bytes followed by anything that is not erased are still damage', async () => {
  const full = await loadFixture('rf43-single-session.TXT');
  const cut = full.subarray(0, Math.trunc(full.length * 0.6));
  // No frame marker in the zeros, so the decoder resyncs straight to the end —
  // but the run does not reach the end, so this is not unwritten flash. Enough
  // zeros that the cut frame finishes inside them rather than running off the
  // end of the input (which would be ordinary truncation, not this case).
  const bytes = concat(cut, filled(64, ERASED), filled(256, 0x00));
  const result = decodeLog(bytes);

  assert.equal(integrityOf(result, bytes).state, 'damaged');
  assert.ok(result.sessions[0].errors.some(error => error.code === 'corrupt-frame'));
});

test('erased flash between concatenated sessions ends the first and leaves the next alone',
  async () => {
    const full = await loadFixture('rf46-two-sessions.TXT');
    const [, secondStart] = findSessionStarts(full);
    const firstData = dataOffsetOf(full, 0);
    const cutAt = firstData + Math.trunc((secondStart - firstData) * 0.5);
    const bytes = concat(full.subarray(0, cutAt), filled(700, ERASED), full.subarray(secondStart));

    const result = decodeLog(bytes);
    const reference = decodeLog(full);
    const alone = decodeLog(full.subarray(0, cutAt)).sessions[0];

    assert.equal(result.sessions.length, 2);
    assert.equal(integrityOf(result, bytes, 0).state, 'truncated',
      JSON.stringify(result.sessions[0].errors));
    assert.deepEqual(result.sessions[0].samples, alone.samples);
    assert.deepEqual(result.sessions[0].errors.map(error => error.code), ['truncated']);
    assert.deepEqual(result.sessions[1].samples, reference.sessions[1].samples);
    assert.deepEqual(result.sessions[1].errors, []);
  });

test('a header followed only by erased flash recorded nothing, and is not damaged', async () => {
  const full = await loadFixture('rf43-single-session.TXT');
  const bytes = concat(full.subarray(0, dataOffsetOf(full)), filled(2048, ERASED));
  const result = decodeLog(bytes);
  const [session] = result.sessions;

  assert.deepEqual(session.samples, []);
  assert.equal(integrityOf(result, bytes).state, 'truncated', JSON.stringify(session.errors));
  assert.deepEqual(session.errors.map(error => error.code), ['truncated']);
});
