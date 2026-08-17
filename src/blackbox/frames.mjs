/**
 * The frame loop: walks a session's binary stream and reconstructs samples.
 *
 * Two design choices drive everything here:
 *
 * 1. **Predictor history is committed only by validated frames.** A frame is
 *    decoded into a scratch array and accepted only if it passes sanity checks.
 *    A corrupt frame that slipped through would otherwise poison every
 *    subsequent delta-predicted frame, which is how log viewers end up showing
 *    plausible-looking garbage instead of an error.
 *
 * 2. **Desync is expected, not exceptional.** SD-card logs lose bytes. On a bad
 *    frame the loop rewinds, scans for the next credible frame marker, and
 *    records the gap as data. Decoding continues.
 */

import {ByteReader} from './reader.mjs';
import {DecodeError, DecodeErrorCode, corruptFrame} from './errors.mjs';
import {Encoding, decodeGroup, groupSize} from './encodings.mjs';
import {FrameType} from './headers.mjs';
import {Predictor, predict} from './predictors.mjs';

const FRAME_MARKERS = new Set(
  [FrameType.INTRA, FrameType.INTER, FrameType.SLOW, FrameType.GPS, FrameType.GPS_HOME,
    FrameType.EVENT].map(type => type.charCodeAt(0))
);

const EventType = Object.freeze({
  SYNC_BEEP: 0,
  INFLIGHT_ADJUSTMENT: 13,
  LOGGING_RESUME: 14,
  DISARM: 15,
  FLIGHT_MODE: 30,
  GOVERNOR_STATE: 50,
  RESCUE_STATE: 51,
  AIRBORNE_STATE: 52,
  CUSTOM_DATA: 100,
  CUSTOM_STRING: 101,
  LOG_END: 255
});

/**
 * State-like events all carry an unsigned variable-byte integer in Rotorflight
 * 4.6. Small values happen to occupy one byte, but treating that observation as
 * the format loses alignment as soon as a disarm reason or state exceeds 127.
 */
const UNSIGNED_STATE_EVENTS = new Set([
  EventType.DISARM,
  EventType.GOVERNOR_STATE,
  EventType.RESCUE_STATE,
  EventType.AIRBORNE_STATE
]);

const LOG_END_PAYLOAD = Object.freeze([...new TextEncoder().encode('End of log'), 0]);

function boundedLimit(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/** Fields whose monotonicity tells us whether we are still in sync. */
function findFieldIndex(table, name) {
  return table ? table.fields.findIndex(field => field.name === name) : -1;
}

/**
 * The only `G` frame fields that leave this decoder.
 *
 * A G frame also carries `GPS_coord[0]` and `GPS_coord[1]` — the pilot's
 * latitude and longitude, which is to say their home field or their back
 * garden. Those two are decoded (they have to be, the frame is one packed
 * group and skipping a field would desynchronize the rest) and then dropped on
 * the floor: no coordinate is ever written into a session, so nothing
 * downstream can display, export or accidentally log one. `GPS_home[0..1]` in
 * the `H` frame is treated the same way — it stays inside the predictor state
 * that needs it and never reaches a caller.
 *
 * What is kept is the part that is about the flight rather than the place:
 * satellite count, ground speed and GPS altitude. Those are the fields that
 * could corroborate a takeoff, which is the only reason G frames are surfaced
 * at all. See docs/PRIVACY_POLICY.md — this is the decoder's half of that
 * promise.
 */
const GPS_PUBLISHED_FIELDS = Object.freeze({
  timeUs: 'time',
  numSat: 'GPS_numSat',
  speed: 'GPS_speed',
  altitude: 'GPS_altitude'
});

export class FrameDecoder {
  #session;
  #reader;
  #limits;

  #previous = null;
  #previous2 = null;
  // False from the moment a frame fails until the next I frame re-anchors the
  // stream. A P frame's residuals were computed by firmware against the frame
  // that was lost in the gap, so applying them to the stale history yields
  // values offset by the missing delta — plausible-looking garbage, which is
  // exactly what design choice 1 above exists to prevent. Frames decoded while
  // un-anchored are consumed (their byte length is self-describing and correct)
  // but never committed or published.
  #anchored = true;
  #slow = null;
  #home = [0, 0];

  #timeIndex;
  #iterationIndex;
  #motor0Index;
  #homeBase = new Map();
  #gpsIndexes = null;
  #constants;

  constructor(session, bytes, limits = {}) {
    this.#session = session;
    this.#reader = new ByteReader(bytes, session.dataOffset);

    // Predictor constants belong to THIS decode, not to the session definition.
    //
    // `lastMainFrameTime` is the only one the frame loop writes, and it used to
    // be written straight back into `session.constants` — a table parsed once
    // per session and shared by every decode of it. Harmless while a session
    // could only be decoded once per `decodeLog` call. `releaseFrames()` ended
    // that: the viewer releases a session under memory pressure and reads it
    // again when the pilot returns to it, and the second read would begin with
    // the FIRST read's final timestamp still sitting in the constant.
    //
    // Predictor 10 (LAST_MAIN_FRAME_TIME) reads it, so a G frame reached before
    // any main frame predicted against that leftover and published a different
    // `gps[].timeUs` — no error raised, frame sync held, just a different
    // number. That is precisely the shape of the four defects this decoder has
    // already had. A shallow copy per decode leaves the definition immutable
    // and makes the second decode identical to the first by construction
    // rather than by luck.
    this.#constants = {...session.constants};

    this.#limits = {
      maxFrames: boundedLimit(limits.maxFrames, 4_000_000),
      maxEvents: boundedLimit(limits.maxEvents, 100_000),
      maxAuxFrames: boundedLimit(limits.maxAuxFrames, 1_000_000),
      maxRecords: boundedLimit(limits.maxRecords, 5_000_000),
      maxErrors: boundedLimit(limits.maxErrors, 1000)
    };

    const main = session.frames[FrameType.INTRA];
    this.#timeIndex = findFieldIndex(main, 'time');
    this.#iterationIndex = findFieldIndex(main, 'loopIteration');
    this.#motor0Index = findFieldIndex(main, 'motor[0]');
  }

  /**
   * Index of the first HOME_COORD-predicted field in `table`, or -1.
   *
   * A GPS coordinate pair predicts against the matching home coordinate:
   * latitude against home latitude, longitude against home longitude. That
   * pairing is by *field* position. It was indexed by position within the
   * decoded group instead, and both coordinates declare a group size of 1, so
   * longitude silently predicted against home latitude. It produced correct
   * output only because every H frame in the one real log we hold decodes to
   * [0, 0], which is indistinguishable from no prediction at all.
   */
  #homeBaseFor(table) {
    let base = this.#homeBase.get(table);
    if (base === undefined) {
      base = table.fields.findIndex(field => field.predictor === Predictor.HOME_COORD);
      this.#homeBase.set(table, base);
    }
    return base;
  }

  /**
   * Decodes one frame body against `table`, applying each field's predictor.
   * Returns absolute field values.
   */
  #decodeFields(table, isDelta) {
    const {fields} = table;
    const values = new Array(fields.length).fill(0);
    const homeBase = this.#homeBaseFor(table);

    let index = 0;
    while (index < fields.length) {
      const encoding = fields[index].encoding;

      // Group encodings cover a run of consecutive fields sharing that encoding.
      let run = 1;
      while (index + run < fields.length && fields[index + run].encoding === encoding) {
        run += 1;
      }

      const count = groupSize(encoding, run);
      const decoded = decodeGroup(this.#reader, encoding, count);

      for (let offset = 0; offset < decoded.length && index + offset < fields.length; offset += 1) {
        const fieldIndex = index + offset;
        const field = fields[fieldIndex];
        const prediction = predict(field.predictor, {
          previous: isDelta && this.#previous ? this.#previous[fieldIndex] : 0,
          previous2: isDelta && this.#previous2 ? this.#previous2[fieldIndex] : 0,
          current: values,
          constants: this.#constants,
          motor0Index: this.#motor0Index,
          homeCoord: homeBase >= 0 ? this.#home[fieldIndex - homeBase] ?? 0 : 0
        });

        const absolute = decoded[offset] + prediction;
        // Apply the field's declared 32-bit domain. The old unconditional `|0`
        // made unsigned time/iteration negative above 2^31; `>>> 0` keeps their
        // upper half while retaining firmware's uint32 wrap at 2^32.
        values[fieldIndex] = field.signed ? absolute | 0 : absolute >>> 0;
      }

      index += count;
    }

    return values;
  }

  /**
   * Rejects frames that cannot be true. Time and loop iteration only move
   * forward in a real log, so a backwards jump means we are decoding noise.
   */
  #isPlausibleMainFrame(values) {
    if (!this.#previous) {
      return true;
    }
    if (this.#timeIndex >= 0 && values[this.#timeIndex] < this.#previous[this.#timeIndex]) {
      return false;
    }
    if (this.#iterationIndex >= 0 &&
        values[this.#iterationIndex] < this.#previous[this.#iterationIndex]) {
      return false;
    }
    return true;
  }

  #commitMainFrame(values) {
    this.#previous2 = this.#previous ?? values;
    this.#previous = values;
    if (this.#timeIndex >= 0) {
      // This decode's copy, never the shared definition — see the constructor.
      this.#constants.lastMainFrameTime = values[this.#timeIndex];
    }
  }

  #decodeEvent() {
    const eventType = this.#reader.u8();

    switch (eventType) {
      case EventType.SYNC_BEEP:
        return {event: 'sync-beep', time: this.#reader.unsignedVB()};

      case EventType.LOGGING_RESUME:
        return {
          event: 'logging-resume',
          loopIteration: this.#reader.unsignedVB(),
          time: this.#reader.unsignedVB()
        };

      case EventType.FLIGHT_MODE:
        return {
          event: 'flight-mode',
          flags: this.#reader.unsignedVB(),
          lastFlags: this.#reader.unsignedVB()
        };

      case EventType.INFLIGHT_ADJUSTMENT: {
        const encodedFunction = this.#reader.u8();
        const floatValue = (encodedFunction & 0x80) !== 0;
        return {
          event: 'inflight-adjustment',
          function: encodedFunction & 0x7f,
          value: floatValue ? this.#reader.floatLE() : this.#reader.signedVB(),
          valueType: floatValue ? 'float' : 'integer'
        };
      }

      case EventType.CUSTOM_DATA:
      case EventType.CUSTOM_STRING: {
        const length = this.#reader.u8();
        // Custom payload content is not part of RotorLens' public contract. It
        // still has to be consumed exactly to preserve frame alignment.
        for (let index = 0; index < length; index += 1) {
          this.#reader.u8();
        }
        return {
          event: eventType === EventType.CUSTOM_DATA ? 'custom-data' : 'custom-string',
          length
        };
      }

      case EventType.LOG_END: {
        for (const expected of LOG_END_PAYLOAD) {
          const actual = this.#reader.u8();
          if (actual !== expected) {
            throw corruptFrame('Invalid log-end payload', {
              expected,
              actual,
              formatMismatch: true,
              offset: this.#reader.offset - 1
            });
          }
        }
        return {event: 'log-end', terminal: true};
      }

      default:
        if (UNSIGNED_STATE_EVENTS.has(eventType)) {
          return {event: 'state', eventType, state: this.#reader.unsignedVB()};
        }

        // Unknown payload length: we cannot skip it safely, so resync instead of
        // guessing and silently corrupting everything downstream.
        throw new DecodeError(
          DecodeErrorCode.CORRUPT_FRAME,
          `Unknown event type ${eventType}`,
          {eventType, offset: this.#reader.offset}
        );
    }
  }

  /**
   * Picks the publishable columns out of a decoded `G` frame.
   *
   * Returns null when the log declares none of them, so a G frame carrying only
   * coordinates contributes nothing rather than a row of nulls.
   */
  #publishGpsFix(table, values, sampleIndex) {
    if (this.#gpsIndexes === null) {
      const indexes = {};
      for (const [key, name] of Object.entries(GPS_PUBLISHED_FIELDS)) {
        indexes[key] = findFieldIndex(table, name);
      }
      this.#gpsIndexes = indexes;
    }

    const fix = {sampleIndex};
    let published = false;
    for (const key of Object.keys(GPS_PUBLISHED_FIELDS)) {
      const index = this.#gpsIndexes[key];
      const value = index >= 0 ? values[index] : undefined;
      fix[key] = Number.isFinite(value) ? value : null;
      if (fix[key] !== null) {
        published = true;
      }
    }

    return published ? fix : null;
  }

  /**
   * Scans forward from `searchFrom` (inclusive) to the next byte that could
   * plausibly start a frame, and returns the offset it stopped at.
   */
  #resync(searchFrom) {
    let offset = searchFrom;
    while (offset < this.#reader.length && !FRAME_MARKERS.has(this.#reader.at(offset))) {
      offset += 1;
    }

    this.#reader.offset = offset;
    return offset;
  }

  /**
   * Decodes the session's frame stream.
   *
   * @param {number} sessionEnd byte offset where the next session begins
   */
  decode(sessionEnd) {
    // A concatenated file is several independent byte streams. Bound every
    // primitive read and resync probe to this session, not merely the loop's
    // starting offset, or a frame that begins at the boundary can consume the
    // next session's `H Product` bytes as its own payload.
    this.#reader.endOffset = sessionEnd;

    const session = this.#session;
    const mainIntra = session.frames[FrameType.INTRA];
    const mainInter = session.frames[FrameType.INTER];

    const samples = [];
    // Which samples came from an I frame. An I frame is absolute and a P frame a
    // delta, so this is the only thing that lets a caller compare the two — which
    // is how a mis-assigned bit layout is detected (see bin/verify-log.mjs).
    const intraSampleIndices = [];
    const events = [];
    // Satellite count, ground speed and GPS altitude only. Coordinates are
    // decoded and discarded — see GPS_PUBLISHED_FIELDS.
    const gps = [];
    const errors = [];
    const counts = {
      I: 0, P: 0, S: 0, G: 0, H: 0, E: 0,
      rejected: 0, droppedInterFrames: 0, resyncBytes: 0
    };

    let reachedLogEnd = false;
    let limitExceeded = false;
    let sawTruncatedError = false;
    let recordsProcessed = 0;

    const recordLimit = (resource, limit, offset = this.#reader.offset) => {
      limitExceeded = true;
      errors.push(new DecodeError(
        DecodeErrorCode.LIMIT_EXCEEDED,
        `Decoder ${resource} limit of ${limit} was reached`,
        {resource, limit, offset}
      ).toJSON());
    };

    frameLoop: while (this.#reader.offset < sessionEnd) {
      if (recordsProcessed >= this.#limits.maxRecords) {
        recordLimit('record', this.#limits.maxRecords);
        break;
      }
      recordsProcessed += 1;

      const frameStart = this.#reader.offset;
      let marker;

      try {
        marker = this.#reader.u8();
      } catch {
        break; // clean end of input
      }

      try {
        switch (String.fromCharCode(marker)) {
          case FrameType.INTRA: {
            if (samples.length >= this.#limits.maxFrames) {
              recordLimit('main-frame', this.#limits.maxFrames, frameStart);
              break frameLoop;
            }
            if (!mainIntra) {
              throw corruptFrame('Log declares no I frame fields', {offset: frameStart});
            }
            const values = this.#decodeFields(mainIntra, false);
            // An I frame is absolute, so it is also the resync anchor: accept it
            // and restart prediction history from it.
            this.#previous = null;
            this.#previous2 = null;
            this.#anchored = true;
            this.#commitMainFrame(values);
            intraSampleIndices.push(samples.length);
            samples.push(values);
            counts.I += 1;
            break;
          }

          case FrameType.INTER: {
            if (samples.length >= this.#limits.maxFrames) {
              recordLimit('main-frame', this.#limits.maxFrames, frameStart);
              break frameLoop;
            }
            if (!mainInter || !this.#previous) {
              throw corruptFrame('P frame before any I frame', {offset: frameStart});
            }
            const values = this.#decodeFields(mainInter, true);
            if (!this.#anchored) {
              // The stream lost a frame since the last commit, so this delta's
              // base is gone: the bytes are consumed (the frame's length is
              // self-describing) but the values would be offset by the missing
              // delta, so nothing is committed or published until the next I
              // frame carries an absolute again.
              counts.droppedInterFrames += 1;
              break;
            }
            if (!this.#isPlausibleMainFrame(values)) {
              counts.rejected += 1;
              // The frame body itself decoded cleanly to the reader's current
              // offset; tell the resync where it may resume the scan so the
              // rejected frame's own payload bytes are not re-read as markers.
              throw corruptFrame('P frame failed monotonicity check',
                {offset: frameStart, resumeOffset: this.#reader.offset});
            }
            this.#commitMainFrame(values);
            samples.push(values);
            counts.P += 1;
            break;
          }

          case FrameType.SLOW: {
            if (counts.S + counts.G + counts.H >= this.#limits.maxAuxFrames) {
              recordLimit('auxiliary-frame', this.#limits.maxAuxFrames, frameStart);
              break frameLoop;
            }
            const table = session.frames[FrameType.SLOW];
            if (!table) {
              throw corruptFrame('Log declares no S frame fields', {offset: frameStart});
            }
            this.#slow = this.#decodeFields(table, false);
            counts.S += 1;
            break;
          }

          case FrameType.GPS_HOME: {
            if (counts.S + counts.G + counts.H >= this.#limits.maxAuxFrames) {
              recordLimit('auxiliary-frame', this.#limits.maxAuxFrames, frameStart);
              break frameLoop;
            }
            const table = session.frames[FrameType.GPS_HOME];
            if (!table) {
              throw corruptFrame('Log declares no H frame fields', {offset: frameStart});
            }
            const values = this.#decodeFields(table, false);
            this.#home = [values[0] ?? 0, values[1] ?? 0];
            counts.H += 1;
            break;
          }

          case FrameType.GPS: {
            if (counts.S + counts.G + counts.H >= this.#limits.maxAuxFrames) {
              recordLimit('auxiliary-frame', this.#limits.maxAuxFrames, frameStart);
              break frameLoop;
            }
            const table = session.frames[FrameType.GPS];
            if (!table) {
              throw corruptFrame('Log declares no G frame fields', {offset: frameStart});
            }
            const values = this.#decodeFields(table, false);
            const fix = this.#publishGpsFix(table, values, samples.length);
            if (fix) {
              gps.push(fix);
            }
            counts.G += 1;
            break;
          }

          case FrameType.EVENT: {
            if (events.length >= this.#limits.maxEvents) {
              recordLimit('event', this.#limits.maxEvents, frameStart);
              break frameLoop;
            }
            const event = this.#decodeEvent();
            // An event frame carries no timestamp of its own, so the decoder
            // cannot say when it happened — only which two samples it sits
            // between. It was written after sample `sampleIndex - 1` (whose
            // timestamp is `afterTimeUs`) and before sample `sampleIndex`, so
            // the placement is exact to within one sample interval, ~1 ms on
            // the logs we hold. `offset` alone — a byte position, against
            // samples that carry none — made every event unplaceable on the
            // time axis without re-decoding the stream, which is why firmware
            // ground truth like the airborne flag was unreachable.
            events.push({
              ...event,
              offset: frameStart,
              sampleIndex: samples.length,
              afterTimeUs: this.#timeIndex >= 0 && samples.length > 0
                ? this.#constants.lastMainFrameTime
                : null
            });
            counts.E += 1;
            if (event.terminal) {
              reachedLogEnd = true;
            }
            break;
          }

          default:
            throw corruptFrame(
              `Unrecognized frame marker 0x${marker.toString(16).padStart(2, '0')}`,
              {offset: frameStart}
            );
        }
      } catch (error) {
        if (!(error instanceof DecodeError)) {
          throw error;
        }

        if (errors.length < this.#limits.maxErrors) {
          errors.push({...error.toJSON(), offset: frameStart});
        } else {
          recordLimit('decode-error', this.#limits.maxErrors, frameStart);
          break frameLoop;
        }

        if (error.code === DecodeErrorCode.TRUNCATED) {
          // The reader can run dry mid-payload (e.g. a float cut 1-3 bytes
          // short) with its offset still inside the session; the flag, not the
          // final offset, is what records that the capture stopped mid-frame.
          sawTruncatedError = true;
          break;
        }

        // Prediction history now predates a gap; see the field's declaration.
        this.#anchored = false;

        const resumeOffset = Number.isSafeInteger(error.details?.resumeOffset) &&
          error.details.resumeOffset > frameStart
          ? error.details.resumeOffset
          : frameStart + 1;
        const resumedAt = this.#resync(resumeOffset);
        counts.resyncBytes += resumedAt - frameStart;

        if (resumedAt >= sessionEnd) {
          // The scan found nothing decodable between this failure and the end
          // of the session: the shape of a capture that simply stopped (erased-
          // flash padding, a cut final frame), not of a misread log. Recorded on
          // the error so `splitSessionErrors` can classify it as the tail.
          errors[errors.length - 1].scannedToSessionEnd = true;
        }
      }

      if (reachedLogEnd) {
        break;
      }
    }

    return {
      samples,
      intraSampleIndices,
      slow: this.#slow,
      events,
      gps,
      errors,
      counts,
      reachedLogEnd,
      limitExceeded,
      bytesConsumed: this.#reader.offset - session.dataOffset,
      truncated: !reachedLogEnd && (this.#reader.offset >= sessionEnd || sawTruncatedError)
    };
  }
}
