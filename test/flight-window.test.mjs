/**
 * Cover for `src/analysis/flight-window.mjs`.
 *
 * The failure this file is written against is the one that has shipped five
 * times in this repository: a test that cannot reach the failure it names. The
 * shape it would take here is obvious — generate a flight by adding a constant
 * to a collective column, then assert that a detector which looks for a
 * constant added to a collective column finds it. That passes for a detector
 * with the ground level hard-coded, for one that ignores the rotor entirely,
 * and for one that returns the midpoint of the log.
 *
 * So the randomized generator below is written from the flight, not from the
 * rule: it picks a rotor ramp, a ground collective in ITS OWN arbitrary units
 * and offset, a liftoff instant, a landing instant, a sample rate and a noise
 * level, and only then renders sample rows. Nothing it does is expressed in
 * terms of `FLIGHT_WINDOW_CONSTANTS`. The tolerance is stated in seconds of
 * flight, not in multiples of any threshold.
 *
 * And the property swept over thousands of flights is not "it finds the
 * liftoff". It is "it never says a liftoff happened somewhere it did not" —
 * which is the property that survives contact with a log the rule cannot read.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

import {
  FLIGHT_WINDOW_CONSTANTS,
  FlightWindowBasis,
  FlightWindowCheck,
  checkFlightWindow,
  detectFlightWindow,
  resolveFlightWindow
} from '../src/analysis/flight-window.mjs';
import {FIELD_MAP, buildAnalysisRecords} from '../src/analysis/records.mjs';
import {decodeLog} from '../src/blackbox/decode.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(projectRoot, 'fixtures', 'synthetic', 'rf46-stop-manoeuvres.TXT');

const REAL_LOG = process.env.ROTORLENS_REAL_LOG;
const realLogSkip = !REAL_LOG && 'set ROTORLENS_REAL_LOG to a .bbl path to run this';

/**
 * The other three sample logs sit beside the reference one and are not in the
 * repository. Found by name rather than by a second environment variable; each
 * test that needs them skips loudly when they are absent rather than passing
 * on an empty list.
 */
const SIBLING_LOGS = ['sample-clean-tuned.bbl', 'sample-governor-sag.bbl', 'sample-vibration-problem.bbl'];
const siblingPaths = REAL_LOG
  ? SIBLING_LOGS.map(name => path.join(path.dirname(REAL_LOG), name)).filter(file => existsSync(file))
  : [];
const siblingSkip = siblingPaths.length === SIBLING_LOGS.length
  ? false
  : `needs ${SIBLING_LOGS.join(', ')} beside ROTORLENS_REAL_LOG`;

async function decodeFile(file) {
  return decodeLog(new Uint8Array(await readFile(file))).sessions[0];
}

// ---------------------------------------------------------------------------
// A deterministic PRNG, so a failure is reproducible from its seed alone.
// ---------------------------------------------------------------------------

function makeRandom(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

const pick = (random, low, high) => low + random() * (high - low);

/**
 * Renders one flight as decoder-shaped sample rows.
 *
 * Written as a narrative — spool up, hover, land, spool down — with every unit
 * chosen at random so nothing about the rendering can be read back out of the
 * detector's constants. `collectiveOffset` and `collectiveScale` in particular
 * exist because absolute collective thresholds are the failure mode this rule
 * was designed around: the reference log's collective is centred on 0 and the
 * repo fixture's sits at 1200.
 */
function synthesizeFlight(random, overrides = {}) {
  const sampleHz = overrides.sampleHz ?? Math.round(pick(random, 120, 900));
  const intervalUs = 1e6 / sampleHz;
  const startTimeUs = overrides.startTimeUs ?? Math.round(pick(random, 0, 400e6));

  const armToSpinS = pick(random, 0.5, 6);
  const spinUpS = pick(random, 4, 14);
  const liftoffS = overrides.liftoffS
    ?? armToSpinS + spinUpS + pick(random, 1.5, 12);
  const flightS = overrides.flightS ?? pick(random, 12, 40);
  const landingS = liftoffS + flightS;
  const spinDownS = pick(random, 3, 10);
  const totalS = overrides.totalS ?? landingS + pick(random, 3, 12) + spinDownS;

  const flightRpm = pick(random, 900, 3200);
  const collectiveScale = overrides.collectiveScale ?? pick(random, 0.2, 6);
  const collectiveOffset = overrides.collectiveOffset ?? pick(random, -1500, 1500);
  // Ground collective is negative pitch on a real machine; flight collective is
  // whatever holds it up. Both in the flight's own arbitrary units.
  const groundPitch = pick(random, -12, -2);
  const flightPitch = overrides.flightPitch ?? groundPitch + pick(random, 4, 14);
  const groundNoise = pick(random, 0.05, 1.2);
  const flightNoise = pick(random, 0.3, 2.5);
  const liftRampS = pick(random, 0.15, 0.8);
  const landRampS = pick(random, 0.2, 1.2);

  const count = Math.round(totalS * sampleHz);
  const samples = [];

  for (let at = 0; at < count; at += 1) {
    const seconds = at / sampleHz;

    let rpm = 0;
    if (seconds > armToSpinS) {
      rpm = Math.min(flightRpm, flightRpm * (seconds - armToSpinS) / spinUpS);
    }
    if (seconds > landingS + 1) {
      rpm = Math.max(0, flightRpm * (1 - (seconds - landingS - 1) / spinDownS));
    }
    rpm += pick(random, -6, 6);

    let pitch = groundPitch;
    if (seconds >= liftoffS && seconds < landingS) {
      const ramp = Math.min(1, (seconds - liftoffS) / liftRampS);
      pitch = groundPitch + ramp * (flightPitch - groundPitch);
      pitch += Math.sin(seconds * 2.1) * flightNoise;
    } else if (seconds >= landingS) {
      const ramp = Math.min(1, (seconds - landingS) / landRampS);
      pitch = flightPitch + ramp * (groundPitch - flightPitch);
    }
    if (seconds < liftoffS) {
      pitch += pick(random, -groundNoise, groundNoise);
      // A pre-takeoff stick check, on the skids with the head still slow. This
      // is the excursion that makes a collective-only rule pick 3 s instead of
      // 22 s on the reference log, so every generated flight gets one.
      if (seconds > armToSpinS * 0.5 && seconds < armToSpinS * 0.5 + 0.6) {
        pitch = flightPitch + pick(random, 0, 3);
      }
    }

    samples.push([
      Math.round(startTimeUs + at * intervalUs),
      Math.max(0, rpm),
      collectiveOffset + collectiveScale * pitch
    ]);
  }

  return {
    session: {
      fields: [
        {name: 'time', index: 0},
        {name: 'headspeed', index: 1},
        {name: 'rcCommand[3]', index: 2}
      ],
      samples,
      events: []
    },
    truth: {
      startTimeUs,
      liftoffUs: startTimeUs + liftoffS * 1e6,
      // Two instants, because a landing is not one: `descentUs` is where the
      // pilot starts putting it down and `touchdownUs` is where collective
      // reaches ground level. The machine is flying for all of the time
      // between them, so a correct window ends somewhere in that band.
      descentUs: startTimeUs + landingS * 1e6,
      touchdownUs: startTimeUs + (landingS + landRampS) * 1e6,
      liftoffS,
      landingS,
      landRampS,
      totalS,
      sampleHz
    }
  };
}

// ---------------------------------------------------------------------------
// The randomized sweep
// ---------------------------------------------------------------------------

test('across thousands of randomized flights the window brackets the real one, in the flight\'s own units', () => {
  /**
   * The two directions of error are NOT symmetric and the assertions below are
   * deliberately not symmetric either.
   *
   * Opening the window EARLY is the damaging error: it readmits the spool-up,
   * which is the entire thing this module exists to remove, and it does it
   * silently. Opening it LATE only costs a second of hover. So early is capped
   * hard at a quarter of a second, and late is allowed to degrade — but its
   * spread is pinned, because "late is allowed" would otherwise excuse a rule
   * that had stopped working and was answering somewhere in the middle of the
   * flight.
   *
   * The tail of late answers is real and is not a defect: the generator draws
   * flights whose in-flight collective oscillation is comparable to the
   * separation between ground and flight collective, and on those the crossing
   * genuinely is not resolvable to better than a second or two.
   */
  const detectedErrorsS = [];
  const failures = [];

  for (let seed = 1; seed <= 3000; seed += 1) {
    const random = makeRandom(seed * 2654435761);
    const {session, truth} = synthesizeFlight(random);
    const window = detectFlightWindow(session);

    if (window.basis !== FlightWindowBasis.DETECTED) {
      // Declining is allowed. Claiming a window while declining is not.
      if (window.trimmed) {
        failures.push(`seed ${seed}: basis ${window.basis} but trimmed the log anyway`);
      }
      continue;
    }

    const liftErrorS = (window.startUs - truth.liftoffUs) / 1e6;
    detectedErrorsS.push(liftErrorS);

    if (liftErrorS < -0.25) {
      failures.push(`seed ${seed}: window opens ${(-liftErrorS).toFixed(3)} s BEFORE the liftoff`);
    }
    if (liftErrorS > 4) {
      failures.push(`seed ${seed}: window opens ${liftErrorS.toFixed(3)} s after the liftoff`);
    }
    // The end must land inside the descent, not merely near it: earlier than
    // the descent began would cut real flight off, later than touchdown plus a
    // second would be keeping ground data.
    if (window.endUs < truth.descentUs - 1e6 || window.endUs > truth.touchdownUs + 1e6) {
      failures.push(
        `seed ${seed}: landing at ${((window.endUs - truth.startTimeUs) / 1e6).toFixed(3)} s, `
        + `descent ${truth.landingS.toFixed(3)}..${(truth.landingS + truth.landRampS).toFixed(3)} s`
      );
    }
    // The window must never contain the pre-takeoff stick check, which lives in
    // the first few seconds of every generated flight.
    if (window.startUs < truth.startTimeUs + 1e6) {
      failures.push(`seed ${seed}: window opens ${(window.startUs - truth.startTimeUs) / 1e6} s in`);
    }
    if (window.takeoff.signal !== 'collective-above-ground-with-rotor-at-speed') {
      failures.push(`seed ${seed}: takeoff signal ${window.takeoff.signal}`);
    }
  }

  assert.deepEqual(failures.slice(0, 12), [], `${failures.length} of 3000 flights failed`);
  // A sweep that declined every flight would pass every assertion above.
  assert.ok(detectedErrorsS.length > 2700, `only ${detectedErrorsS.length} of 3000 produced a window`);

  const sorted = detectedErrorsS.slice().sort((left, right) => left - right);
  const at = fraction => sorted[Math.round(fraction * (sorted.length - 1))];
  assert.ok(Math.abs(at(0.5)) < 0.2, `median liftoff error ${at(0.5).toFixed(3)} s`);
  assert.ok(at(0.95) < 1.0, `95th percentile liftoff error ${at(0.95).toFixed(3)} s`);
  assert.ok(at(0.99) < 2.5, `99th percentile liftoff error ${at(0.99).toFixed(3)} s`);
});

test('the rule is independent of the log rate, from 60 Hz to 8 kHz', () => {
  // The sweep above runs at rates that keep it fast. Rate independence is a
  // separate claim and is worth proving at the ends of the real range: the
  // holds are expressed in microseconds, and a rule that had drifted into
  // counting samples would fail at one end or the other.
  const failures = [];

  for (const sampleHz of [60, 250, 1000, 2000, 4000, 8000]) {
    for (let seed = 1; seed <= 6; seed += 1) {
      const random = makeRandom(seed * 7919 + sampleHz);
      const {session, truth} = synthesizeFlight(random, {
        sampleHz, liftoffS: 24, flightS: 14, totalS: 46
      });
      const window = detectFlightWindow(session);
      if (window.basis !== FlightWindowBasis.DETECTED) {
        failures.push(`${sampleHz} Hz seed ${seed}: ${window.basis}`);
        continue;
      }
      const liftErrorS = (window.startUs - truth.liftoffUs) / 1e6;
      const landErrorS = (window.endUs - truth.touchdownUs) / 1e6;
      if (Math.abs(liftErrorS) > 1 || Math.abs(landErrorS) > 1) {
        failures.push(`${sampleHz} Hz seed ${seed}: ${liftErrorS.toFixed(3)} / ${landErrorS.toFixed(3)} s`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test('a flight the rule cannot separate is declined, never guessed at', () => {
  // Flight collective barely above the ground noise: the honest outcomes are a
  // window near the truth or no window at all. A confident wrong answer is the
  // failure being swept for.
  const failures = [];
  let declined = 0;

  for (let seed = 1; seed <= 1500; seed += 1) {
    const random = makeRandom(seed * 40503);
    const {session, truth} = synthesizeFlight(random);
    // Collapse the lift: the rotor still spools up and runs, but the collective
    // column carries nothing but its own ground level and dither. There is no
    // takeoff to find in it and the only correct answer is to say so.
    const noise = makeRandom(seed * 7 + 5);
    const groundValue = session.samples[Math.trunc(session.samples.length * 0.05)][2];
    const flat = session.samples.map(row => [row[0], row[1], groundValue + (noise() - 0.5) * 0.01]);
    const window = detectFlightWindow({...session, samples: flat});

    if (window.basis === FlightWindowBasis.DETECTED
        || window.basis === FlightWindowBasis.ENDED_IN_FLIGHT) {
      failures.push(`seed ${seed}: claimed ${window.basis} on a flat collective`);
      continue;
    }
    declined += 1;
    assert.equal(window.startUs, truth.startTimeUs);
    assert.equal(window.trimmed, false);
  }

  assert.deepEqual(failures.slice(0, 8), [], `${failures.length} of 1500 flat columns produced a claim`);
  assert.equal(declined, 1500);
});

test('the liftoff margin is load-bearing, not decoration', () => {
  // A constant nobody can move without changing an answer is a constant nobody
  // can verify. Sweeping it on generated flights proves it decides something:
  // widened far enough it must stop finding the liftoff it found at 3.
  const random = makeRandom(99991);
  const {session, truth} = synthesizeFlight(random, {liftoffS: 30, flightS: 40, totalS: 90});

  const base = detectFlightWindow(session);
  assert.equal(base.basis, FlightWindowBasis.DETECTED);
  assert.ok(Math.abs(base.startUs - truth.liftoffUs) < 1e6);

  const widened = detectFlightWindow(session, {constants: {liftMargin: 400}});
  assert.equal(widened.basis, FlightWindowBasis.NO_LIFTOFF);
  assert.equal(widened.trimmed, false);

  const narrowed = detectFlightWindow(session, {constants: {liftMargin: 0.01}});
  // Narrowed to nothing it fires on ground noise the moment the rotor is up —
  // earlier than the truth, which is exactly why the margin exists.
  assert.ok(
    narrowed.startUs < base.startUs,
    `expected an earlier liftoff at margin 0.01, got ${narrowed.startUs} vs ${base.startUs}`
  );
});

// ---------------------------------------------------------------------------
// Honest degradation
// ---------------------------------------------------------------------------

test('a log with no collective column returns the whole recording and says why', () => {
  const {session} = synthesizeFlight(makeRandom(7));
  const noCollective = {
    fields: session.fields.filter(field => field.name !== 'rcCommand[3]'),
    samples: session.samples,
    events: []
  };

  const window = detectFlightWindow(noCollective);
  assert.equal(window.basis, FlightWindowBasis.NO_COLLECTIVE);
  assert.equal(window.startUs, session.samples[0][0]);
  assert.equal(window.endUs, session.samples[session.samples.length - 1][0]);
  assert.equal(window.trimmed, false);
  assert.equal(window.coverageRatio, 1);
  assert.equal(window.takeoff.timeUs, null);
  assert.equal(window.takeoff.signal, null);
});

test('a log with no headspeed column cannot apply the rotor gate and says so', () => {
  const {session} = synthesizeFlight(makeRandom(11));
  const window = detectFlightWindow({
    fields: session.fields.filter(field => field.name !== 'headspeed'),
    samples: session.samples,
    events: []
  });

  assert.equal(window.basis, FlightWindowBasis.NO_HEADSPEED);
  assert.equal(window.trimmed, false);
});

test('a recording that begins with the rotor already up has no takeoff to find', () => {
  const random = makeRandom(23);
  const {session, truth} = synthesizeFlight(random, {liftoffS: 20, flightS: 60, totalS: 100});
  // Cut both ends off: the log now opens mid-air with the head already at
  // speed and stops before the spool-down, which is the shape the repo's own
  // stop fixture has and the symmetric case to a log cut in flight.
  const midAir = session.samples.filter(row => {
    const seconds = (row[0] - truth.startTimeUs) / 1e6;
    return seconds > truth.liftoffS + 10 && seconds < truth.landingS - 5;
  });
  assert.ok(midAir.length > 1000);

  const window = detectFlightWindow({fields: session.fields, samples: midAir, events: []});
  assert.equal(window.basis, FlightWindowBasis.NO_ROTOR_START);
  assert.equal(window.startUs, midAir[0][0]);
  assert.equal(window.endUs, midAir[midAir.length - 1][0]);
  assert.equal(window.trimmed, false);
});

test('a recording cut while still flying reports no landing rather than inventing one', () => {
  const random = makeRandom(31);
  const {session, truth} = synthesizeFlight(random, {liftoffS: 25, flightS: 120, totalS: 200});
  // Power off mid-flight: everything after the cut simply does not exist.
  const cutS = truth.liftoffS + 40;
  const cut = session.samples.filter(row => (row[0] - truth.startTimeUs) / 1e6 <= cutS);

  const window = detectFlightWindow({fields: session.fields, samples: cut, events: []});
  assert.equal(window.basis, FlightWindowBasis.ENDED_IN_FLIGHT);
  assert.ok(Math.abs(window.startUs - truth.liftoffUs) < 1e6);
  assert.equal(window.endUs, cut[cut.length - 1][0], 'the window runs to the last sample');
  assert.equal(window.landing.timeUs, null, 'no landing instant may be reported');
  assert.equal(window.landing.signal, null);
  assert.equal(window.landing.basis, FlightWindowBasis.ENDED_IN_FLIGHT);
});

test('a recording cut moments after touchdown is not credited with a landing', () => {
  /**
   * This test exists because mutating the settle-hold guard to `true` left the
   * whole suite green. Both "ends in flight" cases above are protected by a
   * different clause — the log's last sample IS above the settle level, so
   * there is no sample after it to call a landing — and neither one ever
   * reaches the duration check. A guard no test can reach is the defect that
   * has shipped five times in this repository.
   *
   * The case that reaches it: the collective genuinely comes back to ground
   * level and the recording stops a moment later. That is indistinguishable
   * from a power cut during a fast descent, so it must not be called a landing;
   * given a few more seconds of quiet ground it must be.
   */
  const random = makeRandom(151);
  const {session, truth} = synthesizeFlight(random, {
    sampleHz: 500, liftoffS: 20, flightS: 25, totalS: 70
  });
  const touchdownS = (truth.touchdownUs - truth.startTimeUs) / 1e6;
  const cutAt = seconds => ({
    fields: session.fields,
    samples: session.samples.filter(row => (row[0] - truth.startTimeUs) / 1e6 <= seconds),
    events: []
  });

  const hair = detectFlightWindow(cutAt(touchdownS + 0.5));
  assert.equal(hair.basis, FlightWindowBasis.ENDED_IN_FLIGHT);
  assert.equal(hair.landing.timeUs, null);

  const brief = detectFlightWindow(cutAt(touchdownS + 1.5));
  assert.equal(brief.basis, FlightWindowBasis.ENDED_IN_FLIGHT, 'still under the settle hold');

  const settled = detectFlightWindow(cutAt(touchdownS + 4));
  assert.equal(settled.basis, FlightWindowBasis.DETECTED);
  assert.ok(Math.abs(settled.landing.timeUs - truth.touchdownUs) < 1e6);
  assert.equal(settled.landing.signal, 'collective-returned-to-ground-and-stayed');
  assert.ok(settled.landing.detail.settledForUs >= FLIGHT_WINDOW_CONSTANTS.settleHoldUs);
});

test('an empty session degrades to a stated absence, not a crash', () => {
  for (const empty of [{}, {samples: [], fields: []}, [], {records: []}]) {
    const window = detectFlightWindow(empty);
    assert.equal(window.basis, FlightWindowBasis.NO_SAMPLES);
    assert.equal(window.startUs, null);
    assert.equal(window.endUs, null);
    assert.equal(window.durationUs, null);
  }
});

test('gaps in the collective column break a run rather than bridging it', () => {
  const random = makeRandom(41);
  const {session, truth} = synthesizeFlight(random, {liftoffS: 20, flightS: 40, totalS: 80});
  const holed = session.samples.map(row => row.slice());
  // Punch a non-finite gap through the first 400 ms after the real liftoff. A
  // detector that treats NaN as zero, or that interpolates across it, will
  // place the liftoff at the far side of the hole or not at all.
  const liftIndex = holed.findIndex(row => row[0] >= truth.liftoffUs);
  for (let at = liftIndex; at < liftIndex + Math.round(truth.sampleHz * 0.4); at += 1) {
    holed[at][2] = Number.NaN;
  }

  const window = detectFlightWindow({fields: session.fields, samples: holed, events: []});
  assert.equal(window.basis, FlightWindowBasis.DETECTED);
  assert.ok(
    window.startUs >= truth.liftoffUs + 0.35e6,
    'the liftoff must be found after the gap, not inside it'
  );
  assert.ok(window.startUs < truth.liftoffUs + 1.6e6);
});

// ---------------------------------------------------------------------------
// Corroboration must not become the boundary
// ---------------------------------------------------------------------------

test('the airborne event corroborates and never moves a boundary', () => {
  const random = makeRandom(53);
  const {session, truth} = synthesizeFlight(random, {liftoffS: 30, flightS: 40, totalS: 90});
  const withoutEvents = detectFlightWindow(session);

  // A firmware airborne latch placed 25 seconds before the real liftoff, plus
  // the ground chatter the reference log actually contains. If the rule read it
  // as a boundary the window would move; it must not.
  const chatterIndex = Math.round(truth.sampleHz * 5);
  const withEvents = detectFlightWindow({
    ...session,
    events: [
      {event: 'state', eventType: 52, state: 1, sampleIndex: chatterIndex, offset: 100},
      {event: 'state', eventType: 52, state: 0, sampleIndex: chatterIndex + 500, offset: 200},
      {event: 'state', eventType: 52, state: 1, sampleIndex: chatterIndex + 900, offset: 300}
    ]
  });

  assert.equal(withEvents.startUs, withoutEvents.startUs, 'the event moved the window');
  assert.equal(withEvents.endUs, withoutEvents.endUs);
  assert.equal(withEvents.corroboration.airborneEvent.state, 'latched');
  assert.equal(withEvents.corroboration.airborneEvent.transitions, 3);
  // The latch is placed at the sample it names, and the agreement is the signed
  // gap from the measured liftoff. Reporting a large disagreement is the point:
  // the pilot sees the firmware and the measurement differ instead of being
  // handed one of them as fact.
  const latchTimeUs = session.samples[chatterIndex + 900][0];
  assert.equal(withEvents.corroboration.airborneEvent.timeUs, latchTimeUs);
  assert.equal(
    withEvents.corroboration.airborneEventAgreementUs,
    latchTimeUs - withoutEvents.startUs
  );
  assert.ok(
    withEvents.corroboration.airborneEventAgreementUs < -10e6,
    `expected a large negative agreement, got ${withEvents.corroboration.airborneEventAgreementUs}`
  );
  assert.equal(withoutEvents.corroboration.airborneEvent.state, 'absent');
});

test('an event with no sample position is reported as unplaceable, not placed at zero', () => {
  const {session} = synthesizeFlight(makeRandom(59), {liftoffS: 20, flightS: 30, totalS: 70});
  const window = detectFlightWindow({
    ...session,
    // The pre-fix decoder shape: a byte offset and nothing else.
    events: [{event: 'state', eventType: 52, state: 1, offset: 4096}]
  });

  assert.equal(window.corroboration.airborneEvent.state, 'unplaceable');
  assert.equal(window.corroboration.airborneEvent.timeUs, null);
  assert.equal(window.corroboration.airborneEventAgreementUs, null);
});

// ---------------------------------------------------------------------------
// The caller-supplied window
// ---------------------------------------------------------------------------

test('a caller-supplied window is used verbatim and labelled as the caller\'s', () => {
  const {session, truth} = synthesizeFlight(makeRandom(67), {liftoffS: 20, flightS: 40, totalS: 80});
  const startUs = truth.startTimeUs + 10e6;
  const endUs = truth.startTimeUs + 50e6;

  const window = resolveFlightWindow(session, {override: {startUs, endUs}});
  assert.equal(window.basis, FlightWindowBasis.CALLER_SUPPLIED);
  assert.equal(window.startUs, startUs);
  assert.equal(window.endUs, endUs);
  assert.equal(window.takeoff.signal, 'caller');
  assert.equal(window.landing.signal, 'caller');
  assert.equal(window.overrideCheck.code, FlightWindowCheck.OK);
});

test('an unusable override falls back to detection and says which check rejected it', () => {
  const {session, truth} = synthesizeFlight(makeRandom(71), {liftoffS: 25, flightS: 40, totalS: 90});
  const detected = detectFlightWindow(session);

  const inverted = detectFlightWindow(session, {
    override: {startUs: truth.startTimeUs + 40e6, endUs: truth.startTimeUs + 10e6}
  });
  assert.equal(inverted.overrideCheck.code, FlightWindowCheck.INVERTED);
  assert.equal(inverted.basis, detected.basis);
  assert.equal(inverted.startUs, detected.startUs);

  const outside = detectFlightWindow(session, {
    override: {startUs: truth.startTimeUs - 1e9, endUs: truth.startTimeUs - 9e8}
  });
  assert.equal(outside.overrideCheck.code, FlightWindowCheck.OUTSIDE_LOG);
  assert.equal(outside.startUs, detected.startUs);
});

test('checkFlightWindow answers the questions a draggable marker asks', () => {
  const {session, truth} = synthesizeFlight(makeRandom(83), {liftoffS: 20, flightS: 30, totalS: 70});
  const logEndUs = session.samples[session.samples.length - 1][0];

  const ok = checkFlightWindow(session, {
    startUs: truth.startTimeUs + 5e6,
    endUs: truth.startTimeUs + 40e6
  });
  assert.equal(ok.valid, true);
  assert.equal(ok.code, FlightWindowCheck.OK);
  assert.equal(ok.clamped, false);
  assert.ok(ok.sampleCount > 1000);
  assert.equal(session.samples[ok.firstSampleIndex][0] >= ok.startUs, true);
  assert.equal(session.samples[ok.firstSampleIndex - 1][0] < ok.startUs, true);
  assert.equal(session.samples[ok.lastSampleIndex][0] <= ok.endUs, true);

  // Dragged off the end: repaired and reported as repaired, not rejected.
  const clamped = checkFlightWindow(session, {
    startUs: truth.startTimeUs - 30e6,
    endUs: logEndUs + 30e6
  });
  assert.equal(clamped.valid, true);
  assert.equal(clamped.code, FlightWindowCheck.CLAMPED);
  assert.equal(clamped.clamped, true);
  assert.equal(clamped.startUs, truth.startTimeUs);
  assert.equal(clamped.endUs, logEndUs);
  assert.equal(clamped.sampleCount, session.samples.length);

  // Pinched down to nothing: no analysis can run over it, and the check says so
  // rather than handing back a window with one sample in it.
  const pinched = checkFlightWindow(session, {
    startUs: truth.startTimeUs + 5e6,
    endUs: truth.startTimeUs + 5e6 + 1
  });
  assert.equal(pinched.valid, false);
  assert.equal(pinched.code, FlightWindowCheck.TOO_FEW_SAMPLES);

  for (const bad of [{}, {startUs: Number.NaN, endUs: 10}, {startUs: 0, endUs: Number.POSITIVE_INFINITY}]) {
    const rejected = checkFlightWindow(session, bad);
    assert.equal(rejected.valid, false, `${JSON.stringify(bad)} was accepted`);
    assert.equal(rejected.code, FlightWindowCheck.NOT_FINITE);
  }

  const inverted = checkFlightWindow(session, {startUs: 100, endUs: 100});
  assert.equal(inverted.code, FlightWindowCheck.INVERTED);
});

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

test('records and a session produce the same window', () => {
  const {session} = synthesizeFlight(makeRandom(97), {liftoffS: 22, flightS: 45, totalS: 95});
  const records = session.samples.map(row => ({
    timeUs: row[0],
    headspeed: row[1],
    collective: row[2]
  }));

  const fromSession = detectFlightWindow(session);
  const fromRecords = detectFlightWindow({records});
  const fromArray = detectFlightWindow(records);

  assert.equal(fromSession.basis, FlightWindowBasis.DETECTED);
  assert.equal(fromRecords.startUs, fromSession.startUs);
  assert.equal(fromRecords.endUs, fromSession.endUs);
  assert.equal(fromArray.startUs, fromSession.startUs);
  assert.equal(fromRecords.inputSource, 'records');
  assert.equal(fromSession.inputSource, 'session');
});

test('the field spellings match the ones records.mjs resolves', () => {
  // A log whose collective resolves in one module and not the other would make
  // the window disagree with the records measured inside it.
  const {session} = synthesizeFlight(makeRandom(101), {liftoffS: 20, flightS: 30, totalS: 70});

  for (const [key, candidates] of [['collective', FIELD_MAP.collective], ['headspeed', FIELD_MAP.headspeed]]) {
    for (const name of candidates) {
      const renamed = {
        fields: session.fields.map(field => (
          field.name === (key === 'collective' ? 'rcCommand[3]' : 'headspeed')
            ? {...field, name}
            : field
        )),
        samples: session.samples,
        events: []
      };
      assert.equal(
        detectFlightWindow(renamed).resolved[key], name,
        `flight-window does not resolve the ${key} spelling ${name} that records.mjs accepts`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Real logs
// ---------------------------------------------------------------------------

test('the reference flight is trimmed to its takeoff and reports no landing', {skip: realLogSkip}, async () => {
  const session = await decodeFile(REAL_LOG);
  const window = detectFlightWindow(session);
  const rel = us => (us - window.logStartUs) / 1e6;

  assert.equal(window.basis, FlightWindowBasis.ENDED_IN_FLIGHT);
  // Pinned to the microsecond: this is a specific sample in a specific log, and
  // a rule that quietly starts choosing its neighbour has changed.
  assert.equal(rel(window.startUs).toFixed(6), '22.762337');
  assert.equal(rel(window.endUs).toFixed(6), '133.521805');
  assert.equal(window.takeoff.signal, 'collective-above-ground-with-rotor-at-speed');
  assert.equal(window.resolved.collective, 'rcCommand[3]');

  // The recording is cut by power-off with the rotor still turning. There is no
  // landing in it and none may be reported.
  assert.equal(window.landing.timeUs, null);
  assert.equal(window.landing.basis, FlightWindowBasis.ENDED_IN_FLIGHT);

  // Self-calibrated on the log's own units, not on a constant.
  assert.equal(window.thresholds.groundCollective, -74);
  assert.equal(window.thresholds.groundSpread, 33);
  assert.equal(window.thresholds.liftLevel, 25);
  assert.equal(window.thresholds.groundSpreadWasFloored, false);

  // The firmware's own airborne latch agrees to 11 ms — and is not what the
  // rule used. Stripping every event must leave the window bit-identical.
  assert.equal(window.corroboration.airborneEvent.state, 'latched');
  assert.equal(window.corroboration.airborneEvent.transitions, 5);
  assert.equal(window.corroboration.airborneEventAgreementUs, 10_925);

  const blind = detectFlightWindow({...session, events: []});
  assert.equal(blind.startUs, window.startUs, 'the window depended on the events after all');
  assert.equal(blind.endUs, window.endUs);
});

test('on the reference flight the liftoff margin decides the answer', {skip: realLogSkip}, async () => {
  const session = await decodeFile(REAL_LOG);
  const rel = window => (window.startUs - window.logStartUs) / 1e6;

  // Every constant except this one is inert on this log; sweeping them all and
  // finding no movement would be indistinguishable from a detector that ignores
  // them. Widened to 12 the threshold rises above the flight's own median
  // collective and the answer jumps by twelve seconds.
  assert.ok(rel(detectFlightWindow(session, {constants: {liftMargin: 12}})) > 30);
  assert.ok(Math.abs(rel(detectFlightWindow(session, {constants: {liftMargin: 1}})) - 22.578) < 0.01);
  assert.ok(Math.abs(rel(detectFlightWindow(session, {constants: {liftMargin: 8}})) - 23.475) < 0.01);

  // Reverse the collective and the evidence for a takeoff is gone. A rule that
  // fell back to "trim to where the headspeed settles" would still answer.
  const collectiveIndex = session.fields.find(field => field.name === 'rcCommand[3]').index;
  const negated = session.samples.map(row => {
    const copy = row.slice();
    copy[collectiveIndex] = -copy[collectiveIndex];
    return copy;
  });
  const flipped = detectFlightWindow({...session, samples: negated});
  assert.equal(flipped.basis, FlightWindowBasis.NO_LIFTOFF);
  assert.equal(flipped.coverageRatio, 1);
});

test('the reference flight window built from records matches the one built from the session', {skip: realLogSkip}, async () => {
  const session = await decodeFile(REAL_LOG);
  const {records, usable} = buildAnalysisRecords(session, {axis: 'roll'});
  assert.equal(usable, true);

  const fromRecords = detectFlightWindow({records});
  const fromSession = detectFlightWindow(session);
  assert.equal(fromRecords.startUs, fromSession.startUs);
  assert.equal(fromRecords.endUs, fromSession.endUs);
  assert.equal(fromRecords.basis, fromSession.basis);
});

test('logs with no collective column keep the whole recording', {skip: siblingSkip}, async () => {
  for (const file of siblingPaths) {
    const session = await decodeFile(file);
    const window = detectFlightWindow(session);

    assert.equal(window.basis, FlightWindowBasis.NO_COLLECTIVE, path.basename(file));
    assert.equal(window.coverageRatio, 1, path.basename(file));
    assert.equal(window.trimmed, false, path.basename(file));
    assert.equal(window.resolved.collective, null, path.basename(file));
    assert.equal(window.resolved.headspeed, 'headspeed', path.basename(file));
    assert.equal(((window.endUs - window.startUs) / 1e6).toFixed(4), '14.9995', path.basename(file));
  }
});

test('the stop fixture is not trimmed, so no stop can be lost to the window', async () => {
  // The fixture opens with the head already at speed, which is the shape that
  // has no takeoff in it. Its type-52 interval covers 1 of its 12 stops, so a
  // rule that trusted the event here would cost eleven.
  const session = await decodeFile(FIXTURE);
  const window = detectFlightWindow(session);

  assert.equal(window.basis, FlightWindowBasis.NO_ROTOR_START);
  assert.equal(window.coverageRatio, 1);
  assert.equal(window.trimmed, false);
  assert.equal(window.startUs, session.samples[0][session.fields.find(f => f.name === 'time').index]);
  assert.equal(window.corroboration.airborneEvent.transitions, 2);
});

test('the exported constants are the ones the module actually uses', () => {
  // Freezing them is what lets a caller show the pilot what the rule was, and
  // what lets the sweeps above be honest about which knob they turned.
  assert.ok(Object.isFrozen(FLIGHT_WINDOW_CONSTANTS));
  assert.equal(FLIGHT_WINDOW_CONSTANTS.liftMargin, 3);
  assert.equal(FLIGHT_WINDOW_CONSTANTS.settleMargin, 1);

  const {session} = synthesizeFlight(makeRandom(103), {liftoffS: 20, flightS: 30, totalS: 70});
  const explicit = detectFlightWindow(session, {constants: {...FLIGHT_WINDOW_CONSTANTS}});
  const implicit = detectFlightWindow(session);
  assert.equal(explicit.startUs, implicit.startUs);
  assert.equal(explicit.endUs, implicit.endUs);
});
