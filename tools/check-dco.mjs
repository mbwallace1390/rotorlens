// SPDX-FileCopyrightText: 2026 Michael Wallace
// SPDX-License-Identifier: MPL-2.0

import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const DCO_ENFORCEMENT_BASE = 'a222ba1e556b61ac46b7f28bceeef4a00178fc3e';

export function hasDcoSignOff(message) {
  return /^Signed-off-by:\s+\S(?:.*\S)?\s+<[^<>\s]+>\s*$/imu.test(String(message));
}

function git(arguments_, repository) {
  return execFileSync('git', arguments_, {
    cwd: repository ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

export function checkDco({
  base = DCO_ENFORCEMENT_BASE,
  head = 'HEAD',
  repository
} = {}) {
  const resolvedHead = git(
    ['rev-parse', '--verify', '--end-of-options', `${head}^{commit}`],
    repository
  );
  let resolvedBase;
  let scope;
  try {
    resolvedBase = git(
      ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`],
      repository
    );
    git(['merge-base', '--is-ancestor', resolvedBase, resolvedHead], repository);
    scope = 'post-baseline';
  } catch {
    // A clean public history does not contain the private-development baseline.
    // Fail closed by checking its complete reachable non-merge history instead.
    scope = 'full-history';
  }

  const revision = scope === 'post-baseline'
    ? `${resolvedBase}..${resolvedHead}`
    : resolvedHead;
  const output = git(['rev-list', '--reverse', '--no-merges', revision], repository);
  const commits = output ? output.split(/\r?\n/u) : [];
  const missing = commits.filter(commit => !hasDcoSignOff(
    git(['show', '--no-patch', '--format=%B', commit], repository)
  ));
  return {checked: commits.length, missing, scope};
}

function main() {
  const head = process.env.ROTORLENS_DCO_HEAD || 'HEAD';
  const result = checkDco({head});
  if (result.missing.length > 0) {
    console.error('DCO sign-off missing from these commits:');
    for (const commit of result.missing) console.error(`- ${commit}`);
    console.error('Amend each commit with: git commit --amend --signoff');
    process.exitCode = 1;
    return;
  }
  const scope = result.scope === 'post-baseline'
    ? 'post-baseline'
    : 'full-history';
  console.log(`DCO sign-off verified for ${result.checked} ${scope} commit(s) through ${head}.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) main();
