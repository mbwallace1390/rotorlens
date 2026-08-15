/**
 * Blackbox field encodings.
 *
 * Encoding identifiers are declared per field in the log header (`H Field I
 * encoding:...`). They are format facts, not our invention — a decoder has to
 * agree with them byte for byte or it reads nothing. What is ours is how they
 * are implemented here: several encodings cover a *group* of consecutive fields
 * that share one encoding, so the interface is group-oriented rather than
 * field-at-a-time, which keeps the frame loop free of per-encoding special
 * cases.
 *
 * Bit-level assumptions are recorded in docs/BLACKBOX_FORMAT_NOTES.md and are
 * verified against real firmware output by `npm run verify:log`.
 */

import {DecodeError, DecodeErrorCode} from './errors.mjs';
import {NibbleReader, signExtend} from './reader.mjs';

export const Encoding = Object.freeze({
  SIGNED_VB: 0,
  UNSIGNED_VB: 1,
  NEG_14BIT: 3,
  TAG8_8SVB: 6,
  TAG2_3S32: 7,
  TAG8_4S16: 8,
  NULL: 9,
  TAG2_3SVARIABLE: 10
});

/** Maximum fields each encoding covers in one group. */
const GROUP_CAPACITY = new Map([
  [Encoding.TAG8_8SVB, 8],
  [Encoding.TAG2_3S32, 3],
  [Encoding.TAG2_3SVARIABLE, 3],
  [Encoding.TAG8_4S16, 4]
]);

/**
 * How many consecutive fields the next read consumes: group encodings swallow up
 * to their capacity, everything else is one field at a time.
 */
export function groupSize(encoding, availableFields) {
  return Math.min(GROUP_CAPACITY.get(encoding) ?? 1, availableFields);
}

function decodeTag8_8SVB(reader, count) {
  // A single field skips the selector byte entirely.
  if (count === 1) {
    return [reader.signedVB()];
  }

  const present = reader.u8();
  const values = new Array(count);
  for (let index = 0; index < count; index += 1) {
    // Bit n selects field n, low bit first.
    //
    // This encoding is in the silent-permutation class too, which is not
    // obvious and was initially got wrong in the other direction. Reversing the
    // bits *within the group* preserves their popcount, so exactly the same
    // number of varints is read and the stream stays aligned: on the real 4.6
    // log a reversed order still gives 134,429 samples, 1 error and 525 resync
    // bytes — bit-identical. Only continuity separates them (altitude becomes
    // infinite and rssi 29.6x; on a third-party log axisI[0] hits 158.9x),
    // against a worst case of 1.16x in this order.
    values[index] = (present & (1 << index)) === 0 ? 0 : reader.signedVB();
  }
  return values;
}

function decodeTag2_3S32(reader, count) {
  const lead = reader.u8();
  const selector = lead >> 6;
  const values = [0, 0, 0];

  switch (selector) {
    case 0: // three 2-bit values packed into the lead byte
      // Field 0 in the HIGH pair, and that is not an oversight — see the note on
      // selector 3 below, which packs its widths the other way round.
      //
      // Each of selectors 0, 1 and 2 was reversed in turn against the real 4.6
      // log and measured by I-frame continuity. Every one blows up loudly:
      // reversing this selector puts axisO[0] at 5461x and axisI[2] at 71.5x,
      // reversing selector 1 puts attitude[1] at 19.7x, reversing selector 2
      // puts axisP[0] at 19.6x — against a worst case of 1.16x as shipped.
      for (let index = 0; index < 3; index += 1) {
        values[index] = signExtend((lead >> (4 - index * 2)) & 0x03, 2);
      }
      break;

    case 1: { // three 4-bit values: one in the lead byte, two in the next
      values[0] = signExtend(lead & 0x0f, 4);
      const packed = reader.u8();
      values[1] = signExtend((packed >> 4) & 0x0f, 4);
      values[2] = signExtend(packed & 0x0f, 4);
      break;
    }

    case 2: // three 6-bit values, one per byte
      values[0] = signExtend(lead & 0x3f, 6);
      values[1] = signExtend(reader.u8() & 0x3f, 6);
      values[2] = signExtend(reader.u8() & 0x3f, 6);
      break;

    default: // per-field byte widths, 2 bits each in the lead byte
      // Field 0's width is in the LOW two bits — the opposite end from the
      // 2-bit VALUES of selector 0 above, which is exactly the trap: this code
      // read the widths high-pair-first by analogy with selector 0 until 12
      // August 2026, and that was the second instance of the TAG8_4S16 bug.
      //
      // Permuting the three widths leaves their sum unchanged, so the group
      // consumed the right number of bytes either way: sample count (134,429),
      // error count (1) and resync bytes (525) on the real 4.6 log were
      // bit-identical, and our writer packed it the same wrong way so round-trip
      // agreed with itself. No round-trip test can ever settle a slot order.
      //
      // WHAT IS MEASURED, AND WHAT IS NOT. Of the six possible width-slot
      // permutations, the logs we hold separate this order from FOUR of them:
      //   • continuity — attitude[2] 17.93x → 0.67x at I-frame positions,
      //     axisP[1] 4.97x → 0.96x, attitude[0] 2.23x → 0.97x;
      //   • tightness, which needs no predictors at all — of the 7 groups in the
      //     real log whose outer widths differ, the old order spent 2 bytes on a
      //     value that fits in 1 in 6 of 21 slots; this order does so in 0 of 21;
      //   • physical range — attitude[2] is heading in decidegrees and lands on
      //     exactly 0..3599 with two clean wraps here, against -3..3595 before.
      //
      // The SIXTH permutation is NOT separated, and calling this layout measured
      // without saying so overstates it. Swapping which lead-byte pair feeds
      // field 0 and field 1 — reading (1,0,2) instead of (0,1,2) — decodes the
      // reference 4.6 log to BIT-IDENTICAL samples and still passes verify:log
      // 13/13, because all 633 of its selector-3 groups have width[0] ==
      // width[1] (624 are 1,1,1; 7 are 1,1,2; 2 are 4,4,4). No measurement can
      // separate two decoders that produce the same numbers, so continuity,
      // tightness and range say nothing here — they are silent, not supporting.
      // Re-measured 2026-08-12: the six permutations collapse to three
      // distinguishable classes on that log, and this order shares its class with
      // its own field-0/field-1 transposition.
      //
      // The consequence if it is wrong: this group carries axisP/axisI/axisD/
      // axisF/axisO, so the day firmware emits a selector-3 group whose first two
      // fields need different widths, roll and pitch PID terms silently swap.
      // What would settle it is a real log containing such a group — see
      // docs/BLACKBOX_FORMAT_NOTES.md. Our own corpus cannot: it would only prove
      // this reader agrees with our writer, which shares the assumption.
      for (let index = 0; index < 3; index += 1) {
        const width = ((lead >> (index * 2)) & 0x03) + 1;
        values[index] = reader.signedLE(width);
      }
      break;
  }

  return values.slice(0, count);
}

function decodeTag2_3SVariable(reader, count) {
  const lead = reader.u8();
  const selector = lead >> 6;

  // Only the widest selector differs from TAG2_3S32: it falls back to
  // variable-byte values rather than fixed byte widths.
  if (selector === 3) {
    const values = [reader.signedVB(), reader.signedVB(), reader.signedVB()];
    return values.slice(0, count);
  }

  reader.offset = reader.offset - 1;
  return decodeTag2_3S32(reader, count);
}

function decodeTag8_4S16(reader, count) {
  const lead = reader.u8();
  const widths = new Array(4);
  for (let index = 0; index < 4; index += 1) {
    // Field 0's width is in the LOW two bits, field 3's in the high two.
    //
    // This read the lead byte from the wrong end until 11 August 2026, and
    // nothing caught it: reversing the order permutes the widths {0,1,2,4} but
    // leaves their sum unchanged, so the nibble stream consumes exactly the
    // right number of bytes and the frame loop never loses sync. Our encoder
    // packed it the same wrong way, so round-trip agreed with itself, and
    // BLACKBOX_FORMAT_NOTES.md argued that holding sync over 134,000 frames
    // proved the order right. It proved nothing.
    //
    // What exposes it is continuity. A P frame carries a delta and an I frame
    // an absolute, so mis-assigned widths make a field drift for 31 samples and
    // snap back at each I frame. On the real 4.6 log, bucketing |Δ| by position
    // in the 32-sample I-frame period put a 28x spike on setpoint[0] at exactly
    // phase 0 (55x on setpoint[2], 46x on rcCommand[0]) while SVB-encoded
    // gyroADC[0] sat flat at 1.0x. Corrected, every one of them falls to ~1.2x
    // and the controls do not move.
    widths[index] = (lead >> (index * 2)) & 0x03;
  }

  const nibbles = new NibbleReader(reader);
  const values = new Array(4).fill(0);

  for (let index = 0; index < 4; index += 1) {
    switch (widths[index]) {
      case 0: values[index] = 0; break;
      case 1: values[index] = signExtend(nibbles.value(1), 4); break;
      case 2: values[index] = signExtend(nibbles.value(2), 8); break;
      default: values[index] = signExtend(nibbles.value(4), 16); break;
    }
  }

  return values.slice(0, count);
}

/**
 * Decodes one group of `count` fields sharing `encoding`. Returns raw encoded
 * values; predictors are applied by the caller.
 */
export function decodeGroup(reader, encoding, count) {
  switch (encoding) {
    case Encoding.SIGNED_VB:
      return [reader.signedVB()];

    case Encoding.UNSIGNED_VB:
      // Keep the full uint32 range. Coercing through a signed bitwise operation
      // turns timestamps >= 2^31 microseconds negative after about 35.8 minutes.
      return [reader.unsignedVB()];

    case Encoding.NEG_14BIT:
      return [-signExtend(reader.unsignedVB() & 0x3fff, 14)];

    case Encoding.NULL:
      return [0];

    case Encoding.TAG8_8SVB:
      return decodeTag8_8SVB(reader, count);

    case Encoding.TAG2_3S32:
      return decodeTag2_3S32(reader, count);

    case Encoding.TAG2_3SVARIABLE:
      return decodeTag2_3SVariable(reader, count);

    case Encoding.TAG8_4S16:
      return decodeTag8_4S16(reader, count);

    default:
      throw new DecodeError(
        DecodeErrorCode.UNSUPPORTED_ENCODING,
        `Unsupported field encoding ${encoding}`,
        {encoding, offset: reader.offset}
      );
  }
}
