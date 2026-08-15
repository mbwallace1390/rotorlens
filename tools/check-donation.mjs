#!/usr/bin/env node

/**
 * Refuses to let a donated log be published unless it can be PROVED to carry no
 * recorded position, and to arrive with the permission `docs/FIXTURE_POLICY.md`
 * requires.
 *
 * Usage:
 *   npm run check:donation -- <file-or-directory> [more…]
 *
 * Each log is expected to have a sidecar named `<file>.donation.json` carrying
 * the fields in `DONATION_METADATA_FIELDS`. Run with `--template` to print an
 * empty one.
 *
 * Exit status is the point: 0 when every file may be published, 1 when any may
 * not. That makes it usable as the last step before a fixture is added, which is
 * the only moment at which anybody would think to check.
 */

import {readFile, readdir, stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {sha256Hex} from '../src/integrity.mjs';
import {
  checkDonation, renderDonationCheck, DONATION_METADATA_FIELDS
} from './corpus/donation-check.mjs';

const LOG_EXTENSIONS = new Set(['.bbl', '.bfl', '.txt', '.log']);

function printTemplate() {
  const template = {};
  for (const field of Object.keys(DONATION_METADATA_FIELDS)) {
    template[field] = '';
  }
  template.byteLength = 0;
  template.identifyingFieldsPresent = 'none';
  template.redaction = 'none';
  process.stdout.write(`${JSON.stringify(template, null, 2)}\n`);
  process.stdout.write('\nEvery field, and why it is required:\n\n');
  for (const [field, reason] of Object.entries(DONATION_METADATA_FIELDS)) {
    process.stdout.write(`  ${field}\n    ${reason}\n\n`);
  }
}

export async function collectFiles(target) {
  // Missing and unreadable targets must reject. `--allow-empty` is only a
  // statement about an existing directory containing no logs; treating a
  // misspelled or inaccessible path as empty would turn the CI gate off.
  const info = await stat(target);
  if (info.isFile()) {
    return [target];
  }
  if (!info.isDirectory()) {
    return [];
  }

  const files = [];
  for (const entry of await readdir(target, {withFileTypes: true})) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(full));
    } else if (LOG_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
        && !entry.name.endsWith('.donation.json')) {
      files.push(full);
    }
  }
  return files;
}

export async function readMetadata(logPath) {
  try {
    const text = await readFile(`${logPath}.donation.json`, 'utf8');
    return {metadata: JSON.parse(text), error: null};
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {metadata: null, error: null};
    }
    return {metadata: null, error: String(error?.message ?? error)};
  }
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const allowEmpty = arguments_.includes('--allow-empty');
  const targets = arguments_.filter(argument => argument !== '--allow-empty');

  if (targets.includes('--template')) {
    printTemplate();
    return;
  }

  if (targets.length === 0) {
    process.stderr.write(
      'Usage: npm run check:donation -- <file-or-directory> [--template]\n'
    );
    process.exit(2);
  }

  const files = [];
  for (const target of targets) {
    try {
      files.push(...await collectFiles(target));
    } catch (error) {
      process.stderr.write(
        `cannot inspect donation target ${target}: ${error?.message ?? error}\n`
      );
      process.exitCode = 2;
      return;
    }
  }

  if (files.length === 0) {
    if (allowEmpty) {
      process.stdout.write('0 log-looking files found; publication gate passed\n');
      return;
    }
    process.stderr.write('no log-looking files found\n');
    process.exit(2);
  }

  process.stdout.write('\nRotorLens donation check\n');
  process.stdout.write('='.repeat(72));
  process.stdout.write('\n');

  let refused = 0;

  for (const file of files) {
    const label = path.basename(file);
    let bytes = null;
    try {
      const buffer = await readFile(file);
      bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch (error) {
      // Unreadable is refused, not skipped. A file this tool cannot open is a
      // file it cannot clear.
      refused += 1;
      process.stdout.write(`\n  REFUSED  ${label}\n`);
      process.stdout.write(`    REFUSE FILE_UNREADABLE\n           ${error?.message ?? error}\n`);
      continue;
    }

    const {metadata, error: metadataError} = await readMetadata(file);
    const result = checkDonation({
      bytes,
      sourceFile: label,
      metadata,
      sha256: sha256Hex(bytes)
    });

    if (metadataError !== null) {
      result.findings.unshift({
        severity: 'refuse',
        code: 'METADATA_UNREADABLE',
        detail: metadataError
      });
      result.publishable = false;
    }

    if (!result.publishable) {
      refused += 1;
    }
    process.stdout.write(`${renderDonationCheck(result)}\n`);
  }

  process.stdout.write(`\n${'='.repeat(72)}\n`);
  if (refused === 0) {
    process.stdout.write(
      `\n  ${files.length} file(s) checked, all may be published.\n`
      + '  This says the bytes carry no recorded position and the permission is on\n'
      + '  file. It does not say the donor understood what they agreed to — that is\n'
      + '  what the wording in docs/SHARED_CORPUS_DESIGN.md is for.\n\n'
    );
  } else {
    process.stdout.write(
      `\n  ${refused} of ${files.length} file(s) MAY NOT BE PUBLISHED.\n`
      + '  A refusal is not a bug in the file. It is the check doing its job, and\n'
      + '  the fix is either a redaction that is documented or a donation that is\n'
      + '  used locally and never committed.\n\n'
    );
  }

  process.exit(refused === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
