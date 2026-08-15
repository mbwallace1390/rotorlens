/**
 * Telling a truncated capture apart from a misread log.
 *
 * This distinction must come from the decoder's typed error, not proximity.
 * The earlier policy forgave any `corrupt-frame` near EOF because one private
 * 8.2 MB log ended that way. That also forgave unknown events and invalid
 * payloads. Only a bounds-checked `truncated` read proves the bytes ran out.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TAIL_TOLERANCE_BYTES,
  sessionEndOffset,
  sessionIntegrity,
  splitSessionErrors
} from '../src/blackbox/log-integrity.mjs';

const FILE_BYTES = 8_572_928;

/** The real log's shape: clean body, one error in the final frame. */
function truncatedSession(overrides = {}) {
  return {
    index: 0,
    byteOffset: 0,
    truncated: true,
    reachedLogEnd: false,
    errors: [{code: 'truncated', offset: 8_572_403}],
    ...overrides
  };
}

test('an error in the final frame is the truncated tail, not a decode fault', () => {
  const session = truncatedSession();
  const {body, tail} = splitSessionErrors(session, FILE_BYTES);

  assert.equal(body.length, 0, 'the body of this log decoded cleanly');
  assert.equal(tail.length, 1);
  assert.equal(sessionIntegrity(session, FILE_BYTES).state, 'truncated');
});

test('a truncated read in the body of the log is a decode fault', () => {
  // Same error, moved to the middle. Nothing else changes.
  const session = truncatedSession({errors: [{code: 'truncated', offset: 4_000_000}]});
  const integrity = sessionIntegrity(session, FILE_BYTES);

  assert.equal(integrity.state, 'damaged');
  assert.equal(integrity.bodyErrors.length, 1);
  assert.equal(integrity.tailErrors.length, 0);
});

test('the tail boundary is where the tolerance says it is', () => {
  // Straddling the boundary in both directions, because an off-by-one here
  // decides whether a real log is reported as damaged.
  const justInside = truncatedSession({
    errors: [{code: 'truncated', offset: FILE_BYTES - TAIL_TOLERANCE_BYTES}]
  });
  const justOutside = truncatedSession({
    errors: [{code: 'truncated', offset: FILE_BYTES - TAIL_TOLERANCE_BYTES - 1}]
  });

  assert.equal(sessionIntegrity(justInside, FILE_BYTES).state, 'truncated');
  assert.equal(sessionIntegrity(justOutside, FILE_BYTES).state, 'damaged');
});

test('a log that reached its end marker with no errors is clean', () => {
  const session = truncatedSession({truncated: false, reachedLogEnd: true, errors: []});
  const integrity = sessionIntegrity(session, FILE_BYTES);

  assert.equal(integrity.state, 'clean');
  assert.equal(integrity.endedMidFrame, false);
});

test('a session that ends mid-frame with no error recorded still says so', () => {
  // The decoder can stop on a stump too short to be a frame without producing an
  // error at all. The capture is still incomplete and the viewer must still say
  // so, or a partial log reads as a whole one.
  const session = truncatedSession({errors: []});
  const integrity = sessionIntegrity(session, FILE_BYTES);

  assert.equal(integrity.state, 'truncated');
  assert.equal(integrity.endedMidFrame, true);
});

test('a session ends where the next one begins', () => {
  const result = {sessions: [{index: 0, byteOffset: 0}, {index: 1, byteOffset: 4_000}]};

  assert.equal(sessionEndOffset(result, 0, 10_000), 4_000);
  assert.equal(sessionEndOffset(result, 1, 10_000), 10_000, 'the last session runs to EOF');
});

test('damage in an earlier session is not excused by the next session starting', () => {
  // The bug this prevents: measuring the tail from end-of-file rather than from
  // the end of *this* session would forgive an error anywhere in the last 4 KB
  // of every session but the last.
  const result = {sessions: [{index: 0, byteOffset: 0}, {index: 1, byteOffset: 4_000_000}]};
  const session = truncatedSession({errors: [{code: 'truncated', offset: 3_999_000}]});
  const end = sessionEndOffset(result, 0, FILE_BYTES);

  assert.equal(sessionIntegrity(session, end).state, 'truncated', 'near this session\'s end');
  assert.equal(sessionIntegrity(session, FILE_BYTES).state, 'damaged', 'far from the file end');
});

test('an error without a finite byte offset is body damage, never a forgiven tail', () => {
  for (const offset of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY]) {
    const session = truncatedSession({
      truncated: false,
      errors: [{code: 'corrupt-header', ...(offset === undefined ? {} : {offset})}]
    });
    const integrity = sessionIntegrity(session, 114);
    assert.equal(integrity.state, 'damaged');
    assert.equal(integrity.bodyErrors.length, 1);
    assert.equal(integrity.tailErrors.length, 0);
  }
});

test('header, compatibility and resource-limit failures are body damage even near EOF', () => {
  for (const code of ['corrupt-header', 'unsupported-firmware', 'limit-exceeded']) {
    const session = truncatedSession({
      truncated: false,
      errors: [{code, offset: 110}]
    });
    assert.equal(sessionIntegrity(session, 114).state, 'damaged', code);
  }
});

test('a validated format mismatch is body damage even when resync reaches EOF', () => {
  const session = truncatedSession({
    errors: [{code: 'corrupt-frame', offset: FILE_BYTES - 10, formatMismatch: true}]
  });
  assert.equal(sessionIntegrity(session, FILE_BYTES).state, 'damaged');
});

test('an unknown event at EOF is corruption, not evidence of a cut-off', () => {
  const session = truncatedSession({
    errors: [{code: 'corrupt-frame', offset: FILE_BYTES - 2, eventType: 200}]
  });
  const integrity = sessionIntegrity(session, FILE_BYTES);
  assert.equal(integrity.state, 'damaged');
  assert.equal(integrity.bodyErrors.length, 1);
  assert.equal(integrity.tailErrors.length, 0);
});
