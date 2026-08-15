/**
 * RotorLens' own Blackbox decoder, exposed as an adapter for the parser contract
 * in `src/parser-contract.mjs`.
 *
 * This is the engine. It is written from the log format — header keys, encoding
 * and predictor identifiers, frame markers — which is interoperability
 * vocabulary rather than anyone's protected expression. No third-party decoder
 * source, in any language, was copied, ported, or translated to produce it.
 *
 * Conformance status: validated by round-trip against `tools/blackbox-writer.mjs`
 * and by structural self-checks over real logs (`npm run verify:log`). Round-trip
 * proves internal consistency, not agreement with firmware output — see
 * docs/BLACKBOX_FORMAT_NOTES.md.
 */

import {DecodeError, DecodeErrorCode} from './errors.mjs';
import {FrameType, parseSession, findSessionStarts} from './headers.mjs';
import {FrameDecoder} from './frames.mjs';
import {PARSER_CONTRACT_VERSION} from '../parser-contract.mjs';

export const ENGINE = Object.freeze({
  name: 'rotorlens-blackbox',
  version: '0.1.0',
  license: 'MPL-2.0'
});

const BLACKBOX_PRODUCT = 'Blackbox flight data recorder by Nicholas Sherlock';
const ROTORFLIGHT_TYPE = 'Rotorflight';
// Accepted for interoperability, not claimed equally verified: the committed
// synthetic corpus exercises 4.3, independently produced/private logs cover
// 4.4 and 4.6, and the event serializer is pinned against 4.6 firmware source.
// A future minor may change a field or event contract, so it fails closed until
// a log and the conformance checks deliberately widen this range.
const ROTORFLIGHT_REVISION_PATTERN =
  /^Rotorflight 4\.[3-6]\.\d+(?:-[A-Za-z0-9.]+)?(?:\s|$)/;

// Decoder-owned evidence cannot be reconstructed from, or forged through, the
// public session report. Public arrays intentionally remain mutable because the
// viewer releases them in place; community inspection needs the categorical
// facts captured before those arrays are exposed.
const FRAME_STAGE_STATE = new WeakMap();
const DECODE_RESULT_STATE = new WeakMap();
const NOT_DECODED_EVIDENCE = Object.freeze({status: 'not-decoded'});
const UNAVAILABLE_EVIDENCE = Object.freeze({status: 'unavailable'});
const INVALID_SELECTION_EVIDENCE = Object.freeze({status: 'invalid-selection'});

/** Refuse a header whose identity/version contract this decoder does not implement. */
function compatibilityError(definition) {
  if (definition.product !== BLACKBOX_PRODUCT) {
    return new DecodeError(
      DecodeErrorCode.UNSUPPORTED_FIRMWARE,
      `Unsupported Blackbox product ${JSON.stringify(definition.product)}`,
      {offset: definition.byteOffset, product: definition.product}
    );
  }
  if (definition.dataVersion !== '2') {
    return new DecodeError(
      DecodeErrorCode.UNSUPPORTED_FIRMWARE,
      `Unsupported Blackbox data version ${JSON.stringify(definition.dataVersion)}`,
      {offset: definition.byteOffset, dataVersion: definition.dataVersion}
    );
  }
  if (definition.firmware.type !== ROTORFLIGHT_TYPE ||
      !ROTORFLIGHT_REVISION_PATTERN.test(definition.firmware.revision ?? '')) {
    return new DecodeError(
      DecodeErrorCode.UNSUPPORTED_FIRMWARE,
      `Unsupported firmware ${JSON.stringify(
        definition.firmware.revision ?? definition.firmware.type
      )}`,
      {offset: definition.byteOffset, firmwareType: definition.firmware.type,
        firmwareRevision: definition.firmware.revision}
    );
  }
  return null;
}

function asUint8Array(bytes) {
  if (bytes instanceof Uint8Array) {
    return bytes;
  }
  throw new TypeError('Decoder input must be a Uint8Array');
}

function boundedLimit(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function freezeFrameCounts(counts) {
  return Object.freeze({
    I: counts.I,
    P: counts.P,
    S: counts.S,
    G: counts.G,
    H: counts.H,
    E: counts.E,
    rejected: counts.rejected,
    resyncBytes: counts.resyncBytes
  });
}

function freezeDecodeErrors(errors) {
  return Object.freeze(errors.map(error => Object.freeze({
    code: error.code,
    offset: error.offset
  })));
}

function freezeEventSummary(events) {
  const tags = new Set();
  let adjustmentObserved = false;
  let loggingResumeObserved = false;
  let logEndCount = 0;
  let terminalCount = 0;
  for (const event of events) {
    tags.add(event.event);
    if (event.event === 'inflight-adjustment') adjustmentObserved = true;
    if (event.event === 'logging-resume') loggingResumeObserved = true;
    if (event.event === 'log-end') logEndCount += 1;
    if (event.terminal === true) terminalCount += 1;
  }
  const finalEvent = events.at(-1);
  return Object.freeze({
    count: events.length,
    tags: Object.freeze([...tags].sort()),
    adjustmentObserved,
    loggingResumeObserved,
    logEndCount,
    terminalCount,
    finalTag: finalEvent?.event ?? null,
    finalTerminal: finalEvent?.terminal === true
  });
}

function buildSessionIntegrityEvidence(definition, result, sessionEnd) {
  const revision = definition.firmware.revision ?? '';
  return Object.freeze({
    status: 'decoded',
    firmware: Object.freeze({
      type: definition.firmware.type,
      version: /(\d+\.\d+\.\d+)/.exec(revision)?.[1] ?? null,
      revision: definition.firmware.revision,
      board: definition.board
    }),
    byteOffset: definition.byteOffset,
    sessionEnd,
    bodyEndOffset: definition.dataOffset + result.bytesConsumed,
    headerTerminationClean: definition.headerTerminationClean,
    headerKeysUnique: definition.headerKeysUnique,
    sampleCount: result.samples.length,
    intraSampleCount: result.intraSampleIndices.length,
    gpsCount: result.gps.length,
    frameCounts: freezeFrameCounts(result.counts),
    eventSummary: freezeEventSummary(result.events),
    errors: freezeDecodeErrors(result.errors),
    truncated: result.truncated,
    reachedLogEnd: result.reachedLogEnd,
    limitExceeded: result.limitExceeded
  });
}

/**
 * Attaches the frame stage to a session report without putting it in the data.
 *
 * `decodeFrames`, `releaseFrames` and `framesDecoded` are defined
 * non-enumerable on purpose. A session report is compared with
 * `deepStrictEqual`, serialized with `JSON.stringify`, and spread into other
 * objects all over this app; a lazily decoded session has to be
 * indistinguishable from an eagerly decoded one through every one of those, or
 * the two paths are not the same path.
 */
function attachFrameStage(session, {decode, reset}) {
  let decoded = false;
  const state = {decoded: false, evidence: null};
  FRAME_STAGE_STATE.set(session, state);

  Object.defineProperties(session, {
    decodeFrames: {
      value() {
        if (!decoded) {
          // Marked decoded only once the frames are actually in. A throw here
          // is a defect in the decoder, not bad log content, and it must not
          // leave the session looking read when it is still empty.
          state.evidence = decode() ?? null;
          decoded = true;
          state.decoded = true;
        }
        return session;
      }
    },
    /**
     * Empties this session's frame data. THE RESET IS IN PLACE.
     *
     * The session object is not replaced — its arrays are emptied and its
     * frame-derived fields set back to null, on the same object every existing
     * reference still points at. That is deliberate, because the picker, the
     * analysis and the history all hold sessions by identity. It is also the
     * sharp edge of this API, and it has already drawn blood:
     *
     *   TypeError: Cannot read properties of null (reading 'length')
     *       at indexAtOrAfter (src/analysis/axis-report.mjs)
     *       at runRecommendations (ui/app.mjs)
     *
     * An analysis had taken a reference to the session it started on, awaited,
     * and resumed after the pilot switched flights and this ran. On a phone
     * that is a blank screen, and no unit test can see it: it needs a real race
     * between a tap and an analysis that is still running.
     *
     * SO: ANYTHING HOLDING A SESSION ACROSS AN `await` must either retire that
     * work before releasing, or refuse to release while it is still reading.
     * `ui/app.mjs` does both — `analysesInFlight`, and retiring the pending run
     * at the top of `openSession` — and is worth copying rather than
     * reinventing.
     */
    releaseFrames: {
      value() {
        if (decoded) {
          decoded = false;
          state.decoded = false;
          state.evidence = null;
          reset();
        }
        return session;
      }
    },
    framesDecoded: {
      get() {
        return decoded;
      }
    }
  });

  return session;
}

/**
 * A session whose header could not be read: nothing to decode, ever.
 *
 * It carries the SAME KEYS as any other session report, with the frame-derived
 * ones empty rather than absent. Absent was the older shape and it was a trap:
 * `session.samples` came back `undefined`, so a caller that had correctly
 * learned to tell `null` ("not read yet") from `[]` ("read, and empty") got a
 * third value it had never been told about, and `samples.length` threw. In the
 * viewer that put a corrupt flight in the picker looking like an unopened one,
 * and selecting it left the PREVIOUS flight's numbers on screen underneath the
 * new selection.
 *
 * `[]` rather than `null`, deliberately: this session HAS been read as far as
 * it can ever be read. `errors` says why it is empty, and `errors` is the only
 * thing that separates this from a flight that genuinely logged nothing.
 */
function unreadableSession(report) {
  // Same key order as `buildSessionReport`, so the two shapes stay comparable.
  return attachFrameStage({
    index: report.index,
    byteOffset: report.byteOffset,
    firmware: report.firmware,
    craftName: report.craftName ?? null,
    locationFieldsDeclared: report.locationFieldsDeclared ?? false,
    fields: report.fields ?? [],
    samples: [],
    intraSampleIndices: [],
    events: [],
    gps: [],
    frameCounts: {I: 0, P: 0, S: 0, G: 0, H: 0, E: 0, rejected: 0, resyncBytes: 0},
    truncated: false,
    reachedLogEnd: false,
    limitExceeded: (report.errors ?? [])
      .some(error => error?.code === DecodeErrorCode.LIMIT_EXCEEDED),
    errors: report.errors ?? []
  }, {decode() {}, reset() {}});
}

/**
 * Decodes every session in a log.
 *
 * Never throws for bad log content: unreadable sessions come back with their
 * errors attached so the caller can show what failed and still render the rest.
 *
 * By default every session's frames are decoded before this returns, which is
 * what `verify:log` and the analysis tests want. Pass `{lazy: true}` and only
 * the header blocks are read — milliseconds even for a 125 MB dataflash dump —
 * with each session carrying a `decodeFrames()` method that reads its own frame
 * stream on demand and memoises the result. A 73-session dump costs 73 header
 * blocks instead of 2.8 million samples, and the pilot pays for the one session
 * actually opened.
 *
 * Until `decodeFrames()` is called, every frame-derived field on a lazy session
 * is `null` rather than empty. `null` means "not read yet"; `[]` would mean
 * "read, and there was nothing there", and a session picker cannot tell a
 * failed flight from an unopened one if those two look alike.
 *
 * `{headersOnly: true}` is the older spelling and selects the same path, but it
 * is NOT what it used to mean and no caller should treat it as unchanged. It
 * previously returned `samples: []`, `errors: []` and `fields[].sampleCount: 0`;
 * it now returns `null` for all three, so `session.samples.length` throws where
 * it used to read `0`. Nothing outside the tests passes it, which is why the
 * spelling was kept rather than the old behaviour — but it is a silent break
 * for anything that arrives later, so prefer `{lazy: true}` and read the
 * paragraph above about `null`.
 *
 * A session whose HEADER cannot be parsed is the one exception to all of this:
 * it can never be decoded, so it reports empty frame data rather than `null`
 * straight away, with `errors` saying why. See `unreadableSession`.
 */
export function decodeLog(bytes, options = {}) {
  const input = asUint8Array(bytes);
  const maxSessions = boundedLimit(options.limits?.maxSessions, 4096);
  const starts = findSessionStarts(input, maxSessions + 1);

  if (starts.length === 0) {
    return {
      engine: ENGINE,
      sessions: [],
      errors: [{
        code: DecodeErrorCode.UNSUPPORTED_FIRMWARE,
        message: 'No Blackbox session header found'
      }]
    };
  }

  if (starts.length > maxSessions) {
    return {
      engine: ENGINE,
      sessions: [],
      errors: [{
        code: DecodeErrorCode.LIMIT_EXCEEDED,
        message: `Decoder session limit of ${maxSessions} was reached`,
        resource: 'session',
        limit: maxSessions,
        offset: starts[maxSessions]
      }]
    };
  }

  const lazy = options.lazy === true || options.headersOnly === true;

  const sessions = starts.map((start, index) => {
    const sessionEnd = starts[index + 1] ?? input.length;

    let definition;
    try {
      definition = parseSession(input, start, index);
    } catch (error) {
      if (!(error instanceof DecodeError)) {
        throw error;
      }
      return unreadableSession({
        index,
        byteOffset: start,
        firmware: {type: null, version: null},
        fields: [],
        errors: [{...error.toJSON(), offset: error.details.offset ?? start}]
      });
    }

    const unsupported = compatibilityError(definition);
    if (unsupported) {
      return unreadableSession({
        index,
        byteOffset: start,
        firmware: describeFirmware(definition),
        craftName: definition.craftName,
        locationFieldsDeclared: definition.locationFieldsDeclared,
        fields: [],
        errors: [unsupported.toJSON()]
      });
    }

    const mainTable = definition.frames[FrameType.INTRA];
    if (!mainTable) {
      return unreadableSession({
        index,
        byteOffset: start,
        firmware: describeFirmware(definition),
        craftName: definition.craftName,
        fields: [],
        errors: [{
          code: DecodeErrorCode.CORRUPT_HEADER,
          message: 'Session declares no main frame fields',
          offset: start
        }]
      });
    }

    // One construction site for the report, whether the frames arrive now or
    // later. Eager decoding is the lazy path with the method called
    // immediately, so there is no second implementation to drift.
    const session = attachFrameStage(buildSessionReport(definition, mainTable, null), {
      decode() {
        const result = new FrameDecoder(definition, input, options.limits).decode(sessionEnd);
        const evidence = buildSessionIntegrityEvidence(definition, result, sessionEnd);
        Object.assign(session, buildSessionReport(definition, mainTable, result));
        return evidence;
      },
      reset() {
        Object.assign(session, buildSessionReport(definition, mainTable, null));
      }
    });

    return lazy ? session : session.decodeFrames();
  });

  const report = {engine: ENGINE, sessions, errors: []};
  DECODE_RESULT_STATE.set(report, Object.freeze({
    byteLength: input.length,
    sessions: Object.freeze([...sessions])
  }));
  return report;
}

/**
 * Return decoder-issued, immutable categorical evidence for one session.
 *
 * The WeakMap membership is the provenance boundary: an object shaped like a
 * decode result, including one carrying the exported ENGINE object, cannot
 * manufacture evidence. Releasing a session clears its evidence in place.
 */
export function captureSessionIntegrityEvidence(result, sessionIndex, byteLength) {
  const registered = DECODE_RESULT_STATE.get(result);
  if (registered === undefined) return null;
  if (registered.byteLength !== byteLength
      || !Number.isSafeInteger(sessionIndex)
      || sessionIndex < 0
      || sessionIndex >= registered.sessions.length) return INVALID_SELECTION_EVIDENCE;
  const state = FRAME_STAGE_STATE.get(registered.sessions[sessionIndex]);
  if (state === undefined) return null;
  if (!state.decoded) return NOT_DECODED_EVIDENCE;
  return state.evidence ?? UNAVAILABLE_EVIDENCE;
}

function describeFirmware(definition) {
  const revision = definition.firmware.revision ?? '';
  const version = /(\d+\.\d+\.\d+)/.exec(revision)?.[1] ?? null;

  return {
    type: definition.firmware.type,
    version,
    revision: definition.firmware.revision,
    date: definition.firmware.date,
    board: definition.board
  };
}

/**
 * The session report. `result` is the frame decoder's output, or `null` when
 * the frames have not been read — in which case every field that only the
 * frame stream can answer is `null`, and only the header-derived ones are
 * populated.
 */
function buildSessionReport(definition, mainTable, result) {
  const sampleCount = result ? result.samples.length : null;

  return {
    index: definition.index,
    byteOffset: definition.byteOffset,
    firmware: describeFirmware(definition),
    craftName: definition.craftName,
    locationFieldsDeclared: definition.locationFieldsDeclared,
    fields: mainTable.fields.map((field, fieldIndex) => ({
      name: field.name,
      index: fieldIndex,
      signed: field.signed,
      sampleCount
    })),
    samples: result ? result.samples : null,
    // Sample positions that came from an I frame; needed to compare absolute
    // frames against delta frames (see `checkIntraFrameContinuity`).
    intraSampleIndices: result ? result.intraSampleIndices : null,
    events: result ? result.events : null,
    // Satellite count, ground speed and GPS altitude, one row per `G` frame.
    // Coordinates are deliberately absent — the decoder never lets one out, so
    // no caller can render or export the pilot's location. `locationFieldsDeclared`
    // above is what tells a caller the log contained coordinates at all.
    gps: result ? result.gps : null,
    frameCounts: result ? result.counts : null,
    truncated: result ? result.truncated : null,
    reachedLogEnd: result ? result.reachedLogEnd : null,
    limitExceeded: result ? result.limitExceeded : null,
    // `null`, not `[]`: a session whose frames have not been read is not a
    // session that read cleanly.
    errors: result ? result.errors : null
  };
}

/**
 * Adapter shape consumed by `decodeWithAdapter`. Async because a future WASM or
 * worker-backed implementation will be, and the boundary should not change when
 * that happens.
 *
 * Everything the contract report carries is header-derived except `errors`, so
 * `{lazy: true}` produces the whole report without touching a frame stream —
 * at the cost of the decode errors, which nothing has looked for yet.
 */
export const blackboxAdapter = {
  async decode(bytes, options = {}) {
    const result = decodeLog(bytes, options);

    return {
      contractVersion: PARSER_CONTRACT_VERSION,
      engine: result.engine,
      sessions: result.sessions.map(session => ({
        index: session.index,
        firmware: {
          type: session.firmware.type ?? 'unknown',
          version: session.firmware.version ?? undefined
        },
        craftName: session.craftName ?? undefined,
        fields: session.fields,
        errors: session.errors ?? []
      }))
    };
  }
};
