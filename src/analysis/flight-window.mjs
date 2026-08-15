/**
 * Where the flight is inside the recording.
 *
 * A Blackbox log starts when the pilot arms and stops when they disarm or the
 * power comes off, so it routinely opens with tens of seconds of the machine
 * sitting on its skids at idle and spooling up. That prologue is not neutral —
 * it is the single largest source of wrong answers elsewhere in RotorLens. On
 * the reference flight the spool-up alone drives the whole-log headspeed
 * relative spread to 0.62 against a 0.12 stationarity gate, which makes the
 * rotor correlation unavailable and leaves all fifteen vibration peaks
 * unexplained. Trimming to the flight brings the spread to 0.073 and nine of
 * those peaks resolve to main-rotor orders 1, 2 and 4.
 *
 * This module answers one question — when did it leave the ground and when did
 * it come back — and it answers "I cannot tell" out loud rather than guessing a
 * number. Every result carries the basis code it was reached by, so a caller
 * can render the reason next to the markers instead of silently snapping them.
 *
 * ---------------------------------------------------------------------------
 * THE RULE, AND WHY IT IS THIS ONE
 * ---------------------------------------------------------------------------
 *
 * Collective pitch, gated by rotor speed, calibrated on the log's own units.
 *
 * A helicopter leaves the ground when the pilot raises collective while the
 * rotor is at flight speed, and only then. Neither half works alone: collective
 * moves on the ground during stick checks, and the rotor reaches speed several
 * seconds before the machine lifts. The two together are what separates ground
 * from air.
 *
 * Absolute collective thresholds are impossible across logs. The reference
 * log's collective is centred on 0 and spans roughly −500…+500; the repo's
 * `rf46-stop-manoeuvres` fixture sits at 1140…1260. So the rule calibrates on
 * the log's own spool-up interval, which is guaranteed to be on the ground
 * because the rotor has not reached flight speed yet.
 *
 * ---------------------------------------------------------------------------
 * CANDIDATES THAT WERE MEASURED AND REJECTED
 * ---------------------------------------------------------------------------
 *
 * Recorded so nobody re-derives them. All figures from
 * `sample-bell-222ut.bbl`, whose detected liftoff is 22.762 s.
 *
 * - **The log's own airborne event (type 52) as the window.** It is real
 *   firmware ground truth and it is not usable as a boundary. On the reference
 *   log it emits 1/0/1/0/1 at 15.575/17.787/18.402/18.815/22.773 s; at each of
 *   the first four the rotor is below flight speed (1267–1623 rpm) and
 *   collective is negative (−74…−95), so the machine is provably on the skids.
 *   On `rf46-stop-manoeuvres.TXT` the type-52 interval is 11.042…14.722 s and
 *   contains 1 of that fixture's 12 stops — trusting it there costs eleven.
 *   It is published here as corroboration and never sets a boundary.
 *
 * - **Gyro activity.** Anti-correlated on this flight: per-second gyro RMS
 *   reads 9.79 and 11.88 at s15–s16 on the ground during run-up against 2.76,
 *   1.96 and 1.84 at s44, s70 and s108 in stable flight. Any "gyro rises off
 *   the floor" rule fires during spool-up.
 *
 * - **Barometric altitude.** Separates in the median (on-ground −138, in-flight
 *   +55) but its in-flight standard deviation is 20x its on-ground one and it
 *   swings 450 cm in the first two seconds of flight from rotor wash. Absent
 *   from three of the four logs we hold.
 *
 * - **GPS.** The decoder now publishes satellite count, ground speed and GPS
 *   altitude (never coordinates), and on the reference log they cannot support
 *   a takeoff threshold: ground speed reads 53–75 cm/s while the machine sits
 *   on its skids at 14–21 s, `numSat` drops to 0 for a fourteen-fix stretch
 *   straddling the real liftoff, and GPS altitude drifts from 79 406 cm to
 *   4 321 cm as the fix converges. Three of the four logs carry no G frames.
 *
 * - **Throttle (`rcCommand[4]`).** Marks arming, not takeoff: 0 → 708 at s4 and
 *   1000 from s5, against a liftoff at 22.762 s.
 *
 * - **Collective alone, without the rotor gate.** First sustained 0.5 s
 *   crossing of −50 gives 3.090 s (a pre-arm stick check, rotor stopped);
 *   of −20 gives 22.618 s. A 30-unit threshold change moves the answer by
 *   19.5 s, which is why the rotor gate has to come first.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is not a stationarity window. Three of the four logs we hold have no
 * collective column at all and correctly return the whole log; the tempting
 * fallback of "trim to where headspeed goes stationary" would delete two of
 * their eight injected manoeuvres, which all happen during the ramp. Keep the
 * per-range stationarity measurement where it lives.
 *
 * It also does not replace `sessionTimeBounds`, which means the whole recording
 * and must keep meaning that.
 *
 * Pure and dependency-free: Float64Array, Number, Math. Node, a browser and an
 * Android WebView run one copy.
 */

/**
 * Field name candidates, in preference order.
 *
 * Deliberately the same spellings `records.mjs` `FIELD_MAP` uses, and
 * `test/flight-window.test.mjs` asserts they have not drifted apart — a log
 * whose collective resolves in one module and not the other would produce a
 * window that disagrees with the records measured inside it.
 *
 * `rpm[0]` is accepted as a headspeed alias here, which `mechanical-session.mjs`
 * refuses. The difference is what the number is used for: harmonic correlation
 * needs the absolute rotor speed and a motor rpm is wrong by the gear ratio,
 * whereas every headspeed comparison below is a RATIO against that same
 * column's own median. A gear ratio cancels out of a ratio.
 */
const TIME_FIELDS = Object.freeze(['time']);
const HEADSPEED_FIELDS = Object.freeze(['headspeed', 'rpm[0]']);
const COLLECTIVE_FIELDS = Object.freeze(['rcCommand[3]', 'collective']);

/**
 * Every tuned constant, in one place, exported so a test can sweep them.
 *
 * The sensitivity of the reference log's liftoff to each, measured:
 *   liftMargin        1 … 8   -> 22.578 … 23.475 s   (0.9 s across an 8x sweep)
 *   flightSpeedFrac   0.70 … 0.98 -> 22.658 … 22.835 s
 *   holdFrac          0.70 … 0.95 -> 22.762 … 22.794 s
 *   spinStartFrac     0.01 … 0.30 -> 22.762 / 22.731 s
 *   liftHoldUs        0.1 … 3 s   -> 22.762 s unchanged
 *   spooledHoldUs     0.5 … 8 s   -> 22.762 s unchanged
 *   spinRatioMax      0.1 … 0.9   -> 22.762 s unchanged
 *
 * `liftMargin` is the only one that moves the answer at all, and it is
 * load-bearing rather than arbitrary: at 12 the threshold rises above the
 * flight's own median collective and the detected liftoff jumps past 35 s.
 * `test/flight-window.test.mjs` pins that so the constant cannot be quietly
 * neutered into a value that no longer decides anything.
 */
export const FLIGHT_WINDOW_CONSTANTS = Object.freeze({
  /** A log with no rotor start cannot be split into ground and air by this rule. */
  spinRatioMax: 0.5,
  /** Rotor is turning at all: fraction of the log's median headspeed. */
  spinStartFrac: 0.05,
  /** Rotor is at flight speed: fraction of the log's median headspeed. */
  flightSpeedFrac: 0.90,
  /** ...and must not fall below this fraction for `spooledHoldUs`. */
  holdFrac: 0.85,
  spooledHoldUs: 2_000_000,
  /** Liftoff threshold = ground collective + liftMargin x ground spread. */
  liftMargin: 3,
  /** Collective must stay above the threshold this long to count as a liftoff. */
  liftHoldUs: 500_000,
  /** Landing threshold = ground collective + settleMargin x ground spread. */
  settleMargin: 1,
  /** ...and must stay there, to the end of the log, this long. */
  settleHoldUs: 2_000_000,
  /**
   * Floor under the measured ground spread, as a fraction of the collective
   * column's own full range.
   *
   * A perfectly flat on-ground collective measures a spread of zero, which
   * would collapse the liftoff threshold onto the ground level itself and let
   * one noisy sample declare a takeoff. On the reference log the measured
   * spread is 33 and this floor is 7.6, so it changes nothing there; it exists
   * for the degenerate log, and when the full range is zero too there is no
   * collective signal at all and the rule says so.
   */
  minSpreadFraction: 0.02
});

/** Why a window is what it is. Rendered to the pilot, so each one is a sentence. */
export const FlightWindowBasis = Object.freeze({
  /** Both ends found. */
  DETECTED: 'FLIGHT_WINDOW_DETECTED',
  /** Took off, and the recording stops while still flying. */
  ENDED_IN_FLIGHT: 'LIFTOFF_DETECTED_LOG_ENDED_IN_FLIGHT',
  /** The caller supplied the window; nothing was detected on its behalf. */
  CALLER_SUPPLIED: 'CALLER_SUPPLIED_WINDOW',
  /** No collective column, so ground and air cannot be told apart. */
  NO_COLLECTIVE: 'COLLECTIVE_NOT_LOGGED',
  /** No headspeed column, so the rotor gate cannot be applied. */
  NO_HEADSPEED: 'HEADSPEED_NOT_LOGGED',
  /** The rotor is already turning at sample zero: the log begins mid-flight. */
  NO_ROTOR_START: 'NO_ROTOR_START_IN_LOG',
  /** Rotor started, but it never reached a sustained flight speed. */
  NO_ROTOR_AT_SPEED: 'ROTOR_NEVER_REACHED_FLIGHT_SPEED',
  /** Rotor reached speed and collective never rose enough for long enough. */
  NO_LIFTOFF: 'NO_LIFTOFF_DETECTED',
  /** Nothing to measure. */
  NO_SAMPLES: 'NO_SAMPLES',
  NO_TIME: 'TIME_NOT_LOGGED'
});

/** Outcomes of `checkFlightWindow`. */
export const FlightWindowCheck = Object.freeze({
  OK: 'WINDOW_OK',
  /** Inside the log, but one or both ends were pulled back to the log's own. */
  CLAMPED: 'WINDOW_CLAMPED_TO_LOG',
  NOT_FINITE: 'WINDOW_NOT_FINITE',
  INVERTED: 'WINDOW_INVERTED',
  OUTSIDE_LOG: 'WINDOW_OUTSIDE_LOG',
  /** Fewer than two samples fall inside; nothing can be measured over it. */
  TOO_FEW_SAMPLES: 'WINDOW_TOO_FEW_SAMPLES'
});

// ---------------------------------------------------------------------------
// Column extraction
// ---------------------------------------------------------------------------

function indexByName(session) {
  const map = new Map();
  for (const field of session?.fields ?? []) {
    if (field && typeof field.name === 'string' && Number.isInteger(field.index)) {
      map.set(field.name, field.index);
    }
  }
  return map;
}

function resolveFirst(indexes, candidates) {
  for (const candidate of candidates) {
    const index = indexes.get(candidate);
    if (index !== undefined) {
      return {index, name: candidate};
    }
  }
  return null;
}

function numeric(value) {
  return Number.isFinite(value) ? value : Number.NaN;
}

/**
 * Accepts a decoded session, an already-built record array, or `{records}`.
 *
 * Records are the shape `buildAnalysisRecords` emits: `{timeUs, headspeed,
 * collective}`. Taking both means a caller that has already paid for records
 * does not decode a second time, and a caller holding only a session does not
 * have to build them.
 */
function extractColumns(input) {
  const records = Array.isArray(input) ? input : input?.records;

  if (Array.isArray(records)) {
    const count = records.length;
    const timeUs = new Float64Array(count);
    const headspeed = new Float64Array(count);
    const collective = new Float64Array(count);
    let sawHeadspeed = false;
    let sawCollective = false;

    for (let at = 0; at < count; at += 1) {
      const record = records[at];
      timeUs[at] = numeric(record?.timeUs);
      headspeed[at] = numeric(record?.headspeed);
      collective[at] = numeric(record?.collective);
      sawHeadspeed ||= Number.isFinite(headspeed[at]);
      sawCollective ||= Number.isFinite(collective[at]);
    }

    return {
      timeUs,
      headspeed: sawHeadspeed ? headspeed : null,
      collective: sawCollective ? collective : null,
      resolved: {
        time: count > 0 ? 'record.timeUs' : null,
        headspeed: sawHeadspeed ? 'record.headspeed' : null,
        collective: sawCollective ? 'record.collective' : null
      },
      source: 'records'
    };
  }

  const samples = input?.samples ?? [];
  const indexes = indexByName(input);
  const timeField = resolveFirst(indexes, TIME_FIELDS);
  const headspeedField = resolveFirst(indexes, HEADSPEED_FIELDS);
  const collectiveField = resolveFirst(indexes, COLLECTIVE_FIELDS);

  const column = field => {
    if (!field) {
      return null;
    }
    const out = new Float64Array(samples.length);
    for (let at = 0; at < samples.length; at += 1) {
      out[at] = numeric(samples[at]?.[field.index]);
    }
    return out;
  };

  return {
    timeUs: column(timeField) ?? new Float64Array(0),
    headspeed: column(headspeedField),
    collective: column(collectiveField),
    resolved: {
      time: timeField?.name ?? null,
      headspeed: headspeedField?.name ?? null,
      collective: collectiveField?.name ?? null
    },
    source: 'session'
  };
}

// ---------------------------------------------------------------------------
// Small statistics, written here rather than imported so this module stays
// standalone. Each sorts a copy; nothing mutates the caller's data.
// ---------------------------------------------------------------------------

/** Finite values of `column` over [from, to], sorted ascending. */
function sortedSlice(column, from, to) {
  const out = [];
  for (let at = from; at <= to; at += 1) {
    const value = column[at];
    if (Number.isFinite(value)) {
      out.push(value);
    }
  }
  out.sort((left, right) => left - right);
  return out;
}

/** Nearest-rank percentile of an already-sorted array. */
function percentileOf(sorted, fraction) {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(fraction * (sorted.length - 1)))
  );
  return sorted[rank];
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Earliest index from which `atSpeed` holds continuously for `holdUs`.
 *
 * Walks maximal runs where headspeed stays above the hold fraction, and inside
 * each run takes the first sample that also reaches the flight fraction and
 * still has `holdUs` of run left after it. Restarting at every dip is what
 * stops a single spike during spool-up from being read as "at speed".
 */
function firstSustainedAboveIndex(values, timeUs, enterLevel, holdLevel, holdUs) {
  let runStart = -1;
  let entered = -1;

  for (let at = 0; at < values.length; at += 1) {
    const value = values[at];
    const inRun = Number.isFinite(value) && value >= holdLevel;

    if (!inRun) {
      runStart = -1;
      entered = -1;
      continue;
    }

    if (runStart === -1) {
      runStart = at;
      entered = -1;
    }
    if (entered === -1 && value >= enterLevel) {
      entered = at;
    }
    if (entered !== -1 && Number.isFinite(timeUs[at]) && Number.isFinite(timeUs[entered])
        && timeUs[at] - timeUs[entered] >= holdUs) {
      return entered;
    }
  }

  return -1;
}

/** First index at or after `from` whose value is finite and >= `level`. */
function firstAtOrAbove(values, level, from) {
  for (let at = Math.max(0, from); at < values.length; at += 1) {
    if (Number.isFinite(values[at]) && values[at] >= level) {
      return at;
    }
  }
  return -1;
}

/**
 * Start index of the first run at or after `from` that stays at or above
 * `level` for at least `holdUs`.
 */
function firstRunAboveFor(values, timeUs, level, holdUs, from) {
  let runStart = -1;

  for (let at = Math.max(0, from); at < values.length; at += 1) {
    const value = values[at];
    if (!Number.isFinite(value) || value < level) {
      runStart = -1;
      continue;
    }
    if (runStart === -1) {
      runStart = at;
    }
    if (Number.isFinite(timeUs[at]) && Number.isFinite(timeUs[runStart])
        && timeUs[at] - timeUs[runStart] >= holdUs) {
      return runStart;
    }
  }

  return -1;
}

/** Last index whose value is finite and >= `level`. */
function lastAtOrAbove(values, level) {
  for (let at = values.length - 1; at >= 0; at -= 1) {
    if (Number.isFinite(values[at]) && values[at] >= level) {
      return at;
    }
  }
  return -1;
}

function emptyEnd(basis) {
  return Object.freeze({timeUs: null, sampleIndex: null, signal: null, basis, detail: null});
}

/**
 * The last type-52 airborne latch that is never cancelled, if the log has one.
 *
 * Corroboration only. It is reported next to the detected liftoff so a pilot
 * can see the firmware agreeing (10.9 ms apart on the reference log) or
 * disagreeing, and it never moves a boundary — see the rejected candidates at
 * the top of this file for what happens when it does.
 */
function airborneEventCorroboration(input, timeUs) {
  const events = Array.isArray(input) ? [] : input?.events ?? [];
  const latches = [];

  for (const event of events) {
    if (event?.event !== 'state' || event.eventType !== 52) {
      continue;
    }
    if (!Number.isInteger(event.sampleIndex)) {
      // Pre-fix decoders emitted a byte offset and no sample position, so the
      // event cannot be placed on the time axis at all. Say so rather than
      // inventing a placement.
      return {state: 'unplaceable', timeUs: null, transitions: null};
    }
    latches.push(event);
  }

  if (latches.length === 0) {
    return {state: 'absent', timeUs: null, transitions: 0};
  }

  let last = null;
  for (const event of latches) {
    last = event.state === 1 ? event : null;
  }

  if (last === null) {
    return {state: 'never-latched', timeUs: null, transitions: latches.length};
  }

  const at = Math.min(last.sampleIndex, timeUs.length - 1);
  const time = at >= 0 ? timeUs[at] : Number.NaN;

  return {
    state: 'latched',
    timeUs: Number.isFinite(time) ? time : null,
    transitions: latches.length
  };
}

/**
 * Detects the flight inside a recording.
 *
 * @param {object|object[]} input a decoded session, a record array, or `{records}`
 * @param {object} [options]
 * @param {{startUs: number, endUs: number}} [options.override] a caller-supplied
 *        window, used verbatim when it passes `checkFlightWindow`
 * @param {object} [options.constants] overrides for `FLIGHT_WINDOW_CONSTANTS`,
 *        for sensitivity testing
 * @returns {object} the window, its basis, and the evidence for each end
 */
export function detectFlightWindow(input, options = {}) {
  const constants = {...FLIGHT_WINDOW_CONSTANTS, ...options.constants};
  const columns = extractColumns(input);
  const {timeUs, headspeed, collective} = columns;
  const count = timeUs.length;

  const logStartUs = count > 0 && Number.isFinite(timeUs[0]) ? timeUs[0] : null;
  const logEndUs = count > 0 && Number.isFinite(timeUs[count - 1]) ? timeUs[count - 1] : null;

  const whole = basis => finish({
    basis,
    startUs: logStartUs,
    endUs: logEndUs,
    takeoff: emptyEnd(basis),
    landing: emptyEnd(basis),
    thresholds: null,
    marks: null
  });

  function finish(result) {
    const {startUs, endUs} = result;
    const durationUs = Number.isFinite(startUs) && Number.isFinite(endUs)
      ? endUs - startUs
      : null;
    const logDurationUs = Number.isFinite(logStartUs) && Number.isFinite(logEndUs)
      ? logEndUs - logStartUs
      : null;

    return Object.freeze({
      ...result,
      durationUs,
      logStartUs,
      logEndUs,
      logDurationUs,
      // 1 means "the window is the whole recording", which is what every
      // honest-failure basis returns. A caller can use it to decide whether the
      // trim is worth telling the pilot about.
      coverageRatio: logDurationUs && logDurationUs > 0 && Number.isFinite(durationUs)
        ? durationUs / logDurationUs
        : (logDurationUs === 0 ? 1 : null),
      trimmed: Number.isFinite(durationUs) && Number.isFinite(logDurationUs)
        && durationUs < logDurationUs,
      resolved: columns.resolved,
      inputSource: columns.source,
      sampleCount: count,
      corroboration: {
        airborneEvent: airborneEventCorroboration(input, timeUs),
        airborneEventAgreementUs: null
      }
    });
  }

  if (count === 0) {
    return whole(FlightWindowBasis.NO_SAMPLES);
  }
  if (logStartUs === null || logEndUs === null) {
    return whole(FlightWindowBasis.NO_TIME);
  }

  // A caller-supplied window short-circuits everything: the pilot dragged the
  // markers, and their window is not a hypothesis to be second-guessed. It is
  // still checked, and a window that cannot be measured over falls back to
  // detection rather than being handed on broken.
  if (options.override) {
    const check = checkFlightWindow(input, options.override);
    if (check.valid) {
      const supplied = {
        timeUs: check.startUs,
        sampleIndex: check.firstSampleIndex,
        signal: 'caller',
        basis: FlightWindowBasis.CALLER_SUPPLIED,
        detail: {check: check.code}
      };
      return finish({
        basis: FlightWindowBasis.CALLER_SUPPLIED,
        startUs: check.startUs,
        endUs: check.endUs,
        takeoff: Object.freeze(supplied),
        landing: Object.freeze({
          ...supplied,
          timeUs: check.endUs,
          sampleIndex: check.lastSampleIndex
        }),
        thresholds: null,
        marks: null,
        overrideCheck: check
      });
    }
    // Fall through to detection, carrying the rejection so the caller can say
    // why the window they passed was not honoured.
    const detected = detectFlightWindow(input, {...options, override: undefined});
    return Object.freeze({...detected, overrideCheck: check});
  }

  if (!headspeed) {
    return whole(FlightWindowBasis.NO_HEADSPEED);
  }

  const headspeedSorted = sortedSlice(headspeed, 0, count - 1);
  const medianHeadspeed = percentileOf(headspeedSorted, 0.5);
  const minHeadspeed = headspeedSorted.length > 0 ? headspeedSorted[0] : Number.NaN;

  if (!Number.isFinite(medianHeadspeed) || medianHeadspeed <= 0) {
    return whole(FlightWindowBasis.NO_ROTOR_START);
  }
  // The rotor must actually start inside the log. If the lowest headspeed in
  // the recording is already most of the median, the log opens with the head
  // turning and there is no ground segment to calibrate against — the
  // symmetric case to a log that ends in flight.
  if (minHeadspeed / medianHeadspeed > constants.spinRatioMax) {
    return whole(FlightWindowBasis.NO_ROTOR_START);
  }

  const spinIndex = firstAtOrAbove(headspeed, constants.spinStartFrac * medianHeadspeed, 0);
  const spooledIndex = firstSustainedAboveIndex(
    headspeed,
    timeUs,
    constants.flightSpeedFrac * medianHeadspeed,
    constants.holdFrac * medianHeadspeed,
    constants.spooledHoldUs
  );

  if (spinIndex === -1 || spooledIndex === -1 || spooledIndex <= spinIndex) {
    return whole(FlightWindowBasis.NO_ROTOR_AT_SPEED);
  }

  if (!collective) {
    return whole(FlightWindowBasis.NO_COLLECTIVE);
  }

  // Calibrate on [spin, spooled]: the rotor is turning but below flight speed
  // across all of it, so the machine is on the ground for all of it. This is
  // the step that makes the rule portable between logs whose collective is
  // centred on 0 and logs whose collective sits at 1200.
  const groundSorted = sortedSlice(collective, spinIndex, spooledIndex);
  const groundCollective = percentileOf(groundSorted, 0.5);
  const measuredSpread = percentileOf(groundSorted, 0.95) - percentileOf(groundSorted, 0.05);

  const fullSorted = sortedSlice(collective, 0, count - 1);
  const fullRange = percentileOf(fullSorted, 0.95) - percentileOf(fullSorted, 0.05);
  const spreadFloor = Number.isFinite(fullRange)
    ? constants.minSpreadFraction * Math.abs(fullRange)
    : 0;
  const groundSpread = Math.max(
    Number.isFinite(measuredSpread) ? measuredSpread : 0,
    Number.isFinite(spreadFloor) ? spreadFloor : 0
  );

  if (!Number.isFinite(groundCollective) || groundSpread <= 0) {
    // Flat everywhere: the column exists but carries no signal to threshold.
    return whole(FlightWindowBasis.NO_LIFTOFF);
  }

  const liftLevel = groundCollective + constants.liftMargin * groundSpread;
  const settleLevel = groundCollective + constants.settleMargin * groundSpread;

  const thresholds = Object.freeze({
    medianHeadspeed,
    flightSpeedRpm: constants.flightSpeedFrac * medianHeadspeed,
    groundCollective,
    groundSpread,
    groundSpreadWasFloored: groundSpread > (Number.isFinite(measuredSpread) ? measuredSpread : 0),
    liftLevel,
    settleLevel
  });
  const marks = Object.freeze({
    rotorSpinUs: timeUs[spinIndex],
    rotorAtSpeedUs: timeUs[spooledIndex],
    rotorSpinIndex: spinIndex,
    rotorAtSpeedIndex: spooledIndex
  });

  const liftIndex = firstRunAboveFor(
    collective, timeUs, liftLevel, constants.liftHoldUs, spooledIndex
  );

  if (liftIndex === -1) {
    return finish({
      basis: FlightWindowBasis.NO_LIFTOFF,
      startUs: logStartUs,
      endUs: logEndUs,
      takeoff: emptyEnd(FlightWindowBasis.NO_LIFTOFF),
      landing: emptyEnd(FlightWindowBasis.NO_LIFTOFF),
      thresholds,
      marks
    });
  }

  const takeoff = Object.freeze({
    timeUs: timeUs[liftIndex],
    sampleIndex: liftIndex,
    signal: 'collective-above-ground-with-rotor-at-speed',
    basis: FlightWindowBasis.DETECTED,
    detail: Object.freeze({
      collectiveField: columns.resolved.collective,
      headspeedField: columns.resolved.headspeed,
      liftLevel,
      groundCollective,
      groundSpread,
      heldForUs: constants.liftHoldUs,
      rotorAtSpeedUs: timeUs[spooledIndex]
    })
  });

  // Landing is the moment collective settles back to ground level FOR GOOD.
  //
  // Not "the last sample above the liftoff threshold": a descent passes down
  // through the whole band between the two levels, so the samples immediately
  // after the last flight-level one are still above the settle level and the
  // check would reject every landing there is. Written that way it declared
  // 2 967 of 3 000 generated flights to have ended in flight, including ones
  // that plainly land, which is how the mistake was found.
  //
  // The descent itself belongs INSIDE the window — the machine is flying all
  // the way down — so the boundary is the first sample after which collective
  // never returns to the settle level.
  const lastAboveSettle = lastAtOrAbove(collective, settleLevel);
  const landIndex = lastAboveSettle + 1;
  const landed = lastAboveSettle >= 0
    && landIndex < count
    && landIndex > liftIndex
    && Number.isFinite(timeUs[landIndex])
    && Number.isFinite(timeUs[count - 1])
    // The recording has to plainly outlive the flight. A log cut two samples
    // after the skids touch cannot tell a landing from a power cut, and the
    // reference log — cut by power-off with the rotor at 1707 rpm and
    // collective at +303 — is exactly the case that must not be given one.
    && timeUs[count - 1] - timeUs[landIndex] >= constants.settleHoldUs;

  const result = landed
    ? {
      basis: FlightWindowBasis.DETECTED,
      startUs: timeUs[liftIndex],
      endUs: timeUs[landIndex],
      takeoff,
      landing: Object.freeze({
        timeUs: timeUs[landIndex],
        sampleIndex: landIndex,
        signal: 'collective-returned-to-ground-and-stayed',
        basis: FlightWindowBasis.DETECTED,
        detail: Object.freeze({
          collectiveField: columns.resolved.collective,
          settleLevel,
          lastFlightCollectiveUs: timeUs[lastAboveSettle],
          settledForUs: timeUs[count - 1] - timeUs[landIndex]
        })
      }),
      thresholds,
      marks
    }
    : {
      basis: FlightWindowBasis.ENDED_IN_FLIGHT,
      startUs: timeUs[liftIndex],
      endUs: logEndUs,
      takeoff,
      landing: Object.freeze({
        timeUs: null,
        sampleIndex: null,
        signal: null,
        basis: FlightWindowBasis.ENDED_IN_FLIGHT,
        detail: Object.freeze({
          collectiveField: columns.resolved.collective,
          settleLevel,
          lastFlightCollectiveUs: lastAboveSettle >= 0 ? timeUs[lastAboveSettle] : null,
          settledForUs: lastAboveSettle >= 0 && landIndex < count
            ? timeUs[count - 1] - timeUs[landIndex]
            : 0
        })
      }),
      thresholds,
      marks
    };

  const finished = finish(result);
  const airborne = finished.corroboration.airborneEvent;

  return Object.freeze({
    ...finished,
    corroboration: Object.freeze({
      airborneEvent: airborne,
      // Signed: positive means the firmware latched airborne AFTER we say it
      // lifted. Reported, never acted on.
      airborneEventAgreementUs: airborne.state === 'latched' && airborne.timeUs !== null
        ? airborne.timeUs - result.startUs
        : null
    })
  });
}

/**
 * Validates a caller-supplied window against the log it will be measured over.
 *
 * Written for a UI with draggable ends, so it never throws and never rejects
 * something it can repair: a window that hangs off one end is clamped and
 * reported as clamped. `valid` answers only "can an analysis be run over this",
 * which needs at least two samples inside it.
 *
 * @param {object|object[]} input the same shapes `detectFlightWindow` takes
 * @param {{startUs: number, endUs: number}} window
 */
export function checkFlightWindow(input, window) {
  const {timeUs} = extractColumns(input);
  const count = timeUs.length;
  const logStartUs = count > 0 && Number.isFinite(timeUs[0]) ? timeUs[0] : null;
  const logEndUs = count > 0 && Number.isFinite(timeUs[count - 1]) ? timeUs[count - 1] : null;

  const reject = code => Object.freeze({
    valid: false,
    code,
    startUs: null,
    endUs: null,
    durationUs: null,
    firstSampleIndex: null,
    lastSampleIndex: null,
    sampleCount: 0,
    logStartUs,
    logEndUs,
    clamped: false
  });

  const requestedStart = Number(window?.startUs);
  const requestedEnd = Number(window?.endUs);

  if (!Number.isFinite(requestedStart) || !Number.isFinite(requestedEnd)) {
    return reject(FlightWindowCheck.NOT_FINITE);
  }
  if (requestedEnd <= requestedStart) {
    return reject(FlightWindowCheck.INVERTED);
  }
  if (logStartUs === null || logEndUs === null) {
    return reject(FlightWindowCheck.OUTSIDE_LOG);
  }
  if (requestedEnd < logStartUs || requestedStart > logEndUs) {
    return reject(FlightWindowCheck.OUTSIDE_LOG);
  }

  const startUs = Math.max(requestedStart, logStartUs);
  const endUs = Math.min(requestedEnd, logEndUs);
  const clamped = startUs !== requestedStart || endUs !== requestedEnd;

  let firstSampleIndex = -1;
  let lastSampleIndex = -1;
  let sampleCount = 0;
  for (let at = 0; at < count; at += 1) {
    const time = timeUs[at];
    if (!Number.isFinite(time) || time < startUs || time > endUs) {
      continue;
    }
    if (firstSampleIndex === -1) {
      firstSampleIndex = at;
    }
    lastSampleIndex = at;
    sampleCount += 1;
  }

  if (sampleCount < 2) {
    return Object.freeze({
      ...reject(FlightWindowCheck.TOO_FEW_SAMPLES),
      sampleCount,
      clamped
    });
  }

  return Object.freeze({
    valid: true,
    code: clamped ? FlightWindowCheck.CLAMPED : FlightWindowCheck.OK,
    startUs,
    endUs,
    durationUs: endUs - startUs,
    firstSampleIndex,
    lastSampleIndex,
    sampleCount,
    logStartUs,
    logEndUs,
    clamped
  });
}

/**
 * The window a UI should open on, with the pilot's override applied if there is
 * one. Thin on purpose: it exists so no caller has to reimplement the
 * "override wins, detection is the fallback" precedence and get it subtly
 * different from the next caller.
 */
export function resolveFlightWindow(input, options = {}) {
  return detectFlightWindow(input, options);
}
