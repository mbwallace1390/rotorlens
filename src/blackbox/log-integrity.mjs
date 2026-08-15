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
 */
export function splitSessionErrors(session, sessionEnd, tolerance = TAIL_TOLERANCE_BYTES) {
  const body = [];
  const tail = [];

  for (const error of session.errors ?? []) {
    const offset = error.offset;
    const distanceFromEnd = sessionEnd - offset;
    const canBeCaptureTail = Boolean(session.truncated) &&
      Number.isFinite(offset) &&
      offset >= (session.byteOffset ?? 0) &&
      distanceFromEnd >= 0 &&
      distanceFromEnd <= tolerance &&
      error.code === 'truncated';

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
