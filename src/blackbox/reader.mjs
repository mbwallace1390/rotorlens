/**
 * Bounds-checked pull reader over immutable log bytes, plus the integer
 * primitives the Blackbox field encodings are built from.
 *
 * The reader never reads past the end of the buffer: every overrun raises a
 * typed TRUNCATED error that the frame loop turns into recorded data. Callers
 * treat `offset` as a savepoint — on a bad frame the loop rewinds and resyncs.
 */

import {DecodeErrorCode, DecodeError, truncated} from './errors.mjs';

/** ZigZag: maps signed values onto unsigned so small magnitudes stay small. */
export function zigZagEncode(value) {
  return ((value << 1) ^ (value >> 31)) >>> 0;
}

export function zigZagDecode(value) {
  return ((value >>> 1) ^ -(value & 1)) | 0;
}

/** Sign-extends the low `bits` of `value` to a full 32-bit signed integer. */
export function signExtend(value, bits) {
  const shift = 32 - bits;
  return (value << shift) >> shift;
}

export class ByteReader {
  #bytes;
  #view;
  #offset;
  #end;

  constructor(bytes, offset = 0, endOffset = bytes?.length) {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError('ByteReader requires a Uint8Array');
    }
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#end = bytes.length;
    this.endOffset = endOffset;
    this.offset = offset;
  }

  get offset() {
    return this.#offset;
  }

  set offset(next) {
    this.#offset = Math.max(0, Math.min(next, this.#end));
  }

  /** Absolute exclusive boundary. Lets one immutable file back several readers. */
  get endOffset() {
    return this.#end;
  }

  set endOffset(next) {
    if (!Number.isSafeInteger(next)) {
      throw new TypeError('ByteReader endOffset must be a safe integer');
    }
    this.#end = Math.max(0, Math.min(next, this.#bytes.length));
    if (Number.isFinite(this.#offset) && this.#offset > this.#end) {
      this.#offset = this.#end;
    }
  }

  get length() {
    return this.#end;
  }

  get remaining() {
    return this.#end - this.#offset;
  }

  get exhausted() {
    return this.#offset >= this.#end;
  }

  /** Reads one byte without consuming it; null at end of input. */
  peek() {
    return this.#offset < this.#end ? this.#bytes[this.#offset] : null;
  }

  /** Reads a byte at an absolute offset without moving the cursor. */
  at(offset) {
    return offset >= 0 && offset < this.#end ? this.#bytes[offset] : null;
  }

  u8() {
    if (this.#offset >= this.#end) {
      throw truncated('Log ended mid-frame', {offset: this.#offset});
    }
    return this.#bytes[this.#offset++];
  }

  skip(count) {
    this.offset = this.#offset + count;
  }

  /**
   * Unsigned variable-byte integer: 7 payload bits per byte, high bit marks
   * continuation. Capped at 5 bytes because the payload is a 32-bit value; a
   * longer run means we are not looking at a real field.
   */
  unsignedVB() {
    let result = 0;
    let shift = 0;

    for (let byteIndex = 0; byteIndex < 5; byteIndex += 1) {
      const byte = this.u8();

      // A uint32 has only four payload bits left in byte five. JavaScript's
      // bitwise shifts wrap their shift count modulo 32, so accepting 0x10..7f
      // here would silently fold bit 32 back into the low end of the value.
      if (byteIndex === 4 && (byte & 0xf0) !== 0) {
        throw new DecodeError(
          DecodeErrorCode.CORRUPT_FRAME,
          'Variable-byte integer exceeded 32 bits',
          {offset: this.#offset}
        );
      }
      result |= (byte & 0x7f) << shift;

      if ((byte & 0x80) === 0) {
        return result >>> 0;
      }
      shift += 7;
    }

    throw new DecodeError(
      DecodeErrorCode.CORRUPT_FRAME,
      'Variable-byte integer exceeded 32 bits',
      {offset: this.#offset}
    );
  }

  signedVB() {
    return zigZagDecode(this.unsignedVB());
  }

  /** Little-endian signed integer of `byteCount` bytes (1-4). */
  signedLE(byteCount) {
    let value = 0;
    for (let index = 0; index < byteCount; index += 1) {
      value |= this.u8() << (index * 8);
    }
    return signExtend(value, byteCount * 8);
  }

  /** IEEE-754 single precision in the little-endian order firmware writes. */
  floatLE() {
    if (this.remaining < 4) {
      throw truncated('Log ended mid-float', {offset: this.#offset});
    }
    const value = this.#view.getFloat32(this.#offset, true);
    this.#offset += 4;
    return value;
  }
}

/**
 * Sequential 4-bit reader used by the nibble-packed field encoding. Nibbles are
 * high-half first; a trailing half byte is padding.
 */
export class NibbleReader {
  #reader;
  #current = 0;
  #hasLowHalf = false;

  constructor(reader) {
    this.#reader = reader;
  }

  next() {
    if (this.#hasLowHalf) {
      this.#hasLowHalf = false;
      return this.#current & 0x0f;
    }

    this.#current = this.#reader.u8();
    this.#hasLowHalf = true;
    return (this.#current >> 4) & 0x0f;
  }

  /** Reads `count` nibbles as one big-endian value. */
  value(count) {
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      value = (value << 4) | this.next();
    }
    return value;
  }
}
