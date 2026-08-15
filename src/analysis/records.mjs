/**
 * Bridges the decoder to the analysis.
 *
 * The decoder returns raw sample rows — arrays of numbers whose meaning lives in
 * the log's own field inventory, which varies by firmware version and by what
 * the pilot enabled. The analysis needs named quantities. This module resolves
 * one to the other, and reports what it could not find instead of substituting
 * zeros: a missing `headspeed` that silently becomes 0 would fail every hold's
 * plausibility gate for a reason nobody could see.
 *
 * Pure and dependency-free, like the analysis it feeds — it runs in a browser,
 * a WebView, and Node without change.
 */

import {AXES} from './pid-evidence.mjs';

/**
 * Field name candidates, in preference order.
 *
 * Blackbox field names differ across firmware versions and forks, so each
 * quantity lists the spellings actually seen rather than assuming one. Anything
 * not found is reported, never guessed.
 */
export const FIELD_MAP = Object.freeze({
  timeUs: ['time'],
  setpoint: [
    ['setpoint[0]', 'axisSetpoint[0]'],
    ['setpoint[1]', 'axisSetpoint[1]'],
    ['setpoint[2]', 'axisSetpoint[2]']
  ],
  gyro: [
    ['gyroADC[0]', 'gyro[0]', 'gyroData[0]'],
    ['gyroADC[1]', 'gyro[1]', 'gyroData[1]'],
    ['gyroADC[2]', 'gyro[2]', 'gyroData[2]']
  ],
  // `debug[n]` was listed here as a last-resort unfiltered-gyro candidate and is
  // gone. A debug channel carries whatever the active `debug_mode` selects, so
  // it is never reliably a gyro. On the reference log (Rotorflight 4.6.0, which
  // writes `gyroRAW[0..2]` and no `gyroUnfilt`) that fallback resolved `raw[0..2]`
  // to `debug[0..2]`, which on this firmware is governor headspeed data: 1710 to
  // 1830, a rotor speed rather than a rate. RMS(raw − filtered) on roll read
  // 1755.9 deg/s through `debug[0]` against 11.1 through `gyroRAW[0]`, and the
  // downstream step-noise metric read 0.231 deg/s instead of 8.772. The error
  // pointed the dangerous way: a noisy airframe reported as clean, with
  // `resolved` telling the caller an unfiltered gyro had been found.
  raw: [
    ['gyroRAW[0]', 'gyroUnfilt[0]', 'gyroADCunfilt[0]'],
    ['gyroRAW[1]', 'gyroUnfilt[1]', 'gyroADCunfilt[1]'],
    ['gyroRAW[2]', 'gyroUnfilt[2]', 'gyroADCunfilt[2]']
  ],
  headspeed: ['headspeed', 'rpm[0]'],
  collective: ['rcCommand[3]', 'collective'],
  vbat: ['Vbat', 'vbatLatest', 'vbat']
});

/** PID term contributions, per axis. `axisF`/`axisB`/`axisO` are not terms we score. */
const TERM_FIELDS = Object.freeze({
  P: axis => [`axisP[${axis}]`],
  I: axis => [`axisI[${axis}]`],
  D: axis => [`axisD[${axis}]`]
});

function resolve(indexByName, candidates) {
  for (const candidate of candidates) {
    const index = indexByName.get(candidate);
    if (index !== undefined) {
      return {index, name: candidate};
    }
  }
  return null;
}

/**
 * Builds analysis records from one decoded session.
 *
 * @param {object} session a session from `decodeLog`
 * @param {object} options
 * @param {string} options.axis which axis the PID terms should describe
 * @returns {{records: object[], missing: string[], resolved: object, usable: boolean}}
 */
export function buildAnalysisRecords(session, options = {}) {
  const axis = options.axis ?? 'roll';
  const axisIndex = AXES.indexOf(axis);
  if (axisIndex === -1) {
    return {records: [], missing: ['axis'], resolved: {}, usable: false};
  }

  const fields = session?.fields ?? [];
  const samples = session?.samples ?? [];
  const indexByName = new Map(fields.map(field => [field.name, field.index]));

  const missing = [];
  const resolved = {};

  const timeField = resolve(indexByName, FIELD_MAP.timeUs);
  if (!timeField) {
    missing.push('time');
  } else {
    resolved.time = timeField.name;
  }

  const vectorIndexes = {};
  for (const key of ['setpoint', 'gyro', 'raw']) {
    vectorIndexes[key] = FIELD_MAP[key].map((candidates, axisSlot) => {
      const found = resolve(indexByName, candidates);
      if (!found) {
        // `raw` is optional: it feeds a noise metric, not the core measurements.
        if (key !== 'raw') {
          missing.push(`${key}[${axisSlot}]`);
        }
        return null;
      }
      resolved[`${key}[${axisSlot}]`] = found.name;
      return found.index;
    });
  }

  const scalarIndexes = {};
  for (const key of ['headspeed', 'collective', 'vbat']) {
    const found = resolve(indexByName, FIELD_MAP[key]);
    if (!found) {
      missing.push(key);
      scalarIndexes[key] = null;
      continue;
    }
    resolved[key] = found.name;
    scalarIndexes[key] = found.index;
  }

  const termIndexes = ['P', 'I', 'D'].map(term => {
    const found = resolve(indexByName, TERM_FIELDS[term](axisIndex));
    if (!found) {
      missing.push(`axis${term}[${axisIndex}]`);
      return null;
    }
    resolved[`term${term}`] = found.name;
    return found.index;
  });

  // Without time or the two core vectors there is nothing to analyse. Say so
  // rather than returning records that every gate will silently reject.
  const usable = Boolean(timeField)
    && vectorIndexes.setpoint.every(index => index !== null)
    && vectorIndexes.gyro.every(index => index !== null);

  if (!usable) {
    return {records: [], missing, resolved, usable: false};
  }

  const pick = (sample, index) => (index === null ? Number.NaN : sample[index]);

  const records = samples.map(sample => {
    const gyro = vectorIndexes.gyro.map(index => pick(sample, index));

    return {
      timeUs: sample[timeField.index],
      setpoint: vectorIndexes.setpoint.map(index => pick(sample, index)),
      gyro,
      // Unfiltered gyro is optional; falling back to the filtered signal keeps
      // the record shape complete and only affects the noise metric.
      raw: vectorIndexes.raw.map((index, slot) => (
        index === null ? gyro[slot] : sample[index]
      )),
      terms: termIndexes.map(index => pick(sample, index)),
      headspeed: pick(sample, scalarIndexes.headspeed),
      collective: pick(sample, scalarIndexes.collective),
      vbat: pick(sample, scalarIndexes.vbat)
    };
  });

  return {records, missing, resolved, usable: true};
}

// ---------------------------------------------------------------------------
// Stop detection
//
// Every threshold below is a physical claim about how a helicopter's command
// signal behaves, and each one names the measurement it came from. They were
// calibrated against ONE flight: `sample-bell-222ut.bbl`, a scale Bell 222UT on
// Rotorflight 4.6.0 (FRSK VANTAC_RF007, STM32F7X2), 134,429 samples spanning
// 80.98 s to 214.51 s of log time at a 993 µs median interval (min 987, max
// 1000). Decode is clean: 4,201 I frames, 130,228 P frames, 0 rejected frames,
// and a single corrupt-frame error at the end of the file.
//
// RE-MEASURED against the fixed decoder. Before commit 1fca05f the TAG8_4S16
// per-field width selectors were read from the wrong end of the lead byte,
// which permuted the four widths while leaving their sum unchanged — frame sync
// never broke, the error count stayed zero, and every setpoint, rcCommand,
// mixer and governor value in the log came out a sawtooth. Peak roll command
// read 287 deg/s against a truth of 56. Any number in this file taken on the
// old decoder was therefore measuring the decoder. Every figure quoted below
// has been re-taken; where the re-take disagreed with what the comment said,
// the comment was wrong and has been replaced.
//
// Per-axis baseline, so the next re-derivation has something to diff against:
//   roll   setpoint −55 … 56    rms 7.87  | gyro −65 … 83    rms 7.86
//   pitch  setpoint −32 … 25    rms 5.49  | gyro −39 … 30    rms 5.86
//   yaw    setpoint −250 … 250  rms 36.09 | gyro −272 … 258  rms 36.72
//   headspeed 0 / 1716 / 1867 rpm and Vbat 2204 / 2326 / 2620 (min/median/max)
//
// That flight contains 32 command excursions above 20 deg/s across the three
// axes and exactly TWO above 80 deg/s, both yaw, opposite signs, 4459.2 ms
// apart. Where a threshold is supported by all 32 it is marked measured; where
// it rests on the two, or on nothing in this log at all, it says so. One flight
// is not a calibration set, and a comment that pretends otherwise is how a
// number nobody can defend ends up gating a diagnosis.
//
// THE 33-FLIGHT CORPUS — a second body of real logs, measured 13 August 2026
//
// Two concatenated dumps were measured against every constant in this file: 36
// sessions from an M4Max on an RDMS NEXUS_XR and 73 from an OMP4MAX on a FRSK
// VANTAC_RF007, plus the reference flight. All 110 sessions decode, with one
// trailing corrupt frame and one truncated session between them.
//
// 110 SESSIONS ARE NOT 110 FLIGHTS, and every figure below depends on the
// difference. 77 of them carry a setpoint that is identically 0 on all three
// axes for their whole length, and 26 never turn the rotor above 300 rpm at all.
// Classifying on "rotor above 1000 rpm for more than 20 s AND the sticks moved"
// leaves 33 flights totalling 35.1 airborne minutes: 27 on the NEXUS_XR (14 on
// 4.6.0-RC1, 13 on RC3), 5 OMP4MAX on RC3, and the Bell reference on 4.6.0
// final. TWO board models and two airframes plus the reference — and the
// shipping firmware is represented by that one reference flight, the same flight
// everything here was already calibrated on. Corpus figures below are measured
// inside each flight's own resolved flight window, and always say "33 flights"
// so the number is never inflated to 110.
//
// WHAT 33 FLIGHTS STILL CANNOT SETTLE, said once so that nothing below is read
// as more than it is:
//
//   - NOBODY HAS ASSESSED EITHER AIRCRAFT. Neither was inspected for blade
//     track, balance, bearing wear or linkage bind. Every distribution here
//     therefore describes what is COMMON on two unassessed helicopters and says
//     nothing about what is CORRECT. A percentile is not a limit, and turning
//     one into a limit would calibrate a fault detector to the faults it exists
//     to find.
//   - THERE IS NO KNOWN-BAD CASE IN IT. No binding linkage, no over-gained axis,
//     no travel-limited control, no out-of-track rotor. Every threshold that
//     separates good from bad has one side measured and the other side empty.
//   - THE MANOEUVRES ARE NOT THERE. The corpus is hover, circuits and
//     pirouettes. At the shipped constants it yields 9 stops in 35.1 airborne
//     minutes, all nine on yaw, spread over 6 flights — and NOT ONE of the 99
//     axis-flights reaches two stops in each direction, which is the bar the
//     gain gate requires. No re-analysis of these bytes can change that.
//
// The single flight that would settle most of this file is written out under
// `MINIMUM_COMMAND_HOLD_US`.
// ---------------------------------------------------------------------------

/**
 * A command's magnitude must reach this before its release is worth measuring.
 *
 * Below it the response is dominated by trim and turbulence rather than by the
 * gains under test. On the reference flight it admits the two yaw pirouettes
 * (peak 250 deg/s) and finds nothing on roll (peak setpoint 56 deg/s) or pitch
 * (peak 32). "This flight contains no qualifying roll stops" is the honest
 * answer there, and the diagnostics prove it is the right one rather than a
 * threshold swallowing the evidence: on roll and pitch EVERY counter is zero,
 * `started` included, so no candidate was ever opened and no gate rejected
 * anything. `detectStopEvents(..., {diagnostics: true}).diagnosis.outcome`
 * reports that case as NO_COMMAND_REACHED_THRESHOLD, distinct from
 * ALL_CANDIDATES_REJECTED, because a caller that cannot tell the two apart
 * cannot tell a quiet axis from a broken detector.
 *
 * Lowering it does not rescue those axes. Swept 80 → 20 deg/s with the stop
 * threshold held at a quarter of it, roll yields at most 1 event (at 30–40
 * deg/s) and pitch never yields one, while the dominant refusal becomes
 * COMMANDED_AGAIN_INSIDE_RESPONSE_WINDOW — at a 30 deg/s command threshold roll
 * opens 5 candidates, 4 of which are refused for that reason. The pilot
 * re-commands the cyclic before the 1 s response window elapses. That is a
 * property of the flight, not of this constant: roll and pitch tuning needs a
 * log flown with deliberate stop-and-hold cyclic inputs, each followed by about
 * a second of hands-off.
 *
 * UNCONSTRAINED BY REAL DATA as a boundary. The only commands in this flight
 * that come near it are the two at 250 deg/s, so nothing here distinguishes 60
 * from 100 deg/s; the sweep above shows only that going well below it admits
 * inputs this flight cannot support, not where the true edge lies.
 *
 * THE 33-FLIGHT BRACKET, and why it is still 80.
 *
 * 80 was chosen for 3D flying and the pilot this app is for is a learner, so the
 * corpus was used to bracket it from both sides. Both bounds are now measured,
 * and they do not separate.
 *
 * LOW SIDE — where a detected stop stops being a measurement. Each axis' own
 * hands-off noise floor, RMS(setpoint − gyro) over runs of at least 0.5 s with
 * |command| at or under 3 deg/s, has a median across the 33 flights of 5.70
 * deg/s on roll (3.57 … 10.84), 3.25 on pitch and 3.76 on yaw. The share of
 * detected stops whose `trackingRmsDps` is under TWICE its own axis' floor runs
 * 44% at a command threshold of 15, 29% at 20, 19% at 25, 13% at 30, 4% at 40,
 * 3% at 50 and 6% at 80 (hold floor relaxed to 25 ms so there are events to
 * count; at the shipped 150 ms floor: 33, 29, 20, 14, 8, 0, 0%). That curve is
 * smooth and monotone. It has no elbow, so it names no lower bound — it only
 * says the contamination grows as the threshold falls.
 *
 * HIGH SIDE — where real flying stops reaching it. Peak |setpoint| per flight
 * (min/p25/median/p75/max): roll 12/21/33/56/197, pitch 14/19/26/58/140, yaw
 * 6/13/119/223/289. Flights whose peak reaches a candidate threshold, roll /
 * pitch / yaw: at 20 deg/s 28/23/21, at 30 18/13/19, at 40 11/11/19, at 80
 * 7/4/19. That curve is smooth too.
 *
 * THE TWO BOUNDS DO NOT SEPARATE CLEANLY, so the value stays. Neither curve has
 * a break in it; picking 40 rather than 30 or 50 would be choosing a point on a
 * smooth trade-off between "reaches more flights" and "measures more noise",
 * which is a percentile dressed as a limit. Worse, the noise floor those bounds
 * rest on is itself a property of two aircraft nobody has assessed — a 5.70
 * deg/s hands-off roll floor may be the airframe, and calibrating a threshold to
 * it would bake that in.
 *
 * Three further measurements, each of which would have to be answered before
 * lowering it is defensible:
 *
 *   - IT WOULD CHANGE WHAT THE REFERENCE FLIGHT REPORTS. `stopThresholdDps` is
 *     tied to a quarter of this value and doubles as the quiet band, so lowering
 *     one lowers the other. Re-run on the Bell at 50 both yaw stops survive; at
 *     40 the negative stop at 184.821 s is REFUSED
 *     COMMANDED_AGAIN_INSIDE_RESPONSE_WINDOW and an unexamined roll stop at
 *     194 s appears instead; at 25 four yaw events appear and the 184.821 s one
 *     is still gone. Lowering this constant does not add to what the owner is
 *     told about his own aircraft — it replaces it.
 *   - IT BUYS NO RECOMMENDATION. At the shipped hold floor the corpus-wide event
 *     count runs 39 at a threshold of 15, 28 at 20, 20 at 25, 14 at 30, 12 at
 *     40, 8 at 50, 9 at 80 (not even monotone), 6 at 100, 2 at 150 — and the
 *     count of axis-flights reaching two stops per direction is at most 1 of 99
 *     one of them. Over the full 9 × 7 threshold × hold-floor grid the best
 *     corner reaches it on 7 of 99, at a 15 deg/s threshold and a 25 ms hold,
 *     which is the corner where 44% of the events are noise.
 *   - THE MISSING EVIDENCE IS A MANOEUVRE, NOT A THRESHOLD. Median peak roll
 *     command over the 33 flights is 33 deg/s: this pilot mostly does not put in
 *     a definite cyclic input and then leave it alone.
 *
 * SETTLED BY: one flight per axis with deliberate stop-and-holds at 40–60 deg/s
 * and the same again at 100–150, four each way with a full second hands-off
 * after each. That measures whether `trackingRmsDps` at 40 agrees with
 * `trackingRmsDps` at 120 on one aircraft, which is the question this constant
 * actually turns on and the one no amount of hover footage can answer.
 */
const COMMAND_THRESHOLD_DPS = 80;

/**
 * At or below this the stick is back at centre; the aircraft is now free.
 *
 * Constrained from below only. It doubles as `quietBandDps`, so lowering it
 * also narrows the band the response window must stay inside: swept against the
 * two yaw stops at a fixed 80 deg/s command threshold, 15 through 60 deg/s all
 * yield both events, while 10 and 5 yield only one — the second stop is then
 * refused COMMANDED_AGAIN_INSIDE_RESPONSE_WINDOW because the aircraft's own
 * residual yaw rate leaves the narrower band. So this flight rules out anything
 * below 15 deg/s and says nothing at all about the upper side; 20 is a quarter
 * of the command threshold, and that ratio, not a measurement, is why it is 20.
 * The band it opens is where every release statistic below is measured.
 *
 * STILL A CONVENTION AFTER 33 FLIGHTS, and now measurably so. Swept at the
 * shipped 80 deg/s command threshold across the corpus, the event count rises
 * monotonically with no elbow anywhere: 3 events at 2 deg/s, 5 at 5, 5 at 10,
 * 7 at 15, 9 at 20, 11 at 25, 11 at 30, 11 at 40, 14 at 60. Nothing in 33
 * flights distinguishes the shipped 20 from 25 or 30 — the curve simply admits
 * more of the same as the band widens. UNCONSTRAINED BY REAL DATA on the upper
 * side, exactly as the reference flight left it, and labelled a ratio rather
 * than a measurement for that reason.
 */
const STOP_THRESHOLD_DPS = 20;

/**
 * The command must be held this long before it is a stop rather than a twitch.
 *
 * Measured start → last sample still above the command threshold. Measuring it
 * start → stop instead would count the release as part of the hold, which
 * matters now that releases are allowed to take hundreds of milliseconds. Both
 * genuine holds in the reference flight are ~1.5 s — 1551.6 ms and 1455.3 ms,
 * ten times this floor — so it rejects nothing at the operating threshold.
 *
 * The only place this flight exercises it is the 20 deg/s band, where the 32
 * excursions have holds from 39 ms to 3332 ms and 9 of the 32 fall below 150 ms.
 * That is the population the floor is meant to remove and it removes it, but
 * "removes the short ones" is a tautology, not a calibration: nothing here
 * distinguishes 100 ms from 200 ms. UNCONSTRAINED BY REAL DATA as a boundary.
 *
 * "IT REJECTS NOTHING AT THE OPERATING THRESHOLD" IS FALSE OFF THIS FLIGHT, and
 * that sentence above is about the reference flight alone. Across the 33-flight
 * corpus this is the DOMINANT rejector at every command threshold tried: over
 * 1,188 detector runs (33 flights × 3 axes × 12 command thresholds) the refusal
 * census is HOLD_TOO_SHORT 2,636, COMMANDED_AGAIN_INSIDE_RESPONSE_WINDOW 2,012,
 * RELEASE_TOO_SLOW 73, RELEASE_DWELL 5, RESPONSE_WINDOW_PAST_END_OF_LOG 4 — 56%
 * of all 4,730 refusals are this floor. The real hold population sits on it
 * rather than far above it: 1,043 excursions give a median hold of 119.0 ms in
 * the 80 deg/s band (p25 77.2, p75 165.2, p90 238.5) and 150.4 ms in the 20
 * deg/s band, so the floor lands within a millisecond of the median of the
 * population it filters. The reference flight's two ~1.5 s pirouettes are the
 * 99.9th percentile of the corpus, not a typical hold. Relaxing the floor to
 * 25 ms multiplies the yield 3.6× at an 80 deg/s command threshold (9 → 32
 * events) and 4.9× at 30 (14 → 69).
 *
 * IT STAYS AT 150 ms ANYWAY, and the yield is not the reason to move it: a
 * shorter hold measures a smaller settled region, and `trackingRmsDps` is only
 * meaningful over a plateau that has settled. Lowering it to buy events would
 * trade a refusal the pilot can read for a number nobody can defend. STILL
 * UNCONSTRAINED BY REAL DATA as a boundary — the corpus says what this floor
 * COSTS, not where it belongs.
 *
 * SETTLED BY: one purpose-flown log with commanded holds at 200, 400, 800 and
 * 1600 ms and a full second hands-off after each, measuring the hold length at
 * which `trackingRmsDps` stops depending on hold length. That one flight settles
 * this constant, `TRACKING_WINDOW_US` and `PLATEAU_FRACTION` together, and it is
 * the flight the whole of this file is waiting on.
 */
const MINIMUM_COMMAND_HOLD_US = 150_000;

/**
 * Longest permitted dwell at one quantised setpoint value during the release.
 *
 * PRIMARY DWELL REJECTOR, and the best-separated statistic available. Across
 * all 32 excursions in the reference flight, exactly THREE decay into a dwell
 * (the pilot easing off and then holding a lower rate) and their longest
 * plateaus are 174.8, 183.7 and 197.7 ms, while every one of the other 29
 * returns to centre with a longest plateau of 79.5 ms or less — the full sorted
 * population runs 1.0, 2.0, 3.0, 6.0, 8.9 … 44.7, 77.5, 79.5, then jumps
 * straight to 174.8. Any value inside that 79.5 → 174.8 ms gap separates all 32
 * identically; sweeping 80, 90, 101, 110, 118, 130, 150 and 170 ms all class
 * the same three as dwells, and only at 175 ms does one escape. 117.9 ms is the
 * gap's geometric midpoint, sqrt(79.5 × 174.8) = 117.88 ms, which is 1.48× clear
 * of the population on each side. Not rounded to 120 ms deliberately — a round
 * number would read as a judgement call rather than a measurement.
 *
 * WAS 101_000, justified as sqrt(79.5 × 129.1). There is no 129.1 ms plateau in
 * this log and no 153.0 ms one either; both were artefacts of the sawtooth
 * decode. 101 ms still splits the real population correctly, but its stated
 * derivation does not survive contact with the real numbers, so the value moved
 * to the midpoint the real gap actually gives. The change is inert on this
 * flight: identical events, identical classification.
 *
 * The two genuine 80 deg/s releases plateau for 1.0 ms and 0.0 ms. Against the
 * 1.0 ms one that is a factor of 118 — two orders of magnitude, not three.
 *
 * THE GAP THAT DERIVATION RESTS ON DOES NOT EXIST OUTSIDE THIS FLIGHT. The same
 * measurement over the 33-flight corpus, same 20 → 5 deg/s band, gives 802
 * excursions, and the empty 79.5 → 174.8 ms window is full: 783 plateau at or
 * under 79.5 ms, FOURTEEN land inside it — at 83, 84, 88, 88, 90, 91, 97, 108,
 * 119, 127, 129, 130, 145 and 155 ms — and 5 sit at or above 174.8. The sorted
 * population runs continuously from 52 ms to 204 ms with no break; the largest
 * multiplicative gap anywhere above 20 ms is 1.13× (155.0 → 174.8), against the
 * 2.20× gap this flight showed. So 117.9 ms is NOT a value that separates two
 * populations. It is a cut through one continuous population, and it splits the
 * 108 ms and 119 ms excursions from each other for no reason either of them
 * could tell you. The population's 99th percentile is 129.0 ms.
 *
 * The gate is also nearly dead. Over 1,188 detector runs across the corpus
 * RELEASE_DWELL fired 5 times, and sweeping this constant from 50 ms to 300 ms
 * changes the corpus-wide event count not at all — 12 events at every value at a
 * 40 deg/s command threshold, 9 at every value at 80.
 *
 * THE VALUE STAYS, THE DERIVATION GOES. 117.9 ms still classes the reference
 * flight's three dwell-decays exactly as before and still costs nothing anywhere
 * else, so moving it would change nothing and defend nothing. But the sentence
 * "any value inside that gap separates all 32 identically" is now known to be a
 * fact about one flight, and leaving it standing as the file's best-separated
 * statistic is precisely the failure this file's header warns about. Read it as
 * a defensible cut with a measured population behind it, NOT as a separation.
 *
 * SETTLED BY: a log flown with DELIBERATE decay-into-dwell releases alongside
 * clean ones on the same axis, which is the only thing that puts the two
 * populations side by side again instead of leaving one continuum to cut.
 */
const RELEASE_PLATEAU_MAX_US = 117_900;

/**
 * Slowest release still treated as a release, as a rate so it scales with the
 * band it is applied to: releaseTransitMaxUs = (command − stop) / rate.
 *
 * SECONDARY GATE. Derived in the 20 → 5 deg/s band, the only place in this
 * flight where dwell-decays and clean releases are adjacent: the plateau gate
 * above classes THREE excursions as dwells and their release rates occupy
 * 27.2–29.4 deg/s, while the slowest release it accepts runs at 48.6 deg/s.
 * 38 deg/s is the geometric midpoint, sqrt(29.4 × 48.6) = 37.80. With it, the
 * rate gate and the plateau gate agree on all 32 excursions — 0 disagreements,
 * neither rejects anything the other accepts — and that mutual consistency is
 * the only evidence either one has.
 *
 * (An earlier comment here said the plateau gate classed FIVE excursions as
 * dwells occupying 5–29 deg/s. On the fixed decoder it is three, at 27.2, 27.4
 * and 29.4 deg/s. The value 38 survives that correction unchanged because the
 * geometric midpoint barely moves: sqrt(29 × 49) and sqrt(29.4 × 48.6) round to
 * the same place.)
 *
 * HONEST LIMIT: at the 80 deg/s operating threshold this flight constrains the
 * boundary only to the open interval (29.4, 1660) deg/s — the two genuine
 * releases run at 1659.7 and 3467.6 deg/s, and there is not one observation in
 * between. This value is extrapolated from the 20 deg/s band, not measured at
 * 80. It is also not binding here: sweeping it from 10 to 1600 deg/s per second
 * yields the same two yaw events, and only at 1700 does the slower of the two
 * drop out. Its inertness is not validation.
 *
 * THIRTY-THREE FLIGHTS BRACKET IT ONLY FROM ABOVE, and very loosely. Real
 * release rates are far faster than this gate: in the 80 deg/s band, 241
 * excursions run 208 … 5,305 deg/s per second with a median of 1,849 and a 5th
 * percentile of 809 — twenty-one times the shipped value. So the corpus can say
 * only "somewhere below the 5th percentile of real releases" and nothing about
 * where inside that range the boundary belongs. Across the corpus the gate is
 * inert from 5 to 150 deg/s per second at an 80 deg/s command threshold (9
 * events at every value) and binding by exactly one event at 40 (13 events at 29
 * and below, 12 at 38 and above). STILL UNCONSTRAINED BY REAL DATA.
 *
 * SETTLED BY: the same log named under `RELEASE_PLATEAU_MAX_US` — deliberately
 * lazy releases flown alongside clean ones, so that the slow population exists
 * to be separated instead of being extrapolated from a narrower band.
 */
const MINIMUM_RELEASE_RATE_DPS_PER_SECOND = 38;

/**
 * How far the command may move back up mid-release before the release is not a
 * release.
 *
 * Both genuine releases are strictly monotone in magnitude (rebound 0 deg/s).
 * Setpoint is logged as integer deg/s and the fastest genuine release steps by
 * up to 6 LSB per sample, so a one-sample apparent rebound of a few deg/s is
 * within quantisation; 8 deg/s allows for that. Across all 32 excursions in the
 * 20 deg/s band the largest rebound seen anywhere is 1 deg/s and the largest
 * per-sample step is 2 LSB, so this gate has 8× headroom over anything the
 * flight contains and rejects nothing. The mechanism is measured, the margin is
 * a judgement.
 *
 * BOTH HALVES SURVIVE A THIRTY-THREE-FOLD LARGER SAMPLE, and one of them gets
 * tighter. Over 1,043 excursions from 33 flights (802 in the 20 deg/s band, 241
 * in the 80) the largest rebound anywhere is still 1 deg/s — p99 is 1.0 in both
 * bands — and setpoint is integer-valued on every axis of every flight, so the
 * quantisation argument holds everywhere and not just here. RELEASE_NOT_MONOTONE
 * fired ZERO times in 1,188 detector runs across the corpus.
 *
 * The margin is smaller than this flight suggested. The largest per-sample step
 * in the 80 deg/s band is 8 LSB (6 in the 20 deg/s band, matching the reference
 * flight's own fastest release), so 8 deg/s is not 8× headroom — it is EXACTLY
 * one sample's worth of quantisation at the fastest real release measured. That
 * is a tighter and more honest statement of the same conclusion, and it means
 * this constant must not be lowered without re-measuring the step population.
 */
const RELEASE_REBOUND_DPS = 8;

/**
 * Fraction of the command peak that still counts as "on the plateau".
 *
 * ANCHORING IS MEASURED; THE VALUE 0.9 IS NOT.
 *
 * The tracking window ends where the command leaves its plateau, not at the
 * stop. Anchored at the stop, the gyro's lag through the release ramp is
 * counted as tracking error. On a synthetic with a known 4.00 deg/s
 * steady-state error and a 15 ms first-order lag, a stop-anchored window
 * reports 11.81/16.50/11.68/4.69 deg/s for 1/30/100/250 ms ramps while a
 * plateau-anchored one reports 4.00/4.05/3.99/3.75. The real log agrees far
 * more strongly than the synthetic did: on the two yaw stops the same
 * comparison gives 6.01 plateau-anchored against 27.66 stop-anchored (4.60×) at
 * t = 180.361 s, and 4.42 against 57.67 (13.04×) at t = 184.821 s. Fixing
 * detection without this would trade a silent zero-event failure for a silently
 * overstated asymmetry, which on yaw is the more dangerous of the two.
 *
 * HONEST LIMIT: none of that evidence picks 0.9. This constant sets the LEVEL of
 * `trackingRmsDps`, not only its anchor. Swept 0.5 → 1.0 on the reference
 * flight's positive yaw stop, `trackingRmsDps` runs 12.84, 9.94, 9.22, 8.80,
 * 6.01, 3.46, 2.04 — a factor of 6.3 — and the SIGN of the yaw directional
 * asymmetry changes with it: at 0.5/0.6/0.7 the negative direction measures
 * worse, at 0.8/0.9 the positive one does, at 0.95/1.0 the negative one again.
 * At the shipped 0.9 the asymmetry ratio is 0.2645, twelve percent under the
 * 0.30 warn threshold, so "no asymmetry" here is a coin toss. `trackingRmsDps`
 * is comparable only between captures taken at the same `plateauFraction`.
 *
 * THE COIN TOSS IS THE MAJORITY CASE, not an artefact of one flight. Measured
 * over the 54 distinct stops the 33-flight corpus can produce — the detector run
 * permissively at a 40 deg/s command threshold and a 25 ms hold floor, because
 * the shipped constants yield only 9 stops corpus-wide — and sweeping the
 * shipped 9 × 6 `plateauFraction` × `trackingWindowUs` grid:
 *
 *   per-stop trackingRmsDps max/min over the grid   median 1.68, p90 2.92, max 32.8
 *   plateauFraction alone, trackingWindowUs 150 ms  median 1.17, max 6.29
 *   trackingWindowUs alone, plateauFraction 0.9     median 1.15, max 2.67
 *
 * Of the 11 axis-flights carrying stops in BOTH directions, the grid changes
 * WHICH DIRECTION IS NAMED WORSE on 6, and carries the 0.30
 * `directionalAsymmetryWarnRatio` across the line on 6. So more often than not,
 * the answer this constant produces about a real aircraft is a property of the
 * constant. That is the strongest evidence in this repository for
 * `requiredSweepAgreementRatio = 1.0`: unanimity across the sweep would have
 * refused to conclude on 6 of those 11.
 *
 * STILL UNCONSTRAINED BY REAL DATA, and the corpus cannot settle it, because it
 * never opens the gate this feeds: at most 1 of 99 axis-flights reach two stops per
 * direction. SETTLED BY: the purpose-flown log named under
 * `MINIMUM_COMMAND_HOLD_US` — at least four clean stops per direction per axis
 * with a full second hands-off after each, so that within-direction spread
 * exists to judge the between-direction gap against.
 */
const PLATEAU_FRACTION = 0.9;

/**
 * How far back from the plateau departure the tracking error is measured.
 *
 * UNCONSTRAINED BY REAL DATA, and not inert. Every other constant in this block
 * got a derivation; this one never had one, and it moves the conclusion. Swept
 * against the two yaw stops, the directional asymmetry ratio reads 0.0212 at
 * 20 ms, crosses the 0.30 warn threshold at 50 ms (0.3296), falls back under it
 * from 100 ms to 250 ms (0.2796, 0.2645, 0.0848), and crosses again at 500 ms
 * (0.3044) and 1000 ms (0.4809) — with the OPPOSITE direction named as worse at
 * those two. The shipped 150 ms sits in a quiet trough between two crossings.
 *
 * What the window is meant to span is the settled part of the hold, after the
 * loop has converged and before the command starts down. This flight cannot fix
 * a length for that: the two stops depart their plateaus 212.6 ms and 64.6 ms
 * before reaching centre, a 3× spread, so any fixed window covers a different
 * fraction of each. As with `plateauFraction`, `trackingRmsDps` is comparable
 * only between captures taken at the same value.
 *
 * ON REAL FLYING IT IS INERT ON THREE QUARTERS OF STOPS, which is a mechanism
 * worth stating because it explains why the aggregate looks flat while
 * individual stops move. The window runs backwards from plateau departure but is
 * clamped at the command start, so on any stop whose hold is shorter than the
 * window this constant does nothing at all. Of the 54 real stops the 33-flight
 * corpus produces, holds are 33 ms … 1650 ms with a median of 97 ms, and only
 * 12 exceed 150 ms (48 exceed 50 ms, 24 exceed 100 ms, 9 exceed 200 ms, 3 exceed
 * 250 ms). That is why the median `trackingRmsDps` is IDENTICAL — 24.88 — at
 * 100, 150, 200, 250 and 500 ms and differs only at 50 ms (18.34): above 100 ms
 * the window has already swallowed the whole hold on most stops.
 *
 * So it is live on 22% of real stops and dead on the rest — and it is on that
 * 22% that it moves the conclusion, per the direction-flip measurement recorded
 * under `PLATEAU_FRACTION`. It also means the 50 ms entry in the sweep grid is
 * doing most of the work in the unanimity gate, which is worth knowing before
 * anyone trims that grid.
 *
 * STILL UNCONSTRAINED BY REAL DATA. SETTLED BY the purpose-flown hold-length log
 * named under `MINIMUM_COMMAND_HOLD_US`: the right window is the one past which
 * `trackingRmsDps` stops depending on the window, and no flight held so far
 * contains a hold long enough to look for it.
 */
const TRACKING_WINDOW_US = 150_000;

/**
 * Ringing window: how the axis behaves in the first quarter-second after centre.
 *
 * UNCONSTRAINED BY REAL DATA. The two yaw events survive every window tried —
 * [10, 150], [20, 250], [20, 400], [50, 250] and [20, 200] ms all yield the same
 * two — but the METRIC does not: `fastRingingRmsDps` on the negative event reads
 * 56.01, 34.82, 27.22, 15.57 and 39.29 across those same five windows, a factor
 * of 3.6. The event count being insensitive says nothing about the number, and
 * the number is what gets compared between directions.
 *
 * NO STABLE WINDOW EXISTS, and 33 flights are enough to say why. Over the 54
 * real stops the corpus produces — every one of them present in all five windows,
 * so this is not a survivorship effect — the per-stop max/min across the five is
 * median 3.19, p90 5.89, max 7.41: the reference flight's 3.6 was typical, not
 * exceptional. The decisive part is the ORDERING. Mean rank of each window, 1
 * being the lowest value it produces:
 *
 *   [10, 150] ms 4.96   [20, 200] 3.91   [20, 250] 2.94   [20, 400] 1.91   [50, 250] 1.28
 *   per-window median   20.93            15.18            13.59            10.99          6.67
 *
 * That is an almost perfect monotone ordering across 54 independent stops, and
 * the pairwise ratios are tight — [20,400]/[20,200] is 0.713 median with a
 * p10–p90 of 0.693–0.798, [10,150]/[20,250] is 1.630 median, 1.284–1.777. So the
 * number is not noisy across windows; it is a DETERMINISTIC FUNCTION of them,
 * which is what taking the RMS of a decaying transient over a window gives you:
 * start later or end later and you get a smaller number, every time. Choosing a
 * better window cannot fix that.
 *
 * STILL UNCONSTRAINED BY REAL DATA, and now with the stronger claim attached:
 * the corpus shows no window choice settles it, so this constant is the wrong
 * place to look. SETTLED BY replacing the estimator rather than the window — fit
 * a decay envelope to the post-stop gyro and report its amplitude and time
 * constant, or report band-limited energy at a fixed frequency resolution. That
 * change is testable on these same 54 stops: the right estimator is the one
 * whose max/min across these five windows collapses from 3.19 towards 1.0.
 */
const FAST_WINDOW_US = Object.freeze([20_000, 250_000]);

/**
 * Slow-oscillation window, and the duration the aircraft must be left alone for.
 *
 * Definitional rather than tuned: one second after centre is the span the
 * response is claimed over, so it is also the span that must be uncommanded
 * (see `quietWindowUs`). Swept [250, 750], [300, 1000] and [250, 1500] ms, the
 * two yaw events are unchanged.
 */
const SLOW_WINDOW_US = Object.freeze([250_000, 1_000_000]);

/**
 * Minimum gap between two reported stops.
 *
 * Slightly more than the full response window, so two events cannot describe
 * overlapping seconds of flight. NON-BINDING on the reference flight: the two
 * yaw stops are 4459.2 ms apart, 4.2× this value. Swept 1050, 2000 and 4000 ms
 * both events survive; only at 4460 ms does one drop out, which measures the
 * gap rather than the constant.
 *
 * STRUCTURALLY UNREACHABLE at the shipped defaults, on any log. A reported stop
 * requires a full `quietWindowUs` (1,000,000 µs) with no command, and the next
 * command then needs `minimumCommandHoldUs` (150,000 µs) before it can stop, so
 * two reported stops are always at least 1,150,000 µs apart against this
 * 1,050,000 µs floor. It is a defensive floor for callers who lower either of
 * those two, not a gate that fires. Kept rather than deleted because a caller
 * shortening the quiet window would otherwise get overlapping events with no
 * backstop at all; a test asserts the inequality so that if it ever inverts, the
 * constant becomes live and needs a real derivation.
 *
 * Confirmed inert on the wider corpus: TOO_SOON_AFTER_PREVIOUS_STOP fired ZERO
 * times in 1,188 detector runs over 33 flights, as the arithmetic above requires.
 */
const MINIMUM_EVENT_SPACING_US = 1_050_000;

/**
 * Cap on reported events, so a pathological log cannot allocate without bound.
 *
 * NON-BINDING on the reference flight, which produces 2, and EVENT_CAP_REACHED
 * fired zero times over the 33-flight corpus at the shipped constants.
 *
 * MEASURED HEADROOM, UNCONSTRAINED BOUNDARY. Driving the detector to the most
 * permissive corner this repository can be driven to — command threshold 15,
 * stop threshold 4, hold floor 25 ms, quiet window 250 ms, event spacing 300 ms —
 * the worst single axis-flight in the corpus produces 24 events and the whole
 * corpus produces 461 across 99 axis-flights. So 64 is 2.7× the worst real case
 * rather than a number nobody had checked. It remains UNCONSTRAINED BY REAL DATA
 * as a boundary: nothing here says where a genuinely pathological log tops out,
 * only that real flying does not come close.
 */
const MAXIMUM_EVENTS = 64;

/**
 * Defaults, exported so a caller can align its gating rather than re-deriving it.
 *
 * Every entry references its module constant. Five of them — `trackingWindowUs`,
 * `fastWindowUs`, `slowWindowUs`, `minimumEventSpacingUs` and `maximumEvents` —
 * used to be literals here AND separately literals in the `detectStopEvents`
 * destructure, so editing this object changed what callers aligned to without
 * changing what the detector did. There is now exactly one place per constant.
 */
export const STOP_DETECTION_DEFAULTS = Object.freeze({
  commandThresholdDps: COMMAND_THRESHOLD_DPS,
  stopThresholdDps: STOP_THRESHOLD_DPS,
  minimumCommandHoldUs: MINIMUM_COMMAND_HOLD_US,
  releasePlateauMaxUs: RELEASE_PLATEAU_MAX_US,
  minimumReleaseRateDpsPerSecond: MINIMUM_RELEASE_RATE_DPS_PER_SECOND,
  releaseReboundDps: RELEASE_REBOUND_DPS,
  plateauFraction: PLATEAU_FRACTION,
  trackingWindowUs: TRACKING_WINDOW_US,
  fastWindowUs: FAST_WINDOW_US,
  slowWindowUs: SLOW_WINDOW_US,
  minimumEventSpacingUs: MINIMUM_EVENT_SPACING_US,
  maximumEvents: MAXIMUM_EVENTS
});

/** First index whose timeUs is >= `timeUs`, by binary search over a sorted column. */
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

/** Last index whose timeUs is <= `timeUs`, or -1. */
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

/**
 * Accumulates one derived quantity over an inclusive index range without
 * allocating.
 *
 * The previous implementation filtered all 134,429 records three times per
 * candidate. That is not a correctness problem, but this runs in an Android
 * WebView on a phone.
 */
function accumulate(records, from, to, valueOf) {
  let count = 0;
  let sum = 0;
  let sumSquares = 0;
  for (let index = from; index <= to; index += 1) {
    const value = valueOf(records[index]);
    if (Number.isFinite(value)) {
      count += 1;
      sum += value;
      sumSquares += value * value;
    }
  }
  return {
    span: Math.max(0, to - from + 1),
    count,
    mean: count === 0 ? null : sum / count,
    rms: count === 0 ? null : Math.sqrt(sumSquares / count)
  };
}

/**
 * Reconstructs stop events from records so directional evidence can be built
 * from a RotorLens decode alone.
 *
 * A stop is a sustained command on one axis released cleanly to near zero. The
 * command's sign is the whole point here — it is what makes the evidence
 * directional, and what a yaw measurement cannot be pooled across.
 *
 * Three states, because two were not enough. The previous version discarded a
 * command the moment the setpoint appeared anywhere between the stop threshold
 * and the command threshold, on the theory that this was a release into a
 * dwell. Every real release passes through that band on its way down: the two
 * genuine releases in the reference flight spend 36.8 ms and 17.9 ms inside it.
 * The old rule therefore admitted exactly one signal shape — a command that
 * reaches centre within a single 993 µs sample, i.e. a release rate above
 * 26,000 deg/s — which no stick, servo or radio link produces. It found zero
 * events in a real flight that contains two, and passed its own tests because
 * the synthetic fixture stepped from 150 to 0 in one sample.
 *
 * Traversing the band is now expected. What separates a release from a dwell is
 * measured instead: how long the command lingers at one value on the way down,
 * how fast it crosses, whether it moves back up, and whether the pilot left the
 * aircraft alone afterwards for as long as the response is measured.
 *
 * WHY A LOG YIELDED NOTHING is a first-class answer here, not something to be
 * inferred. "Your aircraft never did the manoeuvre" and "my threshold rejected
 * it" are different facts with different remedies, and a UI that shows one when
 * the other is true is worse than a UI that shows nothing. `diagnostics: true`
 * returns a `diagnosis` whose `outcome` separates them:
 *
 *   UNKNOWN_AXIS                   the caller asked for an axis that is not one
 *   NO_RECORDS                     nothing to look at
 *   AXIS_NOT_LOGGED                records exist but this axis has no finite
 *                                  setpoint sample — the field is absent or all
 *                                  gap, which is a decode problem, not a flying
 *                                  one
 *   NO_COMMAND_REACHED_THRESHOLD   the axis was logged and the command never
 *                                  got near the threshold — the aircraft did
 *                                  not do it. `peakCommandDps` is how close it
 *                                  came; roll and pitch on the reference flight
 *                                  peak at 56 and 32 against a threshold of 80.
 *   ALL_CANDIDATES_REJECTED        commands WERE found and every one was
 *                                  refused. `dominantRejectionReason` names the
 *                                  gate that did it, `rejections` counts them
 *                                  all. This is the only outcome in which
 *                                  changing a threshold could change the answer.
 *   EVENTS_DETECTED                at least one stop was measured.
 *
 * @param {object[]} records the record contract from `pid-evidence.mjs`
 * @param {object} [options] see `STOP_DETECTION_DEFAULTS`; `diagnostics: true`
 *   changes the return to `{events, candidates, counters, diagnosis}` so "why
 *   did this log yield nothing" is answerable without re-instrumenting the
 *   detector. `candidates` is capped for memory; `rejections` is not.
 * @returns {object[]|{events: object[], candidates: object[], counters: object,
 *   diagnosis: object}}
 */
export function detectStopEvents(records, options = {}) {
  const {
    axis = 'roll',
    commandThresholdDps = COMMAND_THRESHOLD_DPS,
    stopThresholdDps = STOP_THRESHOLD_DPS,
    minimumCommandHoldUs = MINIMUM_COMMAND_HOLD_US,
    releasePlateauMaxUs = RELEASE_PLATEAU_MAX_US,
    minimumReleaseRateDpsPerSecond = MINIMUM_RELEASE_RATE_DPS_PER_SECOND,
    releaseReboundDps = RELEASE_REBOUND_DPS,
    // A reversal past the stop band is a reversal, not a stop. Tied to the stop
    // threshold so there is no dead zone between the two meanings. No release in
    // the reference flight reverses, so this is UNCONSTRAINED BY REAL DATA and
    // is justified only by that internal consistency. Still true at 33 flights:
    // no release in 1,043 real excursions reverses past the stop band, and
    // RELEASE_REVERSED fired zero times in 1,188 detector runs, so the corpus
    // exercises this gate on nothing. It would take a log containing deliberate
    // through-centre reversals to constrain it.
    reversalDps = stopThresholdDps,
    plateauFraction = PLATEAU_FRACTION,
    trackingWindowUs = TRACKING_WINDOW_US,
    fastWindowUs = FAST_WINDOW_US,
    slowWindowUs = SLOW_WINDOW_US,
    // The response is measured for a full second after the stop, so the aircraft
    // must be left alone for that second. Definitional, not tuned: same duration
    // as the slow window, same band that defined the stop. Without it the fast
    // and slow windows can contain the pilot's next input and the evidence is
    // confidently about the wrong thing. NON-BINDING on the reference flight —
    // swept 200, 500, 1000 and 2000 ms the two yaw events all survive, and only
    // at 3000 ms does one drop out.
    quietWindowUs = slowWindowUs[1],
    quietBandDps = stopThresholdDps,
    minimumEventSpacingUs = MINIMUM_EVENT_SPACING_US,
    maximumEvents = MAXIMUM_EVENTS,
    diagnostics = false
  } = options;

  const events = [];
  const candidates = [];
  const counters = {
    started: 0, releasing: 0, reversed: 0, tooSlow: 0, reCommanded: 0,
    reachedStop: 0, emitted: 0
  };
  // Counted for every refusal, unlike `candidates`, which is capped. A log that
  // refuses ten thousand candidates must still be able to say what refused them.
  const rejections = {};
  let peakCommandDps = 0;
  let finiteSampleCount = 0;

  /**
   * Separates "the aircraft never did the manoeuvre" from "a gate rejected it".
   *
   * Both look identical from an empty event list, and they call for opposite
   * responses: the first needs a different flight, the second needs a different
   * threshold. Deciding between them downstream, from counters alone, is how a
   * UI ends up telling a pilot to re-fly a manoeuvre he already flew.
   */
  const diagnose = () => {
    let outcome;
    if (!Array.isArray(records) || records.length === 0) {
      outcome = 'NO_RECORDS';
    } else if (finiteSampleCount === 0) {
      outcome = 'AXIS_NOT_LOGGED';
    } else if (events.length > 0) {
      outcome = 'EVENTS_DETECTED';
    } else if (counters.started === 0) {
      outcome = 'NO_COMMAND_REACHED_THRESHOLD';
    } else {
      outcome = 'ALL_CANDIDATES_REJECTED';
    }

    let dominantRejectionReason = null;
    let dominantCount = 0;
    for (const reason of Object.keys(rejections)) {
      if (rejections[reason] > dominantCount) {
        dominantCount = rejections[reason];
        dominantRejectionReason = reason;
      }
    }

    return {
      axis,
      outcome,
      // The two numbers that make NO_COMMAND_REACHED_THRESHOLD legible: how
      // close the axis came, and to what.
      peakCommandDps,
      commandThresholdDps,
      sampleCount: Array.isArray(records) ? records.length : 0,
      finiteSampleCount,
      candidatesOpened: counters.started,
      candidatesReachingStopTest: counters.reachedStop,
      eventCount: events.length,
      rejections,
      dominantRejectionReason
    };
  };

  const finish = () => (
    diagnostics ? {events, candidates, counters, diagnosis: diagnose()} : events
  );

  const axisIndex = AXES.indexOf(axis);
  if (axisIndex === -1) {
    // An unknown axis name is a caller bug, not a quiet aircraft. Never let it
    // read as NO_COMMAND_REACHED_THRESHOLD.
    return diagnostics
      ? {events, candidates, counters, diagnosis: {...diagnose(), outcome: 'UNKNOWN_AXIS'}}
      : events;
  }
  if (!Array.isArray(records) || records.length === 0) {
    return finish();
  }

  // Derived, not hard-coded: the band the release must cross scales with the
  // thresholds, so a fixed duration would mean different physics at a different
  // command threshold.
  const releaseTransitMaxUs = minimumReleaseRateDpsPerSecond > 0
    ? (commandThresholdDps - stopThresholdDps) / minimumReleaseRateDpsPerSecond * 1e6
    : Infinity;

  const lastRecordUs = records[records.length - 1].timeUs;
  const setpointAt = index => records[index].setpoint?.[axisIndex];

  const IDLE = 0;
  const COMMANDING = 1;
  const RELEASING = 2;

  let state = IDLE;
  let commandStart = 0;
  let commandSign = 0;
  let peakDps = 0;
  let lastAbove = 0;
  let plateauDeparture = 0;
  let previousStopUs = -Infinity;

  const openCommand = (index, sign, magnitude) => {
    state = COMMANDING;
    commandStart = index;
    commandSign = sign;
    peakDps = magnitude;
    lastAbove = index;
    plateauDeparture = index;
    counters.started += 1;
  };

  /** Records why a candidate was refused, so a silent zero is never the only answer. */
  const refuse = (index, reason, extra) => {
    // Tallied unconditionally: the per-candidate detail is capped, the counts
    // are not, so `dominantRejectionReason` stays true on a long noisy log.
    rejections[reason] = (rejections[reason] ?? 0) + 1;
    if (diagnostics && candidates.length < maximumEvents * 8) {
      candidates.push({
        stopTimeUs: records[index].timeUs,
        commandSign: commandSign > 0 ? 'positive' : 'negative',
        accepted: false,
        reason,
        ...extra
      });
    }
    state = IDLE;
  };

  for (let index = 0; index < records.length; index += 1) {
    const setpoint = setpointAt(index);

    // A gap in the signal is not a stop. Nothing may span it.
    if (!Number.isFinite(setpoint)) {
      state = IDLE;
      continue;
    }

    const magnitude = Math.abs(setpoint);
    const sign = setpoint >= 0 ? 1 : -1;

    // Tracked over every finite sample, not only inside candidates: it is the
    // whole answer when nothing was detected. On the reference flight this
    // reads 56 on roll and 32 on pitch against a threshold of 80, which is why
    // those axes yield nothing and why lowering the threshold is not the fix.
    finiteSampleCount += 1;
    if (magnitude > peakCommandDps) {
      peakCommandDps = magnitude;
    }

    if (state === IDLE) {
      if (magnitude >= commandThresholdDps) {
        openCommand(index, sign, magnitude);
      }
      continue;
    }

    if (state === COMMANDING) {
      if (magnitude >= commandThresholdDps) {
        if (sign !== commandSign) {
          // Straight from one direction to the other: two commands, not one.
          openCommand(index, sign, magnitude);
          continue;
        }
        if (magnitude > peakDps) {
          peakDps = magnitude;
          // The plateau is defined against the peak, so a new peak re-anchors it.
          plateauDeparture = index;
        }
        lastAbove = index;
        if (magnitude >= plateauFraction * peakDps) {
          plateauDeparture = index;
        }
        continue;
      }
      state = RELEASING;
      counters.releasing += 1;
      // Falls through to the RELEASING rules for this same sample.
    }

    // RELEASING. Take the first rule that applies.
    if (sign !== commandSign && magnitude > reversalDps) {
      counters.reversed += 1;
      refuse(index, 'RELEASE_REVERSED', {reversalDps: magnitude});
      // A reversal that is itself a command opens the next command immediately.
      if (magnitude >= commandThresholdDps) {
        openCommand(index, sign, magnitude);
      }
      continue;
    }

    if (records[index].timeUs - records[lastAbove].timeUs > releaseTransitMaxUs) {
      counters.tooSlow += 1;
      refuse(index, 'RELEASE_TOO_SLOW', {
        transitUs: records[index].timeUs - records[lastAbove].timeUs
      });
      continue;
    }

    if (magnitude >= commandThresholdDps && sign === commandSign) {
      // The pilot pushed again before reaching centre. One command, still open.
      state = COMMANDING;
      counters.reCommanded += 1;
      if (magnitude > peakDps) {
        peakDps = magnitude;
      }
      lastAbove = index;
      if (magnitude >= plateauFraction * peakDps) {
        plateauDeparture = index;
      }
      continue;
    }

    if (magnitude > stopThresholdDps) {
      continue; // still crossing the band — this is what a release looks like
    }

    // ----- candidate stop -------------------------------------------------
    counters.reachedStop += 1;
    const stopUs = records[index].timeUs;
    const holdUs = records[lastAbove].timeUs - records[commandStart].timeUs;
    const transitUs = stopUs - records[lastAbove].timeUs;

    if (holdUs < minimumCommandHoldUs) {
      refuse(index, 'HOLD_TOO_SHORT', {holdUs});
      continue;
    }

    // Monotone in magnitude, and no dwell, across [lastAbove, stop].
    let rebound = 0;
    let plateauUs = 0;
    let runStartUs = records[lastAbove].timeUs;
    let runValue = setpointAt(lastAbove);
    for (let step = lastAbove + 1; step <= index; step += 1) {
      const value = setpointAt(step);
      rebound = Math.max(rebound, Math.abs(value) - Math.abs(setpointAt(step - 1)));
      if (value !== runValue) {
        plateauUs = Math.max(plateauUs, records[step - 1].timeUs - runStartUs);
        runStartUs = records[step].timeUs;
        runValue = value;
      }
    }
    plateauUs = Math.max(plateauUs, stopUs - runStartUs);

    if (rebound > releaseReboundDps) {
      refuse(index, 'RELEASE_NOT_MONOTONE', {reboundDps: rebound});
      continue;
    }
    if (plateauUs > releasePlateauMaxUs) {
      refuse(index, 'RELEASE_DWELL', {plateauUs});
      continue;
    }
    // No transit gate here. `transitUs` is exactly the quantity the in-loop
    // RELEASE_TOO_SLOW check above tests, at this same index and against this
    // same `lastAbove` — the only assignment to `lastAbove` between the two is
    // followed by `continue` — so any release slow enough to fail it was already
    // refused before this block could run. A second copy here fired on nothing:
    // planting a `throw` in it left the whole suite green, and a sweep of 240
    // randomized flights x 105 threshold combinations (25,200 runs, 4,407 events,
    // 66,044 RELEASE_TOO_SLOW refusals) never once reached it. It read as a
    // second line of defence while being none, which is worse than one gate that
    // looks like one gate. `transitUs` stays: the event reports it.
    if (stopUs + slowWindowUs[1] > lastRecordUs) {
      refuse(index, 'RESPONSE_WINDOW_PAST_END_OF_LOG', {});
      continue;
    }

    // The response windows must be uncommanded, or they measure the next input.
    const quietUntil = lastAtOrBefore(records, stopUs + quietWindowUs);
    let disturbed = false;
    for (let step = index + 1; step <= quietUntil; step += 1) {
      const value = setpointAt(step);
      if (!Number.isFinite(value) || Math.abs(value) > quietBandDps) {
        disturbed = true;
        refuse(index, 'COMMANDED_AGAIN_INSIDE_RESPONSE_WINDOW', {
          disturbanceTimeUs: records[step].timeUs,
          disturbanceDps: value
        });
        break;
      }
    }
    if (disturbed) {
      continue;
    }

    if (stopUs - previousStopUs < minimumEventSpacingUs) {
      refuse(index, 'TOO_SOON_AFTER_PREVIOUS_STOP', {sinceStopUs: stopUs - previousStopUs});
      continue;
    }
    if (events.length >= maximumEvents) {
      refuse(index, 'EVENT_CAP_REACHED', {});
      continue;
    }

    // ----- measurement ----------------------------------------------------
    // Tracking ends where the command left its plateau, not at the stop: the
    // gyro's lag through the release ramp is the loop doing its job, not error.
    const plateauUsAt = records[plateauDeparture].timeUs;
    const trackingFrom = Math.max(
      commandStart,
      firstAtOrAfter(records, Math.max(records[commandStart].timeUs, plateauUsAt - trackingWindowUs))
    );
    const trackingTo = plateauDeparture;
    const fastFrom = firstAtOrAfter(records, stopUs + fastWindowUs[0]);
    const fastTo = lastAtOrBefore(records, stopUs + fastWindowUs[1]);
    const slowFrom = firstAtOrAfter(records, stopUs + slowWindowUs[0]);
    const slowTo = lastAtOrBefore(records, stopUs + slowWindowUs[1]);

    if (trackingTo - trackingFrom < 1 || fastTo - fastFrom < 1 || slowTo - slowFrom < 1) {
      refuse(index, 'MEASUREMENT_WINDOW_EMPTY', {});
      continue;
    }

    const command = accumulate(records, trackingFrom, trackingTo, record => record.setpoint[axisIndex]);
    const tracking = accumulate(records, trackingFrom, trackingTo,
      record => record.setpoint[axisIndex] - record.gyro[axisIndex]);
    const fast = accumulate(records, fastFrom, fastTo, record => record.gyro[axisIndex]);
    const slow = accumulate(records, slowFrom, slowTo, record => record.gyro[axisIndex]);
    const headspeed = accumulate(records, trackingFrom, trackingTo, record => record.headspeed);

    const event = {
      stopTimeUs: stopUs,
      commandSign: commandSign > 0 ? 'positive' : 'negative',
      // The HOLD, start → last sample above the command threshold. Deliberately
      // not start → stop: that would fold the release into the hold.
      commandDurationUs: holdUs,
      commandAmplitudeDps: command.mean === null ? null : Math.abs(command.mean),
      commandPeakDps: peakDps,
      trackingRmsDps: tracking.rms,
      fastRingingRmsDps: fast.rms,
      slowOscillationRmsDps: slow.rms,
      headspeedRpm: headspeed.mean,
      // Reported rather than merely gated on, so a caller can weigh or drop a
      // lazy release itself instead of trusting a threshold buried in here.
      releaseTransitUs: transitUs,
      releaseRateDpsPerSecond: transitUs > 0
        ? (Math.abs(setpointAt(lastAbove)) - Math.abs(setpoint)) / (transitUs / 1e6)
        : null,
      releasePlateauUs: plateauUs
    };

    events.push(event);
    counters.emitted += 1;
    if (diagnostics && candidates.length < maximumEvents * 8) {
      candidates.push({stopTimeUs: stopUs, commandSign: event.commandSign, accepted: true, reason: null});
    }
    previousStopUs = stopUs;
    state = IDLE;
  }

  return finish();
}
