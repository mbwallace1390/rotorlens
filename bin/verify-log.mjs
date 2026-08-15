#!/usr/bin/env node

/**
 * Conformance self-check for a real flight log.
 *
 * Round-trip tests prove our decoder agrees with our encoder. They cannot prove
 * it agrees with a flight controller. This tool closes that gap without a
 * reference implementation, by checking properties that only hold if the bytes
 * were genuinely understood:
 *
 *   - the frame stream is consumed end to end, with no resync and no errors;
 *   - time and loop iteration advance monotonically across every frame;
 *   - the sample interval is stable, matching a fixed-rate logger;
 *   - decoded values land inside the physical range their sensor can report;
 *   - **no field jumps at I-frame boundaries** — see below.
 *
 * The first four are all *alignment* checks, and alignment is not enough. Three
 * decoder defects shipped past every one of them, because a bit layout can be
 * wrong in a way that consumes exactly the right number of bytes: the stream
 * stays in sync, no error is raised, and the values are quietly a sawtooth. That
 * is what the continuity check is for. A P frame carries a delta and an I frame
 * an absolute, so a corrupted delta accumulates across the keyframe period and
 * snaps back at every I frame — a signature nothing else here can see, and one
 * that no round-trip test can ever produce because our writer would share the
 * mistake.
 *
 * Usage: npm run verify:log -- /path/to/LOG00001.BFL
 */

import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {decodeLog} from '../src/blackbox/decode.mjs';
import {measureIntraFrameContinuity} from '../src/blackbox/continuity.mjs';
import {sessionEndOffset, splitSessionErrors} from '../src/blackbox/log-integrity.mjs';

const target = process.argv[2];
if (!target) {
  process.stderr.write('Usage: npm run verify:log -- /path/to/log.BFL\n');
  process.exit(2);
}

const bytes = new Uint8Array(await readFile(path.resolve(process.cwd(), target)));

// Deliberately eager. The app decodes one session on demand because a pilot
// looks at one; conformance has to read every session in the file, and a check
// that quietly skipped 72 of 73 would be worse than no check.
const result = decodeLog(bytes);

const checks = [];
const notes = [];

function check(name, passed, detail) {
  checks.push({name, passed, detail});
}

/** Where this session's data ends: the next session's start, or end of file. */
function sessionEndOf(index) {
  return sessionEndOffset(result, index, bytes.length);
}

if (result.sessions.length === 0) {
  check('log contains a Blackbox session', false, 'no session header found');
}

for (const session of result.sessions) {
  const label = `session ${session.index}`;
  const fieldIndex = name => session.fields.findIndex(field => field.name === name);
  const timeIndex = fieldIndex('time');
  const iterationIndex = fieldIndex('loopIteration');
  const samples = session.samples;

  check(`${label}: firmware identified`, Boolean(session.firmware.type),
    `${session.firmware.revision ?? 'unknown'}`);

  check(`${label}: frames decoded`, samples.length > 0, `${samples.length} samples`);

  const sessionEnd = sessionEndOf(session.index);
  const {body: bodyErrors, tail} = splitSessionErrors(session, sessionEnd);
  const tailErrors = tail.length;

  check(`${label}: no decode errors`, bodyErrors.length === 0,
    bodyErrors.length === 0
      ? (tailErrors === 0 ? 'clean' : 'clean through the body of the log')
      : `${bodyErrors.length} errors, first: ${bodyErrors[0].code} @ ${bodyErrors[0].offset}`);

  const resyncBytes = session.frameCounts?.resyncBytes ?? 0;
  check(`${label}: never lost sync`, bodyErrors.length === 0,
    bodyErrors.length === 0 && resyncBytes > 0
      ? `${resyncBytes} bytes skipped, all in the final frame`
      : `${resyncBytes} bytes skipped`);

  if (session.reachedLogEnd) {
    check(`${label}: stream consumed to the end`, true, 'log-end event found');
  } else if (bodyErrors.length === 0) {
    // Decoded everything up to a stump too short to be a frame.
    check(`${label}: stream consumed to the end`, true,
      'log ends mid-frame with no log-end marker');
    notes.push(
      `${label}: the capture stops part-way through a frame — normal for a log ` +
      'cut by power-off or a full card, and not a decoding problem.'
    );
  } else {
    check(`${label}: stream consumed to the end`, false,
      'decoding stopped early with data remaining');
  }

  if (timeIndex >= 0 && samples.length > 1) {
    let backwards = 0;
    const deltas = [];
    for (let index = 1; index < samples.length; index += 1) {
      const delta = samples[index][timeIndex] - samples[index - 1][timeIndex];
      if (delta < 0) {
        backwards += 1;
      }
      deltas.push(delta);
    }
    check(`${label}: time is monotonic`, backwards === 0, `${backwards} backwards steps`);

    const sorted = [...deltas].sort((left, right) => left - right);
    const median = sorted[sorted.length >> 1];
    const outliers = deltas.filter(delta => median > 0 && Math.abs(delta - median) > median * 4).length;
    const ratio = outliers / deltas.length;
    check(`${label}: sample interval is stable`, ratio < 0.01,
      `median ${median}µs, ${outliers} outliers (${(ratio * 100).toFixed(2)}%)`);

    if (median > 0) {
      check(`${label}: plausible logging rate`, median >= 100 && median <= 20_000,
        `${Math.round(1_000_000 / median)} Hz`);
    }
  }

  if (iterationIndex >= 0 && samples.length > 1) {
    let backwards = 0;
    for (let index = 1; index < samples.length; index += 1) {
      if (samples[index][iterationIndex] < samples[index - 1][iterationIndex]) {
        backwards += 1;
      }
    }
    check(`${label}: loop iteration is monotonic`, backwards === 0, `${backwards} backwards steps`);
  }

  // Physical plausibility: a gyro cannot report beyond its full-scale range, and
  // a decoder reading the wrong bits produces values far outside it.
  const rangeChecks = [
    {pattern: /^gyroADC\[/, limit: 32_768, label: 'gyro'},
    {pattern: /^motor\[/, limit: 4096, label: 'motor'},
    {pattern: /^rcCommand\[/, limit: 4096, label: 'rcCommand'}
  ];

  for (const {pattern, limit, label: what} of rangeChecks) {
    const indices = session.fields
      .filter(field => pattern.test(field.name))
      .map(field => field.index);
    if (indices.length === 0 || samples.length === 0) {
      continue;
    }

    let worst = 0;
    for (const sample of samples) {
      for (const index of indices) {
        worst = Math.max(worst, Math.abs(sample[index]));
      }
    }
    check(`${label}: ${what} values within sensor range`, worst <= limit,
      `peak magnitude ${worst} (limit ${limit})`);
  }

  // The check that sees a permuted bit layout. Everything above proves the
  // stream stayed aligned; this one proves the values in it are continuous.
  const continuity = measureIntraFrameContinuity({
    samples,
    intraSampleIndices: session.intraSampleIndices,
    fields: session.fields
  });

  if (!continuity.measured) {
    notes.push(
      `${label}: continuity across I-frame boundaries not measured — ` +
      `${continuity.reason}. A log needs both keyframes and delta frames for it.`
    );
  } else {
    const {flagged} = continuity;
    const worstClean = continuity.fields
      .filter(entry => !entry.belowMovementFloor)
      .reduce((worst, entry) => (entry.ratio > worst.ratio ? entry : worst),
        {name: 'none', ratio: 0});

    check(`${label}: values are continuous across I-frame boundaries`, flagged.length === 0,
      flagged.length === 0
        ? `worst ${worstClean.name} ${worstClean.ratio.toFixed(2)}x ` +
          `(threshold ${continuity.ratioThreshold}x, ${continuity.intraTransitions} keyframes)`
        : flagged.slice(0, 6)
          .map(entry =>
            `${entry.name} ${entry.ratio === Infinity ? 'inf' : `${entry.ratio.toFixed(1)}x`} ` +
            `(${entry.intraMean.toFixed(2)} per keyframe vs ${entry.interMean.toFixed(2)} elsewhere)`)
          .join(', '));

    if (flagged.length > 0) {
      notes.push(
        `${label}: a field that jumps only at keyframes is drifting between them, ` +
        'which means its residual is being decoded against the wrong bits — check ' +
        "that field's encoding and predictor in docs/BLACKBOX_FORMAT_NOTES.md. " +
        'This is a measurement of where the discontinuity is, not a diagnosis of ' +
        'which bit is wrong.'
      );
    }
  }
}

const failed = checks.filter(entry => !entry.passed);

process.stdout.write(`\nRotorLens decoder conformance — ${path.basename(target)}\n\n`);
for (const entry of checks) {
  process.stdout.write(`  ${entry.passed ? 'pass' : 'FAIL'}  ${entry.name}\n`);
  if (entry.detail) {
    process.stdout.write(`        ${entry.detail}\n`);
  }
}

for (const note of notes) {
  process.stdout.write(`\n  note  ${note}\n`);
}

process.stdout.write(
  failed.length === 0
    ? `\n${checks.length}/${checks.length} checks passed. ` +
      'The decoder read this log consistently end to end.\n' +
      'Keep this log as a regression fixture if you own it.\n\n'
    : `\n${failed.length} of ${checks.length} checks FAILED. ` +
      'The decoder does not fully understand this log.\n' +
      'Failures here point at a bit-layout assumption in ' +
      'docs/BLACKBOX_FORMAT_NOTES.md that needs correcting.\n\n'
);

process.exit(failed.length === 0 ? 0 : 1);
