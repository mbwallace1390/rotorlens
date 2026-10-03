/**
 * What to adjust, which way, and why — the layer that turns evidence into advice.
 *
 * ---------------------------------------------------------------------------
 * PRODUCT DECISION, 12 August 2026, by the owner (Michael Wallace)
 * ---------------------------------------------------------------------------
 * Until this date RotorLens reported measurements and never a recommendation,
 * and a test named "nothing this module can say is a tuning instruction" failed
 * the build if instruction-shaped text appeared. The owner has reversed that, in
 * his words: "i would like the app to analize the flight log the end user
 * selects and recommend what to adjust, thats always been my plan for the app
 * because a lot of people have no clue what they are looking at when they see
 * all the info and graphs."
 *
 * That is the product's purpose and this module does not relitigate it. What did
 * NOT change, because it is engineering rather than product:
 *
 *   - A recommendation must be EARNED BY EVIDENCE. Where the evidence does not
 *     separate the candidate causes, the honest output is "here is what I can
 *     see, here is what to fly to settle it" — a `next-flight` finding, which on
 *     most logs is the correct answer and is still useful.
 *   - MECHANICAL FAULTS OUTRANK GAINS. A helicopter with a vibration problem
 *     cannot be tuned, and advising a gain change on a shaking airframe makes it
 *     worse. `RUNGS` encodes that order and a blocked rung suppresses every
 *     adjustment below it.
 *   - ONE CHANGE AT A TIME. At most one adjustment instruction is returned.
 *   - ROTORLENS NEVER WRITES TO A FLIGHT CONTROLLER. This module returns plain
 *     objects and performs no I/O of any kind.
 *   - Confident and wrong is worse than silent.
 *
 * NEVER A MAGNITUDE FROM A RULE OF THUMB. The owner asked for what to adjust
 * and which way. No finding carries an amount, a percentage or a new value, and
 * `magnitudes` is a separate top-level array that is empty on every run. This
 * module proposes no step and no target value, ever.
 *
 * A NUMBER MEASURED ON THE PILOT'S OWN AIRCRAFT IS A DIFFERENT STATEMENT, and it
 * does not live here. `buildSensitivityModel` in src/analysis/flight-history.mjs
 * fits one from the pilot's own saved flights and reports what the metric DID
 * between two gain values he has actually flown. That is a measurement of the
 * past with its own evidence attached, not advice, and it is published in the
 * flight-history panel beside the flights it came from rather than on an advice
 * card. Keeping the two apart is deliberate: an amount that outlives the flights
 * behind it is the failure this whole boundary exists to prevent, and the model
 * un-says itself on the next render when one of those flights is forgotten.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE ADDS, AND WHAT IT REUSES
 * ---------------------------------------------------------------------------
 * It builds on the owner's existing code rather than beside it:
 *
 *   records.mjs                 stop detection and the four amplitude metrics
 *   pid-evidence.mjs            directional stop evidence, hold evidence,
 *                               `interpretHoldEvidence`, `EVIDENCE_LIMITS`
 *   axis-report.mjs             `describeStopCapture`, the manoeuvre briefs
 *   advisor/recommendation-gates.mjs  the five-gate interlock and the sweep
 *   advisor/mechanical-spectrum.mjs   vibration, rotor-harmonic attribution
 *
 * What is genuinely new here is SHAPE. Every control-loop measurement upstream
 * is an amplitude, and an amplitude cannot tell three physically opposite events
 * apart. Measured on the reference log's two yaw stops:
 *
 *   t = 180.361 s  fastRingingRmsDps 7.12   — but decay ratio 1.053 (the
 *                  envelope does not fall at all across the window), 2 crossings
 *                  at about 4.4 Hz, peak residual 17 deg/s. This one RINGS.
 *   t = 184.821 s  fastRingingRmsDps 34.82  — 4.9x larger, and decay ratio
 *                  0.204 with the gyro still at 115 deg/s the same way the stick
 *                  had been pushed, 20 ms after centre. This one did NOT STOP.
 *
 * `TERM_VIEWS.D.metric` points at `fastRingingRmsDps`, so a D verdict read from
 * that number alone would lower D on the axis that already cannot arrest itself.
 * `measureStopShape` and `classifyStopShape` below separate the two, and every
 * D-facing finding rests on the classification rather than on the amplitude.
 *
 * The same defect one level down: `trackingRmsDps` is an RMS over the plateau,
 * and P-too-low (a standing offset) and P-too-high (ripple about zero) have
 * opposite shapes and identical RMS. `measureTrackingShape` splits it into a
 * signed offset and a ripple, which is what makes a P direction earnable at all.
 *
 * ---------------------------------------------------------------------------
 * STABILITY UNDER PERTURBATION
 * ---------------------------------------------------------------------------
 * `records.mjs` marks `plateauFraction`, `trackingWindowUs` and `fastWindowUs`
 * UNCONSTRAINED BY REAL DATA, and each flips conclusions on its own across
 * plausible values. A conclusion whose DIRECTION moves with an internal constant
 * nobody in this project can defend is that constant being read aloud, not a
 * recommendation. So every directional claim here is re-derived across a grid
 * and must be UNANIMOUS. The same discipline is applied to the I term, whose
 * verdict on the reference log's pitch axis flips with the hold smoothing length
 * and with `huntingRippleDps` (see `HOLD_SWEEP`).
 *
 * Platform-neutral: Math, Number, Object, Array only. No Buffer, no `node:*`,
 * no DOM, no dependency. Node, browser and Android WebView run one copy.
 */

import {
  AXES,
  CROSSINGS_PER_CYCLE,
  DIRECTIONS,
  EVIDENCE_LIMITS,
  HOLD_READING_THRESHOLDS,
  buildDirectionalStopEvidence,
  buildHoldEvidence,
  interpretHoldEvidence,
  mean,
  movingAverage,
  quantile,
  rms,
  weightedMean,
  zeroCrossingRateHz
} from './pid-evidence.mjs';
import {STOP_DETECTION_DEFAULTS, detectStopEvents} from './records.mjs';
import {describeStopCapture, stopManoeuvre, holdManoeuvre} from './axis-report.mjs';
import {
  GAIN_GATE_THRESHOLDS,
  UNCONSTRAINED_SWEEP,
  evaluateAgreementGate,
  evaluateAirframeGate,
  evaluateCompletenessGate,
  evaluateHeadspeedGate,
  evaluateGainRecommendationGates,
  evaluateStabilityGate,
  sweepCombinations,
  sweepDirectionalConclusion
} from './advisor/recommendation-gates.mjs';

export const RECOMMENDATIONS_SCHEMA_VERSION = 1;

/* --------------------------------------------------------------- the order */

/**
 * The dependency order of tuning, which is why findings are a LIST and not a set.
 *
 * Each rung is measured under conditions the rungs above it invalidate, so a
 * correct recommendation given in the wrong order wastes a flight:
 *
 *   log             a decode that cannot be trusted answers nothing
 *   airframe        vibration imitates a badly tuned D term. Rule it out first.
 *   headspeed       every cyclic and tail gain is head-speed dependent, so a
 *                   tune taken on a drooping machine is wrong at every other
 *                   collective setting
 *   axis-mechanical a binding linkage or a tail running out of authority looks
 *                   like a gain fault on that one axis and is not one
 *   gain-P          P sets the error D then differentiates
 *   gain-D          D set against a wrong P has to be redone
 *   gain-I          I is judged in steady state, which only means anything once
 *                   the fast loop has settled
 *   evidence        what the log could not answer, and what to fly for it
 *
 * A `blocker` finding suppresses every ADJUSTMENT below its rung. Observations
 * and next-flight findings still appear, because "and also your rotor was never
 * checked" is information a pilot needs even when a different rung spoke first.
 */
export const RUNGS = Object.freeze([
  'log',
  'airframe',
  'headspeed',
  'axis-mechanical',
  'gain-P',
  'gain-D',
  'gain-I',
  'evidence'
]);

function rungOrder(rung) {
  const index = RUNGS.indexOf(rung);
  return index === -1 ? RUNGS.length : index;
}

/** The four kinds a finding can be. Only `adjustment` may name a direction. */
export const FINDING_KINDS = Object.freeze([
  // Something outranks the gains and must be dealt with first. May name a
  // physical thing to inspect; never names a gain direction.
  'blocker',
  // What to adjust and which way, earned by evidence. Carries basis, confidence
  // and a confirming flight.
  'adjustment',
  // A measurement worth stating, including a confident negative. No direction.
  'observation',
  // The evidence does not separate the candidates. Names them and the manoeuvre
  // that would settle it. No direction.
  'next-flight'
]);

/* ------------------------------------------------------------ shape constants */

/**
 * Constants for the shape measurements, with what each one rests on.
 *
 * Three of these are DERIVED from constants that already had a derivation, and
 * two are judgements. The judgements are swept in `SHAPE_SWEEP` and a conclusion
 * that moves across the sweep is not emitted, which is what keeps a judgement
 * from becoming a verdict.
 */
export const SHAPE_DEFAULTS = Object.freeze({
  /**
   * DERIVED. The residual rate above which the axis is still going the way it
   * was commanded rather than having stopped.
   *
   * This is the detector's own `stopThresholdDps` — the level at which it
   * declares the COMMAND to have reached centre. An aircraft whose measured rate
   * is still above that level, in the commanded direction, 20 ms after the stick
   * reached centre has not arrested. Using a second, separate number here would
   * create a band in which the command has stopped and the aircraft is neither
   * stopped nor moving.
   */
  residualStoppedDps: STOP_DETECTION_DEFAULTS.stopThresholdDps,

  /**
   * DERIVED. Two full cycles before anything is called an oscillation.
   *
   * A zero crossing is half a cycle, so four crossings is two cycles. One large
   * excursion and its recovery produce two crossings and are not ringing; that
   * is exactly what the reference log's positive yaw stop does.
   */
  minimumRingingCrossings: 4,

  /**
   * JUDGEMENT, swept. Second-half RMS over first-half RMS, above which the
   * envelope is not decaying.
   *
   * A damped transient loses most of its amplitude across a window spanning
   * several periods; a ratio near 1 means the envelope is flat, which is a
   * sustained oscillation rather than a transient dying out. 0.7 is about a 30%
   * fall across half the window. Measured: the reference log's positive yaw stop
   * reads 1.053 (flat — ringing) and its negative one 0.204 (falling steeply —
   * a large transient decaying, which is the aircraft finally arresting).
   */
  ringingDecayFloor: 0.7,

  /**
   * JUDGEMENT, swept. Below this frequency an oscillation is not the D term.
   *
   * D acts on the rate of change of error, so what it destabilises is fast —
   * tens of Hz, at the edge of the loop's own bandwidth. Slow oscillation is
   * airframe-rate: a P limit cycle, a tail authority hunt, or the I term, whose
   * band `EVIDENCE_LIMITS.huntingBandHz` tops out at 3 Hz. 8 Hz leaves a clear
   * gap above that band and below anything a D term produces.
   */
  ringingFloorHz: 8,

  /**
   * DERIVED. How far a metric must stand above the airframe's own noise floor.
   *
   * Not a chosen ratio: two RMS quantities add in quadrature, so a metric `m`
   * measured over a floor `b` leaves sqrt(m^2 - b^2) attributable to the loop,
   * and nothing at all when m <= b. `separableFromNoiseFloor` implements exactly
   * that and this flag only says whether to apply it.
   */
  deconvolveNoiseFloor: true,

  /**
   * JUDGEMENT, swept. Share of the tracking error carried by the signed offset,
   * above which the error is a standing offset rather than ripple.
   *
   * P too low leaves the aircraft settled at a rate below the commanded one and
   * it stays there; P too high leaves the loop chattering about the commanded
   * rate with a near-zero mean. 0.6 is the point at which the offset carries
   * more of the error than everything else combined. Measured: the reference
   * log's two yaw stops read 0.761 and 0.514 — one offset-dominated, one not,
   * from the same flight, which is why a single RMS could never have separated
   * them.
   */
  offsetDominantShare: 0.6,

  /** Mirror of the above: below this the error is ripple, not offset. */
  rippleDominantShare: 0.4,

  /**
   * JUDGEMENT, swept. Plateau oscillation over post-release oscillation, above
   * which the axis was already oscillating before the stick moved.
   *
   * This is what separates too much P from too much D when both produce ringing,
   * and without it frequency is the only discriminator — which is far too weak,
   * because a proportional limit cycle at 16 Hz and a derivative one at 50 Hz
   * are both "fast". A marginal proportional loop chatters whenever it is doing
   * work, so it is oscillating during the hold too; a derivative fault is quiet
   * while the error is steady, because D acts on the CHANGE in error and during
   * a hold there is none. A quarter is the point at which the hold's oscillation
   * is no longer a rounding error beside the release's.
   */
  plateauShareOfRinging: 0.25
});

/**
 * The grid the shape conclusions must survive.
 *
 * `fastWindowUs`, `plateauFraction` and `trackingWindowUs` come straight from
 * `UNCONSTRAINED_SWEEP` so that the shape conclusions are held to the same
 * standard as the directional ones. The two judgement constants above are swept
 * across the range over which each remains a defensible reading of the same
 * physical statement.
 */
export const SHAPE_SWEEP = Object.freeze({
  ringingDecayFloor: Object.freeze([0.55, 0.6, 0.7, 0.8, 0.9]),
  ringingFloorHz: Object.freeze([5, 6.5, 8, 10, 12]),
  offsetDominantShare: Object.freeze([0.5, 0.55, 0.6, 0.65, 0.7]),
  plateauShareOfRinging: Object.freeze([0.15, 0.2, 0.25, 0.3, 0.4])
});

/**
 * The grid the I-term conclusion must survive.
 *
 * The audit of this repository measured the reference log's pitch verdict
 * flipping across both of these, non-monotonically, with the shipped value
 * sitting inside the only window that says `decrease`:
 *
 *   smoothing L  30/50/74/100 ms -> hold;  120/148(shipped)/180/222 -> decrease;
 *                300/400/600 -> hold
 *   huntingRippleDps 0.5/1/1.5/2(shipped) -> decrease;  2.5/3/4/6 -> hold
 *
 * Both are bracketed here, so that verdict cannot be emitted. `huntingSmoothingUs`
 * changes the MEASUREMENT (the crossing rate is counted on a box average of that
 * length), so hold evidence is rebuilt at each value rather than reinterpreted.
 */
export const HOLD_SWEEP = Object.freeze({
  huntingSmoothingUs: Object.freeze([74_000, 100_000, 148_000, 222_000, 300_000]),
  huntingRippleDps: Object.freeze([1, 1.5, 2, 3, 4])
});

/**
 * Bind detection: a standing error the I term is fighting and losing.
 *
 * `interpretHoldEvidence` reads only the error, never `iTermMean`, so a binding
 * linkage — error present, I term wound up large and still growing against it —
 * reaches it looking exactly like "too little I". Recommending more I to an
 * aircraft whose linkage is binding is the most dangerous single output this
 * engine could produce, so the discriminator is applied before the I direction
 * is ever read.
 */
export const BIND_LIMITS = Object.freeze({
  /**
   * DERIVED from the same threshold `interpretHoldEvidence` uses for a standing
   * error, so "there is an error" means one thing in both places.
   */
  errorDpsThreshold: 3,

  /**
   * JUDGEMENT. |I term| this many times its own per-second drift means the term
   * has wound to a large value and is still going. Stated as a ratio so it is
   * unit-free across a controller's own scaling, which RotorLens does not know.
   */
  windUpToDriftRatio: 5,

  /** A drift below this is not going anywhere; units are I-term units/second. */
  minimumITermDriftPerSecond: 0.5
});

/**
 * ADDED 13 AUGUST 2026, after an adversarial review reproduced four ways this
 * engine turned a MECHANICAL fault into a gain instruction. Each limit below
 * exists to answer one question the engine was not asking: CAN THE GAIN I AM
 * ABOUT TO NAME ACTUALLY MOVE THE THING I AM POINTING AT?
 *
 * That question is the difference between a correlation and a recommendation.
 * All four are unit-free ratios, because RotorLens does not know a controller's
 * gain scaling and must never behave as if it did.
 */
export const AUTHORITY_LIMITS = Object.freeze({
  /**
   * JUDGEMENT. Standing offset as a share of the commanded rate, above which
   * "raise P" is not a defensible reading of a failure to arrest.
   *
   * REPRODUCED FAILURE: a control run at its TRAVEL LIMIT — a servo horn on the
   * wrong hole, a swashplate on its stop — produces the most offset-dominated
   * tracking error possible (`offsetShare` 1.000), so the more saturated the
   * actuator was, the more confident the old code's "Raise P" became. Tripling P
   * against a physical stop moved the tracking error by 0.16%, and the engine
   * reissued the same instruction at every gain, unfalsifiably.
   *
   * THE DERIVATION. For a loop closing at gain K the steady-state shortfall is
   * 1/(1+K), so a shortfall of 0.35 of the commanded rate is K = 1.9 — a loop
   * barely closing at all. One gain step is 15-25%: from K = 1.9 that moves the
   * shortfall from 0.345 to about 0.30, which a pilot can see. From a shortfall
   * of 0.57 (the reproduction above) it moves 0.57 to 0.52, and on a saturated
   * actuator it moves nothing at all. Above this line the honest answer is the
   * one the engine already had — AXIS_DOES_NOT_ARREST, whose candidate list
   * already names the travel limit and whose confirming flight (the same stop
   * from half the command) is the manoeuvre that separates them.
   */
  standingOffsetShareOfCommand: 0.35,

  /**
   * JUDGEMENT, and the floor under the ceiling above. Standing offset as a share
   * of the commanded rate, in the SMALLER of the two directions, below which the
   * offset cannot carry "raise P".
   *
   * ADDED 2 October 2026. REPRODUCED FAILURE: a healthy loop with a 25-40 ms lag
   * and a 1% shortfall, stopped from 300-350 deg/s. Its tracking error is almost
   * all offset (`offsetShare` 0.72-0.78), because there is so little error of
   * any other kind, and 20 ms after centre it is still turning at about half the
   * command, because that is what a lag does to a fast stop. Both P_TOO_LOW
   * signatures, nothing wrong, and the engine said "Raise yaw P" with START HERE
   * on it and all five gates passing. `offsetShare` is a share of the ERROR; the
   * claim "it sat at a rate below the one asked for" is about the COMMAND, and
   * only this number measures it. Raising tail P on a healthy tail risks a wag.
   *
   * Why 0.05: it is a twentieth of the rate asked for — about 15-17 deg/s on the
   * stops above, far outside the 1% the reproduction carried — and one gain step
   * from K = 19 (where 1/(1+K) is 0.05) moves it by under a percent of the
   * command, so below it a P step cannot be expected to change anything a pilot
   * can see. The audit proposed it; no real log has tested it.
   */
  standingOffsetShareOfCommandFloor: 0.05,

  /**
   * DERIVED, and the reason is arithmetic rather than empirical. An integrator
   * that is not saturated MUST move when an error stands: dI/dt = ki * error.
   * So an I term whose whole excursion across a hold is under 15% of its own
   * magnitude, while a standing error persists, is an integrator that has
   * stopped integrating — clamped at the flight controller's `iterm_limit`.
   *
   * REPRODUCED FAILURE: `growing`/`woundUp` both require DRIFT, so the old bind
   * discriminator switched itself off exactly when the integrator finished
   * winding against something it could not beat. A 22 deg/s standing yaw error
   * with the integrator pinned is a tail out of authority; the engine said
   * "Raise yaw I", and said it identically at every clamp value.
   */
  iTermTravelShare: 0.15,

  /**
   * DERIVED as a presence floor, not as a size judgement, and the difference was
   * measured rather than assumed.
   *
   * The first draft of the clamp test also required the integrator to be LARGE
   * beside its P term (0.5). Swept against a bind held at four different flight
   * controller `iterm_limit` values, that caught the clamps at 4 and 2 units and
   * missed the clamps at 1 and 0.5 — where the aircraft is equally bound (22.0
   * deg/s of standing error in every row) and the term is merely capped lower.
   * So the size requirement was wrong: what makes a clamp a clamp is that the
   * integrator STOPPED, not that it stopped somewhere high.
   *
   * An integrator that is genuinely too small is still an integrator: it is the
   * running total of the error, so it climbs, slowly. Frozen is the signature,
   * and frozen has exactly one other cause — no integrator at all, where raising
   * I really is the answer. This floor separates that case, and only that case.
   */
  iTermToPTermRatio: 0.1,

  /**
   * JUDGEMENT. The I term's share of the total control-output ripple at the
   * hunting frequency, below which lowering I cannot materially change the
   * motion.
   *
   * REPRODUCED FAILURE: an external low-frequency disturbance the loop cannot
   * reject — a hunting governor, a slipping belt, wind — produces an error whose
   * integral is periodic at the same frequency, so the crossing-rate match the
   * old code relied on reads 1.0 for ANY external periodic input. On that
   * fixture the engine said "Lower yaw I" at every I value down to a tenth of
   * the original, and removing the I term ENTIRELY changed the yaw wander from
   * 23.9 to 23.8 deg/s.
   *
   * THE DERIVATION. "Lower I and the wander should shrink" is a claim about
   * EFFECT SIZE, so the engine must measure the effect size it is promising. If
   * the I term contributes a third of the output's ripple, removing all of it
   * removes at most about a third of the drive. Below that, the promise in the
   * confirming flight is not one the aircraft can keep. A genuine integrator
   * hunt sits far above this line by construction: the instability comes from
   * the integrator's own phase lag being significant, which means its
   * contribution at the hunt frequency is comparable to or larger than P's.
   */
  iTermShareOfOutputRipple: 0.34
});

/**
 * How a measured airframe tone is matched against a control-loop oscillation.
 *
 * ADDED 13 AUGUST 2026 with AUTHORITY_LIMITS, for the fourth reproduced
 * failure. A tone the spectrum analyser has POSITIVELY MATCHED to main-rotor
 * order 1 was being discarded because it sat under the fixed 8 deg/s attention
 * threshold, and the engine then told the pilot the airframe was clean — "a
 * positive measurement of absence, not silence" — while `mechanical.reasonCodes`
 * read `["PERSISTENT_NARROWBAND_ENERGY_BELOW_ATTENTION_THRESHOLD"]`.
 *
 * The fix is deliberately NOT "block gains whenever a tone exists". Every
 * helicopter shows a once-per-rev, and a rule like that would refuse every
 * flight forever. What is blocked is narrower and defensible: a gain change
 * whose entire evidence is an OSCILLATION, when a persistent tone sits at that
 * same frequency. There the loop explanation and the mechanical explanation are
 * not separable within one log, and "lower D" is a coin toss with a decimal
 * point on it.
 */
export const TONE_LIMITS = Object.freeze({
  /**
   * DERIVED from what a peak already means upstream: `persistenceRatio` is the
   * fraction of analysis windows the tone was present in. Half of them is the
   * point at which a tone is a feature of the flight rather than of one moment,
   * and it is the same half-the-windows test `attentionTemporalSpanRatio` uses.
   */
  persistenceRatioFloor: 0.5,

  /**
   * JUDGEMENT. Two frequencies are the same frequency when they are within this
   * fraction of each other, or within the measured bandwidth of the tone,
   * whichever is wider. 15% is wider than the frequency uncertainty of a stop
   * transient measured from a handful of zero crossings, which is the noisier of
   * the two numbers being compared.
   */
  coincidenceFraction: 0.15
});

/* ------------------------------------------------------------------ utilities */

function frozen(value) {
  return Object.freeze(value);
}

function finite(values) {
  return values.filter(Number.isFinite);
}

/**
 * Min and max by iteration rather than by spread.
 *
 * `Math.max(...values)` is a function call with one argument per sample, and a
 * real log holds 134,429 of them: it overflows the call stack rather than
 * returning a wrong answer, which is the good kind of failure but still a
 * failure. This module runs over whole-log arrays in three places.
 */
function extentOf(values) {
  let lowest = Number.POSITIVE_INFINITY;
  let highest = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) {
      continue;
    }
    count += 1;
    if (value < lowest) {
      lowest = value;
    }
    if (value > highest) {
      highest = value;
    }
  }
  return count === 0 ? null : {lowest, highest, count};
}

function round(value, places) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Standard deviation about the sample mean. */
function standardDeviation(values) {
  const usable = finite(values);
  if (usable.length < 2) {
    return null;
  }
  const centre = mean(usable);
  return Math.sqrt(
    usable.reduce((total, value) => total + (value - centre) ** 2, 0) / usable.length
  );
}

/** Pearson correlation, or null when either series has no variation. */
export function correlation(left, right) {
  const count = Math.min(left.length, right.length);
  if (count < 3) {
    return null;
  }
  const a = [];
  const b = [];
  for (let index = 0; index < count; index += 1) {
    if (Number.isFinite(left[index]) && Number.isFinite(right[index])) {
      a.push(left[index]);
      b.push(right[index]);
    }
  }
  if (a.length < 3) {
    return null;
  }
  const meanA = mean(a);
  const meanB = mean(b);
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const da = a[index] - meanA;
    const db = b[index] - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }
  if (varianceA === 0 || varianceB === 0) {
    return null;
  }
  return covariance / Math.sqrt(varianceA * varianceB);
}

/**
 * What is left of an RMS measurement once the airframe's own noise floor is
 * removed, or null when nothing is.
 *
 * Two uncorrelated RMS quantities add in quadrature, so the loop's contribution
 * to a measured `metricDps` over a floor `floorDps` is sqrt(m^2 - b^2). When the
 * floor equals or exceeds the metric, the whole of what was measured is
 * accounted for by the airframe and NOTHING about the loop can be read from it.
 * That is a derivation rather than a chosen margin, which is why it is the rule
 * used everywhere in this module that a metric is interpreted.
 */
export function separableFromNoiseFloor(metricDps, floorDps) {
  if (!Number.isFinite(metricDps)) {
    return null;
  }
  if (!Number.isFinite(floorDps) || floorDps <= 0) {
    return metricDps;
  }
  if (metricDps <= floorDps) {
    return null;
  }
  return Math.sqrt(metricDps * metricDps - floorDps * floorDps);
}

const AXIS_INDEX = Object.freeze({roll: 0, pitch: 1, yaw: 2});

function axisIndexOf(axis) {
  return Object.prototype.hasOwnProperty.call(AXIS_INDEX, axis) ? AXIS_INDEX[axis] : -1;
}

/** First index at or after `timeUs` in a time-sorted record array. */
function firstAtOrAfter(records, timeUs) {
  let low = 0;
  let high = records.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (records[mid].timeUs < timeUs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/** Last index at or before `timeUs`, or -1. */
function lastAtOrBefore(records, timeUs) {
  let low = 0;
  let high = records.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (records[mid].timeUs <= timeUs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low - 1;
}

/* ------------------------------------------------------- window reconstruction */

/**
 * Rebuilds the index at which the command left its plateau, for one stop event.
 *
 * `records.mjs` anchors `trackingRmsDps` to the plateau departure — the last
 * sample at or above `plateauFraction` of the command's peak — and does not
 * publish that index. It publishes enough to recover it exactly:
 * `commandDurationUs` is the hold from command start to the last sample above
 * the command threshold, and `releaseTransitUs` is that sample to the stop. So
 * the command's own span is `stopTimeUs - releaseTransitUs - commandDurationUs`
 * to `stopTimeUs`, and the plateau departure is found by the same scan.
 *
 * This is reconstruction, not reimplementation, and `test/recommendations.test.mjs`
 * pins it by asserting that the RMS over the recovered window equals the event's
 * own `trackingRmsDps` to four decimal places on every event in both logs. If
 * the upstream anchoring ever moves, that assertion fails rather than this
 * module silently measuring a different second of flight.
 */
export function resolvePlateauDeparture(records, event, axis, options = {}) {
  const index = axisIndexOf(axis);
  if (index === -1 || !Array.isArray(records) || records.length === 0) {
    return null;
  }
  const plateauFraction = options.plateauFraction ?? STOP_DETECTION_DEFAULTS.plateauFraction;
  const stopIndex = lastAtOrBefore(records, event.stopTimeUs);
  const startUs = event.stopTimeUs
    - (event.releaseTransitUs ?? 0)
    - (event.commandDurationUs ?? 0);
  const startIndex = firstAtOrAfter(records, startUs);
  if (stopIndex < startIndex) {
    return null;
  }

  let peak = 0;
  let departure = startIndex;
  for (let step = startIndex; step <= stopIndex; step += 1) {
    const value = records[step]?.setpoint?.[index];
    if (!Number.isFinite(value)) {
      continue;
    }
    const magnitude = Math.abs(value);
    if (magnitude > peak) {
      peak = magnitude;
      departure = step;
    }
    if (magnitude >= plateauFraction * peak) {
      departure = step;
    }
  }
  return {startIndex, stopIndex, departureIndex: departure, peakDps: peak};
}

/**
 * Splits the tracking error into the two shapes a single RMS cannot separate.
 *
 * P TOO LOW is a standing offset: the aircraft settles at a rate below the one
 * commanded and stays there, so the error has a large signed mean and little
 * scatter. P TOO HIGH is ripple: the loop chatters about the commanded rate, so
 * the mean is near zero and the scatter carries the error. `trackingRmsDps`
 * combines the two and reports one number, and the two faults call for opposite
 * gain moves.
 *
 * `signedOffsetDps` is the offset in the COMMAND's own direction: positive means
 * the aircraft was lagging behind what was asked for, which is the P-too-low
 * signature and is the same statement for a left stop and a right one.
 *
 * Measured, reference log yaw:
 *   t = 180.361 s  offset -14.61 in command frame, ripple 12.44, share 0.761
 *   t = 184.821 s  offset -18.44 in command frame, ripple 30.74, share 0.514
 * Two stops from one flight whose errors differ in KIND. Their RMS values —
 * 6.01 and 4.42 — say only "the first is slightly worse".
 */
export function measureTrackingShape(records, event, axis, options = {}) {
  const index = axisIndexOf(axis);
  const anchor = resolvePlateauDeparture(records, event, axis, options);
  if (index === -1 || anchor === null) {
    return null;
  }
  const trackingWindowUs = options.trackingWindowUs ?? STOP_DETECTION_DEFAULTS.trackingWindowUs;
  const departureUs = records[anchor.departureIndex].timeUs;
  const from = Math.max(
    anchor.startIndex,
    firstAtOrAfter(records, Math.max(records[anchor.startIndex].timeUs, departureUs - trackingWindowUs))
  );
  const to = anchor.departureIndex;
  if (to - from < 1) {
    return null;
  }

  const errors = [];
  const commands = [];
  for (let step = from; step <= to; step += 1) {
    const setpoint = records[step]?.setpoint?.[index];
    const gyro = records[step]?.gyro?.[index];
    if (Number.isFinite(setpoint) && Number.isFinite(gyro)) {
      errors.push(setpoint - gyro);
      commands.push(setpoint);
    }
  }
  if (errors.length < 2) {
    return null;
  }

  const sign = event.commandSign === 'negative' ? -1 : 1;
  const offset = mean(errors);
  const ripple = standardDeviation(errors);
  const total = rms(errors);

  // The oscillation while the command was genuinely FLAT, which is a different
  // question from the tracking error and answers a different one.
  //
  // `plateauFraction` is 0.9, so the tracking window ends a little way into the
  // release ramp — the command has left its peak but not yet dropped below 90%
  // of it. Across that ramp the aircraft lags by construction, and on the
  // reference log's two yaw stops that ramp alone carries error ripple of 12.4
  // and 30.7 deg/s. Averaging it in would make every axis look like it chatters.
  // So this is measured only over samples whose command is within 1% of the
  // window's own median: the part that is unambiguously a hold.
  const commandMedian = quantile(commands, 0.5);
  const flat = [];
  for (let step = 0; step < errors.length; step += 1) {
    if (Math.abs(commands[step] - commandMedian) <= Math.abs(commandMedian) * 0.01) {
      flat.push(errors[step]);
    }
  }
  const plateauRipple = flat.length >= 4 ? standardDeviation(flat) : null;

  return frozen({
    sampleCount: errors.length,
    flatSampleCount: flat.length,
    fromTimeUs: records[from].timeUs,
    toTimeUs: records[to].timeUs,
    /** Signed in the log's own frame, kept so it can be checked against a trace. */
    offsetDps: round(offset, 4),
    /** Positive means the aircraft lagged the command, whichever way it was flown. */
    signedOffsetDps: round(offset * sign, 4),
    rippleRmsDps: round(ripple, 4),
    /**
     * Oscillation while the command was flat. This is the P-versus-D
     * discriminator: an axis whose loop is marginal chatters WHENEVER it is
     * doing work, so it oscillates during the hold as well as after the
     * release. An axis with too much D is quiet while the error is steady —
     * D acts on how fast the error is changing, and during a hold it is not
     * changing — and only rings in the transient after centre.
     */
    plateauRippleRmsDps: round(plateauRipple, 4),
    trackingRmsDps: round(total, 4),
    /** 1 means the error is entirely a standing offset; 0 entirely ripple. */
    offsetShare: total === 0 ? null : round(Math.abs(offset) / total, 4)
  });
}

/**
 * The shape of the response after the release, which is what separates ringing
 * from a failure to stop.
 *
 * Everything here is arithmetic over samples the detector already visited; the
 * window is the same `fastWindowUs` that produces `fastRingingRmsDps`, so the
 * two describe the same seconds and can be shown side by side.
 *
 *   sameWayPeakDps    the largest rate still in the COMMANDED direction. Large
 *                     means the aircraft had not arrested.
 *   overshootDps      the largest rate the other way — a genuine overshoot.
 *   zeroCrossings     half-cycles. Four is two cycles, which is the least that
 *                     can be called an oscillation.
 *   decayRatio        second-half RMS over first-half. Near 1 is a flat
 *                     envelope: sustained. Well under 1 is a transient dying.
 *   settleTimeUs      time from centre until |rate| stays under the detector's
 *                     own stop threshold for the rest of the window, or null if
 *                     it never does.
 */
export function measureStopShape(records, event, axis, options = {}) {
  const index = axisIndexOf(axis);
  if (index === -1 || !Array.isArray(records) || records.length === 0) {
    return null;
  }
  const fastWindowUs = options.fastWindowUs ?? STOP_DETECTION_DEFAULTS.fastWindowUs;
  const residualStoppedDps = options.residualStoppedDps ?? SHAPE_DEFAULTS.residualStoppedDps;

  const from = firstAtOrAfter(records, event.stopTimeUs + fastWindowUs[0]);
  const to = lastAtOrBefore(records, event.stopTimeUs + fastWindowUs[1]);
  if (to - from < 3) {
    return null;
  }

  const times = [];
  const values = [];
  for (let step = from; step <= to; step += 1) {
    const value = records[step]?.gyro?.[index];
    if (Number.isFinite(value)) {
      times.push(records[step].timeUs);
      values.push(value);
    }
  }
  if (values.length < 4) {
    return null;
  }

  const sign = event.commandSign === 'negative' ? -1 : 1;
  let sameWayPeak = 0;
  let overshoot = 0;
  let crossings = 0;
  for (let step = 0; step < values.length; step += 1) {
    const inCommandFrame = values[step] * sign;
    if (inCommandFrame > sameWayPeak) {
      sameWayPeak = inCommandFrame;
    }
    if (-inCommandFrame > overshoot) {
      overshoot = -inCommandFrame;
    }
    // A sign change of the measured rate is half an oscillation cycle. Counted
    // on the raw comparison rather than against a band, so a signal that never
    // reaches zero contributes none.
    if (step > 0 && (values[step - 1] < 0) !== (values[step] < 0)) {
      crossings += 1;
    }
  }

  const half = Math.floor(values.length / 2);
  const firstHalf = rms(values.slice(0, half));
  const secondHalf = rms(values.slice(half));
  const spanSeconds = (times[times.length - 1] - times[0]) / 1e6;

  // Settled means it stays settled: a rate that dips under the threshold and
  // comes back out has not settled, it is mid-oscillation.
  let settleTimeUs = null;
  for (let step = 0; step < values.length; step += 1) {
    let stays = true;
    for (let ahead = step; ahead < values.length; ahead += 1) {
      if (Math.abs(values[ahead]) >= residualStoppedDps) {
        stays = false;
        break;
      }
    }
    if (stays) {
      settleTimeUs = times[step] - event.stopTimeUs;
      break;
    }
  }

  return frozen({
    sampleCount: values.length,
    fromTimeUs: times[0],
    toTimeUs: times[times.length - 1],
    windowUs: frozen([...fastWindowUs]),
    rmsDps: round(rms(values), 4),
    sameWayPeakDps: round(sameWayPeak, 4),
    overshootDps: round(overshoot, 4),
    zeroCrossings: crossings,
    impliedFrequencyHz: spanSeconds > 0 ? round(crossings / (2 * spanSeconds), 4) : null,
    firstHalfRmsDps: round(firstHalf, 4),
    secondHalfRmsDps: round(secondHalf, 4),
    decayRatio: firstHalf === 0 ? null : round(secondHalf / firstHalf, 4),
    settleTimeUs,
    residualStoppedDps
  });
}

/**
 * Four physically distinct outcomes, from the shape rather than the amplitude.
 *
 *   not-stopped   the axis was still going the commanded way, above the level at
 *                 which the detector calls a command stopped, after the stick
 *                 reached centre. This is a failure to arrest, and it is what
 *                 the largest `fastRingingRmsDps` in the reference log actually
 *                 is. Reading it as "too much D" would lower D on the axis that
 *                 already cannot stop.
 *   ringing       a flat envelope over at least two cycles: sustained
 *                 oscillation. The D-term signature when it is fast enough.
 *   overshoot     it went past centre and came back, and the envelope is
 *                 decaying. Underdamped, and NOT attributable to one term — too
 *                 little D, too much P and too much F all produce it.
 *   settled       it stopped. Nothing to conclude, which is a result.
 *
 * Order matters: not-stopped is tested first because an aircraft that never
 * arrested also crosses zero and also has an envelope, and describing it by
 * either of those would name the wrong fault.
 */
export function classifyStopShape(shape, options = {}) {
  if (!shape) {
    return frozen({classification: null, codes: frozen(['SHAPE_NOT_MEASURABLE'])});
  }
  const limits = {...SHAPE_DEFAULTS, ...options};
  const codes = [];

  // The EXCESS in the commanded direction, not the peak. A large symmetric
  // oscillation also peaks above the stop threshold on the commanded side, and
  // testing the peak alone would call every ringing axis a failure to arrest —
  // the same confusion as reading the amplitude, one level up. What says "it did
  // not stop" is a BIAS: the axis went much further one way than the other, and
  // the way it went further is the way it had been pushed. Measured on the
  // reference log's two yaw stops: 17.0 against 13.0 (a difference of 4, not a
  // bias) and 115.0 against 16.0 (a difference of 99, which is the aircraft
  // failing to arrest).
  if (shape.sameWayPeakDps - shape.overshootDps > limits.residualStoppedDps) {
    codes.push('RESIDUAL_RATE_IN_COMMAND_DIRECTION');
    return frozen({classification: 'not-stopped', codes: frozen(codes)});
  }

  const flatEnvelope = Number.isFinite(shape.decayRatio)
    && shape.decayRatio >= limits.ringingDecayFloor;
  const enoughCycles = shape.zeroCrossings >= limits.minimumRingingCrossings;
  const fastEnough = Number.isFinite(shape.impliedFrequencyHz)
    && shape.impliedFrequencyHz >= limits.ringingFloorHz;

  if (flatEnvelope && enoughCycles) {
    codes.push('FLAT_ENVELOPE_OVER_TWO_CYCLES');
    if (!fastEnough) {
      // Slow sustained oscillation is not the D term. Reported as ringing so it
      // is not mistaken for settled, and flagged so no D finding may rest on it.
      codes.push('OSCILLATION_BELOW_D_TERM_BAND');
    }
    return frozen({classification: 'ringing', codes: frozen(codes)});
  }

  if (shape.overshootDps > limits.residualStoppedDps && shape.zeroCrossings >= 1) {
    codes.push('OVERSHOOT_PAST_CENTRE');
    return frozen({classification: 'overshoot', codes: frozen(codes)});
  }

  codes.push('SETTLED_WITHIN_WINDOW');
  return frozen({classification: 'settled', codes: frozen(codes)});
}

/* ---------------------------------------------------------------- shape sweeps */

/**
 * Every combination the shape conclusions are re-derived at.
 *
 * The detector grid and the judgement grid are crossed, so a classification that
 * survives is one that survives BOTH the windows nobody derived and the two
 * thresholds this module chose. Full size is
 * |UNCONSTRAINED_SWEEP| x |ringingDecayFloor| x |ringingFloorHz| x
 * |offsetDominantShare| = 270 x 125, which is far more detector runs than are
 * needed: the detector output depends only on the first three, so it is run once
 * per detector combination and reclassified across the judgement grid.
 */
export function shapeSweepCombinations(grid = SHAPE_SWEEP) {
  const out = [];
  for (const ringingDecayFloor of grid.ringingDecayFloor) {
    for (const ringingFloorHz of grid.ringingFloorHz) {
      for (const offsetDominantShare of grid.offsetDominantShare) {
        for (const plateauShareOfRinging of grid.plateauShareOfRinging) {
          out.push({
            ringingDecayFloor, ringingFloorHz, offsetDominantShare, plateauShareOfRinging
          });
        }
      }
    }
  }
  return out;
}

/**
 * Whether the axis was already oscillating before the stick moved.
 *
 * `null` when there is no post-release oscillation to compare against, which is
 * not the same as "no, it was quiet" and must not read the same downstream.
 */
export function oscillationSource(shape, tracking, limits = SHAPE_DEFAULTS) {
  const release = shape?.rmsDps;
  const plateau = tracking?.plateauRippleRmsDps;
  if (!Number.isFinite(release) || release === 0 || !Number.isFinite(plateau)) {
    return null;
  }
  return plateau / release >= limits.plateauShareOfRinging ? 'hold-and-release' : 'release-only';
}

/**
 * Re-derives the per-direction shape conclusion at every point in both grids.
 *
 * Returns, per direction, the SET of classifications seen and the set of
 * tracking-error kinds seen. A direction whose set has one member survived; a
 * direction whose set has more than one did not, and nothing directional may be
 * said about it.
 *
 * SILENCE IS NOT DISSENT, and getting that wrong made the D verdict
 * unreachable. `oscillationSource` returns null when the combination could not
 * MEASURE the hold — the plateau window landed inside the release ramp and
 * contained no flat command at all — which is a different thing from "no, the
 * axis was quiet beforehand". Adding that null to the set of opinions made the
 * set two-membered and vetoed the conclusion, so one window with no hold in it
 * out-voted the 265 that could see one.
 *
 * MEASURED on fixtures/synthetic/rf46-gain-fault.TXT, which is built as a
 * textbook too-much-D fault. At plateauFraction 0.5 with a 50 ms tracking
 * window the departure anchor sits 26 ms deeper into the release than at the
 * shipped 0.9, so the whole window is ramp: the command falls 260 -> 134 deg/s
 * across its 26 samples and NOT ONE of them is within 1% of the window's own
 * median, so `flatSampleCount` is 0 and `plateauRippleRmsDps` is null. Five of
 * the 270 detector combinations (plateauFraction 0.5 x trackingWindowUs 50 ms x
 * all five fast windows) did that, and those five were enough to reduce
 * `oscillationSourcesSeen` to [null, 'release-only'] and turn a clean D fault
 * into RINGING_SOURCE_UNKNOWN.
 *
 * So a null is counted as an ABSTENTION here: unanimity is required among the
 * combinations that had an opinion, and `GAIN_GATE_THRESHOLDS.requiredSweepOpinionShare`
 * requires that they be a majority of the grid. Silence from a CONSTANT NOBODY
 * DERIVED is not evidence; that is the whole reason this sweep exists.
 *
 * The per-event path in `axisFindings` deliberately does NOT do this. There, a
 * null comes from a manoeuvre the pilot actually flew, and a stop with no
 * measurable hold is missing evidence rather than an unjustified constant — so
 * it still withholds the conclusion.
 */
export function sweepStopShapeConclusion(records, axis, options = {}) {
  const detectorGrid = options.detectorGrid ?? UNCONSTRAINED_SWEEP;
  const judgementGrid = options.judgementGrid ?? SHAPE_SWEEP;
  const detectorCombinations = sweepCombinations(detectorGrid);
  const judgementCombinations = shapeSweepCombinations(judgementGrid);

  const seen = {};
  for (const direction of DIRECTIONS) {
    seen[direction] = {
      classifications: new Set(),
      // Opinions only. A combination that could not measure the hold is counted
      // in `oscillationSilences` instead, never added here as a member.
      oscillationSources: new Set(),
      oscillationOpinions: 0,
      oscillationSilences: 0,
      errorKinds: new Set(),
      eventCounts: new Set(),
      frequencies: [],
      decayRatios: [],
      sameWayPeaks: [],
      overshoots: [],
      signedOffsets: [],
      offsetShares: []
    };
  }

  let evaluatedCombinations = 0;
  for (const detector of detectorCombinations) {
    const events = detectStopEvents(records, {
      ...(options.detectOptions ?? {}),
      axis,
      plateauFraction: detector.plateauFraction,
      trackingWindowUs: detector.trackingWindowUs,
      fastWindowUs: detector.fastWindowUs
    });

    for (const direction of DIRECTIONS) {
      seen[direction].eventCounts.add(
        events.filter(event => event.commandSign === direction).length
      );
    }

    for (const event of events) {
      const direction = event.commandSign;
      if (!DIRECTIONS.includes(direction)) {
        continue;
      }
      const shape = measureStopShape(records, event, axis, {
        fastWindowUs: detector.fastWindowUs
      });
      const tracking = measureTrackingShape(records, event, axis, {
        plateauFraction: detector.plateauFraction,
        trackingWindowUs: detector.trackingWindowUs
      });
      if (shape) {
        seen[direction].frequencies.push(shape.impliedFrequencyHz);
        seen[direction].decayRatios.push(shape.decayRatio);
        seen[direction].sameWayPeaks.push(shape.sameWayPeakDps);
        seen[direction].overshoots.push(shape.overshootDps);
      }
      if (tracking) {
        seen[direction].signedOffsets.push(tracking.signedOffsetDps);
        seen[direction].offsetShares.push(tracking.offsetShare);
      }
      for (const judgement of judgementCombinations) {
        const verdict = classifyStopShape(shape, judgement);
        seen[direction].classifications.add(verdict.classification);
        const source = oscillationSource(shape, tracking, {...SHAPE_DEFAULTS, ...judgement});
        if (source === null) {
          seen[direction].oscillationSilences += 1;
        } else {
          seen[direction].oscillationOpinions += 1;
          seen[direction].oscillationSources.add(source);
        }
        if (tracking) {
          seen[direction].errorKinds.add(
            tracking.offsetShare === null ? null
              : tracking.offsetShare >= judgement.offsetDominantShare ? 'offset'
                : tracking.offsetShare <= SHAPE_DEFAULTS.rippleDominantShare ? 'ripple'
                  : 'mixed'
          );
        }
      }
    }
    evaluatedCombinations += 1;
  }

  const directions = {};
  for (const direction of DIRECTIONS) {
    const record = seen[direction];
    const classifications = [...record.classifications];
    const errorKinds = [...record.errorKinds];
    const sources = [...record.oscillationSources];
    // How much of the grid could see a hold at all. Null when the direction had
    // no events, which is a different silence again and reads as one.
    const evaluations = record.oscillationOpinions + record.oscillationSilences;
    const opinionShare = evaluations === 0 ? null : record.oscillationOpinions / evaluations;
    const quorum = opinionShare !== null
      && opinionShare > GAIN_GATE_THRESHOLDS.requiredSweepOpinionShare;
    directions[direction] = frozen({
      stable: classifications.length === 1 && record.eventCounts.size === 1,
      classification: classifications.length === 1 ? classifications[0] : null,
      classificationsSeen: frozen(classifications),
      oscillationSource: sources.length === 1 && quorum ? sources[0] : null,
      oscillationSourcesSeen: frozen(sources),
      /** Combinations that produced an opinion, over combinations tried. */
      oscillationOpinionShare: opinionShare === null ? null : round(opinionShare, 4),
      /** Combinations whose window contained no hold to measure. */
      oscillationSilentEvaluations: record.oscillationSilences,
      oscillationEvaluations: evaluations,
      errorKind: errorKinds.length === 1 ? errorKinds[0] : null,
      errorKindsSeen: frozen(errorKinds),
      eventCountsSeen: frozen([...record.eventCounts].sort((a, b) => a - b)),
      frequencyHzRange: rangeOf(record.frequencies),
      decayRatioRange: rangeOf(record.decayRatios),
      sameWayPeakDpsRange: rangeOf(record.sameWayPeaks),
      overshootDpsRange: rangeOf(record.overshoots),
      signedOffsetDpsRange: rangeOf(record.signedOffsets),
      offsetShareRange: rangeOf(record.offsetShares)
    });
  }

  return frozen({
    axis,
    detectorCombinationCount: detectorCombinations.length,
    judgementCombinationCount: judgementCombinations.length,
    evaluatedCombinations,
    directions: frozen(directions)
  });
}

function rangeOf(values) {
  const extent = extentOf(values);
  if (extent === null) {
    return null;
  }
  return frozen({minimum: round(extent.lowest, 4), maximum: round(extent.highest, 4)});
}

/* ------------------------------------------------------- the airframe assessment */

/**
 * The airframe interlock, with the broadband term the upstream gate cannot see.
 *
 * `mechanical-spectrum.mjs`'s `tuningEvidenceGate` is `permitted` on a `clear`
 * status, and `clear` means "no persistent NARROWBAND peak reached the 8 deg/s
 * attention threshold". Nothing anywhere tests the FLOOR, so a raised noise
 * floor with no discrete line in it passes. A worn bearing, a dry damper, a
 * delaminating blade or a loose head produce exactly that, and broadband is the
 * class of mechanical fault that imitates a bad D term most closely — the one a
 * notch filter cannot touch.
 *
 * WHICH NUMBER, AND WHY NOT THE OBVIOUS ONE. `broadbandRmsDps` is the integral
 * of the whole PSD across the analysed band, so it contains the tones, the rotor
 * orders AND the pilot's own manoeuvre. It is not a floor, and an earlier
 * version of this gate treated it as one. Measured, on a synthetic flight whose
 * only unusual feature is a 14 deg/s control-loop oscillation on yaw:
 * `broadbandRmsDps` reads 0.274 / 0.273 / 24.269, where the yaw figure IS the
 * loop being measured — gating on it would have blocked the very finding it was
 * evidence for. On the reference log it reads 10.939 / 7.514 / 5.715, of which
 * the largest part is the rotor's own orders.
 *
 * The floor is `medianNoisePsdDps2PerHz`: a MEDIAN power spectral density, which
 * is robust to tones and to the manoeuvre by construction, integrated across the
 * analysed band. On the same three cases it reads 0.272 / 0.270 / 0.417 — the
 * control oscillation is invisible to it, correctly, because a tone is not a
 * floor — and 2.237 / 1.222 / 1.150 on the reference log.
 *
 * THE THRESHOLD IS NOT A NEW NUMBER. It is the same attention level the
 * narrowband peaks are held to, and against the floor it is a like-for-like
 * comparison: an amplitude of structureless noise against an amplitude of one
 * tone. The argument for reusing it is that a tone can be notched out and
 * broadband cannot, so whatever amplitude of narrowband vibration is judged
 * worth a pilot's attention, the same amplitude spread flat across the band
 * cannot be held to a looser standard.
 *
 * MEASURED CONSEQUENCE. A synthetic airframe carrying 26 deg/s of white noise on
 * all three axes and no tone anywhere reads `clear` upstream with zero
 * attention-eligible peaks and `tuningEvidenceGate` `permitted` — and this gate
 * blocks it, at a floor of 14.15 / 14.07 / 20.04 deg/s. That is the hole. The
 * reference log passes the broadband term (2.24 deg/s at worst) and is blocked
 * instead by the rotor never having been compared, which is the honest answer
 * for a whole-log range with the spool-up inside it.
 *
 * @param {object} mechanical raw result from `analyzeMechanicalSpectrum` or
 *   `analyzeMechanicalTimeSeries` — NOT `summarizeMechanicalVibration`, which
 *   publishes neither `tuningEvidenceGate` nor `medianNoisePsdDps2PerHz`
 * @param {object} [options] `{eventTimesUs}` forwarded to the upstream gate
 */
/**
 * The persistent tones on one axis, sub-threshold ones included.
 *
 * `bandRmsDps` and `harmonicMatch` come straight from the spectrum analyser;
 * nothing is recomputed here. The persistence floor is what keeps a single
 * noisy window out of a sentence a pilot will read.
 *
 * An attention-eligible peak is admitted whatever its persistence ratio. The
 * analyser only grants that status to a peak sustained across most of the
 * range, and since 2 October 2026 a main-rotor tone at that level no longer
 * blocks the airframe rung — so the tone-coincidence rule is what stands between
 * it and a gain change, and it must be able to see it.
 *
 * `rotorCompared` is whether THIS peak was tested against a rotor speed: the
 * comparison of the stretch it was measured in, when the window was measured in
 * stretches, and of the whole result otherwise. A peak from a stretch whose head
 * speed was steady was genuinely compared, whatever the stretch beside it did,
 * and "matches no rotor order" is then a measurement rather than a guess.
 */
function tonesOf(entry, toneLimits, correlation) {
  const out = [];
  for (const peak of entry?.peaks ?? []) {
    if (!Number.isFinite(peak?.frequencyHz)) {
      continue;
    }
    if (peak?.attentionEligible !== true
        && (peak?.persistenceRatio ?? 0) < toneLimits.persistenceRatioFloor) {
      continue;
    }
    const comparison = peak.chunkHarmonicCorrelation ?? correlation ?? null;
    out.push(frozen({
      axis: entry?.axis ?? null,
      frequencyHz: peak.frequencyHz,
      bandRmsDps: Number.isFinite(peak?.bandRmsDps) ? peak.bandRmsDps : null,
      bandwidthHz: Number.isFinite(peak?.bandwidthHz) ? peak.bandwidthHz : null,
      persistenceRatio: peak.persistenceRatio ?? null,
      attentionEligible: peak.attentionEligible === true,
      rotor: peak.harmonicMatch?.rotor ?? null,
      order: peak.harmonicMatch?.order ?? null,
      rotorCompared: peak.harmonicMatch ? true : comparison?.state === 'evaluated',
      chunkRangeUs: Array.isArray(peak.chunkRangeUs) ? frozen([...peak.chunkRangeUs]) : null
    }));
  }
  return out;
}

/**
 * One entry per tone, at its worst, however many stretches it was measured in.
 *
 * A window measured in stretches lists the same tone once per stretch. A tone
 * matched to a rotor order is the same tone on the same axis at the same order;
 * an unmatched one is the same tone when it sits within its own bandwidth, or
 * 2.5% — the analyser's own matching tolerance — of another on that axis. The
 * loudest copy speaks for it, carrying the stretch it was loudest in and how
 * many stretches it was seen in.
 */
function distinctTones(tones) {
  const kept = [];
  for (const tone of tones) {
    // Only copies from DIFFERENT stretches are one tone. Two peaks the analyser
    // listed separately within one analysis stay two.
    const stretch = Array.isArray(tone.chunkRangeUs) ? tone.chunkRangeUs[0] : null;
    const same = stretch === null ? null : kept.find(entry => entry.axis === tone.axis
      && !entry.stretches.includes(stretch)
      && (tone.rotor !== null
        ? entry.rotor === tone.rotor && entry.order === tone.order
        : entry.rotor === null && Math.abs(entry.frequencyHz - tone.frequencyHz)
          <= Math.max(entry.bandwidthHz ?? 0,
            0.025 * Math.min(entry.frequencyHz, tone.frequencyHz))));
    if (!same) {
      kept.push({...tone, stretches: stretch === null ? [] : [stretch]});
      continue;
    }
    const stretches = [...same.stretches, stretch];
    if ((tone.bandRmsDps ?? -Infinity) > (same.bandRmsDps ?? -Infinity)) {
      Object.assign(same, tone);
    }
    same.stretches = stretches;
  }
  return kept.map(({stretches, ...entry}) => frozen({...entry, stretchCount: stretches.length}));
}

/** " (worst in the stretch 150.0–300.0 s into the range)", or nothing. */
function stretchNote(tone, rangeStartUs, worst = true) {
  if (!Array.isArray(tone?.chunkRangeUs) || !Number.isFinite(rangeStartUs)) {
    return '';
  }
  const from = round((tone.chunkRangeUs[0] - rangeStartUs) / 1e6, 1).toFixed(1);
  const to = round((tone.chunkRangeUs[1] - rangeStartUs) / 1e6, 1).toFixed(1);
  return ` (${worst ? 'worst in' : 'in'} the stretch ${from}–${to} s into the range)`;
}

/**
 * A ROTOR-ORDER tone at the same frequency as `frequencyHz`, or null.
 *
 * THE ROTOR MATCH IS THE WHOLE RULE, and it is worth writing down why, because
 * the wider rule was tried first and was wrong. A control loop oscillating after
 * every release IS a persistent narrowband tone in the gyro — measured on this
 * repository's own too-much-D fixture it reads 25.39 Hz, 4.78 deg/s, present in
 * 82% of the analysis windows, indistinguishable in every published field from a
 * structural mode. Refusing a gain change whenever a tone coincides would
 * therefore refuse every genuine D and P finding this engine can make.
 *
 * What a loop CANNOT do is choose to oscillate at exactly the rotor's own
 * rotational frequency. When the oscillation sits on a rotor order the
 * coincidence is evidence, and it is evidence of a mechanical explanation that
 * outranks a gain. Moved to 30 Hz — 1/rev at 1800 rpm — that same fixture's peak
 * is matched `main/1` by the spectrum analyser's own harmonic test.
 *
 * THE COST, stated rather than hidden: a real D fault whose ringing happens to
 * land on a rotor order is refused a verdict and sent away with a different
 * head speed to fly. That is the right way round. The reverse error tells a
 * pilot to lower D at a shedding blade.
 */
export function coincidentTone(tones, frequencyHz, limits = TONE_LIMITS) {
  if (!Number.isFinite(frequencyHz) || frequencyHz <= 0) {
    return null;
  }
  for (const tone of tones ?? []) {
    if (!Number.isFinite(tone?.frequencyHz) || tone?.rotor === null
        || tone?.rotor === undefined) {
      continue;
    }
    const tolerance = Math.max(
      tone.bandwidthHz ?? 0, limits.coincidenceFraction * frequencyHz
    );
    if (Math.abs(tone.frequencyHz - frequencyHz) <= tolerance) {
      return tone;
    }
  }
  return null;
}

/**
 * A tone at `frequencyHz` that matches NO rotor order, or null.
 *
 * The mirror of `coincidentTone`. That one finds the coincidence that is
 * evidence; this one finds the coincidence that is merely a warning, so a
 * verdict can name it instead of quietly stepping over it.
 */
export function unmatchedTone(tones, frequencyHz, limits = TONE_LIMITS) {
  if (!Number.isFinite(frequencyHz) || frequencyHz <= 0) {
    return null;
  }
  for (const tone of tones ?? []) {
    if (!Number.isFinite(tone?.frequencyHz) || tone?.rotor !== null && tone?.rotor !== undefined) {
      continue;
    }
    const tolerance = Math.max(
      tone.bandwidthHz ?? 0, limits.coincidenceFraction * frequencyHz
    );
    if (Math.abs(tone.frequencyHz - frequencyHz) <= tolerance) {
      return tone;
    }
  }
  return null;
}

/**
 * The caveat that rides with every oscillation-based gain verdict.
 *
 * THE ENGINE CANNOT SEPARATE THESE TWO THINGS INSIDE ONE LOG, and until this
 * existed it did not say so. A lightly damped structural mode — a dry bearing,
 * a loose mount, a tired damper — re-excited by every release produces a
 * narrowband oscillation after each input, quiet while the command is held,
 * repeatable in both directions. So does a derivative term with too much gain.
 * Measured on this repository's own genuine too-much-D fixture the ring reads
 * 25.39 Hz, 4.78 deg/s, present in 82% of the analysis windows and matching no
 * rotor order: indistinguishable in every published field from a structural
 * mode.
 *
 * `coincidentTone` catches the one case where the coincidence IS evidence,
 * because a control loop cannot choose to oscillate at exactly the rotor's
 * turning speed. Off a rotor order nothing gives that leverage, and the verdict
 * still has to be made — refusing on any coincident tone would refuse every
 * genuine D and P finding this engine can produce.
 *
 * What is available instead is the NEXT flight. Lowering the gain one step is
 * already the confirmation step; what was missing is telling the pilot what the
 * other outcome means. An oscillation that keeps its frequency and its size
 * after a gain change was never that gain, and a pilot who keeps lowering D
 * into an airframe fault is chasing a symptom of something that is getting
 * worse. That sentence is the whole point of this function.
 */
export function airframeAmbiguity(tones, frequencyHz) {
  const tone = unmatchedTone(tones, frequencyHz);
  const sighting = tone
    ? `The spectrum on this axis does carry a persistent tone at ${round(tone.frequencyHz, 1)} Hz `
      + `(${round(tone.bandRmsDps, 2)} deg/s), matching no rotor order — which is equally `
      + 'consistent with the loop ringing and with the airframe ringing. '
    : 'No airframe tone was measured at that frequency, which makes the loop the better '
      + 'explanation but does not settle it: a mode excited only by a release need not show '
      + 'up as a steady tone across the whole flight. ';

  return {
    code: tone ? 'AIRFRAME_MODE_NOT_EXCLUDED_TONE_PRESENT' : 'AIRFRAME_MODE_NOT_EXCLUDED',
    sentence: 'ONE FLIGHT CANNOT RULE OUT THE AIRFRAME. A lightly damped mechanical mode — a '
      + 'dry bearing, a loose mount, a tired damper — re-excited by every release looks the '
      + `same to this engine as a gain that is too high. ${sighting}`
      + 'The gain is the cheaper and more likely of the two, which is why it is named first, '
      + 'and the flight below tells the two apart.',
    confirmSentence: 'If instead the oscillation comes back at the SAME frequency and the same '
      + 'size, it was never that gain. Stop changing it, put the gain back where it was, and '
      + 'inspect the aircraft — blade tracking, damper condition, bearings, head play and '
      + 'anything loose. A gain lowered to mask a mechanical fault leaves you with less '
      + 'control authority and the fault still there.',
    tone
  };
}

export function assessAirframe(mechanical, options = {}) {
  const upstream = evaluateAirframeGate(mechanical, options);
  const toneLimits = {...TONE_LIMITS, ...options.toneLimits};
  const codes = [...upstream.codes];
  const threshold = mechanical?.attentionThreshold?.bandRmsDps ?? null;
  const band = mechanical?.analyzedBandHz ?? null;
  const bandwidthHz = Array.isArray(band) && band.length === 2
    && Number.isFinite(band[0]) && Number.isFinite(band[1])
    ? band[1] - band[0]
    : null;

  const axes = [];
  for (const entry of mechanical?.axes ?? []) {
    // The FLOOR, not the total. A median PSD carries no tone and no manoeuvre;
    // integrating it across the analysed band turns it back into a deg/s figure
    // that can be compared with the attention level like for like.
    const psd = Number.isFinite(entry?.medianNoisePsdDps2PerHz)
      ? entry.medianNoisePsdDps2PerHz : null;
    const floor = psd !== null && Number.isFinite(bandwidthHz) && bandwidthHz > 0
      ? Math.sqrt(psd * bandwidthHz)
      : null;
    const overThreshold = floor !== null && Number.isFinite(threshold) && floor >= threshold;
    axes.push(frozen({
      axis: entry?.axis ?? null,
      gyroSource: entry?.source ?? entry?.gyroSource ?? null,
      available: entry?.available === true,
      /** The structureless part of the spectrum, in deg/s across the band. */
      broadbandNoiseRmsDps: floor === null ? null : round(floor, 3),
      medianNoisePsdDps2PerHz: psd,
      /** Total band power, published beside it so the two are never confused. */
      totalBandRmsDps: Number.isFinite(entry?.broadbandRmsDps) ? entry.broadbandRmsDps : null,
      broadbandOverAttentionThreshold: overThreshold,
      narrowbandPeakCount: (entry?.peaks ?? []).length,
      attentionPeakCount: (entry?.peaks ?? [])
        .filter(peak => peak?.attentionEligible === true || peak?.aboveAttentionThreshold === true)
        .length,
      /**
       * Every persistent tone on this axis, whether or not it reached the
       * attention level. The upstream analysis discards the harmonic match of a
       * sub-threshold peak entirely — `MAIN_ROTOR_HARMONIC_CORRELATION` is only
       * raised when `hasAttentionPeak` is already true — so a tone positively
       * identified as a rotor order can be present, measured, named, and never
       * mentioned. Carrying it here is what lets the finding layer say what was
       * actually seen instead of "a positive measurement of absence".
       */
      tones: frozen(tonesOf(entry, toneLimits, mechanical?.harmonicCorrelation ?? null))
    }));
  }

  // Absence has to be measured, not assumed. An axis whose floor was never
  // produced cannot support "the airframe is clear", and saying so is the whole
  // difference between this gate and the one upstream.
  const unmeasured = axes
    .filter(entry => entry.broadbandNoiseRmsDps === null).map(entry => entry.axis);
  const elevated = axes
    .filter(entry => entry.broadbandOverAttentionThreshold).map(entry => entry.axis);

  // Not raised when the analysis is absent entirely: "you have not run the
  // vibration check" and "the check ran and could not measure one axis" are
  // different problems with different fixes, and stacking both on one screen
  // reads as two faults where there is one.
  if (unmeasured.length > 0
      || (axes.length === 0 && !upstream.codes.includes('MECHANICAL_ANALYSIS_ABSENT'))) {
    codes.push('BROADBAND_NOT_MEASURED');
  }
  if (elevated.length > 0) {
    codes.push('BROADBAND_ABOVE_ATTENTION_THRESHOLD');
  }

  // Tones under the attention level are NOT a reason to block. A once-per-rev
  // is present on every helicopter ever built, and a gate that refused one would
  // refuse every flight. They are a reason not to claim absence, and a reason
  // not to blame a gain for an oscillation sitting on top of one — which is why
  // they travel in their own field rather than in `codes`.
  const subThresholdTones = [];
  for (const entry of axes) {
    for (const tone of entry.tones) {
      if (!tone.attentionEligible) {
        subThresholdTones.push(tone);
      }
    }
  }

  return frozen({
    gate: 'airframe',
    status: codes.length === 0 ? 'permitted' : 'blocked',
    codes: frozen(codes),
    upstream,
    attentionThresholdDps: threshold,
    attentionThresholdBasis: mechanical?.attentionThreshold?.basis ?? null,
    analyzedBandwidthHz: bandwidthHz,
    axes: frozen(axes),
    unmeasuredAxes: frozen(unmeasured),
    elevatedAxes: frozen(elevated),
    /** Measured, named, and below the attention level. Not a blocker. */
    subThresholdTones: frozen(subThresholdTones),
    /**
     * Main-rotor 1/rev and 2/rev above the experimental attention level, when
     * they are ALL that is above it. Not a blocker either, by owner decision of
     * 2 October 2026; see `rotorOrderToneAssessment` in the gates module.
     */
    rotorOrderTones: upstream.measured?.rotorOrderTonesOnly === true
      ? upstream.measured.rotorOrderTones : frozen([]),
    /**
     * The same tones, when they are all that is above the level but one of them
     * is past the severity ceiling. A blocker, not an observation.
     */
    rotorOrderTonesLarge: upstream.measured?.rotorOrderTonesLarge ?? frozen([]),
    rotorOrderToneCeilingDps: upstream.measured?.rotorOrderToneCeilingDps ?? null,
    /** Why the rotor-order rule did not apply, when it was asked. */
    rotorOrderRefusal: upstream.measured?.rotorOrderRefusal ?? null,
    observations: frozen([
      ...(upstream.observations ?? []),
      ...(subThresholdTones.length > 0 ? ['PERSISTENT_TONE_BELOW_ATTENTION_THRESHOLD'] : [])
    ])
  });
}

/** "once-per-rev", "twice-per-rev", "3 times-per-rev" */
function perRev(order) {
  if (order === 1) {
    return 'once-per-rev';
  }
  return order === 2 ? 'twice-per-rev' : `${order} times-per-rev`;
}

/** "29.3 Hz on roll, the main rotor's once-per-rev, at 4.6 deg/s" */
function describeTone(tone) {
  const where = tone.axis ? ` on ${tone.axis}` : '';
  const order = tone.rotor && Number.isFinite(tone.order)
    ? `, which is the ${tone.rotor} rotor's ${perRev(tone.order)}`
    : '';
  const size = Number.isFinite(tone.bandRmsDps) ? `, at ${round(tone.bandRmsDps, 1)} deg/s` : '';
  return `${round(tone.frequencyHz, 1)} Hz${where}${order}${size}`;
}

/* ------------------------------------------------------ the headspeed assessment */

/**
 * The governor rung, and the reason it does NOT gate on a whole-flight spread.
 *
 * `EVIDENCE_LIMITS.maximumHeadspeedVariationRatio` is 0.05, and it is derived
 * for a HOLD WINDOW — five seconds of steady flight, over which 5% of movement
 * would put governor activity into a measurement of the tune. Applying it to a
 * whole flight is a category error, and this module got it wrong first:
 *
 *   reference log, whole range          span ratio 1.088 (the recording starts
 *                                       before the rotor does; almost all of
 *                                       that is the 0 to 1705 rpm spool-up)
 *   same log, samples above the floor    p95-p5 spread 0.551 (the spool-up is
 *                                       still 15% of the samples, so it reaches
 *                                       inside the fifth percentile)
 *   same log, after the spool-up         about 0.07, and the flight is fine
 *
 * No number in this repository derives a whole-flight limit, and inventing one
 * would be a threshold with no basis deciding whether a pilot gets any advice at
 * all. So the ENFORCEMENT lives at the scale where the limit is derived, and it
 * is already there and already working:
 *
 *   holds  `measureHold` rejects a hold whose head speed moved more than 5%
 *          across it, as HOLD_HEADSPEED_UNSTABLE / HOLD_HEADSPEED_INVALID
 *   stops  `evaluateHeadspeedGate` compares the head speed of the stops being
 *          compared, between directions and within each event
 *
 * What this function adds is the whole-flight PICTURE, published so it can be
 * read beside those refusals, plus the one whole-flight verdict that does have a
 * derivation: whether the head speed moving is what cost the flight its holds.
 * A flight whose steady segments were mostly thrown away for head speed is a
 * flight whose governor is the finding, and that refusal count is currently
 * discarded as noise rather than reported.
 */
export function assessHeadspeed(records, options = {}) {
  const limits = {...EVIDENCE_LIMITS, ...options.limits};
  const values = finite((records ?? []).map(record => record?.headspeed));

  if (values.length === 0) {
    return frozen({
      gate: 'headspeed',
      status: 'blocked',
      codes: frozen(['HEADSPEED_NOT_LOGGED']),
      measured: frozen({})
    });
  }

  const spinning = values.filter(value =>
    value >= limits.minimumPlausibleHeadspeedRpm && value <= limits.maximumPlausibleHeadspeedRpm);

  const wholeMedian = quantile(values, 0.5);
  const wholeExtent = extentOf(values);
  const wholeSpan = (wholeExtent.highest - wholeExtent.lowest) / Math.abs(wholeMedian || 1);

  const codes = [];
  let steadySpread = null;
  let steadyMedian = null;
  let afterSpoolUpSpread = null;
  let spoolUpEndTimeUs = null;
  if (spinning.length < 2) {
    codes.push('HEADSPEED_NEVER_SPUN_UP');
  } else {
    steadyMedian = quantile(spinning, 0.5);
    steadySpread = Math.abs(steadyMedian) === 0
      ? null
      : (quantile(spinning, 0.95) - quantile(spinning, 0.05)) / Math.abs(steadyMedian);

    // The same spread with the spool-up cut off, which is the number a pilot
    // means when he asks whether the governor held. The cut is the first sample
    // that reaches within a hold window's worth of the eventual median — a
    // definition, not a threshold: everything before it is the rotor arriving.
    const arrival = steadyMedian * (1 - limits.maximumHeadspeedVariationRatio);
    const after = [];
    let arrived = false;
    for (const record of records ?? []) {
      const value = record?.headspeed;
      if (!Number.isFinite(value)) {
        continue;
      }
      if (!arrived && value >= arrival) {
        arrived = true;
        spoolUpEndTimeUs = record.timeUs ?? null;
      }
      if (arrived) {
        after.push(value);
      }
    }
    if (after.length >= 2) {
      const median = quantile(after, 0.5);
      afterSpoolUpSpread = Math.abs(median) === 0
        ? null
        : (quantile(after, 0.95) - quantile(after, 0.05)) / Math.abs(median);
    }
  }

  // How many steady segments the head speed cost this flight, summed across the
  // axes the caller measured. This IS at hold scale, so the 5% limit applies.
  //
  // CORRECTED 2 October 2026, in three ways, after one NaN from an RPM sensor
  // blocked every gain on every axis and told the pilot his governor wandered:
  //
  //   1. The share is over every segment the engine EVALUATED — the holds it
  //      measured as well as the ones it refused. It used to be over the
  //      refusals alone, so three good holds and one refused read 1/1, "most".
  //   2. Only HOLD_HEADSPEED_UNSTABLE is the head speed moving. HOLD_HEADSPEED_
  //      INVALID is a reading that was missing or impossible — a sensor that lost
  //      its signal, a logging dropout — and says nothing about the governor. It
  //      is counted and reported on its own, never as movement.
  //   3. One segment is not "most" of anything. At least `minimumHolds` must have
  //      been evaluated: the same count the I term needs before it is read.
  //
  // CORRECTED AGAIN the same day, after review, in two more ways:
  //
  //   4. A segment is a PHYSICAL stretch of steady flight, counted once. The app
  //      analyses roll, pitch and yaw over the same records, and a still hover is
  //      a hold on all three, so one hover with the head speed moving read "3 of
  //      the 3 steady segments" — the minimum above defeated in the app's own
  //      shape, and the same flight read differently when the app had memory for
  //      only one axis. Given `holdWindows`, the windows of every axis are merged
  //      where they overlap and each merged stretch is one segment.
  //   5. Only a segment whose head speed was actually READ counts towards the
  //      share and the minimum. `measureHold` checks the sample gap, the window
  //      and the other axes' input before it ever looks at the head speed, so a
  //      segment refused for off-axis input says nothing about the governor and
  //      used to be counted as if it had held.
  const segments = countHeadspeedSegments(options);
  const headspeedMoved = segments.moved;
  const headspeedReadingLost = segments.readingLost;
  const totalRejected = segments.unused;
  const totalAccepted = segments.accepted;
  const evaluated = segments.read;
  const headspeedCostShare = evaluated === 0 ? null : headspeedMoved / evaluated;
  if (headspeedMoved > 0 && evaluated >= limits.minimumHolds && headspeedCostShare >= 0.5) {
    // At least half of the steady segments this flight had, it lost to the
    // rotor speed moving during otherwise steady flight. That is the governor,
    // at the scale the 5% limit was derived for, and it is a finding rather
    // than a discarded reason code.
    codes.push('HEADSPEED_COST_THIS_FLIGHT_ITS_HOLDS');
  }

  return frozen({
    gate: 'headspeed',
    status: codes.length === 0 ? 'permitted' : 'blocked',
    codes: frozen(codes),
    measured: frozen({
      holdWindowLimit: limits.maximumHeadspeedVariationRatio,
      sampleCount: values.length,
      spinningSampleCount: spinning.length,
      wholeRangeMedianRpm: round(wholeMedian, 2),
      wholeRangeSpanRatio: round(wholeSpan, 5),
      steadyStateMedianRpm: round(steadyMedian, 2),
      steadyStateSpreadRatio: round(steadySpread, 5),
      afterSpoolUpSpreadRatio: round(afterSpoolUpSpread, 5),
      spoolUpEndTimeUs,
      spreadBasis: 'p95 minus p5 over samples above the plausible floor, over the median. '
        + 'Includes the spool-up when the recording starts before the rotor does, and is '
        + 'published rather than gated on for exactly that reason; '
        + 'afterSpoolUpSpreadRatio is the same figure with the arrival cut off.',
      // Every count below is of steady SEGMENTS — physical stretches of steady
      // flight, once each however many axes saw them — when the caller passed
      // `holdWindows`, as buildRecommendations does. See `segmentCounting`.
      /**
       * Segments LOST to the head speed moving: HOLD_HEADSPEED_UNSTABLE on some
       * axis, and no hold measured anywhere in the segment. The share is over these.
       */
      holdsRejectedForHeadspeed: headspeedMoved,
      /**
       * Segments in which the head speed moved across one axis's hold while
       * another axis measured a hold over a stretch where it held. Not in the
       * count above, and not in the share. Null when the windows were not given.
       */
      holdsMovedWithAHoldUsedInside: segments.movedWithAHoldUsed,
      /** Segments in which the reading was missing or impossible (HOLD_HEADSPEED_INVALID). */
      holdsRejectedForHeadspeedReading: headspeedReadingLost,
      /** Segments whose head speed was examined and that no axis measured. */
      holdsRejectedTotal: totalRejected,
      /** Segments that at least one axis measured. */
      holdsAccepted: totalAccepted,
      /** Segments whose head speed was READ: the share and the minimum are over these. */
      holdsEvaluated: evaluated,
      minimumHoldsEvaluated: limits.minimumHolds,
      headspeedShareOfEvaluatedHolds: round(headspeedCostShare, 4),
      segmentCounting: segments.counting
    })
  });
}

/**
 * Hold refusals that were reached only after the head speed had been read
 * across the window, in `measureHold`'s order. Anything refused earlier — too
 * short, a sample gap, the other axes moving — never had its head speed looked
 * at, and says nothing about the governor.
 */
const HEAD_SPEED_READ_OUTCOMES = Object.freeze(new Set([
  'accepted', 'HOLD_HEADSPEED_UNSTABLE', 'HOLD_BATTERY_UNSTABLE'
]));
const HEAD_SPEED_EXAMINED_OUTCOMES = Object.freeze(new Set([
  ...HEAD_SPEED_READ_OUTCOMES, 'HOLD_HEADSPEED_INVALID'
]));

/**
 * Steady segments for the governor rung, counted once each.
 *
 * With `holdWindows` — `{axis, startTimeUs, endTimeUs, outcome}`, outcome being
 * 'accepted' or the refusal code — every window whose head speed was examined is
 * merged with any other it overlaps, on any axis, and each merged stretch is one
 * segment: it MOVED if the head speed moved across any window in it, its reading
 * was LOST if any window in it had an impossible sample, and it was READ if some
 * window in it read the head speed all the way through. A window refused before
 * the head speed was examined (off-axis input, a sample gap) is left out of the
 * merge, so it can neither glue two hovers into one nor count as a hover held.
 *
 * Without windows — the older call shape, counts per axis — the axes cannot be
 * matched up, so each category is the LARGEST any one axis saw: a lower bound on
 * the physical count, which can only make the two-segment minimum harder to
 * meet, never easier.
 */
function countHeadspeedSegments(options) {
  if (Array.isArray(options.holdWindows)) {
    const windows = options.holdWindows
      .filter(window => HEAD_SPEED_EXAMINED_OUTCOMES.has(window?.outcome)
        && Number.isFinite(window.startTimeUs) && Number.isFinite(window.endTimeUs))
      .sort((left, right) => left.startTimeUs - right.startTimeUs);
    const merged = [];
    for (const window of windows) {
      const last = merged[merged.length - 1];
      if (last && window.startTimeUs <= last.endTimeUs) {
        last.endTimeUs = Math.max(last.endTimeUs, window.endTimeUs);
        last.outcomes.add(window.outcome);
      } else {
        merged.push({
          startTimeUs: window.startTimeUs,
          endTimeUs: window.endTimeUs,
          outcomes: new Set([window.outcome])
        });
      }
    }
    const count = test => merged.filter(segment => test(segment.outcomes)).length;
    return {
      counting: 'physical',
      // LOST to head speed: it moved, and no axis measured a hold anywhere in the
      // segment (review of 3 October 2026). This is the count the governor share
      // is taken over. A segment in which one axis was refused for head speed
      // while another measured a hold at a steady head speed was not lost — the
      // hold was used — and counting it here once blocked every gain on a flight
      // of two such hovers, "2 of the 2", while both had given a measurement.
      moved: count(outcomes => outcomes.has('HOLD_HEADSPEED_UNSTABLE')
        && !outcomes.has('accepted')),
      // A segment can be both (round three): one axis's hold moved with the head
      // speed and was refused, another axis's hold inside the same stretch held
      // its head speed all the way through and was measured. Reported on its
      // own, never in the share.
      movedWithAHoldUsed: count(outcomes => outcomes.has('HOLD_HEADSPEED_UNSTABLE')
        && outcomes.has('accepted')),
      readingLost: count(outcomes => outcomes.has('HOLD_HEADSPEED_INVALID')),
      accepted: count(outcomes => outcomes.has('accepted')),
      unused: count(outcomes => !outcomes.has('accepted')),
      read: count(outcomes => [...outcomes].some(outcome => HEAD_SPEED_READ_OUTCOMES.has(outcome)))
    };
  }

  const largest = {moved: 0, readingLost: 0, accepted: 0, unused: 0, read: 0};
  const axes = new Set([
    ...Object.keys(options.holdRejections ?? {}),
    ...Object.keys(options.acceptedHolds ?? {})
  ]);
  const positive = value => (Number.isFinite(value) && value > 0 ? value : 0);
  for (const axis of axes) {
    const refused = options.holdRejections?.[axis] ?? {};
    const moved = positive(refused.HOLD_HEADSPEED_UNSTABLE);
    const lost = positive(refused.HOLD_HEADSPEED_INVALID);
    const battery = positive(refused.HOLD_BATTERY_UNSTABLE);
    const accepted = positive(options.acceptedHolds?.[axis]);
    largest.moved = Math.max(largest.moved, moved);
    largest.readingLost = Math.max(largest.readingLost, lost);
    largest.accepted = Math.max(largest.accepted, accepted);
    largest.unused = Math.max(largest.unused, moved + lost + battery);
    largest.read = Math.max(largest.read, accepted + moved + battery);
  }
  // Counts per axis cannot be matched up, so whether a segment was both is unknown.
  return {counting: 'largest-axis', ...largest, movedWithAHoldUsed: null};
}

/* ------------------------------------------------------------ the hold assessment */

/**
 * The I-term reading, with the two things `interpretHoldEvidence` cannot do.
 *
 * FIRST, the bind discriminator. `interpretHoldEvidence` reads only the error —
 * never `iTermMean`, which `measureHold` already reports — so an aircraft with a
 * binding linkage arrives at it as a standing error and leaves as "increase I".
 * The separation is free and sits in data already in the window: too little I
 * shows a standing error with a SMALL I term that is not going anywhere; a bind
 * shows the same error with the I term wound LARGE and still growing against it,
 * because the loop is fighting something it cannot beat. That is not a gain
 * fault and more I will not fix it.
 *
 * SECOND, the stability sweep. The audit of this repository measured the
 * reference log's pitch verdict flipping between `hold` and `decrease` across
 * both the smoothing length and `huntingRippleDps`, with the shipped values
 * sitting inside the only window that says `decrease`. `HOLD_SWEEP` brackets
 * both, evidence is REBUILT at each smoothing length (the crossing rate is a
 * property of the filter, not of the interpretation), and a verdict that is not
 * unanimous is not emitted.
 *
 * THIRD, a confirmation the module could always have had: whether the I term
 * actually moves with the error. In-band hunting blamed on the I term should
 * show the I term oscillating with the error it is integrating. That correlation
 * is one dot product over samples already in the hold window.
 */
export function assessHoldIndication(records, axis, options = {}) {
  const baseLimits = {...EVIDENCE_LIMITS, ...options.limits};
  const grid = options.grid ?? HOLD_SWEEP;

  const evidence = buildHoldEvidence(records, {axis, term: 'I'}, {limits: baseLimits});
  const shipped = interpretHoldEvidence(evidence, options.interpretOptions);

  const codes = [...shipped.codes];
  const indications = new Set();
  let sweepRuns = 0;
  let abstained = 0;

  // What the aircraft actually did, measured once at the shipped filter. Used
  // below to decide which filter lengths are even capable of seeing it.
  const observedCrossingRateHz = evidence.summary?.meanErrorCrossingRateHz ?? null;

  if (evidence.status === 'captured') {
    for (const huntingSmoothingUs of grid.huntingSmoothingUs) {
      // A box average of length L has its -3 dB corner at 0.443/L, so a filter
      // longer than that cannot see this oscillation at all. A point that cannot
      // see the thing under test ABSTAINS; it does not vote "no".
      //
      // This distinction is the difference between a gate and a refusal. Without
      // it, any hunt above about 1.5 Hz would be blocked by the longest filter in
      // the grid every time — not because two readings disagreed about the
      // aircraft, but because one of them was too blunt to look. With it, the
      // grid still catches the case the gate exists for: the reference log's
      // pitch verdict, which flips between `hold` and `decrease` across filter
      // lengths that can ALL see its 2.59-a-second crossing rate.
      //
      // The corner is a FREQUENCY and the crossing rate counts half-cycles, so
      // the rate is halved before the two are compared (2 October 2026). Before
      // that, a 0.8 Hz hunt — 1.6 crossings a second — was abstained on by the
      // 300 ms filter, whose corner is 1.48 Hz and which sees it plainly; and
      // the reference pitch's 2.59 crossings, a 1.3 Hz oscillation, was abstained
      // on at 222 and 300 ms. Not re-measured on the reference log since.
      //
      // Applied ONLY when the shipped reading was "the I term is causing an
      // oscillation", because that is the only reading whose evidence IS the
      // crossing rate. A standing error is a standing error at any filter
      // length, and abstaining on it would silence the one branch this engine
      // most needs: an aircraft with a standing error and no integrator to
      // close it produces a crossing rate of numerical dither (78 Hz on the
      // closed-loop fixture, from an error that never moves), which no filter
      // in the grid can "observe" and which has nothing to do with the verdict.
      const observableTopHz = 0.443 / (huntingSmoothingUs / 1_000_000);
      if (shipped.indication === 'decrease'
          && Number.isFinite(observedCrossingRateHz)
          && observedCrossingRateHz / CROSSINGS_PER_CYCLE > observableTopHz) {
        abstained += 1;
        continue;
      }
      const rebuilt = buildHoldEvidence(records, {axis, term: 'I'}, {
        limits: {...baseLimits, huntingSmoothingUs}
      });
      for (const huntingRippleDps of grid.huntingRippleDps) {
        const verdict = interpretHoldEvidence(rebuilt, {
          ...(options.interpretOptions ?? {}),
          huntingRippleDps
        });
        indications.add(verdict.indication);
        sweepRuns += 1;
      }
    }
  }

  const stable = indications.size === 1;
  if (evidence.status === 'captured' && !stable) {
    codes.push('HOLD_VERDICT_FLIPS_ACROSS_SWEEP');
  }
  if (evidence.status === 'captured' && sweepRuns === 0) {
    // Every filter length in the grid was too blunt to see it. Nothing was
    // tested, which must not read the same as everything agreeing.
    codes.push('HOLD_SWEEP_COULD_NOT_OBSERVE_THE_OSCILLATION');
  }

  // Is the I term oscillating too? Reported always so its absence is visible,
  // gated on only when the verdict is "the I term is causing an oscillation".
  const smoothingUs = evidence.measurement?.huntingSmoothingUs ?? baseLimits.huntingSmoothingUs;
  const iTermCoupling = measureITermCoupling(records, axis, evidence, smoothingUs);

  // How much of the output the integrator actually is. See the docstring on
  // `measureITermAuthority` and on AUTHORITY_LIMITS.
  const authorityLimits = {...AUTHORITY_LIMITS, ...options.authorityLimits};
  const authority = measureITermAuthority(records, axis, evidence, smoothingUs);

  // The bind discriminator, applied before any direction is read.
  const summary = evidence.summary;
  const bindLimits = {...BIND_LIMITS, ...options.bindLimits};
  let bind = null;
  if (summary) {
    const error = summary.meanAbsoluteSteadyStateErrorDps ?? 0;
    const iRms = Math.abs(summary.meanITermRms ?? 0);
    const iDrift = Math.abs(summary.meanITermDriftPerSecond ?? 0);
    const growing = iDrift >= bindLimits.minimumITermDriftPerSecond;
    const woundUp = iDrift > 0 && iRms >= iDrift * bindLimits.windUpToDriftRatio;
    const standingError = error > bindLimits.errorDpsThreshold;

    // SECOND SIGNATURE, added 13 August 2026. The one above needs the I term to
    // be still WINDING, and every real flight controller clamps its integrator,
    // so it switches itself off at precisely the moment the loop has finished
    // losing. A large integrator that has stopped moving while an error stands
    // is arithmetically impossible unless it is pinned: dI/dt = ki * error.
    const pinned = standingError
      && authority.available
      && Number.isFinite(authority.meanITermTravelShare)
      && authority.meanITermTravelShare <= authorityLimits.iTermTravelShare
      && Number.isFinite(authority.meanITermToPTermRatio)
      && authority.meanITermToPTermRatio >= authorityLimits.iTermToPTermRatio;

    const winding = standingError && growing && woundUp;
    bind = frozen({
      suspected: winding || pinned,
      pattern: winding ? 'winding' : (pinned ? 'pinned' : null),
      meanAbsoluteSteadyStateErrorDps: error,
      meanITermRms: summary.meanITermRms ?? null,
      meanITermDriftPerSecond: summary.meanITermDriftPerSecond ?? null,
      meanITermTravelShare: authority.meanITermTravelShare,
      meanITermToPTermRatio: authority.meanITermToPTermRatio,
      errorDpsThreshold: bindLimits.errorDpsThreshold
    });
    if (winding) {
      codes.push('STANDING_ERROR_WITH_WOUND_UP_I_TERM');
    }
    if (pinned) {
      codes.push('STANDING_ERROR_WITH_A_PINNED_I_TERM');
    }
  }

  const swept = evidence.status === 'captured' && stable && sweepRuns > 0;
  let indication = swept ? shipped.indication : 'hold';
  let confidence = swept ? shipped.confidence : 'none';
  if (bind?.suspected) {
    // A bind outranks the gain reading entirely. The finding built from this
    // names the linkage, not a term.
    indication = 'hold';
    confidence = 'none';
  }
  if (indication === 'decrease') {
    const ratio = iTermCoupling.meanCrossingRateRatio;
    const tolerance = options.iTermCrossingRateTolerance ?? 2;
    const matched = Number.isFinite(ratio) && ratio >= 1 / tolerance && ratio <= tolerance;
    if (!matched) {
      // The error is wandering and the I term is not going with it, so whatever
      // is moving the aircraft, the integrator is not carrying it.
      codes.push('I_TERM_DOES_NOT_OSCILLATE_WITH_THE_ERROR');
      indication = 'hold';
      confidence = 'none';
    }
  }
  if (indication === 'decrease') {
    // AND is it large enough for lowering it to change anything? The crossing
    // rates above match for ANY external periodic disturbance, because the
    // integral of a periodic error is periodic at the same frequency whoever is
    // driving the aircraft. This is the size test that the rate test cannot do.
    if (!authority.available) {
      codes.push('I_TERM_NOT_LOGGED');
      indication = 'hold';
      confidence = 'none';
    } else if (!Number.isFinite(authority.meanITermShareOfOutputRipple)
        || authority.meanITermShareOfOutputRipple < authorityLimits.iTermShareOfOutputRipple) {
      codes.push('I_TERM_TOO_SMALL_A_SHARE_OF_THE_OUTPUT');
      indication = 'hold';
      confidence = 'none';
    }
  }
  if (indication === 'increase' && !authority.available) {
    // "The I term is small and is not winding up against it" is the whole
    // reasoning behind raising I, and it is a claim about the I term. A log that
    // did not record one cannot support it.
    codes.push('I_TERM_NOT_LOGGED');
    indication = 'hold';
    confidence = 'none';
  }

  return frozen({
    axis,
    evidence,
    shippedIndication: shipped.indication,
    shippedConfidence: shipped.confidence,
    indication,
    confidence,
    codes: frozen(codes),
    sweepStable: stable,
    sweepIndicationsSeen: frozen([...indications]),
    sweepRunCount: sweepRuns,
    sweepAbstainedFilterCount: abstained,
    observedCrossingRateHz,
    bind,
    iTermCoupling,
    iTermAuthority: authority,
    holdCount: evidence.holds.length,
    minimumHolds: baseLimits.minimumHolds
  });
}

/**
 * Whether the I term is actually carrying the oscillation it is being blamed for.
 *
 * The obvious test — correlate the I term against the error — is WRONG, and it
 * is worth writing down why, because it looks right. The I term is the integral
 * of the error, so during a clean oscillation it is a quarter cycle out of
 * phase with it, and a plain Pearson correlation between them is close to ZERO
 * exactly when the integrator is most clearly the cause. A gate on that number
 * would reject every genuine case and pass the ambiguous ones.
 *
 * What does discriminate is whether the I term is OSCILLATING TOO, at the same
 * rate. If the error wanders and the I term sits still, whatever is moving the
 * aircraft is not the integrator. If the error is broadband noise, its integral
 * is a random walk and crosses its own mean far less often than the error does.
 * So the test is a match of crossing rates, measured on the same smoothed
 * signals the hold evidence used, plus a requirement that the I term's own
 * ripple is not negligible.
 */
function measureITermCoupling(records, axis, evidence, smoothingUs) {
  const index = axisIndexOf(axis);
  const perHold = [];
  if (index !== -1) {
    for (const hold of evidence?.holds ?? []) {
      const from = firstAtOrAfter(records, hold.measureStartTimeUs);
      const to = lastAtOrBefore(records, hold.endTimeUs);
      if (to - from < 16) {
        continue;
      }
      const times = [];
      const errors = [];
      const terms = [];
      for (let step = from; step <= to; step += 1) {
        const setpoint = records[step]?.setpoint?.[index];
        const gyro = records[step]?.gyro?.[index];
        const term = records[step]?.terms?.[1];
        if (Number.isFinite(setpoint) && Number.isFinite(gyro) && Number.isFinite(term)) {
          times.push(records[step].timeUs);
          errors.push(setpoint - gyro);
          terms.push(term);
        }
      }
      if (times.length < 16) {
        continue;
      }
      const intervals = times.slice(1).map((value, at) => value - times[at]);
      const medianInterval = quantile(intervals, 0.5);
      const window = Number.isFinite(medianInterval) && medianInterval > 0
        ? Math.max(1, Math.round(smoothingUs / medianInterval))
        : 1;
      const smoothedError = movingAverage(errors, window);
      const smoothedTerm = movingAverage(terms, window);
      const errorRate = zeroCrossingRateHz(times, centre(smoothedError));
      const termRate = zeroCrossingRateHz(times, centre(smoothedTerm));
      perHold.push(frozen({
        errorCrossingRateHz: round(errorRate, 4),
        iTermCrossingRateHz: round(termRate, 4),
        iTermRippleRms: round(rms(centre(smoothedTerm)), 4),
        // Reported because it is informative, NEVER gated on: see the docstring.
        plainCorrelation: round(correlation(errors, terms), 4)
      }));
    }
  }

  const rates = perHold.filter(entry =>
    Number.isFinite(entry.errorCrossingRateHz) && entry.errorCrossingRateHz > 0);
  const ratios = rates.map(entry => entry.iTermCrossingRateHz / entry.errorCrossingRateHz);
  const meanRatio = ratios.length === 0 ? null : mean(ratios);

  return frozen({
    perHold: frozen(perHold),
    meanCrossingRateRatio: round(meanRatio, 4),
    meanITermRippleRms: perHold.length === 0
      ? null : round(mean(perHold.map(entry => entry.iTermRippleRms)), 4),
    meanPlainCorrelation: perHold.length === 0
      ? null : round(mean(perHold.map(entry => entry.plainCorrelation)), 4)
  });
}

function centre(values) {
  const middle = mean(values) ?? 0;
  return values.map(value => value - middle);
}

/**
 * Whether the I term is BIG ENOUGH TO BE THE ANSWER, in both directions.
 *
 * ADDED 13 AUGUST 2026. `measureITermCoupling` above answers "is the integrator
 * moving with the error", and an adversarial review showed that question has the
 * same answer for an integrator driving an oscillation and an integrator riding
 * one — the integral of a periodic error is periodic at the same frequency
 * whoever is moving the aircraft. What separates them is SIZE, and size is
 * measurable without knowing a single gain, because the P, I and D terms are
 * logged in the same units as each other.
 *
 * Three ratios, all unit-free:
 *
 *  `iTermTravelShare`  the I term's whole excursion across a hold over its own
 *      magnitude. An unsaturated integrator facing a standing error MUST move —
 *      dI/dt = ki * error — so a large I term that does not move while an error
 *      stands is one pinned at the controller's `iterm_limit`, which RotorLens
 *      cannot see and every real flight controller has.
 *
 *  `iTermToPTermRatio`  I-term RMS over P-term RMS. This is what "the I term is
 *      small" has to mean when the scaling is unknown.
 *
 *  `iTermShareOfOutputRipple`  the I term's ripple over the whole output's
 *      ripple, both measured through the same filter the hold verdict was
 *      measured through. This is the effect size behind "lower I and the wander
 *      should shrink": if the integrator is a tenth of the output's movement, it
 *      is a passenger, and lowering it cannot deliver what the sentence promises.
 *
 * `available` is false when the log carries no P/I/D terms at all, and that is
 * treated downstream as a reason to say nothing rather than as a pass.
 */
function measureITermAuthority(records, axis, evidence, smoothingUs) {
  const index = axisIndexOf(axis);
  const perHold = [];
  let sawFiniteTerms = false;
  let sawNonZeroTerms = false;

  if (index !== -1) {
    for (const hold of evidence?.holds ?? []) {
      const from = firstAtOrAfter(records, hold.measureStartTimeUs);
      const to = lastAtOrBefore(records, hold.endTimeUs);
      if (to - from < 16) {
        continue;
      }
      const times = [];
      const errors = [];
      const pTerms = [];
      const iTerms = [];
      const outputs = [];
      for (let step = from; step <= to; step += 1) {
        const setpoint = records[step]?.setpoint?.[index];
        const gyro = records[step]?.gyro?.[index];
        const terms = records[step]?.terms;
        const p = terms?.[0];
        const i = terms?.[1];
        const d = terms?.[2];
        if (!Number.isFinite(setpoint) || !Number.isFinite(gyro)
            || !Number.isFinite(p) || !Number.isFinite(i) || !Number.isFinite(d)) {
          continue;
        }
        sawFiniteTerms = true;
        if (p !== 0 || i !== 0 || d !== 0) {
          sawNonZeroTerms = true;
        }
        times.push(records[step].timeUs);
        errors.push(setpoint - gyro);
        pTerms.push(p);
        iTerms.push(i);
        outputs.push(p + i + d);
      }
      if (times.length < 16) {
        continue;
      }

      const intervals = times.slice(1).map((value, at) => value - times[at]);
      const medianInterval = quantile(intervals, 0.5);
      const window = Number.isFinite(medianInterval) && medianInterval > 0
        ? Math.max(1, Math.round(smoothingUs / medianInterval))
        : 1;

      // Travel is measured over the SECOND HALF of the hold, and the magnitude
      // over all of it. The first half of any hold contains the integrator
      // arriving — winding up to whatever value it is going to sit at — and an
      // integrator that arrives at its clamp travels while it arrives. Measuring
      // the arrival and calling it "still integrating" is how a clamp at four
      // units read 0.31 of travel and escaped this test. Over the second half a
      // clamped integrator is flat and a working one is still climbing.
      //
      // p95 - p05 rather than max - min: one sample of telemetry noise is not an
      // integrator travelling.
      const secondHalf = iTerms.slice(Math.floor(iTerms.length / 2));
      const iSpan = quantile(secondHalf, 0.95) - quantile(secondHalf, 0.05);
      const iMagnitude = Math.max(Math.abs(mean(iTerms) ?? 0), rms(iTerms) ?? 0);
      const pRms = rms(pTerms) ?? 0;
      const iRms = rms(iTerms) ?? 0;
      const iRipple = rms(centre(movingAverage(iTerms, window))) ?? 0;
      const outputRipple = rms(centre(movingAverage(outputs, window))) ?? 0;

      perHold.push(frozen({
        measuredDurationUs: hold.measuredDurationUs ?? (times[times.length - 1] - times[0]),
        meanAbsoluteErrorDps: round(mean(errors.map(Math.abs)), 4),
        iTermTravelShare: iMagnitude > 0 ? round(Math.abs(iSpan) / iMagnitude, 4) : null,
        iTermToPTermRatio: pRms > 0 ? round(iRms / pRms, 4) : null,
        iTermShareOfOutputRipple: outputRipple > 0 ? round(iRipple / outputRipple, 4) : null
      }));
    }
  }

  const across = field => {
    const values = perHold.map(entry => entry[field]).filter(Number.isFinite);
    const weights = perHold
      .filter(entry => Number.isFinite(entry[field]))
      .map(entry => entry.measuredDurationUs);
    return values.length === 0 ? null : round(weightedMean(values, weights), 4);
  };

  return frozen({
    available: sawFiniteTerms && sawNonZeroTerms && perHold.length > 0,
    perHold: frozen(perHold),
    meanITermTravelShare: across('iTermTravelShare'),
    meanITermToPTermRatio: across('iTermToPTermRatio'),
    meanITermShareOfOutputRipple: across('iTermShareOfOutputRipple')
  });
}

/* ------------------------------------------------------------------- findings */

let findingCounter = 0;

function makeFinding(fields) {
  findingCounter += 1;
  const finding = {
    id: fields.id,
    rung: fields.rung,
    rungOrder: rungOrder(fields.rung),
    axis: fields.axis ?? null,
    kind: fields.kind,
    // What to adjust. A physical thing for a blocker, a term for an adjustment,
    // null for anything that is not asking for a change.
    adjust: fields.adjust ?? null,
    // The only place in this module a direction may appear, and only on an
    // `adjustment`. Asserted by the guard in test/recommendations.test.mjs.
    direction: fields.kind === 'adjustment' ? (fields.direction ?? null) : null,
    confidence: fields.confidence ?? 'none',
    headline: fields.headline,
    reasoning: fields.reasoning,
    // The measurements this rests on, in a form a pilot can check against the
    // trace he is looking at. Never empty on an adjustment or a blocker.
    basis: frozen((fields.basis ?? []).map(entry => frozen({...entry}))),
    // What to fly next. On an adjustment this confirms it worked; on a
    // next-flight finding it is the manoeuvre that separates the candidates.
    confirm: fields.confirm ?? null,
    // Named when the evidence does not separate the causes. Two or more entries
    // is why `direction` is null on a next-flight finding.
    candidates: frozen(fields.candidates ?? []),
    codes: frozen(fields.codes ?? []),
    // Set later by `orderFindings`; at most one finding in a result has it.
    actNow: false,
    sequence: findingCounter
  };
  return frozen(finding);
}

function basisEntry(label, value, unit, source) {
  return {label, value, unit: unit ?? null, source};
}

/* ------------------------------------------------------------- axis assessment */

/**
 * Everything the gates and findings need for one axis, from records alone.
 *
 * Exposed so a caller does not have to know the assembly order, and so tests can
 * build the same material for a synthetic flight as for a real one.
 */
export function analyseAxisEvidence(records, axis, options = {}) {
  const diagnostics = detectStopEvents(records, {
    ...(options.detectOptions ?? {}), axis, diagnostics: true
  });
  const evidence = buildDirectionalStopEvidence(diagnostics.events, {axis});
  const capture = describeStopCapture(diagnostics, {axis});
  const shapes = diagnostics.events.map(event => frozen({
    stopTimeUs: event.stopTimeUs,
    commandSign: event.commandSign,
    event,
    shape: measureStopShape(records, event, axis, options.detectOptions),
    tracking: measureTrackingShape(records, event, axis, options.detectOptions)
  }));
  return frozen({axis, diagnostics, events: diagnostics.events, evidence, capture, shapes});
}

function directionShapes(shapes, direction) {
  return shapes.filter(entry => entry.commandSign === direction);
}

/* ---------------------------------------------------------------- the engine */

/**
 * The ordered findings for one analysed log.
 *
 * @param {object} input
 * @param {object} input.axes            `{roll, pitch, yaw}` of `analyseAxisEvidence`
 *   results, or of `{records, ...}` material. Axes that are absent are skipped.
 * @param {object[]} input.records       records for the whole log, used for the
 *   headspeed rung and the hold windows. When axes carry their own records those
 *   are preferred, because `buildAnalysisRecords` is per-axis.
 * @param {object} input.mechanical      raw `analyzeMechanicalSpectrum` result
 * @param {object} [input.axisSummaries] `summarizeAxis` per axis, for the
 *   FILTERED high-frequency noise floor. The stop metrics are computed on
 *   filtered gyro, so the unfiltered broadband figure is the wrong floor to
 *   deconvolve them against — it is the right number for "is the machine
 *   shaking", and the wrong one for "can this metric be read".
 * @param {object} [input.options]       `{detectorGrid, holdGrid}`. Stability
 *   sweeps are mandatory and cannot be bypassed by a caller.
 *
 * There is deliberately no history or sensitivity parameter. Everything this
 * function concludes is a question about THIS log, and every gate above is a
 * question about THIS log; a model of other flights has no standing to answer
 * one. What the pilot's own flights have taught is published separately, by
 * `buildSensitivityModel`, beside the flights that taught it.
 */
export function buildRecommendations(input = {}) {
  const options = input.options ?? {};
  const findings = [];
  const withheld = [];
  const axes = input.axes ?? {};
  const mechanical = input.mechanical ?? null;

  const eventTimesUs = [];
  for (const axis of AXES) {
    for (const event of axes[axis]?.events ?? []) {
      if (Number.isFinite(event?.stopTimeUs)) {
        eventTimesUs.push(event.stopTimeUs);
      }
    }
  }

  const anyRecords = input.records
    ?? axes.roll?.records ?? axes.pitch?.records ?? axes.yaw?.records ?? [];

  /* -------- hold evidence first, because the governor rung reads its refusals */
  const holds = {};
  const holdRejections = {};
  // The holds that WERE measured, so the governor rung can judge what share of
  // the flight's steady segments the head speed cost — not what share of its
  // refusals.
  const acceptedHolds = {};
  const holdWindows = [];
  if (!options.skipHolds) {
    for (const axis of AXES) {
      if (!axes[axis]) {
        continue;
      }
      holds[axis] = assessHoldIndication(
        axes[axis].records ?? anyRecords, axis, options.holdOptions
      );
      holdRejections[axis] = holds[axis].evidence.rejectedHoldCounts;
      acceptedHolds[axis] = holds[axis].evidence.holds?.length ?? 0;
      // Where each of them was, so one hover seen by three axes is one segment.
      for (const window of holds[axis].evidence.holds ?? []) {
        holdWindows.push({axis, startTimeUs: window.startTimeUs, endTimeUs: window.endTimeUs,
          outcome: 'accepted'});
      }
      for (const window of holds[axis].evidence.rejectedHolds ?? []) {
        holdWindows.push({axis, startTimeUs: window.startTimeUs, endTimeUs: window.endTimeUs,
          outcome: window.reason});
      }
    }
  }

  const holdTimesUs = [];
  for (const hold of Object.values(holds)) {
    for (const window of hold?.evidence?.holds ?? []) {
      for (const timeUs of [window.startTimeUs, window.endTimeUs]) {
        if (Number.isFinite(timeUs)) {
          holdTimesUs.push(timeUs);
        }
      }
    }
  }

  /* -------- rung: airframe */
  const airframe = assessAirframe(mechanical, {eventTimesUs, holdTimesUs});
  findings.push(...airframeFindings(airframe, mechanical));

  /* -------- rung: headspeed */
  const headspeed = assessHeadspeed(anyRecords,
    {...options, holdRejections, acceptedHolds, holdWindows});
  findings.push(...headspeedFindings(headspeed));

  /* -------- per axis */
  const perAxis = {};
  for (const axis of AXES) {
    const material = axes[axis];
    if (!material) {
      continue;
    }
    const records = material.records ?? anyRecords;
    const summary = input.axisSummaries?.[axis] ?? null;
    const result = axisFindings({
      axis, material, records, summary, airframe, mechanical,
      hold: holds[axis] ?? null, holdTimesUs, options
    });
    perAxis[axis] = result;
    findings.push(...result.findings);
    withheld.push(...result.withheld);
  }

  const ordered = orderFindings(findings, {airframe, headspeed});
  const returnedSequences = new Set(ordered.map(finding => finding.sequence));
  const blockers = findings.filter(finding => finding.kind === 'blocker');
  for (const candidate of findings) {
    if (candidate.kind !== 'adjustment' || returnedSequences.has(candidate.sequence)) {
      continue;
    }
    const blockerAbove = blockers.some(blocker =>
      blocker.rungOrder < candidate.rungOrder
      && (blocker.axis === null || blocker.axis === candidate.axis));
    withheld.push(frozen({
      findingId: candidate.id,
      rung: candidate.rung,
      axis: candidate.axis,
      reason: blockerAbove ? 'BLOCKER_ABOVE' : 'ONE_CHANGE_AT_A_TIME',
      sentence: blockerAbove
        ? `${candidate.id} was measured on ${candidate.axis} but a higher safety rung blocked it.`
        : `${candidate.id} was measured on ${candidate.axis} but another single change was selected first.`
    }));
  }

  return frozen({
    schemaVersion: RECOMMENDATIONS_SCHEMA_VERSION,
    kind: 'rotorlens-recommendations',
    findings: frozen(ordered),
    withheld: frozen(withheld),
    gates: frozen({airframe, headspeed, holds: frozen(holds), axes: frozen(perAxis)}),

    /**
     * Always empty, and the empty array is the contract rather than a stage.
     *
     * The owner asked for what to adjust and which way, and nothing in a log
     * this module can see defends an AMOUNT: the metrics a magnitude would be
     * derived from move by factors of three to six across constants nobody
     * derived, and no controller scaling is recoverable from a Blackbox log. A
     * number from a rule of thumb would be a guess with a decimal point on it.
     *
     * A previous revision of this file accepted an `input.sensitivity` model and
     * ran it through a 518-line admission gate. That gate was removed, and the
     * removal is the point rather than a retreat: NOTHING EVER CALLED IT. Its
     * fifteen refusal clauses read producer-declared scalars — how the fit was
     * selected, whether the baseline was pooled, whether the pilot rather than
     * the app chose the change — and no stored record carries any of those
     * facts, so no honest producer could ever have filled them in. An
     * unreachable gate whose clauses cannot be evaluated is not a safety net; it
     * is an assurance that reads as one, which is worse than none. What the
     * pilot's own flights teach is published by `buildSensitivityModel` beside
     * those flights, as a measurement of the past, and is gated where it is
     * produced by conditions that are computed from the points themselves.
     */
    magnitudes: frozen([]),
    magnitudeBasis: null,

    boundary: 'RotorLens reads logs. It never writes to a flight controller. Every '
      + 'finding above names the measurement it rests on so you can check it against '
      + 'the trace, and one change at a time is what makes the next flight tell you '
      + 'anything.'
  });
}

/* ------------------------------------------------------------ rung: airframe */

/**
 * Why a vibration check could not measure, in the order a pilot can act on it.
 *
 * The first code present wins. Codes that mean "this stretch was too long" come
 * last: the whole-window analysis splits a long flight, so on the app's own path
 * they should not occur, and if one does it is the least informative reason.
 */
const NOT_MEASURED_REASONS = Object.freeze([
  {
    codes: ['GYRO_FIELDS_MISSING'],
    phrase: 'the log carries no gyro column for at least one axis',
    confirm: 'Turn gyro logging on in the Blackbox field set — gyroRAW or gyroUnfilt — and '
      + 'fly the same manoeuvres again.'
  },
  {
    codes: ['SAMPLE_RATE_UNAVAILABLE'],
    phrase: 'its sample rate could not be established, or is under the 50 samples a second '
      + 'a vibration measurement needs',
    confirm: 'Log at a higher Blackbox rate — a vibration measurement wants hundreds of '
      + 'samples a second — and fly the same manoeuvres again.'
  },
  {
    codes: ['SAMPLE_RATE_LIMIT_EXCEEDED'],
    phrase: 'its sample rate is above the 8 kHz the analysis accepts',
    confirm: 'Log at a Blackbox rate of 8 kHz or less and fly the same manoeuvres again.'
  },
  {
    codes: ['NON_MONOTONIC_TIMESTAMPS'],
    phrase: 'its timestamps go backwards',
    confirm: 'A log whose clock runs backwards cannot be transformed. Fly again and measure '
      + 'the new log.'
  },
  {
    codes: ['TIMING_GAPS_EXCESSIVE'],
    phrase: 'the log has gaps in its sampling too large to measure across, which is usually '
      + 'the logging storage falling behind',
    confirm: 'Fly again with a lower Blackbox logging rate, or faster logging storage, and '
      + 'measure that log.'
  },
  {
    codes: ['INSUFFICIENT_TIMESTAMPED_SAMPLES'],
    phrase: 'it is too short, with too few samples to measure',
    confirm: 'Measure a longer stretch of steady flight — tens of seconds, not a moment.'
  },
  {
    codes: [
      'INSUFFICIENT_CONTIGUOUS_GYRO_DATA', 'VALID_WINDOW_COVERAGE_INSUFFICIENT',
      'FINITE_GYRO_SAMPLE_COVERAGE_INSUFFICIENT', 'FINITE_GYRO_TIME_SPAN_COVERAGE_INSUFFICIENT',
      'SELECTED_TIMESTAMP_SPAN_COVERAGE_INSUFFICIENT', 'GYRO_COVERAGE_INSUFFICIENT'
    ],
    phrase: 'too little of it carries continuous gyro data',
    confirm: 'Measure a stretch of flight where the gyro is logged without dropouts.'
  },
  {
    codes: [
      'SELECTION_SAMPLE_LIMIT_EXCEEDED', 'SELECTION_DURATION_LIMIT_EXCEEDED',
      'RESAMPLED_SAMPLE_LIMIT_EXCEEDED'
    ],
    phrase: 'a stretch of it is longer than one vibration analysis accepts',
    confirm: 'Measure a shorter stretch of the flight.'
  }
]);

function notMeasuredBecause(reasonCodes) {
  const known = NOT_MEASURED_REASONS.flatMap(entry => entry.codes);
  const codes = (reasonCodes ?? []).filter(code => known.includes(code));
  const entry = NOT_MEASURED_REASONS.find(candidate =>
    candidate.codes.some(code => codes.includes(code)));
  return entry
    ? {phrase: entry.phrase, confirm: entry.confirm, codes}
    : {
      phrase: 'it did not produce a measurement on every axis',
      confirm: 'Measure a stretch of steady flight with unfiltered gyro logged throughout.',
      codes
    };
}

/** Why the rotor was not compared, worded from the measured reason. */
const ROTOR_NOT_COMPARED_WORDING = Object.freeze({
  NOT_EVALUATED: {
    why: 'the vibration check could not measure this range, so it never got as far as '
      + 'reading the rotor speed',
    detail: 'This follows from the measurement that failed above; it is not a second fault. '
      + 'Once the vibration check can measure the range, the rotor comparison runs with it.',
    confirm: 'Nothing separate to fly for this: it clears when the vibration check can measure '
      + 'the range.'
  },
  FIELD_MISSING: {
    why: 'this log does not record head speed',
    detail: 'Matching a tone to a rotor order needs the speed the rotor turned at, and without '
      + 'a head-speed column there is nothing to match against.',
    confirm: 'Add head speed to the Blackbox field set, make sure the RPM sensor reads, and '
      + 'fly again.'
  },
  NO_VALID_RPM_IN_RANGE: {
    why: 'there is no usable rotor speed in the head-speed column across it',
    detail: 'The column is in the log, but every reading in this range is zero or impossible — '
      + 'the rotor was not turning, or the RPM sensor was not reading.',
    confirm: 'Check that the RPM sensor reads in flight, and measure a range where the rotor is '
      + 'up to speed.'
  },
  INSUFFICIENT_COVERAGE: {
    why: 'head speed was recorded for too little of it',
    detail: 'Most of the range has to carry a usable head-speed reading before a tone can be '
      + 'matched to a rotor order, and this one did not.',
    confirm: 'Measure a range where head speed is logged throughout, and check the RPM sensor '
      + 'if it drops out.'
  },
  RPM_OUT_OF_RANGE: {
    why: 'the head-speed readings across it are outside what the comparison accepts',
    detail: 'A median head speed under 100 rpm or over 50,000 rpm is not a rotor turning at '
      + 'flight speed.',
    confirm: 'Check how the RPM sensor is set up, and fly again.'
  },
  RPM_UNSTABLE_IN_SELECTION: {
    why: 'the head speed moved too much across it',
    detail: 'The head speed has to be steady across the range before a peak can be matched to '
      + 'a rotor order, and on this range it was not — usually because the spool-up is inside '
      + 'the selection.',
    confirm: 'Select a range after the spool-up and before the descent, where the head speed '
      + 'is steady, and run the vibration check on that.'
  },
  default: {
    why: 'no head speed across it was usable for the comparison',
    detail: 'Without a usable rotor speed, no tone can be matched to a rotor order.',
    confirm: 'Measure a range where head speed is logged and steady.'
  }
});

/**
 * The same reasons, said about the part of a window that was NOT compared, when
 * other stretches of it were. The reason is the combined one the analyser
 * publishes, which names the measured cause before "not read".
 */
const ROTOR_NOT_COMPARED_REST = Object.freeze({
  NOT_EVALUATED: 'the vibration check could not measure it, so its rotor speed was never read',
  FIELD_MISSING: 'no head speed was recorded',
  NO_VALID_RPM_IN_RANGE: 'there is no usable rotor speed in the head-speed column',
  INSUFFICIENT_COVERAGE: 'head speed was recorded for too little of it',
  RPM_OUT_OF_RANGE: 'the head-speed readings are outside what the comparison accepts',
  RPM_UNSTABLE_IN_SELECTION: 'the head speed moved too much',
  default: 'no head speed was usable for the comparison'
});

/**
 * Why the rest of the advice can be read over a range whose rotor-order tones
 * all ARE the main rotor's, but the rule still did not apply — worded from the
 * refusal the gate measured rather than from a list of possibilities.
 */
const ROTOR_ORDER_REFUSAL_WORDING = Object.freeze({
  STRETCH_NOT_MEASURED: 'part of the range could not be measured',
  ROTOR_NOT_COMPARED: 'the rotor speed could not be compared against the vibration across all '
    + 'of the range',
  REASON_CODE_OUTSIDE_ALLOW_LIST: 'the vibration check flagged something else about the range '
    + 'as well',
  AXIS_NOT_MEASURED_ON_UNFILTERED_GYRO: 'not every axis was measured on unfiltered gyro',
  ATTENTION_PEAK_LIST_INCOMPLETE: 'the spectrum held attention-level peaks too close together '
    + 'to list separately, so not every one of them could be checked against the rotor',
  TONE_SIZE_NOT_MEASURED: 'the size of one of the tones was not measured',
  ATTENTION_THRESHOLD_UNKNOWN: 'the attention level it was judged against did not come with '
    + 'the result'
});

/** What makes measured vibration "unexplained", from the tones that carried it. */
function unexplainedBecause(attentionTones, airframe) {
  const parts = [];
  // Per tone, not per range: in a window measured in stretches a tone from a
  // stretch whose head speed was steady WAS compared, whatever the next one did.
  if (attentionTones.some(tone => tone.rotor === null && tone.rotorCompared)) {
    parts.push('a tone that matches no rotor order');
  }
  if (attentionTones.some(tone => tone.rotor === null && !tone.rotorCompared)) {
    parts.push('a tone that could not be compared against the rotor at all');
  }
  if (attentionTones.some(tone => tone.rotor === 'tail')) {
    parts.push('a tone on the tail rotor');
  }
  if (attentionTones.some(tone => tone.rotor === 'main' && tone.order > 2)) {
    parts.push('a higher order of the main rotor than once or twice per rev');
  }
  if (parts.length > 0) {
    return `Above the attention level it carries ${parts.join(', and ')}.`;
  }
  if (attentionTones.length > 0) {
    const why = ROTOR_ORDER_REFUSAL_WORDING[airframe.rotorOrderRefusal]
      ?? 'the rest of the check did not hold';
    return 'What it measured lines up with the main rotor\'s once- or twice-per-rev, but '
      + `${why}, so "only the rotor" is not established.`;
  }
  return 'The vibration check reported attention-level vibration it did not attribute to the main '
    + 'rotor\'s once- or twice-per-rev.';
}

/**
 * The strongest tone, judged — as the ceiling is — on its size WHILE PRESENT,
 * and that size over the published level. Round 3 of the 2 October 2026 review:
 * the flight average a tone present part of the time is pulled down by its quiet
 * stretches, so a card about a tone "above the level" could state "0.6 times" it.
 * The size while present is at least the level by construction, so the ratio
 * here never reads under one.
 */
function toneAgainstLevel(airframe, tones) {
  const sorted = [...tones].sort((left, right) =>
    (right.aboveLevelBandRmsDps ?? 0) - (left.aboveLevelBandRmsDps ?? 0));
  const strongest = sorted[0];
  const threshold = airframe.attentionThresholdDps;
  const ratio = Number.isFinite(threshold) && threshold > 0
    && Number.isFinite(strongest.aboveLevelBandRmsDps)
    ? round(strongest.aboveLevelBandRmsDps / threshold, 1) : null;
  return {sorted, strongest, ratio};
}

/** "13.6 deg/s on roll at 1800 rpm", the tone's size while present. */
function toneSize(tone) {
  return `${round(tone.aboveLevelBandRmsDps, 1)} deg/s on ${tone.axis}`
    + (Number.isFinite(tone.headspeedRpm) ? ` at ${tone.headspeedRpm} rpm` : '');
}

/** What a tone's share and average are OF: the range, or the stretch it was worst in. */
function toneScope(tone) {
  if (!Array.isArray(tone.chunkRangeUs)) {
    return 'the range';
  }
  return (tone.chunkRangesUs ?? []).length > 1
    ? 'the stretch it was worst in' : 'the stretch it was measured in';
}

/**
 * "it was above it for 32% of the range, and averaged 14.9 deg/s over all of it"
 * — how long the strongest tone was there, and the flight average its size while
 * present is NOT, stated beside it so neither is mistaken for the other.
 */
function tonePresence(tone, aboveIt) {
  const share = Number.isFinite(tone.aboveLevelShare)
    ? Math.round(tone.aboveLevelShare * 100) : null;
  const average = Number.isFinite(tone.bandRmsDps) ? round(tone.bandRmsDps, 1) : null;
  if (share === null || average === null) {
    return '';
  }
  return `; it was above ${aboveIt} for ${share}% of ${toneScope(tone)}, and averaged ${average} `
    + 'deg/s over all of it';
}

/** One basis row per distinct tone, its size while present, naming the stretch it was worst in. */
function rotorToneBasis(tones, rangeStartUs, suffix = '') {
  return tones.slice(0, 6).map(tone => basisEntry(
    `${tone.axis}: main rotor ${perRev(tone.order)}, band RMS while above the attention level`
      + suffix + stretchNote(tone, rangeStartUs, (tone.chunkRangesUs ?? []).length > 1),
    round(tone.aboveLevelBandRmsDps, 3), 'deg/s',
    `RMS over the analysis windows in which the spectrum peak at ${round(tone.frequencyHz, 1)} Hz `
    + `reached the attention level; matched to main-rotor order ${tone.order}`
    + `${Number.isFinite(tone.headspeedRpm) ? ` at ${tone.headspeedRpm} rpm` : ''}`
  ));
}

/** The strongest tone's share of the range above the level, and its average over all of it. */
function strongestToneBasis(tone) {
  const scope = toneScope(tone) === 'the range' ? 'the range' : 'its stretch';
  return [
    basisEntry(`strongest tone, share of ${scope} above the attention level`,
      Number.isFinite(tone.aboveLevelShare) ? Math.round(tone.aboveLevelShare * 100) : null, '%',
      'analysis windows in which its band reached the attention level'),
    basisEntry(`strongest tone, band RMS averaged over all of ${scope}`,
      Number.isFinite(tone.bandRmsDps) ? round(tone.bandRmsDps, 3) : null, 'deg/s',
      'Welch average over every analysis window, the windows it was absent from included')
  ];
}

/**
 * Main-rotor 1/rev and 2/rev above the experimental level, said as a measurement.
 *
 * OWNER DECISION, 2 October 2026. The 8 deg/s level is calibrated on synthetic
 * signals and is crossed on 32 of 33 real flights, mostly by exactly these tones.
 * So when they are all that crosses it, this rung reports them — axis, order,
 * size, head speed, and the threshold with its basis — at low confidence, and
 * does not hold the rest of the advice back on their account. It is an
 * observation, never a blocker and never the first thing to act on.
 *
 * Emitted ONLY when the airframe rung is otherwise permitted. Beside another
 * airframe blocker, "this does not hold the rest back" would be false, so the
 * tones go into that blocker's basis instead. And it states the size and the
 * ratio as numbers: an earlier plain-English line called every such tone "a
 * little above" the level, whatever it measured.
 */
function rotorOrderToneFinding(airframe, basis) {
  const {sorted: tones, strongest, ratio} = toneAgainstLevel(airframe, airframe.rotorOrderTones);
  const others = tones.length - 1;
  const orders = [...new Set(tones.map(tone => tone.order))].sort();
  const threshold = Number.isFinite(airframe.attentionThresholdDps)
    ? `${airframe.attentionThresholdDps} deg/s` : 'attention';
  const rangeStartUs = airframe.upstream.measured?.rangeStartTimeUs ?? null;
  return makeFinding({
    id: 'AIRFRAME_ROTOR_ORDER_TONE',
    rung: 'airframe',
    kind: 'observation',
    confidence: 'low',
    // Its size WHILE PRESENT, that over the level, and how long it was present
    // for beside its flight average — never the average alone, which for a tone
    // present part of the time reads under the level it was above.
    headline: `The main rotor's ${perRev(strongest.order)} measured ${toneSize(strongest)} `
      + `while it was above an experimental ${threshold} level`
      + (ratio !== null ? `, ${ratio} times that level` : '')
      + tonePresence(strongest, 'it')
      + (others > 0
        ? `; ${others} more main-rotor ${others === 1 ? 'tone is' : 'tones are'} listed below`
        : '')
      + '.',
    reasoning: 'This is a measurement, not a verdict. Everything above the attention level on '
      + 'this flight is the main rotor\'s own once- or twice-per-rev, measured on unfiltered '
      + 'gyro and matched against the logged head speed. The '
      + `${threshold} level is experimental: it was calibrated on synthetic signals and `
      + 'has not yet been validated on a known out-of-track aircraft, and on real flights '
      + 'tones like this one cross it more often than not. So, up to '
      + `${Number.isFinite(airframe.rotorOrderToneCeilingDps)
        ? `${airframe.rotorOrderToneCeilingDps} deg/s while present, three times that level,`
        : 'three times that level while present,'}`
      + ' such a tone is reported here rather than holding back the rest of the analysis; '
      + 'past that it would block. Where an oscillation on one axis sits '
      + 'on top of one of these tones, that axis is refused on its own card rather than '
      + 'blamed on a gain.',
    basis: [
      ...rotorToneBasis(tones, rangeStartUs),
      basisEntry('strongest tone against the experimental level', ratio, 'times',
        'its band RMS while above the attention level, over the attention threshold'),
      ...strongestToneBasis(strongest),
      basisEntry('head speed the strongest tone was matched against', strongest.headspeedRpm,
        'rpm', 'logged head speed, through the spectrum analyser\'s rotor-order match'),
      basisEntry('severity ceiling for a main-rotor tone', airframe.rotorOrderToneCeilingDps,
        'deg/s', 'three times the attention threshold (recommendation-gates.mjs); a safety '
        + 'backstop, not a calibration'),
      ...basis
    ],
    confirm: 'Blade tracking or balance is the usual cause of a once- or twice-per-rev tone, '
      + 'so checking both is where to start. Fly the same flight after the blades are '
      + 'tracked and balanced: if this tone drops, it was the blades.',
    codes: [
      'MAIN_ROTOR_ORDER_TONE_ABOVE_EXPERIMENTAL_THRESHOLD',
      ...orders.map(order => `MAIN_ROTOR_ORDER_${order}`)
    ]
  });
}

/**
 * Main-rotor 1/rev or 2/rev past the severity ceiling: a blocker, said as its size.
 *
 * Decided 2 October 2026 as a safety refinement of the owner's rotor-order rule.
 * The rule exists because an 8 deg/s level calibrated on synthetic signals was
 * refusing nearly every real flight over tones of 10 to 17 deg/s. It was never
 * meant to wave through a 40 deg/s once-per-rev, which is the size of a head
 * badly out of track or balance. So past three times the level the tone blocks
 * every gain again — as the rotor's own measured tone, not as "unexplained".
 */
function rotorOrderToneLargeFinding(airframe, basis) {
  const {sorted: tones, strongest, ratio} = toneAgainstLevel(airframe, airframe.rotorOrderTonesLarge);
  const orders = [...new Set(tones.map(tone => tone.order))].sort();
  const threshold = Number.isFinite(airframe.attentionThresholdDps)
    ? `${airframe.attentionThresholdDps} deg/s` : 'attention';
  const ceiling = airframe.rotorOrderToneCeilingDps;
  const rangeStartUs = airframe.upstream.measured?.rangeStartTimeUs ?? null;
  return makeFinding({
    id: 'AIRFRAME_ROTOR_ORDER_TONE_LARGE',
    rung: 'airframe',
    kind: 'blocker',
    adjust: 'airframe',
    confidence: 'medium',
    headline: `The main rotor's ${perRev(strongest.order)} measured ${toneSize(strongest)} `
      + `while it was above the experimental ${threshold} level — ${ratio} times that level, `
      + `past the ${ceiling} deg/s up to which a main-rotor tone is only reported`
      + tonePresence(strongest, 'the level') + '.',
    reasoning: 'This is the main rotor\'s own tone, measured on unfiltered gyro and matched '
      + 'against the logged head speed, and at this size it is what a head out of track or '
      + 'out of balance produces. It sits in the gyro trace under everything a gain would be '
      + 'judged on, and a gain moved to chase it leaves the aircraft exactly as it was — so no '
      + 'gain is read over it. The size is the tone\'s size while it was there, not its '
      + 'average over the whole flight, which the stretches it was absent from pull down. The '
      + 'ceiling is a safety backstop, three times an attention level that was calibrated on '
      + 'synthetic signals, not a validated limit.',
    basis: [
      ...rotorToneBasis(tones, rangeStartUs),
      basisEntry('strongest tone against the experimental level', ratio, 'times',
        'its band RMS while above the attention level, over the attention threshold'),
      ...strongestToneBasis(strongest),
      basisEntry('severity ceiling for a main-rotor tone', ceiling, 'deg/s',
        'three times the attention threshold (recommendation-gates.mjs); a safety backstop, '
        + 'not a calibration'),
      basisEntry('head speed the strongest tone was matched against', strongest.headspeedRpm,
        'rpm', 'logged head speed, through the spectrum analyser\'s rotor-order match'),
      ...basis
    ],
    confirm: 'Sort the tracking and balance before tuning: track and balance the blades, then '
      + 'fly the same flight again and compare this number. If it drops, it was the blades; if '
      + 'it does not, look at the head, the dampers and the bearings next.',
    codes: [
      'MAIN_ROTOR_ORDER_TONE_LARGE',
      ...orders.map(order => `MAIN_ROTOR_ORDER_${order}`)
    ]
  });
}

function airframeFindings(airframe, mechanical) {
  const out = [];
  const basis = [];
  for (const entry of airframe.axes) {
    basis.push(basisEntry(
      `${entry.axis} broadband noise floor`,
      entry.broadbandNoiseRmsDps,
      'deg/s',
      `median PSD of the ${entry.gyroSource ?? 'gyro'} spectrum, integrated across the `
      + 'analysed band — tones and your own inputs excluded by construction'
    ));
  }
  for (const entry of airframe.axes) {
    basis.push(basisEntry(
      `${entry.axis} total band power, for comparison`,
      entry.totalBandRmsDps, 'deg/s',
      'the whole spectrum including the rotor orders and your own inputs — NOT a floor'
    ));
  }
  if (Number.isFinite(airframe.attentionThresholdDps)) {
    basis.push(basisEntry(
      'attention threshold', airframe.attentionThresholdDps, 'deg/s',
      `mechanical-spectrum.mjs (${airframe.attentionThresholdBasis})`
    ));
  }

  // Owner decision, 2 October 2026: when everything above the experimental
  // threshold is the main rotor's own once- or twice-per-rev, it is reported as
  // a measurement and does not hold the gains back on that account. When nothing
  // else blocks the airframe it stands in for AIRFRAME_CLEAR, which would be
  // false with a tone above the threshold.
  //
  // When something ELSE blocks it, that card's "does not hold the rest back"
  // would be false, so the card is not shown — and the tones it would have named
  // go into the basis every airframe blocker below carries, so the measurement is
  // still on screen beside what does block.
  const rotorRangeStartUs = airframe.upstream.measured?.rangeStartTimeUs ?? null;
  const rotorToneRows = [];
  if ((airframe.rotorOrderTones ?? []).length > 0) {
    if (airframe.status === 'permitted') {
      out.push(rotorOrderToneFinding(airframe, basis));
      return out;
    }
    rotorToneRows.push(...rotorToneBasis(toneAgainstLevel(airframe, airframe.rotorOrderTones).sorted,
      rotorRangeStartUs, ' (a main-rotor tone; not what blocks here)'));
    basis.push(...rotorToneRows);
  }

  // Past the severity ceiling the same tones block, and say so first: they are
  // the specific, measured thing to sort before anything else on this rung.
  if ((airframe.rotorOrderTonesLarge ?? []).length > 0
      && airframe.upstream.codes.includes('MAIN_ROTOR_ORDER_TONE_LARGE')) {
    out.push(rotorOrderToneLargeFinding(airframe, basis));
  }

  // A tone that was measured, named and found small is not silence, and the old
  // wording below claimed silence. The distinction matters most exactly where it
  // was wrong: `mechanical.reasonCodes` reading
  // PERSISTENT_NARROWBAND_ENERGY_BELOW_ATTENTION_THRESHOLD while the pilot was
  // told "no persistent tone reached the attention level ... that is a positive
  // measurement of absence".
  if (airframe.status === 'permitted' && airframe.subThresholdTones.length > 0) {
    // One per tone, not one per stretch it was measured in.
    const tones = distinctTones(airframe.subThresholdTones);
    const rotorTones = tones.filter(tone => tone.rotor !== null);
    out.push(makeFinding({
      id: 'AIRFRAME_TONE_BELOW_ATTENTION',
      rung: 'airframe',
      kind: 'observation',
      confidence: 'medium',
      headline: 'The airframe is quiet enough to judge the tune over, but it is not silent: '
        + `${tones.length === 1 ? 'one tone was' : tones.length + ' tones were'} measured `
        + 'below the level worth chasing.',
      reasoning: 'Nothing here is large enough to call a fault, and none of it stops the '
        + 'tune being read. It is written down because "clean" and "nothing reached the '
        + 'threshold" are different statements, and the old wording claimed the first while '
        + 'measuring the second. Note that a control loop oscillating shows up in this list '
        + 'too — a tone is a tone, and this rung cannot tell the loop from the airframe. '
        + `${rotorTones.length > 0
          ? 'Some of this lines up with a rotor order, which is normal on a helicopter and '
            + 'worth watching only if it grows — but where it lands on top of something the '
            + 'loop is doing, it is said again on that axis, because there it stops a gain '
            + 'change being readable.'
          : 'None of it lines up with a rotor order, so if it grows, look at bearings, '
            + 'belts and anything that turns at its own speed.'}`,
      basis: [
        ...basis,
        ...tones.slice(0, 6).map(tone => basisEntry(
          `persistent tone below the attention level: ${describeTone(tone)}`
            + stretchNote(tone, rotorRangeStartUs, tone.stretchCount > 1),
          round(tone.bandRmsDps, 3), 'deg/s',
          `spectrum peak, present in ${Math.round((tone.persistenceRatio ?? 0) * 100)}% of the `
          + 'analysed windows'
        ))
      ],
      confirm: 'Nothing to fly for this. If a tone grows between flights, that is the thing '
        + 'to chase — a level is less informative than a trend.',
      codes: ['PERSISTENT_TONE_BELOW_ATTENTION_THRESHOLD']
    }));
    return out;
  }

  if (airframe.status === 'permitted') {
    out.push(makeFinding({
      id: 'AIRFRAME_CLEAR',
      rung: 'airframe',
      kind: 'observation',
      confidence: 'medium',
      headline: 'The airframe is clean enough to judge the tune over.',
      reasoning: 'The unfiltered gyro was checked across the analysed range, the rotor '
        + 'speed was steady enough for each peak to be tested against its own orders, no '
        + 'persistent tone reached the attention level, and the broadband noise floor sits '
        + 'below it too. That is a positive measurement of absence, not silence.',
      basis,
      confirm: null,
      codes: []
    }));
    return out;
  }

  if (airframe.codes.includes('BROADBAND_ABOVE_ATTENTION_THRESHOLD')) {
    out.push(makeFinding({
      id: 'AIRFRAME_BROADBAND_ELEVATED',
      rung: 'airframe',
      kind: 'blocker',
      adjust: 'airframe',
      confidence: 'medium',
      headline: `The vibration floor on ${airframe.elevatedAxes.join(' and ')} is at or above `
        + 'the level a single tone would earn attention at.',
      reasoning: 'This is a raised noise floor rather than one tone, which is what a worn '
        + 'bearing, a dry damper, a delaminating blade or a loose head produce — and it is '
        + 'the kind of vibration that imitates a badly tuned D term most closely. A tone can '
        + 'be notched out; broadband cannot, so it is held to the same level rather than a '
        + 'looser one. Nothing about the gains can be read over it.',
      basis,
      confirm: 'Check the head, blade tracking, dampers and bearings, then fly the same '
        + 'range again. If this number falls, the vibration was mechanical and the tune was '
        + 'never the problem. Measure it over a window where the head speed is steady, not '
        + 'across the spool-up.',
      codes: ['BROADBAND_ABOVE_ATTENTION_THRESHOLD']
    }));
  }

  // A filtered gyro source is one specific reason the floor could not be
  // measured, and it is the one a pilot can act on. Reported instead of the
  // generic pair, because "the vibration check did not come back clear" and
  // "your log does not contain the signal it needs" send someone to different
  // places — the workshop, or the Blackbox field set.
  const reasonCodes = mechanical?.reasonCodes ?? [];
  const filteredSource = reasonCodes.includes('FILTERED_GYRO_SOURCE_USED')
    || reasonCodes.includes('UNFILTERED_GYRO_REQUIRED_FOR_CLEAR_GATE')
    || airframe.axes.some(entry =>
      entry.available === false && typeof entry.gyroSource === 'string'
      && entry.gyroSource.includes('filtered'));

  if (filteredSource) {
    out.push(makeFinding({
      id: 'AIRFRAME_UNFILTERED_GYRO_MISSING',
      rung: 'airframe',
      kind: 'blocker',
      confidence: 'none',
      headline: 'This log has no unfiltered gyro, so the airframe cannot be ruled out from '
        + 'it at all.',
      reasoning: 'Vibration is judged on the raw gyro because the filter chain removes the '
        + 'evidence before it can be measured — on a filtered signal, "nothing found" would '
        + 'only mean "nothing was left to look at". Every gain finding stands on the '
        + 'airframe being clear, so nothing below this can be earned from this flight, '
        + 'however good the flying was.',
      basis: [
        ...basis,
        basisEntry('gyro source used', airframe.axes.map(entry => entry.gyroSource).join(', '),
          null, 'buildMechanicalSeries')
      ],
      confirm: 'Enable an unfiltered gyro field in the Blackbox field set — gyroRAW or '
        + 'gyroUnfilt — and fly the same manoeuvres again. Nothing about vibration can be '
        + 'settled from this log.',
      codes: ['BROADBAND_NOT_MEASURED']
    }));
    return out;
  }

  // MEASURED vibration, and only measured vibration. Until 2 October 2026 this
  // fired whenever the upstream gate was not `permitted`, which includes every
  // result that could not be measured at all — so a 40 Hz log was told "could
  // not be read" and, on the next card, that it was shaking. The gate now only
  // raises MECHANICAL_EVIDENCE_GATE_BLOCKED for `attention`, and the status is
  // checked here as well so the two can never drift apart again.
  const upstreamCodes = airframe.upstream.codes;
  const measuredStatus = airframe.upstream.measured?.mechanicalStatus ?? null;
  if (upstreamCodes.includes('MECHANICAL_EVIDENCE_GATE_BLOCKED') && measuredStatus === 'attention') {
    const attentionTones = airframe.axes.flatMap(entry =>
      entry.tones.filter(tone => tone.attentionEligible));
    // Every tone seen IS a main-rotor 1/rev or 2/rev, and the rotor-order rule
    // still refused: something else about the result — a stretch that could not
    // be measured, a filtered axis — means "only the rotor" was not established.
    // Said as exactly that, rather than as a tone the rotor does not explain.
    const rotorOrderNotEstablished = attentionTones.length > 0 && attentionTones.every(tone =>
      tone.rotor === 'main' && (tone.order === 1 || tone.order === 2));
    // "The rotor does not explain it" needs a tone that was COMPARED and is not
    // main 1/rev or 2/rev. Judged per tone: in a window measured in stretches, a
    // tone from a stretch whose head speed was steady was genuinely compared,
    // whatever the next stretch did. Where no such tone exists and something was
    // not compared, it is not known either way, and must not be said.
    const positivelyUnexplained = attentionTones.some(tone => tone.rotor === 'tail'
      || (tone.rotor === 'main' && tone.order > 2)
      || (tone.rotor === null && tone.rotorCompared === true));
    const notCompared = attentionTones.length > 0
      ? !positivelyUnexplained
      : airframe.upstream.measured?.harmonicCorrelationState !== 'evaluated';
    let cause = 'NOT_EXPLAINED_BY_MAIN_ROTOR_ORDER';
    if (rotorOrderNotEstablished) {
      cause = 'ROTOR_ORDER_NOT_ESTABLISHED';
    } else if (notCompared) {
      cause = 'VIBRATION_NOT_COMPARED_WITH_ROTOR';
    }
    const headlines = {
      ROTOR_ORDER_NOT_ESTABLISHED: 'The vibration check measured vibration on this range above '
        + 'the experimental attention level, and could not establish that it is only the main '
        + 'rotor\'s once- or twice-per-rev.',
      VIBRATION_NOT_COMPARED_WITH_ROTOR: 'The vibration check measured vibration on this range '
        + 'above the experimental attention level, and it could not be compared against the '
        + 'rotor speed to see whether the main rotor accounts for it.',
      NOT_EXPLAINED_BY_MAIN_ROTOR_ORDER: 'The vibration check measured vibration on this range '
        + 'that the main rotor\'s once- and twice-per-rev do not explain.'
    };
    out.push(makeFinding({
      id: 'AIRFRAME_VIBRATION_PRESENT',
      rung: 'airframe',
      kind: 'blocker',
      adjust: 'airframe',
      confidence: 'medium',
      headline: headlines[cause],
      reasoning: `${unexplainedBecause(attentionTones, airframe)} `
        + 'A tracking fault, a worn damper or a dry bearing all look like a badly tuned D term '
        + 'in the gyro trace, and moving a gain to chase one leaves the aircraft exactly as it '
        + 'was. The level it crossed is experimental — calibrated on synthetic signals, not on '
        + 'a known faulty aircraft — and is listed below beside the measurement, so the margin '
        + 'can be judged rather than taken on trust.',
      basis: [
        // One row per tone, however many stretches it was measured in.
        ...distinctTones(attentionTones).slice(0, 6).map(tone => basisEntry(
          `persistent tone above the attention level: ${describeTone(tone)}`
            + stretchNote(tone, rotorRangeStartUs, tone.stretchCount > 1),
          round(tone.bandRmsDps, 3), 'deg/s',
          `spectrum peak, present in ${Math.round((tone.persistenceRatio ?? 0) * 100)}% of the `
          + 'analysed windows'
        )),
        ...basis
      ],
      confirm: 'Sort the airframe, then fly the same manoeuvres again and compare this '
        + 'number rather than the gains.',
      // Where every tone IS the rotor's, which condition of the rule did not hold,
      // so the plain copy can say that one rather than guess.
      codes: ['MECHANICAL_EVIDENCE_GATE_BLOCKED', cause,
        ...(cause === 'ROTOR_ORDER_NOT_ESTABLISHED' && airframe.rotorOrderRefusal
          ? [airframe.rotorOrderRefusal] : [])]
    }));
  }

  // NOT MEASURED, and why. One card, naming the reason the vibration check gave,
  // because "too short", "logging dropouts" and "sample rate too low" send a pilot
  // to three different places.
  if (airframe.codes.includes('BROADBAND_NOT_MEASURED')
      || upstreamCodes.includes('MECHANICAL_EVIDENCE_NOT_MEASURED')) {
    const why = notMeasuredBecause(reasonCodes);
    const partly = Array.isArray(mechanical?.chunks)
      && mechanical.chunks.some(chunk => chunk?.status !== 'insufficient');
    out.push(makeFinding({
      id: 'AIRFRAME_BROADBAND_NOT_MEASURED',
      rung: 'airframe',
      kind: 'blocker',
      confidence: 'none',
      headline: `The vibration check could not measure ${partly ? 'part of ' : ''}this range — `
        + `${why.phrase} — so the airframe has not been ruled out.`,
      reasoning: 'A clear verdict is a positive measurement of absence. Where nothing was '
        + 'measured there is no verdict either way: this is not a finding that the aircraft '
        + 'vibrates, and it is not a clean bill of health.',
      basis: [
        basisEntry('why the vibration check could not measure',
          why.codes.length > 0 ? why.codes.join(', ') : 'no reason code was given', null,
          'mechanical-spectrum.mjs reason codes'),
        ...basis
      ],
      confirm: why.confirm,
      // The cue the plain copy reads to say "part of" too, rather than parsing
      // the headline.
      codes: ['BROADBAND_NOT_MEASURED', ...why.codes, ...(partly ? ['VIBRATION_PARTLY_MEASURED'] : [])]
    }));
  }

  if (upstreamCodes.includes('ROTOR_CORRELATION_PARTIAL')) {
    // Compared over SOME of the window. "Never compared" would be false about
    // the stretches that were — whose tones the cards beside this one name by
    // rotor order — so this says part, and why the rest was not.
    const reason = airframe.upstream.measured.headspeedReasonCode ?? null;
    const rest = ROTOR_NOT_COMPARED_REST[reason] ?? ROTOR_NOT_COMPARED_REST.default;
    const words = ROTOR_NOT_COMPARED_WORDING[reason] ?? ROTOR_NOT_COMPARED_WORDING.default;
    // Counted in the stretches the vibration check could MEASURE. Round-2 review:
    // this said "1 of the 2 stretches it was measured in" of a window whose second
    // stretch was never measured, and then said so itself.
    const compared = airframe.upstream.measured.rotorComparedStretchCount;
    const measured = airframe.upstream.measured.measuredStretchCount;
    const of = airframe.upstream.measured.stretchCount;
    out.push(makeFinding({
      id: 'AIRFRAME_ROTOR_NOT_COMPARED',
      rung: 'airframe',
      kind: 'blocker',
      confidence: 'none',
      headline: 'The vibration was compared against the rotor over only part of this range'
        + (Number.isFinite(compared) && Number.isFinite(measured) && Number.isFinite(of)
          ? ` (${compared} of the ${measured} measured ${measured === 1 ? 'stretch' : 'stretches'}`
            + `, of ${of} in all)`
          : '')
        + `: across the rest, ${rest}.`,
      reasoning: 'Over the stretches where the head speed could be used, each tone was tested '
        + 'against the rotor\'s own orders, and what that found is on the cards beside this one. '
        + 'Over the rest nothing was compared, so the airframe is not ruled out across the '
        + 'whole range: "no rotor problem found" is a statement only about what was compared.',
      basis: [
        basisEntry('stretches compared against the rotor', compared, 'count',
          'mechanical-spectrum.mjs, per stretch'),
        basisEntry('stretches the vibration check could measure', measured, 'count',
          'mechanical-spectrum.mjs, per stretch'),
        basisEntry('stretches the range was split into', of, 'count',
          'mechanical-spectrum.mjs, per stretch'),
        basisEntry('head-speed relative spread over the analysed range',
          round(airframe.upstream.measured.headspeedRelativeSpread, 4), 'ratio',
          'mechanical-spectrum.mjs rotor-speed evidence, bounded across the stretches'),
        basisEntry('why the rest could not be compared against',
          reason ?? 'no reason code was given', null,
          'mechanical-spectrum.mjs rotor-speed evidence'),
        ...basis
      ],
      confirm: reason === 'NOT_EVALUATED'
        ? 'Nothing separate to fly for this: it clears when the vibration check can measure '
          + 'the whole range.'
        : words.confirm,
      codes: ['ROTOR_CORRELATION_PARTIAL', ...(reason ? [reason] : [])]
    }));
  } else if (upstreamCodes.includes('ROTOR_CORRELATION_UNAVAILABLE')
      || upstreamCodes.includes('ROTOR_CORRELATION_NOT_ATTEMPTED')) {
    // Worded from the reason the rotor speed could not be used, not from a guess.
    // It used to say the head speed "moved too much" whatever had happened, on
    // logs with no head-speed column and on results that never read it.
    const notAttempted = upstreamCodes.includes('ROTOR_CORRELATION_NOT_ATTEMPTED');
    const reason = notAttempted
      ? 'NOT_EVALUATED'
      : (airframe.upstream.measured.headspeedReasonCode ?? null);
    const words = ROTOR_NOT_COMPARED_WORDING[reason] ?? ROTOR_NOT_COMPARED_WORDING.default;
    out.push(makeFinding({
      id: 'AIRFRAME_ROTOR_NOT_COMPARED',
      rung: 'airframe',
      kind: 'blocker',
      confidence: 'none',
      headline: `The vibration was never compared against the rotor on this range: ${words.why}.`,
      reasoning: '"No rotor problem found" and "the rotor was never checked" are opposite '
        + `facts, and only the first is a statement about the aircraft. ${words.detail}`,
      basis: [
        basisEntry('head-speed relative spread over the analysed range',
          round(airframe.upstream.measured.headspeedRelativeSpread, 4), 'ratio',
          'mechanical-spectrum.mjs rotor-speed evidence'),
        basisEntry('why the head speed could not be compared against',
          reason ?? 'no reason code was given', null,
          'mechanical-spectrum.mjs rotor-speed evidence'),
        ...basis
      ],
      confirm: words.confirm,
      codes: [
        notAttempted ? 'ROTOR_CORRELATION_NOT_ATTEMPTED' : 'ROTOR_CORRELATION_UNAVAILABLE',
        ...(reason ? [reason] : [])
      ]
    }));
  }
  if (upstreamCodes.includes('MECHANICAL_ANALYSIS_ABSENT')) {
    out.push(makeFinding({
      id: 'AIRFRAME_NOT_CHECKED',
      rung: 'airframe',
      kind: 'blocker',
      confidence: 'none',
      headline: 'The vibration check has not been run on this range.',
      reasoning: 'The airframe outranks every gain, so nothing below it is worth reading '
        + 'until it has been looked at.',
      basis: [basisEntry('vibration analysis', null, null, 'not supplied to this engine')],
      confirm: 'Select a range and run the vibration check first.',
      codes: ['MECHANICAL_ANALYSIS_ABSENT']
    }));
  }
  if (upstreamCodes.includes('MECHANICAL_RANGE_EXCLUDES_EVENTS')) {
    out.push(makeFinding({
      id: 'AIRFRAME_RANGE_EXCLUDES_EVENTS',
      rung: 'airframe',
      kind: 'blocker',
      confidence: 'none',
      headline: 'The vibration check covered a different part of this flight from the '
        + 'stops being measured.',
      reasoning: 'A clear verdict measured over other seconds is not evidence about the '
        + 'seconds the tune was measured in.',
      basis: [
        basisEntry('analysed range start', airframe.upstream.measured.rangeStartTimeUs, 'us',
          'mechanical analysis range'),
        basisEntry('analysed range end', airframe.upstream.measured.rangeEndTimeUs, 'us',
          'mechanical analysis range'),
        basisEntry('stop events in the log', airframe.upstream.measured.eventCount, 'count',
          'stop detection'),
        ...rotorToneRows
      ],
      confirm: 'Run the vibration check over a range that contains the stops.',
      codes: ['MECHANICAL_RANGE_EXCLUDES_EVENTS']
    }));
  }
  if (upstreamCodes.includes('MECHANICAL_RANGE_EXCLUDES_HOLDS')) {
    out.push(makeFinding({
      id: 'AIRFRAME_RANGE_EXCLUDES_HOLDS',
      rung: 'airframe',
      kind: 'blocker',
      confidence: 'none',
      headline: 'The vibration check covered a different part of this flight from the holds '
        + 'being measured.',
      reasoning: 'A clear verdict measured over other seconds is not evidence about the '
        + 'seconds used for I-term advice.',
      basis: [
        basisEntry('analysed range start', airframe.upstream.measured.rangeStartTimeUs, 'us',
          'mechanical analysis range'),
        basisEntry('analysed range end', airframe.upstream.measured.rangeEndTimeUs, 'us',
          'mechanical analysis range'),
        basisEntry('hold boundaries in the log', airframe.upstream.measured.holdBoundaryCount,
          'count', 'hold evidence'),
        ...rotorToneRows
      ],
      confirm: 'Run the vibration check over a range that contains every hold used for advice.',
      codes: ['MECHANICAL_RANGE_EXCLUDES_HOLDS']
    }));
  }

  return out;
}

/* ----------------------------------------------------------- rung: headspeed */

function headspeedFindings(headspeed) {
  const measured = headspeed.measured;
  const basis = [
    basisEntry('median head speed while the rotor was turning',
      measured.steadyStateMedianRpm, 'rpm', 'records[].headspeed'),
    basisEntry('head-speed spread once the rotor was up to speed (p95-p5 over median)',
      measured.afterSpoolUpSpreadRatio, 'ratio', 'records[].headspeed, spool-up cut off'),
    basisEntry('head-speed spread including the spool-up',
      measured.steadyStateSpreadRatio, 'ratio',
      'records[].headspeed — published, not gated on: a recording that starts before the '
      + 'rotor does would fail any whole-flight limit'),
    basisEntry('whole-range span including the spool-up', measured.wholeRangeSpanRatio,
      'ratio', 'records[].headspeed, every sample'),
    // Segments are stretches of steady flight, each counted once however many
    // axes were analysed through it (see countHeadspeedSegments).
    basisEntry('steady segments whose head speed was read all the way through',
      measured.holdsEvaluated, 'count',
      'measureHold, each stretch counted once across the axes'),
    basisEntry('of those, segments lost to the head speed moving, with no hold measured in them',
      measured.holdsRejectedForHeadspeed, 'count',
      'measureHold refusals, HOLD_HEADSPEED_UNSTABLE, where no axis measured a hold'),
    // Not lost, and not in the share (review of 3 October 2026): the head speed
    // moved across one axis's hold, and another axis's hold in the same segment
    // held it and was used.
    basisEntry('of those, segments where the head speed moved across one axis\'s hold while '
      + 'another axis measured a hold over a stretch where it held',
    measured.holdsMovedWithAHoldUsedInside ?? null, 'count',
    'each stretch counted once across the axes; not counted as lost'),
    basisEntry('steady segments in which the head-speed reading was missing or impossible',
      measured.holdsRejectedForHeadspeedReading, 'count',
      'measureHold refusals, HOLD_HEADSPEED_INVALID — the sensor or the logging, not the governor'),
    basisEntry('steady segments measured on at least one axis', measured.holdsAccepted, 'count',
      'buildHoldEvidence'),
    basisEntry('share of the read segments lost to the head speed moving',
      measured.headspeedShareOfEvaluatedHolds, 'share',
      'lost over read; at least half, over at least '
      + `${measured.minimumHoldsEvaluated ?? '—'} segments, blocks`),
    basisEntry('limit applied to a five-second hold', measured.holdWindowLimit, 'ratio',
      'EVIDENCE_LIMITS.maximumHeadspeedVariationRatio')
  ];

  // A reading that dropped out is reported as what it is, beside whatever the
  // rung concluded, and never folded into "the head speed moved".
  // Built after the rung's own finding, so it is listed after it.
  const readingLost = measured.holdsRejectedForHeadspeedReading ?? 0;
  const withDropout = finding => (readingLost > 0 ? [finding, makeFinding({
    id: 'HEADSPEED_READING_DROPPED_OUT',
    rung: 'headspeed',
    kind: 'observation',
    confidence: 'medium',
    headline: `The head-speed reading was missing or impossible during ${readingLost} steady `
      + `segment${readingLost === 1 ? '' : 's'} of this flight, so no hold was measured `
      + 'across the gap.',
    reasoning: 'A steady segment is only measured where the head speed is known all the way '
      + 'through it, because a tune is only valid at the head speed it was taken at. '
      + `${readingLost === 1 ? 'This one was' : 'These were'} refused because the reading `
      + 'itself was missing or outside anything a rotor in flight '
      + 'turns at — an RPM sensor losing its signal, or the logging dropping a sample — not '
      + 'because the head speed moved. It says nothing about the governor.',
    basis,
    confirm: 'Check the RPM sensor\'s wiring and signal, and that nothing else in the log is '
      + 'missing samples, then fly again. The count of segments lost to the reading should go '
      + 'to zero.',
    codes: ['HOLD_HEADSPEED_INVALID']
  })] : [finding]);

  if (headspeed.codes.includes('HEADSPEED_NOT_LOGGED')
      || headspeed.codes.includes('HEADSPEED_NEVER_SPUN_UP')) {
    return [makeFinding({
      id: 'HEADSPEED_NOT_MEASURED',
      rung: 'headspeed',
      kind: 'blocker',
      confidence: 'none',
      headline: 'No usable head speed was recorded, so nothing below can be tied to a '
        + 'rotor speed.',
      reasoning: 'A tune is only valid at the head speed it was taken at. Without the '
        + 'rotor speed there is no way to know whether two measurements describe the same '
        + 'aircraft.',
      basis,
      confirm: 'Check that the Blackbox field set includes head speed and that the RPM '
        + 'sensor is reading, then fly again.',
      codes: [...headspeed.codes]
    })];
  }

  // `moved` is the segments LOST to the head speed — it moved, and no axis
  // measured a hold anywhere in them — and is the count every verdict below is
  // taken on. `mixed` is the segments where it moved across one axis's hold
  // while another axis measured a hold in the same stretch at a steady head
  // speed: said, truthfully, and never counted as lost (review of 3 October
  // 2026, after two such hovers read "2 of the 2" and blocked every gain).
  const moved = measured.holdsRejectedForHeadspeed ?? 0;
  const mixed = measured.holdsMovedWithAHoldUsedInside ?? 0;
  const read = measured.holdsEvaluated ?? 0;
  const needed = measured.minimumHoldsEvaluated ?? EVIDENCE_LIMITS.minimumHolds;
  const holdSeconds = round(EVIDENCE_LIMITS.minimumHoldDurationUs / 1e6, 1);
  const mixedNote = mixed > 0
    ? ` In ${mixed === 1 ? 'one other segment' : `${mixed} other segments`} the head speed moved `
      + 'across one axis\'s hold while another axis measured a hold over a stretch where it '
      + `had held; ${mixed === 1 ? 'that hold was' : 'those holds were'} used, the part where it `
      + `moved was not, and ${mixed === 1 ? 'that segment is' : 'those segments are'} not counted `
      + 'as lost.'
    : '';

  if (headspeed.codes.includes('HEADSPEED_COST_THIS_FLIGHT_ITS_HOLDS')) {
    return withDropout(makeFinding({
      id: 'HEADSPEED_MOVED_DURING_STEADY_FLIGHT',
      rung: 'headspeed',
      kind: 'blocker',
      adjust: 'governor',
      confidence: 'medium',
      // The share it measured, not a word for it: "most" was once printed over
      // one refused segment and three good ones.
      headline: 'The head speed was still moving during the steady parts of this flight, '
        + `and that is what cost it ${moved} of the `
        + `${read} steady segments whose head speed could be read.`,
      reasoning: 'Aerodynamic damping, servo authority and the whole rate loop\'s effective '
        + 'gain all move with rotor speed, so a tune taken while the head speed is wandering '
        + 'is wrong at every other collective setting. This is not the spool-up: these are '
        + 'segments of otherwise steady flight in which the rotor speed moved by more than '
        + 'the amount that puts governor activity into a measurement of the tune, and no hold '
        + 'was measured in any of them.' + mixedNote,
      basis,
      confirm: 'Get the head speed holding first — let the governor settle, and watch that '
        + 'it holds through collective changes — then fly the tuning manoeuvres again. The '
        + 'count of segments lost to head speed should go to zero.',
      codes: [...headspeed.codes]
    }));
  }

  // THE HEAD SPEED MOVED, BUT NOT ENOUGH OF THE FLIGHT WAS READ TO JUDGE THE
  // GOVERNOR (2 October 2026, round two of the review). Below the minimum the
  // rung does not block — one segment is not "most" of anything — and it used to
  // fall through to "the head speed held well enough", over a flight whose only
  // measurement said it had not. The count is the finding, and so is what to fly.
  if (moved > 0 && read < needed) {
    return withDropout(makeFinding({
      id: 'HEADSPEED_TOO_FEW_SEGMENTS_TO_JUDGE',
      rung: 'headspeed',
      kind: 'next-flight',
      confidence: 'none',
      headline: `The head speed moved during ${moved} of the ${read} steady `
        + `segment${read === 1 ? '' : 's'} whose head speed could be read, with no hold measured `
        + `in ${moved === 1 ? 'it' : 'them'} — too few to judge the governor from.`,
      reasoning: 'A tune is only valid at the head speed it was taken at, so a steady segment '
        + 'in which the rotor speed moved by more than the limit is not measured. Whether that '
        + 'is the governor or one gust it caught needs more than one look: the governor is '
        + `judged over ${needed} or more steady segments, and this flight had ${read} whose `
        + 'head speed could be read.' + mixedNote + ' This is not an all-clear on the head '
        + 'speed, and it does not hold back the rest of the advice.',
      basis,
      confirm: `Fly ${needed} or more still hovers, each held for ${holdSeconds} s or more with `
        + 'the sticks centred and the governor settled, and watch the head-speed trace across '
        + 'them. If it moves in most of them, the governor is the place to start.',
      codes: [...headspeed.codes, 'HEADSPEED_MOVED_TOO_FEW_SEGMENTS_TO_JUDGE']
    }));
  }

  // Enough segments, and fewer than half of them lost to the head speed: not
  // the governor at the scale the limit was derived for, and not "steady" either.
  //
  // Worded per HOLD since round three: "every hold used held its head speed all
  // the way through" is true of every flight, because `measureHold` refuses any
  // hold that did not. Since 3 October 2026 the count is of segments LOST — no
  // hold measured in them — and a segment where another axis measured a hold is
  // said separately, in `mixedNote`, rather than counted here and then excused.
  if (moved > 0) {
    return withDropout(makeFinding({
      id: 'HEADSPEED_MOVED_IN_SOME_SEGMENTS',
      rung: 'headspeed',
      kind: 'observation',
      confidence: 'low',
      headline: `The head speed moved during ${moved} of the ${read} steady segments whose `
        + `head speed could be read, with no hold measured in ${moved === 1 ? 'it' : 'them'}. `
        + 'Every hold that was used held its head speed all the way through.',
      reasoning: 'A hold in which the rotor speed moved by more than the limit is not measured, '
        + 'because a tune is only valid at the head speed it was taken at. Fewer than half of '
        + 'the segments read were lost to it, which is not the governor wandering at the scale '
        + 'the limit was derived for — but it did move, and that is said rather than called '
        + 'steady.' + mixedNote,
      basis,
      confirm: null,
      codes: [...headspeed.codes, 'HEADSPEED_MOVED_IN_A_MINORITY_OF_SEGMENTS']
    }));
  }

  // THE HEAD SPEED MOVED ONLY WHERE ANOTHER AXIS STILL MEASURED A HOLD (review of
  // 3 October 2026). No segment was lost to it, so nothing here counts against
  // the governor or holds back the advice; but it did move, and a card reading
  // "held well enough" would be false of the hold it cost one axis.
  if (mixed > 0) {
    return withDropout(makeFinding({
      id: 'HEADSPEED_MOVED_WHERE_A_HOLD_WAS_STILL_MEASURED',
      rung: 'headspeed',
      kind: 'observation',
      confidence: 'low',
      headline: `The head speed moved during ${mixed} of the ${read} steady segments whose head `
        + `speed could be read, but in ${mixed === 1 ? 'it' : 'each of them'} another axis still `
        + 'measured a hold over a stretch where it held, so none was lost to it. Every hold that '
        + 'was used held its head speed all the way through.',
      reasoning: 'A hold in which the rotor speed moved by more than the limit is not measured, '
        + 'because a tune is only valid at the head speed it was taken at, so one axis lost its '
        + `hold in ${mixed === 1 ? 'that segment' : 'those segments'}. Another axis measured a `
        + 'hold over the part where the head speed held, and that hold was used. The governor is '
        + 'judged on segments lost to head speed with no hold measured in them, and there were '
        + 'none, so this does not hold back the advice — but the head speed did move, and that '
        + 'is said rather than called steady.',
      basis,
      confirm: null,
      codes: [...headspeed.codes, 'HEADSPEED_MOVED_ONLY_WHERE_A_HOLD_WAS_MEASURED']
    }));
  }

  return withDropout(makeFinding({
    id: 'HEADSPEED_STEADY_ENOUGH',
    rung: 'headspeed',
    kind: 'observation',
    confidence: 'medium',
    headline: 'The head speed held well enough during the measurable parts of this flight.',
    reasoning: 'Every cyclic and tail gain behaves differently at different head speeds, so '
      + 'this had to be true before anything below it could mean anything. It is judged '
      + 'where the limit has a derivation — across each steady segment and across the stops '
      + 'being compared — rather than across the whole recording, which starts before the '
      + 'rotor does and would fail every flight.',
    basis,
    confirm: null,
    codes: [...headspeed.codes]
  }));
}

/* --------------------------------------------------------------- rung: per axis */

function axisFindings({axis, material, records, summary, airframe, mechanical, hold, holdTimesUs,
  options}) {
  const findings = [];
  const withheld = [];

  const events = material.events ?? [];
  const evidence = material.evidence;
  const capture = material.capture;
  const shapes = material.shapes
    ?? events.map(event => ({
      commandSign: event.commandSign,
      event,
      shape: measureStopShape(records, event, axis),
      tracking: measureTrackingShape(records, event, axis)
    }));

  // The FILTERED noise floor is the right one to deconvolve the stop metrics
  // against, because the stop metrics are computed on filtered gyro. The
  // unfiltered broadband figure answers "is the machine shaking", which the
  // airframe rung already asked.
  const noiseFloorDps = summary?.gyroHighFrequencyRmsDps ?? null;

  const completeness = evaluateCompletenessGate(capture);
  const agreement = evaluateAgreementGate(evidence, 'trackingRmsDps', events);
  const headspeedGate = evaluateHeadspeedGate(events, {records});

  // Stability is a production gate, not a diagnostic option. A caller used to
  // be able to set `skipSweeps` and turn four gates into permission; ignore that
  // legacy flag and always re-derive the conclusion.
  const trackingSweep = sweepDirectionalConclusion(records, axis, 'trackingRmsDps',
    {grid: options.detectorGrid ?? UNCONSTRAINED_SWEEP});
  const ringingSweep = sweepDirectionalConclusion(records, axis, 'fastRingingRmsDps',
    {grid: options.detectorGrid ?? UNCONSTRAINED_SWEEP});
  const sweeps = {
    tracking: evaluateStabilityGate(trackingSweep),
    ringing: evaluateStabilityGate(ringingSweep),
    shape: sweepStopShapeConclusion(records, axis, {
      detectorGrid: options.detectorGrid ?? UNCONSTRAINED_SWEEP,
      judgementGrid: options.judgementGrid ?? SHAPE_SWEEP
    })
  };

  const eventTimesUs = events
    .map(event => event?.stopTimeUs)
    .filter(Number.isFinite);
  const gainInterlocks = {
    tracking: evaluateGainRecommendationGates({
      axis, metric: 'trackingRmsDps', mechanical, capture, evidence, events, records,
      eventTimesUs, holdTimesUs, sweep: trackingSweep
    }),
    ringing: evaluateGainRecommendationGates({
      axis, metric: 'fastRingingRmsDps', mechanical, capture, evidence, events, records,
      eventTimesUs, holdTimesUs, sweep: ringingSweep
    })
  };

  /* ---- axis-mechanical: a resolved directional asymmetry outranks the gains */
  if (agreement.status === 'blocked' && agreement.codes.includes('DIRECTIONS_DISAGREE')
      && completeness.status === 'permitted') {
    findings.push(makeFinding({
      id: 'DIRECTIONAL_ASYMMETRY_MECHANICAL',
      rung: 'axis-mechanical',
      axis,
      kind: 'blocker',
      adjust: axis === 'yaw' ? 'tail authority or linkage' : 'linkage or head geometry',
      confidence: sweeps.tracking.status === 'permitted' ? 'medium' : 'low',
      headline: `${axis} behaves differently one way from the other, by more than a gain `
        + 'change would explain.',
      reasoning: axis === 'yaw'
        ? 'On a single-rotor helicopter the tail works with main-rotor torque one way and '
          + 'against it the other, so a left stop and a right stop are not the same '
          + 'measurement. A difference this large is usually authority running out on one '
          + 'side, a binding linkage or head-speed dependence — and a gain moved to split '
          + 'the difference makes the good direction worse without fixing the bad one.'
        : 'A difference this large between the two directions is a mechanical asymmetry '
          + 'rather than a gain fault, and one number would describe neither direction.',
      basis: [
        basisEntry('how many times worse the poorer direction tracks',
          timesWorse(agreement.measured.positive, agreement.measured.negative), 'x',
          'per-direction mean tracking error over the stop events'),
        basisEntry('tracking error, one way', round(agreement.measured.positive, 3), 'deg/s',
          'buildDirectionalStopEvidence'),
        basisEntry('tracking error, the other way', round(agreement.measured.negative, 3),
          'deg/s', 'buildDirectionalStopEvidence'),
        basisEntry('directional asymmetry ratio',
          round(agreement.measured.asymmetryRatio, 4), 'ratio',
          'buildDirectionalStopEvidence'),
        basisEntry('warn ratio', agreement.measured.warnRatio, 'ratio',
          'EVIDENCE_LIMITS.directionalAsymmetryWarnRatio'),
        basisEntry('worse direction', agreement.measured.worseDirection, null,
          'per-direction means over the stop events'),
        basisEntry('widest spread within a single direction',
          round(agreement.measured.widestWithinDirectionSpan, 4), 'deg/s',
          'individual stop events')
      ],
      confirm: `Look at the tail, the linkage and the servo travel before the gains. Then `
        + `fly two more ${axis} stops each way and compare this ratio — if it falls, the `
        + 'asymmetry was mechanical.',
      codes: [...agreement.codes]
    }));
  }

  /* ---- gain findings, from shape */
  const gateStatus = {
    airframe: airframe.status,
    completeness: completeness.status,
    agreement: agreement.status,
    headspeed: headspeedGate.status,
    stability: gainInterlocks.tracking.mayRecommend && gainInterlocks.ringing.mayRecommend
      ? 'permitted' : 'blocked'
  };

  const coreGatesPermitted = airframe.status === 'permitted'
    && completeness.status === 'permitted'
    && agreement.status === 'permitted'
    && headspeedGate.status === 'permitted';

  const perDirection = {};
  for (const direction of DIRECTIONS) {
    const entries = directionShapes(shapes, direction);
    const classifications = new Set(
      entries.map(entry => classifyStopShape(entry.shape).classification)
    );
    const swept = sweeps?.shape?.directions?.[direction] ?? null;
    const sources = new Set(
      entries.map(entry => oscillationSource(entry.shape, entry.tracking))
    );
    perDirection[direction] = {
      count: entries.length,
      classification: classifications.size === 1 ? [...classifications][0] : null,
      classificationsSeen: [...classifications],
      oscillationSource: sources.size === 1 ? [...sources][0] : null,
      sweptOscillationSource: swept?.oscillationSource ?? null,
      sweptClassification: swept?.classification ?? null,
      sweptStable: swept?.stable ?? null,
      meanPlateauRippleDps: mean(entries.map(entry => entry.tracking?.plateauRippleRmsDps)),
      meanSignedOffsetDps: mean(entries.map(entry => entry.tracking?.signedOffsetDps)),
      meanOffsetShare: mean(entries.map(entry => entry.tracking?.offsetShare)),
      meanRippleRmsDps: mean(entries.map(entry => entry.tracking?.rippleRmsDps)),
      meanFrequencyHz: mean(entries.map(entry => entry.shape?.impliedFrequencyHz)),
      meanDecayRatio: mean(entries.map(entry => entry.shape?.decayRatio)),
      meanSameWayPeakDps: mean(entries.map(entry => entry.shape?.sameWayPeakDps)),
      meanOvershootDps: mean(entries.map(entry => entry.shape?.overshootDps)),
      meanRingingRmsDps: mean(entries.map(entry => entry.event?.fastRingingRmsDps)),
      // The rate that was actually being asked for, which is what turns a
      // standing offset in deg/s into "how much of the command was missing".
      meanCommandAmplitudeDps: mean(entries.map(entry => entry.event?.commandAmplitudeDps))
    };
  }

  const bothDirections = DIRECTIONS.every(direction => perDirection[direction].count > 0);
  const agreedClassification = bothDirections
    && perDirection.positive.classification !== null
    && perDirection.positive.classification === perDirection.negative.classification
    ? perDirection.positive.classification
    : null;

  const sweptAgreed = bothDirections && sweeps
    && perDirection.positive.sweptStable && perDirection.negative.sweptStable
    && perDirection.positive.sweptClassification === perDirection.negative.sweptClassification
    ? perDirection.positive.sweptClassification
    : null;

  const shapeConclusion = sweptAgreed;

  // Where the oscillation lives, agreed across both directions and — when the
  // sweeps ran — across the judgement grid too. Null wherever they disagree,
  // and null is what makes the P-versus-D question unanswerable rather than
  // guessed at.
  const sourceKey = 'sweptOscillationSource';
  perDirection.oscillationSource = bothDirections
    && perDirection.positive[sourceKey] !== null
    && perDirection.positive[sourceKey] === perDirection.negative[sourceKey]
    ? perDirection.positive[sourceKey]
    : null;

  if (coreGatesPermitted && shapeConclusion !== null) {
    const candidates = shapeFindings({
      axis, shapeConclusion, perDirection, noiseFloorDps, sweeps, gateStatus,
      tones: (airframe.axes ?? []).find(entry => entry.axis === axis)?.tones ?? []
    });
    for (const candidate of candidates) {
      if (candidate.kind !== 'adjustment') {
        findings.push(candidate);
        continue;
      }
      const interlock = candidate.rung === 'gain-D'
        ? gainInterlocks.ringing
        : gainInterlocks.tracking;
      if (interlock.mayRecommend) {
        findings.push(candidate);
      } else {
        withheld.push(frozen({
          findingId: candidate.id,
          rung: candidate.rung,
          axis,
          reason: 'GATES_NOT_PASSED',
          gateStatus: frozen(Object.fromEntries(
            interlock.gates.map(gate => [gate.gate, gate.status])
          )),
          sentence: `${candidate.id} was measured on ${axis} and is not being turned into a `
            + `gain change, because ${interlock.blockedBy.join(', ')} did not pass.`
        }));
      }
    }
  } else if (bothDirections && agreedClassification !== null) {
    withheld.push(frozen({
      rung: 'gain-P',
      axis,
      reason: 'GATES_NOT_PASSED',
      gateStatus: frozen({...gateStatus}),
      sentence: `A ${agreedClassification} signature was measured on ${axis} in both `
        + 'directions and is not being turned into a gain change, because '
        + `${describeBlockedGates(gateStatus)}.`
    }));
  }

  /* ---- gain-I */
  if (hold) {
    findings.push(...holdFindings({axis, hold, airframe}));
  }

  /* ---- what the stops that DO exist look like, even when there are too few */
  //
  // Reported with its count attached rather than suppressed, mirroring what
  // `directionalObservations` already does for the amplitude metrics. On the
  // reference log this is the single most informative thing that can be said
  // about yaw: its two stops have OPPOSITE shapes — one rings with a flat
  // envelope, the other never arrested — and the amplitude metric ranks them
  // backwards. A pilot who can see that has learned something real from a flight
  // that cannot support a verdict.
  if (completeness.status === 'blocked' && events.length > 0) {
    const described = shapes
      .filter(entry => entry.shape)
      .map(entry => `${entry.commandSign === 'positive' ? 'one way' : 'the other way'} at `
        + `${round(entry.event.stopTimeUs / 1e6, 1)} s: `
        + `${classifyStopShape(entry.shape).classification}`);
    findings.push(makeFinding({
      id: 'STOP_SHAPE_PROVISIONAL',
      rung: 'evidence',
      axis,
      kind: 'observation',
      confidence: 'none',
      headline: `What the ${events.length} ${axis} stop${events.length === 1 ? '' : 's'} in `
        + 'this flight actually did, with too few of them to conclude from.',
      reasoning: 'Shape is what separates an axis that rings from an axis that never '
        + 'arrested, and the two call for opposite changes. The plain size of the response '
        + 'after a release cannot tell them apart — on this kind of flight the largest of '
        + 'those numbers is often the stop that simply failed to stop.',
      basis: [
        basisEntry('what each stop did', described.join('; '), null,
          'measureStopShape / classifyStopShape'),
        ...shapes.filter(entry => entry.shape).flatMap(entry => [
          basisEntry(`rate still in the commanded direction, ${entry.commandSign} stop`,
            entry.shape.sameWayPeakDps, 'deg/s', 'measureStopShape'),
          basisEntry(`envelope decay, ${entry.commandSign} stop`, entry.shape.decayRatio,
            'ratio', 'second-half RMS over first-half'),
          basisEntry(`oscillation frequency, ${entry.commandSign} stop`,
            entry.shape.impliedFrequencyHz, 'Hz', 'zero crossings over the window'),
          basisEntry(`plain response size, ${entry.commandSign} stop`,
            round(entry.event.fastRingingRmsDps, 2), 'deg/s',
            'records.mjs fastRingingRmsDps — the number shape corrects')
        ])
      ],
      confirm: null,
      codes: ['PROVISIONAL_SINGLE_STOP_PER_DIRECTION']
    }));
  }

  /* ---- evidence: what this log could not answer */
  if (completeness.status === 'blocked') {
    findings.push(makeFinding({
      id: 'STOP_EVIDENCE_INCOMPLETE',
      rung: 'evidence',
      axis,
      kind: 'next-flight',
      confidence: 'none',
      headline: capture.headline,
      reasoning: 'Two clean stops in each direction are needed before the two directions '
        + 'can be compared. With fewer than that, one untidy release is the whole result — '
        + 'there is no spread within a direction to judge the difference between them '
        + 'against.',
      basis: [
        basisEntry('stops captured one way', completeness.measured.positiveStops, 'count',
          'detectStopEvents'),
        basisEntry('stops captured the other way', completeness.measured.negativeStops,
          'count', 'detectStopEvents'),
        basisEntry('needed each way', completeness.measured.requiredPerDirection, 'count',
          'EVIDENCE_LIMITS.minimumStopsPerDirection'),
        basisEntry('largest command in this flight', capture.peakCommandDps, 'deg/s',
          'summarizeAxis'),
        basisEntry('command needed for a stop', capture.commandThresholdDps, 'deg/s',
          'STOP_DETECTION_DEFAULTS.commandThresholdDps')
      ],
      confirm: capture.manoeuvre
        ? capture.manoeuvre.steps.join(' ')
        : stopManoeuvre(axis).steps.join(' '),
      candidates: [],
      codes: [...completeness.codes]
    }));
  }

  return {findings, withheld, gates: frozen({
    completeness, agreement, headspeedGate, sweeps, gainInterlocks
  })};
}

/**
 * The asymmetry a pilot can picture: how many times worse the poorer side is.
 *
 * `asymmetryRatio` is |a-b|/max, which is scale-free and right for a threshold
 * and means nothing to anybody. Both are published — the threshold is judged on
 * the first, the sentence is written with the second.
 */
export function timesWorse(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return null;
  }
  const low = Math.min(Math.abs(left), Math.abs(right));
  const high = Math.max(Math.abs(left), Math.abs(right));
  return low === 0 ? null : round(high / low, 2);
}

function describeBlockedGates(gateStatus) {
  const blocked = Object.entries(gateStatus)
    .filter(([, status]) => status !== 'permitted' && status !== 'not-run')
    .map(([gate]) => gate);
  if (blocked.length === 0) {
    return 'the conclusion did not survive being re-derived across the measurement windows '
      + 'nobody in this project can defend';
  }
  return `the ${blocked.join(', ')} check${blocked.length === 1 ? '' : 's'} did not pass`;
}

/* ------------------------------------------------------- shape-driven findings */

function shapeFindings({axis, shapeConclusion, perDirection, noiseFloorDps, sweeps, gateStatus,
  tones = []}) {
  const out = [];

  const ringingBasis = [
    basisEntry('shape after release, one way', perDirection.positive.classification, null,
      'measureStopShape / classifyStopShape'),
    basisEntry('shape after release, the other way', perDirection.negative.classification,
      null, 'measureStopShape / classifyStopShape'),
    basisEntry('oscillation frequency after release',
      round(mean([perDirection.positive.meanFrequencyHz, perDirection.negative.meanFrequencyHz]), 2),
      'Hz', 'zero crossings over the 20-250 ms window'),
    basisEntry('envelope decay (second half over first)',
      round(mean([perDirection.positive.meanDecayRatio, perDirection.negative.meanDecayRatio]), 3),
      'ratio', 'measureStopShape'),
    basisEntry('largest rate still in the commanded direction after centre',
      round(Math.max(perDirection.positive.meanSameWayPeakDps ?? 0,
        perDirection.negative.meanSameWayPeakDps ?? 0), 1),
      'deg/s', 'measureStopShape'),
    basisEntry('filtered gyro noise floor on this axis', round(noiseFloorDps, 3), 'deg/s',
      'summarizeAxis.gyroHighFrequencyRmsDps')
  ];

  const ringingAmplitude = Math.max(
    perDirection.positive.meanRingingRmsDps ?? 0,
    perDirection.negative.meanRingingRmsDps ?? 0
  );
  const separable = separableFromNoiseFloor(ringingAmplitude, noiseFloorDps);

  // Is a measured airframe tone sitting at the frequency the loop is being
  // blamed for? A gain change here would be a coin toss: within one log the
  // engine cannot tell a lightly-damped structural mode re-excited by every
  // release from a derivative term with too much gain, because both are a
  // narrowband oscillation at that frequency after each input. See TONE_LIMITS.
  const oscillationHz = mean([
    perDirection.positive.meanFrequencyHz, perDirection.negative.meanFrequencyHz
  ]);
  const tone = coincidentTone(tones, oscillationHz);

  // Rides with every oscillation-based gain verdict below. Off a rotor order the
  // engine has to name a gain or say nothing useful, so it names one — and now
  // says out loud that one flight cannot exclude the airframe, and what the
  // confirming flight means if the oscillation does not move.
  const ambiguity = airframeAmbiguity(tones, oscillationHz);
  const withAmbiguity = finding => makeFinding({
    ...finding,
    reasoning: `${finding.reasoning}\n\n${ambiguity.sentence}`,
    confirm: `${finding.confirm} ${ambiguity.confirmSentence}`,
    codes: [...(finding.codes ?? []), ambiguity.code]
  });

  const toneFinding = () => makeFinding({
    id: 'OSCILLATION_MATCHES_AIRFRAME_TONE',
    rung: 'axis-mechanical',
    axis,
    kind: 'next-flight',
    confidence: 'low',
    headline: `${axis} oscillates at the same frequency as something the airframe is already `
      + `doing — ${describeTone(tone)} — so a gain change here would be a guess.`,
    reasoning: 'The spectrum on this axis carries a persistent tone at that frequency, and it '
      + `lines up with the ${tone.rotor} rotor's own turning speed. `
      + (tone.attentionEligible
        // Since 2 October 2026 a main-rotor 1/rev or 2/rev above the experimental
        // level is reported on the airframe rung instead of blocking it, so this
        // rule now meets tones above the level too, and must not say otherwise.
        // Where it is listed depends on what else the airframe rung found: its
        // own observation card, or the basis of whatever blocks there.
        ? 'It is above the experimental attention level, and the airframe rung above lists '
          + 'it with its measured size. But a control '
        : 'It did not reach the level worth chasing on its own, which is why nothing above '
          + 'calls it a fault. But a control ')
      + 'loop does not get to choose to oscillate at exactly the speed the rotor turns at, so '
      + 'this coincidence is worth something: it says a mechanical explanation is on the table '
      + 'and this flight cannot rule it out. Lowering a gain to quieten a rotor order does not '
      + 'quieten the rotor — it takes authority away from the loop that is coping with it, on '
      + 'a machine that may be telling you something about a blade, a damper or a balance.',
    basis: [
      ...ringingBasis,
      basisEntry('persistent airframe tone at this frequency', round(tone.frequencyHz, 2), 'Hz',
        'spectrum peak on this axis'),
      basisEntry('how large that tone is', round(tone.bandRmsDps, 3), 'deg/s', 'spectrum peak'),
      basisEntry('how much of the flight it was present for',
        round(tone.persistenceRatio, 3), 'share', 'spectrum peak persistence'),
      basisEntry('rotor order it matches',
        tone.rotor === null ? 'none' : `${tone.rotor} rotor, order ${tone.order}`, null,
        'harmonic match against the logged rotor speed')
    ],
    candidates: [
      `a ${tone.rotor}-rotor order exciting this axis — blade tracking, a damper, balance`,
      'a gain on this axis with too little margin at that frequency'
    ],
    confirm: 'Fly the same stops at a clearly different head speed, and run the vibration '
      + 'check over both. A rotor or frame mode moves with rotor speed; a loop oscillation '
      + 'stays where it is. That one flight separates them, and it is worth more than any '
      + 'gain step you could take from this log.',
    codes: ['OSCILLATION_COINCIDES_WITH_AIRFRAME_TONE']
  });

  if (shapeConclusion === 'settled') {
    out.push(makeFinding({
      id: 'STOPS_SETTLE_CLEANLY',
      rung: 'gain-D',
      axis,
      kind: 'observation',
      confidence: 'medium',
      headline: `${axis} arrests cleanly in both directions — nothing here calls for a `
        + 'gain change.',
      reasoning: 'After each release the rate came back under the stop threshold and stayed '
        + 'there, with no sustained oscillation and no residual in the commanded direction. '
        + 'A confident negative is a result: it is what stops a pilot moving a gain that '
        + 'was never the problem.',
      basis: ringingBasis,
      confirm: null,
      codes: []
    }));
    return out;
  }

  if (shapeConclusion === 'not-stopped') {
    // A failure to arrest with a standing offset is P too low. Everything else
    // with the same shape has other explanations, so the offset is required.
    const offsetDominant = DIRECTIONS.every(direction =>
      Number.isFinite(perDirection[direction].meanOffsetShare)
      && perDirection[direction].meanOffsetShare >= SHAPE_DEFAULTS.offsetDominantShare
      && (perDirection[direction].meanSignedOffsetDps ?? 0) > 0);

    // HOW MUCH of the commanded rate was missing — not just how cleanly the
    // shortfall was a standing one. `offsetShare` is a share of the ERROR, so a
    // saturated actuator reads 1.000 on it: the most offset-dominant reading
    // possible, which is why the old code grew MORE confident about "Raise P"
    // the harder the control was jammed against its stop. This is the share of
    // the COMMAND, and it is the number that says whether a gain step can close
    // the gap at all. See AUTHORITY_LIMITS.standingOffsetShareOfCommand.
    const shortfallShares = DIRECTIONS.map(direction => {
      const offset = Math.abs(perDirection[direction].meanSignedOffsetDps ?? Number.NaN);
      const command = Math.abs(perDirection[direction].meanCommandAmplitudeDps ?? Number.NaN);
      return Number.isFinite(offset) && Number.isFinite(command) && command > 0
        ? offset / command
        : null;
    });
    const worstShortfallShare = shortfallShares.every(share => share === null)
      ? null
      : Math.max(...shortfallShares.filter(share => share !== null));
    const closeableByAGainStep = worstShortfallShare !== null
      && worstShortfallShare < AUTHORITY_LIMITS.standingOffsetShareOfCommand;

    // AND HOW LITTLE (2 October 2026). The ceiling above stops "raise P" being
    // aimed at a stop; nothing stopped it being aimed at a HEALTHY loop, whose
    // tiny shortfall is a clean offset precisely because there is so little error
    // of any kind. The claim is "it sat below the rate asked for", in both
    // directions, so the SMALLER side has to carry it. See
    // AUTHORITY_LIMITS.standingOffsetShareOfCommandFloor.
    const smallestShortfallShare = shortfallShares.some(share => share === null)
      ? null
      : Math.min(...shortfallShares);
    const shortfallLargeEnough = smallestShortfallShare !== null
      && smallestShortfallShare >= AUTHORITY_LIMITS.standingOffsetShareOfCommandFloor;
    // And it has to be a MEASUREMENT: an offset no larger than the axis's own gyro
    // noise floor leaves nothing attributable to the loop, by the same quadrature
    // rule every other metric in this module is read through.
    const offsetsAboveNoise = DIRECTIONS.map(direction =>
      separableFromNoiseFloor(perDirection[direction].meanSignedOffsetDps, noiseFloorDps));
    const offsetSeparable = offsetsAboveNoise.every(value => Number.isFinite(value) && value > 0);
    const offsetEarnsP = shortfallLargeEnough && offsetSeparable;

    const basis = [
      ...ringingBasis,
      basisEntry('tracking error carried by a standing offset, one way',
        round(perDirection.positive.meanOffsetShare, 3), 'share', 'measureTrackingShape'),
      basisEntry('tracking error carried by a standing offset, the other way',
        round(perDirection.negative.meanOffsetShare, 3), 'share', 'measureTrackingShape'),
      basisEntry('how far behind the command the aircraft sat, one way',
        round(perDirection.positive.meanSignedOffsetDps, 2), 'deg/s', 'measureTrackingShape'),
      basisEntry('how far behind the command the aircraft sat, the other way',
        round(perDirection.negative.meanSignedOffsetDps, 2), 'deg/s', 'measureTrackingShape'),
      basisEntry('the largest shortfall, as a share of the rate being asked for',
        worstShortfallShare === null ? null : round(worstShortfallShare, 3), 'share',
        'standing offset over commanded rate, per direction'),
      basisEntry('the most a gain step can be expected to close',
        AUTHORITY_LIMITS.standingOffsetShareOfCommand, 'share',
        'AUTHORITY_LIMITS.standingOffsetShareOfCommand'),
      basisEntry('the smallest shortfall, as a share of the rate being asked for',
        smallestShortfallShare === null ? null : round(smallestShortfallShare, 3), 'share',
        'standing offset over commanded rate, the smaller direction'),
      basisEntry('the least shortfall that can be read as too little P',
        AUTHORITY_LIMITS.standingOffsetShareOfCommandFloor, 'share',
        'AUTHORITY_LIMITS.standingOffsetShareOfCommandFloor'),
      basisEntry('standing offset left above the gyro noise floor, the smaller direction',
        offsetSeparable ? round(Math.min(...offsetsAboveNoise), 2) : null, 'deg/s',
        'separableFromNoiseFloor(offset, summarizeAxis.gyroHighFrequencyRmsDps)')
    ];

    if (offsetDominant && closeableByAGainStep && offsetEarnsP) {
      out.push(makeFinding({
        id: 'P_TOO_LOW',
        rung: 'gain-P',
        axis,
        kind: 'adjustment',
        adjust: `${axis} P`,
        direction: 'increase',
        confidence: 'medium',
        headline: `Raise ${axis} P.`,
        reasoning: 'Two things point the same way and they are independent of each other. '
          + 'While the command was held, the aircraft sat at a rate BELOW the one asked for '
          + 'and stayed there — a standing offset, not a wobble — which is what too little '
          + 'proportional gain looks like. And after the stick reached centre the aircraft '
          + 'was still turning the way it had been pushed, above the level the detector '
          + 'calls stopped. It is not ringing and it is not overshooting; it is not '
          + 'following, and P is the term that makes it follow.',
        basis,
        confirm: `Raise ${axis} P one step, change nothing else, and fly the same stop `
          + 'twice each way. The standing offset should shrink and the aircraft should '
          + 'arrest sooner. If it starts to ring or overshoot instead, you have gone past '
          + 'it — come back a step.',
        codes: ['RESIDUAL_RATE_IN_COMMAND_DIRECTION', 'STANDING_TRACKING_OFFSET']
      }));
      return out;
    }

    // Three different roads reach this finding and a pilot needs to know which.
    // Either the tracking error was not a clean standing offset (the original
    // case); or it was, and it was so LARGE a share of the commanded rate that
    // no gain step could close it, which is what a control run at its travel
    // limit looks like from inside a log; or it was, and it was so SMALL — or so
    // buried in the gyro's own noise — that it is not a shortfall a P step can be
    // expected to move, which is what a healthy loop with a little lag looks like
    // after a big, fast stop.
    // Only a MEASURED shortfall can be too large: with no direction's command
    // measured, this used to print "0% of what was being asked for" as too large.
    const outOfAuthority = offsetDominant && worstShortfallShare !== null && !closeableByAGainStep;
    // A FOURTH ROAD (review of 3 October 2026). Where one direction's commanded
    // rate was missing or zero, its shortfall as a share of the command is not
    // known, and the smaller side — the one that has to carry the claim — is not
    // known either. That is a missing measurement, not a small shortfall: it used
    // to take the too-small road and print "only null% below the rate asked for".
    const shortfallMeasured = shortfallShares.every(share => share !== null);
    const shortfallNotMeasured = offsetDominant && !outOfAuthority && !shortfallMeasured;
    const tooSmallForP = offsetDominant && closeableByAGainStep && shortfallMeasured
      && !offsetEarnsP;
    const smallestPercent = smallestShortfallShare === null
      ? null : round(smallestShortfallShare * 100, 1);

    let headline = `${axis} was still turning the way it had been pushed after the stick `
      + 'reached centre, and this log does not say why.';
    let reasoning = 'A failure to arrest is not ringing, and reading it as ringing would '
      + 'lower the very gain that is supposed to stop the aircraft. But the tracking error '
      + 'during the hold is not a clean standing offset either, so too little P is only '
      + 'one of the candidates.';
    let candidates = [
      'too little P on this axis',
      'a mechanical drag or bind on the control run',
      'the servo or the swashplate hitting a travel or rate limit'
    ];
    let confirm = 'Fly the same stop from a smaller command — about half the rate — twice each '
      + 'way. If the aircraft arrests properly from the smaller one, something is running '
      + 'out of travel or rate at the larger one and no gain will fix that. If it fails to '
      + 'arrest from both, the loop is the place to look.';
    const codes = ['RESIDUAL_RATE_IN_COMMAND_DIRECTION'];

    if (outOfAuthority) {
      headline = `${axis} did not reach the rate it was asked for and did not arrest, and the `
        + 'gap is too large for a gain to be the whole story.';
      reasoning = 'The aircraft sat at a rate well below the commanded one and stayed there, '
        + 'which on its own looks like too little P. But the missing rate is '
        + `${Math.round((worstShortfallShare ?? 0) * 100)}% of what was being asked for, and `
        + 'a loop that far from following is not one gain step away from following. A '
        + 'control run at its travel limit — a servo horn on the wrong hole, a linkage set '
        + 'short, a swashplate on its stop — produces exactly this: a clean standing '
        + 'shortfall that does not move when the gain does. Raising P into a stop winds the '
        + 'loop harder against something that is not going to give, and leaves the aircraft '
        + 'badly over-gained the moment the mechanical fault is fixed.';
    } else if (shortfallNotMeasured) {
      codes.push('COMMANDED_RATE_NOT_MEASURED');
      const missing = DIRECTIONS.filter((direction, index) => shortfallShares[index] === null)
        .length;
      headline = `${axis} was still turning the way it had been pushed after the stick reached `
        + 'centre, but the rate it was asked for could not be measured in '
        + `${missing === DIRECTIONS.length ? 'either direction' : 'one direction'}, so how far `
        + 'short of it the aircraft sat is not known.';
      reasoning = 'While the command was held the aircraft sat at a steady rate below the one '
        + 'asked for, which on its own looks like too little P. Whether a P step could close '
        + 'that gap depends on how large it is against the rate being asked for, and in '
        + `${missing === DIRECTIONS.length ? 'both directions' : 'one direction'} the commanded `
        + 'rate was not measured — it was missing or zero over the held part of the stops. That '
        + 'is a missing measurement, not a small shortfall and not a large one, so this flight '
        + 'does not read it as too little P.';
    } else if (tooSmallForP) {
      // Two different reasons, said differently (round two of the review). A
      // shortfall under the floor is tiny, and "it followed the stick too
      // closely" is true of it. A shortfall over the floor that the noise
      // swallows is NOT tiny — 8-9% of the command on the reproduction — and
      // those words were false about it.
      const tooSmall = !shortfallLargeEnough;
      const buried = !offsetSeparable;
      if (tooSmall) {
        codes.push('STANDING_OFFSET_TOO_SMALL_FOR_P');
      }
      if (buried) {
        codes.push('STANDING_OFFSET_WITHIN_NOISE_FLOOR');
      }
      // The offset is an AVERAGE over the held part of each stop; the floor is the
      // gyro's sample-to-sample high-frequency spread. They are not the same kind
      // of number, and averaging shrinks noise, so the comparison refuses more
      // than it has to. It is kept because silence is cheaper than a wrong "Raise
      // P", and the sentence says what was compared rather than overstating it.
      const noiseNote = 'The gyro\'s own high-frequency noise on this axis is '
        + `${round(noiseFloorDps, 1)} deg/s from one sample to the next, and in at least one `
        + 'direction the shortfall, averaged over the held part of each stop, is no larger '
        + 'than that. Averaging shrinks noise, so that is a cautious comparison and the '
        + 'shortfall may well be real — but this engine reads a shortfall as too little P '
        + 'only where it stands above the noise itself.';
      const lagNote = 'The rate still turning just after centre grows with the size and speed '
        + 'of the stop: any loop with a little lag in it leaves rate behind after a big, fast '
        + 'stop, whatever its P. So this flight does not show P is too low, and it does not rule '
        + 'it out either.';
      if (tooSmall) {
        headline = `${axis} was still turning the way it had been pushed after the stick `
          + 'reached centre, but it followed the stick too closely while it was held for that '
          + 'to say P is too low.';
        reasoning = `In at least one direction the aircraft sat only ${smallestPercent}% below `
          + 'the rate asked for while the command was held. That reads as a clean standing '
          + 'offset — most of the tracking error — only because there was so little error of '
          + 'any kind, and a shortfall that small is not one a P step can be expected to move. '
          + (buried ? `${noiseNote} ` : '')
          + lagNote;
        candidates = [
          'nothing wrong: the ordinary lag of the loop after a large, fast stop',
          'too little P on this axis',
          'a mechanical drag or bind on the control run',
          'the servo or the swashplate hitting a travel or rate limit'
        ];
        confirm = 'Fly the same stop from about half the rate, twice each way. If the rate still '
          + 'turning just after centre roughly halves with it, it is scaling with the size of '
          + 'the stop — the loop\'s own lag — and is not a fault on its own. If the aircraft '
          + 'arrests cleanly from the smaller stop but not from the larger, something is running '
          + 'out of travel or rate at the larger one, and no gain will fix that.';
      } else {
        headline = `${axis} was still turning the way it had been pushed after the stick `
          + `reached centre, and sat ${smallestPercent}% or more below the rate asked for while `
          + 'it was held — but no further below it than this axis\'s gyro noise, so this flight '
          + 'does not read that as too little P.';
        reasoning = 'While the command was held the aircraft sat '
          + `${round(perDirection.positive.meanSignedOffsetDps, 1)} and `
          + `${round(perDirection.negative.meanSignedOffsetDps, 1)} deg/s below it, at least `
          + `${smallestPercent}% of the rate asked for — a shortfall large enough to be too `
          + `little P. ${noiseNote} Deal with the noise first — it is usually vibration reaching `
          + 'the gyro — and a shortfall that is still there on a quieter gyro can be read.';
        candidates = [
          'too little P on this axis',
          'a mechanical drag or bind on the control run',
          'the servo or the swashplate hitting a travel or rate limit',
          'nothing wrong: noise on the gyro making the shortfall look larger than it is'
        ];
        confirm = 'Find what is making the gyro noisy on this axis — the vibration check says '
          + 'where to look — then fly the same stops twice each way. If the shortfall is still '
          + 'there on a quieter gyro, it is read as what it is.';
      }
    }

    out.push(makeFinding({
      id: 'AXIS_DOES_NOT_ARREST',
      rung: 'gain-P',
      axis,
      kind: 'next-flight',
      confidence: 'low',
      headline,
      reasoning,
      basis,
      candidates,
      confirm,
      codes
    }));
    return out;
  }

  if (shapeConclusion === 'ringing') {
    const fastEnough = Number.isFinite(perDirection.positive.meanFrequencyHz)
      && Number.isFinite(perDirection.negative.meanFrequencyHz)
      && Math.min(perDirection.positive.meanFrequencyHz, perDirection.negative.meanFrequencyHz)
        >= SHAPE_DEFAULTS.ringingFloorHz;

    if (!Number.isFinite(separable)) {
      out.push(makeFinding({
        id: 'RINGING_BELOW_NOISE_FLOOR',
        rung: 'gain-D',
        axis,
        kind: 'next-flight',
        confidence: 'none',
        headline: `${axis} rings after a release, and the airframe's own gyro noise on this `
          + 'axis is as large as the ringing.',
        reasoning: 'Two RMS quantities add in quadrature, so when the noise floor equals or '
          + 'exceeds the measurement there is nothing left that can be attributed to the '
          + 'loop. Whatever is being seen is accounted for by the airframe.',
        basis: ringingBasis,
        candidates: ['airframe vibration', 'a genuinely ringing loop hidden under it'],
        confirm: 'Deal with the vibration first, then fly the same stops again. If the '
          + 'ringing survives a clean airframe it becomes readable.',
        codes: ['METRIC_BELOW_AIRFRAME_NOISE_FLOOR']
      }));
      return out;
    }

    // P and D both ring, and frequency alone is far too weak to separate them —
    // a proportional limit cycle at 16 Hz and a derivative one at 50 Hz are both
    // "fast". What separates them is WHEN the axis oscillates. A marginal
    // proportional loop chatters whenever it is doing work, so it is oscillating
    // during the hold as well; a derivative fault is quiet while the error is
    // steady, because D acts on the change in error and during a hold there is
    // none, and shows itself only in the transient after centre.
    const source = perDirection.oscillationSource;

    // Applied only where a gain change would otherwise be named. The
    // next-flight findings below are already the honest answer and do not need
    // replacing with a different honest answer.
    if (tone !== null && (source === 'hold-and-release' || (source !== null && fastEnough))) {
      out.push(toneFinding());
      return out;
    }

    const oscillationBasis = [
      ...ringingBasis,
      basisEntry('oscillation while the command was held, one way',
        round(perDirection.positive.meanPlateauRippleDps, 3), 'deg/s',
        'measureTrackingShape, samples where the command was flat'),
      basisEntry('oscillation while the command was held, the other way',
        round(perDirection.negative.meanPlateauRippleDps, 3), 'deg/s',
        'measureTrackingShape, samples where the command was flat'),
      basisEntry('when the axis oscillated', source, null,
        'plateau oscillation against post-release oscillation')
    ];

    if (source === 'hold-and-release') {
      out.push(withAmbiguity({
        id: 'P_TOO_HIGH',
        rung: 'gain-P',
        axis,
        kind: 'adjustment',
        adjust: `${axis} P`,
        direction: 'decrease',
        confidence: 'medium',
        headline: `Lower ${axis} P.`,
        reasoning: 'This axis oscillates whenever it is being asked to do anything — it '
          + 'chatters while the command is being held steady, not only in the moment after '
          + 'the stick reaches centre. A D-term fault is quiet during a hold, because D acts '
          + 'on how fast the error is changing and during a steady hold it is not changing. '
          + 'A loop that is oscillating while it holds is a loop whose proportional gain has '
          + 'no margin left. Both directions did the same thing, at every measurement window '
          + 'tried.',
        basis: oscillationBasis,
        confirm: `Lower ${axis} P one step, change nothing else, and fly the same stop twice `
          + 'each way. The chatter while you hold the command should go first. If the '
          + 'aircraft starts lagging the command or failing to arrest instead, you have gone '
          + 'one step too far.',
        codes: ['FLAT_ENVELOPE_OVER_TWO_CYCLES', 'OSCILLATION_DURING_THE_HOLD']
      }));
      return out;
    }

    if (source === null) {
      out.push(makeFinding({
        id: 'RINGING_SOURCE_UNKNOWN',
        rung: 'gain-D',
        axis,
        kind: 'next-flight',
        confidence: 'low',
        headline: `${axis} rings after a release, and this flight cannot say whether it was `
          + 'already ringing beforehand.',
        reasoning: 'Too much P and too much D both ring. What tells them apart is whether the '
          + 'axis was also oscillating while the command was held steady, and that could not '
          + 'be measured here — usually because the command was never flat for long enough.',
        basis: oscillationBasis,
        candidates: ['too much P on this axis', 'too much D on this axis'],
        confirm: 'Fly the same stops with the command held rock steady for a full two '
          + 'seconds before each release, so there is a clean stretch of hold to look at.',
        codes: ['PLATEAU_OSCILLATION_NOT_MEASURABLE']
      }));
      return out;
    }

    if (fastEnough) {
      out.push(withAmbiguity({
        id: 'D_TOO_HIGH',
        rung: 'gain-D',
        axis,
        kind: 'adjustment',
        adjust: `${axis} D`,
        direction: 'decrease',
        confidence: 'medium',
        headline: `Lower ${axis} D.`,
        reasoning: 'After each release the axis oscillated for at least two full cycles with '
          + 'an envelope that barely fell — a sustained oscillation rather than a transient '
          + 'dying away — and it did so fast, well above the band an I term or a tail hunt '
          + 'lives in. Crucially it was QUIET while the command was being held: it only rings '
          + 'when the error is changing, which is precisely what the D term acts on, and is '
          + 'what separates this from too much P. Both directions did the same thing, at '
          + 'every measurement window tried.',
        basis: oscillationBasis,
        confirm: `Lower ${axis} D one step, change nothing else, and fly the same stop twice `
          + 'each way. The oscillation after the release should shorten and its envelope '
          + 'should start falling. If the aircraft starts overshooting further instead, you '
          + 'have gone one step too far.',
        codes: ['FLAT_ENVELOPE_OVER_TWO_CYCLES']
      }));
      return out;
    }

    out.push(makeFinding({
      id: 'SLOW_OSCILLATION_AFTER_RELEASE',
      rung: 'gain-P',
      axis,
      kind: 'next-flight',
      confidence: 'low',
      headline: `${axis} oscillates after a release, and it is too slow to be the D term.`,
      reasoning: 'D acts on the rate of change of error, so what it destabilises is fast. '
        + 'An oscillation this slow is airframe-rate — a proportional limit cycle, a tail '
        + 'hunting against its own authority, or a rotor or frame mode being excited by the '
        + 'release. The axis was quiet while the command was held, which rules out a loop '
        + 'that has no margin at all, but does not name which of the rest it is. Lowering D '
        + 'here would be aimed at the wrong term.',
      basis: oscillationBasis,
      candidates: [
        'too much P on this axis',
        'a frame or rotor mode excited by the release',
        'the tail hunting against its authority'
      ],
      confirm: 'Fly the same stops at a clearly different head speed. A frame or rotor mode '
        + 'moves with rotor speed; a loop oscillation does not. Run the vibration check over '
        + 'both windows and compare where the energy sits.',
      codes: ['OSCILLATION_BELOW_D_TERM_BAND']
    }));
    return out;
  }

  if (shapeConclusion === 'overshoot') {
    const source = perDirection.oscillationSource;

    if (tone !== null && source === 'hold-and-release') {
      out.push(toneFinding());
      return out;
    }

    const basis = [
      ...ringingBasis,
      basisEntry('overshoot past centre, one way',
        round(perDirection.positive.meanOvershootDps, 2), 'deg/s', 'measureStopShape'),
      basisEntry('overshoot past centre, the other way',
        round(perDirection.negative.meanOvershootDps, 2), 'deg/s', 'measureStopShape'),
      basisEntry('oscillation while the command was held, one way',
        round(perDirection.positive.meanPlateauRippleDps, 3), 'deg/s',
        'measureTrackingShape, samples where the command was flat'),
      basisEntry('oscillation while the command was held, the other way',
        round(perDirection.negative.meanPlateauRippleDps, 3), 'deg/s',
        'measureTrackingShape, samples where the command was flat'),
      basisEntry('when the axis oscillated', source, null,
        'plateau oscillation against post-release oscillation')
    ];

    if (source === 'hold-and-release') {
      out.push(withAmbiguity({
        id: 'P_TOO_HIGH',
        rung: 'gain-P',
        axis,
        kind: 'adjustment',
        adjust: `${axis} P`,
        direction: 'decrease',
        confidence: 'medium',
        headline: `Lower ${axis} P.`,
        reasoning: 'Two things agree, and they are measured in different seconds of the '
          + 'flight. The axis goes past centre after the release, which says the loop is '
          + 'underdamped — and it was ALREADY chattering while the command was being held '
          + 'steady, which too little D does not do, because D acts on how fast the error is '
          + 'changing and during a steady hold it is not changing. A loop that oscillates '
          + 'while it holds and overshoots when it stops is one whose proportional gain has '
          + 'run out of margin.',
        basis,
        confirm: `Lower ${axis} P one step, change nothing else, and fly the same stop twice `
          + 'each way. The chatter during the hold should go first and the overshoot should '
          + 'shrink with it. If the aircraft starts lagging the command instead, you have '
          + 'gone one step too far.',
        codes: ['OVERSHOOT_PAST_CENTRE', 'OSCILLATION_DURING_THE_HOLD']
      }));
      return out;
    }

    out.push(makeFinding({
      id: 'OVERSHOOT_CANDIDATES_UNSEPARATED',
      rung: 'gain-D',
      axis,
      kind: 'next-flight',
      confidence: 'low',
      headline: `${axis} goes past centre before it settles, and this log cannot say which `
        + 'term is doing it.',
      reasoning: 'Overshoot on a stop is a phase-margin symptom, and three different things '
        + 'produce it: too little D, too much P, or too much feedforward. The axis was quiet '
        + 'while the command was held, which is what would have pointed at P, so P is the '
        + 'least likely of the three — and nothing in this engine measures feedforward at '
        + 'all. Feedforward acts on how fast the stick MOVES, which lives in the ramp into '
        + 'the command rather than in the plateau this measurement covers.',
      basis,
      candidates: [
        'too little D on this axis',
        'too much P on this axis',
        'too much feedforward on this axis'
      ],
      confirm: 'Fly the same stop twice each way SLOWLY into the command, then twice each '
        + 'way with a fast stick movement in. Feedforward-driven overshoot scales with how '
        + 'fast the stick moved IN; D-driven overshoot scales with how fast it was released. '
        + 'That one flight separates them.',
      codes: ['OVERSHOOT_PAST_CENTRE']
    }));
  }

  return out;
}

/* ---------------------------------------------------------- hold-driven findings */

/**
 * Codes that each say the I-term question was not answered with "nothing to
 * change": a sign of too little or too much I, a refusal to read one, or holds
 * that could not be judged at all. Any one of them rules out the all-clear.
 */
const I_TERM_ALL_CLEAR_EXCLUDED = Object.freeze(new Set([
  'STEADY_STATE_ERROR_PRESENT',
  'STEADY_STATE_ERROR_DRIFTING',
  'LOW_FREQUENCY_HUNTING',
  'CONFLICTING_HOLD_SIGNATURES',
  'SLOW_MOVEMENT_BELOW_I_TERM_BAND',
  'STANDING_ERROR_NOT_CLEAR_OF_SLOW_MOVEMENT',
  'I_TERM_DOES_NOT_OSCILLATE_WITH_THE_ERROR',
  'I_TERM_TOO_SMALL_A_SHARE_OF_THE_OUTPUT',
  'I_TERM_NOT_LOGGED',
  'HOLD_KIND_MISMATCH',
  'HOLD_VERDICT_FLIPS_ACROSS_SWEEP',
  'HOLD_SWEEP_COULD_NOT_OBSERVE_THE_OSCILLATION',
  'STANDING_ERROR_WITH_WOUND_UP_I_TERM',
  'STANDING_ERROR_WITH_A_PINNED_I_TERM',
  'INSUFFICIENT_HOLD_SEGMENTS',
  'EVIDENCE_KIND_MISMATCH',
  'EVIDENCE_INCONCLUSIVE',
  // Round three. A fast oscillation dominates the crossing count, so nothing
  // slower was measured under it; a slow ripple no larger than the noise was not
  // told from it; and a standing error not read for want of holds, or because it
  // changed side or stood in some holds and not others, is not "none".
  'OSCILLATION_ABOVE_I_TERM_BAND',
  'SLOW_RIPPLE_NOT_CLEAR_OF_NOISE',
  'STANDING_ERROR_NOT_CLEAR_IN_EVERY_HOLD',
  'STANDING_ERROR_CHANGES_SIDE_BETWEEN_HOLDS',
  'STANDING_ERROR_FOLLOWS_COMMAND_DIRECTION',
  'TOO_FEW_HOLDS_FOR_A_STANDING_ERROR'
]));

/**
 * Whether hold codes earn I_TERM_WITHIN_TOLERANCE: a POSITIVE measurement of an
 * error that neither stood nor wandered (HOLD_EVIDENCE_WITHIN_TOLERANCE), and
 * not one code that says otherwise. Added 2 October 2026, after three separate
 * refusals were found falling through to the all-clear; an all-clear reached by
 * elimination is how each of them got there.
 */
export function earnsITermAllClear(codes) {
  const list = Array.isArray(codes) ? codes : [];
  return list.includes('HOLD_EVIDENCE_WITHIN_TOLERANCE')
    && !list.some(code => I_TERM_ALL_CLEAR_EXCLUDED.has(code));
}

/**
 * I_TERM_NOT_JUDGED, worded from what was missing (round three of the review).
 *
 * The card used to say only that the holds were "not measured in a way that
 * answers the I-term question". Each road that now reaches it is a specific
 * measurement that could not be made, and the pilot is told which, and what to
 * fly to make it: a fast oscillation that hid the band under it; a slow ripple
 * no larger than the noise; a standing error seen in too few holds, or one that
 * followed the stick from turn to turn.
 */
function iTermNotJudged({axis, hold, basis, summary, ripple, rate, meanError, bandLow, bandHigh,
  oscillationHz, errorList, onEachSide}) {
  const codes = hold.codes;
  const has = code => codes.includes(code);
  const holdCount = hold.holdCount;
  const needed = EVIDENCE_LIMITS.minimumHoldsForStandingError;
  const seconds = round(EVIDENCE_LIMITS.minimumHoldDurationUs / 1e6, 1);
  const noise = round(summary?.meanErrorNoiseRmsDps, 1);
  const inBand = oscillationHz >= bandLow && oscillationHz <= bandHigh;
  // Three ways, never two: a movement above the band is not "slower than" it.
  const where = inBand
    ? `inside the ${bandLow}-${bandHigh} Hz band an integrator can cause`
    : oscillationHz > bandHigh
      ? `faster than the ${bandLow}-${bandHigh} Hz band an integrator can cause`
      : `slower than the ${bandLow}-${bandHigh} Hz band an integrator can cause`;
  const movementNamed = has('OSCILLATION_ABOVE_I_TERM_BAND') || has('SLOW_RIPPLE_NOT_CLEAR_OF_NOISE');

  const sentences = [];
  const candidates = [];
  let headline = `The ${axis} holds were measured, but not in a way that answers the I-term `
    + 'question either way.';
  let confirm = holdManoeuvre(axis).steps.join(' ');

  if (has('OSCILLATION_ABOVE_I_TERM_BAND')) {
    headline = `${axis} shook faster than an integrator works during the holds, and that hid `
      + 'anything slower, so the I term was not judged.';
    sentences.push(`The error's slow part swung ${ripple} deg/s RMS ${rate} — faster than the `
      + `${bandLow}-${bandHigh} Hz band an integrator can cause. Movement that fast is the fast `
      + 'loop, the frame or the tail, not the integrator, and it dominates this measurement: a '
      + 'standing error averages out from under it, but a hunt or a slow wander underneath it '
      + 'could not be seen.');
    candidates.push('too much P or D, or a frame or tail resonance, shaking the axis',
      'under it, an I term that is right, too small or too large — this flight cannot say');
    confirm = 'Settle what is shaking first — the stop and vibration findings on this flight say '
      + `whether it is the airframe, P or D — then fly ${needed} or more still holds of `
      + `${seconds} s or more again.`;
  } else if (has('SLOW_RIPPLE_NOT_CLEAR_OF_NOISE')) {
    headline = `${axis} moved slowly during the holds, but no more than its own gyro noise, so `
      + 'the I term was not judged.';
    sentences.push(`The error's slow part swung ${ripple} deg/s RMS ${rate} — ${where} — but no `
      + `more than the ${noise} deg/s RMS of faster noise around it, so it could not be told `
      + 'from that noise: a hunt was neither read nor ruled out.');
    candidates.push(...(inBand ? ['too much I term, hunting under the noise'] : []),
      'the governor, the drive or the wind moving the aircraft',
      'vibration or noise reaching the gyro');
    confirm = 'Check the gyro mounting and the vibration findings on this flight, then fly '
      + `${needed} or more still holds of ${seconds} s or more in calm air.`;
  }

  if (has('STANDING_ERROR_NOT_CLEAR_OF_SLOW_MOVEMENT')
      || has('STANDING_ERROR_NOT_CLEAR_IN_EVERY_HOLD')) {
    sentences.push(`The holds also sat ${meanError} deg/s off the commanded rate on average, but `
      + 'in some of them the error moved as much as it averaged, so that average was not read '
      + 'as a standing error.');
    candidates.push('too little I term, hidden under the movement');
    if (!candidates.some(entry => /governor/.test(entry))) {
      candidates.push('the governor, the drive or the wind moving the aircraft');
    }
  } else if (has('STANDING_ERROR_FOLLOWS_COMMAND_DIRECTION')) {
    headline = `The ${axis} error changed side with the direction of each turn, so the I term `
      + 'was not judged from these turns.';
    sentences.push(`In every turn the error sat ${meanError} deg/s or so on the same side `
      + `relative to the turn (${errorList} deg/s, hold by hold). A loop that lags behind every `
      + 'turn does that — and so does a slow wander that happens to keep step with the turns, '
      + 'and these holds cannot tell the two apart.');
    candidates.push('too little I term on this axis',
      'a slow wander in step with the turns — the governor, the drive or the wind');
    confirm = `Fly ${needed} or more steady turns all in one direction, each held for ${seconds} `
      + 's or more, or the same number of still hovers.';
  } else if (has('STANDING_ERROR_CHANGES_SIDE_BETWEEN_HOLDS')) {
    // Reached only when the movement inside the holds was NOT below the band
    // (review of 3 October 2026); below it, this is SLOW_WANDER_NOT_FROM_THE_I_TERM.
    if (!movementNamed) {
      headline = `The ${axis} error sat off the commanded rate on one side in some holds and on `
        + 'the other side in others, so the I term was not judged from these holds.';
      sentences.push(`Within each hold the error's slow part swung ${ripple} deg/s RMS ${rate} — `
        + `${where} — by no more than the ${HOLD_READING_THRESHOLDS.huntingRippleDps} deg/s that `
        + 'would be read as a hunt.');
    }
    sentences.push(`Hold by hold, the error sat off the commanded rate on one side in `
      + `${onEachSide?.[0] ?? 0} and on the other in ${onEachSide?.[1] ?? 0} (${errorList} deg/s). `
      + 'A standing error the I term should close keeps to one side every time the aircraft is '
      + 'held, so these averages were not read as one; what moved them from hold to hold this '
      + 'flight cannot say.');
    candidates.push('too little I term on this axis, under whatever moved the averages',
      'something moving the aircraft between holds — the governor, the drive or the wind');
    confirm = `Fly ${needed} or more still holds of ${seconds} s or more on this axis in calm air, `
      + 'with the other two axes quiet, and watch the head-speed trace across them.';
  } else if (has('TOO_FEW_HOLDS_FOR_A_STANDING_ERROR')) {
    headline = `The ${axis} holds sat off the commanded rate on the same side each time, but `
      + `${holdCount} holds are too few to call that a standing error.`;
    sentences.push(`Across the ${holdCount} holds the error averaged ${meanError} deg/s, on the `
      + `same side in every one (${errorList} deg/s). That is what too little I looks like, and `
      + 'also what part of a slow wander looks like. A standing error the I term should close '
      + 'stays on one side however many times the aircraft is held; a wander does not, and it '
      + `takes ${needed} holds or more to tell them apart.`);
    candidates.push('too little I term on this axis',
      'part of a slow wander — the governor, the drive or the wind — caught on the same side '
        + 'each time');
    confirm = `Fly ${needed} or more still holds of ${seconds} s or more on this axis, with the `
      + 'other two axes quiet. The pilot guide asks for five.';
  }

  return {
    id: 'I_TERM_NOT_JUDGED',
    rung: 'evidence',
    axis,
    kind: 'next-flight',
    confidence: 'none',
    headline,
    reasoning: (sentences.length > 0
      ? sentences.join(' ')
      : 'What the holds showed is listed below, with the reason codes the measurement '
        + 'returned. None of it is a reading of the I term, and none of it is a sign that the '
        + 'I term is right.')
      + ' This is not an all-clear on the I term.',
    basis: [...basis,
      basisEntry('fast noise in the error, which the I-term filter removed', noise, 'deg/s',
        'measureHold'),
      basisEntry('average error in each hold', errorList, 'deg/s', 'measureHold, signed')],
    ...(candidates.length > 0 ? {candidates} : {}),
    confirm,
    codes: [...codes]
  };
}

function holdFindings({axis, hold, airframe}) {
  const out = [];
  const summary = hold.evidence.summary;

  const basis = [
    basisEntry('holds measured', hold.holdCount, 'count', 'buildHoldEvidence'),
    basisEntry('steady-state error, mean over the holds',
      summary?.meanAbsoluteSteadyStateErrorDps ?? null, 'deg/s', 'measureHold'),
    basisEntry('slow ripple in the error', summary?.meanErrorRippleRmsDps ?? null, 'deg/s',
      'measureHold, error smoothed to the I-term band'),
    // A count of crossings per second, two per cycle — not the oscillation's
    // frequency, which is half of it. Shown raw, and labelled as what it is.
    basisEntry('how often the error crossed zero', summary?.meanErrorCrossingRateHz ?? null,
      'per second', 'measureHold — two crossings per cycle'),
    basisEntry('I-term size', summary?.meanITermRms ?? null, null, 'measureHold'),
    basisEntry('I-term drift', summary?.meanITermDriftPerSecond ?? null, 'per second',
      'measureHold'),
    basisEntry('how often the I term itself crossed its own mean, against the error',
      hold.iTermCoupling.meanCrossingRateRatio, 'ratio',
      'this module, over the same hold window and the same filter'),
    basisEntry('how far the I term moved across a hold, against its own size',
      hold.iTermAuthority?.meanITermTravelShare ?? null, 'share',
      'this module — an integrator facing an error must move, unless it is clamped'),
    basisEntry('I-term size against P-term size', hold.iTermAuthority?.meanITermToPTermRatio ?? null,
      'ratio', 'this module, over the same hold windows'),
    basisEntry('the I term\'s share of the whole output\'s slow movement',
      hold.iTermAuthority?.meanITermShareOfOutputRipple ?? null, 'share',
      'this module, through the same filter the verdict was measured through')
  ];

  if (hold.bind?.suspected) {
    const pinned = hold.bind.pattern === 'pinned';
    out.push(makeFinding({
      id: 'SUSPECTED_MECHANICAL_BIND',
      rung: 'axis-mechanical',
      axis,
      kind: 'blocker',
      adjust: 'linkage or servo',
      confidence: 'medium',
      headline: `Something on ${axis} is holding against the controller. Look at the `
        + 'linkage before any gain.',
      reasoning: pinned
        ? 'During a steady hold the aircraft sat off the commanded rate and stayed there, '
          + 'while the I term — the term whose whole job is to remove exactly that error — sat '
          + 'large and DID NOT MOVE. An integrator facing a standing error has no choice but '
          + 'to move; it is the running total of that error. One that is large and stationary '
          + 'has hit the flight controller\'s own integrator limit, which means the loop has '
          + 'already asked for everything it is allowed to ask for and the aircraft still is '
          + 'not doing it. That is a control run binding, a servo out of travel, or a tail out '
          + 'of authority. Raising I here asks for more of something that is already capped.'
        : 'During a steady hold the error stayed put while the I term wound up large '
          + 'and kept growing against it — the loop pushing harder and harder at something it '
          + 'cannot beat. That is what a binding linkage, a tight ball link or a servo hitting '
          + 'a limit looks like from inside the log. An error alone would have read as too '
          + 'little I, and adding I to an aircraft that is binding winds the term further into '
          + 'a fight it still loses.',
      basis,
      confirm: 'With the motor disconnected, move that control through its full travel by '
        + 'hand and feel for a tight spot. Check the ball links, the servo arm and that '
        + 'nothing is fouling. Then fly the same hold again — if the I term stops winding, '
        + 'that was it.',
      codes: [...hold.codes]
    }));
    return out;
  }

  if (hold.evidence.status !== 'captured') {
    if (hold.holdCount > 0) {
      out.push(makeFinding({
        id: 'HOLD_EVIDENCE_PROVISIONAL',
        rung: 'evidence',
        axis,
        kind: 'next-flight',
        confidence: 'none',
        headline: `${hold.holdCount} usable steady hold on ${axis}, and ${hold.minimumHolds} `
          + 'are needed before the I term can be called.',
        reasoning: 'One window is one sample of one flight condition. What was measured in '
          + 'it is shown below so you can see how close this is — the difference between '
          + '"the evidence was weak" and "there was only one window" matters, and this is '
          + 'the second.',
        basis,
        confirm: holdManoeuvre(axis).steps.join(' '),
        codes: [...hold.codes]
      }));
      return out;
    }
    out.push(makeFinding({
      id: 'NO_HOLD_EVIDENCE',
      rung: 'evidence',
      axis,
      kind: 'next-flight',
      confidence: 'none',
      headline: `This flight contains no steady ${axis} segment long enough to measure the `
        + 'I term in.',
      reasoning: 'The I term only shows itself in sustained error, so it is invisible in a '
        + 'stop and needs a hold. The commonest reason a hold is thrown away is another '
        + 'axis moving during it.',
      basis,
      confirm: holdManoeuvre(axis).steps.join(' '),
      codes: [...hold.codes]
    }));
    return out;
  }

  // HOLDS OF TWO KINDS, NEITHER JUDGED (2 October 2026). A hold at zero rate and
  // a hold at a steady rate test the I term in different regimes, and
  // `interpretHoldEvidence` rightly refuses to read them pooled: it returns
  // `hold` with HOLD_KIND_MISMATCH and judges nothing. That refusal used to fall
  // through to I_TERM_WITHIN_TOLERANCE — "nothing in the holds calls for an
  // I-term change" — on exactly the flights ordinary pilots fly, hovers and
  // steady turns. On an aircraft with NO integrator against a standing torque,
  // either kind alone earns "raise I"; mixed, it was told all was well. Nothing
  // was judged, so nothing is cleared: the pilot is told what to fly instead.
  // Reading each kind on its own is a later stage, deliberately not built here.
  if (hold.codes.includes('HOLD_KIND_MISMATCH')) {
    const holds = hold.evidence.holds ?? [];
    const zeroRate = holds.filter(entry => entry.holdKind === 'zero');
    const steadyRate = holds.filter(entry => entry.holdKind === 'sustained');
    const meanErrorOf = entries => (entries.length === 0 ? null : round(weightedMean(
      entries.map(entry => entry.absoluteSteadyStateErrorDps),
      entries.map(entry => entry.measuredDurationUs)
    ), 2));
    const needed = hold.minimumHolds ?? EVIDENCE_LIMITS.minimumHolds;
    const seconds = round(EVIDENCE_LIMITS.minimumHoldDurationUs / 1e6, 1);
    const offAxis = EVIDENCE_LIMITS.offAxisCommandLimitDps;
    const rateKind = {yaw: 'pirouettes or turns', pitch: 'turns', roll: 'rolls'}[axis]
      ?? 'manoeuvres';
    const still = axis === 'yaw'
      ? 'still hovers, or straight flight, holding a heading with the pedals centred'
      : `still hovers, or level flight, with the ${axis} stick centred`;
    const turning = {
      yaw: 'steady pirouettes or turns at a constant rate',
      pitch: 'steady turns or loops held at a constant pitch rate',
      roll: 'continuous rolls held at a constant roll rate'
    }[axis] ?? `steady ${axis} rates`;

    out.push(makeFinding({
      id: 'I_TERM_HOLDS_MIXED',
      rung: 'evidence',
      axis,
      kind: 'next-flight',
      confidence: 'low',
      headline: `The steady ${axis} segments in this flight were a mix of holds at zero rate `
        + `(hovering or flying straight) and holds at a steady rate (${rateKind}), so the I `
        + 'term was not judged from either.',
      reasoning: 'A hold at zero rate and a hold at a steady rate test the I term in two '
        + 'different regimes — holding still against torque and trim, and holding a rate '
        + 'against a changing load — and averaging them together describes neither. This '
        + `flight had ${zeroRate.length} of the first and ${steadyRate.length} of the second, `
        + 'and the two are not yet read separately, so nothing about the I term was judged '
        + 'here. This is not an all-clear: the I term may be right, too small or too large, '
        + 'and this flight cannot say which.',
      basis: [
        ...basis,
        basisEntry('holds at zero rate (hovering or flying straight)', zeroRate.length, 'count',
          'buildHoldEvidence, holdKind zero'),
        basisEntry('holds at a steady rate (turning)', steadyRate.length, 'count',
          'buildHoldEvidence, holdKind sustained'),
        basisEntry('steady-state error, mean over the zero-rate holds', meanErrorOf(zeroRate),
          'deg/s', 'measureHold, weighted by measured duration'),
        basisEntry('steady-state error, mean over the steady-rate holds', meanErrorOf(steadyRate),
          'deg/s', 'measureHold, weighted by measured duration'),
        basisEntry('a hold counts as zero rate when its command is under',
          EVIDENCE_LIMITS.zeroHoldThresholdDps, 'deg/s', 'EVIDENCE_LIMITS.zeroHoldThresholdDps')
      ],
      candidates: [
        'the I term is right for this aircraft',
        'too little I term on this axis',
        'too much I term on this axis'
      ],
      confirm: `Fly ${needed} or more steady ${axis} segments of ONE kind, each held for `
        + `${seconds} s or more with the other two axes under ${offAxis}°/s: either ${still}, `
        + `or ${turning}. Keep any steady stretch of the other kind shorter than ${seconds} s `
        + 'in that flight, or outside the window you select — the two kinds are not yet read '
        + 'separately, so a mix is not judged at all.',
      codes: [...hold.codes]
    }));
    return out;
  }

  if (!hold.sweepStable) {
    // The candidates are the readings the sweep actually produced (2 October
    // 2026, round two). They were written in as "slightly high" and "fine" for
    // the one flip this card was built for, and an aircraft with NO integrator
    // whose reading flipped between "raise I" and a refusal was offered both.
    const readings = hold.sweepIndicationsSeen.length > 0
      ? hold.sweepIndicationsSeen : [hold.shippedIndication];
    const candidates = [
      ...(readings.includes('increase') ? ['the I term is slightly low'] : []),
      ...(readings.includes('decrease') ? ['the I term is slightly high'] : []),
      ...(readings.includes('hold')
        ? ['the I term is fine, or something outside it is moving the aircraft'] : [])
    ];
    out.push(makeFinding({
      id: 'I_TERM_VERDICT_UNSTABLE',
      rung: 'evidence',
      axis,
      kind: 'next-flight',
      confidence: 'none',
      headline: `The ${axis} I-term reading changes depending on how the error is filtered, `
        + 'so it is not a result yet.',
      reasoning: 'The same holds read one way at one smoothing length or ripple threshold and '
        + 'another way at another, across settings that are all equally defensible. A verdict '
        + 'that moves with an internal setting is that setting being read aloud, not a '
        + 'measurement of the aircraft.',
      basis: [
        ...basis,
        basisEntry('readings seen across the sweep', hold.sweepIndicationsSeen.join(', '),
          null, 'HOLD_SWEEP'),
        basisEntry('sweep points', hold.sweepRunCount, 'count', 'HOLD_SWEEP')
      ],
      candidates,
      confirm: 'Fly two or three more long, still holds on this axis — hands off the other '
        + 'two — and the reading will settle one way or the other.',
      codes: [...hold.codes]
    }));
    return out;
  }

  if (airframe.status !== 'permitted') {
    return out;
  }

  // The I question cannot be answered from a log that did not record the term.
  // Falling through would reach I_TERM_WITHIN_TOLERANCE, whose sentence — "the
  // aircraft neither sat off the commanded rate nor wandered slowly either side
  // of it" — can be flatly false on exactly this flight.
  if (hold.codes.includes('I_TERM_NOT_LOGGED')) {
    out.push(makeFinding({
      id: 'I_TERM_NOT_LOGGED',
      rung: 'gain-I',
      axis,
      kind: 'next-flight',
      confidence: 'none',
      headline: `This log does not record what the ${axis} I term was doing, so the I-term `
        + 'question cannot be answered from it either way.',
      reasoning: 'Everything this engine can say about an integrator rests on the term '
        + 'itself: whether it is small, whether it is winding up against something, whether '
        + "it has hit the flight controller's own limit and stopped moving. Those are three "
        + 'different aircraft with the same error trace, and without the term they cannot be '
        + 'told apart. The error is reported below exactly as measured; the diagnosis is not.',
      basis,
      confirm: 'Turn the PID term fields on in the Blackbox logging setup — axisP, axisI and '
        + 'axisD — and fly the same two long, still holds again.',
      codes: [...hold.codes]
    }));
    return out;
  }

  // The aircraft IS wandering slowly and the integrator is not big enough to be
  // doing it. Saying nothing here would be worse than the wrong answer: the
  // pilot can see the wander, and silence invites him to go looking for a gain.
  if (hold.codes.includes('I_TERM_TOO_SMALL_A_SHARE_OF_THE_OUTPUT')) {
    out.push(makeFinding({
      id: 'SLOW_WANDER_NOT_FROM_THE_I_TERM',
      rung: 'gain-I',
      axis,
      kind: 'next-flight',
      confidence: 'low',
      headline: `${axis} wanders slowly during a hold, and the I term is too small a part of `
        + 'what the controller is doing for it to be the cause.',
      reasoning: 'The error crosses zero at the slow rate an integrator can cause, and the I '
        + 'term crosses at the same rate — but that is true of ANY slow disturbance, because '
        + 'the integral of a wandering error wanders at the same frequency whatever is moving '
        + 'the aircraft. The size test is the one that decides it, and the integrator is '
        + 'carrying only a small share of the output\'s own movement. Something outside the '
        + 'loop is moving the aircraft and the loop is chasing it. Lowering I would not shrink '
        + 'the wander, and taken far enough it removes the heading hold you rely on in wind '
        + 'and through every collective change.',
      basis,
      candidates: [
        'the governor hunting, so main-rotor torque is modulating at that rate',
        'a slipping or worn tail belt, or a drive that is not steady',
        'wind, or the aircraft flying through its own wake',
        axis === 'yaw' ? 'the tail running out of authority and re-catching'
          : 'a control run with a slack or springy spot in it'
      ],
      confirm: 'Fly the same still hold in calm air, and look at the head-speed trace across '
        + 'it at the same time. If the wander tracks head speed, it is the governor or the '
        + 'drive, not a gain. If it is there in calm air with a rock-steady head speed, come '
        + 'back to the I term.',
      codes: [...hold.codes]
    }));
    return out;
  }

  if (hold.indication === 'decrease') {
    out.push(makeFinding({
      id: 'I_TOO_HIGH',
      rung: 'gain-I',
      axis,
      kind: 'adjustment',
      adjust: `${axis} I`,
      direction: 'decrease',
      confidence: hold.confidence,
      headline: `Lower ${axis} I.`,
      reasoning: 'During the steady holds the error kept crossing zero at a slow rate — '
        + 'inside the band an integrator can cause and below what the measurement filter can '
        + 'be fooled by — with the slow component standing clearly above the noise that was '
        + 'filtered out, and the I TERM ITSELF crossing its own mean at the same rate. That '
        + 'last part is what says the integrator is carrying the oscillation rather than '
        + 'sitting still while something else moves the aircraft. The reading held at every '
        + 'filter length that could see it, and at every ripple threshold tried.',
      basis,
      confirm: `Lower ${axis} I one step, change nothing else, and fly two long still holds `
        + 'again. The slow wander should shrink. If a standing error appears instead, you '
        + 'have gone one step too far.',
      codes: [...hold.codes]
    }));
    return out;
  }

  if (hold.indication === 'increase') {
    out.push(makeFinding({
      id: 'I_TOO_LOW',
      rung: 'gain-I',
      axis,
      kind: 'adjustment',
      adjust: `${axis} I`,
      direction: 'increase',
      confidence: hold.confidence,
      headline: `Raise ${axis} I.`,
      reasoning: 'During the steady holds the aircraft sat off the commanded rate and stayed '
        + `there — on the same side in every one of the ${hold.holdCount} holds, which a slow `
        + 'wander does not do — and the I term, the one whose job is exactly that error, is '
        + 'small and is not winding up against it. That is an integrator that is not doing '
        + 'enough, and it is specifically NOT the pattern a binding linkage makes, which is the '
        + 'same error with the I term wound large and still growing.',
      basis: [...basis, basisEntry('average error in each hold',
        (hold.evidence.holds ?? []).map(entry => round(entry.steadyStateErrorDps, 1)).join(', '),
        'deg/s', 'measureHold, signed')],
      confirm: `Raise ${axis} I one step, change nothing else, and fly two long still holds `
        + 'again. The standing error should close up. If the aircraft starts wandering slowly '
        + 'either side of the target instead, you have gone one step too far.',
      codes: [...hold.codes]
    }));
    return out;
  }

  // EVERY 'HOLD' BELOW IS A REFUSAL UNTIL PROVED A RESULT (2 October 2026,
  // round two of the review). Three refusals used to fall through to the
  // all-clear, each with "the aircraft neither sat off the commanded rate nor
  // wandered slowly either side of it" over a trace that had done one or both:
  // both signatures at once, an in-band wobble the I term does not move with,
  // and — once the band was in the right units — every wander below it. Each is
  // now named, with what to fly; and the all-clear is reached only through
  // `earnsITermAllClear`, which asks for the positive measurement.
  const crossings = summary?.meanErrorCrossingRateHz;
  const [bandLow, bandHigh] = hold.evidence.measurement?.huntingBandHz
    ?? EVIDENCE_LIMITS.huntingBandHz;
  const ripple = round(summary?.meanErrorRippleRmsDps, 1);
  const meanError = round(summary?.meanAbsoluteSteadyStateErrorDps, 1);
  const rate = Number.isFinite(crossings) && crossings > 0
    ? `at about ${round(crossings / CROSSINGS_PER_CYCLE, 2)} Hz (crossing its own average `
      + `${round(crossings, 2)} times a second)`
    : 'without once crossing its own average inside a hold';
  const wanderCandidates = [
    'the governor hunting, so main-rotor torque is modulating at that rate',
    'a slipping or worn tail belt, or a drive that is not steady',
    'wind, or the aircraft flying through its own wake',
    axis === 'yaw' ? 'the tail running out of authority and re-catching'
      : 'a control run with a slack or springy spot in it'
  ];
  const calmHold = 'Fly the same still hold in calm air, and look at the head-speed trace '
    + 'across it at the same time. If the wander tracks head speed, it is the governor or the '
    + 'drive, not a gain. If it is there in calm air with a rock-steady head speed, come back '
    + 'to the I term.';

  if (hold.codes.includes('CONFLICTING_HOLD_SIGNATURES')) {
    out.push(makeFinding({
      id: 'I_TERM_SIGNATURES_CONFLICT',
      rung: 'gain-I',
      axis,
      kind: 'next-flight',
      confidence: 'low',
      headline: `${axis} both sat off the commanded rate and wobbled either side of it during `
        + 'the holds, so the I term was not judged.',
      reasoning: 'Too little I leaves the aircraft sitting off the target; too much I makes it '
        + 'swing slowly either side of it. These holds showed both at once: an average error '
        + `of ${meanError} deg/s, and a slow part swinging ${ripple} deg/s RMS ${rate}, inside `
        + `the ${bandLow}-${bandHigh} Hz band an integrator can cause. One gain cannot be too `
        + 'small and too large on the same flight, so something outside the I term is usually '
        + 'moving the aircraft, and changing I either way would chase it. This is not an '
        + 'all-clear: the I term was not judged.',
      basis,
      candidates: [
        'a binding or stiff linkage on this control, or a servo near the end of its travel',
        axis === 'yaw' ? 'the tail running out of authority'
          : 'the head or swashplate running out of authority on this axis',
        'the governor hunting, so main-rotor torque is moving',
        'wind or turbulence during the holds'
      ],
      confirm: 'First, with the motor disconnected, move this control through its full travel '
        + 'by hand and feel for a tight spot. Then fly two long, still holds in calm air and '
        + 'watch the head-speed trace across them. If the wobble tracks head speed, it is the '
        + 'governor; if it is gone in calm air, it was the wind; if both remain on a free '
        + 'linkage and a steady head speed, the holds from that flight will read the I term.',
      codes: [...hold.codes]
    }));
    return out;
  }

  if (hold.codes.includes('I_TERM_DOES_NOT_OSCILLATE_WITH_THE_ERROR')) {
    out.push(makeFinding({
      id: 'SLOW_WANDER_NOT_FROM_THE_I_TERM',
      rung: 'gain-I',
      axis,
      kind: 'next-flight',
      confidence: 'low',
      headline: `${axis} wobbles during a hold at a rate an integrator could cause, but the I `
        + 'term does not move with it, so the I term is not the cause.',
      reasoning: `The error's slow part swung ${ripple} deg/s RMS ${rate}, inside the `
        + `${bandLow}-${bandHigh} Hz band an integrator can cause. But an integrator that is `
        + 'carrying an oscillation swings with it, crossing its own average at the same rate, '
        + 'and this I term does not move with the error: whatever is moving the aircraft, the '
        + 'integrator is not carrying it, and an I-term change would not settle it.',
      basis,
      candidates: wanderCandidates,
      confirm: calmHold,
      codes: [...hold.codes]
    }));
    return out;
  }

  // WHERE THE MOVEMENT WAS, and what each hold's own average did (round three).
  // The wording below used to call every refused standing error "slower than the
  // band", including in-band wobbles refused only because they were no larger
  // than the noise. It now says which side of the band the movement was on, and
  // an in-band or faster one is not called a wander at all: it goes to
  // I_TERM_NOT_JUDGED, which does not claim to know what moved the aircraft.
  const oscillationHz = Number.isFinite(crossings) ? crossings / CROSSINGS_PER_CYCLE : 0;
  const belowBand = oscillationHz < bandLow;
  const heldErrors = (hold.evidence.holds ?? []).map(entry => entry.steadyStateErrorDps);
  const onEachSide = [heldErrors.filter(value => value > 0).length,
    heldErrors.filter(value => value < 0).length];
  const errorList = heldErrors.map(value => round(value, 1)).join(', ');
  const standingRefusals = ['STANDING_ERROR_NOT_CLEAR_OF_SLOW_MOVEMENT',
    'STANDING_ERROR_NOT_CLEAR_IN_EVERY_HOLD', 'STANDING_ERROR_CHANGES_SIDE_BETWEEN_HOLDS',
    'STANDING_ERROR_FOLLOWS_COMMAND_DIRECTION', 'TOO_FEW_HOLDS_FOR_A_STANDING_ERROR'];
  const hidden = standingRefusals.some(code => hold.codes.includes(code));
  const changedSide = hold.codes.includes('STANDING_ERROR_CHANGES_SIDE_BETWEEN_HOLDS');
  const notClear = hold.codes.includes('STANDING_ERROR_NOT_CLEAR_OF_SLOW_MOVEMENT')
    || hold.codes.includes('STANDING_ERROR_NOT_CLEAR_IN_EVERY_HOLD');
  const sideSentence = ` Hold by hold, the error sat off the commanded rate on one side in `
    + `${onEachSide[0]} and on the other in ${onEachSide[1]} (${errorList} deg/s). A standing `
    + 'error the I term should close keeps to one side every time the aircraft is held; one '
    + 'that changes side from hold to hold is moving more slowly than the holds themselves.';

  // Only a movement BELOW the band is a slow wander. An error that changed side
  // between holds while its movement inside them was in the band (or above it)
  // used to come here too, whatever its frequency, and was called "slower than
  // an integrator makes an aircraft hunt" (review of 3 October 2026). It goes to
  // I_TERM_NOT_JUDGED, which says where the movement was.
  if (hold.codes.includes('SLOW_MOVEMENT_BELOW_I_TERM_BAND')
      || ((changedSide || notClear) && belowBand)) {
    const movement = belowBand
      ? `The error's slow part swung ${ripple} deg/s RMS ${rate} — slower than the `
        + `${bandLow}-${bandHigh} Hz band an integrator can cause, so the wander is not the I `
        + 'term\'s doing. Movement that slow is the governor, the drive, the wind or the pilot.'
      : `Within each hold the error's slow part swung ${ripple} deg/s RMS ${rate}.`;
    out.push(makeFinding({
      id: 'SLOW_WANDER_NOT_FROM_THE_I_TERM',
      rung: 'gain-I',
      axis,
      kind: 'next-flight',
      confidence: 'low',
      headline: `${axis} wandered slowly during the holds, slower than an integrator makes an `
        + 'aircraft hunt, so the I term was not judged from them.',
      reasoning: movement
        + (changedSide ? sideSentence : '')
        + (notClear
          ? ` The holds also sat ${meanError} deg/s off the commanded rate on average, but a `
            + 'wander that slow leaves part of a cycle in every hold\'s average, and here it is '
            + 'as large as that average — so this flight cannot say whether any of it is a '
            + 'standing error the I term should have closed.'
          : '')
        + ' This is not an all-clear on the I term.',
      basis: [...basis,
        basisEntry('average error in each hold', errorList, 'deg/s', 'measureHold, signed')],
      candidates: hidden
        ? [...wanderCandidates, 'too little I term, hidden under the wander']
        : wanderCandidates,
      confirm: calmHold,
      codes: [...hold.codes]
    }));
    return out;
  }

  // Nothing above caught it, and the holds still do not carry a positive
  // measurement of nothing wrong. Never an all-clear by default — and since
  // round three, the card says which measurement was missing.
  if (!earnsITermAllClear(hold.codes)) {
    out.push(makeFinding(iTermNotJudged({axis, hold, basis, summary, ripple, rate, meanError,
      bandLow, bandHigh, oscillationHz, errorList, onEachSide})));
    return out;
  }

  // Positively measured: the mean under the standing-error threshold and the slow
  // part under the movement threshold, which a slow movement at any frequency the
  // band admits would have crossed. Since round three a fast oscillation never
  // reaches here — it hides whatever moved more slowly under it.
  const reasoning = 'Across the measured holds the aircraft neither sat off the commanded rate '
    + 'nor wandered slowly either side of it: the average error was '
    + `${meanError} deg/s, under the ${HOLD_READING_THRESHOLDS.errorDps} deg/s that would be read `
    + `as a standing error, and its slow part moved ${ripple} deg/s RMS, under the `
    + `${HOLD_READING_THRESHOLDS.huntingRippleDps} deg/s that would have been read as movement. `
    + 'A confident negative is worth as much as a change here: it is what stops a pilot moving '
    + 'a gain that was never the problem.';

  out.push(makeFinding({
    id: 'I_TERM_WITHIN_TOLERANCE',
    rung: 'gain-I',
    axis,
    kind: 'observation',
    confidence: hold.confidence === 'none' ? 'low' : hold.confidence,
    headline: `Nothing in the ${axis} holds calls for an I-term change.`,
    reasoning,
    basis,
    confirm: null,
    codes: [...hold.codes]
  }));
  return out;
}

/* ---------------------------------------------------------------- the ordering */

/**
 * Sorts by rung, suppresses every adjustment below a blocked rung, and returns
 * at most one adjustment instruction.
 *
 * The suppression is what makes "airframe before gains" real rather than
 * advisory: a gain adjustment that survives to the output has no blocker above
 * it, on any axis. Observations and next-flight findings are kept, because they
 * are what the pilot needs in order to clear the blocker.
 */
export function orderFindings(findings, context = {}) {
  const sorted = [...findings].sort((left, right) => {
    if (left.rungOrder !== right.rungOrder) {
      return left.rungOrder - right.rungOrder;
    }
    return left.sequence - right.sequence;
  });

  const blockers = sorted.filter(finding => finding.kind === 'blocker');
  const lowestBlockerRung = blockers.length === 0
    ? Number.POSITIVE_INFINITY
    : Math.min(...blockers.map(finding => finding.rungOrder));

  const kept = sorted.filter(finding => {
    if (finding.kind !== 'adjustment') {
      return true;
    }
    // An adjustment may only stand when nothing above its rung is blocked. An
    // axis-level blocker on one axis does not suppress another axis's gains,
    // because "one axis at a time" is about the measurement, not the machine.
    const blockedAbove = blockers.some(blocker =>
      blocker.rungOrder < finding.rungOrder
      && (blocker.axis === null || blocker.axis === finding.axis));
    return !blockedAbove;
  });

  const primaryAction = kept.find(finding =>
    (finding.kind === 'blocker' || finding.kind === 'adjustment')
    && finding.rungOrder <= (lowestBlockerRung === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY : lowestBlockerRung)) ?? null;

  const out = kept
    // An imperative adjustment without `actNow` is still an instruction. Keep
    // only the primary one so the returned contract, not just its styling flag,
    // enforces one change at a time.
    .filter(finding => finding.kind !== 'adjustment' || finding === primaryAction)
    .map(finding => finding === primaryAction
      ? frozen({...finding, actNow: true})
      : finding);

  void context;
  return out;
}

export {
  AXES,
  DIRECTIONS,
  EVIDENCE_LIMITS,
  GAIN_GATE_THRESHOLDS,
  STOP_DETECTION_DEFAULTS
};
