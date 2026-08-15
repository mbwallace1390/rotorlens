/**
 * What must be TRUE before RotorLens tells a pilot to change a gain.
 *
 * ---------------------------------------------------------------------------
 * PRODUCT DECISION, 12 August 2026, by the owner (Michael Wallace)
 * ---------------------------------------------------------------------------
 * Until this date RotorLens reported measurements and never a recommendation.
 * The owner has reversed that: the app's purpose is to read the log a pilot
 * selects and recommend what to adjust, because "a lot of people have no clue
 * what they are looking at when they see all the info and graphs". That is
 * settled and this module does not relitigate it.
 *
 * What did NOT change, because it is engineering rather than product:
 *
 *   - A recommendation must be EARNED BY EVIDENCE. Where the evidence does not
 *     separate the candidate causes, the honest output is "here is what I can
 *     see, here is what to fly to settle it".
 *   - MECHANICAL FAULTS OUTRANK GAINS. A shaking airframe cannot be tuned.
 *   - ONE CHANGE AT A TIME, with the basis shown.
 *   - ROTORLENS NEVER WRITES TO A FLIGHT CONTROLLER.
 *   - Confident and wrong is worse than silent.
 *
 * So this module is the interlock, not the advice. It answers one question —
 * *may* a gain recommendation be emitted for this axis, from this log? — and
 * when the answer is no it supplies the sentence that says what to do instead.
 * It never names a gain, a direction, or a number, and it writes nothing.
 *
 * ---------------------------------------------------------------------------
 * THE FIVE GATES, AND WHY EACH ONE EXISTS
 * ---------------------------------------------------------------------------
 * All five must pass. They are ordered by how badly acting on a false pass
 * would hurt, and `evaluateGainRecommendationGates` reports every failure
 * rather than short-circuiting, because "and also your rotor was never checked"
 * is information a pilot needs even when a different gate spoke first.
 *
 *  1 AIRFRAME       the vibration finding that outranks every gain
 *  2 COMPLETENESS   enough stops, in both directions, to have a result at all
 *  3 AGREEMENT      left and right must be describing the same aircraft
 *  4 HEADSPEED      the stops being compared must be at one rotor speed
 *  5 STABILITY      the conclusion must survive this repo's own unconstrained
 *                   constants
 *
 * Every threshold below is either measured on a log in this repository, or
 * imported from a constant that already had a derivation. Where a number is a
 * judgement it says so in the same breath, and `GAIN_GATE_THRESHOLDS` publishes
 * the basis string beside the value so a caller is never left inferring one.
 *
 * Platform-neutral: Math, Number, Object, Array. No Buffer, no `node:*`, no
 * DOM, no dependency.
 */

import {
  AXES,
  DIRECTIONS,
  EVIDENCE_LIMITS,
  buildDirectionalStopEvidence,
  quantile,
  spanRatio
} from '../pid-evidence.mjs';
import {detectStopEvents, STOP_DETECTION_DEFAULTS} from '../records.mjs';

/* ------------------------------------------------------------- the sweep grid */

/**
 * The three constants `records.mjs` marks UNCONSTRAINED BY REAL DATA, swept
 * across the plausible range each of their own comments names.
 *
 * These are not a tuning knob. They exist so gate 5 can ask a question no
 * single run can answer: does the conclusion belong to the aircraft, or to a
 * number nobody in this project can defend?
 *
 * `plateauFraction`  — records.mjs says the SIGN of the yaw directional
 *   asymmetry changes across 0.5 → 1.0, so the grid spans exactly that.
 * `trackingWindowUs` — records.mjs sweeps 20 ms → 1000 ms and reports the warn
 *   threshold being crossed at 50, 500 and 1000 ms with the opposite direction
 *   named worse at the last two. 50 ms → 500 ms brackets the shipped 150 ms by
 *   more than 3x each way.
 * `fastWindowUs`     — the five windows records.mjs itself tried, over which it
 *   measured `fastRingingRmsDps` moving by a factor of 3.6.
 *
 * 9 x 6 x 5 = 270 combinations. Measured cost of all 270 on the reference log's
 * 134,429 records: 0.5 s on desktop Node, and 1.7 s for both logs, three axes
 * and two metrics — 12 full sweeps, 3,240 detector runs. It is cheap because
 * the detector is a single pass and the grid does not touch the gates that
 * decide how many candidates open.
 */
export const UNCONSTRAINED_SWEEP = Object.freeze({
  plateauFraction: Object.freeze([0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0]),
  trackingWindowUs: Object.freeze([50_000, 100_000, 150_000, 200_000, 250_000, 500_000]),
  fastWindowUs: Object.freeze([
    Object.freeze([10_000, 150_000]),
    Object.freeze([20_000, 200_000]),
    Object.freeze([20_000, 250_000]),
    Object.freeze([20_000, 400_000]),
    Object.freeze([50_000, 250_000])
  ])
});

/** Every combination the sweep visits, shipped defaults included. */
export function sweepCombinations(grid = UNCONSTRAINED_SWEEP) {
  const out = [];
  for (const plateauFraction of grid.plateauFraction) {
    for (const trackingWindowUs of grid.trackingWindowUs) {
      for (const fastWindowUs of grid.fastWindowUs) {
        out.push({plateauFraction, trackingWindowUs, fastWindowUs});
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------- the thresholds */

export const GAIN_GATE_THRESHOLDS = Object.freeze({
  /**
   * Capture states that may carry a gain recommendation.
   *
   * Exactly one of the five. `partial` is the dangerous one and it is excluded
   * on arithmetic, not on taste: with one stop per direction there is no
   * within-direction spread to compare the between-direction gap against, so a
   * single noisy event IS the result. Measured on the reference log — yaw is
   * `partial`, 1 stop each way, and its tracking asymmetry reads 0.2645 at the
   * shipped constants and anywhere from 0.0145 to 0.7500 across the sweep. The
   * same event, twelve percent under the warn threshold or two and a half times
   * over it, depending on a constant nobody derived.
   */
  admissibleCaptureStates: Object.freeze(['captured']),

  /**
   * Stops needed per direction. Imported, not restated: `EVIDENCE_LIMITS`
   * already owns this and a second copy would drift.
   */
  minimumStopsPerDirection: EVIDENCE_LIMITS.minimumStopsPerDirection,

  /**
   * Above this the two directions are not describing one aircraft.
   *
   * Imported from `EVIDENCE_LIMITS.directionalAsymmetryWarnRatio` (0.30), which
   * already gates `directionsComparable`. The gate here is the consequence
   * that was missing: an asymmetry that large is evidence of a MECHANICAL
   * difference between left and right — tail authority, a binding, a
   * head-speed dependence — and averaging the two into one gain change treats
   * the asymmetry as noise. It is the finding, not the input.
   */
  directionalAsymmetryWarnRatio: EVIDENCE_LIMITS.directionalAsymmetryWarnRatio,

  /**
   * Rotor-speed spread permitted across the stops being compared.
   *
   * Imported from `EVIDENCE_LIMITS.maximumHeadspeedVariationRatio` (0.05),
   * which this repository already applies to hold evidence and which had no
   * counterpart on stop evidence at all. Same physical claim, one definition.
   *
   * MEASURED OVER THE EVENTS, NOT THE LOG, and that distinction is the whole
   * gate. The reference log's whole-log headspeed spread is 0.62107 against the
   * mechanical module's 0.12 range gate — a number that would block everything
   * — while the two yaw stops it contains sit 4.46 s apart at a median of
   * 1829 rpm each, a between-direction ratio of 0.00000 and a worst
   * within-event span of 0.01586. A gate applied to the log would reject a
   * comparison the aircraft actually supports.
   */
  maximumHeadspeedVariationRatio: EVIDENCE_LIMITS.maximumHeadspeedVariationRatio,

  /**
   * Fraction of sweep combinations that must agree. UNANIMITY, deliberately.
   *
   * Not a judgement call dressed as one: the three constants are UNCONSTRAINED
   * BY REAL DATA, which means no combination in the grid — including the
   * shipped one — has a claim to being the right one. A majority rule would
   * therefore be counting votes among values that are all equally unjustified.
   * If the conclusion changes anywhere in the grid, the conclusion is a
   * property of the grid.
   */
  requiredSweepAgreementRatio: 1.0,

  /**
   * Share of the sweep that must have been able to MEASURE the thing being
   * agreed about, before unanimity among the rest means anything.
   *
   * ADDED 13 AUGUST 2026. `requiredSweepAgreementRatio` above governs the
   * combinations that produced an OPINION. This one governs how many did, and
   * it exists because the two were conflated: a combination whose window
   * contains nothing to measure was being counted as a combination that
   * disagreed. It is not. A null is silence, and silence is not a contrary
   * verdict — treating it as one lets a single over-narrow window veto every
   * finding the engine can reach.
   *
   * MEASURED, and this is why the gate is here rather than a bare "ignore the
   * nulls". Over 110 decoded sessions (one Bell 222UT reference log, 36 sessions
   * on an RDMS NEXUS_XR, 73 on a FRSK VANTAC_RF007 — of which 33 are actual
   * flights, the rest bench recordings), NINE axis-directions carried stop
   * events at all, and the share of evaluations that could measure the hold ran:
   *
   *   1.0000  1.0000  0.9815  0.9444  0.9074  0.8519  0.7778  0.6111  0.4444
   *
   * The two at 1.0000 are the reference Bell's yaw, both directions, where
   * nothing was silent and the veto is genuine disagreement about WHERE the
   * oscillation lives. An earlier draft of this comment said eight and listed
   * one 1.0000; recounted 13 August 2026 by walking the grid directly.
   *
   * NOTE ON THE DENOMINATOR, because the number and its name agree less neatly
   * than the prose above suggests: the counter increments once per stop event
   * per judgement combination, not once per detector combination, so this share
   * is evaluation-weighted rather than a plain fraction of the 270-point
   * detector grid. Every case in the list has a uniform event count per
   * direction, so on this corpus the two are numerically identical and it cannot
   * distinguish them. A flight whose stops were unevenly spread across the grid
   * would separate them; this corpus contains none, so which of the two the gate
   * ought to measure is not yet settled by evidence.
   *
   * The last of those is a flight where more of the grid could NOT see a hold
   * than could. A conclusion drawn there would be the property of a minority of
   * windows, which is the same defect one level down. So the rule is: a
   * conclusion needs a majority of the grid to have had an opinion.
   *
   * A HALF IS NOT CALIBRATED TO THAT LIST — it is the point at which the
   * windows that could see a hold outnumber the windows that could not, which
   * is a statement about meaning rather than about this corpus. Its cost on the
   * corpus is one axis-direction (0.4444), and that one is classified
   * `not-stopped` with zero events the other way, so it could carry no gain
   * finding under any rule.
   */
  requiredSweepOpinionShare: 0.5,

  /**
   * The rotor must have been compared against, not merely not-found.
   *
   * This is the airframe gate's real content and it is the one threshold here
   * that is a NEW requirement rather than an imported one. See
   * `evaluateAirframeGate`.
   */
  requireHarmonicCorrelationEvaluated: true
});

/* ------------------------------------------------------------------- utilities */

function frozen(value) {
  return Object.freeze(value);
}

function finite(values) {
  return values.filter(Number.isFinite);
}

/** Which direction the metric is larger in, or null when it cannot be said. */
function worseDirection(positive, negative) {
  if (!Number.isFinite(positive) || !Number.isFinite(negative)) {
    return null;
  }
  if (Math.abs(positive) === Math.abs(negative)) {
    return 'equal';
  }
  return Math.abs(positive) > Math.abs(negative) ? 'positive' : 'negative';
}

/* ------------------------------------------------------------------ gate 1: airframe */

/**
 * Whether the airframe has been ruled out as the source of what was measured.
 *
 * A tracking fault, a worn damper, a dry bearing and a loose head all produce
 * gyro content that looks like a badly tuned D term. Advising a gain change on
 * a shaking airframe leaves the aircraft exactly as unairworthy while looking
 * like progress, so the airframe is ruled out first or nothing is said.
 *
 * `mechanical-spectrum.mjs` already publishes a `tuningEvidenceGate` and it is
 * NECESSARY BUT NOT SUFFICIENT. It is `permitted` on a `clear` status, and
 * `clear` means "no persistent narrowband energy reached the 8 deg/s attention
 * threshold". What it does not mean, and what nothing downstream could see, is
 * that the rotor was ever compared against.
 *
 * MEASURED, and this is the finding this module exists for. Sweeping 42
 * (start, duration) ranges across the reference log, `tuningEvidenceGate` reads
 * `permitted` on 42 of 42 — it has never once fired on the only real log this
 * project owns, which makes it a constant rather than a gate on that data. On
 * 17 of those 42 the rotor was NEVER COMPARED: `harmonicCorrelation.state` is
 * `unavailable` because the headspeed is not stationary enough to correlate,
 * with relative spreads up to 1.34286 over the spool-up. The whole-log range is
 * one of the 17. So the naive reading — "clear, therefore go ahead" — is
 * available on exactly the ranges where the rotor could not be checked, which
 * is the failure mode this gate is supposed to prevent.
 *
 * The added requirement is `harmonicCorrelation.state === 'evaluated'`: a rotor
 * speed trustworthy enough that each peak could be tested against its orders.
 * Then "not a rotor harmonic" is a measurement, and "clear" means something.
 *
 * @param {object} mechanical a result from `analyzeMechanicalSpectrum`
 * @param {object} [options] `{eventTimesUs, holdTimesUs}` — the stop and hold
 *   times a recommendation would rest on, so the analysed range can be checked
 *   to actually contain them. A `clear` measured over a different hundred
 *   seconds is not evidence about the seconds in question.
 */
export function evaluateAirframeGate(mechanical, options = {}) {
  const codes = [];

  if (!mechanical || typeof mechanical !== 'object') {
    return frozen({
      gate: 'airframe',
      status: 'blocked',
      codes: frozen(['MECHANICAL_ANALYSIS_ABSENT']),
      measured: frozen({})
    });
  }

  const upstream = mechanical.tuningEvidenceGate?.status ?? null;
  if (upstream !== 'permitted') {
    codes.push('MECHANICAL_EVIDENCE_GATE_BLOCKED');
  }

  const correlation = mechanical.harmonicCorrelation?.state ?? null;
  if (GAIN_GATE_THRESHOLDS.requireHarmonicCorrelationEvaluated
      && correlation !== 'evaluated') {
    // The distinction the whole gate turns on: "no rotor harmonic explains this
    // peak" and "no rotor speed was steady enough to ask" are opposite facts
    // and one null used to carry both.
    codes.push(correlation === 'not-evaluated'
      ? 'ROTOR_CORRELATION_NOT_ATTEMPTED'
      : 'ROTOR_CORRELATION_UNAVAILABLE');
  }

  const eventTimesUs = finite(options.eventTimesUs ?? []);
  const holdTimesUs = finite(options.holdTimesUs ?? []);
  const start = mechanical.range?.startTimeUs ?? null;
  const end = mechanical.range?.endTimeUs ?? null;
  let containsEvents = null;
  if (eventTimesUs.length > 0) {
    containsEvents = Number.isFinite(start) && Number.isFinite(end)
      && eventTimesUs.every(timeUs => timeUs >= start && timeUs <= end);
    if (!containsEvents) {
      codes.push('MECHANICAL_RANGE_EXCLUDES_EVENTS');
    }
  }
  let containsHolds = null;
  if (holdTimesUs.length > 0) {
    containsHolds = Number.isFinite(start) && Number.isFinite(end)
      && holdTimesUs.every(timeUs => timeUs >= start && timeUs <= end);
    if (!containsHolds) {
      codes.push('MECHANICAL_RANGE_EXCLUDES_HOLDS');
    }
  }

  return frozen({
    gate: 'airframe',
    status: codes.length === 0 ? 'permitted' : 'blocked',
    codes: frozen(codes),
    measured: frozen({
      mechanicalStatus: mechanical.status ?? null,
      upstreamGate: upstream,
      harmonicCorrelationState: correlation,
      headspeedRelativeSpread: mechanical.rpmEvidence?.headspeed?.relativeSpread ?? null,
      headspeedState: mechanical.rpmEvidence?.headspeed?.state ?? null,
      attentionThresholdDps: mechanical.attentionThreshold?.bandRmsDps ?? null,
      attentionThresholdBasis: mechanical.attentionThreshold?.basis ?? null,
      rangeStartTimeUs: start,
      rangeEndTimeUs: end,
      eventCount: eventTimesUs.length,
      rangeContainsEvents: containsEvents,
      holdBoundaryCount: holdTimesUs.length,
      rangeContainsHolds: containsHolds
    })
  });
}

/* -------------------------------------------------------- gate 2: completeness */

/**
 * Whether the capture is complete enough for a recommendation to rest on.
 *
 * `describeStopCapture` grades a capture as captured / partial / rejected /
 * absent / unavailable. Only `captured` may carry one.
 *
 * `partial` is the one worth arguing about and the arithmetic settles it. With
 * one stop per direction the between-direction difference has no within-
 * direction spread to be judged against, so there is no way to tell a real
 * asymmetry from one noisy release. Measured on the reference log: yaw is
 * `partial` at 1 and 1, and across the 270-combination sweep of the
 * unconstrained constants its tracking asymmetry runs 0.0145 to 0.7500 and
 * crosses the 0.30 warn threshold in 125 of 270. One event per side is not a
 * measurement with error bars; it is a measurement with no error bars.
 *
 * @param {object} capture from `describeStopCapture`
 */
export function evaluateCompletenessGate(capture) {
  const codes = [];
  const state = capture?.state ?? null;
  const needed = GAIN_GATE_THRESHOLDS.minimumStopsPerDirection;
  const positive = capture?.captured?.positive ?? 0;
  const negative = capture?.captured?.negative ?? 0;

  if (!GAIN_GATE_THRESHOLDS.admissibleCaptureStates.includes(state)) {
    codes.push(`CAPTURE_STATE_${String(state ?? 'MISSING').toUpperCase()}`);
  }
  if (positive < needed || negative < needed) {
    codes.push('INSUFFICIENT_STOPS_PER_DIRECTION');
  }

  return frozen({
    gate: 'completeness',
    status: codes.length === 0 ? 'permitted' : 'blocked',
    codes: frozen(codes),
    measured: frozen({
      captureState: state,
      positiveStops: positive,
      negativeStops: negative,
      requiredPerDirection: needed
    })
  });
}

/* ------------------------------------------------------------ gate 3: agreement */

/**
 * Whether left and right are describing the same aircraft.
 *
 * When the two directions disagree about how the axis behaves, that is evidence
 * of a MECHANICAL asymmetry or of an insufficient sample. It is not a reason to
 * average them: the average describes neither direction, and a gain moved to
 * split the difference makes the better direction worse without fixing the
 * worse one. On yaw the usual cause is tail authority or head-speed dependence,
 * and no gain change addresses either.
 *
 * Three ways to fail, because they call for three different sentences:
 *
 *   DISAGREE    the relative gap exceeds the 0.30 warn ratio AND is larger than
 *               the scatter between the individual stops that produced it. A
 *               resolved asymmetry, and a finding in its own right: the
 *               recommendation becomes "look at the tail", not "change a gain".
 *   UNRESOLVED  the gap exceeds the warn ratio but is NOT larger than the
 *               within-direction scatter, so the apparent asymmetry is not
 *               separated from the noise. Needs more stops, not a verdict.
 *   SCATTER     the individual stops within a direction differ from each other
 *               by more than the warn ratio itself. Then neither "they agree"
 *               nor "they differ" is supportable, because a resample could
 *               produce either. Evaluated whatever the between-direction ratio
 *               reads, which is the case a gate looking only at the ratio
 *               misses.
 *
 * The directions agreeing is NOT a failure. A relative gap inside the warn
 * ratio, with tight stops behind it, is exactly the state in which one number
 * describes both directions and a single change can be reasoned about.
 *
 * MEASURED. Reference log, yaw, shipped constants: tracking asymmetry 0.2645,
 * under the threshold — but from 1 stop each way, so gate 2 has already
 * blocked, and across the sweep the same pair reads over the threshold in 125
 * of 270 combinations. Stop fixture, at 2 stops each way: roll 0.6489 and yaw
 * 0.7486 both trip the gate (the fixture has a deliberate 2.8x directional
 * asymmetry built in and this is it being caught), pitch reads 0.0219 and
 * passes. So the gate fires on 2 of the 3 axes that reach it, which is the
 * point — an asymmetric aircraft is the common case, not the exception.
 *
 * @param {object} evidence from `buildDirectionalStopEvidence`
 * @param {string} metric the directional metric a recommendation would rest on
 * @param {object[]} [events] the raw stop events, for the within-direction
 *   spread. Omitted, UNRESOLVED cannot be evaluated and says so.
 */
export function evaluateAgreementGate(evidence, metric, events = null) {
  const codes = [];
  const ratio = evidence?.asymmetry?.[metric] ?? null;
  const positive = evidence?.directions?.positive?.[metric] ?? null;
  const negative = evidence?.directions?.negative?.[metric] ?? null;

  const warn = GAIN_GATE_THRESHOLDS.directionalAsymmetryWarnRatio;

  // Within-direction spread, so a between-direction gap can be judged against
  // the scatter that produced it rather than taken at face value.
  let separation = null;
  let widestWithinDirection = null;
  let scatterRatio = null;
  if (Array.isArray(events) && events.length > 0) {
    const spans = DIRECTIONS
      .map(direction => {
        const values = finite(events
          .filter(event => event?.commandSign === direction)
          .map(event => event?.[metric]));
        return values.length < 2 ? null : Math.max(...values) - Math.min(...values);
      })
      .filter(Number.isFinite);
    if (spans.length === DIRECTIONS.length
        && Number.isFinite(positive) && Number.isFinite(negative)) {
      widestWithinDirection = Math.max(...spans);
      separation = Math.abs(Math.abs(positive) - Math.abs(negative));
      const largest = Math.max(Math.abs(positive), Math.abs(negative));
      scatterRatio = largest === 0 ? null : widestWithinDirection / largest;
    }
  }

  if (!Number.isFinite(ratio)) {
    codes.push('ASYMMETRY_NOT_MEASURABLE');
  } else if (ratio > warn) {
    // Resolved asymmetry, or an apparent one the sample cannot support. The
    // second is not a weaker version of the first: it calls for more stops,
    // where the first calls for looking at the aircraft.
    codes.push(
      separation !== null && separation <= widestWithinDirection
        ? 'DIRECTIONS_UNRESOLVED'
        : 'DIRECTIONS_DISAGREE'
    );
  }

  // Evaluated whether or not the between-direction ratio tripped, because this
  // is the case a gate reading only that ratio cannot see: stops that differ
  // from each other, within one direction, by more than the amount that would
  // have counted as the two directions differing. Then "they agree" is as
  // unsupported as "they differ" — a resample could produce either — and the
  // 0.30 reading is a coin toss with a decimal point on it.
  if (Number.isFinite(scatterRatio) && scatterRatio > warn) {
    codes.push('STOP_SCATTER_EXCEEDS_ASYMMETRY_LIMIT');
  }

  return frozen({
    gate: 'agreement',
    status: codes.length === 0 ? 'permitted' : 'blocked',
    codes: frozen(codes),
    measured: frozen({
      metric,
      asymmetryRatio: ratio,
      warnRatio: GAIN_GATE_THRESHOLDS.directionalAsymmetryWarnRatio,
      positive,
      negative,
      worseDirection: worseDirection(positive, negative),
      betweenDirectionSeparation: separation,
      widestWithinDirectionSpan: widestWithinDirection,
      withinDirectionScatterRatio: scatterRatio
    })
  });
}

/* ------------------------------------------------------------- gate 4: headspeed */

/**
 * Whether the stops being compared happened at one rotor speed.
 *
 * Gains behave differently at different head speeds: aerodynamic damping, servo
 * authority and the whole rate loop's effective gain all move with it, so two
 * stops at different head speeds are two different aircraft and their
 * difference is not a tuning result.
 *
 * MEASURED AT EVENT LEVEL, and that is not the same question the mechanical
 * module asks. `mechanical-spectrum.mjs` gates a spectral RANGE at 0.12
 * relative spread because a spectrum smears across whatever the rotor did
 * during it. A stop comparison does not: it is four windows of about a second
 * each, and what matters is that those windows sit at one speed.
 *
 * Reference log, yaw, the two stops 4.46 s apart:
 *   positive stop  median 1829.0 rpm, within-event span ratio 0.01586 worst
 *   negative stop  median 1829.0 rpm
 *   between-direction ratio 0.00000
 * against a whole-log spread of 0.62107. The log-level number would have
 * blocked a comparison the aircraft plainly supports; the event-level number
 * passes comfortably.
 *
 * Stop fixture, all three axes: between-direction ratios 0.00098 / 0.00000 /
 * 0.00024, worst within-event span ratio 0.01760. Passes.
 *
 * So this gate passes on both logs, and it is still worth having: it is the
 * only thing standing between a governor-sag flight and a confident gain
 * change, and neither log in this repository contains one.
 *
 * @param {object[]} events stop events carrying `headspeedRpm`
 * @param {object} [options] `{records}` to measure the within-event span from
 *   the samples rather than trusting the event's own mean
 */
export function evaluateHeadspeedGate(events, options = {}) {
  const codes = [];
  const limit = GAIN_GATE_THRESHOLDS.maximumHeadspeedVariationRatio;
  const maximumSampleGapUs = Number.isFinite(options.maximumSampleGapUs)
    && options.maximumSampleGapUs > 0
    ? options.maximumSampleGapUs
    : EVIDENCE_LIMITS.maximumHoldSampleGapUs;
  const usable = (Array.isArray(events) ? events : [])
    .filter(event => DIRECTIONS.includes(event?.commandSign));

  // Filtering missing values out made half-populated evidence look complete.
  // Every stop admitted to the comparison must carry a finite, positive rotor
  // speed; absence is a blocker, not a smaller sample.
  const missingEventHeadspeed = usable.filter(event =>
    !Number.isFinite(event?.headspeedRpm) || !(event.headspeedRpm > 0)).length;
  if (missingEventHeadspeed > 0) {
    codes.push('HEADSPEED_EVIDENCE_INCOMPLETE');
  }

  const byDirection = {};
  for (const direction of DIRECTIONS) {
    byDirection[direction] = finite(usable
      .filter(event => event?.commandSign === direction)
      .map(event => event?.headspeedRpm));
  }

  if (byDirection.positive.length === 0 || byDirection.negative.length === 0) {
    return frozen({
      gate: 'headspeed',
      status: 'blocked',
      codes: frozen([...codes, 'HEADSPEED_NOT_MEASURABLE']),
      measured: frozen({limit})
    });
  }

  const positiveMedian = quantile(byDirection.positive, 0.5);
  const negativeMedian = quantile(byDirection.negative, 0.5);
  const betweenDirectionRatio = Math.abs(positiveMedian - negativeMedian)
    / Math.max(Math.abs(positiveMedian), Math.abs(negativeMedian));

  const all = [...byDirection.positive, ...byDirection.negative];
  const acrossEventsRatio = spanRatio(all, quantile(all, 0.5));

  if (!(betweenDirectionRatio <= limit)) {
    codes.push('HEADSPEED_DIFFERS_BETWEEN_DIRECTIONS');
  }
  if (!(Number.isFinite(acrossEventsRatio) && acrossEventsRatio <= limit)) {
    codes.push('HEADSPEED_UNSTABLE_ACROSS_EVENTS');
  }

  // Within-event span, from the records when a caller supplies them. An event's
  // `headspeedRpm` is a MEAN over the tracking window, and a mean is exactly
  // what a governor sag hides in.
  let worstWithinEventRatio = null;
  let incompleteEventWindows = 0;
  const records = options.records;
  if (Array.isArray(records) && records.length > 0) {
    for (const event of usable) {
      if (!DIRECTIONS.includes(event?.commandSign)) {
        continue;
      }
      const from = event.stopTimeUs - (event.commandDurationUs ?? 0);
      const to = event.stopTimeUs + (options.responseWindowUs ?? 1_000_000);
      const windowRecords = records
        .filter(record => record.timeUs >= from && record.timeUs <= to);
      const window = windowRecords.map(record => record.headspeed);
      const coversWindow = windowRecords.length >= 2
        && Number.isFinite(windowRecords[0]?.timeUs)
        && windowRecords[0].timeUs - from <= maximumSampleGapUs
        && Number.isFinite(windowRecords.at(-1)?.timeUs)
        && to - windowRecords.at(-1).timeUs <= maximumSampleGapUs
        && windowRecords.every((record, index) => index === 0
          || (record.timeUs - windowRecords[index - 1].timeUs > 0
            && record.timeUs - windowRecords[index - 1].timeUs <= maximumSampleGapUs));
      if (!coversWindow
          || window.some(value => !Number.isFinite(value) || !(value > 0))) {
        incompleteEventWindows += 1;
        continue;
      }
      const ratio = spanRatio(window, quantile(window, 0.5));
      if (Number.isFinite(ratio)) {
        worstWithinEventRatio = worstWithinEventRatio === null
          ? ratio : Math.max(worstWithinEventRatio, ratio);
      }
    }
    if (Number.isFinite(worstWithinEventRatio) && worstWithinEventRatio > limit) {
      codes.push('HEADSPEED_UNSTABLE_WITHIN_EVENT');
    }
    if (incompleteEventWindows > 0) {
      if (!codes.includes('HEADSPEED_EVIDENCE_INCOMPLETE')) {
        codes.push('HEADSPEED_EVIDENCE_INCOMPLETE');
      }
    }
  }

  return frozen({
    gate: 'headspeed',
    status: codes.length === 0 ? 'permitted' : 'blocked',
    codes: frozen(codes),
    measured: frozen({
      limit,
      positiveMedianRpm: positiveMedian,
      negativeMedianRpm: negativeMedian,
      betweenDirectionRatio,
      acrossEventsRatio,
      worstWithinEventRatio,
      maximumSampleGapUs,
      eventCount: usable.length,
      missingEventHeadspeedCount: missingEventHeadspeed,
      incompleteEventWindowCount: incompleteEventWindows
    })
  });
}

/* ------------------------------------------------------------- gate 5: stability */

/**
 * Re-derives the directional conclusion at every point in the sweep grid.
 *
 * THE MOST IMPORTANT GATE. `records.mjs` marks `plateauFraction`,
 * `trackingWindowUs` and `fastWindowUs` UNCONSTRAINED BY REAL DATA, and each of
 * them individually flips the sign of the yaw directional asymmetry as it
 * sweeps across plausible values. A recommendation whose DIRECTION depends on
 * an arbitrary internal constant is not a recommendation, it is that constant
 * being read aloud.
 *
 * The conclusion is characterised by two things, and both must be unanimous:
 *   - which direction the metric is worse in
 *   - which side of the 0.30 warn ratio the asymmetry falls on
 *
 * @param {object[]} records the record contract from `pid-evidence.mjs`
 * @param {string} axis
 * @param {string} metric the directional metric under test
 * @param {object} [options] `{grid, detectOptions}`
 */
export function sweepDirectionalConclusion(records, axis, metric, options = {}) {
  const grid = options.grid ?? UNCONSTRAINED_SWEEP;
  const combinations = sweepCombinations(grid);
  const outcomes = [];

  for (const combination of combinations) {
    const events = detectStopEvents(records, {
      ...(options.detectOptions ?? {}),
      axis,
      plateauFraction: combination.plateauFraction,
      trackingWindowUs: combination.trackingWindowUs,
      fastWindowUs: combination.fastWindowUs
    });
    const evidence = buildDirectionalStopEvidence(events, {axis});
    const positive = evidence.directions.positive?.[metric] ?? null;
    const negative = evidence.directions.negative?.[metric] ?? null;
    const ratio = evidence.asymmetry?.[metric] ?? null;
    outcomes.push({
      ...combination,
      positiveStops: evidence.directions.positive?.directionEventCount ?? 0,
      negativeStops: evidence.directions.negative?.directionEventCount ?? 0,
      captureStatus: evidence.status,
      positive,
      negative,
      asymmetryRatio: ratio,
      worse: worseDirection(positive, negative),
      overWarnRatio: Number.isFinite(ratio)
        ? ratio > GAIN_GATE_THRESHOLDS.directionalAsymmetryWarnRatio
        : null
    });
  }

  return frozen({
    axis,
    metric,
    combinationCount: combinations.length,
    outcomes: frozen(outcomes)
  });
}

/**
 * Whether the conclusion survived the sweep.
 *
 * MEASURED, and this is the single most important number in this module.
 *
 * REFERENCE LOG, yaw, `trackingRmsDps` (the P-term metric):
 *   270 combinations, all yielding 1 stop each way
 *   worse direction: positive in 75, negative in 195     -> DOES NOT SURVIVE
 *   over the 0.30 warn ratio: 125 of 270                 -> DOES NOT SURVIVE
 *   asymmetry ratio ranges 0.0145 to 0.7500, a factor of 52
 *   and each constant flips it alone: at plateauFraction 0.8 and 0.85 the
 *   positive direction is worse in 20 of 30, at 0.5/0.6/0.7/0.75/1.0 the
 *   negative direction is worse in 30 of 30.
 *
 * REFERENCE LOG, yaw, `fastRingingRmsDps` (the D-term metric):
 *   worse direction: negative in 270 of 270              -> SURVIVES
 *   over the warn ratio: 270 of 270, range 0.5483–0.8260 -> SURVIVES
 *   This is the only conclusion in the reference log that survives the sweep,
 *   and gate 2 blocks it anyway: it rests on one stop per direction.
 *
 * STOP FIXTURE, all three axes, both metrics:
 *   270 of 270 unanimous on direction and on the threshold, every time.
 *   Asymmetry ranges are tight — roll tracking 0.6432–0.6560, yaw tracking
 *   0.7453–0.7520 — because the fixture's 2.8x asymmetry is far larger than
 *   anything the constants move. It SURVIVES, and gate 1 blocks it: the
 *   fixture logs `gyroADC`, so there is no unfiltered gyro to rule the airframe
 *   out with, and the mechanical analysis returns `insufficient` on all 35
 *   ranges tried.
 *
 * NET RESULT ON THE TWO LOGS THIS REPOSITORY HAS: not one gain recommendation
 * is earned. The reference log fails completeness and stability; the fixture
 * fails the airframe gate. That is the correct outcome for both — neither log
 * was flown for tuning — and it is why gate 6, the wording, is not a
 * consolation prize but the entire user-visible product on this data.
 */
export function evaluateStabilityGate(sweep) {
  const codes = [];
  const outcomes = sweep?.outcomes ?? [];

  if (outcomes.length === 0) {
    return frozen({
      gate: 'stability',
      status: 'blocked',
      codes: frozen(['SWEEP_NOT_RUN']),
      measured: frozen({})
    });
  }

  const evaluable = outcomes.filter(outcome =>
    outcome.worse !== null && outcome.overWarnRatio !== null);
  const directions = new Set(evaluable.map(outcome => outcome.worse));
  const verdicts = new Set(evaluable.map(outcome => outcome.overWarnRatio));

  const captureShortfall = outcomes.filter(outcome =>
    outcome.positiveStops < GAIN_GATE_THRESHOLDS.minimumStopsPerDirection
    || outcome.negativeStops < GAIN_GATE_THRESHOLDS.minimumStopsPerDirection).length;

  const directionAgreementRatio = evaluable.length === 0
    ? 0
    : Math.max(...[...directions].map(direction =>
      evaluable.filter(outcome => outcome.worse === direction).length)) / evaluable.length;
  const verdictAgreementRatio = evaluable.length === 0
    ? 0
    : Math.max(...[...verdicts].map(verdict =>
      evaluable.filter(outcome => outcome.overWarnRatio === verdict).length)) / evaluable.length;

  const required = GAIN_GATE_THRESHOLDS.requiredSweepAgreementRatio;

  if (evaluable.length < outcomes.length) {
    codes.push('SWEEP_INCOMPLETE');
  }
  if (!(directionAgreementRatio >= required)) {
    codes.push('SWEEP_FLIPS_DIRECTION');
  }
  if (!(verdictAgreementRatio >= required)) {
    codes.push('SWEEP_FLIPS_THRESHOLD_VERDICT');
  }
  if (captureShortfall > 0) {
    codes.push('SWEEP_LOSES_CAPTURE');
  }

  const ratios = finite(evaluable.map(outcome => outcome.asymmetryRatio));

  return frozen({
    gate: 'stability',
    status: codes.length === 0 ? 'permitted' : 'blocked',
    codes: frozen(codes),
    measured: frozen({
      combinationCount: outcomes.length,
      evaluableCount: evaluable.length,
      directionAgreementRatio,
      verdictAgreementRatio,
      requiredAgreementRatio: required,
      directionsSeen: frozen([...directions]),
      captureShortfallCount: captureShortfall,
      asymmetryRatioMinimum: ratios.length ? Math.min(...ratios) : null,
      asymmetryRatioMaximum: ratios.length ? Math.max(...ratios) : null
    })
  });
}

/* ---------------------------------------------------------- gate 6: the wording */

/**
 * What the app says when a gate blocks advice.
 *
 * "Cannot tell you" is useless. Every sentence here names the measurement that
 * blocked, in the pilot's own terms, and ends with something he can do — either
 * a different range of the same log, a different flight, or a different part of
 * the aircraft to look at. None of them is a tuning instruction and none of
 * them asks him to change a setting.
 *
 * `{n}`-style placeholders are filled by `describeGateBlock` from the gate's
 * own `measured` block, so a sentence cannot state a number the gate did not
 * measure.
 */
export const GATE_WORDING = Object.freeze({
  MECHANICAL_ANALYSIS_ABSENT:
    'The vibration check has not been run on this range, and a gain is not worth '
    + 'discussing until the airframe is ruled out. Select a range and run it first.',

  MECHANICAL_EVIDENCE_GATE_BLOCKED:
    'This range shows vibration that has to be explained before any gain is worth '
    + 'changing. A tracking fault, a worn damper or a dry bearing all look like a '
    + 'badly tuned D term in the gyro trace, and moving a gain to chase one leaves '
    + 'the aircraft exactly as it was. Sort the airframe first.',

  ROTOR_CORRELATION_UNAVAILABLE:
    'The head speed moved too much across this range for the vibration to be '
    + 'matched against the rotor, so "no rotor problem found" is not something '
    + 'this flight can support — nothing was compared. Select a range where the '
    + 'head speed is steady, after the spool-up and before the descent, and run '
    + 'the vibration check on that.',

  ROTOR_CORRELATION_NOT_ATTEMPTED:
    'The rotor speed was never compared against the vibration on this range, so '
    + 'the airframe has not been ruled out. Run the vibration check over a range '
    + 'that carries a steady head speed.',

  MECHANICAL_RANGE_EXCLUDES_EVENTS:
    'The vibration check covered a different part of this flight from the stops '
    + 'being measured. Run it over a range that contains them, so the airframe is '
    + 'ruled out for the seconds the measurement actually came from.',

  MECHANICAL_RANGE_EXCLUDES_HOLDS:
    'The vibration check covered a different part of this flight from the steady '
    + 'holds being measured. Run it over a range that contains every hold used for '
    + 'I-term evidence before changing that gain.',

  CAPTURE_STATE_PARTIAL:
    'This flight caught some stops but not enough of them. Two clean stops in each '
    + 'direction are needed before left and right can be compared, and with fewer '
    + 'than that one untidy release is the whole result. Fly the manoeuvre a few '
    + 'more times, each way, and this becomes answerable.',

  CAPTURE_STATE_REJECTED:
    'This flight has commands big enough to measure, and none of the releases were '
    + 'clean enough to use. Usually that is the stick moving again before the '
    + 'aircraft settled. Hold the command steady, release it to centre in one '
    + 'movement, then keep hands off for a full second.',

  CAPTURE_STATE_ABSENT:
    'Nothing in this flight is a stop. Nothing is wrong with the aircraft — the '
    + 'manoeuvre simply is not in this log. To record one: hold a firm command on '
    + 'that axis for about a second and a half, release the stick to centre in one '
    + 'movement, and keep hands off for a full second afterwards. Do that twice in '
    + 'each direction.',

  CAPTURE_STATE_UNAVAILABLE:
    'This axis is not in the log. Flying again will not add it: the Blackbox field '
    + 'set has to include it before there is anything to measure.',

  INSUFFICIENT_STOPS_PER_DIRECTION:
    'There are not yet two clean stops in each direction, so a difference between '
    + 'left and right cannot be told apart from one noisy release.',

  DIRECTIONS_DISAGREE:
    'This axis behaves differently one way from the other, by more than a gain '
    + 'change would explain. That is a mechanical difference — on the tail it is '
    + 'usually authority running out on one side, or head-speed dependence — and '
    + 'moving a gain would split the difference between two directions instead of '
    + 'fixing either. Look at the tail and the linkage before the gains.',

  DIRECTIONS_UNRESOLVED:
    'This axis looks different one way from the other, and the difference is no '
    + 'bigger than the scatter between the individual stops that produced it — so '
    + 'it is not yet a real difference. Fly two or three more stops each way and '
    + 'this becomes answerable one way or the other.',

  STOP_SCATTER_EXCEEDS_ASYMMETRY_LIMIT:
    'The individual stops in this flight disagree with each other, within a single '
    + 'direction, by more than the amount that would count as the two directions '
    + 'differing. Nothing can be concluded from them, in either direction. Hold '
    + 'each command steady for about a second and a half and release it the same '
    + 'way each time, and the stops will start to agree.',

  CAPTURE_STATE_MISSING:
    'No stop capture was supplied for this axis, so there is nothing to reason '
    + 'from. Run the stop detection on a selected range first.',

  ASYMMETRY_NOT_MEASURABLE:
    'Left and right could not be compared on this axis, so nothing is concluded '
    + 'from them. Fly stops in both directions on this axis — two each way — and '
    + 'there will be something to compare.',

  HEADSPEED_DIFFERS_BETWEEN_DIRECTIONS:
    'The stops one way were flown at a different head speed from the stops the '
    + 'other way, so the two are not comparable — the gains behave differently at '
    + 'different head speeds, and that difference would be read as a tuning '
    + 'result. Fly the stops both ways at one head speed.',

  HEADSPEED_UNSTABLE_ACROSS_EVENTS:
    'Your head speed moved too much across the stops in this flight to compare '
    + 'them against each other. Fly a window at one head speed — let the governor '
    + 'settle, then do the stops — and this becomes answerable.',

  HEADSPEED_UNSTABLE_WITHIN_EVENT:
    'The head speed was still moving during the stops themselves, so what was '
    + 'measured includes the governor catching up rather than the tune. Let the '
    + 'head speed settle before each stop.',

  HEADSPEED_NOT_MEASURABLE:
    'No usable head speed was recorded for these stops, so they cannot be shown '
    + 'to have happened at the same rotor speed. Check that the Blackbox field set '
    + 'includes head speed and that the RPM sensor is reading, then fly it again.',

  HEADSPEED_EVIDENCE_INCOMPLETE:
    'At least one stop has no complete head-speed measurement. Missing samples '
    + 'cannot be discarded and called a steady rotor; check head-speed logging throughout '
    + 'every stop and repeat the manoeuvre.',

  SWEEP_FLIPS_DIRECTION:
    'On this flight the two directions are close enough that which one comes out '
    + 'worse depends on how the measurement window is drawn rather than on the '
    + 'aircraft. Different but equally reasonable windows name opposite '
    + 'directions, so there is no honest answer here yet. Fly two or three more '
    + 'clean stops each way and it will settle one way or the other.',

  SWEEP_FLIPS_THRESHOLD_VERDICT:
    'Whether the two directions differ enough to matter changes with how the '
    + 'measurement window is drawn on this flight, so this is not yet a result. '
    + 'More stops each way would settle it.',

  SWEEP_LOSES_CAPTURE:
    'Some reasonable ways of drawing the measurement window find fewer stops in '
    + 'this flight than others, so the set being compared is not stable. Fly more '
    + 'stops, each held steady and released cleanly.',

  SWEEP_INCOMPLETE:
    'The measurement could not be re-derived across the full range of window '
    + 'choices, so its stability is unknown and nothing is concluded from it. Run '
    + 'the stability check again over a range that contains all of the stops.',

  SWEEP_NOT_RUN:
    'The stability check has not been run for this axis, and no recommendation is '
    + 'made without it.'
});

/** The one sentence for a blocked gate, with its measurement attached. */
export function describeGateBlock(gate) {
  const codes = gate?.codes ?? [];
  return frozen(codes.map(code => frozen({
    code,
    gate: gate.gate,
    sentence: GATE_WORDING[code]
      ?? 'Something in this measurement could not be relied on, so nothing is '
        + 'concluded from it.'
  })));
}

/* ------------------------------------------------------------------ the interlock */

/**
 * All five gates, evaluated together.
 *
 * Reports every failure rather than stopping at the first, because a pilot told
 * only "not enough stops" will fly more stops and hit the airframe gate on the
 * next log. He should have been told both the first time.
 *
 * Returns `mayRecommend` and nothing resembling a recommendation. What to say
 * when it is true belongs to a layer above this one; what to say when it is
 * false is in `sentences`, which is the entire user-visible output on both logs
 * this repository holds.
 */
export function evaluateGainRecommendationGates(input) {
  const metric = input?.metric ?? 'trackingRmsDps';
  const gates = [
    evaluateAirframeGate(input?.mechanical, {
      eventTimesUs: input?.eventTimesUs,
      holdTimesUs: input?.holdTimesUs
    }),
    evaluateCompletenessGate(input?.capture),
    evaluateAgreementGate(input?.evidence, metric, input?.events),
    evaluateHeadspeedGate(input?.events, {records: input?.records}),
    evaluateStabilityGate(input?.sweep)
  ];

  const blocked = gates.filter(gate => gate.status === 'blocked');
  const sentences = [];
  for (const gate of blocked) {
    for (const entry of describeGateBlock(gate)) {
      sentences.push(entry);
    }
  }

  return frozen({
    schemaVersion: 1,
    axis: input?.axis ?? null,
    metric,
    mayRecommend: blocked.length === 0,
    gates: frozen(gates),
    blockedBy: frozen(blocked.map(gate => gate.gate)),
    sentences: frozen(sentences),
    // Restated on every result so a caller cannot end up holding a permitted
    // verdict without the constraints that made it one.
    boundary: 'RotorLens reads logs. It never writes to a flight controller, and '
      + 'a recommendation is one change at a time with the measurement it rests '
      + 'on shown beside it.'
  });
}

/*
 * THERE IS NO SIXTH GATE, and the absence is deliberate.
 *
 * A revision of this file carried `admitMagnitudes`: 518 lines asking whether a
 * learned per-aircraft model might say HOW FAR, with fifteen refusal clauses
 * covering the feedback loop, selection on agreement, regression to the mean,
 * composition mismatch and extrapolation. It was removed, and what it failed on
 * is worth writing down so it is not rebuilt the same way.
 *
 * NOTHING EVER CALLED IT. `buildRecommendations` never received a model in the
 * shipping app, so every clause governed an array that was empty on every run,
 * and the repo's own advice-surface guard failed on its pilot-facing prose the
 * moment the full suite was run against it.
 *
 * Worse than unreachable, it was uncheckable. Twelve of the fifteen clauses read
 * scalars the producer declared about ITSELF — that the fit pooled its baseline,
 * that both directions of gain change were flown, that the pilot rather than the
 * app chose the change — and no stored flight record carries any of those facts.
 * Nothing could have filled them in honestly, and a gate that reads an
 * attestation is only as good as the attester.
 *
 * The rule that survived is simpler and is enforced where the number is made:
 * a magnitude belongs to the module that fitted it, published beside the flights
 * it rests on, as a statement about what already happened. See `buildMagnitude`
 * in src/analysis/flight-history.mjs. This module decides direction from THIS
 * log and nothing else, which is the only question it has the evidence to ask.
 */

export {AXES, DIRECTIONS, STOP_DETECTION_DEFAULTS};
