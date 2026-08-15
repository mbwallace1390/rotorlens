import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  COMMUNITY_CONFIG_SUPPLEMENT_MANIFESTS,
  COMMUNITY_CONFIG_SUPPLEMENT_SNAPSHOT_KIND,
  inspectCommunityConfigSupplement
} from '../src/analysis/community-config-supplement.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENCODER = new TextEncoder();

// Audited against the official source at each pinned commit. These constants
// are deliberately independent of the exported manifests: a field, domain,
// source path, or digest change requires a fresh source review.
const AUDITED_RELEASE_GOLDENS = Object.freeze({
  '4.3.0': Object.freeze({
    fieldCount: 61,
    manifestSha256:
      '5a74d1162326474b6f0abff76f5e2ad2a45116968277f5c8842b873a1b6b519e',
    snapshotDigest: 'sha256:gHquw_oQBmpvqVY4YhIG8LN5-GWPAkhN_t6FHUnReuw'
  }),
  '4.4.0': Object.freeze({
    fieldCount: 62,
    manifestSha256:
      'aca5ea186bfe6cc864ce043d1e0cd6a5c90746c1ece599340ac5a58629c84748',
    snapshotDigest: 'sha256:WO3gFvmwAdHi6W_qbUTsdBfcFeCciDNxby54FXz7Hco'
  }),
  '4.4.1': Object.freeze({
    fieldCount: 62,
    manifestSha256:
      'eb26f8dadd30b2daa5acc62f8c2d1208889e9916766fe95189dffbbf9782705f',
    snapshotDigest: 'sha256:RJaiGuI6b17ffQsZ7-BputX3bcG5YNZzvPteHjNJyC0'
  }),
  '4.5.0': Object.freeze({
    fieldCount: 73,
    manifestSha256:
      'b95179b44e72c838f3dfbc07743365b6b11aee95c48582ead963daf88a7f896b',
    snapshotDigest: 'sha256:P0prSGSgO-QVIrsbKee-E6KFd3jKgoFVomhQ3EHuPKg'
  }),
  '4.5.1': Object.freeze({
    fieldCount: 73,
    manifestSha256:
      '42f9e89f1ac8c82336b19e718fdb62a52c04568af8230d66fd2499e8757fc36d',
    snapshotDigest: 'sha256:cUL6cbv6kN2NEq9Gfj1Pl1eFsKPT79SZcQQFNfL5MlE'
  }),
  '4.6.0': Object.freeze({
    fieldCount: 82,
    manifestSha256:
      '882d14f5e55310584020c2f627f47272f01af69f1d358268069e4730e6eda7ef',
    snapshotDigest: 'sha256:5fWSOFEnptP-6wEBETYW4CIkHAYkBdOshXLzESsNQ00'
  })
});

function auditedManifestDigest(manifest) {
  const fields = manifest.fields.map(specification => [
    specification.scope,
    specification.key,
    specification.type,
    specification.minimum,
    specification.maximum,
    specification.length,
    specification.values
  ]);
  const canonical = JSON.stringify({
    id: manifest.id,
    version: manifest.version,
    commit: manifest.commit,
    shortCommit: manifest.shortCommit,
    target: manifest.target,
    sourcePaths: manifest.sourcePaths,
    fields
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function valueFor(specification) {
  if (specification.type === 'string') return specification.values[0];
  if (specification.type === 'vector') {
    return Array.from({length: specification.length}, () => specification.minimum);
  }
  return specification.minimum;
}

function rowsFor(version) {
  return COMMUNITY_CONFIG_SUPPLEMENT_MANIFESTS[version].fields.map(
    specification => [
      specification.scope,
      specification.key,
      valueFor(specification)
    ]
  );
}

function envelope(version = '4.6.0', acquisition = 'cli', rows = rowsFor(version)) {
  return {
    schemaVersion: 1,
    kind: COMMUNITY_CONFIG_SUPPLEMENT_SNAPSHOT_KIND,
    acquisition,
    rows
  };
}

function bytes(value) {
  return ENCODER.encode(JSON.stringify(value));
}

function inspect(value) {
  return inspectCommunityConfigSupplement(bytes(value));
}

function replaceRow(rows, scope, key, replacement) {
  return rows.map(row => row[0] === scope && row[1] === key
    ? [row[0], row[1], replacement]
    : [...row]);
}

function code(report, expected) {
  assert.equal(report.codes.includes(expected), true, JSON.stringify(report));
}

test('all six pinned release snapshots remain valid but permanently closed', () => {
  const expected = {
    '4.3.0': '05570fe',
    '4.4.0': '5fc142a',
    '4.4.1': '456633b',
    '4.5.0': 'e77d192',
    '4.5.1': 'e69823a',
    '4.6.0': '118e912'
  };
  for (const [version, shortCommit] of Object.entries(expected)) {
    const manifest = COMMUNITY_CONFIG_SUPPLEMENT_MANIFESTS[version];
    const golden = AUDITED_RELEASE_GOLDENS[version];
    assert.equal(manifest.shortCommit, shortCommit);
    assert.equal(manifest.fields.length, golden.fieldCount);
    assert.equal(auditedManifestDigest(manifest), golden.manifestSha256);
    const report = inspect(envelope(version));
    assert.equal(report.snapshotValid, true, `${version}: ${report.codes}`);
    assert.equal(report.supplement.digest, golden.snapshotDigest);
    assert.equal(report.requiredRowCount, manifest.fields.length);
    assert.equal(report.acceptedRowCount, manifest.fields.length);
    assert.equal(report.binding, 'unproven');
    assert.equal(report.complete, false);
    assert.equal(report.cohortEligible, false);
    assert.equal(report.adviceEligible, false);
    assert.deepEqual(report.codes, [
      'SNAPSHOT_FLIGHT_BINDING_UNPROVEN',
      'CONFIGURATION_TRANSITIVE_CONTEXT_MISSING',
      'COMMUNITY_CONFIGURATION_CLOSED'
    ]);
  }
});

test('release manifests keep incompatible rate and governor layouts separate', () => {
  const keys = version => new Set(
    COMMUNITY_CONFIG_SUPPLEMENT_MANIFESTS[version].fields.map(
      specification => `${specification.scope}:${specification.key}`
    )
  );
  const rf43 = keys('4.3.0');
  const rf45 = keys('4.5.1');
  const rf46 = keys('4.6.0');
  assert.equal(rf43.has('rates:quickrates_rc_expo'), true);
  assert.equal(rf43.has('rates:setpoint_boost_gain'), false);
  assert.equal(rf43.has('governor-profile:gov_min_throttle'), false);
  assert.equal(rf45.has('rates:quickrates_rc_expo'), true);
  assert.equal(rf45.has('rates:setpoint_boost_gain'), true);
  assert.equal(rf45.has('governor-profile:gov_p_limit'), true);
  assert.equal(rf46.has('rates:quickrates_rc_expo'), false);
  assert.equal(rf46.has('rates:cyclic_polar'), true);
  assert.equal(rf46.has('governor-master:gov_throttle_type'), true);
  assert.equal(rf46.has('mixer:sc_rate'), true);
  assert.equal(
    COMMUNITY_CONFIG_SUPPLEMENT_MANIFESTS['4.3.0'].sourcePaths
      .includes('src/main/pg/governor.c'),
    false
  );
  for (const version of ['4.4.0', '4.4.1', '4.5.0', '4.5.1', '4.6.0']) {
    const sources = COMMUNITY_CONFIG_SUPPLEMENT_MANIFESTS[version].sourcePaths;
    assert.equal(sources.includes('src/main/pg/governor.c'), true);
    assert.equal(sources.includes('src/main/pg/rates.c'), true);
  }
});

test('row order does not alter the semantic digest', () => {
  const rows = rowsFor('4.6.0');
  const cli = inspect(envelope('4.6.0', 'cli', rows));
  const reversed = inspect(envelope('4.6.0', 'cli', [...rows].reverse()));
  assert.equal(cli.snapshotValid, true);
  assert.equal(reversed.snapshotValid, true);
  assert.equal(cli.supplement.digest, reversed.supplement.digest);
});

test('one setting change changes the digest without exposing the setting', () => {
  const rows = rowsFor('4.6.0');
  const changed = replaceRow(rows, 'rates', 'collective_response', 1);
  const before = inspect(envelope('4.6.0', 'cli', rows));
  const after = inspect(envelope('4.6.0', 'cli', changed));
  assert.notEqual(before.supplement.digest, after.supplement.digest);
  const serialized = JSON.stringify(after);
  assert.equal(serialized.includes('collective_response'), false);
  assert.equal(serialized.includes('NEXUS'), false);
});

test('reports are deeply frozen and contain no raw configuration rows', () => {
  const report = inspect(envelope());
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.coverage), true);
  assert.equal(Object.isFrozen(report.supplement), true);
  assert.equal(Object.isFrozen(report.codes), true);
  assert.throws(() => report.codes.push('MUTATE'), TypeError);
  const serialized = JSON.stringify(report);
  for (const forbidden of ['FRSK VANTAC_RF007', 'gov_mode', 'sc_rate']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('hostile byte and JSON boundaries fail closed', () => {
  assert.throws(() => inspectCommunityConfigSupplement('not bytes'), TypeError);
  code(inspectCommunityConfigSupplement(new Proxy(new Uint8Array(), {})),
    'SNAPSHOT_UTF8_INVALID');
  class LyingBytes extends Uint8Array {
    get byteLength() { return 0; }
  }
  code(inspectCommunityConfigSupplement(new LyingBytes(256 * 1024 + 1)),
    'SNAPSHOT_TOO_LARGE');
  code(inspectCommunityConfigSupplement(new Uint8Array(256 * 1024 + 1)),
    'SNAPSHOT_TOO_LARGE');
  code(inspectCommunityConfigSupplement(Uint8Array.of(0xc3, 0x28)),
    'SNAPSHOT_UTF8_INVALID');
  const canonical = bytes(envelope());
  const bomPrefixed = new Uint8Array(canonical.length + 3);
  bomPrefixed.set([0xef, 0xbb, 0xbf]);
  bomPrefixed.set(canonical, 3);
  code(inspectCommunityConfigSupplement(bomPrefixed),
    'SNAPSHOT_ENCODING_NONCANONICAL');
  code(inspectCommunityConfigSupplement(ENCODER.encode('{')),
    'SNAPSHOT_JSON_INVALID');
  code(inspectCommunityConfigSupplement(ENCODER.encode(
    JSON.stringify(envelope(), null, 2)
  )), 'SNAPSHOT_ENCODING_NONCANONICAL');
  const scientific = JSON.stringify(envelope()).replace(
    '["rates","collective_response",0]',
    '["rates","collective_response",1e0]'
  );
  code(inspectCommunityConfigSupplement(ENCODER.encode(scientific)),
    'SNAPSHOT_ENCODING_NONCANONICAL');
});

test('root schema, acquisition, and row limits are exact', () => {
  code(inspect({...envelope(), extra: true}), 'SNAPSHOT_SCHEMA_INVALID');
  code(inspect({...envelope(), kind: 'other'}), 'SNAPSHOT_SCHEMA_INVALID');
  code(inspect({...envelope(), acquisition: 'raw-dump'}),
    'SNAPSHOT_SCHEMA_INVALID');
  code(inspect({...envelope(), acquisition: 'msp'}),
    'SNAPSHOT_SCHEMA_INVALID');
  code(inspect({...envelope(), rows: Array.from(
    {length: 257}, (_, index) => ['meta', `x${index}`, 0]
  )}), 'SNAPSHOT_ROW_LIMIT_EXCEEDED');
});

test('malformed, duplicate, missing, unknown, and wrong-scope rows fail closed', () => {
  const rows = rowsFor('4.6.0');
  code(inspect(envelope('4.6.0', 'cli', [...rows, [1, 'bad', 0]])),
    'SNAPSHOT_ROW_INVALID');
  code(inspect(envelope('4.6.0', 'cli', [...rows, [...rows[0]]])),
    'SNAPSHOT_ROW_DUPLICATE');
  code(inspect(envelope('4.6.0', 'cli', rows.slice(1))),
    'SNAPSHOT_FIRMWARE_UNREVIEWED');
  code(inspect(envelope('4.6.0', 'cli', rows.filter(
    row => !(row[0] === 'rates' && row[1] === 'collective_response')
  ))), 'SNAPSHOT_ROW_MISSING');
  code(inspect(envelope('4.6.0', 'cli', [
    ...rows,
    ['meta', 'pilot_name', 'Alice Example']
  ])), 'SNAPSHOT_ROW_UNKNOWN');
  const wrongScope = rows.map(row => row[0] === 'mixer' && row[1] === 'sc_rate'
    ? ['rates', row[1], row[2]]
    : [...row]);
  const wrongScopeReport = inspect(envelope('4.6.0', 'cli', wrongScope));
  code(wrongScopeReport, 'SNAPSHOT_ROW_UNKNOWN');
  code(wrongScopeReport, 'SNAPSHOT_ROW_MISSING');
  assert.equal(JSON.stringify(wrongScopeReport).includes('sc_rate'), false);
});

test('unreviewed firmware identity fails without echoing supplied text', () => {
  let rows = rowsFor('4.6.0');
  rows = replaceRow(rows, 'meta', 'firmware_version', '4.6.9-private');
  const version = inspect(envelope('4.6.0', 'cli', rows));
  code(version, 'SNAPSHOT_FIRMWARE_UNREVIEWED');
  assert.equal(JSON.stringify(version).includes('4.6.9-private'), false);

  rows = rowsFor('4.6.0');
  code(inspect(envelope('4.6.0', 'cli', replaceRow(
    rows, 'meta', 'firmware_commit', 'fffffff'
  ))), 'SNAPSHOT_FIRMWARE_UNREVIEWED');
  code(inspect(envelope('4.6.0', 'cli', replaceRow(
    rows, 'meta', 'firmware_target', 'STM32H743'
  ))), 'SNAPSHOT_FIRMWARE_UNREVIEWED');
});

test('prototype-named firmware versions fail closed without throwing', () => {
  for (const version of ['__proto__', 'constructor', 'toString']) {
    let report;
    assert.doesNotThrow(() => {
      report = inspect(envelope(version, 'cli', [
        ['meta', 'firmware_version', version]
      ]));
    });
    code(report, 'SNAPSHOT_FIRMWARE_UNREVIEWED');
    assert.equal(JSON.stringify(report).includes(version), false);
  }
});

test('scalar and vector domains are enforced', () => {
  const rows = rowsFor('4.6.0');
  code(inspect(envelope('4.6.0', 'cli', replaceRow(
    rows, 'rates', 'collective_expo', 101
  ))), 'SNAPSHOT_SETTING_INVALID');
  code(inspect(envelope('4.6.0', 'cli', replaceRow(
    rows, 'rates', 'setpoint_boost_gain', [0, 0, 0]
  ))), 'SNAPSHOT_SETTING_INVALID');
  code(inspect(envelope('4.6.0', 'cli', replaceRow(
    rows, 'governor-master', 'gov_bypass_throttle',
    [0, 0, 0, 0, 0, 0, 0, 0, 256]
  ))), 'SNAPSHOT_SETTING_INVALID');
});

test('rate, mixer, and RF4.6 governor cross-fields are enforced', () => {
  let rows = rowsFor('4.6.0');
  rows = replaceRow(rows, 'rates', 'rates_type', 6);
  rows = replaceRow(rows, 'rates', 'roll_rc_rate', 201);
  code(inspect(envelope('4.6.0', 'cli', rows)),
    'SNAPSHOT_CROSS_FIELD_INVALID');

  rows = rowsFor('4.6.0');
  rows = replaceRow(rows, 'mixer', 'sc_min', 1);
  rows = replaceRow(rows, 'mixer', 'sc_max', 0);
  code(inspect(envelope('4.6.0', 'cli', rows)),
    'SNAPSHOT_CROSS_FIELD_INVALID');

  rows = rowsFor('4.6.0');
  rows = replaceRow(rows, 'governor-master', 'gov_mode', 1);
  rows = replaceRow(rows, 'governor-profile', 'gov_use_pid_spoolup', 1);
  code(inspect(envelope('4.6.0', 'cli', rows)),
    'SNAPSHOT_CROSS_FIELD_INVALID');

  rows = rowsFor('4.6.0');
  rows = replaceRow(rows, 'governor-master', 'gov_idle_throttle', 2);
  rows = replaceRow(rows, 'governor-master', 'gov_auto_throttle', 1);
  code(inspect(envelope('4.6.0', 'cli', rows)),
    'SNAPSHOT_CROSS_FIELD_INVALID');
});

test('RF4.6 mode OFF preserves legal profile values not post-validated at init', () => {
  let rows = rowsFor('4.6.0');
  rows = replaceRow(rows, 'governor-profile', 'gov_use_pid_spoolup', 1);
  rows = replaceRow(rows, 'governor-profile', 'gov_max_throttle', 10);
  rows = replaceRow(rows, 'governor-profile', 'gov_min_throttle', 100);
  const report = inspect(envelope('4.6.0', 'cli', rows));
  assert.equal(report.snapshotValid, true, report.codes.join(','));
});

function sourceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const full = path.join(directory, entry.name);
    const generatedAndroidBuild = path.resolve(full) === path.resolve(
      ROOT, 'android', 'app', 'build'
    );
    if (entry.isDirectory() && !generatedAndroidBuild) {
      found.push(...sourceFiles(full));
    }
    else if (/\.(?:mjs|cjs|mts|cts|js|jsx|ts|tsx|html?|vue|svelte|java|kt|kts|gradle|sh|ps1|bat|cmd)$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

test('supplement remains unreachable from production and has no transport', () => {
  const modulePath = path.join(
    ROOT, 'src', 'analysis', 'community-config-supplement.mjs'
  );
  const offlinePairingPath = path.join(
    ROOT, 'src', 'analysis', 'community-config-pairing.mjs'
  );
  const moduleText = readFileSync(modulePath, 'utf8');
  assert.equal(
    readFileSync(offlinePairingPath, 'utf8')
      .includes("from './community-config-supplement.mjs'"),
    true,
    'only the offline pairing boundary may consume the supplement inspector'
  );
  for (const forbidden of [
    /\bfetch\s*\(/,
    /https?:\/\//,
    /node:net/,
    /WebSocket/,
    /MSP_SET/
  ]) assert.doesNotMatch(moduleText, forbidden);

  const candidates = [
    ...sourceFiles(path.join(ROOT, 'src')),
    ...sourceFiles(path.join(ROOT, 'ui')),
    ...sourceFiles(path.join(ROOT, 'android')),
    ...sourceFiles(path.join(ROOT, 'tools')),
    ...sourceFiles(path.join(ROOT, 'bin')),
    path.join(ROOT, 'package.json')
  ].filter(candidate => ![modulePath, offlinePairingPath]
    .some(allowed => path.resolve(candidate) === path.resolve(allowed)));
  for (const candidate of candidates) {
    assert.equal(
      readFileSync(candidate, 'utf8').includes('community-config-supplement'),
      false,
      `unexpected production reference: ${candidate}`
    );
  }
});
