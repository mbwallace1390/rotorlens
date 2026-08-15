import assert from 'node:assert/strict';
import test from 'node:test';
import {ByteReader, signExtend, zigZagDecode, zigZagEncode} from '../src/blackbox/reader.mjs';
import {Encoding, decodeGroup, groupSize} from '../src/blackbox/encodings.mjs';
import {DecodeErrorCode} from '../src/blackbox/errors.mjs';
import {ByteWriter, writeGroup} from '../tools/blackbox-writer.mjs';

/** Encodes values with the writer, then decodes them back with the decoder. */
function roundTrip(encoding, values) {
  const writer = new ByteWriter();
  writeGroup(writer, encoding, values);
  const bytes = new Uint8Array(writer.toBuffer());
  return decodeGroup(new ByteReader(bytes), encoding, values.length);
}

test('zigzag survives the full signed range including the extremes', () => {
  const cases = [0, -1, 1, -2, 2, 127, -128, 32_767, -32_768, 2_147_483_647, -2_147_483_648];
  for (const value of cases) {
    assert.equal(zigZagDecode(zigZagEncode(value)), value, `zigzag failed for ${value}`);
  }
});

test('sign extension recovers negative values from packed bit widths', () => {
  assert.equal(signExtend(0b11, 2), -1);
  assert.equal(signExtend(0b01, 2), 1);
  assert.equal(signExtend(0b1000, 4), -8);
  assert.equal(signExtend(0b0111, 4), 7);
  assert.equal(signExtend(0b100000, 6), -32);
  assert.equal(signExtend(0xffff, 16), -1);
});

test('variable-byte integers round-trip across byte-length boundaries', () => {
  // 127/128 and 16383/16384 are where the encoding grows a byte.
  for (const value of [0, 1, 127, 128, 16_383, 16_384, 2_097_151, 2_097_152, 0xffff_ffff]) {
    const writer = new ByteWriter();
    writer.unsignedVB(value);
    const reader = new ByteReader(new Uint8Array(writer.toBuffer()));
    assert.equal(reader.unsignedVB(), value >>> 0, `unsignedVB failed for ${value}`);
  }
});

test('a variable-byte run that never terminates is reported, not looped on', () => {
  const reader = new ByteReader(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80]));
  assert.throws(() => reader.unsignedVB(), error => error.code === DecodeErrorCode.CORRUPT_FRAME);
});

test('reading past the end of the log raises a truncation error', () => {
  const reader = new ByteReader(new Uint8Array([0x01]));
  reader.u8();
  assert.throws(() => reader.u8(), error => error.code === DecodeErrorCode.TRUNCATED);
});

test('single-value encodings round-trip', () => {
  assert.deepEqual(roundTrip(Encoding.SIGNED_VB, [-123_456]), [-123_456]);
  assert.deepEqual(roundTrip(Encoding.SIGNED_VB, [0]), [0]);
  assert.deepEqual(roundTrip(Encoding.UNSIGNED_VB, [1_000_000]), [1_000_000]);
  assert.deepEqual(roundTrip(Encoding.NEG_14BIT, [-8191]), [-8191]);
  assert.deepEqual(roundTrip(Encoding.NULL, [0]), [0]);
});

test('TAG2_3S32 round-trips through every selector width', () => {
  const byWidth = [
    [-2, 1, 0],                    // 2-bit
    [-8, 7, 3],                    // 4-bit
    [-32, 31, 12],                 // 6-bit
    [-128, 300, -70_000],          // per-field byte widths
    [2_000_000, -2_000_000, 1]     // widest fields
  ];

  for (const values of byWidth) {
    assert.deepEqual(roundTrip(Encoding.TAG2_3S32, values), values,
      `TAG2_3S32 failed for ${values.join(',')}`);
  }
});

test('TAG8_4S16 round-trips through every per-field width including zeros', () => {
  const cases = [
    [0, 0, 0, 0],
    [-8, 7, 0, 1],
    [-128, 127, 0, -1],
    [-32_768, 32_767, 0, 1234],
    [1, -200, 30_000, 0]
  ];

  for (const values of cases) {
    assert.deepEqual(roundTrip(Encoding.TAG8_4S16, values), values,
      `TAG8_4S16 failed for ${values.join(',')}`);
  }
});

test('TAG8_8SVB round-trips dense, sparse, and single-field groups', () => {
  assert.deepEqual(roundTrip(Encoding.TAG8_8SVB, [42]), [42]);
  assert.deepEqual(
    roundTrip(Encoding.TAG8_8SVB, [0, 0, 0, 0, 0, 0, 0, 0]),
    [0, 0, 0, 0, 0, 0, 0, 0]
  );
  assert.deepEqual(
    roundTrip(Encoding.TAG8_8SVB, [1, 0, -300, 0, 0, 99_999, 0, -1]),
    [1, 0, -300, 0, 0, 99_999, 0, -1]
  );
});

test('group sizing matches each encoding capacity and never overruns the field list', () => {
  assert.equal(groupSize(Encoding.TAG8_8SVB, 20), 8);
  assert.equal(groupSize(Encoding.TAG8_8SVB, 3), 3);
  assert.equal(groupSize(Encoding.TAG2_3S32, 9), 3);
  assert.equal(groupSize(Encoding.TAG8_4S16, 9), 4);
  assert.equal(groupSize(Encoding.SIGNED_VB, 9), 1);
});

test('an unknown encoding is a typed error rather than silent garbage', () => {
  const reader = new ByteReader(new Uint8Array([0x00, 0x00]));
  assert.throws(
    () => decodeGroup(reader, 42, 1),
    error => error.code === DecodeErrorCode.UNSUPPORTED_ENCODING
  );
});
