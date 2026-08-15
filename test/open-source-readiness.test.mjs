// SPDX-FileCopyrightText: 2026 Michael Wallace
// SPDX-License-Identifier: MPL-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  checkDco,
  DCO_ENFORCEMENT_BASE,
  hasDcoSignOff
} from '../tools/check-dco.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function read(relativePath) {
  return readFile(path.join(projectRoot, relativePath), 'utf8');
}

test('public project metadata preserves creator credit and the MPL boundary', async () => {
  const files = await Promise.all([
    read('AUTHORS.md'),
    read('NOTICE'),
    read('CITATION.cff'),
    read('TRADEMARKS.md'),
    read('GOVERNANCE.md'),
    read('CONTRIBUTING.md')
  ]);
  const [authors, notice, citation, trademarks, governance, contributing] = files;

  for (const [name, content] of [
    ['AUTHORS.md', authors],
    ['NOTICE', notice],
    ['TRADEMARKS.md', trademarks],
    ['GOVERNANCE.md', governance]
  ]) {
    assert.match(content, /Michael Wallace/, `${name} must preserve the original creator credit`);
  }

  assert.match(authors, /founded and originally created/i);
  for (const [name, content] of [
    ['AUTHORS.md', authors],
    ['NOTICE', notice]
  ]) {
    assert.match(content, /historical Git metadata/i, `${name} must describe the retained AI-tooling metadata`);
    assert.match(content, /Author[^]*Committer[^]*Co-Authored-By/i, `${name} must name the Git fields that exist in history`);
    assert.match(content, /not[^.]*legal or copyright author/i, `${name} must distinguish metadata from legal authorship`);
  }
  assert.match(notice, /official source repository/i);
  assert.match(citation, /^cff-version: 1\.2\.0$/m);
  assert.match(citation, /^\s+given-names: "Michael"$/m);
  assert.match(citation, /^\s+- family-names: "Wallace"$/m);
  assert.match(citation, /^license: "MPL-2\.0"$/m);
  assert.match(trademarks, /Based on RotorLens, originally created by Michael Wallace/);
  assert.match(trademarks, /distinct product name, application icon, package or bundle identifier/i);
  assert.match(governance, /lead maintainer/i);
  assert.match(contributing, /inbound equals outbound/i);
  assert.match(contributing, /Mozilla Public License 2\.0/);
  assert.match(contributing, /git commit --signoff/);
});

test('DCO policy has an executable fail-closed merge gate', async () => {
  const [contributing, pullRequest, ci, manifest, checker] = await Promise.all([
    read('CONTRIBUTING.md'),
    read('.github/pull_request_template.md'),
    read('.github/workflows/ci.yml'),
    read('package.json').then(JSON.parse),
    read('tools/check-dco.mjs')
  ]);

  assert.equal(DCO_ENFORCEMENT_BASE, 'a222ba1e556b61ac46b7f28bceeef4a00178fc3e');
  assert.equal(hasDcoSignOff('Subject\n\nSigned-off-by: Michael Wallace <m@example.test>\n'), true);
  assert.equal(hasDcoSignOff('Subject\n\nCo-authored-by: Someone <s@example.test>\n'), false);
  assert.match(contributing, new RegExp(DCO_ENFORCEMENT_BASE));
  assert.match(pullRequest, /Every non-merge contribution commit has a DCO `Signed-off-by` trailer/);
  assert.equal(manifest.scripts['check:dco'], 'node ./tools/check-dco.mjs');
  assert.match(ci, /fetch-depth: 0[\s\S]*?name: Verify DCO sign-offs[\s\S]*?npm run check:dco/);
  assert.match(checker, /process\.env\.ROTORLENS_DCO_HEAD/);
  assert.match(contributing, /fails closed and verifies every reachable non-merge commit/);
});

test('DCO checker preserves the private baseline and checks an unrelated clean root', async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'rotorlens-dco-'));
  const git = arguments_ => execFileSync(
    'git',
    ['-c', 'commit.gpgsign=false', ...arguments_],
    {
      cwd: repository,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }
  ).trim();

  try {
    git(['init', '--quiet']);
    git(['config', 'user.name', 'RotorLens Test']);
    git(['config', 'user.email', 'rotorlens@example.test']);
    git([
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'Private baseline',
      '-m',
      'Signed-off-by: RotorLens Test <rotorlens@example.test>'
    ]);
    const baseline = git(['rev-parse', 'HEAD']);
    git(['commit', '--quiet', '--allow-empty', '-m', 'Unsigned private child']);
    const unsignedPrivateChild = git(['rev-parse', 'HEAD']);

    assert.deepEqual(checkDco({base: baseline, repository}), {
      checked: 1,
      missing: [unsignedPrivateChild],
      scope: 'post-baseline'
    });

    git(['checkout', '--quiet', '--orphan', 'clean-public']);
    git(['commit', '--quiet', '--allow-empty', '-m', 'Unsigned public root']);
    const unsignedPublicRoot = git(['rev-parse', 'HEAD']);

    assert.deepEqual(checkDco({base: baseline, repository}), {
      checked: 1,
      missing: [unsignedPublicRoot],
      scope: 'full-history'
    });
    assert.throws(
      () => checkDco({base: baseline, head: '--all', repository}),
      /Command failed/u
    );
  } finally {
    await rm(repository, {recursive: true, force: true});
  }
});

test('third-party governance texts preserve their own attribution and license boundaries', async () => {
  const [notices, dco, conduct] = await Promise.all([
    read('THIRD_PARTY_NOTICES.md'),
    read('DCO'),
    read('CODE_OF_CONDUCT.md')
  ]);

  assert.match(dco, /Developer Certificate of Origin\s+Version 1\.1/);
  assert.match(dco, /Copyright \(C\) 2004, 2006 The Linux Foundation and its contributors/);
  assert.match(dco, /copy and distribute verbatim copies[\s\S]*changing it is not allowed/);
  assert.equal(
    createHash('sha256').update(dco).digest('hex'),
    'f7ac75b443f4ca16b503241344b41aeff9503b0c30bedc2b119551d83cb0fa90'
  );
  assert.match(notices, /Developer Certificate of Origin 1\.1[\s\S]*DCO-1\.1 copying terms/);
  assert.match(notices, /DCO[\s\S]*verbatim cop(?:y|ies)[\s\S]*not (?:permit|covered by).*MPL-2\.0/i);

  assert.match(conduct, /adapted from the[\s\S]*Contributor Covenant[\s\S]*version 2\.1/i);
  assert.match(conduct, /Creative Commons Attribution 4\.0[\s\S]*CC-BY-4\.0/i);
  assert.match(conduct, /not covered by RotorLens' root MPL-2\.0 license/i);
  assert.match(notices, /Contributor Covenant Code of Conduct 2\.1[\s\S]*CC-BY-4\.0/);
  assert.match(notices, /2014 Coraline Ada Ehmke and Contributor Covenant contributors/);
  assert.match(
    notices,
    /project-specific changes[\s\S]*not MPL-covered RotorLens\s+application source/
  );
});

test('machine-readable file licensing covers first-party source without swallowing GPL boundaries', async () => {
  const reuse = await read('REUSE.toml');
  assert.match(reuse, /^version = 1$/m);
  assert.match(reuse, /SPDX-FileCopyrightText = "2026 Michael Wallace and contributors to RotorLens"/);
  assert.match(reuse, /SPDX-License-Identifier = "MPL-2\.0"/);
  for (const firstPartyPath of ['src/**', 'ui/app.mjs', 'tools/**', 'test/**', 'android/app/**', 'ios/**']) {
    assert.ok(reuse.includes(`"${firstPartyPath}"`), `${firstPartyPath} lacks a file-level license mapping`);
  }
  assert.doesNotMatch(reuse, /integration\/rotorflight-(?:blackbox|firmware)\/\*\*/);
  assert.doesNotMatch(reuse, /android\/gradle\/wrapper\/\*\*/);
  assert.match(reuse, /path = "CODE_OF_CONDUCT\.md"[\s\S]*precedence = "override"[\s\S]*CC-BY-4\.0/);
});

test('public contribution paths refuse sensitive flight data and route vulnerabilities privately', async () => {
  const templateDir = path.join(projectRoot, '.github', 'ISSUE_TEMPLATE');
  const templateNames = (await readdir(templateDir)).filter(name => name.endsWith('.yml'));
  const templateText = (
    await Promise.all(templateNames.map(name => read(path.join('.github', 'ISSUE_TEMPLATE', name))))
  ).join('\n');
  const pullRequest = await read('.github/pull_request_template.md');
  const security = await read('SECURITY.md');
  const support = await read('SUPPORT.md');

  assert.match(templateText, /Do not attach, paste, or link raw flight logs/i);
  assert.match(templateText, /GPS|home coordinates/i);
  assert.match(templateText, /security\/advisories\/new/);
  assert.match(pullRequest, /did \*\*not\*\* include or link raw flight logs/i);
  assert.match(security, /Report a vulnerability privately/i);
  assert.match(security, /security\/advisories\/new/);
  assert.match(support, /Never post.*flight log/is);
});

test('maintainer guidance contains no committed private machine or LAN coordinates', async () => {
  const claudeFiles = ['CLAUDE.md'];
  const pending = [path.join(projectRoot, '.claude')];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.name.endsWith('.md')) claudeFiles.push(path.relative(projectRoot, absolute));
    }
  }

  const combined = (await Promise.all(claudeFiles.map(read))).join('\n');
  assert.doesNotMatch(combined, /[A-Za-z]:[\\/]Users[\\/]/i);
  assert.doesNotMatch(combined, /\b192\.168\.\d{1,3}\.\d{1,3}\b/);
  assert.doesNotMatch(combined, /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  assert.doesNotMatch(combined, /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/);
});

test('repository defaults protect private captures and signing material', async () => {
  const ignore = await read('.gitignore');
  const codeowners = await read('.github/CODEOWNERS');
  const ci = await read('.github/workflows/ci.yml');

  for (const pattern of [
    /\*\.jks/,
    /\*\.keystore/,
    /\*\.p12/,
    /\*\.p8/,
    /\*\.mobileprovision/,
    /\*\.\[bB\]\[bB\]\[lL\]/,
    /\/fixtures\/real\/\*\*/
  ]) {
    assert.match(ignore, pattern);
  }

  assert.match(codeowners, /^\* @mbwallace1390$/m);
  assert.match(codeowners, /^\/\.github\/ @mbwallace1390$/m);
  assert.match(codeowners, /^\/android\/ @mbwallace1390$/m);
  assert.match(codeowners, /^\/ios\/ @mbwallace1390$/m);
  assert.match(
    ci,
    /actions\/upload-artifact@[0-9a-f]+[^]*?if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/,
    'debug APKs must not be published from untrusted pull-request runs'
  );
});

test('the official launcher artwork has pinned first-party provenance', async () => {
  const [provenance, notice, artwork] = await Promise.all([
    read('docs/ICON_PROVENANCE.md'),
    read('NOTICE'),
    readFile(path.join(
      projectRoot,
      'android', 'app', 'src', 'main', 'res', 'drawable-nodpi',
      'ic_launcher_artwork.png'
    ))
  ]);
  const digest = createHash('sha256').update(artwork).digest('hex');
  assert.equal(digest, 'dad023f829b945a33dc90390c0390114d9dc9c160c2d21afe59f6d40d7fb5719');
  assert.match(provenance, /AI-assisted design workflow[\s\S]*Michael Wallace/i);
  assert.match(provenance, /not copied from[\s\S]*Rotorflight[\s\S]*Betaflight/i);
  assert.match(provenance, /MPL-2\.0[\s\S]*to the extent\s+copyright subsists/i);
  assert.match(provenance, /1024 × 1024[\s\S]*iPhone and iPad/i);
  assert.match(notice, /official application icon[\s\S]*Michael\s+Wallace/i);
});
