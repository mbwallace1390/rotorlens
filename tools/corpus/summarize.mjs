/**
 * Turns a pile of corpus measurements into the four distributions this
 * repository currently guesses at, and renders them as text a human reads.
 *
 * Each section names the constant it bears on and says what would settle it, so
 * the output can be pasted beside that constant without a covering note. The
 * numbers are descriptive: a percentile of what a few unassessed helicopters
 * happen to do is not a limit, and this module never presents one as though it
 * were.
 */

import {AXES, auditCorpusMeasurement} from './measure.mjs';
import {EVIDENCE_LIMITS} from '../../src/analysis/pid-evidence.mjs';
import {STOP_DETECTION_DEFAULTS} from '../../src/analysis/records.mjs';

/**
 * The figures already quoted in `src/`, so a run can be read as a diff.
 *
 * Every one of these is cited where it lives. Restating them here rather than
 * importing is deliberate for the three that are not constants at all — they are
 * numbers written into comments, and the point of this tool is to find out
 * whether they survive contact with more aircraft.
 */
export const SHIPPED_FIGURES = Object.freeze({
  /** src/analysis/pid-evidence.mjs — enforced in flight-history.compareAxisHold. */
  minimumComparisonHolds: EVIDENCE_LIMITS.minimumComparisonHolds,
  /** The largest hold count ever observed, from the 33-flight corpus note. */
  observedMaximumHolds: 4,
  /** src/analysis/records.mjs — the stop-detection command threshold. */
  commandThresholdDps: STOP_DETECTION_DEFAULTS.commandThresholdDps,
  /** src/analysis/pid-evidence.mjs — pooled across all three axes. */
  pooledHoldErrorNoiseFloorDps: EVIDENCE_LIMITS.holdErrorNoiseFloorDps,
  /**
   * Per-axis identical-gain p90s quoted in flight-history.mjs, at n = 5, 4 and
   * 18. Comments, not constants: nothing in `src/` reads these.
   */
  perAxisNoiseFloorP90Dps: Object.freeze({roll: 0.915, pitch: 1.390, yaw: 0.0966}),
  /**
   * src/analysis/advisor/mechanical-spectrum.mjs, ATTENTION_BAND_RMS_THRESHOLD_DPS.
   *
   * NAMED HERE WITH A CAVEAT THAT MUST TRAVEL WITH IT. The shipped gate is a
   * NARROWBAND band RMS around a detected peak. What this tool measures is the
   * BROADBAND high-frequency gyro RMS from `summarizeAxis`. They are not the
   * same measurement and the broadband figure is the larger of the two by
   * construction, so a broadband distribution BRACKETS the threshold — it says
   * where the total lives — and does not calibrate it. Reading "60% of flights
   * exceed 8" off the broadband column as though it were the gate firing would
   * be wrong, and the report says so wherever the number appears.
   */
  attentionBandRmsThresholdDps: 8,
  /** src/analysis/pid-evidence.mjs — how close two headspeeds must be to pair. */
  maximumHeadspeedVariationRatio: EVIDENCE_LIMITS.maximumHeadspeedVariationRatio
});

/** Command thresholds the peak-command distribution is scored against. */
const COMMAND_LADDER_DPS = Object.freeze([20, 30, 40, 50, 60, 80, 100, 150]);

// ---------------------------------------------------------------------------
// Small statistics
// ---------------------------------------------------------------------------

function sortedFinite(values) {
  return values.filter(Number.isFinite).sort((left, right) => left - right);
}

/** Nearest-rank quantile over an already-sorted array. */
function quantileOf(sorted, fraction) {
  if (sorted.length === 0) {
    return null;
  }
  const rank = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[rank];
}

export function describeDistribution(values) {
  const sorted = sortedFinite(values);
  if (sorted.length === 0) {
    return {n: 0, min: null, p25: null, median: null, p75: null, p90: null, max: null};
  }
  return {
    n: sorted.length,
    min: sorted[0],
    p25: quantileOf(sorted, 0.25),
    median: quantileOf(sorted, 0.5),
    p75: quantileOf(sorted, 0.75),
    p90: quantileOf(sorted, 0.9),
    max: sorted[sorted.length - 1]
  };
}

// ---------------------------------------------------------------------------
// Null pairs
// ---------------------------------------------------------------------------

function sameGainsOnAxis(left, right, axis) {
  const a = left.gains?.[axis];
  const b = right.gains?.[axis];
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
}

function nothingChangedAnywhere(left, right) {
  return AXES.every(axis => sameGainsOnAxis(left, right, axis));
}

function headspeedsMatch(left, right, axis) {
  const a = left.axes?.[axis]?.headspeedMedianRpm;
  const b = right.axes?.[axis]?.headspeedMedianRpm;
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return false;
  }
  const larger = Math.max(Math.abs(a), Math.abs(b));
  if (larger === 0) {
    return false;
  }
  return Math.abs(b - a) / larger <= SHIPPED_FIGURES.maximumHeadspeedVariationRatio;
}

/**
 * Every pair of flights on one aircraft where NOTHING was changed.
 *
 * Same aircraft, same firmware, same rates, identical gains on all three axes,
 * both admissible, both with a measured hold error on this axis, the same hold
 * kind, and headspeeds within the shipped tolerance. Whatever the metric does
 * across such a pair is what it does when the answer is "no difference" — which
 * is the definition of the floor a real result has to clear.
 *
 * The conditions are the ones `compareFlightRecords` itself applies, and that
 * matters: a floor measured under looser conditions than the gate uses is a
 * floor the gate will never meet.
 */
export function findNullPairs(measurements, axis) {
  const usable = measurements.filter(entry =>
    entry.readable
    && entry.admissible
    && entry.aircraftGroup !== null
    && Number.isFinite(entry.axes?.[axis]?.meanAbsoluteSteadyStateErrorDps));

  const deltas = [];
  const levels = [];
  const pairs = [];

  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const left = usable[i];
      const right = usable[j];
      if (left.aircraftGroup !== right.aircraftGroup) {
        continue;
      }
      if (left.firmwareRevision !== right.firmwareRevision) {
        continue;
      }
      if (left.ratesFingerprint !== right.ratesFingerprint) {
        continue;
      }
      if (!nothingChangedAnywhere(left, right)) {
        continue;
      }
      const a = left.axes[axis];
      const b = right.axes[axis];
      // A heading hold and a constant-rate turn are different tests.
      if ((a.zeroHoldCount > 0) !== (b.zeroHoldCount > 0)) {
        continue;
      }
      if (!headspeedsMatch(left, right, axis)) {
        continue;
      }

      const delta = Math.abs(
        b.meanAbsoluteSteadyStateErrorDps - a.meanAbsoluteSteadyStateErrorDps
      );
      deltas.push(delta);
      levels.push(a.meanAbsoluteSteadyStateErrorDps, b.meanAbsoluteSteadyStateErrorDps);
      pairs.push({
        aircraftGroup: left.aircraftGroup,
        left: {sourceFile: left.sourceFile, sessionIndex: left.sessionIndex},
        right: {sourceFile: right.sourceFile, sessionIndex: right.sessionIndex},
        deltaDps: delta
      });
    }
  }

  return {
    axis,
    pairCount: deltas.length,
    delta: describeDistribution(deltas),
    level: describeDistribution(levels),
    pairs
  };
}

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

export function summarizeCorpus(measurements, fileFailures = []) {
  const readable = measurements.filter(entry => entry.readable);
  const flights = readable.filter(entry => entry.admissible);

  const failureTally = new Map();
  for (const entry of measurements) {
    if (entry.readable) {
      continue;
    }
    const code = entry.failureCode ?? 'UNKNOWN';
    failureTally.set(code, (failureTally.get(code) ?? 0) + 1);
  }
  for (const failure of fileFailures) {
    const code = failure.code ?? 'UNKNOWN';
    failureTally.set(code, (failureTally.get(code) ?? 0) + 1);
  }

  const admissionTally = new Map();
  for (const entry of readable) {
    if (entry.admissible) {
      continue;
    }
    for (const code of entry.admissionCodes ?? []) {
      admissionTally.set(code, (admissionTally.get(code) ?? 0) + 1);
    }
  }

  const airborneSeconds = flights.reduce(
    (total, entry) => total + (entry.durationSeconds ?? 0), 0
  );

  // --- 1. hold segments per flight-axis
  const holdHistogram = new Map();
  let flightAxes = 0;
  let flightAxesReachingGate = 0;
  let maximumHolds = 0;
  const holdsByAxis = {};
  for (const axis of AXES) {
    holdsByAxis[axis] = [];
  }
  for (const entry of flights) {
    for (const axis of AXES) {
      const count = entry.axes?.[axis]?.holdCount;
      if (!Number.isFinite(count)) {
        continue;
      }
      flightAxes += 1;
      holdsByAxis[axis].push(count);
      holdHistogram.set(count, (holdHistogram.get(count) ?? 0) + 1);
      maximumHolds = Math.max(maximumHolds, count);
      if (count >= SHIPPED_FIGURES.minimumComparisonHolds) {
        flightAxesReachingGate += 1;
      }
    }
  }

  // --- 2. peak commanded rate per axis
  const peakCommand = {};
  for (const axis of AXES) {
    const peaks = flights
      .map(entry => entry.axes?.[axis]?.peakCommandDps)
      .filter(Number.isFinite);
    peakCommand[axis] = {
      distribution: describeDistribution(peaks),
      reaching: COMMAND_LADDER_DPS.map(threshold => ({
        thresholdDps: threshold,
        flights: peaks.filter(value => value >= threshold).length
      }))
    };
  }

  // --- 3. broadband gyro RMS
  const gyroRms = {};
  for (const axis of AXES) {
    const filtered = flights
      .map(entry => entry.axes?.[axis]?.gyroHighFrequencyRmsDps)
      .filter(Number.isFinite);
    const unfiltered = flights
      .map(entry => entry.axes?.[axis]?.unfilteredHighFrequencyRmsDps)
      .filter(Number.isFinite);
    gyroRms[axis] = {
      filtered: describeDistribution(filtered),
      unfiltered: describeDistribution(unfiltered),
      unfilteredAvailable: unfiltered.length,
      filteredAtOrAboveThreshold:
        filtered.filter(value => value >= SHIPPED_FIGURES.attentionBandRmsThresholdDps).length,
      // Counted separately because the two answers are nothing alike. On the
      // reference dumps the filtered figure never once reaches 8 while the
      // unfiltered one passes it on a third of roll flights — so a report
      // quoting only the filtered column would say "nothing is near the
      // threshold" about a corpus where the pre-filter signal routinely is.
      unfilteredAtOrAboveThreshold:
        unfiltered.filter(value => value >= SHIPPED_FIGURES.attentionBandRmsThresholdDps).length
    };
  }

  // --- 4. identical-gain null pairs
  const nullPairs = {};
  for (const axis of AXES) {
    nullPairs[axis] = findNullPairs(flights, axis);
  }

  const aircraftGroups = new Set(
    readable.map(entry => entry.aircraftGroup).filter(group => group !== null)
  );
  const sourceFiles = new Set(measurements.map(entry => entry.sourceFile));
  for (const failure of fileFailures) {
    sourceFiles.add(failure.sourceFile);
  }

  return {
    counts: {
      files: sourceFiles.size,
      sessions: measurements.length,
      readable: readable.length,
      unreadable: measurements.length - readable.length,
      fileFailures: fileFailures.length,
      flights: flights.length,
      aircraft: aircraftGroups.size,
      airborneSeconds,
      // Decode health, reported because a donation that decodes badly is
      // evidence about this repository's parser rather than about a helicopter,
      // and those two findings must never be tallied into the same number.
      sessionsWithDecodeErrors: readable.filter(entry => entry.decodeErrorCount > 0).length,
      decodeErrors: readable.reduce((total, entry) => total + entry.decodeErrorCount, 0),
      sessionsEndedMidFrame: readable.filter(entry => !entry.reachedLogEnd).length
    },
    failureTally: [...failureTally.entries()].sort((a, b) => b[1] - a[1]),
    admissionTally: [...admissionTally.entries()].sort((a, b) => b[1] - a[1]),
    holds: {
      flightAxes,
      flightAxesReachingGate,
      maximumHolds,
      histogram: [...holdHistogram.entries()].sort((a, b) => a[0] - b[0]),
      byAxis: Object.fromEntries(
        AXES.map(axis => [axis, describeDistribution(holdsByAxis[axis])])
      )
    },
    peakCommand,
    gyroRms,
    nullPairs
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function number(value, places = 3) {
  return Number.isFinite(value) ? value.toFixed(places) : '—';
}

function distributionLine(distribution, places = 2) {
  if (distribution.n === 0) {
    return 'no measurements';
  }
  return `n=${distribution.n}  min ${number(distribution.min, places)}`
    + `  p25 ${number(distribution.p25, places)}`
    + `  median ${number(distribution.median, places)}`
    + `  p75 ${number(distribution.p75, places)}`
    + `  p90 ${number(distribution.p90, places)}`
    + `  max ${number(distribution.max, places)}`;
}

export function renderCorpusReport(summary, options = {}) {
  const lines = [];
  const say = text => lines.push(text);
  const {counts} = summary;

  say('');
  say('RotorLens corpus report');
  say('='.repeat(72));
  say('');
  say(`  files read                 ${counts.files}`);
  say(`  sessions found             ${counts.sessions}`);
  say(`  sessions measured          ${counts.readable}`);
  say(`  sessions unreadable        ${counts.unreadable}`
    + (counts.fileFailures > 0 ? ` (+${counts.fileFailures} file-level failures)` : ''));
  say(`  sessions that FLEW         ${counts.flights}`
    + (counts.readable > 0
      ? `  (${Math.round(counts.flights / counts.readable * 100)}% of measured)`
      : ''));
  say(`  distinct aircraft          ${counts.aircraft}`);
  say(`  airborne minutes analysed  ${(counts.airborneSeconds / 60).toFixed(1)}`);
  say(`  sessions ending mid-frame  ${counts.sessionsEndedMidFrame}`
    + '   (normal: a log cut by a power-off)');
  say(`  sessions with decode errors ${counts.sessionsWithDecodeErrors}`
    + `, ${counts.decodeErrors} error(s) in total`);
  say('');
  say('  A SESSION IS NOT A FLIGHT. Bench runs and spool-ups are the majority of');
  say('  any real dump; every distribution below is over the sessions that flew,');
  say('  measured inside each flight\'s own window.');

  if (summary.failureTally.length > 0) {
    say('');
    say('  Could not be measured:');
    for (const [code, count] of summary.failureTally) {
      say(`    ${code.padEnd(34)} ${count}`);
    }
  }
  if (summary.admissionTally.length > 0) {
    say('');
    say('  Measured but did not fly:');
    for (const [code, count] of summary.admissionTally) {
      say(`    ${code.padEnd(34)} ${count}`);
    }
  }

  // --- 1
  say('');
  say('-'.repeat(72));
  say('1. HOLD SEGMENTS PER FLIGHT-AXIS');
  say(`   bears on  EVIDENCE_LIMITS.minimumComparisonHolds = `
    + `${SHIPPED_FIGURES.minimumComparisonHolds}`);
  say('');
  const {holds} = summary;
  if (holds.flightAxes === 0) {
    say('   no flight-axis produced a hold measurement');
  } else {
    for (const [count, n] of holds.histogram) {
      const share = (n / holds.flightAxes * 100).toFixed(0);
      say(`     ${String(count).padStart(3)} holds : ${String(n).padStart(4)}`
        + `  ${share.padStart(3)}%  ${'#'.repeat(Math.min(40, Math.round(n / holds.flightAxes * 40)))}`);
    }
    say('');
    say(`   maximum ever seen on one flight-axis : ${holds.maximumHolds}`);
    say(`   the gate needs                       : ${SHIPPED_FIGURES.minimumComparisonHolds}`
      + ' per side');
    say(`   flight-axes reaching it              : ${holds.flightAxesReachingGate}`
      + ` of ${holds.flightAxes}`);
    say('');
    if (holds.flightAxesReachingGate === 0) {
      say('   NOT ONE. On this corpus the comparison cannot fire, so a before/after');
      say('   verdict is unreachable no matter what the pilot changes. Either the');
      say('   minimum comes down — with the loss of power stated where it is set —');
      say('   or flights have to be flown that produce more holds.');
    } else {
      say('   The gate CAN open on real data. The count above is how often, and it');
      say('   is the number to weigh against the power the minimum was chosen for.');
    }
  }

  // --- 2
  say('');
  say('-'.repeat(72));
  say('2. PEAK COMMANDED RATE PER AXIS');
  say(`   bears on  COMMAND_THRESHOLD_DPS = ${SHIPPED_FIGURES.commandThresholdDps} deg/s`);
  say('');
  for (const axis of AXES) {
    say(`   ${axis.padEnd(6)} ${distributionLine(summary.peakCommand[axis].distribution, 1)}`);
  }
  say('');
  say('   flights whose peak reaches a threshold:');
  say(`     ${'deg/s'.padEnd(8)}${AXES.map(a => a.padStart(8)).join('')}`);
  for (let index = 0; index < COMMAND_LADDER_DPS.length; index += 1) {
    const threshold = COMMAND_LADDER_DPS[index];
    const cells = AXES
      .map(axis => String(summary.peakCommand[axis].reaching[index].flights).padStart(8))
      .join('');
    const mark = threshold === SHIPPED_FIGURES.commandThresholdDps ? '  <- shipped' : '';
    say(`     ${String(threshold).padEnd(8)}${cells}${mark}`);
  }
  say('');
  say('   A threshold no flight reaches detects nothing; one every flight reaches');
  say('   measures trim and turbulence. This table is both sides of that trade at');
  say('   once. It does not name a value — a smooth curve has no elbow to pick.');

  // --- 3
  say('');
  say('-'.repeat(72));
  say('3. BROADBAND HIGH-FREQUENCY GYRO RMS');
  say(`   bears on  ATTENTION_BAND_RMS_THRESHOLD_DPS = `
    + `${SHIPPED_FIGURES.attentionBandRmsThresholdDps} deg/s`);
  say('');
  say('   THESE ARE NOT THE SAME MEASUREMENT. The shipped threshold is a');
  say('   NARROWBAND band RMS around one detected peak; this is the BROADBAND');
  say('   content above ~50 Hz, which is larger by construction. The column below');
  say('   brackets the threshold — it says where the total sits — and cannot');
  say('   calibrate it. Do not read the last line as the gate firing.');
  say('');
  for (const axis of AXES) {
    const entry = summary.gyroRms[axis];
    say(`   ${axis.padEnd(6)} filtered    ${distributionLine(entry.filtered, 2)}`);
    say(`   ${' '.repeat(6)} unfiltered  ${distributionLine(entry.unfiltered, 2)}`);
    say(`   ${' '.repeat(6)} at or above ${SHIPPED_FIGURES.attentionBandRmsThresholdDps}`
      + ` deg/s broadband:  filtered ${entry.filteredAtOrAboveThreshold}/${entry.filtered.n}`
      + `   unfiltered ${entry.unfilteredAtOrAboveThreshold}/${entry.unfiltered.n}`);
  }
  const unfilteredTotal = AXES.reduce(
    (total, axis) => total + summary.gyroRms[axis].unfilteredAvailable, 0
  );
  say('');
  if (unfilteredTotal === 0) {
    say('   NO DONATION IN THIS RUN CARRIES AN UNFILTERED GYRO. Without gyroRAW the');
    say('   filtered trace cannot separate what the airframe does from what the');
    say('   filter removed, so no donation here can judge an airframe. That is the');
    say('   single most important thing to ask a donor to turn on.');
  } else {
    say(`   Flight-axes carrying an unfiltered gyro: ${unfilteredTotal}. Only these`);
    say('   can separate airframe vibration from what the filter chain removed.');
  }

  // --- 4
  say('');
  say('-'.repeat(72));
  say('4. IDENTICAL-GAIN NULL PAIRS  (the per-axis noise floor)');
  say(`   bears on  EVIDENCE_LIMITS.holdErrorNoiseFloorDps = `
    + `${SHIPPED_FIGURES.pooledHoldErrorNoiseFloorDps} deg/s, pooled across axes`);
  say('');
  say('   A null pair is two flights on one aircraft with nothing changed: same');
  say('   firmware, same rates, identical gains on all three axes, same hold kind,');
  say('   headspeed within '
    + `${(SHIPPED_FIGURES.maximumHeadspeedVariationRatio * 100).toFixed(0)}%.`
    + ' Whatever the metric does across');
  say('   one of those is what it does when the true answer is "no change".');
  say('');
  for (const axis of AXES) {
    const entry = summary.nullPairs[axis];
    const previous = SHIPPED_FIGURES.perAxisNoiseFloorP90Dps[axis];
    say(`   ${axis.toUpperCase()}  ${entry.pairCount} pair(s)`);
    if (entry.pairCount === 0) {
      say('     nothing to measure: no two flights here matched on everything');
      continue;
    }
    say(`     |delta|  ${distributionLine(entry.delta, 4)}`);
    say(`     level    ${distributionLine(entry.level, 4)}`);
    say(`     p90 here ${number(entry.delta.p90, 4)}`
      + `   previously reported ${previous}`
      + `   pooled shipped floor ${SHIPPED_FIGURES.pooledHoldErrorNoiseFloorDps}`);
  }
  say('');
  say('   A floor is only as good as the number of pairs behind it. Read the pair');
  say('   count first: a p90 over three pairs is a sentence about three flights.');

  say('');
  say('='.repeat(72));
  say('');
  say('WHAT THIS RUN CANNOT SETTLE, said once so nothing above is read as more');
  say('than it is:');
  say('');
  say('  - No aircraft here has been assessed by anyone for blade track, balance,');
  say('    bearing wear or linkage bind. Every distribution says what is COMMON on');
  say('    the machines that were donated and nothing about what is CORRECT.');
  say('  - There is no labelled known-bad case. Every threshold separating good');
  say('    from bad has one side measured and the other side empty.');
  say('  - A percentile is not a limit. Promoting one to a limit would calibrate a');
  say('    fault detector to the faults it exists to find.');
  say('');

  if (options.footer) {
    say(options.footer);
    say('');
  }

  return lines.join('\n');
}

/**
 * Audits every measurement before it is written or printed.
 *
 * Called by the CLI on the way out rather than only in a test: the thing being
 * guarded against is a report that leaks a donor's craft name, and a guard that
 * runs only under `npm test` does not guard the artefact anyone actually sends.
 */
export function auditAll(measurements) {
  const violations = [];
  for (const measurement of measurements) {
    const audit = auditCorpusMeasurement(measurement);
    if (!audit.ok) {
      violations.push({
        sourceFile: measurement.sourceFile,
        sessionIndex: measurement.sessionIndex,
        violations: audit.violations
      });
    }
  }
  return {ok: violations.length === 0, violations};
}
