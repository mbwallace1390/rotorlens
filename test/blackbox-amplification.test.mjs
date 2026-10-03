/**
 * How much work and memory a log can demand per byte of itself.
 *
 * NULL (encoding 9) is a real, valid encoding that consumes no bytes — the value
 * comes entirely from the predictor. A header may declare up to 1024 fields. So
 * a header of 1024 NULL fields turns every `I` byte after it into a whole
 * 1024-cell sample, and the sample COUNT was the only thing bounded: a 215 KB
 * file decoded to ~200,000 samples and +1.66 GB of heap. Worse, the frame loop
 * re-scanned the whole run of same-encoding fields for every field, so one such
 * frame cost ~524,000 comparisons even though NULL groups are one field wide —
 * 10,000 frames took 6.5 s. The viewer decodes on the page's main thread, so a
 * shared hostile file froze the app and then the WebView ran out of memory.
 *
 * Real logs sit far from any of this: 110 real sessions decode to 1.40-1.73
 * cells per body byte, and the densest frame any field table we hold can
 * produce is under 2 cells per byte (2.64 for the synthetic 4.6 table). These
 * tests hold the decoder to "tens of cells per byte", and check that the
 * committed corpus stays well clear of the line.
 *
 * Everything is built in memory.
 */

import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

import {decodeLog} from '../src/blackbox/decode.mjs';
import {findSessionStarts, parseSession} from '../src/blackbox/headers.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(projectRoot, 'fixtures', 'synthetic');

// The ceiling these tests enforce. Deliberately looser than the decoder's own
// budget so the test pins the property (bounded amplification) rather than
// one constant, and deliberately far below the ~1000 cells per byte that an
// all-NULL table produced before.
const CEILING_CELLS_PER_BYTE = 32;
const CEILING_FLOOR_CELLS = 65_536;

function tableLines(type, names, encodings, predictors = names.map(() => 0)) {
  return [
    `H Field ${type} name:${names.join(',')}`,
    `H Field ${type} signed:${names.map(() => 0).join(',')}`,
    `H Field ${type} predictor:${predictors.join(',')}`,
    `H Field ${type} encoding:${encodings.join(',')}`
  ];
}

function logWith(headerLines, body) {
  const header = new TextEncoder().encode([
    'H Product:Blackbox flight data recorder by Nicholas Sherlock',
    'H Data version:2',
    ...headerLines,
    'H Firmware type:Rotorflight',
    'H Firmware revision:Rotorflight 4.6.0 (amplification fixture) STM32H743',
    ''
  ].join('\n'));
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header, 0);
  bytes.set(body, header.length);
  return {bytes, bodyBytes: body.length};
}

const names = count => Array.from({length: count}, (_, index) => `f${index}`);

function nullMainTable(fieldCount, encodings = new Array(fieldCount).fill(9)) {
  return [
    ...tableLines('I', names(fieldCount), encodings),
    // P frames reuse the I names and declare their own predictor and encoding.
    `H Field P predictor:${new Array(fieldCount).fill(1).join(',')}`,
    `H Field P encoding:${encodings.join(',')}`
  ];
}

function decodeTimed(bytes) {
  const started = performance.now();
  const result = decodeLog(bytes);
  return {result, elapsed: performance.now() - started};
}

function assertCellLimited(session, fieldCount, bodyBytes, label) {
  assert.equal(session.limitExceeded, true, `${label}: no limit was reached`);
  assert.ok(
    session.errors.some(error => error.code === 'limit-exceeded' && error.resource === 'cell'),
    `${label}: expected a cell limit error, got ${JSON.stringify(session.errors.slice(0, 3))}`
  );
  const cells = session.samples.length * fieldCount;
  assert.ok(cells <= CEILING_CELLS_PER_BYTE * bodyBytes + CEILING_FLOOR_CELLS,
    `${label}: ${cells} cells retained from a ${bodyBytes}-byte body`);
}

test('a 1024-field NULL table cannot turn every body byte into a 1024-cell sample', () => {
  const fieldCount = 1024;
  const {bytes, bodyBytes} = logWith(nullMainTable(fieldCount),
    new Uint8Array(4096).fill(0x49)); // 'I' x 4096
  const {result, elapsed} = decodeTimed(bytes);
  const [session] = result.sessions;

  assertCellLimited(session, fieldCount, bodyBytes, 'all-NULL I frames');
  assert.ok(session.samples.length > 0, 'frames inside the budget still decode');
  assert.ok(elapsed < 1500, `decode took ${Math.round(elapsed)} ms`);
});

test('one byte-carrying field among 1023 NULL fields is bounded the same way', () => {
  // Rejecting only all-NULL tables would not be enough: 1023 NULL fields plus
  // one varint field still yields 1024 cells per two bytes.
  const fieldCount = 1024;
  const encodings = new Array(fieldCount).fill(9);
  encodings[0] = 1;
  const body = new Uint8Array(8192);
  for (let index = 0; index < body.length; index += 2) {
    body[index] = 0x49; // 'I'
    body[index + 1] = 0x00; // field 0 = 0, and time never runs backwards
  }
  const {bytes, bodyBytes} = logWith(nullMainTable(fieldCount, encodings), body);
  const {result, elapsed} = decodeTimed(bytes);

  assertCellLimited(result.sessions[0], fieldCount, bodyBytes, 'one varint + 1023 NULL');
  assert.ok(elapsed < 1500, `decode took ${Math.round(elapsed)} ms`);
});

test('frames that are decoded and thrown away are bounded too, and each costs linear time', () => {
  // S frames are not retained, so a sample-count cap never sees them. Every
  // body byte here is a complete 1024-field S frame. Before the run scan was
  // capped at the encoding's group size, each of these cost ~524,000
  // comparisons; this body asks for ~16,000 of them.
  const fieldCount = 1024;
  const body = new Uint8Array(1 << 20).fill(0x53); // 'S'
  body.set([0x49, 0xe8, 0x07], 0); // one I frame first, time = 1000
  const {bytes, bodyBytes} = logWith([
    ...tableLines('I', ['time'], [1]),
    'H Field P predictor:1',
    'H Field P encoding:0',
    ...tableLines('S', names(fieldCount), new Array(fieldCount).fill(9))
  ], body);
  const {result, elapsed} = decodeTimed(bytes);
  const [session] = result.sessions;

  assert.deepEqual(session.samples, [[1000]]);
  assert.equal(session.limitExceeded, true);
  assert.ok(session.errors.some(error => error.code === 'limit-exceeded' && error.resource === 'cell'),
    JSON.stringify(session.errors.slice(0, 3)));
  assert.ok(session.frameCounts.S * fieldCount <=
    CEILING_CELLS_PER_BYTE * bodyBytes + CEILING_FLOOR_CELLS,
  `${session.frameCounts.S} S frames of ${fieldCount} fields from ${bodyBytes} bytes`);
  assert.ok(session.frameCounts.S > 1000, 'the budget must not stop a stream this size early');
  assert.ok(elapsed < 3000, `decode took ${Math.round(elapsed)} ms`);
});

test('every committed fixture decodes far inside the cell budget', async () => {
  // Headroom, measured on our own corpus: if a legitimate field table ever
  // approaches the budget, this fails before a pilot's log does.
  const files = (await readdir(fixtureDir)).filter(name => name.endsWith('.TXT'));
  assert.ok(files.length >= 10);

  for (const file of files) {
    const bytes = new Uint8Array(await readFile(path.join(fixtureDir, file)));
    const starts = findSessionStarts(bytes);
    const result = decodeLog(bytes);

    for (const session of result.sessions) {
      assert.equal(session.limitExceeded, false, `${file} session ${session.index}`);
      if (session.samples.length === 0) continue;
      const dataOffset = parseSession(bytes, starts[session.index], session.index).dataOffset;
      const bodyBytes = (starts[session.index + 1] ?? bytes.length) - dataOffset;
      const perByte = session.samples.length * session.fields.length / bodyBytes;
      assert.ok(perByte <= 4,
        `${file} session ${session.index}: ${perByte.toFixed(2)} cells per byte`);
    }
  }
});
