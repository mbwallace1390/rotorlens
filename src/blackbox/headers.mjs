/**
 * Log header parsing: turns the textual `H key:value` block at the start of each
 * session into the field definition tables the frame decoder runs on.
 *
 * A log is a concatenation of independent sessions, each with its own header
 * block, so a single file can mix firmware versions and field sets. Every
 * session is described independently here for that reason.
 */

import {DecodeError, DecodeErrorCode} from './errors.mjs';
import {Encoding} from './encodings.mjs';
import {Predictor} from './predictors.mjs';

const SESSION_MARKER = 'H Product:';
const DATA_VERSION_MARKER = 'H Data version:';
const LOCATION_FIELD_PATTERN = /^(gps|home)/i;
const MAX_FIELDS_PER_FRAME = 1024;
const MAX_HEADER_LINES = 4096;
const MAX_HEADER_LINE_BYTES = 64 * 1024;
const SUPPORTED_ENCODINGS = new Set(Object.values(Encoding));
const SUPPORTED_PREDICTORS = new Set(Object.values(Predictor));

/** Frame types that carry field definitions, in header-declaration order. */
export const FrameType = Object.freeze({
  INTRA: 'I',
  INTER: 'P',
  SLOW: 'S',
  GPS: 'G',
  GPS_HOME: 'H',
  EVENT: 'E'
});

const textDecoder = new TextDecoder('utf-8');

/**
 * Finds `needle` in `haystack` at or after `from`.
 *
 * Hand-rolled rather than using Buffer.indexOf: the decoder has to run in a
 * WebView and in a mobile runtime, not just Node, and Buffer exists in neither.
 *
 * The candidate positions come from `TypedArray.prototype.indexOf` — plain
 * ES2015, present in every runtime this ships to — rather than from a
 * per-byte loop in JS. Only the first byte is searched natively; the rest is
 * compared here. On the 125 MB dataflash dump that is 29 ms instead of 232 ms,
 * and this scan is the whole cost of listing a log's sessions.
 */
function indexOfBytes(haystack, needle, from) {
  const last = haystack.length - needle.length;
  const first = needle[0];
  let start = Math.max(0, from);

  while (start <= last) {
    start = haystack.indexOf(first, start);
    if (start === -1 || start > last) {
      return -1;
    }

    let offset = 1;
    while (offset < needle.length && haystack[start + offset] === needle[offset]) {
      offset += 1;
    }
    if (offset === needle.length) {
      return start;
    }

    start += 1;
  }

  return -1;
}

function asciiBytes(text) {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index);
  }
  return bytes;
}

/**
 * A session marker must be followed by a complete Product line and another
 * header line. Inside an already-recognized header, only the complete Product +
 * Data-version preamble firmware writes can split an adjacent session.
 *
 * Sessions are concatenated with no separator, so the byte before a marker is
 * arbitrary binary from the previous session's last frame — requiring a newline
 * there silently drops every session after the first. Confirming the header
 * shape that follows is both more permissive and more selective: it accepts a
 * real mid-file session start, while the exact nested-preamble check distinguishes
 * an adjacent header-only session from a repeated Product metadata key.
 */
function boundedLineEnd(buffer, offset) {
  const end = Math.min(buffer.length, offset + MAX_HEADER_LINE_BYTES + 1);
  const relative = buffer.subarray(offset, end).indexOf(0x0a);
  return relative === -1 ? -1 : offset + relative;
}

function startsHeaderBlock(buffer, offset) {
  const productLineEnd = boundedLineEnd(buffer, offset);
  if (productLineEnd === -1) {
    return false;
  }

  return buffer[productLineEnd + 1] === 0x48 && buffer[productLineEnd + 2] === 0x20; // "H "
}

/** The exact two-line preamble that can split otherwise contiguous headers. */
function startsSessionPreamble(buffer, offset) {
  for (let index = 0; index < SESSION_MARKER.length; index += 1) {
    if (buffer[offset + index] !== SESSION_MARKER.charCodeAt(index)) {
      return false;
    }
  }

  const productLineEnd = boundedLineEnd(buffer, offset);
  if (productLineEnd === -1) {
    return false;
  }

  // Firmware always writes Data version immediately after Product. Requiring
  // the complete two-line preamble distinguishes a real adjacent session from
  // a repeated Product metadata key inside the current header.
  const dataVersionOffset = productLineEnd + 1;
  for (let index = 0; index < DATA_VERSION_MARKER.length; index += 1) {
    if (buffer[dataVersionOffset + index] !== DATA_VERSION_MARKER.charCodeAt(index)) {
      return false;
    }
  }
  return boundedLineEnd(buffer, dataVersionOffset) !== -1;
}

/** End of one contiguous, syntactically header-shaped block without decoding it. */
function headerBlockEnd(buffer, startOffset) {
  let offset = startOffset;
  while (offset < buffer.length && buffer[offset] === 0x48 && buffer[offset + 1] === 0x20) {
    if (offset !== startOffset && startsSessionPreamble(buffer, offset)) {
      break;
    }
    const lineEnd = boundedLineEnd(buffer, offset);
    if (lineEnd === -1) break;

    let separator = offset + 2;
    while (separator < lineEnd && buffer[separator] !== 0x3a) separator += 1; // ':'
    if (separator === lineEnd) break;
    offset = lineEnd + 1;
  }
  return offset;
}

/** Byte offsets where a new session header block begins. */
export function findSessionStarts(bytes, maximumStarts = Number.POSITIVE_INFINITY) {
  if (maximumStarts <= 0) return [];

  const marker = asciiBytes(SESSION_MARKER);
  const starts = [];

  let offset = indexOfBytes(bytes, marker, 0);
  while (offset !== -1) {
    if (startsHeaderBlock(bytes, offset)) {
      starts.push(offset);
      if (starts.length >= maximumStarts) {
        break;
      }
      // A Product key can legally be repeated inside one contiguous header.
      // Resume after that header rather than treating every repetition as a
      // new session and reparsing the same suffix quadratically.
      const dataOffset = headerBlockEnd(bytes, offset);
      offset = indexOfBytes(bytes, marker, Math.max(offset + marker.length, dataOffset));
      continue;
    }
    offset = indexOfBytes(bytes, marker, offset + marker.length);
  }

  return starts;
}

/**
 * Reads consecutive `H key:value` lines. Stops at the first line that is not a
 * well-formed header, which is where the binary frame stream begins.
 */
export function parseHeaderBlock(bytes, startOffset) {
  const entries = [];
  const headers = Object.create(null);
  let offset = startOffset;
  let headerTerminationClean = true;

  while (offset < bytes.length) {
    if (offset !== startOffset && startsSessionPreamble(bytes, offset)) {
      break;
    }
    const lineEnd = boundedLineEnd(bytes, offset);
    if (lineEnd === -1) {
      if (bytes.length - offset > MAX_HEADER_LINE_BYTES) {
        throw new DecodeError(
          DecodeErrorCode.LIMIT_EXCEEDED,
          `Header line exceeds ${MAX_HEADER_LINE_BYTES} bytes`,
          {limit: MAX_HEADER_LINE_BYTES, offset}
        );
      }
      // A binary frame may legitimately run to EOF without containing a
      // newline. Only an unterminated header-shaped line is incomplete header
      // evidence; security-sensitive consumers must fail closed on that case.
      headerTerminationClean = bytes[offset] !== 0x48 || bytes[offset + 1] !== 0x20;
      break; // truncated mid-line: keep what we already parsed
    }

    const line = textDecoder.decode(bytes.subarray(offset, lineEnd)).replace(/\r$/, '');
    if (!line.startsWith('H ')) {
      break;
    }

    const separator = line.indexOf(':', 2);
    const key = separator === -1 ? '' : line.slice(2, separator).trim();
    if (separator === -1 || key === '') {
      headerTerminationClean = false;
      break;
    }

    if (entries.length >= MAX_HEADER_LINES) {
      throw new DecodeError(
        DecodeErrorCode.LIMIT_EXCEEDED,
        `Session header exceeds ${MAX_HEADER_LINES} lines`,
        {limit: MAX_HEADER_LINES, offset}
      );
    }

    entries.push({key, value: line.slice(separator + 1).trim()});
    headers[key] = line.slice(separator + 1).trim();
    offset = lineEnd + 1;
  }

  return {entries, headers, dataOffset: offset, headerTerminationClean};
}

function splitList(value) {
  return value === undefined
    ? null
    : value.split(',').map(item => item.trim()).filter(item => item !== '');
}

function numberList(value, fallback) {
  const parts = splitList(value);
  return parts === null ? fallback : parts.map(part => {
    if (!/^[+-]?\d+$/.test(part)) {
      return Number.NaN;
    }
    return Number.parseInt(part, 10);
  });
}

function intHeader(headers, key, fallback) {
  const raw = headers[key];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Builds the field table for one frame type. `P` frames reuse `I` frame names
 * but declare their own predictors and encodings, which is what makes them
 * deltas rather than absolute samples.
 */
function buildFieldTable(headers, frameType, nameSourceType = frameType, headerOffset = 0) {
  const names = splitList(headers[`Field ${nameSourceType} name`]);
  if (names === null) {
    return null;
  }

  if (names.length > MAX_FIELDS_PER_FRAME) {
    throw new DecodeError(
      DecodeErrorCode.LIMIT_EXCEEDED,
      `Frame ${frameType} declares ${names.length} fields; limit is ${MAX_FIELDS_PER_FRAME}`,
      {frameType, limit: MAX_FIELDS_PER_FRAME, offset: headerOffset}
    );
  }

  const predictors = numberList(headers[`Field ${frameType} predictor`], []);
  const encodings = numberList(headers[`Field ${frameType} encoding`], []);
  const signed = numberList(headers[`Field ${nameSourceType} signed`], []);
  if (encodings.length === 0) {
    return null;
  }

  if (encodings.length !== names.length || predictors.length !== names.length ||
      signed.length !== names.length) {
    throw new DecodeError(
      DecodeErrorCode.CORRUPT_HEADER,
      `Frame ${frameType} declares ${names.length} fields but ` +
      `${predictors.length} predictors, ${encodings.length} encodings and ` +
      `${signed.length} signed flags`,
      {frameType, offset: headerOffset}
    );
  }

  for (let index = 0; index < names.length; index += 1) {
    if (!SUPPORTED_PREDICTORS.has(predictors[index])) {
      throw new DecodeError(
        DecodeErrorCode.UNSUPPORTED_PREDICTOR,
        `Unsupported field predictor ${predictors[index]}`,
        {frameType, field: names[index], fieldIndex: index, predictor: predictors[index],
          offset: headerOffset}
      );
    }
    if (!SUPPORTED_ENCODINGS.has(encodings[index])) {
      throw new DecodeError(
        DecodeErrorCode.UNSUPPORTED_ENCODING,
        `Unsupported field encoding ${encodings[index]}`,
        {frameType, field: names[index], fieldIndex: index, encoding: encodings[index],
          offset: headerOffset}
      );
    }
    if (signed[index] !== 0 && signed[index] !== 1) {
      throw new DecodeError(
        DecodeErrorCode.CORRUPT_HEADER,
        `Invalid signed flag ${signed[index]}`,
        {frameType, field: names[index], fieldIndex: index, signed: signed[index],
          offset: headerOffset}
      );
    }
  }

  return {
    frameType,
    fields: names.map((name, index) => ({
      name,
      signed: signed[index] === 1,
      predictor: predictors[index],
      encoding: encodings[index]
    }))
  };
}

/**
 * How much an INCREMENT-predicted field advances per *logged* frame.
 *
 * Not every loop iteration is written to the card. `I interval` counts loop
 * iterations between keyframes and `P ratio` counts logged frames between them,
 * so their quotient is iterations per logged frame. `P interval` states the same
 * thing directly — either as a bare step (`2`) or as a fraction of iterations
 * logged (`1/1`, `1/2`): `1/2` means one frame per two iterations, so the step
 * is the DENOMINATOR over the numerator, not the leading number. Taking the
 * leading integer of `1/2` yields a step of 1 and reproduces the loopIteration
 * sawtooth described below on any firmware that spells the header that way.
 *
 * This was hardcoded to 1 until 12 August 2026. The real 4.6 log declares
 * `I interval:64`, `P interval:2`, `P ratio:32` — a step of 2 — so loopIteration
 * ramped 1 per P frame and was yanked forward 33 at every keyframe: a sawtooth
 * at 4200 of 4200 I frames, ending 28 counts short of the truth. Nothing caught
 * it because 33 and 1 are both forward, so the monotonicity guard was satisfied
 * and no frame was ever rejected. Both derivations agree on all four logs held.
 */
function incrementStep(headers) {
  const intraInterval = intHeader(headers, 'I interval', 0);
  const interRatio = intHeader(headers, 'P ratio', 0);
  if (intraInterval > 0 && interRatio > 0 && intraInterval % interRatio === 0) {
    return Math.max(1, intraInterval / interRatio);
  }

  // `P interval` is "num/denom" or a bare step depending on firmware.
  const raw = typeof headers['P interval'] === 'string' ? headers['P interval'].trim() : '';
  const ratio = raw.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (ratio) {
    const numerator = Number.parseInt(ratio[1], 10);
    const denominator = Number.parseInt(ratio[2], 10);
    if (numerator > 0 && denominator > 0 && denominator % numerator === 0) {
      return Math.max(1, denominator / numerator);
    }
  }

  return Math.max(1, intHeader(headers, 'P interval', 1));
}

/**
 * Header-derived constants that predictors reference.
 *
 * READ-ONLY once built, and the frame loop keeps it that way. `lastMainFrameTime`
 * is seeded here at 0 and advances as decoding progresses, but it advances on a
 * per-decode COPY — see the `FrameDecoder` constructor. Writing it back here
 * would leak one decode's final timestamp into the next decode of the same
 * session, which `releaseFrames()` made reachable.
 */
function buildConstants(headers) {
  const motorRange = numberList(headers['motorOutput'], null);

  return {
    minthrottle: intHeader(headers, 'minthrottle', 0),
    maxthrottle: intHeader(headers, 'maxthrottle', 0),
    vbatref: intHeader(headers, 'vbatref', 0),
    minmotor: Number.isFinite(motorRange?.[0])
      ? motorRange[0]
      : intHeader(headers, 'minthrottle', 0),
    incrementStep: incrementStep(headers),
    lastMainFrameTime: 0
  };
}

/** Parses one session: headers, field tables, constants, and where frames start. */
export function parseSession(bytes, startOffset, index, options = {}) {
  const {entries, headers, dataOffset, headerTerminationClean} =
    parseHeaderBlock(bytes, startOffset);
  const headerKeysUnique = new Set(entries.map(entry => entry.key)).size === entries.length;

  const frames = {
    [FrameType.INTRA]: buildFieldTable(headers, FrameType.INTRA, FrameType.INTRA, startOffset),
    [FrameType.INTER]: buildFieldTable(headers, FrameType.INTER, FrameType.INTRA, startOffset),
    [FrameType.SLOW]: buildFieldTable(headers, FrameType.SLOW, FrameType.SLOW, startOffset),
    [FrameType.GPS]: buildFieldTable(headers, FrameType.GPS, FrameType.GPS, startOffset),
    [FrameType.GPS_HOME]: buildFieldTable(
      headers, FrameType.GPS_HOME, FrameType.GPS_HOME, startOffset
    )
  };

  const allFields = Object.values(frames)
    .filter(Boolean)
    .flatMap(table => table.fields.map(field => field.name));
  const locationFields = allFields.filter(name => LOCATION_FIELD_PATTERN.test(name));

  const session = {
    index,
    byteOffset: startOffset,
    dataOffset,
    headerCount: entries.length,
    headers,
    frames,
    constants: buildConstants(headers),
    product: headers.Product ?? null,
    dataVersion: headers['Data version'] ?? null,
    firmware: {
      type: headers['Firmware type'] ?? null,
      revision: headers['Firmware revision'] ?? null,
      date: headers['Firmware date'] ?? null
    },
    board: headers['Board information'] ?? null,
    craftName: headers['Craft name'] ?? null,
    locationFieldsDeclared: locationFields.length > 0,
    locationFields
  };

  // Compact, always-present evidence for consumers that must reject a
  // truncated or malformed final `H ` line rather than trusting a parsed
  // prefix as the whole header. Lock the slot without freezing the session so
  // a Proxy cannot swap the value between validation and extraction.
  Object.defineProperty(session, 'headerTerminationClean', {
    value: headerTerminationClean,
    enumerable: true,
    writable: false,
    configurable: false
  });

  // The ordinary decoder does not retain the full ordered header, but a
  // security-sensitive consumer still needs to know whether last-write-wins
  // parsing hid a duplicate identity or field-definition line. Firmware emits
  // every header key once; a duplicate is ambiguous evidence even when the
  // final value happens to be supported.
  Object.defineProperty(session, 'headerKeysUnique', {
    value: headerKeysUnique,
    enumerable: true,
    writable: false,
    configurable: false
  });

  if (options?.retainHeaderEntries === true) {
    // Duplicate detection needs declaration order, but retaining every header
    // line in the normal viewer/decoder path would permanently duplicate the
    // header map on memory-constrained phones. The explicit evidence path gets
    // its own immutable snapshot; all default callers retain nothing extra.
    const headerEntries = Object.freeze(entries.map(entry => Object.freeze({
      key: entry.key,
      value: entry.value
    })));
    Object.defineProperty(session, 'headerEntries', {
      value: headerEntries,
      enumerable: true,
      writable: false,
      configurable: false
    });
  }

  return session;
}

/** Parses every session header block in a log without decoding frames. */
export function parseSessions(bytes) {
  return findSessionStarts(bytes).map((start, index) => parseSession(bytes, start, index));
}
