import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';

import {
  COMMUNITY_BLACKBOX_CONFIG_MANIFESTS
} from '../src/analysis/community-config-extractor.mjs';
import {
  COMMUNITY_CONFIG_PAIRING_INSPECTOR_VERSION,
  COMMUNITY_CONFIG_PAIRING_REPORT_KIND,
  COMMUNITY_CONFIG_PAIRING_SCHEMA_VERSION,
  inspectCommunityConfigPairing
} from '../src/analysis/community-config-pairing.mjs';
import {
  COMMUNITY_CONFIG_SUPPLEMENT_MANIFESTS,
  COMMUNITY_CONFIG_SUPPLEMENT_SNAPSHOT_KIND
} from '../src/analysis/community-config-supplement.mjs';
import {parseSession} from '../src/blackbox/headers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENCODER = new TextEncoder();
const RELEASES = Object.freeze({
  '4.3.0': 'Rotorflight 4.3.0 (05570fe) STM32F7X2',
  '4.4.0': 'Rotorflight 4.4.0 (5fc142a) STM32F7X2',
  '4.4.1': 'Rotorflight 4.4.1 (456633b) STM32F7X2',
  '4.5.0': 'Rotorflight 4.5.0 (e77d192) STM32F7X2',
  '4.5.1': 'Rotorflight 4.5.1 (e69823a) STM32F7X2',
  '4.6.0': 'Rotorflight 4.6.0 (118e912) STM32F7X2'
});

function blackboxValueFor(specification) {
  const values = specification.domains.map(component =>
    component.values?.[0] ?? component.minimum);
  if (specification.key === 'collectiveRange') return '-1000,1000';
  if (specification.key === 'minthrottle') return '500';
  if (specification.key === 'maxthrottle') return '1000';
  if (specification.key === 'I interval') return '64';
  if (specification.key === 'P interval') return '2';
  if (specification.key === 'P ratio') return '32';
  if (specification.key === 'looptime') return '125';
  if (specification.key === 'pid_process_denom') return '4';
  if (specification.key === 'filter_process_denom') return '1';
  if (specification.key === 'motor_pwm_protocol') return '7';
  if (specification.key.startsWith('gyro_rpm_notch_center_')) {
    return Array(specification.arity).fill('0').join(',');
  }
  return values.join(',');
}

function supplementValueFor(specification) {
  if (specification.type === 'string') return specification.values[0];
  if (specification.key === 'sc_min') return -1000;
  if (specification.key === 'sc_max') return 1000;
  if (specification.type === 'vector') {
    return Array.from({length: specification.length}, () => specification.minimum);
  }
  return specification.minimum;
}

function snapshotRows(version = '4.6.0') {
  return COMMUNITY_CONFIG_SUPPLEMENT_MANIFESTS[version].fields.map(
    specification => [
      specification.scope,
      specification.key,
      supplementValueFor(specification)
    ]
  );
}

function rowValue(rows, scope, key) {
  return rows.find(row => row[0] === scope && row[1] === key)?.[2];
}

function snapshotBytes(version = '4.6.0', rows = snapshotRows(version)) {
  return ENCODER.encode(JSON.stringify({
    schemaVersion: 1,
    kind: COMMUNITY_CONFIG_SUPPLEMENT_SNAPSHOT_KIND,
    acquisition: 'cli',
    rows
  }));
}

function headerEntries(version = '4.6.0') {
  const revision = RELEASES[version];
  const minor = version.slice(0, 3);
  const rows = snapshotRows(version);
  const axisValues = (suffix) => ['roll', 'pitch', 'yaw']
    .map(axis => rowValue(rows, 'rates', `${axis}_${suffix}`)).join(',');
  const governorPid = [
    'gov_p_gain',
    'gov_i_gain',
    'gov_d_gain',
    'gov_f_gain',
    'gov_gain'
  ].map(key => rowValue(rows, 'governor-profile', key)).join(',');
  const yawTta = ['gov_tta_gain', 'gov_tta_limit']
    .map(key => rowValue(rows, 'governor-profile', key)).join(',');
  return [
    {key: 'Product', value: 'Blackbox flight data recorder by Nicholas Sherlock'},
    {key: 'Data version', value: '2'},
    {key: 'Firmware type', value: 'Rotorflight'},
    {key: 'Firmware revision', value: revision},
    {key: 'Board information', value: rowValue(rows, 'meta', 'board')},
    {key: 'gyro_scale', value: '0x3f800000'},
    {key: 'rates_type', value: String(rowValue(rows, 'rates', 'rates_type'))},
    {key: 'rc_rates', value: axisValues('rc_rate')},
    {key: 'rc_expo', value: axisValues('expo')},
    {key: 'rates', value: axisValues('srate')},
    ...(version === '4.3.0' ? [] : [
      {key: 'govPID', value: governorPid},
      {key: 'yaw_tta', value: yawTta}
    ]),
    {key: 'Craft name', value: 'PRIVATE HELICOPTER NAME'},
    {key: 'Log start datetime', value: '2026-08-14T12:34:56.000'},
    {key: 'Private path', value: 'C:\\private\\pilot\\flight.bbl'},
    ...COMMUNITY_BLACKBOX_CONFIG_MANIFESTS[minor].fields.map(specification => ({
      key: specification.key,
      value: blackboxValueFor(specification)
    }))
  ];
}

function frozenEvidence(entries = headerEntries(), terminationClean = true) {
  const frozenEntries = entries.map(entry => Object.freeze({...entry}));
  Object.freeze(frozenEntries);
  return Object.defineProperties({}, {
    headerTerminationClean: {
      value: terminationClean,
      enumerable: true,
      writable: false,
      configurable: false
    },
    headerEntries: {
      value: frozenEntries,
      enumerable: true,
      writable: false,
      configurable: false
    }
  });
}

function replaceHeader(entries, key, value) {
  return entries.map(entry => entry.key === key ? {...entry, value} : {...entry});
}

function replaceRow(rows, scope, key, value) {
  return rows.map(row => row[0] === scope && row[1] === key
    ? [row[0], row[1], value]
    : [row[0], row[1], Array.isArray(row[2]) ? [...row[2]] : row[2]]);
}

function assertClosed(report, overlap) {
  assert.equal(report.overlap, overlap);
  assert.equal(report.binding, 'unproven');
  assert.equal(report.complete, false);
  assert.equal(report.cohortEligible, false);
  assert.equal(report.adviceEligible, false);
  assert.equal(report.modelEligible, false);
  assert.equal(report.sessionBody, 'not-checked');
  assert.equal(report.configChangeEvents, 'not-checked');
  for (const code of [
    'SESSION_BODY_NOT_CHECKED',
    'CONFIG_CHANGE_EVENTS_NOT_CHECKED',
    'EXACT_FLIGHT_BINDING_UNPROVEN',
    'COMPLETE_CONFIGURATION_BINDING_UNPROVEN',
    'CONFIGURATION_TRANSITIVE_CONTEXT_MISSING',
    'COMMUNITY_CONFIGURATION_CLOSED'
  ]) assert.equal(report.codes.includes(code), true, code);
}

test('all six reviewed releases match only the common header subset and remain closed', () => {
  for (const version of Object.keys(RELEASES)) {
    const rows = snapshotRows(version);
    const reportedCommit = /\(([0-9a-f]{7,40})\)/.exec(RELEASES[version])[1];
    const snapshotCommit = rowValue(rows, 'meta', 'firmware_commit');
    assert.equal(snapshotCommit.length, 7);
    assert.equal(reportedCommit.startsWith(snapshotCommit), true,
      `${version} Blackbox identity must contain the reviewed snapshot prefix`);
    const report = inspectCommunityConfigPairing(
      frozenEvidence(headerEntries(version)),
      snapshotBytes(version, rows)
    );
    assert.equal(report.sessionEvidence, 'reviewed-partial', version);
    assert.equal(report.snapshotEvidence, 'reviewed-partial', version);
    assertClosed(report, 'matched');
    assert.equal(report.codes.includes('COMMON_EVIDENCE_MATCHED'), true);
  }
});

test('real opt-in parseSession evidence reaches the same closed match', () => {
  const entries = headerEntries('4.6.0');
  const structural = [
    {key: 'Field I name', value: 'time'},
    {key: 'Field I signed', value: '0'},
    {key: 'Field I predictor', value: '0'},
    {key: 'Field I encoding', value: '1'},
    {key: 'Field P predictor', value: '1'},
    {key: 'Field P encoding', value: '0'}
  ];
  const preamble = entries.filter(entry => ['Product', 'Data version'].includes(entry.key));
  const remainder = entries.filter(entry => !['Product', 'Data version'].includes(entry.key));
  const text = [...preamble, ...structural, ...remainder]
    .map(entry => `H ${entry.key}:${entry.value}`).join('\n') + '\nI';
  const parsed = parseSession(ENCODER.encode(text), 0, 0, {retainHeaderEntries: true});
  assertClosed(inspectCommunityConfigPairing(parsed, snapshotBytes()), 'matched');
});

test('8-character and full Blackbox commits match every reviewed short snapshot commit', () => {
  for (const version of Object.keys(RELEASES)) {
    const fullCommit = COMMUNITY_CONFIG_SUPPLEMENT_MANIFESTS[version].commit;
    assert.equal(fullCommit.length, 40);
    for (const reportedCommit of [fullCommit.slice(0, 8), fullCommit]) {
      const entries = replaceHeader(
        headerEntries(version),
        'Firmware revision',
        `Rotorflight ${version} (${reportedCommit}) STM32F7X2`
      );
      assertClosed(inspectCommunityConfigPairing(
        frozenEvidence(entries), snapshotBytes(version)
      ), 'matched');
    }
  }
});

test('distinct RF4.6 values pin govPID p,i,d,f,gain and yaw_tta gain,limit order', () => {
  let rows = snapshotRows('4.6.0');
  for (const [key, value] of [
    ['gov_p_gain', 11],
    ['gov_i_gain', 12],
    ['gov_d_gain', 13],
    ['gov_f_gain', 14],
    ['gov_gain', 15],
    ['gov_tta_gain', 16],
    ['gov_tta_limit', 17]
  ]) rows = replaceRow(rows, 'governor-profile', key, value);
  rows = replaceRow(rows, 'mixer', 'sc_min', -900);
  rows = replaceRow(rows, 'mixer', 'sc_max', 900);

  let entries = replaceHeader(headerEntries(), 'govPID', '11,12,13,14,15');
  entries = replaceHeader(entries, 'yaw_tta', '16,17');
  entries = replaceHeader(entries, 'collectiveRange', '-900,900');
  assertClosed(inspectCommunityConfigPairing(
    frozenEvidence(entries), snapshotBytes('4.6.0', rows)
  ), 'matched');

  assertClosed(inspectCommunityConfigPairing(
    frozenEvidence(replaceHeader(entries, 'govPID', '15,11,12,13,14')),
    snapshotBytes('4.6.0', rows)
  ), 'mismatched');
  assertClosed(inspectCommunityConfigPairing(
    frozenEvidence(replaceHeader(entries, 'yaw_tta', '17,16')),
    snapshotBytes('4.6.0', rows)
  ), 'mismatched');
});

test('every independently valid common-evidence change is a mismatch', () => {
  const cases = [
    ['board', 'meta', 'board', 'NEXUS'],
    ['rate type', 'rates', 'rates_type', 2],
    ['rc rate', 'rates', 'roll_rc_rate', 2],
    ['expo', 'rates', 'pitch_expo', 1],
    ['super rate', 'rates', 'yaw_srate', 1],
    ['acceleration', 'rates', 'roll_accel_limit', 1],
    ['response', 'rates', 'pitch_response', 1],
    ['governor PID', 'governor-profile', 'gov_p_gain', 1],
    ['governor TTA', 'governor-profile', 'gov_tta_gain', 1],
    ['collective range', 'mixer', 'sc_min', -999]
  ];
  const base = snapshotRows('4.6.0');
  for (const [label, scope, key, value] of cases) {
    const report = inspectCommunityConfigPairing(
      frozenEvidence(),
      snapshotBytes('4.6.0', replaceRow(base, scope, key, value))
    );
    assertClosed(report, 'mismatched');
    assert.equal(report.codes.includes('COMMON_EVIDENCE_MISMATCH'), true, label);
  }

  const releaseMismatch = inspectCommunityConfigPairing(
    frozenEvidence(headerEntries('4.4.0')),
    snapshotBytes('4.4.1')
  );
  assertClosed(releaseMismatch, 'mismatched');
});

test('missing, malformed, duplicate, or unreviewed common headers are unavailable', () => {
  const base = headerEntries();
  const cases = [
    base.filter(entry => entry.key !== 'rc_expo'),
    replaceHeader(base, 'rc_rates', '1, 1,1'),
    [...base, {key: 'rates_type', value: '1'}],
    replaceHeader(base, 'Board information', 'PRIVATE BOARD'),
    replaceHeader(base, 'Firmware revision',
      'Rotorflight 4.6.0 (118e912) STM32H743')
  ];
  for (const entries of cases) {
    const report = inspectCommunityConfigPairing(frozenEvidence(entries), snapshotBytes());
    assertClosed(report, 'unavailable');
  }

  const duplicateRequiredSetting = inspectCommunityConfigPairing(
    frozenEvidence([...base, {...base.find(entry => entry.key === 'looptime')}]),
    snapshotBytes()
  );
  assert.equal(
    duplicateRequiredSetting.codes.includes('BLACKBOX_CONTEXT_UNAVAILABLE'),
    true
  );
  assertClosed(duplicateRequiredSetting, 'unavailable');
});

test('RF4.4+ governor, TTA, and collective overlap fails closed by evidence class', () => {
  const base = headerEntries('4.4.1');
  const malformed = Object.freeze({
    govPID: '0,0,0,0',
    yaw_tta: '0, 0',
    collectiveRange: '-0,1000'
  });
  const outOfDomain = Object.freeze({
    govPID: '251,0,0,0,0',
    yaw_tta: '251,0',
    collectiveRange: '-2501,1000'
  });
  const disagreements = Object.freeze({
    govPID: '1,0,0,0,0',
    yaw_tta: '1,0',
    collectiveRange: '-999,1000'
  });

  for (const key of ['govPID', 'yaw_tta', 'collectiveRange']) {
    const missing = base.filter(entry => entry.key !== key);
    assertClosed(inspectCommunityConfigPairing(
      frozenEvidence(missing), snapshotBytes('4.4.1')
    ), 'unavailable');

    const original = base.find(entry => entry.key === key);
    const duplicate = [...base, {...original}];
    assertClosed(inspectCommunityConfigPairing(
      frozenEvidence(duplicate), snapshotBytes('4.4.1')
    ), 'unavailable');

    assertClosed(inspectCommunityConfigPairing(
      frozenEvidence(replaceHeader(base, key, malformed[key])),
      snapshotBytes('4.4.1')
    ), 'unavailable');

    assertClosed(inspectCommunityConfigPairing(
      frozenEvidence(replaceHeader(base, key, outOfDomain[key])),
      snapshotBytes('4.4.1')
    ), 'unavailable');

    assertClosed(inspectCommunityConfigPairing(
      frozenEvidence(replaceHeader(base, key, disagreements[key])),
      snapshotBytes('4.4.1')
    ), 'mismatched');
  }
});

test('RF4.3 does not require governor, TTA, or collective header evidence', () => {
  const entries = headerEntries('4.3.0');
  for (const key of ['govPID', 'yaw_tta', 'collectiveRange']) {
    assert.equal(entries.some(entry => entry.key === key), false, key);
  }
  assertClosed(inspectCommunityConfigPairing(
    frozenEvidence(entries), snapshotBytes('4.3.0')
  ), 'matched');
});

test('mutable, truncated, accessor, and throwing-proxy session evidence never throws', () => {
  const mutableEntries = headerEntries().map(entry => Object.freeze(entry));
  const mutable = Object.defineProperties({}, {
    headerTerminationClean: {
      value: true, enumerable: true, writable: false, configurable: false
    },
    headerEntries: {
      value: mutableEntries, enumerable: true, writable: false, configurable: false
    }
  });
  const accessorEntry = {value: '1'};
  Object.defineProperty(accessorEntry, 'key', {get() { throw new Error('no'); }});
  Object.freeze(accessorEntry);
  const accessorEntries = Object.freeze([accessorEntry]);
  const accessor = Object.defineProperties({}, {
    headerTerminationClean: {
      value: true, enumerable: true, writable: false, configurable: false
    },
    headerEntries: {
      value: accessorEntries, enumerable: true, writable: false, configurable: false
    }
  });
  const hostile = new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error('hostile'); }
  });
  for (const candidate of [
    null,
    mutable,
    frozenEvidence(headerEntries(), false),
    accessor,
    hostile
  ]) {
    let report;
    assert.doesNotThrow(() => {
      report = inspectCommunityConfigPairing(candidate, snapshotBytes());
    });
    assert.equal(report.codes.includes('SESSION_EVIDENCE_INVALID'), true);
    assertClosed(report, 'unavailable');
  }
});

test('hostile snapshots fail closed without invoking typed-array species', () => {
  class HostileBytes extends Uint8Array {
    static get [Symbol.species]() {
      throw new Error('species must not run');
    }
  }
  const ordinary = snapshotBytes();
  const subclass = new HostileBytes(ordinary);
  assertClosed(inspectCommunityConfigPairing(frozenEvidence(), subclass), 'matched');

  const proxy = new Proxy(ordinary, {});
  let proxyReport;
  assert.doesNotThrow(() => {
    proxyReport = inspectCommunityConfigPairing(frozenEvidence(), proxy);
  });
  assert.equal(proxyReport.codes.includes('SUPPLEMENT_SNAPSHOT_UNAVAILABLE'), true);
  assertClosed(proxyReport, 'unavailable');

  const revocable = Proxy.revocable(ordinary, {});
  revocable.revoke();
  let revokedReport;
  assert.doesNotThrow(() => {
    revokedReport = inspectCommunityConfigPairing(frozenEvidence(), revocable.proxy);
  });
  assert.equal(revokedReport.codes.includes('SUPPLEMENT_SNAPSHOT_UNAVAILABLE'), true);
  assertClosed(revokedReport, 'unavailable');

  if (typeof SharedArrayBuffer !== 'undefined') {
    const shared = new Uint8Array(new SharedArrayBuffer(ordinary.length));
    shared.set(ordinary);
    const sharedReport = inspectCommunityConfigPairing(frozenEvidence(), shared);
    assert.equal(sharedReport.codes.includes('SUPPLEMENT_SNAPSHOT_UNAVAILABLE'), true);
    assertClosed(sharedReport, 'unavailable');

    const crossRealmBuffer = runInNewContext(
      `new SharedArrayBuffer(${ordinary.length})`
    );
    assert.equal(crossRealmBuffer instanceof SharedArrayBuffer, false);
    const crossRealmBacked = new Uint8Array(crossRealmBuffer);
    crossRealmBacked.set(ordinary);
    const crossRealmReport = inspectCommunityConfigPairing(
      frozenEvidence(), crossRealmBacked
    );
    assert.equal(
      crossRealmReport.codes.includes('SUPPLEMENT_SNAPSHOT_UNAVAILABLE'),
      true
    );
    assertClosed(crossRealmReport, 'unavailable');
  }

  const invalid = ENCODER.encode('{');
  const invalidReport = inspectCommunityConfigPairing(frozenEvidence(), invalid);
  assert.equal(invalidReport.codes.includes('SUPPLEMENT_SNAPSHOT_UNAVAILABLE'), true);
  assertClosed(invalidReport, 'unavailable');

  const duplicatedRows = snapshotRows();
  duplicatedRows.push([...duplicatedRows[0]]);
  const duplicateReport = inspectCommunityConfigPairing(
    frozenEvidence(), snapshotBytes('4.6.0', duplicatedRows)
  );
  assert.equal(duplicateReport.codes.includes('SUPPLEMENT_SNAPSHOT_UNAVAILABLE'), true);
  assertClosed(duplicateReport, 'unavailable');
});

test('reports are deeply frozen and never echo private or rejected evidence', () => {
  const privateEntries = replaceHeader(
    headerEntries(), 'rc_rates', '999999999999999999999999999999'
  );
  const report = inspectCommunityConfigPairing(
    frozenEvidence(privateEntries),
    snapshotBytes()
  );
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.codes), true);
  assert.equal(COMMUNITY_CONFIG_PAIRING_SCHEMA_VERSION, 1);
  assert.equal(
    COMMUNITY_CONFIG_PAIRING_REPORT_KIND,
    'rotorlens-community-config-pairing-report-v1'
  );
  assert.equal(
    COMMUNITY_CONFIG_PAIRING_INSPECTOR_VERSION,
    'rotorlens-community-config-pairing-inspector-v1'
  );
  assert.equal(report.schemaVersion, COMMUNITY_CONFIG_PAIRING_SCHEMA_VERSION);
  assert.equal(report.kind, COMMUNITY_CONFIG_PAIRING_REPORT_KIND);
  assert.equal(report.inspectorVersion, COMMUNITY_CONFIG_PAIRING_INSPECTOR_VERSION);
  assert.deepEqual(Object.keys(report), [
    'schemaVersion',
    'kind',
    'inspectorVersion',
    'sessionEvidence',
    'snapshotEvidence',
    'overlap',
    'sessionBody',
    'configChangeEvents',
    'binding',
    'complete',
    'cohortEligible',
    'adviceEligible',
    'modelEligible',
    'codes'
  ]);
  assert.throws(() => report.codes.push('MUTATE'), TypeError);
  const serialized = JSON.stringify(report);
  for (const forbidden of [
    'PRIVATE HELICOPTER NAME',
    '2026-08-14',
    'C:\\private',
    '999999999999999999999999999999',
    'FRSK VANTAC_RF007',
    '118e912',
    'rc_rates'
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.equal('index' in report, false);
  assert.equal('digest' in report, false);
  assert.equal('configFingerprints' in report, false);
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

test('pairing remains an offline leaf outside contract, model, UI, Android, and tools', () => {
  const modulePath = path.join(ROOT, 'src', 'analysis', 'community-config-pairing.mjs');
  const source = readFileSync(modulePath, 'utf8');
  for (const forbidden of [
    /community-contract/,
    /community-model/,
    /flight-history/,
    /recommendations/,
    /\bfetch\s*\(/,
    /https?:\/\//,
    /node:net/,
    /WebSocket/,
    /MSP_SET/,
    /sha256Hex/,
    /hmac/i
  ]) assert.doesNotMatch(source, forbidden);

  const candidates = [
    ...sourceFiles(path.join(ROOT, 'src')),
    ...sourceFiles(path.join(ROOT, 'ui')),
    ...sourceFiles(path.join(ROOT, 'android')),
    ...sourceFiles(path.join(ROOT, 'tools')),
    ...sourceFiles(path.join(ROOT, 'bin')),
    path.join(ROOT, 'package.json')
  ].filter(candidate => path.resolve(candidate) !== path.resolve(modulePath));
  for (const candidate of candidates) {
    assert.equal(
      readFileSync(candidate, 'utf8').includes('community-config-pairing'),
      false,
      `unexpected production reference: ${candidate}`
    );
  }
});
