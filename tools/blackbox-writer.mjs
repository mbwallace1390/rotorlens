/**
 * Blackbox log writer.
 *
 * This exists so the decoder can be validated without anyone else's log file.
 * Encoding a known sample series and decoding it back proves the two halves of
 * every encoding and predictor agree, exercised over real frame streams rather
 * than hand-picked byte vectors.
 *
 * What round-trip proves: our encodings are self-consistent and our frame loop,
 * predictors, and group handling work end to end.
 * What it does NOT prove: that our bit layout matches what a flight controller
 * actually writes. Only a real log settles that — see `npm run verify:log`.
 */

import {Encoding} from '../src/blackbox/encodings.mjs';
import {Predictor, predict} from '../src/blackbox/predictors.mjs';
import {zigZagEncode} from '../src/blackbox/reader.mjs';

class ByteWriter {
  #bytes = [];
  #pendingNibble = null;

  get length() {
    return this.#bytes.length;
  }

  u8(value) {
    this.#flushNibble();
    this.#bytes.push(value & 0xff);
    return this;
  }

  ascii(text) {
    this.#flushNibble();
    for (const byte of Buffer.from(text, 'ascii')) {
      this.#bytes.push(byte);
    }
    return this;
  }

  unsignedVB(value) {
    this.#flushNibble();
    let remaining = value >>> 0;

    while (remaining > 0x7f) {
      this.#bytes.push((remaining & 0x7f) | 0x80);
      remaining >>>= 7;
    }
    this.#bytes.push(remaining);
    return this;
  }

  signedVB(value) {
    return this.unsignedVB(zigZagEncode(value | 0));
  }

  signedLE(value, byteCount) {
    this.#flushNibble();
    for (let index = 0; index < byteCount; index += 1) {
      this.#bytes.push((value >> (index * 8)) & 0xff);
    }
    return this;
  }

  /** Firmware writes adjustment floats as little-endian IEEE-754 binary32. */
  floatLE(value) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, value, true);
    for (const byte of bytes) {
      this.u8(byte);
    }
    return this;
  }

  /** Writes a 4-bit half byte; nibbles pair up high half first. */
  nibble(value) {
    if (this.#pendingNibble === null) {
      this.#pendingNibble = value & 0x0f;
    } else {
      this.#bytes.push((this.#pendingNibble << 4) | (value & 0x0f));
      this.#pendingNibble = null;
    }
    return this;
  }

  nibbles(value, count) {
    for (let index = count - 1; index >= 0; index -= 1) {
      this.nibble((value >> (index * 4)) & 0x0f);
    }
    return this;
  }

  #flushNibble() {
    if (this.#pendingNibble !== null) {
      this.#bytes.push(this.#pendingNibble << 4); // trailing half byte is padding
      this.#pendingNibble = null;
    }
  }

  toBuffer() {
    this.#flushNibble();
    return Buffer.from(this.#bytes);
  }
}

function fitsSigned(value, bits) {
  const limit = 1 << (bits - 1);
  return value >= -limit && value < limit;
}

/**
 * `reverseSlotOrder` deliberately assigns each grouped encoding's per-field slots
 * to the wrong fields: the width slots of TAG2_3S32 selector 3 and TAG8_4S16
 * (the exact defect both shipped with), and the selector bits of TAG8_8SVB (the
 * same class, and not obviously so — reversing bits within a group preserves
 * their popcount, so the byte count does not move either).
 *
 * It exists so a test can build a log that carries the bug in BOTH halves at
 * once, which is the only configuration a round-trip test cannot detect, and
 * prove the I-frame continuity check sees it anyway. Nothing that generates a
 * fixture may pass it.
 */
function writeTag2_3S32(writer, values, reverseSlotOrder = false) {
  if (values.every(value => fitsSigned(value, 2))) {
    let lead = 0 << 6;
    values.forEach((value, index) => {
      lead |= (value & 0x03) << (4 - index * 2);
    });
    writer.u8(lead);
    return;
  }

  if (values.every(value => fitsSigned(value, 4))) {
    writer.u8((1 << 6) | (values[0] & 0x0f));
    writer.u8(((values[1] & 0x0f) << 4) | (values[2] & 0x0f));
    return;
  }

  if (values.every(value => fitsSigned(value, 6))) {
    writer.u8((2 << 6) | (values[0] & 0x3f));
    writer.u8(values[1] & 0x3f);
    writer.u8(values[2] & 0x3f);
    return;
  }

  const widths = values.map(value => {
    if (fitsSigned(value, 8)) return 1;
    if (fitsSigned(value, 16)) return 2;
    if (fitsSigned(value, 24)) return 3;
    return 4;
  });

  let lead = 3 << 6;
  widths.forEach((width, index) => {
    // Field 0 in the low two bits, matching decodeTag2_3S32. Both halves packed
    // this backwards until 12 August 2026 and agreed with each other — the same
    // trap as TAG8_4S16 below, in the same encoding family, found the same way.
    lead |= (width - 1) << (reverseSlotOrder ? 4 - index * 2 : index * 2);
  });
  writer.u8(lead);
  values.forEach((value, index) => writer.signedLE(value, widths[index]));
}

function writeTag8_4S16(writer, values, reverseSlotOrder = false) {
  const padded = [...values, 0, 0, 0, 0].slice(0, 4);
  const widths = padded.map(value => {
    if (value === 0) return 0;
    if (fitsSigned(value, 4)) return 1;
    if (fitsSigned(value, 8)) return 2;
    return 3;
  });

  let lead = 0;
  widths.forEach((width, index) => {
    // Field 0 in the low two bits, matching decodeTag8_4S16. Both halves packed
    // this backwards until 11 August 2026 and agreed with each other, which is
    // precisely why the round-trip test could not see it — see the comment in
    // src/blackbox/encodings.mjs for what finally exposed it.
    lead |= width << (reverseSlotOrder ? 6 - index * 2 : index * 2);
  });
  writer.u8(lead);

  padded.forEach((value, index) => {
    switch (widths[index]) {
      case 0: break;
      case 1: writer.nibbles(value & 0x0f, 1); break;
      case 2: writer.nibbles(value & 0xff, 2); break;
      default: writer.nibbles(value & 0xffff, 4); break;
    }
  });
}

function writeTag8_8SVB(writer, values, reverseSelectorBits = false) {
  if (values.length === 1) {
    writer.signedVB(values[0]);
    return;
  }

  let present = 0;
  values.forEach((value, index) => {
    if (value !== 0) {
      // Reversing within the group preserves the popcount, so the same number of
      // varints is written and the stream length does not move — this encoding is
      // in the same silent class as the width-packed ones. Test-only, as above.
      present |= 1 << (reverseSelectorBits ? values.length - 1 - index : index);
    }
  });

  writer.u8(present);
  values.forEach(value => {
    if (value !== 0) {
      writer.signedVB(value);
    }
  });
}

export function writeGroup(writer, encoding, values, options = {}) {
  const reversed = options.reverseSlotOrder === true;

  switch (encoding) {
    case Encoding.SIGNED_VB: writer.signedVB(values[0]); break;
    case Encoding.UNSIGNED_VB: writer.unsignedVB(values[0]); break;
    case Encoding.NEG_14BIT: writer.unsignedVB((-values[0]) & 0x3fff); break;
    case Encoding.NULL: break;
    case Encoding.TAG8_8SVB: writeTag8_8SVB(writer, values, reversed); break;
    case Encoding.TAG2_3S32:
      writeTag2_3S32(writer, [...values, 0, 0, 0].slice(0, 3), reversed);
      break;
    case Encoding.TAG8_4S16: writeTag8_4S16(writer, values, reversed); break;
    default:
      throw new Error(`Writer does not support encoding ${encoding}`);
  }
}

/** Mirrors the decoder's grouping rule so both sides agree on field runs. */
function groupCapacity(encoding) {
  switch (encoding) {
    case Encoding.TAG8_8SVB: return 8;
    case Encoding.TAG2_3S32: return 3;
    case Encoding.TAG8_4S16: return 4;
    default: return 1;
  }
}

/**
 * Encodes one frame body: residuals against each field's predictor, grouped the
 * same way the decoder groups them.
 */
function writeFrameBody(writer, fields, values, history, constants, isDelta, options = {}) {
  const motor0Index = fields.findIndex(field => field.name === 'motor[0]');
  // Where the HOME_COORD run starts, so latitude encodes against home latitude
  // and longitude against home longitude. The decoder pairs by FIELD position
  // (see `#homeBaseFor`); pairing by group position instead is one of the four
  // defects this decoder has already had, and an encoder that made the same
  // mistake would agree with it and hide it.
  const homeBase = fields.findIndex(field => field.predictor === Predictor.HOME_COORD);
  let index = 0;

  while (index < fields.length) {
    const encoding = fields[index].encoding;

    let run = 1;
    while (index + run < fields.length && fields[index + run].encoding === encoding) {
      run += 1;
    }
    const count = Math.min(groupCapacity(encoding), run);

    const residuals = [];
    for (let offset = 0; offset < count; offset += 1) {
      const fieldIndex = index + offset;
      const prediction = predict(fields[fieldIndex].predictor, {
        previous: isDelta && history.previous ? history.previous[fieldIndex] : 0,
        previous2: isDelta && history.previous2 ? history.previous2[fieldIndex] : 0,
        current: values,
        constants,
        motor0Index,
        homeCoord: homeBase >= 0 ? (options.home ?? [0, 0])[fieldIndex - homeBase] ?? 0 : 0
      });
      residuals.push((values[fieldIndex] - prediction) | 0);
    }

    writeGroup(writer, encoding, residuals, options);
    index += count;
  }
}

export function writeHeaderBlock(lines) {
  return `${lines.join('\n')}\n`;
}

/** Rotorflight 4.6 event serialization, matching firmware's switch by event ID. */
function writeEvent(writer, event) {
  writer.ascii('E').u8(event.type);

  // Pre-encoded payloads remain available for corruption/adversarial vectors.
  // Normal fixtures should use the typed properties below.
  if (event.payload !== undefined) {
    for (const byte of event.payload) writer.u8(byte);
    return;
  }

  switch (event.type) {
    case 0:
      writer.unsignedVB(event.time);
      break;
    case 13: {
      const floatValue = event.valueType === 'float';
      writer.u8((event.function & 0x7f) | (floatValue ? 0x80 : 0));
      if (floatValue) writer.floatLE(event.value);
      else writer.signedVB(event.value);
      break;
    }
    case 14:
      writer.unsignedVB(event.loopIteration).unsignedVB(event.time);
      break;
    case 30:
      writer.unsignedVB(event.flags).unsignedVB(event.lastFlags);
      break;
    case 15:
    case 50:
    case 51:
    case 52:
      writer.unsignedVB(event.state);
      break;
    case 100:
    case 101: {
      const payload = event.data ?? [];
      if (payload.length > 255) throw new RangeError('Event payload exceeds one-byte length');
      writer.u8(payload.length);
      for (const byte of payload) writer.u8(byte);
      break;
    }
    default:
      throw new Error(`Writer does not support event type ${event.type}`);
  }
}

function writeLogEnd(writer) {
  writer.ascii('E').u8(255).ascii('End of log').u8(0);
}

/**
 * Writes a complete session: header block followed by an I/P frame stream.
 *
 * @param {object} spec
 * @param {string[]} spec.headerLines  full `H key:value` lines
 * @param {object[]} spec.intraFields  {name, predictor, encoding}
 * @param {object[]} spec.interFields  {name, predictor, encoding}
 * @param {number[][]} spec.frames     absolute field values per frame
 * @param {number} spec.intraInterval  emit an I frame every N frames
 * @param {object} spec.constants      predictor constants (minthrottle, vbatref…)
 * @param {object[]} [spec.events]     typed Rotorflight event records; `payload`
 *   is accepted only as an explicitly pre-encoded test vector
 * @param {object[]} [spec.gpsFields]  {name, predictor, encoding} for `G` frames
 * @param {object[]} [spec.homeFields] {name, predictor, encoding} for `H` frames
 * @param {object[]} [spec.gpsFrames]  {afterFrame, values[]} `G` frame records
 * @param {object[]} [spec.homeFrames] {afterFrame, values[]} `H` frame records
 * @param {boolean} [spec.reverseSlotOrder] deliberately mis-pack width slots —
 *   test-only, see the note above `writeTag2_3S32`
 *
 * G and H frames exist here because nothing else could reach that half of the
 * decoder. No committed fixture contained a single `G` frame, so `gps[]`,
 * `#publishGpsFix`, HOME_COORD and LAST_MAIN_FRAME_TIME were exercised only by
 * one uncommitted reference log — and a defect in any of them was invisible to
 * `npm test` on a clean checkout. Two of the decoder's four historical defects
 * lived in exactly that region.
 */
export function writeSession(spec) {
  const writer = new ByteWriter();
  writer.ascii(writeHeaderBlock(spec.headerLines));

  const constants = {
    minthrottle: 0,
    maxthrottle: 0,
    vbatref: 0,
    minmotor: 0,
    // Must match what the decoder derives from this session's headers, or the
    // INCREMENT-predicted field encodes against a different step than it decodes.
    incrementStep: 1,
    lastMainFrameTime: 0,
    ...spec.constants
  };

  const history = {previous: null, previous2: null};
  const timeIndex = spec.intraFields.findIndex(field => field.name === 'time');

  // The home coordinate a `G` frame's HOME_COORD fields predict against. It is
  // whatever the most recent `H` frame set, exactly as the decoder tracks it.
  let home = [0, 0];

  /** One `G` or `H` frame. Neither is a delta, so `history` is not consulted. */
  const writeAuxFrame = (marker, fields, values) => {
    writer.ascii(marker);
    writeFrameBody(writer, fields, values, history, constants, false, {home});
  };

  /**
   * Emits every `H` then `G` frame scheduled for this position.
   *
   * `H` first: a `G` frame's coordinates predict against the home the last `H`
   * frame set, so writing them the other way round would encode against a home
   * the decoder has not seen yet.
   *
   * `afterFrame: -1` puts a frame BEFORE the first main frame. That position is
   * the whole point of supporting these: it is the only place a G frame is
   * decoded while `lastMainFrameTime` still holds its seed, which is where a
   * constant leaking between two decodes of one session becomes visible.
   */
  const writeAuxFramesAt = position => {
    for (const frame of spec.homeFrames ?? []) {
      if (frame.afterFrame === position) {
        writeAuxFrame('H', spec.homeFields, frame.values);
        home = [frame.values[0] ?? 0, frame.values[1] ?? 0];
      }
    }
    for (const frame of spec.gpsFrames ?? []) {
      if (frame.afterFrame === position) {
        writeAuxFrame('G', spec.gpsFields, frame.values);
      }
    }
  };

  writeAuxFramesAt(-1);

  spec.frames.forEach((values, frameIndex) => {
    const isIntra = frameIndex % spec.intraInterval === 0;

    writer.ascii(isIntra ? 'I' : 'P');
    writeFrameBody(
      writer,
      isIntra ? spec.intraFields : spec.interFields,
      values,
      history,
      constants,
      !isIntra,
      {reverseSlotOrder: spec.reverseSlotOrder === true}
    );

    if (isIntra) {
      history.previous = values;
      history.previous2 = values;
    } else {
      history.previous2 = history.previous;
      history.previous = values;
    }
    if (timeIndex >= 0) {
      constants.lastMainFrameTime = values[timeIndex];
    }

    // Real logs interleave event records between frames; a corpus without them
    // cannot catch an event whose payload length we skip wrongly.
    for (const event of spec.events ?? []) {
      if (event.afterFrame === frameIndex) {
        writeEvent(writer, event);
      }
    }

    writeAuxFramesAt(frameIndex);
  });

  // Terminal event: tells the decoder the stream ended cleanly rather than being
  // cut off, which is the difference between "complete" and "truncated".
  writeLogEnd(writer);

  return writer.toBuffer();
}

export {ByteWriter};
