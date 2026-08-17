/**
 * Separating a truncated capture from a misread log.
 *
 * A log cut by power-off, a full card, or a yanked battery ends part-way through
 * a frame. That is a fact about the capture, not a decoder fault. Counting those
 * final bytes as decode errors reports every real log as damaged, which trains
 * the owner to ignore the one warning that matters.
 *
 * This lived only in `bin/verify-log.mjs`, so the conformance tool called the
 * truncated tail normal while the viewer showed the same bytes as "1 decode
 * issue — treat measurements from this session with care." Two answers about one
 * file. The judgment lives here now, and both callers ask it.
 */

/**
 * How near the end an error must be to count as part of the truncated tail.
 *
 * Generous enough to cover one frame of a wide field set, tight enough that a
 * genuine mid-log failure still counts.
 */
export const TAIL_TOLERANCE_BYTES = 4096;

/** Where a session's data ends: the next session's start, or end of file. */
export function sessionEndOffset(result, index, byteLength) {
  const next = result.sessions[index + 1];
  return next ? next.byteOffset : byteLength;
}

/**
 * Splits a session's decode errors into the body and the truncated tail.
 *
 * `body` is the set that means the decoder did not understand the log. `tail` is
 * the set explained by the capture stopping mid-frame.
 *
 * Two error shapes qualify as tail, and both are required in practice:
 *
 * - a `truncated` error near the end — the reader ran out of bytes inside a
 *   frame, the literal cut;
 * - a `corrupt-frame` error whose resync scanned to the session end without
 *   finding another frame (`scannedToSessionEnd`, stamped by the frame loop).
 *   A dataflash dump cut by power-off usually does NOT end at an exact frame
 *   boundary: it ends in erased-flash 0xff padding or a stump that fails a
 *   check, which surfaces as `corrupt-frame`, never as `truncated`. Requiring
 *   the `truncated` code alone classified every such ordinary capture as
 *   damaged — the exact false alarm this module exists to prevent. No distance
 *   bound applies to this shape because erased padding can be arbitrarily
 *   long; the evidence is that nothing decodable followed, not that the
 *   failure sat near the end.
 */
export function splitSessionErrors(session, sessionEnd, tolerance = TAIL_TOLERANCE_BYTES) {
  const body = [];
  const tail = [];

  for (const error of session.errors ?? []) {
    const offset = error.offset;
    const distanceFromEnd = sessionEnd - offset;
    const inSession = Boolean(session.truncated) &&
      Number.isFinite(offset) &&
      offset >= (session.byteOffset ?? 0) &&
      distanceFromEnd >= 0;
    // `formatMismatch` marks affirmative evidence the decoder disagrees with
    // the bytes (e.g. a log-end record with the wrong payload) — that is a
    // misread wherever it sits, never a cut.
    const canBeCaptureTail = inSession &&
      error.formatMismatch !== true &&
      (error.code === 'truncated'
        ? distanceFromEnd <= tolerance
        : error.code === 'corrupt-frame' && error.scannedToSessionEnd === true);

    if (canBeCaptureTail) {
      tail.push(error);
    } else {
      // Missing/NaN offsets and semantic failures (header, firmware, limits)
      // are never evidence of an ordinary cut-off, even in a short session.
      body.push(error);
    }
  }

  return {body, tail};
}

/**
 * The whole integrity picture for one session, as data rather than as words.
 *
 * `state` is one of:
 *   - `clean`      — decoded end to end with nothing unexplained
 *   - `truncated`  — the capture stops mid-frame, and that is all that is wrong
 *   - `damaged`    — errors in the body of the log; measurements are suspect
 */
export function sessionIntegrity(session, sessionEnd, tolerance = TAIL_TOLERANCE_BYTES) {
  const {body, tail} = splitSessionErrors(session, sessionEnd, tolerance);
  const endedMidFrame = Boolean(session.truncated) || tail.length > 0;

  let state = 'clean';
  if (body.length > 0) {
    state = 'damaged';
  } else if (endedMidFrame) {
    state = 'truncated';
  }

  return Object.freeze({
    state,
    bodyErrors: body,
    tailErrors: tail,
    endedMidFrame,
    reachedLogEnd: Boolean(session.reachedLogEnd)
  });
}
