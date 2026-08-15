#!/usr/bin/env node

/**
 * Builds the offline, shadow-only community model from already-scrubbed
 * contribution records.
 *
 * Usage:
 *   npm run community:model -- <contributions.json> [--out model.json]
 *     [--allow-empty]
 *
 * The input is deliberately narrower than the corpus tool's input: one JSON
 * file containing one top-level array of community contribution objects. This
 * command does not read flight logs, use the network, sign or publish a model,
 * or apply a model to tuning advice. It is intentionally limited to a curated,
 * licensed manual corpus; client-formatted IDs are not an authentication layer.
 * The current production legal registries are empty and configuration schema 1
 * is explicitly incomplete, so only an empty smoke artifact can succeed until
 * both prerequisites are replaced by reviewed production versions.
 */

import {createReadStream} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';

import {auditCommunityContribution} from '../src/analysis/community-contract.mjs';
import {
  auditCommunityShadowModel,
  buildCommunityShadowModel
} from '../src/analysis/community-model.mjs';

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_CONTRIBUTIONS = 10_000;
const MAX_REPORTED_VIOLATIONS = 100;
const USAGE = 'Usage: npm run community:model -- <contributions.json> '
  + '[--out model.json] [--allow-empty]\n';

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** Parse exactly one input and at most one output without guessing at options. */
function parseArguments(argv) {
  let input = null;
  let output = null;
  let allowEmpty = false;
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (!positionalOnly && argument === '--') {
      positionalOnly = true;
      continue;
    }

    if (!positionalOnly && argument === '--out') {
      if (output !== null) {
        throw new CliError('output may be specified only once', 2);
      }
      if (index + 1 >= argv.length) {
        throw new CliError('the --out option requires a file', 2);
      }
      output = argv[index += 1];
      continue;
    }

    if (!positionalOnly && argument === '--allow-empty') {
      if (allowEmpty) {
        throw new CliError('the --allow-empty option may be specified only once', 2);
      }
      allowEmpty = true;
      continue;
    }

    if (!positionalOnly && argument.startsWith('-')) {
      // Do not echo arbitrary command-line values. They can themselves contain
      // a local path or other private text.
      throw new CliError('unknown option', 2);
    }

    if (input !== null) {
      throw new CliError('multiple input files are not allowed', 2);
    }
    input = argument;
  }

  if (input === null) {
    throw new CliError('one contribution file is required', 2);
  }
  if (output !== null && sameFileName(input, output)) {
    throw new CliError('input and output must be different files', 2);
  }

  return {input, output, allowEmpty};
}

/** Windows paths compare case-insensitively; other supported hosts do not. */
function sameFileName(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/**
 * Read a bounded stream so a changed or misleading file size cannot make the
 * process allocate an unbounded buffer.
 */
async function readBoundedInput(file) {
  const chunks = [];
  let bytes = 0;

  try {
    for await (const chunk of createReadStream(file, {highWaterMark: 64 * 1024})) {
      bytes += chunk.length;
      if (bytes > MAX_INPUT_BYTES) {
        throw new CliError('input exceeds the 64 MiB limit');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    // Node's filesystem error message includes the source path. Only its
    // machine-readable code is safe and useful here.
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? ` (${error.code})`
      : '';
    throw new CliError(`input could not be read${code}`, 1);
  }

  return Buffer.concat(chunks, bytes).toString('utf8');
}

/** Audit every item, even after an earlier item failed, before building. */
function auditContributions(contributions) {
  const violations = [];
  let invalid = false;

  function record(index, path, reason) {
    invalid = true;
    // A 64 MiB array can contain millions of tiny invalid objects. Keep
    // auditing every object, but bound the diagnostics retained in memory.
    if (violations.length < MAX_REPORTED_VIOLATIONS) {
      violations.push({index, path, reason});
    }
  }

  for (let index = 0; index < contributions.length; index += 1) {
    let audit = null;
    try {
      audit = auditCommunityContribution(contributions[index]);
    } catch {
      record(index, '$', 'validation could not be completed');
      continue;
    }

    if (audit?.ok === true) {
      continue;
    }

    if (!Array.isArray(audit?.violations) || audit.violations.length === 0) {
      record(index, '$', 'failed validation');
      continue;
    }

    for (const violation of audit.violations) {
      record(
        index,
        safeAuditPath(violation?.path),
        safeAuditReason(violation?.reason)
      );
    }
  }

  return {ok: !invalid, violations};
}

/** Keep a diagnostic path useful without allowing it to carry a source path. */
function safeAuditPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240) {
    return '$';
  }
  return /^[A-Za-z0-9_$.[\]-]+$/.test(value) ? value : '$';
}

/** Audit reasons are static contract text; suppress anything path-like/control-like. */
function safeAuditReason(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) {
    return 'failed validation';
  }
  if (/[\r\n\\/]/.test(value)) {
    return 'failed validation';
  }
  return value;
}

function reportContributionViolations(violations) {
  process.stderr.write('community model refused: invalid contribution records\n');
  for (const violation of violations.slice(0, MAX_REPORTED_VIOLATIONS)) {
    process.stderr.write(
      `contribution[${violation.index}] ${violation.path}: ${violation.reason}\n`
    );
  }
}

function reportModelViolations(audit) {
  process.stderr.write('community model refused: generated model failed its audit\n');
  const violations = Array.isArray(audit?.violations) ? audit.violations : [];
  if (violations.length === 0) {
    process.stderr.write('model $: failed validation\n');
    return;
  }
  for (const violation of violations.slice(0, MAX_REPORTED_VIOLATIONS)) {
    process.stderr.write(
      `model ${safeAuditPath(violation?.path)}: ${safeAuditReason(violation?.reason)}\n`
    );
  }
}

async function main() {
  let input;
  let output;
  let allowEmpty;
  try {
    ({input, output, allowEmpty} = parseArguments(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}`);
    process.exitCode = error.exitCode ?? 2;
    return;
  }

  let contributions;
  try {
    const source = await readBoundedInput(input);
    try {
      contributions = JSON.parse(source);
    } catch {
      throw new CliError('input is not valid JSON');
    }
  } catch (error) {
    process.stderr.write(`${error instanceof CliError ? error.message : 'input could not be read'}\n`);
    process.exitCode = error.exitCode ?? 1;
    return;
  }

  if (!Array.isArray(contributions)) {
    process.stderr.write('input must be a top-level JSON array\n');
    process.exitCode = 1;
    return;
  }
  if (contributions.length > MAX_CONTRIBUTIONS) {
    process.stderr.write(`input exceeds the ${MAX_CONTRIBUTIONS} contribution limit\n`);
    process.exitCode = 1;
    return;
  }

  const contributionAudit = auditContributions(contributions);
  if (!contributionAudit.ok) {
    reportContributionViolations(contributionAudit.violations);
    process.exitCode = 1;
    return;
  }

  let model;
  try {
    model = buildCommunityShadowModel(contributions);
  } catch {
    process.stderr.write('community model could not be built\n');
    process.exitCode = 1;
    return;
  }

  let modelAudit = null;
  try {
    modelAudit = auditCommunityShadowModel(model);
  } catch {
    // Treat an auditor failure exactly like a failed audit. Nothing is emitted.
  }
  if (modelAudit?.ok !== true) {
    reportModelViolations(modelAudit);
    process.exitCode = 1;
    return;
  }

  // A successful command must normally prove that the corpus produced at
  // least one privacy-qualified cohort. Empty artifacts are useful only for
  // deterministic smoke tests, so they require an explicit opt-in.
  if (!allowEmpty && model.summary?.publishedCohortCount === 0) {
    process.stderr.write(
      'community model refused: corpus produced no privacy-qualified cohort evidence; '
      + 'use --allow-empty only for smoke tests\n'
    );
    process.exitCode = 1;
    return;
  }

  const serialized = `${JSON.stringify(model, null, 2)}\n`;
  if (output === null) {
    process.stdout.write(serialized);
    return;
  }

  try {
    // Models are build artefacts, but a caller can mistype this path as the
    // source corpus (or name a symlink to it). Create only; never clobber.
    await writeFile(output, serialized, {encoding: 'utf8', flag: 'wx'});
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? ` (${error.code})`
      : '';
    process.stderr.write(`model output could not be written${code}\n`);
    process.exitCode = 1;
  }
}

await main();
