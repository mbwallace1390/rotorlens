/**
 * Adversarial coverage for `detectStopEvents`.
 *
 * The detector this replaced found zero stop events in a real flight that
 * contains two, and passed a green suite the whole time, because its only test
 * fixture released the command from 150 deg/s to 0 between two consecutive 1 ms
 * samples. Every case here is built around signal shapes that fixture could not
 * produce: releases that take time, releases that decay into a dwell, reversals,
 * a second input landing inside the response window, and noise sitting on the
 * thresholds.
 *
 * Two rules govern the expectations below:
 *   - every numeric expectation is derived by hand from the generated signal, or
 *     re-checked against the signal independently of the detector;
 *   - where an event COUNT would be the same whether the detector is right or
 *     wrong, the assertion is on stop times instead. A test that agrees with the
 *     bug is worse than no test, and the contaminated-window case below is the
 *     exact shape where that happens.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {detectStopEvents, STOP_DETECTION_DEFAULTS} from '../src/analysis/records.mjs';

const AXIS = 'yaw';
const AXIS_INDEX = 2;
const INTERVAL_US = 1000;

/**
 * Turns a setpoint series (one value per sample) into analysis records.
 *
 * `intervalUs` exists only so the event-cap test can build seventy stops without
 * allocating ninety thousand records; every other case uses 1 ms samples, which
 * is close enough to the reference flight's 993 µs to keep the hand arithmetic
 * in these tests honest.
 */
function toRecords(series, gyroOf = setpoint => setpoint, intervalUs = INTERVAL_US) {
  return series.map((setpoint, index) => {
    const gyro = gyroOf(setpoint, index);
    return {
      timeUs: index * intervalUs,
      setpoint: [0, 0, setpoint],
      gyro: [0, 0, gyro],
      raw: [0, 0, gyro],
      terms: [10, 20, 5],
      headspeed: 2000,
      collective: 50,
      vbat: 250
    };
  });
}

/** Constant tracking error on any commanded sample; zero when centred. */
const trackingErrorOf = errorDps => setpoint => (
  setpoint === 0 ? 0 : setpoint - errorDps * Math.sign(setpoint)
);

const holdAt = (dps, ms) => new Array(ms).fill(dps);

/** Linear ramp, excluding `from` and including `to`, one sample per ms. */
const rampTo = (from, to, ms) => Array.from(
  {length: ms},
  (unused, step) => from + (to - from) * (step + 1) / ms
);

function reasonsOf(diagnostic) {
  const counts = {};
  for (const candidate of diagnostic.candidates) {
    if (!candidate.accepted) {
      counts[candidate.reason] = (counts[candidate.reason] ?? 0) + 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Releases that take time — the failure that motivated all of this
// ---------------------------------------------------------------------------

/** One command per cycle, alternating sign, released over `rampMs`. */
function rampFlight({rampMs, count = 6, peak = 150, holdMs = 300, quietMs = 1300}) {
  const series = [];
  for (let cycle = 0; cycle < count; cycle += 1) {
    const sign = cycle % 2 === 0 ? 1 : -1;
    series.push(...holdAt(peak * sign, holdMs));
    series.push(...rampTo(peak * sign, 0, rampMs));
    series.push(...holdAt(0, quietMs));
  }
  series.push(...holdAt(0, 1200));
  return series;
}

test('a release is detected at every ramp duration from 1 ms to 400 ms', () => {
  // The old rule accepted only a release completed inside one 1 ms sample. Its
  // cliff was between 0 and 1 samples, so three sample points could straddle a
  // future cliff without seeing it — hence the sweep.
  for (let rampMs = 1; rampMs <= 400; rampMs += 1) {
    const events = detectStopEvents(toRecords(rampFlight({rampMs}), trackingErrorOf(5)), {axis: AXIS});

    assert.equal(events.length, 6, `ramp ${rampMs} ms produced ${events.length} events`);
    assert.ok(events.some(event => event.commandSign === 'positive'));
    assert.ok(events.some(event => event.commandSign === 'negative'));

    // Hold is start -> last sample at or above 80 deg/s, so it must EXCLUDE the
    // release. Ramp sample k sits at 150(1 - k/ramp); the last one at or above
    // 80 deg/s is k = floor(ramp * 7 / 15), one sample per millisecond.
    const expectedHoldUs = (300 - 1 + Math.floor(rampMs * 7 / 15)) * INTERVAL_US;
    for (const event of events) {
      assert.equal(event.commandDurationUs, expectedHoldUs, `hold at ramp ${rampMs} ms`);
      assert.equal(event.trackingRmsDps, 5, `injected tracking error at ramp ${rampMs} ms`);
    }
  }
});

test('the release characteristics are reported, not just gated on', () => {
  const events = detectStopEvents(toRecords(rampFlight({rampMs: 30}), trackingErrorOf(5)), {axis: AXIS});

  // 150 deg/s over 30 ms is 5 deg/s per sample. The last sample at or above 80
  // is k = 14 (80 exactly); the first at or below 20 is k = 26 (20 exactly).
  for (const event of events) {
    assert.equal(event.releaseTransitUs, 12_000);
    assert.equal(event.releaseRateDpsPerSecond, 5000); // (80 - 20) deg/s in 12 ms
    assert.equal(event.releasePlateauUs, 0, 'a linear ramp never dwells');
    assert.equal(event.commandPeakDps, 150);
  }
});

// ---------------------------------------------------------------------------
// Releasing into a dwell is not a stop
// ---------------------------------------------------------------------------

/** Command, ease off to a lower rate, sit there for `dwellMs`, then centre. */
function dwellFlight(dwellMs) {
  return [
    ...holdAt(150, 300),
    ...rampTo(150, 45, 100),
    ...holdAt(45, dwellMs),
    ...rampTo(45, 0, 30),
    ...holdAt(0, 2600)
  ];
}

test('a release that decays into a sustained dwell is refused, and says why', () => {
  const diagnostic = detectStopEvents(toRecords(dwellFlight(400), trackingErrorOf(5)),
    {axis: AXIS, diagnostics: true});

  assert.equal(diagnostic.events.length, 0);
  // The reason matters more than the count here: the old rule also returned 0,
  // by aborting at the first sample below the command threshold — which is what
  // it did to every genuine release too.
  assert.deepEqual(reasonsOf(diagnostic), {RELEASE_DWELL: 1});
  assert.equal(diagnostic.counters.reachedStop, 1, 'it must reach the stop test to be judged');
});

test('passing through the band is allowed; only lingering there is not', () => {
  // Same shape, dwelling for 60 ms rather than 400 — under the plateau limit
  // (117.9 ms), so this is a slow release and not a dwell. A boundary test that
  // pins the limit to the exported default exactly is further down; this one is
  // here to state the intent in readable numbers.
  assert.ok(STOP_DETECTION_DEFAULTS.releasePlateauMaxUs > 60_000);
  const events = detectStopEvents(toRecords(dwellFlight(60), trackingErrorOf(5)), {axis: AXIS});

  assert.equal(events.length, 1, 'the plateau gate is a threshold, not a ban on the band');
  // Samples 0..299 hold 150, 300..399 ramp to 45, 400..459 dwell at 45. The
  // final ramp drops 1.5 deg/s per sample from index 459, so the first sample at
  // or below 20 is 459 + 17 = 476 (45 - 25.5 = 19.5 deg/s).
  assert.equal(events[0].stopTimeUs, 476_000);
  assert.ok(events[0].releasePlateauUs <= STOP_DETECTION_DEFAULTS.releasePlateauMaxUs);
});

// ---------------------------------------------------------------------------
// Easing off is not stopping
//
// `minimumReleaseRateDpsPerSecond` had NO behavioural coverage. Every place that
// enforced it could be deleted and this suite stayed green, because the only
// thing holding the number was the bounds test further down — which asserts the
// NUMBER and never touches the CODE. That is the defect shape this file exists
// to prevent, and it had reached the shipped detector.
//
// It was also enforced in two places that read as two gates and were one: the
// check inside the release loop, and a second copy in the candidate-stop block
// evaluating the identical expression at the identical index against the
// identical `lastAbove`. The second was unreachable and has been removed, so
// these tests pin the site that is actually load-bearing — `counters.reachedStop`
// is asserted precisely because it is what tells the two sites apart.
//
// What the gate is for: a pilot who eases the stick back over several seconds is
// not testing a stop, and his gyro trace through that ramp is the loop following
// a moving command rather than an axis settling. The plateau gate cannot catch
// him — a smooth ease-off never repeats a value, so its longest plateau is one
// sample — so with the rate gate gone the ease-off is emitted as a stop event
// carrying `trackingRmsDps` and `fastRingingRmsDps`, and those numbers go on to
// describe a manoeuvre that never happened.
// ---------------------------------------------------------------------------

/** 2 s at 150 deg/s, then eased back to centre over 6 s. */
const easeOffFlight = () => [
  ...holdAt(150, 2000),
  ...rampTo(150, 0, 6000),
  ...holdAt(0, 2600)
];

/** The band the release must cross, and the time the exported defaults allow it. */
function transitLimitUs(options = {}) {
  const commandThresholdDps = options.commandThresholdDps ?? STOP_DETECTION_DEFAULTS.commandThresholdDps;
  const stopThresholdDps = options.stopThresholdDps ?? STOP_DETECTION_DEFAULTS.stopThresholdDps;
  const rate = options.minimumReleaseRateDpsPerSecond
    ?? STOP_DETECTION_DEFAULTS.minimumReleaseRateDpsPerSecond;
  return rate > 0 ? (commandThresholdDps - stopThresholdDps) / rate * 1e6 : Infinity;
}

/**
 * Re-derives, from the raw series alone, the two samples the transit is measured
 * between: the last one at or above the command threshold, and the first one at
 * or below the stop threshold after it.
 *
 * Deliberately independent of the detector. A transit taken from the event the
 * detector emitted could only ever agree with it.
 */
function transitOf(series, options = {}) {
  const commandThresholdDps = options.commandThresholdDps ?? STOP_DETECTION_DEFAULTS.commandThresholdDps;
  const stopThresholdDps = options.stopThresholdDps ?? STOP_DETECTION_DEFAULTS.stopThresholdDps;
  let lastAbove = -1;
  let stopIndex = -1;
  for (let index = 0; index < series.length; index += 1) {
    const magnitude = Math.abs(series[index]);
    if (magnitude >= commandThresholdDps) {
      lastAbove = index;
      stopIndex = -1;
    } else if (lastAbove >= 0 && stopIndex === -1 && magnitude <= stopThresholdDps) {
      stopIndex = index;
    }
  }
  return {lastAbove, stopIndex, transitUs: (stopIndex - lastAbove) * INTERVAL_US};
}

test('a command eased off over seconds is refused, and the transit gate is what refuses it', () => {
  const series = easeOffFlight();

  // Derived from the series, not from the detector. The command holds 150 deg/s
  // for samples 0..1999 and then decays by 0.025 deg/s per sample; it last sits
  // at 80 deg/s at t = 4.799 s and first reaches 20 deg/s at t = 7.199 s, so the
  // release takes 2.400 s to cross a band the defaults allow 1.579 s for.
  const {lastAbove, stopIndex, transitUs} = transitOf(series);
  assert.equal(lastAbove, 4799);
  assert.equal(stopIndex, 7199);
  assert.equal(transitUs, 2_400_000);
  assert.ok(transitUs > transitLimitUs(), `${transitUs} must exceed the allowed ${transitLimitUs()}`);

  const diagnostic = detectStopEvents(toRecords(series, trackingErrorOf(5)),
    {axis: AXIS, diagnostics: true});

  assert.equal(diagnostic.events.length, 0, 'easing the stick back is not a stop');
  assert.deepEqual(reasonsOf(diagnostic), {RELEASE_TOO_SLOW: 1});
  assert.deepEqual(diagnostic.diagnosis.rejections, {RELEASE_TOO_SLOW: 1});
  assert.equal(diagnostic.diagnosis.dominantRejectionReason, 'RELEASE_TOO_SLOW');
  assert.equal(diagnostic.diagnosis.outcome, 'ALL_CANDIDATES_REJECTED');
  assert.equal(diagnostic.counters.tooSlow, 1);

  // WHICH gate: the one inside the release loop, which fires the moment the
  // release has been under way longer than the band allows — 1.579 s after the
  // command last sat at 80 deg/s, while the stick is still out at 40.5 deg/s.
  // `reachedStop: 0` is the proof: the candidate-stop block never ran, so no gate
  // in it can be the one that refused this.
  assert.equal(diagnostic.counters.reachedStop, 0,
    'the transit gate must refuse this before the candidate-stop block is reached');
  assert.equal(diagnostic.candidates[0].stopTimeUs, 6_378_000);
  assert.equal(diagnostic.candidates[0].transitUs, 1_579_000,
    'the first sample whose elapsed release exceeds the allowed transit');
  assert.ok(diagnostic.candidates[0].transitUs > transitLimitUs());

  // AND THE CONSEQUENCE. With the rate set to 0 the derived transit limit is
  // Infinity, i.e. the gate is not applied — the same code path every other gate
  // takes, so this says every OTHER gate accepts this flight. What comes out is a
  // fabricated stop event whose own reported release rate, 25 deg/s per second,
  // is below the 38 the constant demands, carrying tracking and ringing numbers
  // for a manoeuvre the pilot never flew.
  const ungated = detectStopEvents(toRecords(series, trackingErrorOf(5)),
    {axis: AXIS, minimumReleaseRateDpsPerSecond: 0});

  assert.equal(ungated.length, 1, 'nothing else in the detector refuses this flight');
  assert.equal(ungated[0].stopTimeUs, 7_199_000);
  assert.equal(ungated[0].releaseTransitUs, 2_400_000);
  assert.equal(ungated[0].releaseRateDpsPerSecond, 25);
  assert.ok(ungated[0].releaseRateDpsPerSecond
    < STOP_DETECTION_DEFAULTS.minimumReleaseRateDpsPerSecond,
    'the fabricated event is exactly what the constant names as too slow');
  assert.equal(ungated[0].releasePlateauUs, 0,
    'a smooth ease-off never dwells, so the plateau gate cannot stand in for this one');
  assert.equal(ungated[0].trackingRmsDps, 5);
  assert.ok(ungated[0].fastRingingRmsDps > 0, 'and it carries a ringing measurement');
});

/**
 * A release whose transit is controllable to the millisecond.
 *
 * `holdMs` samples at `peak`, one sample at exactly the command threshold, then a
 * linear ramp of `transitMs` samples ending at exactly the stop threshold. The
 * last sample at or above the command threshold is therefore index `holdMs` and
 * the first at or below the stop threshold is index `holdMs + transitMs`, so the
 * transit is exactly `transitMs` ms whatever else the flight does. Every value in
 * the ramp is distinct, so the plateau gate measures 0 and cannot interfere.
 */
const transitFlight = ({transitMs, peak = 150, holdMs = 300, commandDps = 80, stopDps = 20}) => [
  ...holdAt(peak, holdMs),
  ...holdAt(commandDps, 1),
  ...rampTo(commandDps, stopDps, transitMs),
  ...holdAt(0, 1200)
];

test('the transit boundary sits exactly where the exported constants put it', () => {
  // Also pins the default against the destructure: `minimumReleaseRateDpsPerSecond`
  // is named in STOP_DETECTION_DEFAULTS and again in the detectStopEvents
  // signature, which is the drift this whole section of the file guards.
  const limitUs = transitLimitUs();

  // Accepted while transit <= limit, so the last accepted whole millisecond is
  // floor(limit / 1 ms) = 1578, and 1579 is the first refused.
  const longestAcceptedMs = Math.floor(limitUs / INTERVAL_US);

  const accepted = detectStopEvents(
    toRecords(transitFlight({transitMs: longestAcceptedMs}), trackingErrorOf(5)),
    {axis: AXIS, diagnostics: true}
  );
  assert.equal(transitOf(transitFlight({transitMs: longestAcceptedMs})).transitUs,
    longestAcceptedMs * INTERVAL_US, 'the fixture transit is what it claims');
  assert.equal(accepted.events.length, 1, `a ${longestAcceptedMs} ms transit is still a release`);
  assert.equal(accepted.events[0].releaseTransitUs, longestAcceptedMs * INTERVAL_US);
  assert.ok(accepted.events[0].releaseTransitUs <= limitUs);
  assert.equal(accepted.events[0].releasePlateauUs, 0,
    'the plateau gate is silent here, so the transit gate is the only one under test');

  const refused = detectStopEvents(
    toRecords(transitFlight({transitMs: longestAcceptedMs + 1}), trackingErrorOf(5)),
    {axis: AXIS, diagnostics: true}
  );
  assert.equal(refused.events.length, 0);
  assert.deepEqual(reasonsOf(refused), {RELEASE_TOO_SLOW: 1});
  assert.equal(refused.counters.reachedStop, 0);
});

test('the transit boundary holds across a sweep of transits and threshold combinations', () => {
  // A hand-picked transit either side of one boundary is how the last four
  // untested constants got through: it cannot see a limit that is derived from
  // the wrong quantity, only one that is off by a millisecond. So the boundary is
  // re-derived and re-checked at every combination of the three constants that
  // feed it, at every transit near it, and at randomized transits far from it.
  let boundaryChecks = 0;
  let randomChecks = 0;
  let accepted = 0;
  let rejected = 0;

  const check = (options, transitMs, peak, holdMs) => {
    const series = transitFlight({
      transitMs, peak, holdMs,
      commandDps: options.commandThresholdDps,
      stopDps: options.stopThresholdDps
    });
    const derived = transitOf(series, options);
    assert.equal(derived.transitUs, transitMs * INTERVAL_US,
      `fixture transit at ${JSON.stringify(options)} transit ${transitMs}`);

    const {events, diagnosis, counters} = detectStopEvents(toRecords(series, trackingErrorOf(5)),
      {axis: AXIS, diagnostics: true, ...options});
    const shouldAccept = derived.transitUs <= transitLimitUs(options);
    const label = `${JSON.stringify(options)} transit ${transitMs} peak ${peak} hold ${holdMs}`;

    if (shouldAccept) {
      assert.equal(events.length, 1, `expected a stop: ${label} (${JSON.stringify(diagnosis.rejections)})`);
      assert.equal(events[0].releaseTransitUs, derived.transitUs, label);
      accepted += 1;
    } else {
      assert.equal(events.length, 0, `expected no stop: ${label}`);
      assert.deepEqual(diagnosis.rejections, {RELEASE_TOO_SLOW: 1}, label);
      assert.equal(counters.reachedStop, 0, label);
      rejected += 1;
    }
  };

  // Every combination, at the exact boundary and one millisecond either side.
  for (const commandThresholdDps of [40, 80, 160]) {
    for (const stopThresholdDps of [4, 20, 30]) {
      for (const minimumReleaseRateDpsPerSecond of [12, 25, 38, 90, 300]) {
        const options = {commandThresholdDps, stopThresholdDps, minimumReleaseRateDpsPerSecond};
        const boundaryMs = Math.floor(transitLimitUs(options) / INTERVAL_US);
        assert.ok(boundaryMs >= 2, `boundary ${boundaryMs} ms is too short to straddle`);
        for (const transitMs of [boundaryMs - 1, boundaryMs, boundaryMs + 1, boundaryMs + 2]) {
          check(options, transitMs, Math.max(200, commandThresholdDps * 2), 300);
          boundaryChecks += 1;
        }
      }
    }
  }

  // And away from the boundary, with the peak, the hold and the transit random.
  const random = mulberry32(20_260_812);
  const pick = (low, high) => low + Math.floor(random() * (high - low + 1));
  for (let run = 0; run < 900; run += 1) {
    const commandThresholdDps = pick(30, 200);
    const stopThresholdDps = pick(0, commandThresholdDps - 10);
    const minimumReleaseRateDpsPerSecond = pick(8, 400);
    const options = {commandThresholdDps, stopThresholdDps, minimumReleaseRateDpsPerSecond};
    check(options, pick(1, 2500), commandThresholdDps + pick(0, 120), pick(151, 900));
    randomChecks += 1;
  }

  assert.equal(boundaryChecks, 3 * 3 * 5 * 4);
  assert.equal(randomChecks, 900);
  // A sweep that landed on one side of the gate the whole time would prove
  // nothing about where the gate is.
  assert.ok(accepted > 200, `expected plenty of accepted releases, got ${accepted}`);
  assert.ok(rejected > 200, `expected plenty of refused releases, got ${rejected}`);
});

// ---------------------------------------------------------------------------
// Reversals
// ---------------------------------------------------------------------------

test('a reversal that skips the stop band is refused', () => {
  // 150 -> 60 -> -25: never inside +/-20, so the reversal rule is what has to
  // catch it. This is the gate with no support in any real log we hold, so it is
  // pinned from both sides below rather than only at the extreme.
  const diagnostic = detectStopEvents(toRecords([
    ...holdAt(150, 300),
    ...holdAt(60, 1),
    ...holdAt(-25, 200),
    ...holdAt(0, 2600)
  ], trackingErrorOf(5)), {axis: AXIS, diagnostics: true});

  assert.equal(diagnostic.events.length, 0);
  assert.deepEqual(reasonsOf(diagnostic), {RELEASE_REVERSED: 1});
});

test('a reversal that stays inside the stop band is a stop', () => {
  // Ramp 150 -> -15 over 60 ms: 2.75 deg/s per sample. The first sample at or
  // below 20 is step 48 (150 - 132 = 18), so the stop is at 299 + 48 = 347 ms.
  // -15 is inside the +/-20 stop band, so the following second is uncommanded.
  const events = detectStopEvents(toRecords([
    ...holdAt(150, 300),
    ...rampTo(150, -15, 60),
    ...holdAt(-15, 300),
    ...holdAt(0, 2600)
  ], trackingErrorOf(5)), {axis: AXIS});

  assert.equal(events.length, 1);
  assert.equal(events[0].stopTimeUs, 347_000);
  assert.equal(events[0].commandSign, 'positive');
});

test('a reversal to just outside the stop band is refused', () => {
  // The only difference from the case above is -25 rather than -15, i.e. one
  // side of `reversalDps` versus the other. Here the command reaches the stop
  // band first, so it is the uncommanded-window rule that refuses it.
  const diagnostic = detectStopEvents(toRecords([
    ...holdAt(150, 300),
    ...rampTo(150, -25, 60),
    ...holdAt(-25, 300),
    ...holdAt(0, 2600)
  ], trackingErrorOf(5)), {axis: AXIS, diagnostics: true});

  assert.equal(diagnostic.events.length, 0);
  assert.deepEqual(reasonsOf(diagnostic), {COMMANDED_AGAIN_INSIDE_RESPONSE_WINDOW: 1});
});

test('an oscillation between the two directions produces no stops', () => {
  const series = [];
  for (let cycle = 0; cycle < 3; cycle += 1) {
    series.push(...holdAt(150, 300));
    series.push(...rampTo(150, -150, 60));
    series.push(...holdAt(-150, 100));
    series.push(...rampTo(-150, 150, 60));
    series.push(...holdAt(150, 100));
  }
  // A deliberate final release, so "no events" cannot come from the detector
  // having simply stopped tracking the signal.
  series.push(...holdAt(150, 300), ...rampTo(150, 0, 60), ...holdAt(0, 2600));

  const diagnostic = detectStopEvents(toRecords(series, trackingErrorOf(5)),
    {axis: AXIS, diagnostics: true});

  // Only the final release is a stop; every reversal in between is not. Each
  // reversal does pass through the stop band on its way to the other direction,
  // and is refused because the opposite command lands inside its response window.
  assert.equal(diagnostic.events.length, 1);
  assert.equal(diagnostic.events[0].commandSign, 'positive');
  assert.equal(reasonsOf(diagnostic).COMMANDED_AGAIN_INSIDE_RESPONSE_WINDOW, 3);
});

// ---------------------------------------------------------------------------
// The response window has to be uncommanded
// ---------------------------------------------------------------------------

test('a stop whose response window contains the next command is not the one reported', () => {
  // THE SHARPEST CASE IN THIS FILE. Both the broken and the corrected rule
  // return three events here; only the stop TIMES differ. The broken rule
  // reports the stop at 300 ms, whose fast and slow windows are measuring the
  // 140 deg/s command that arrives at 500 ms rather than the aircraft settling.
  const series = [];
  for (let cycle = 0; cycle < 3; cycle += 1) {
    series.push(...holdAt(150, 300)); // released instantly, so the old rule sees it
    series.push(...holdAt(0, 200));
    series.push(...holdAt(140, 300));
    series.push(...holdAt(0, 1300));
  }
  series.push(...holdAt(0, 1200));

  const diagnostic = detectStopEvents(toRecords(series, trackingErrorOf(5)),
    {axis: AXIS, diagnostics: true});

  assert.equal(diagnostic.events.length, 3);
  // Each cycle is 2100 ms; the clean stop is the second one, at 800 ms into it.
  assert.deepEqual(
    diagnostic.events.map(event => event.stopTimeUs),
    [800_000, 2_900_000, 5_000_000]
  );
  assert.equal(reasonsOf(diagnostic).COMMANDED_AGAIN_INSIDE_RESPONSE_WINDOW, 3);
});

test('a jab inside the response window discards the stop entirely', () => {
  const series = [];
  for (let cycle = 0; cycle < 3; cycle += 1) {
    series.push(...holdAt(150, 300));
    series.push(...holdAt(0, 40));
    series.push(...holdAt(-150, 60)); // shorter than the hold floor, so not a command
    series.push(...holdAt(0, 1300));
  }
  series.push(...holdAt(0, 1200));

  const diagnostic = detectStopEvents(toRecords(series, trackingErrorOf(5)),
    {axis: AXIS, diagnostics: true});

  assert.equal(diagnostic.events.length, 0);
  const reasons = reasonsOf(diagnostic);
  assert.equal(reasons.COMMANDED_AGAIN_INSIDE_RESPONSE_WINDOW, 3);
  assert.equal(reasons.HOLD_TOO_SHORT, 3, 'the jab itself is too short to be a command');
});

// ---------------------------------------------------------------------------
// Hold floor, and the measurement change that goes with it
// ---------------------------------------------------------------------------

test('a command held under the floor is refused, and the release does not pad the hold', () => {
  // Above the command threshold for 123 ms (120 ms at 150 deg/s plus three ramp
  // samples), then a long lazy decay to centre. Measured start -> stop, as the
  // previous version did, this reads as 288 ms and clears the 150 ms floor.
  // Measured start -> last sample above the threshold, it is what it actually
  // was: a 123 ms input, which is a twitch and not a stop test.
  const short = detectStopEvents(toRecords([
    ...holdAt(150, 120),
    ...rampTo(150, 60, 5),
    ...rampTo(60, 0, 245),
    ...holdAt(0, 2600)
  ], trackingErrorOf(5)), {axis: AXIS, diagnostics: true});

  assert.equal(short.events.length, 0);
  assert.deepEqual(reasonsOf(short), {HOLD_TOO_SHORT: 1});

  const long = detectStopEvents(toRecords([
    ...holdAt(150, 180),
    ...rampTo(150, 0, 30),
    ...holdAt(0, 2600)
  ], trackingErrorOf(5)), {axis: AXIS});

  assert.equal(long.length, 1);
  // 180 samples at 150 deg/s (t = 0..179 ms) then 14 ramp samples at or above
  // 80 deg/s: the hold ends at 193 ms.
  assert.equal(long[0].commandDurationUs, 193_000);
});

// ---------------------------------------------------------------------------
// End of log
// ---------------------------------------------------------------------------

test('a release at the very end of a log is not reported', () => {
  const truncated = detectStopEvents(toRecords([
    ...holdAt(150, 300),
    ...rampTo(150, 0, 30),
    ...holdAt(0, 900) // less than the 1 s slow window
  ], trackingErrorOf(5)), {axis: AXIS, diagnostics: true});

  assert.equal(truncated.events.length, 0);
  assert.deepEqual(reasonsOf(truncated), {RESPONSE_WINDOW_PAST_END_OF_LOG: 1});

  // One more second of log and the same release is measurable.
  const complete = detectStopEvents(toRecords([
    ...holdAt(150, 300),
    ...rampTo(150, 0, 30),
    ...holdAt(0, 1900)
  ], trackingErrorOf(5)), {axis: AXIS});
  assert.equal(complete.length, 1);
});

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

/** Deterministic PRNG; a detector whose job is to not fire needs many seeds. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test('noise across the thresholds produces no stops, over thousands of sweeps', () => {
  // Amplitudes span the stop threshold (20) and the command threshold (80) so
  // the noise is repeatedly on both sides of both gates. A single hand-picked
  // seed proves nothing about a detector whose whole job is to not fire.
  const length = 3000;
  const records = toRecords(new Array(length).fill(0));
  let runs = 0;

  for (let amplitude = 15; amplitude <= 95; amplitude += 5) {
    for (let seed = 1; seed <= 120; seed += 1) {
      const random = mulberry32(seed * 7919 + amplitude);
      for (let index = 0; index < length; index += 1) {
        const setpoint = (random() * 2 - 1) * amplitude;
        records[index].setpoint[AXIS_INDEX] = setpoint;
        records[index].gyro[AXIS_INDEX] = setpoint * 0.9;
      }
      const events = detectStopEvents(records, {axis: AXIS});
      assert.equal(events.length, 0,
        `white noise at +/-${amplitude} deg/s, seed ${seed}, produced ${events.length} events`);
      runs += 1;
    }
  }

  assert.ok(runs >= 2000, `expected a wide sweep, ran ${runs}`);
});

/**
 * A randomized flight: quiet gaps, commands of random size, hold and release,
 * with dwells and jabs mixed in and a little noise everywhere.
 *
 * Deliberately not a random walk. A walk that wanders above 80 deg/s and then
 * happens to sit inside +/-20 for a full second IS a stop, so demanding zero
 * events from one would be demanding that real stops be rejected. What is tested
 * here instead is that every event the detector emits still holds up when its
 * own claims are re-derived from the raw series.
 */
function randomFlight(random, sampleCount = 12_000) {
  const pick = (low, high) => low + Math.floor(random() * (high - low + 1));
  const noise = scale => (random() * 2 - 1) * scale;
  const series = [];

  while (series.length < sampleCount) {
    for (let step = 0; step < pick(300, 1500); step += 1) {
      series.push(noise(3));
    }

    const sign = random() < 0.5 ? 1 : -1;
    const peak = pick(30, 200) * sign;
    for (let step = 0; step < pick(50, 800); step += 1) {
      series.push(peak + noise(1));
    }

    const rampMs = pick(1, 300);
    if (random() < 0.25) {
      // Ease off to a lower rate and sit there: a dwell, not a stop.
      const dwell = pick(25, 60) * sign;
      for (const value of rampTo(peak, dwell, rampMs)) {
        series.push(value + noise(1));
      }
      for (let step = 0; step < pick(100, 600); step += 1) {
        series.push(dwell + noise(1));
      }
      for (const value of rampTo(dwell, 0, pick(1, 60))) {
        series.push(value + noise(1));
      }
    } else {
      for (const value of rampTo(peak, 0, rampMs)) {
        series.push(value + noise(1));
      }
    }

    if (random() < 0.25) {
      // A jab back the other way, landing inside the response window.
      for (let step = 0; step < pick(10, 120); step += 1) {
        series.push(noise(3));
      }
      const jab = pick(60, 200) * -sign;
      for (let step = 0; step < pick(20, 300); step += 1) {
        series.push(jab + noise(1));
      }
      for (const value of rampTo(jab, 0, pick(1, 60))) {
        series.push(value + noise(1));
      }
    }
  }

  for (let step = 0; step < 1500; step += 1) {
    series.push(noise(3));
  }
  return series;
}

test('anything the detector emits on randomized flights survives an independent re-check', () => {
  let emitted = 0;

  for (let seed = 1; seed <= 600; seed += 1) {
    const records = toRecords(randomFlight(mulberry32(seed * 104729 + 17)), setpoint => setpoint * 0.9);
    const events = detectStopEvents(records, {axis: AXIS});
    let previousStopUs = -Infinity;

    for (const event of events) {
      emitted += 1;
      const stopIndex = event.stopTimeUs / INTERVAL_US;
      const lastAboveIndex = stopIndex - event.releaseTransitUs / INTERVAL_US;
      const startIndex = lastAboveIndex - event.commandDurationUs / INTERVAL_US;
      const sign = event.commandSign === 'positive' ? 1 : -1;
      const at = index => records[index].setpoint[AXIS_INDEX];

      assert.ok(Math.abs(at(stopIndex)) <= STOP_DETECTION_DEFAULTS.stopThresholdDps,
        'the stop sample is inside the stop band');
      assert.ok(Math.abs(at(startIndex)) >= STOP_DETECTION_DEFAULTS.commandThresholdDps
        && Math.sign(at(startIndex)) === sign, 'the command opened above the threshold');
      assert.ok(Math.abs(at(lastAboveIndex)) >= STOP_DETECTION_DEFAULTS.commandThresholdDps
        && Math.sign(at(lastAboveIndex)) === sign, 'the hold ended above the threshold');
      assert.ok(event.commandDurationUs >= STOP_DETECTION_DEFAULTS.minimumCommandHoldUs,
        'the hold cleared the floor');
      assert.ok(event.releasePlateauUs <= STOP_DETECTION_DEFAULTS.releasePlateauMaxUs,
        'the release never dwelt');
      // NOT independent coverage of the spacing gate, and not claimed as any.
      // At the shipped defaults that gate cannot fire, so this floor is satisfied
      // by a detector that never applies it. The bound that does hold here —
      // consecutive stops more than (quiet window + hold floor) apart — is
      // implied by the quiet-window scan and the hold assertion above, so
      // asserting it changes nothing: every mutation that closes the gap trips
      // one of those first (verified: weakening `quietWindowUs` reports the quiet
      // scan, lowering `minimumCommandHoldUs` reports the hold floor). The gate
      // itself is exercised at the end of this file, with the two constants that
      // make it unreachable relaxed, which is the only way to reach it.
      assert.ok(event.stopTimeUs - previousStopUs >= STOP_DETECTION_DEFAULTS.minimumEventSpacingUs,
        'stops are spaced');
      previousStopUs = event.stopTimeUs;

      const quietUntil = Math.min(records.length - 1, stopIndex + 1000);
      for (let index = stopIndex + 1; index <= quietUntil; index += 1) {
        assert.ok(Math.abs(at(index)) <= STOP_DETECTION_DEFAULTS.stopThresholdDps,
          `sample ${index} disturbs the response window of the stop at ${event.stopTimeUs}`);
      }
      assert.ok(event.stopTimeUs + 1_000_000 <= (records.length - 1) * INTERVAL_US,
        'the response window fits inside the log');
    }
  }

  // Not an assertion about the aircraft — an assertion that the re-check above
  // actually ran on something. A sweep that emitted nothing tests nothing.
  assert.ok(emitted > 100, `expected plenty of events to re-check, got ${emitted}`);
});

// ---------------------------------------------------------------------------
// Where the tracking window ends
// ---------------------------------------------------------------------------

test('tracking error is measured on the plateau, not through the release ramp', () => {
  // A known steady-state tracking error of 4.00 deg/s and a first-order gyro lag
  // of 15 ms. On the plateau the gyro has long since converged, so the true
  // tracking error there is exactly 4.00 whatever the release does afterwards.
  const ERROR_DPS = 4;
  const TAU_MS = 15;
  const alpha = 1 - Math.exp(-1 / TAU_MS);

  const laggedRecords = rampMs => {
    let gyro = 0;
    return toRecords(
      [...holdAt(150, 400), ...rampTo(150, 0, rampMs), ...holdAt(0, 2600)],
      setpoint => {
        const target = setpoint === 0 ? 0 : setpoint - ERROR_DPS * Math.sign(setpoint);
        gyro += alpha * (target - gyro);
        return gyro;
      }
    );
  };

  const rmsBetween = (records, fromUs, toUs) => {
    let sum = 0;
    let count = 0;
    for (const record of records) {
      if (record.timeUs < fromUs || record.timeUs > toUs) {
        continue;
      }
      const error = record.setpoint[AXIS_INDEX] - record.gyro[AXIS_INDEX];
      sum += error * error;
      count += 1;
    }
    return Math.sqrt(sum / count);
  };

  for (const rampMs of [1, 10, 30, 50, 100, 250]) {
    const records = laggedRecords(rampMs);
    const events = detectStopEvents(records, {axis: AXIS});
    assert.equal(events.length, 1, `ramp ${rampMs} ms`);

    // The window ends at the plateau departure, so at most 10% of the peak is
    // traversed inside it: 0.1 * rampMs of a 150 ms window, where the extra lag
    // error is bounded by (slope * tau). 0.3 deg/s covers that for every ramp
    // here, and nothing wider is needed to state the truth.
    assert.ok(Math.abs(events[0].trackingRmsDps - ERROR_DPS) <= 0.3,
      `ramp ${rampMs} ms reported ${events[0].trackingRmsDps} against a truth of ${ERROR_DPS}`);

    // And the anchor is load-bearing: ending the same window at the stop sample
    // instead measures the loop chasing the ramp and reports several times the
    // real error. Computed here from the fixture, not from the detector.
    if (rampMs <= 100) {
      const stopAnchored = rmsBetween(records,
        Math.max(0, events[0].stopTimeUs - 150_000), events[0].stopTimeUs);
      assert.ok(stopAnchored > 2.5 * events[0].trackingRmsDps,
        `ramp ${rampMs} ms: stop-anchored ${stopAnchored} vs plateau-anchored ${events[0].trackingRmsDps}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Nothing is invented
// ---------------------------------------------------------------------------

test('a quiet axis yields nothing, and an axis with no records yields nothing', () => {
  const quiet = toRecords(holdAt(0, 5000));
  assert.deepEqual(detectStopEvents(quiet, {axis: AXIS}), []);
  assert.deepEqual(detectStopEvents(quiet, {axis: 'roll'}), []);
  assert.deepEqual(detectStopEvents([], {axis: AXIS}), []);
  assert.deepEqual(detectStopEvents(null, {axis: AXIS}), []);
  assert.deepEqual(detectStopEvents(quiet, {axis: 'collective'}), []);
});

test('a gap in the signal cannot be spanned by a command', () => {
  const series = [...holdAt(150, 300), ...holdAt(Number.NaN, 5), ...holdAt(0, 2600)];
  const diagnostic = detectStopEvents(toRecords(series, trackingErrorOf(5)),
    {axis: AXIS, diagnostics: true});

  assert.equal(diagnostic.events.length, 0, 'a stop across missing samples is not a measurement');
});

// ---------------------------------------------------------------------------
// Why a log yielded nothing
//
// "Your aircraft never did the manoeuvre" and "my threshold rejected it" are
// different facts with opposite remedies, and an empty event list looks the same
// either way. The reference flight is exactly this problem: roll and pitch peak
// at 56 and 32 deg/s against a threshold of 80, so no candidate is ever opened —
// telling that pilot to lower a threshold would be wrong, and telling him to
// re-fly a manoeuvre he never flew would be right.
// ---------------------------------------------------------------------------

test('an axis that was never commanded is reported as such, not as a rejection', () => {
  // Peak 40 deg/s, half the command threshold: the shape of roll and pitch on
  // the reference flight.
  const quiet = toRecords([...holdAt(40, 800), ...holdAt(0, 2600)], trackingErrorOf(5));
  const {diagnosis, counters} = detectStopEvents(quiet, {axis: AXIS, diagnostics: true});

  assert.equal(diagnosis.outcome, 'NO_COMMAND_REACHED_THRESHOLD');
  assert.equal(diagnosis.peakCommandDps, 40, 'how close the axis came is the whole answer');
  assert.equal(diagnosis.commandThresholdDps, STOP_DETECTION_DEFAULTS.commandThresholdDps);
  assert.deepEqual(diagnosis.rejections, {}, 'nothing was rejected because nothing was opened');
  assert.equal(diagnosis.dominantRejectionReason, null);
  assert.equal(counters.started, 0);
});

test('an axis that was commanded and refused names the gate that refused it', () => {
  const {diagnosis} = detectStopEvents(toRecords(dwellFlight(400), trackingErrorOf(5)),
    {axis: AXIS, diagnostics: true});

  assert.equal(diagnosis.outcome, 'ALL_CANDIDATES_REJECTED');
  assert.equal(diagnosis.dominantRejectionReason, 'RELEASE_DWELL');
  assert.deepEqual(diagnosis.rejections, {RELEASE_DWELL: 1});
  assert.equal(diagnosis.peakCommandDps, 150, 'the command DID reach the threshold');
  assert.equal(diagnosis.candidatesOpened, 1);
  assert.equal(diagnosis.candidatesReachingStopTest, 1);
});

test('the remaining outcomes are distinguished from each other', () => {
  const detected = detectStopEvents(toRecords(rampFlight({rampMs: 30}), trackingErrorOf(5)),
    {axis: AXIS, diagnostics: true});
  assert.equal(detected.diagnosis.outcome, 'EVENTS_DETECTED');
  assert.equal(detected.diagnosis.eventCount, 6);

  assert.equal(detectStopEvents([], {axis: AXIS, diagnostics: true}).diagnosis.outcome, 'NO_RECORDS');
  assert.equal(detectStopEvents(null, {axis: AXIS, diagnostics: true}).diagnosis.outcome, 'NO_RECORDS');

  // A field that is absent or entirely gap is a decode problem, not a flying
  // one, and must not read as a quiet aircraft.
  const allGap = detectStopEvents(toRecords(holdAt(Number.NaN, 3000)), {axis: AXIS, diagnostics: true});
  assert.equal(allGap.diagnosis.outcome, 'AXIS_NOT_LOGGED');
  assert.equal(allGap.diagnosis.finiteSampleCount, 0);
  assert.equal(allGap.diagnosis.sampleCount, 3000);

  // And a caller typo is a caller typo.
  const unknown = detectStopEvents(toRecords(holdAt(0, 100)), {axis: 'collective', diagnostics: true});
  assert.equal(unknown.diagnosis.outcome, 'UNKNOWN_AXIS');
});

test('the outcome never contradicts the signal, across thousands of randomized flights', () => {
  // The failure this guards is the one that matters: reporting
  // NO_COMMAND_REACHED_THRESHOLD on a flight that did contain qualifying
  // commands, or ALL_CANDIDATES_REJECTED on one that did not. A hand-picked
  // fixture cannot reach the boundary cases where a command grazes the
  // threshold, so the peak is re-derived from the raw series every time.
  const seen = new Set();
  let checked = 0;

  for (let seed = 1; seed <= 1200; seed += 1) {
    const random = mulberry32(seed * 40961 + 11);
    // A third of the sweep is deliberately capped just under the threshold, so
    // the "never commanded" branch is exercised hard rather than incidentally.
    const cap = seed % 3 === 0 ? 79 : 200;
    const series = randomFlight(random, 4000).map(value => Math.max(-cap, Math.min(cap, value)));
    const records = toRecords(series, setpoint => setpoint * 0.9);
    const {events, diagnosis} = detectStopEvents(records, {axis: AXIS, diagnostics: true});

    let peak = 0;
    for (const value of series) {
      if (Number.isFinite(value) && Math.abs(value) > peak) {
        peak = Math.abs(value);
      }
    }
    assert.equal(diagnosis.peakCommandDps, peak, `peak at seed ${seed}`);

    seen.add(diagnosis.outcome);
    checked += 1;

    if (diagnosis.outcome === 'EVENTS_DETECTED') {
      assert.ok(events.length > 0);
    } else {
      assert.equal(events.length, 0, `seed ${seed} claims ${diagnosis.outcome} with events`);
    }
    if (diagnosis.outcome === 'NO_COMMAND_REACHED_THRESHOLD') {
      assert.ok(peak < STOP_DETECTION_DEFAULTS.commandThresholdDps,
        `seed ${seed} said nothing reached ${STOP_DETECTION_DEFAULTS.commandThresholdDps} but peak was ${peak}`);
      assert.deepEqual(diagnosis.rejections, {});
    }
    if (diagnosis.outcome === 'ALL_CANDIDATES_REJECTED') {
      assert.ok(peak >= STOP_DETECTION_DEFAULTS.commandThresholdDps,
        `seed ${seed} blamed a gate on a flight whose peak was only ${peak}`);
      assert.ok(diagnosis.dominantRejectionReason !== null, `seed ${seed} blamed a gate it cannot name`);
      assert.ok(Object.values(diagnosis.rejections).reduce((sum, n) => sum + n, 0) > 0);
    }
  }

  assert.equal(checked, 1200);
  // A sweep that only ever saw one outcome would prove nothing about the split.
  for (const outcome of ['EVENTS_DETECTED', 'NO_COMMAND_REACHED_THRESHOLD', 'ALL_CANDIDATES_REJECTED']) {
    assert.ok(seen.has(outcome), `the sweep never produced ${outcome}: ${[...seen].join(', ')}`);
  }
});

test('the rejection tally survives a log with more refusals than the candidate cap holds', () => {
  // `candidates` is capped so a pathological log cannot allocate without bound.
  // The counts are not capped, because "which gate refused everything" is the
  // one thing a caller needs when a long noisy log yields nothing.
  const series = [];
  for (let cycle = 0; cycle < 40; cycle += 1) {
    series.push(...dwellFlight(400));
  }
  const {diagnosis, candidates} = detectStopEvents(toRecords(series, trackingErrorOf(5)),
    {axis: AXIS, diagnostics: true, maximumEvents: 1});

  assert.equal(candidates.length, 8, 'the per-candidate detail is capped at maximumEvents * 8');
  assert.equal(diagnosis.rejections.RELEASE_DWELL, 40, 'the tally is not');
  assert.equal(diagnosis.dominantRejectionReason, 'RELEASE_DWELL');
});

// ---------------------------------------------------------------------------
// What the reference flight actually constrains
//
// `sample-bell-222ut.bbl` can never be committed, so the figures it yields are
// recorded here as bounds instead. Every number below was re-measured against
// the FIXED decoder — before the TAG8_4S16 width-selector fix every setpoint in
// that log was a sawtooth and its peak roll command read 287 deg/s against a
// truth of 56, so any bound taken before that fix was measuring the decoder.
//
// A constant moved outside one of these ranges is a constant that would change
// what the reference flight reports, which is the one thing nobody may do
// silently. Constants the flight does NOT constrain are absent on purpose;
// inventing a bound for them would be worse than having none.
// ---------------------------------------------------------------------------

test('every constant the reference flight constrains stays inside what it measured', () => {
  const defaults = STOP_DETECTION_DEFAULTS;

  // Roll peaks at 56 deg/s and pitch at 32, so neither axis may open a
  // candidate; yaw peaks at 250 on both stops and must.
  assert.ok(defaults.commandThresholdDps > 56,
    'roll peaks at 56 deg/s in the reference flight and must not open candidates');
  assert.ok(defaults.commandThresholdDps <= 250,
    'the two genuine yaw commands peak at 250 deg/s and must open candidates');

  // Below 15 deg/s the stop band doubles as too narrow a quiet band and the
  // second yaw stop is refused COMMANDED_AGAIN_INSIDE_RESPONSE_WINDOW. Above 20
  // the flight is flat all the way to 60 and says nothing.
  assert.ok(defaults.stopThresholdDps >= 15,
    'at 10 deg/s the reference flight loses one of its two yaw stops');

  // The two genuine holds are 1551.6 ms and 1455.3 ms.
  assert.ok(defaults.minimumCommandHoldUs <= 1_455_278,
    'the shorter of the two genuine holds must clear the floor');

  // The 32 excursions split cleanly: 29 clean releases with a longest plateau of
  // 79.5 ms or less, and three dwell-decays at 174.8, 183.7 and 197.7 ms.
  assert.ok(defaults.releasePlateauMaxUs > 79_500,
    'the slowest clean release in the reference flight must survive');
  assert.ok(defaults.releasePlateauMaxUs < 174_800,
    'the fastest dwell-decay in the reference flight must not');

  // Release rates: three dwell-decays at 27.2/27.4/29.4 deg/s, the slowest
  // accepted release at 48.6, and at the operating threshold nothing at all
  // between 29.4 and the two genuine releases at 1659.7 and 3467.6.
  assert.ok(defaults.minimumReleaseRateDpsPerSecond > 29.4,
    'the fastest dwell-decay must be rejected as a release');
  assert.ok(defaults.minimumReleaseRateDpsPerSecond < 1659.7,
    'the slower of the two genuine releases must survive');

  // The derived transit limit is what the detector actually applies.
  const transitLimitUs = (defaults.commandThresholdDps - defaults.stopThresholdDps)
    / defaults.minimumReleaseRateDpsPerSecond * 1e6;
  assert.ok(transitLimitUs > 36_754,
    'the slower genuine release crosses the band in 36.754 ms and must fit');

  // The largest rebound anywhere in the 32 excursions is 1 deg/s.
  assert.ok(defaults.releaseReboundDps > 1,
    'nothing in the reference flight rebounds by more than 1 deg/s');
});

// ---------------------------------------------------------------------------
// What the 33-FLIGHT CORPUS constrains
//
// Measured 13 August 2026 over two concatenated dumps plus the reference flight:
// 110 sessions decode, 77 of them have setpoint identically zero on all three
// axes and 26 never turn the rotor above 300 rpm, leaving 33 flights and 35.1
// airborne minutes on two board models. See the corpus block in
// `src/analysis/records.mjs` for what that population can and cannot say.
//
// Only bounds that come from a MEASURED EXTREME are asserted here — the fastest
// real release step, the busiest real axis-flight, the slowest real release, the
// longest real plateau. A percentile of 33 unassessed aircraft is not a limit and
// none is written as one, so the constants this corpus cannot bound are absent
// from this block on purpose: `commandThresholdDps`, `stopThresholdDps`,
// `minimumCommandHoldUs`, `plateauFraction`, `trackingWindowUs` and
// `fastWindowUs` all stay UNCONSTRAINED and each says so at its declaration.
// ---------------------------------------------------------------------------

test('constants bounded by a measured extreme of the 33-flight corpus stay inside it', () => {
  const defaults = STOP_DETECTION_DEFAULTS;

  // Setpoint is integer deg/s on every axis of all 33 flights, and the fastest
  // real release steps by 8 LSB in one sample (6 in the 20 deg/s band). A
  // one-sample quantisation artefact on such a release is indistinguishable from
  // a rebound of the same size, so a tolerance under 8 deg/s can refuse a
  // genuine fast release for having been logged.
  assert.ok(defaults.releaseReboundDps >= 8,
    'the fastest real release steps 8 deg/s in one sample; below that the gate '
    + 'can refuse a genuine release on quantisation alone');

  // The most permissive corner this detector can be driven to (command 15, stop
  // 4, hold 25 ms, quiet 250 ms, spacing 300 ms) yields 24 events on the busiest
  // real axis-flight and 461 across all 99. A cap at or under that would silently
  // truncate a real flight rather than a pathological one.
  assert.ok(defaults.maximumEvents > 24,
    'the busiest real axis-flight yields 24 events at the most permissive '
    + 'settings, so the cap must sit above it');

  // The slowest release in 241 real excursions in the 80 deg/s band runs at
  // 208.3 deg/s per second. Above that, this gate starts refusing releases that
  // really happened on the owner's own aircraft.
  assert.ok(defaults.minimumReleaseRateDpsPerSecond < 208.3,
    'the slowest real release in the 80 deg/s band runs at 208.3 deg/s per '
    + 'second and must not be refused');

  // The longest plateau in 802 real excursions in the 20 deg/s band is 204.0 ms.
  // At or above that the dwell gate accepts everything the corpus contains and
  // is dead code rather than a gate.
  assert.ok(defaults.releasePlateauMaxUs < 204_000,
    'the longest real plateau is 204.0 ms; a limit above it makes the dwell '
    + 'gate unreachable on real flying');
});

// ---------------------------------------------------------------------------
// One place per constant
//
// Five of the twelve entries in STOP_DETECTION_DEFAULTS used to be literals in
// the frozen object AND separately literals in the detectStopEvents destructure,
// so editing the object changed what callers aligned to without changing what
// the detector did. Each test below finds the exact input at which the detector
// flips, and asserts that point against the EXPORTED default — so the two
// declarations cannot drift apart again without a red test.
// ---------------------------------------------------------------------------

test('the hold floor sits exactly at the exported minimumCommandHoldUs', () => {
  // holdAt(150, n) spans indices 0..n-1, so the measured hold is (n - 1) ms.
  const holdOf = samples => detectStopEvents(
    toRecords([...holdAt(150, samples), ...holdAt(0, 2600)], trackingErrorOf(5)),
    {axis: AXIS, diagnostics: true}
  );
  const floorSamples = STOP_DETECTION_DEFAULTS.minimumCommandHoldUs / INTERVAL_US + 1;

  const atFloor = holdOf(floorSamples);
  assert.equal(atFloor.events.length, 1);
  assert.equal(atFloor.events[0].commandDurationUs, STOP_DETECTION_DEFAULTS.minimumCommandHoldUs);

  const belowFloor = holdOf(floorSamples - 1);
  assert.equal(belowFloor.events.length, 0);
  assert.deepEqual(reasonsOf(belowFloor), {HOLD_TOO_SHORT: 1});
});

/**
 * Command, step straight to 45 deg/s, sit there `dwellMs`, then ramp to centre.
 *
 * The plateau the detector measures is the longest run at one value between the
 * last sample above the command threshold and the stop. The last such sample is
 * index 299; the run of 45s spans indices 300 .. 300 + dwellMs - 1, so the
 * measured plateau is exactly (dwellMs - 1) ms and nothing else in the release
 * repeats a value.
 */
const plateauFlight = dwellMs => [
  ...holdAt(150, 300),
  ...holdAt(45, dwellMs),
  ...rampTo(45, 0, 30),
  ...holdAt(0, 2600)
];

test('the dwell boundary sits exactly at the exported releasePlateauMaxUs', () => {
  const limitUs = STOP_DETECTION_DEFAULTS.releasePlateauMaxUs;
  const longestAcceptedDwell = Math.floor(limitUs / INTERVAL_US) + 1;

  const accepted = detectStopEvents(toRecords(plateauFlight(longestAcceptedDwell), trackingErrorOf(5)),
    {axis: AXIS, diagnostics: true});
  assert.equal(accepted.events.length, 1, `a ${longestAcceptedDwell - 1} ms plateau is a slow release`);
  assert.equal(accepted.events[0].releasePlateauUs, (longestAcceptedDwell - 1) * INTERVAL_US);
  assert.ok(accepted.events[0].releasePlateauUs <= limitUs);

  const refused = detectStopEvents(toRecords(plateauFlight(longestAcceptedDwell + 1), trackingErrorOf(5)),
    {axis: AXIS, diagnostics: true});
  assert.equal(refused.events.length, 0);
  assert.deepEqual(reasonsOf(refused), {RELEASE_DWELL: 1});

  // And the whole point of moving 101_000 -> 117_900: the reference flight's
  // clean releases top out at a 79.5 ms plateau and its three dwell-decays start
  // at 174.8 ms, so the limit has to live strictly inside that gap.
  assert.ok(limitUs > 79_500, 'the slowest clean release in the reference flight must survive');
  assert.ok(limitUs < 174_800, 'the fastest dwell-decay in the reference flight must not');
});

test('the plateau anchor sits exactly at the exported plateauFraction', () => {
  // Hold 150 with a 5 deg/s tracking error, then step to `level` with a 50 deg/s
  // one and hold that for 200 ms. If `level` still counts as the plateau the
  // tracking window ends inside the 50 deg/s segment; if it does not, the window
  // ends at the last 150 sample and never sees it.
  const PEAK = 150;
  const flightAt = level => toRecords(
    [...holdAt(PEAK, 400), ...holdAt(level, 200), ...rampTo(level, 0, 30), ...holdAt(0, 2600)],
    setpoint => {
      if (setpoint === PEAK) {
        return PEAK - 5;
      }
      if (setpoint === level) {
        return level - 50;
      }
      return setpoint;
    }
  );

  const onPlateau = Math.ceil(STOP_DETECTION_DEFAULTS.plateauFraction * PEAK);
  const included = detectStopEvents(flightAt(onPlateau), {axis: AXIS});
  assert.equal(included.length, 1);
  assert.equal(included[0].trackingRmsDps, 50, `${onPlateau} deg/s is still the plateau`);

  const excluded = detectStopEvents(flightAt(onPlateau - 1), {axis: AXIS});
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].trackingRmsDps, 5, `${onPlateau - 1} deg/s has left the plateau`);
});

test('the tracking window is exactly the exported trackingWindowUs long', () => {
  // A perfectly tracked tail of the hold, and a 20 deg/s error before it. If the
  // window is the advertised length, a clean tail of exactly (window + one
  // sample) drives the reported RMS to zero, and one sample less does not.
  // The release is a single-sample step deliberately: a ramp's first samples are
  // still above plateauFraction * peak, which walks the plateau departure into
  // the ramp and moves the window with it. That is correct behaviour, and it
  // would blur the one-sample boundary this test exists to locate.
  const HOLD = 600;
  const flightWithCleanTail = cleanSamples => toRecords(
    [...holdAt(150, HOLD), ...holdAt(0, 2600)],
    (setpoint, index) => {
      if (setpoint !== 150) {
        return setpoint;
      }
      return index >= HOLD - cleanSamples ? setpoint : setpoint - 20;
    }
  );

  const windowSamples = STOP_DETECTION_DEFAULTS.trackingWindowUs / INTERVAL_US + 1;

  const clean = detectStopEvents(flightWithCleanTail(windowSamples), {axis: AXIS});
  assert.equal(clean.length, 1);
  assert.equal(clean[0].trackingRmsDps, 0, 'the whole window is inside the clean tail');

  const oneSampleShort = detectStopEvents(flightWithCleanTail(windowSamples - 1), {axis: AXIS});
  assert.equal(oneSampleShort.length, 1);
  // Exactly one errored sample in a window of `windowSamples`: 20 / sqrt(n).
  assert.ok(Math.abs(oneSampleShort[0].trackingRmsDps - 20 / Math.sqrt(windowSamples)) < 1e-9,
    `a window one sample longer than advertised reported ${oneSampleShort[0].trackingRmsDps}`);
});

test('the fast and slow response windows sit exactly at their exported bounds', () => {
  // A single-sample gyro blip walked across the response. Which window reports
  // it locates that window's edges to one sample, without trusting the detector
  // to describe itself.
  const [fastFromUs, fastToUs] = STOP_DETECTION_DEFAULTS.fastWindowUs;
  const [slowFromUs, slowToUs] = STOP_DETECTION_DEFAULTS.slowWindowUs;
  const STOP_INDEX = 300;

  const blipAt = offsetUs => detectStopEvents(
    toRecords([...holdAt(150, STOP_INDEX), ...holdAt(0, 3000)],
      (setpoint, index) => (index === STOP_INDEX + offsetUs / INTERVAL_US ? 100 : setpoint)),
    {axis: AXIS}
  )[0];

  const justBeforeFast = blipAt(fastFromUs - INTERVAL_US);
  assert.equal(justBeforeFast.fastRingingRmsDps, 0);
  assert.equal(justBeforeFast.slowOscillationRmsDps, 0);

  assert.ok(blipAt(fastFromUs).fastRingingRmsDps > 0, 'the fast window opens at fastWindowUs[0]');
  assert.ok(blipAt(fastToUs).fastRingingRmsDps > 0, 'and closes at fastWindowUs[1]');

  // fastWindowUs[1] and slowWindowUs[0] are the same instant by construction, so
  // one sample later the blip must have moved into the slow window and only there.
  const justAfterFast = blipAt(fastToUs + INTERVAL_US);
  assert.equal(justAfterFast.fastRingingRmsDps, 0);
  assert.ok(justAfterFast.slowOscillationRmsDps > 0);
  assert.equal(slowFromUs, fastToUs, 'the two windows must not leave a gap between them');

  assert.ok(blipAt(slowToUs).slowOscillationRmsDps > 0, 'the slow window closes at slowWindowUs[1]');
  const past = blipAt(slowToUs + INTERVAL_US);
  assert.equal(past.slowOscillationRmsDps, 0);
  assert.equal(past.fastRingingRmsDps, 0);
});

test('the event cap sits exactly at the exported maximumEvents', () => {
  // Seventy clean stops, sampled at 10 ms so this stays a ten-thousand-record
  // fixture rather than a hundred-thousand-record one.
  const CAP = STOP_DETECTION_DEFAULTS.maximumEvents;
  const SAMPLE_US = 10_000;
  const series = [];
  for (let cycle = 0; cycle < CAP + 6; cycle += 1) {
    series.push(...holdAt(150, 20)); // 190 ms of hold, clear of the 150 ms floor
    series.push(...holdAt(0, 120)); // 1.2 s uncommanded, clear of the 1 s window
  }
  series.push(...holdAt(0, 150));

  const diagnostic = detectStopEvents(toRecords(series, trackingErrorOf(5), SAMPLE_US),
    {axis: AXIS, diagnostics: true});

  assert.equal(diagnostic.events.length, CAP);
  assert.equal(reasonsOf(diagnostic).EVENT_CAP_REACHED, 6);
});

test('the event spacing floor sits exactly at the exported minimumEventSpacingUs', () => {
  // At the shipped defaults this gate CANNOT fire: a stop needs a full
  // quietWindowUs (1 s) of calm before the next command may open, and that
  // command needs minimumCommandHoldUs (150 ms) before it can stop, so two
  // reported stops are always at least 1150 ms apart against a 1050 ms floor.
  assert.ok(
    STOP_DETECTION_DEFAULTS.minimumEventSpacingUs
      < STOP_DETECTION_DEFAULTS.slowWindowUs[1] + STOP_DETECTION_DEFAULTS.minimumCommandHoldUs,
    'if this ever stops being true, the gate becomes live and needs a real derivation'
  );

  // So it is pinned with those two relaxed, which is the only way to reach it.
  const relaxed = {axis: AXIS, diagnostics: true, minimumCommandHoldUs: 10_000, quietWindowUs: 100_000};
  const spacingOf = gapMs => detectStopEvents(
    toRecords([...holdAt(150, 50), ...holdAt(0, gapMs), ...holdAt(150, 50), ...holdAt(0, 2000)],
      trackingErrorOf(5)),
    relaxed
  );

  // Stops land at 50 ms and (gapMs + 100) ms, so the spacing is gapMs + 50 ms.
  const atFloorMs = STOP_DETECTION_DEFAULTS.minimumEventSpacingUs / INTERVAL_US - 50;

  const spaced = spacingOf(atFloorMs);
  assert.equal(spaced.events.length, 2);
  assert.equal(spaced.events[1].stopTimeUs - spaced.events[0].stopTimeUs,
    STOP_DETECTION_DEFAULTS.minimumEventSpacingUs);

  const tooClose = spacingOf(atFloorMs - 1);
  assert.equal(tooClose.events.length, 1);
  assert.equal(reasonsOf(tooClose).TOO_SOON_AFTER_PREVIOUS_STOP, 1);
});
