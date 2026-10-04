/**
 * Cover for `src/analysis/evidence-span.mjs`: which seconds of the flight
 * window the governor was flying the rotor.
 *
 * The synthetic cases below are lists of governor-state events in and a span
 * out. They prove the wiring — that the module reads event 50 the way the
 * decoder emits it and does the arithmetic it documents — and nothing about
 * whether state 4 means ACTIVE on any particular firmware. That is a format
 * fact, recorded in docs/BLACKBOX_FORMAT_NOTES.md with the real flights it was
 * measured on, and the real-log tests at the foot of this file are the only
 * ones here that touch it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

import {
  EVIDENCE_SPAN_LIMITS,
  EvidenceSpanBasis,
  governorActiveRanges,
  resolveEvidenceSpan,
  sliceSessionToSpan,
  spannedSession
} from '../src/analysis/evidence-span.mjs';
import {resolveFlightWindow} from '../src/analysis/flight-window.mjs';
import {buildAnalysisRecords} from '../src/analysis/records.mjs';
import {AXES, buildHoldEvidence} from '../src/analysis/pid-evidence.mjs';
import {decodeLog} from '../src/blackbox/decode.mjs';
import {checkFlightAdmissible} from '../src/analysis/flight-history.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STOP_MANOEUVRES = path.join(projectRoot, 'fixtures', 'synthetic',
  'rf46-stop-manoeuvres.TXT');

const S = 1_000_000;

/**
 * A minimal decoded session: a time column at 10 ms and the events given, in
 * the exact shape `FrameDecoder` emits them — `afterTimeUs` is the timestamp of
 * the sample written before the event, `sampleIndex` the sample after it.
 */
function sessionWith(states, {startUs = 0, endUs = 60 * S, intervalUs = 10_000, extra = []} = {}) {
  const samples = [];
  for (let timeUs = startUs; timeUs <= endUs; timeUs += intervalUs) {
    samples.push([timeUs]);
  }
  const events = [];
  for (const [atS, state] of states) {
    const atUs = Math.round(atS * S);
    // The first sample strictly after the event; the event follows the one
    // before it, whose time is `afterTimeUs`.
    let sampleIndex = 0;
    while (sampleIndex < samples.length && samples[sampleIndex][0] <= atUs) {
      sampleIndex += 1;
    }
    events.push({
      event: 'state',
      eventType: 50,
      state,
      offset: 1000 + events.length,
      sampleIndex,
      afterTimeUs: sampleIndex > 0 ? samples[sampleIndex - 1][0] : null
    });
  }
  return {
    fields: [{name: 'time', index: 0, signed: false}],
    samples,
    events: [...events, ...extra]
  };
}

const windowOf = (startS, endS) => ({startUs: startS * S, endUs: endS * S});
const seconds = us => Math.round(us) / S;

test('the settle after ACTIVE is half a second, and state 4 is the only ACTIVE state', () => {
  assert.equal(EVIDENCE_SPAN_LIMITS.activeSettleUs, 500_000);
  assert.equal(EVIDENCE_SPAN_LIMITS.governorStateEventType, 50);
  assert.equal(EVIDENCE_SPAN_LIMITS.governorActiveState, 4);
  assert.deepEqual(Object.values(EvidenceSpanBasis).sort(), [
    'GOVERNOR_ACTIVE', 'GOVERNOR_NEVER_ACTIVE', 'GOVERNOR_STATE_NOT_LOGGED'
  ]);
});

test('a log with no governor-state event keeps the flight window exactly', () => {
  // Other state events are present, so "no event 50" is not "no events".
  const session = sessionWith([], {extra: [
    {event: 'state', eventType: 52, state: 1, sampleIndex: 100, afterTimeUs: 990_000, offset: 9}
  ]});
  const span = resolveEvidenceSpan(session, windowOf(10, 50));
  assert.equal(span.basis, EvidenceSpanBasis.GOVERNOR_STATE_NOT_LOGGED);
  assert.equal(span.startUs, 10 * S);
  assert.equal(span.endUs, 50 * S);
  assert.equal(span.trimmedStartUs, 0);
  assert.equal(span.trimmedEndUs, 0);
  assert.deepEqual(span.inactiveRangesInside, []);
  assert.equal(span.activeRangeCount, 0);
});

test('a governor that never reached ACTIVE keeps the flight window exactly', () => {
  const span = resolveEvidenceSpan(sessionWith([[2, 1], [4, 2], [9, 1], [52, 0]]),
    windowOf(10, 50));
  assert.equal(span.basis, EvidenceSpanBasis.GOVERNOR_NEVER_ACTIVE);
  assert.equal(span.startUs, 10 * S);
  assert.equal(span.endUs, 50 * S);
  assert.equal(span.trimmedStartUs, 0);
  assert.equal(span.trimmedEndUs, 0);
  assert.equal(span.activeRangeCount, 0);
});

test('the spool-down after the last ACTIVE range is cut off the end', () => {
  // ACTIVE from 3 s, out of it at 50 s, rotor off at 52 s; the window, as the
  // collective rule placed it, runs on to 56 s.
  const span = resolveEvidenceSpan(sessionWith([[1, 1], [2, 2], [3, 4], [50, 7], [52, 0]]),
    windowOf(10, 56));
  assert.equal(span.basis, EvidenceSpanBasis.GOVERNOR_ACTIVE);
  assert.equal(span.startUs, 10 * S, 'ACTIVE long before liftoff trims nothing at the start');
  assert.equal(seconds(span.endUs), 50);
  assert.equal(span.trimmedStartUs, 0);
  assert.equal(seconds(span.trimmedEndUs), 6);
  assert.equal(seconds(span.durationUs), 40);
  assert.deepEqual(span.inactiveRangesInside, []);
});

test('ACTIVE that runs past the end of the window, or to the end of the log, keeps the end', () => {
  const toLogEnd = resolveEvidenceSpan(sessionWith([[3, 4]]), windowOf(10, 50));
  assert.equal(toLogEnd.basis, EvidenceSpanBasis.GOVERNOR_ACTIVE);
  assert.equal(toLogEnd.startUs, 10 * S);
  assert.equal(toLogEnd.endUs, 50 * S);
  assert.equal(toLogEnd.trimmedEndUs, 0);

  const pastWindow = resolveEvidenceSpan(sessionWith([[3, 4], [55, 7]]), windowOf(10, 50));
  assert.equal(pastWindow.endUs, 50 * S);
  assert.equal(pastWindow.trimmedEndUs, 0);

  const ranges = governorActiveRanges(sessionWith([[3, 4]]));
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].endUs, Infinity, 'a range still open when the log ends has no end yet');
});

test('a liftoff before the governor is ACTIVE trims the start to ACTIVE plus the settle', () => {
  const span = resolveEvidenceSpan(sessionWith([[2, 1], [4, 2], [12, 4], [50, 7]]),
    windowOf(10, 56));
  assert.equal(span.basis, EvidenceSpanBasis.GOVERNOR_ACTIVE);
  assert.equal(seconds(span.startUs), 12.5);
  assert.equal(seconds(span.trimmedStartUs), 2.5);
  assert.equal(seconds(span.endUs), 50);
});

test('restarts before ACTIVE (1, 2, 1, 2, 4) start the span at the first ACTIVE only', () => {
  const span = resolveEvidenceSpan(
    sessionWith([[2, 1], [4, 2], [6, 1], [8, 2], [11, 4], [50, 7]]), windowOf(9, 56));
  assert.equal(span.basis, EvidenceSpanBasis.GOVERNOR_ACTIVE);
  assert.equal(seconds(span.startUs), 11.5);
  assert.equal(seconds(span.trimmedStartUs), 2.5);
  assert.equal(span.activeRangeCount, 1);
  // A second ACTIVE event while already ACTIVE does not reopen the range or
  // move its start.
  const repeated = resolveEvidenceSpan(sessionWith([[11, 4], [20, 4], [50, 7]]), windowOf(9, 56));
  assert.equal(seconds(repeated.startUs), 11.5);
  assert.equal(repeated.activeRangeCount, 1);
});

test('ACTIVE dropping out mid-window keeps the outer span and reports the gap', () => {
  const span = resolveEvidenceSpan(
    sessionWith([[5, 4], [20, 3], [22, 4], [45, 7], [47, 0]]), windowOf(10, 52));
  assert.equal(span.basis, EvidenceSpanBasis.GOVERNOR_ACTIVE);
  assert.equal(span.startUs, 10 * S);
  assert.equal(seconds(span.endUs), 45);
  assert.equal(seconds(span.trimmedEndUs), 7);
  assert.equal(span.activeRangeCount, 2);
  assert.equal(span.inactiveRangesInside.length, 1);
  const [gap] = span.inactiveRangesInside;
  // The gap runs from the drop to the re-entry PLUS its settle, because the
  // same half second that is not trusted after the first ACTIVE is not trusted
  // after a second one.
  assert.equal(seconds(gap.startUs), 20);
  assert.equal(seconds(gap.endUs), 22.5);
  assert.deepEqual([...gap.states], [3]);
});

test('a window that starts inside a gap starts at the next settled ACTIVE moment', () => {
  const span = resolveEvidenceSpan(
    sessionWith([[2, 4], [10, 7], [20, 4], [55, 7]]), windowOf(15, 50));
  assert.equal(span.basis, EvidenceSpanBasis.GOVERNOR_ACTIVE);
  assert.equal(seconds(span.startUs), 20.5);
  assert.equal(span.endUs, 50 * S);
  assert.deepEqual(span.inactiveRangesInside, []);
});

test('a window with no settled ACTIVE moment inside it is kept, and says why', () => {
  // Dragged onto the spool-down: the governor was ACTIVE, but not in here.
  const dragged = resolveEvidenceSpan(sessionWith([[3, 4], [50, 7], [52, 0]]), windowOf(51, 56));
  assert.equal(dragged.basis, EvidenceSpanBasis.GOVERNOR_NEVER_ACTIVE);
  assert.equal(dragged.startUs, 51 * S);
  assert.equal(dragged.endUs, 56 * S);
  assert.equal(dragged.activeRangeCount, 1, 'the log did have ACTIVE, outside this window');

  // ACTIVE 0.2 s before the window ends never finishes its settle inside it.
  const unsettled = resolveEvidenceSpan(sessionWith([[47.8, 4]]), windowOf(10, 48));
  assert.equal(unsettled.basis, EvidenceSpanBasis.GOVERNOR_NEVER_ACTIVE);
  assert.equal(unsettled.endUs, 48 * S);

  // Settled at 50.000 s, in a window ending at 50.005 s, on a 10 ms log: one
  // sample, which the engine cannot measure over and throws on. Not a span.
  const lateActive = sessionWith([[49.505, 4]]);
  const oneSample = resolveEvidenceSpan(lateActive, windowOf(10, 50.005));
  assert.equal(oneSample.basis, EvidenceSpanBasis.GOVERNOR_NEVER_ACTIVE);
  assert.equal(oneSample.startUs, 10 * S);
  // ...and two samples are enough.
  const twoSamples = spannedSession(lateActive, windowOf(10, 50.015));
  assert.equal(twoSamples.span.basis, EvidenceSpanBasis.GOVERNOR_ACTIVE);
  assert.equal(twoSamples.session.samples.length, 2);
});

test('an ACTIVE event written before the first sample counts from the first sample', () => {
  const session = sessionWith([[30, 7]], {startUs: 5 * S});
  session.events.unshift({event: 'state', eventType: 50, state: 4, offset: 1,
    sampleIndex: 0, afterTimeUs: null});
  const span = resolveEvidenceSpan(session, windowOf(5, 40));
  assert.equal(span.basis, EvidenceSpanBasis.GOVERNOR_ACTIVE);
  assert.equal(seconds(span.startUs), 5.5);
  assert.equal(seconds(span.endUs), 30);
});

test('an event that cannot be placed in time is ignored, not guessed', () => {
  const session = sessionWith([[3, 4], [50, 7]]);
  session.events.push({event: 'state', eventType: 50, state: 0, offset: 77,
    sampleIndex: 4000, afterTimeUs: Number.NaN});
  const span = resolveEvidenceSpan(session, windowOf(10, 56));
  assert.equal(seconds(span.endUs), 50);
});

test('no window, or a session with no samples, does not throw', () => {
  const session = sessionWith([[3, 4], [50, 7]]);
  const whole = resolveEvidenceSpan(session, null);
  assert.equal(whole.basis, EvidenceSpanBasis.GOVERNOR_ACTIVE);
  assert.equal(seconds(whole.startUs), 3.5);
  assert.equal(seconds(whole.endUs), 50);

  const empty = resolveEvidenceSpan({fields: [{name: 'time', index: 0}], samples: [], events: []},
    null);
  assert.equal(empty.startUs, null);
  assert.equal(empty.endUs, null);
  assert.equal(resolveEvidenceSpan(null, null).startUs, null);
});

test('the inputs are not touched, and the answer is frozen', () => {
  const session = sessionWith([[3, 4], [50, 7]]);
  const window = windowOf(10, 56);
  const eventsBefore = JSON.stringify(session.events);
  const span = resolveEvidenceSpan(session, window);
  assert.equal(JSON.stringify(session.events), eventsBefore);
  assert.deepEqual(window, windowOf(10, 56));
  assert.ok(Object.isFrozen(span));
  assert.ok(Object.isFrozen(span.inactiveRangesInside));
});

test('the spanned session holds exactly the samples inside the span, sharing the rows', () => {
  const session = sessionWith([[3, 4], [50, 7]]);
  const {session: spanned, span} = spannedSession(session, windowOf(10, 56));
  assert.equal(spanned.samples[0][0], 10 * S);
  assert.equal(spanned.samples.at(-1)[0], 50 * S, 'the sample AT the span end is included');
  assert.equal(spanned.samples.length, 4001);
  assert.equal(spanned.samples[0], session.samples[1000], 'rows are shared, not copied');
  assert.equal(spanned.events, session.events);
  assert.equal(span.basis, EvidenceSpanBasis.GOVERNOR_ACTIVE);

  // A span covering every sample hands back the session itself.
  const all = sliceSessionToSpan(session, {startUs: -1, endUs: 61 * S});
  assert.equal(all, session);
  // No finite span, no slice.
  assert.equal(sliceSessionToSpan(session, {startUs: null, endUs: null}), session);
});

// ---------------------------------------------------------------------------
// Through the real decoder
// ---------------------------------------------------------------------------

/**
 * A committed fixture with its governor and airborne events rewritten IN
 * MEMORY, one payload byte each. The 18.4 s stop-manoeuvre fixture logs event
 * 50 state 1 at 45 % of its frames and event 52 states 1 and 0 at 60 % and
 * 80 %; turning the two 52s into 50s with states 4 and 0 gives a governor that
 * is ACTIVE for 3.7 s of a real encoded frame stream — longer than the settle,
 * which the 0.1 s two-session fixture is not. Nothing is written to disk.
 */
async function fixtureWithGovernor() {
  const bytes = new Uint8Array(await readFile(STOP_MANOEUVRES));
  const session = decodeLog(bytes).sessions[0];
  const airborne = session.events.filter(event => event.eventType === 52);
  assert.equal(airborne.length, 2, 'the fixture must carry its two airborne events');
  const patched = bytes.slice();
  for (const [event, state] of [[airborne[0], 4], [airborne[1], 0]]) {
    assert.equal(patched[event.offset], 0x45, 'an event frame starts with E');
    assert.equal(patched[event.offset + 1], 52);
    patched[event.offset + 1] = 50;
    patched[event.offset + 2] = state;
  }
  return {original: session, patched: decodeLog(patched).sessions[0]};
}

test('event 50 is read in the shape the decoder actually emits', async () => {
  const {original, patched} = await fixtureWithGovernor();
  assert.equal(resolveEvidenceSpan(original, null).basis,
    EvidenceSpanBasis.GOVERNOR_NEVER_ACTIVE, 'the committed fixture logs state 1 only');

  const governor = patched.events.filter(event => event.eventType === 50);
  assert.deepEqual(governor.map(event => event.state), [1, 4, 0]);
  for (const event of governor) {
    assert.equal(event.event, 'state');
    assert.equal(typeof event.afterTimeUs, 'number');
    assert.ok(Number.isInteger(event.sampleIndex));
  }

  const span = resolveEvidenceSpan(patched, null);
  assert.equal(span.basis, EvidenceSpanBasis.GOVERNOR_ACTIVE);
  assert.equal(span.startUs, governor[1].afterTimeUs + EVIDENCE_SPAN_LIMITS.activeSettleUs);
  assert.equal(span.endUs, governor[2].afterTimeUs);
});

// ---------------------------------------------------------------------------
// Real logs. Aggregates only; no log is named or excerpted.
// ---------------------------------------------------------------------------

const REAL_LOG = process.env.ROTORLENS_REAL_LOG;
const realLogSkip = !REAL_LOG && 'set ROTORLENS_REAL_LOG to a .bbl path to run this';

test('THE REFERENCE FLIGHT: it ends in flight at speed, so its span is its window',
  {skip: realLogSkip}, async () => {
    const session = decodeLog(new Uint8Array(await readFile(REAL_LOG))).sessions[0];
    const window = resolveFlightWindow(session);
    const span = resolveEvidenceSpan(session, window);
    // Measured 2026-10-04: the governor reaches ACTIVE 3.25 s before the
    // liftoff, never leaves it, and the log stops in flight.
    assert.equal(span.basis, EvidenceSpanBasis.GOVERNOR_ACTIVE);
    assert.equal(span.startUs, window.startUs);
    assert.equal(span.endUs, window.endUs);
    assert.equal(span.trimmedStartUs, 0);
    assert.equal(span.trimmedEndUs, 0);
    assert.deepEqual(span.inactiveRangesInside, []);
  });

/**
 * Every admissible flight in every configured real log, decoded the way
 * tools/corpus/measure.mjs decodes one.
 */
const CORPUS_LOGS = [...new Set([
  REAL_LOG,
  ...(process.env.ROTORLENS_CORPUS_LOGS ?? '').split(';')
].filter(Boolean).map(file => path.resolve(file)))];
const corpusSkip = CORPUS_LOGS.length === 0
  && 'set ROTORLENS_REAL_LOG or ROTORLENS_CORPUS_LOGS to owner-approved .bbl paths';

/**
 * What every span must satisfy whatever the log carries, as a list of the
 * statements it breaks. Empty means it holds.
 */
function spanViolations(session, window, span, spanned) {
  const broken = [];
  const timeIndex = session.fields.findIndex(field => field.name === 'time');
  const windowUs = window.endUs - window.startUs;
  if (!Number.isFinite(span.startUs) || !Number.isFinite(span.endUs)) {
    return ['the span has no finite ends'];
  }
  if (!(window.startUs <= span.startUs && span.startUs < span.endUs
      && span.endUs <= window.endUs)) {
    broken.push('the span is empty, inverted or outside its window');
  }
  if (span.durationUs !== span.endUs - span.startUs) {
    broken.push('the duration is not the distance between the ends');
  }
  if (!(span.trimmedStartUs >= 0 && span.trimmedEndUs >= 0)
      || span.trimmedStartUs + span.durationUs + span.trimmedEndUs !== windowUs) {
    broken.push('the trims and the span do not add up to the window');
  }
  if (spanned.samples.length < 2) {
    broken.push('fewer than two samples to analyse');
  }
  if (spanned.samples.some(sample => sample[timeIndex] < span.startUs
      || sample[timeIndex] > span.endUs)) {
    broken.push('a sample outside the span was handed on');
  }
  if (span.basis === EvidenceSpanBasis.GOVERNOR_ACTIVE) {
    // Both ends in a settled ACTIVE range, and every gap inside the span.
    const ranges = governorActiveRanges(session);
    const settle = EVIDENCE_SPAN_LIMITS.activeSettleUs;
    const inRange = (timeUs, atEnd) => ranges.some(range => range.startUs + settle <= timeUs
      && (atEnd ? timeUs <= range.endUs : timeUs < range.endUs));
    if (!inRange(span.startUs, false) || !inRange(span.endUs, true)) {
      broken.push('an end of the span lies outside every settled ACTIVE range');
    }
    if (span.inactiveRangesInside.some(gap => gap.startUs < span.startUs
        || gap.endUs > span.endUs || !(gap.startUs < gap.endUs))) {
      broken.push('a reported gap lies outside the span');
    }
  } else {
    // Nothing to trim by: the window stands exactly, and says why.
    if (span.startUs !== window.startUs || span.endUs !== window.endUs
        || span.trimmedStartUs !== 0 || span.trimmedEndUs !== 0) {
      broken.push(`${span.basis} trimmed the window`);
    }
    if (span.inactiveRangesInside.length !== 0) {
      broken.push(`${span.basis} reported a gap`);
    }
  }
  return broken;
}

test('REAL FLIGHTS: every span holds its invariants, and no hold inside a governor span is '
  + 'refused as an invalid head speed', {skip: corpusSkip}, async () => {
  // Rewritten 4 October 2026 (Stage 5a review). It asserted that every
  // admissible flight is governor-ACTIVE — true of this repository's corpus and
  // a fact about it, not about the code — so the first log with an external
  // governor in ROTORLENS_CORPUS_LOGS would have failed the suite for being a
  // log. It now asserts what must hold of EVERY span, on every admissible
  // flight; the head-speed claim is made of the flights whose span the governor
  // set, because only those had a spool-down that could be cut.
  let flights = 0;
  let governed = 0;
  let invalidInWindow = 0;
  let invalidInSpan = 0;
  const violations = [];
  for (const file of CORPUS_LOGS) {
    for (const session of decodeLog(new Uint8Array(await readFile(file))).sessions) {
      if (!Array.isArray(session.samples) || session.samples.length === 0) {
        continue;
      }
      const window = resolveFlightWindow(session);
      if (!checkFlightAdmissible({session, window}).admissible) {
        continue;
      }
      flights += 1;
      const {session: spanned, span} = spannedSession(session, window);
      for (const broken of spanViolations(session, window, span, spanned)) {
        violations.push(`flight ${flights}: ${broken}`);
      }
      if (span.basis !== EvidenceSpanBasis.GOVERNOR_ACTIVE) {
        continue;
      }
      governed += 1;
      const windowed = sliceSessionToSpan(session, window);
      for (const axis of AXES) {
        for (const [scoped, add] of [
          [windowed, n => { invalidInWindow += n; }],
          [spanned, n => { invalidInSpan += n; }]
        ]) {
          const built = buildAnalysisRecords(scoped, {axis});
          if (!built.usable) {
            continue;
          }
          const evidence = buildHoldEvidence(built.records, {axis, term: 'I'});
          add(evidence.rejectedHoldCounts?.HOLD_HEADSPEED_INVALID ?? 0);
        }
      }
    }
  }
  assert.ok(flights > 0, 'no admissible flight in the configured logs');
  assert.deepEqual(violations, [], `${violations.length} span invariant(s) broken`);
  assert.equal(invalidInSpan, 0,
    `${invalidInSpan} hold(s) inside a governor span were refused for head speed`);
  if (governed > 1) {
    // Only meaningful where the corpus has a spool-down to remove; the
    // reference flight alone has none.
    assert.ok(invalidInWindow > 0, 'the window must have had refusals for the span to remove');
  }
});
