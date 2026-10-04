import assert from 'node:assert/strict';
import test from 'node:test';
import {decodeLog} from '../src/blackbox/decode.mjs';
import {parseSession} from '../src/blackbox/headers.mjs';

const textEncoder = new TextEncoder();

function headerBytes(lines, suffix = 'I') {
  return textEncoder.encode(`${lines.join('\n')}\n${suffix}`);
}

const MINIMAL_HEADER = [
  'H Product:Blackbox flight data recorder by Nicholas Sherlock',
  'H Data version:2',
  'H Firmware type:Rotorflight',
  'H Firmware revision:Rotorflight 4.6.0 (header fixture) STM32F7X2'
];

test('parseSession does not retain ordered header entries by default', () => {
  const session = parseSession(headerBytes(MINIMAL_HEADER), 0, 0);

  assert.equal(Object.hasOwn(session, 'headerEntries'), false);
  assert.equal(session.headerTerminationClean, true);
  assert.equal(session.headerKeysUnique, true);
  assert.equal(session.headerCount, MINIMAL_HEADER.length);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(session, 'headerTerminationClean'),
    {
      value: true,
      enumerable: true,
      writable: false,
      configurable: false
    }
  );
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(session, 'headerKeysUnique'),
    {
      value: true,
      enumerable: true,
      writable: false,
      configurable: false
    }
  );
  assert.equal(Object.isFrozen(session), false);
  assert.throws(() => {
    session.headerTerminationClean = false;
  }, TypeError);
});

test('parseSession retains an immutable ordered header snapshot only when requested', () => {
  const lines = [...MINIMAL_HEADER, 'H gyro_lpf1_static_hz:100', 'H gyro_lpf1_static_hz:200'];
  const session = parseSession(headerBytes(lines), 0, 0, {retainHeaderEntries: true});

  assert.equal(session.headerKeysUnique, false);
  assert.equal(Object.isFrozen(session.headerEntries), true);
  assert.equal(session.headerEntries.every(Object.isFrozen), true);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(session, 'headerEntries'),
    {
      value: session.headerEntries,
      enumerable: true,
      writable: false,
      configurable: false
    }
  );
  assert.equal(Object.isFrozen(session), false);
  assert.deepEqual(
    session.headerEntries.slice(-2),
    [
      {key: 'gyro_lpf1_static_hz', value: '100'},
      {key: 'gyro_lpf1_static_hz', value: '200'}
    ]
  );
  assert.throws(() => session.headerEntries.push({key: 'extra', value: '1'}), TypeError);
  assert.throws(() => {
    session.headerEntries[0].value = 'changed';
  }, TypeError);
  assert.throws(() => {
    session.headerEntries = Object.freeze([]);
  }, TypeError);
  assert.throws(() => {
    delete session.headerEntries;
  }, TypeError);
});

test('parseSession reports unterminated and malformed trailing header lines as unclean', () => {
  const unterminated = parseSession(
    headerBytes(MINIMAL_HEADER, 'H gyro_lpf1_static_hz:100'),
    0,
    0,
    {retainHeaderEntries: true}
  );
  const malformed = parseSession(
    headerBytes(MINIMAL_HEADER, 'H malformed setting\n'),
    0,
    0,
    {retainHeaderEntries: true}
  );
  const emptyKey = parseSession(
    headerBytes(MINIMAL_HEADER, 'H :value\n'),
    0,
    0,
    {retainHeaderEntries: true}
  );

  assert.equal(unterminated.headerTerminationClean, false);
  assert.equal(malformed.headerTerminationClean, false);
  assert.equal(emptyKey.headerTerminationClean, false);
  assert.equal(
    unterminated.headerEntries.some(entry => entry.key === 'gyro_lpf1_static_hz'),
    false,
    'an unterminated setting must not enter retained evidence'
  );
  assert.equal(
    malformed.headerEntries.some(entry => entry.key === 'malformed setting'),
    false,
    'a malformed setting must not enter retained evidence'
  );
});

/**
 * A complete header, then a frame stream with no 0x0A byte for more than the
 * 64 KiB a header line may run to.
 *
 * Binary frames are not lines. The parser used to measure the first line of
 * frame data before checking whether it even started `H `, so a body with no
 * newline in its first 64 KiB — an erased or zero-filled stretch after a short
 * flight — threw "Header line exceeds 65536 bytes" and the whole session was
 * reported unreadable, with a header error, over a header that was fine.
 */
function headerThenBody(body) {
  const header = textEncoder.encode([
    ...MINIMAL_HEADER,
    'H Field I name:time',
    'H Field I signed:0',
    'H Field I predictor:0',
    'H Field I encoding:1',
    'H Field P predictor:1',
    'H Field P encoding:0',
    ''
  ].join('\n'));
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header, 0);
  bytes.set(body, header.length);
  return {bytes, dataOffset: header.length};
}

/** One I frame, `time = 1000`, then `padLength` bytes of `pad` and no newline. */
function oneFrameThenPad(pad, padLength) {
  const body = new Uint8Array(3 + padLength).fill(pad);
  body.set([0x49, 0xe8, 0x07], 0); // 'I', unsigned varint 1000
  return headerThenBody(body);
}

test('a frame stream with no newline in 64 KiB is frame data, not an overlong header line', () => {
  for (const pad of [0x00, 0xff, 0x80]) {
    const {bytes, dataOffset} = oneFrameThenPad(pad, 70_000);
    const label = `pad 0x${pad.toString(16)}`;

    const session = parseSession(bytes, 0, 0);
    assert.equal(session.dataOffset, dataOffset, label);
    assert.equal(session.headerTerminationClean, true, label);
    assert.equal(session.frames.I.fields.length, 1, label);

    // And through the real entry point: the frame before the pad decodes, and
    // nothing is blamed on the header.
    const [decoded] = decodeLog(bytes).sessions;
    assert.deepEqual(decoded.samples, [[1000]], label);
    assert.equal(decoded.limitExceeded, false, label);
    assert.ok(decoded.errors.every(error => error.code !== 'limit-exceeded'),
      `${label}: ${JSON.stringify(decoded.errors)}`);
  }
});

test('a header line that really is longer than 64 KiB is still refused', () => {
  const lines = [...MINIMAL_HEADER, `H Long note:${'x'.repeat(70_000)}`, 'H Field I name:time'];
  assert.throws(
    () => parseSession(headerBytes(lines), 0, 0),
    error => error.code === 'limit-exceeded' && /Header line exceeds/.test(error.message)
  );

  // The same overlong `H ` line with no newline before end of file.
  assert.throws(
    () => parseSession(
      textEncoder.encode(`${MINIMAL_HEADER.join('\n')}\nH Long note:${'x'.repeat(70_000)}`),
      0,
      0
    ),
    error => error.code === 'limit-exceeded' && /Header line exceeds/.test(error.message)
  );
});
