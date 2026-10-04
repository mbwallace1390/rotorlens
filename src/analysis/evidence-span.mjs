/**
 * Which seconds of the flight window the governor was flying the rotor.
 *
 * The flight window (`flight-window.mjs`) is placed from the collective and the
 * head speed, and on real logs its end routinely lands well after the rotor has
 * started to come down: measured over the 31 admissible real flights this
 * repository holds, the governor left its ACTIVE state before the window's end
 * on 30, by a median of 5.0 s and up to 15.4 s. Those seconds are a rotor
 * spooling down with the helicopter on the ground or about to be. Measured in
 * them, a hold refuses itself for head speed (every HOLD_HEADSPEED_INVALID on
 * the corpus came from that tail), the vibration range is spread across a
 * falling rotor speed, and every new readout inherits the same skew.
 *
 * This module answers one question: inside a given window, from when to when
 * was the governor ACTIVE? It is the one place that question is answered, and
 * both analysis paths in `ui/app.mjs` and `tools/corpus/measure.mjs` slice the
 * session through `spannedSession` below, so the panels and the corpus report
 * are always about the same seconds.
 *
 * ---------------------------------------------------------------------------
 * THE RULE
 *
 *   start = max(window start, first ACTIVE moment + 0.5 s settle)
 *   end   = min(window end,   end of the last ACTIVE range)
 *
 * generalised to "the first and last SETTLED ACTIVE moments inside the window",
 * which is the same thing whenever the window and the ACTIVE ranges overlap the
 * ordinary way, and still the right thing when a window someone dragged starts
 * or ends inside a stretch where the governor was not ACTIVE.
 *
 * ACTIVE is event 50 (governor state) with state 4. That is a format fact,
 * measured, and recorded with its evidence in docs/BLACKBOX_FORMAT_NOTES.md; the
 * meanings of the other states are NOT established and nothing here assumes
 * any of them. Any state other than 4 ends an ACTIVE range.
 *
 * The 0.5 s settle is the one `summarizeGovernor` in
 * `advisor/deterministic-metrics.mjs` already applies to the same events: the
 * moment the governor reports ACTIVE is the moment it starts holding the head
 * speed, not a moment it has finished getting there.
 *
 * ---------------------------------------------------------------------------
 * WHEN NOTHING CAN BE TRIMMED, THE WINDOW STANDS
 *
 * - No event 50 in the log at all (GOVERNOR_STATE_NOT_LOGGED): an external
 *   governor, a throttle curve, or firmware that does not log the state. The
 *   head-speed alternative was measured and rejected — cutting where the head
 *   speed falls below the window's own flight-speed threshold only turned
 *   HOLD_HEADSPEED_INVALID refusals into HOLD_HEADSPEED_UNSTABLE ones and
 *   added no accepted hold — so the window is analysed exactly as before.
 * - Event 50 logged, but no settled ACTIVE stretch inside this window holding
 *   at least two samples (GOVERNOR_NEVER_ACTIVE): either the governor never
 *   reached state 4 in the whole log, or a dragged window lies outside the
 *   ACTIVE ranges. `activeRangeCount` tells the two apart. Trimming to nothing
 *   would leave no analysis at all — and the engine refuses a session of fewer
 *   than two samples, the same floor `checkFlightWindow` puts under a window —
 *   so the window stands, and the basis says why.
 *
 * ---------------------------------------------------------------------------
 * ACTIVE DROPPING OUT MID-FLIGHT
 *
 * The span keeps its OUTER bounds. A stretch inside it where the governor left
 * ACTIVE and came back is reported in `inactiveRangesInside` — from the drop to
 * the re-entry plus the same settle — with the states seen in it, and is NOT
 * excluded from the evidence. Cutting a hole in the middle of a sample stream
 * joins two stretches of flight end to end: a hold or a stop could then span
 * the join and be measured across seconds that were never flown continuously,
 * which is a worse error than the one being removed. It is reported so that it
 * is visible, and so that a later stage can exclude it per measurement where
 * that is simple and tested. An autorotation ends ACTIVE in flight, so evidence
 * after one is dropped from the end of the span; that is the rule working, not
 * a fault.
 *
 * ---------------------------------------------------------------------------
 * MEASUREMENT ONLY. Platform-neutral: no Node API, no import, explicit loops.
 */

export const EVIDENCE_SPAN_LIMITS = Object.freeze({
  /** The Blackbox event type that carries the governor state. */
  governorStateEventType: 50,
  /** The state value that means ACTIVE. See docs/BLACKBOX_FORMAT_NOTES.md. */
  governorActiveState: 4,
  /** Not trusted for this long after the governor reports ACTIVE. */
  activeSettleUs: 500_000
});

export const EvidenceSpanBasis = Object.freeze({
  /** The span is the window cut to the governor's settled ACTIVE stretch. */
  GOVERNOR_ACTIVE: 'GOVERNOR_ACTIVE',
  /** The log carries no governor-state event; the window is used unchanged. */
  GOVERNOR_STATE_NOT_LOGGED: 'GOVERNOR_STATE_NOT_LOGGED',
  /** Governor states are logged but none is a settled ACTIVE inside the window. */
  GOVERNOR_NEVER_ACTIVE: 'GOVERNOR_NEVER_ACTIVE'
});

function timeColumnOf(session) {
  const fields = Array.isArray(session?.fields) ? session.fields : [];
  for (let index = 0; index < fields.length; index += 1) {
    if (fields[index]?.name === 'time') {
      return index;
    }
  }
  return -1;
}

/** The first and last finite timestamps, or nulls. */
function sampleBounds(session, timeIndex) {
  const samples = Array.isArray(session?.samples) ? session.samples : [];
  let firstUs = null;
  let lastUs = null;
  if (timeIndex === -1) {
    return {firstUs, lastUs};
  }
  for (let index = 0; index < samples.length; index += 1) {
    const timeUs = samples[index]?.[timeIndex];
    if (Number.isFinite(timeUs)) {
      firstUs = timeUs;
      break;
    }
  }
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const timeUs = samples[index]?.[timeIndex];
    if (Number.isFinite(timeUs)) {
      lastUs = timeUs;
      break;
    }
  }
  return {firstUs, lastUs};
}

/**
 * When a governor-state event happened, or null when it cannot be placed.
 *
 * The decoder stamps an event with the time of the sample written before it
 * (`afterTimeUs`), exact to one sample interval. An event written before the
 * first sample has no such time; it preceded every sample, so it is placed at
 * the first one, which is as early as anything in this log can be measured.
 */
function eventTimeUs(event, firstUs) {
  if (Number.isFinite(event.afterTimeUs)) {
    return event.afterTimeUs;
  }
  if (event.afterTimeUs === null && event.sampleIndex === 0 && Number.isFinite(firstUs)) {
    return firstUs;
  }
  return null;
}

/**
 * The governor-state transitions, in stream order, each placed in time.
 *
 * @returns {{timeUs: number, state: number}[]}
 */
function governorTransitions(session, firstUs) {
  const events = Array.isArray(session?.events) ? session.events : [];
  const transitions = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.event !== 'state'
        || event.eventType !== EVIDENCE_SPAN_LIMITS.governorStateEventType
        || !Number.isFinite(event.state)) {
      continue;
    }
    const timeUs = eventTimeUs(event, firstUs);
    if (timeUs === null) {
      continue;
    }
    transitions.push({timeUs, state: event.state});
  }
  return transitions;
}

/** ACTIVE ranges from transitions already in stream order. */
function rangesFrom(transitions) {
  const ranges = [];
  let openedUs = null;
  for (let index = 0; index < transitions.length; index += 1) {
    const {timeUs, state} = transitions[index];
    if (state === EVIDENCE_SPAN_LIMITS.governorActiveState) {
      // A repeated ACTIVE while already ACTIVE neither reopens the range nor
      // moves its start.
      if (openedUs === null) {
        openedUs = timeUs;
      }
    } else if (openedUs !== null) {
      if (timeUs > openedUs) {
        ranges.push({startUs: openedUs, endUs: timeUs});
      }
      openedUs = null;
    }
  }
  if (openedUs !== null) {
    // Still ACTIVE when the log stopped: nothing says when it would have ended.
    ranges.push({startUs: openedUs, endUs: Infinity});
  }
  return ranges;
}

/**
 * Every ACTIVE range in the session, in time order. `endUs` is `Infinity` for
 * a range the log stopped inside.
 *
 * @returns {{startUs: number, endUs: number}[]}
 */
export function governorActiveRanges(session) {
  const {firstUs} = sampleBounds(session, timeColumnOf(session));
  return Object.freeze(rangesFrom(governorTransitions(session, firstUs))
    .map(range => Object.freeze(range)));
}

/** The non-ACTIVE states seen in [startUs, endUs). */
function statesBetween(transitions, startUs, endUs) {
  const seen = [];
  for (let index = 0; index < transitions.length; index += 1) {
    const {timeUs, state} = transitions[index];
    if (timeUs >= startUs && timeUs < endUs
        && state !== EVIDENCE_SPAN_LIMITS.governorActiveState
        && !seen.includes(state)) {
      seen.push(state);
    }
  }
  return Object.freeze(seen);
}

function answer(basis, startUs, endUs, windowStartUs, windowEndUs, extra = {}) {
  const finite = Number.isFinite(startUs) && Number.isFinite(endUs);
  return Object.freeze({
    basis,
    startUs: finite ? startUs : null,
    endUs: finite ? endUs : null,
    durationUs: finite ? endUs - startUs : null,
    windowStartUs: Number.isFinite(windowStartUs) ? windowStartUs : null,
    windowEndUs: Number.isFinite(windowEndUs) ? windowEndUs : null,
    // Microseconds removed from each end of the window. Durations, not times.
    trimmedStartUs: finite && Number.isFinite(windowStartUs) ? startUs - windowStartUs : 0,
    trimmedEndUs: finite && Number.isFinite(windowEndUs) ? windowEndUs - endUs : 0,
    inactiveRangesInside: extra.inactiveRangesInside ?? Object.freeze([]),
    activeRangeCount: extra.activeRangeCount ?? 0,
    settleUs: EVIDENCE_SPAN_LIMITS.activeSettleUs
  });
}

/**
 * The part of `window` the governor was flying the rotor.
 *
 * @param {object} session a decoded session: `fields`, `samples`, `events`
 * @param {{startUs: number, endUs: number}|null} window the flight window,
 *   detected or dragged; with none, the whole recording
 * @returns {{
 *   basis: string,
 *   startUs: number|null, endUs: number|null, durationUs: number|null,
 *   windowStartUs: number|null, windowEndUs: number|null,
 *   trimmedStartUs: number, trimmedEndUs: number,
 *   inactiveRangesInside: {startUs: number, endUs: number, states: number[]}[],
 *   activeRangeCount: number, settleUs: number
 * }}
 */
export function resolveEvidenceSpan(session, window) {
  const timeIndex = timeColumnOf(session);
  const {firstUs, lastUs} = sampleBounds(session, timeIndex);
  const windowStartUs = Number.isFinite(window?.startUs) ? window.startUs : firstUs;
  const windowEndUs = Number.isFinite(window?.endUs) ? window.endUs : lastUs;

  const transitions = governorTransitions(session, firstUs);
  if (transitions.length === 0) {
    return answer(EvidenceSpanBasis.GOVERNOR_STATE_NOT_LOGGED,
      windowStartUs, windowEndUs, windowStartUs, windowEndUs);
  }

  const ranges = rangesFrom(transitions);
  if (!Number.isFinite(windowStartUs) || !Number.isFinite(windowEndUs)) {
    return answer(ranges.length > 0
      ? EvidenceSpanBasis.GOVERNOR_ACTIVE : EvidenceSpanBasis.GOVERNOR_NEVER_ACTIVE,
    null, null, windowStartUs, windowEndUs, {activeRangeCount: ranges.length});
  }

  // Each range, settled, clipped to the window. Ranges arrive in time order, so
  // the overlaps do too. An overlap holding fewer than two samples cannot be
  // measured over — the same two-sample floor `checkFlightWindow` puts under a
  // window — so it counts as no ACTIVE at all rather than handing every
  // analysis an empty session.
  const settle = EVIDENCE_SPAN_LIMITS.activeSettleUs;
  const overlaps = [];
  for (let index = 0; index < ranges.length; index += 1) {
    const low = Math.max(ranges[index].startUs + settle, windowStartUs);
    const high = Math.min(ranges[index].endUs, windowEndUs);
    if (low < high && samplesBetween(session, timeIndex, low, high) >= 2) {
      overlaps.push({startUs: low, endUs: high});
    }
  }

  if (overlaps.length === 0) {
    return answer(EvidenceSpanBasis.GOVERNOR_NEVER_ACTIVE,
      windowStartUs, windowEndUs, windowStartUs, windowEndUs,
      {activeRangeCount: ranges.length});
  }

  const inside = [];
  for (let index = 1; index < overlaps.length; index += 1) {
    const startUs = overlaps[index - 1].endUs;
    const endUs = overlaps[index].startUs;
    inside.push(Object.freeze({startUs, endUs, states: statesBetween(transitions, startUs, endUs)}));
  }

  return answer(EvidenceSpanBasis.GOVERNOR_ACTIVE,
    overlaps[0].startUs, overlaps[overlaps.length - 1].endUs, windowStartUs, windowEndUs,
    {inactiveRangesInside: Object.freeze(inside), activeRangeCount: ranges.length});
}

/** First sample index whose time is at or after `timeUs`. Binary search. */
function firstIndexAtOrAfter(samples, timeIndex, timeUs) {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (samples[middle][timeIndex] < timeUs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** How many samples have a time in [startUs, endUs]. */
function samplesBetween(session, timeIndex, startUs, endUs) {
  if (timeIndex === -1 || !Array.isArray(session?.samples)) {
    return 0;
  }
  return firstIndexAtOrAfter(session.samples, timeIndex, endUs + 1)
    - firstIndexAtOrAfter(session.samples, timeIndex, startUs);
}

/**
 * A session object carrying only the samples in [startUs, endUs], both ends
 * included. The rows are shared with the original, not copied: the cost is one
 * pointer per sample. A span covering every sample returns the session itself.
 */
export function sliceSessionToSpan(session, span) {
  if (!Array.isArray(session?.samples)
      || !Number.isFinite(span?.startUs) || !Number.isFinite(span?.endUs)) {
    return session;
  }
  const timeIndex = timeColumnOf(session);
  if (timeIndex === -1) {
    return session;
  }
  const from = firstIndexAtOrAfter(session.samples, timeIndex, span.startUs);
  // One microsecond past the end, so the sample AT endUs is included.
  const to = firstIndexAtOrAfter(session.samples, timeIndex, span.endUs + 1);
  if (from === 0 && to >= session.samples.length) {
    return session;
  }
  return {...session, samples: session.samples.slice(from, to)};
}

/**
 * The session as every analysis should receive it: the flight window, cut to
 * the governor's ACTIVE span. The one function both the viewer and the corpus
 * tool slice through.
 *
 * @returns {{session: object, span: object}}
 */
export function spannedSession(session, window) {
  const span = resolveEvidenceSpan(session, window);
  return {session: sliceSessionToSpan(session, span), span};
}
