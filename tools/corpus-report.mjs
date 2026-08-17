#!/usr/bin/env node

/**
 * Measures a directory of donated flight logs and reports the numbers this
 * repository currently guesses at.
 *
 * Usage:
 *   npm run corpus:report -- <file-or-directory> [more…] [options]
 *
 * Options:
 *   --json <path>   also write the per-session measurements as JSON
 *   --limit <n>     stop after n sessions (for a quick look at a large dump)
 *   --quiet         no per-session progress
 *
 * ROBUSTNESS IS A REQUIREMENT HERE, not a nicety. Donations arrive truncated,
 * from firmware this decoder has never seen, and occasionally are not logs at
 * all. Every failure is reported and stepped over; the run always finishes and
 * always says how much of what it was given it could actually read. A batch tool
 * that dies on file 7 of 60 silently reports a corpus a third the size.
 *
 * NO NETWORK. This reads local files and writes local files. Nothing here
 * uploads, and the app it belongs to requests no INTERNET permission.
 */

import {readFile, writeFile, readdir, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCorpusScan} from './corpus/measure.mjs';
import {summarizeCorpus, renderCorpusReport, auditAll} from './corpus/summarize.mjs';

const LOG_EXTENSIONS = new Set(['.bbl', '.bfl', '.txt', '.log']);

function parseArguments(argv) {
  const targets = [];
  const options = {json: null, limit: Infinity, quiet: false};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = argv[index += 1] ?? null;
    } else if (argument === '--limit') {
      // `|| Infinity` turned `--limit 0` into "unlimited"; a non-negative
      // integer is honoured as given and anything unparsable means no limit.
      const parsed = Number.parseInt(argv[index += 1] ?? '', 10);
      options.limit = Number.isInteger(parsed) && parsed >= 0 ? parsed : Infinity;
    } else if (argument === '--quiet') {
      options.quiet = true;
    } else if (argument.startsWith('--')) {
      process.stderr.write(`unknown option ${argument}\n`);
      process.exit(2);
    } else {
      targets.push(argument);
    }
  }

  return {targets, options};
}

/**
 * Why a file could not be opened, said without naming where it lives.
 *
 * Deliberately drops `error.message`: on Node an fs error carries the full path
 * inside its message, and NEVER_REPORTED forbids a path or a directory name in
 * anything this tool emits. The code and the syscall are what an owner needs to
 * act — the filename is reported separately and is enough to identify the file.
 */
function unreadableDetail(error) {
  const code = typeof error?.code === 'string' ? error.code : null;
  const syscall = typeof error?.syscall === 'string' ? error.syscall : null;
  if (code && syscall) {
    return `${code} on ${syscall}`;
  }
  return code ?? 'could not be opened';
}

/** Every log-looking file under a target, one level of recursion at a time. */
async function collectFiles(target) {
  let info = null;
  try {
    info = await stat(target);
  } catch (error) {
    return {files: [], errors: [{target, detail: String(error?.message ?? error)}]};
  }

  if (info.isFile()) {
    return {files: [target], errors: []};
  }
  if (!info.isDirectory()) {
    return {files: [], errors: [{target, detail: 'not a file or a directory'}]};
  }

  const files = [];
  const errors = [];
  const entries = await readdir(target, {withFileTypes: true});
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFiles(full);
      files.push(...nested.files);
      errors.push(...nested.errors);
    } else if (LOG_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(full);
    }
  }
  return {files, errors};
}

async function main() {
  const {targets, options} = parseArguments(process.argv.slice(2));

  if (targets.length === 0) {
    process.stderr.write(
      'Usage: npm run corpus:report -- <file-or-directory> [--json out.json] '
      + '[--limit n] [--quiet]\n'
    );
    process.exit(2);
  }

  const files = [];
  const collectionErrors = [];
  for (const target of targets) {
    const found = await collectFiles(target);
    files.push(...found.files);
    collectionErrors.push(...found.errors);
  }

  for (const error of collectionErrors) {
    process.stderr.write(`  cannot read ${error.target}: ${error.detail}\n`);
  }

  if (files.length === 0) {
    process.stderr.write('no log-looking files found\n');
    process.exit(2);
  }

  const scan = createCorpusScan();
  let sessionsSeen = 0;

  for (const file of files) {
    if (sessionsSeen >= options.limit) {
      break;
    }

    const label = path.basename(file);
    let bytes = null;
    try {
      const buffer = await readFile(file);
      // A view, not a copy: the two reference dumps are 85 and 128 MB.
      bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch (error) {
      // A file that cannot be opened is reported and stepped over, exactly like
      // a file that cannot be decoded. The run finishes either way.
      //
      // THE SYSCALL, NOT THE MESSAGE. A Node fs error stringifies as
      // "EPERM: operation not permitted, open 'C:\...\from-jane-smith\x.bbl'" —
      // the ABSOLUTE PATH, which NEVER_REPORTED forbids by name because folders
      // get named after people, and this object is written into the --json
      // artefact that gets sent to someone. `label` is already the bare
      // filename; the code says as much about what went wrong.
      scan.fileFailures.push({
        sourceFile: label,
        code: 'FILE_UNREADABLE',
        detail: unreadableDetail(error)
      });
      process.stderr.write(`  FILE_UNREADABLE ${label}: ${unreadableDetail(error)}\n`);
      continue;
    }

    const started = Date.now();
    scan.addLog(bytes, label, measurement => {
      sessionsSeen += 1;
      if (options.quiet) {
        return;
      }
      const state = measurement.readable
        ? (measurement.admissible ? 'flew' : 'ground')
        : `FAILED ${measurement.failureCode}`;
      process.stderr.write(
        `    ${label} #${measurement.sessionIndex}  ${state}  `
        + `${measurement.sampleCount} samples  `
        + `${measurement.durationSeconds ?? '—'}s\n`
      );
    });

    if (!options.quiet) {
      process.stderr.write(
        `  ${label}: ${((Date.now() - started) / 1000).toFixed(1)}s, `
        + `${(bytes.length / 1e6).toFixed(1)} MB\n`
      );
    }
  }

  const measurements = scan.measurements;

  // The audit runs before anything is written or printed, not only in a test.
  // The artefact this guards is the one that gets sent to somebody.
  const audit = auditAll(measurements);
  if (!audit.ok) {
    process.stderr.write('\n  REPORT REFUSED — it carries a field it must not.\n');
    for (const entry of audit.violations.slice(0, 20)) {
      for (const violation of entry.violations) {
        process.stderr.write(
          `    ${entry.sourceFile} #${entry.sessionIndex} ${violation.path}: `
          + `${violation.reason}\n`
        );
      }
    }
    process.exit(1);
  }

  const summary = summarizeCorpus(measurements, scan.fileFailures);
  process.stdout.write(renderCorpusReport(summary));

  if (options.json) {
    await writeFile(options.json, JSON.stringify({
      kind: 'rotorlens-corpus-report',
      schemaVersion: 1,
      summary,
      measurements,
      fileFailures: scan.fileFailures
    }, null, 1));
    process.stderr.write(`  wrote ${options.json}\n`);
  }
}

// Same entry guard as every other CLI in tools/: an unconditional `await
// main()` exits the importing process with code 2 the moment a test or tool
// imports this file for a helper. Resolved-path comparison, not string
// comparison — see the note in serve-ui.mjs.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
