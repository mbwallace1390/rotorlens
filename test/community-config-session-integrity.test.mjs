import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  COMMUNITY_CONFIG_SESSION_INTEGRITY_CODES,
  COMMUNITY_CONFIG_SESSION_INTEGRITY_INSPECTOR_VERSION,
  COMMUNITY_CONFIG_SESSION_INTEGRITY_REPORT_KIND,
  COMMUNITY_CONFIG_SESSION_INTEGRITY_SCHEMA_VERSION,
  inspectCommunityConfigSessionIntegrity
} from '../src/analysis/community-config-session-integrity.mjs';
import {
  COMMUNITY_BLACKBOX_CONFIG_MANIFESTS
} from '../src/analysis/community-config-extractor.mjs';
import {
  captureSessionIntegrityEvidence,
  decodeLog,
  ENGINE
} from '../src/blackbox/decode.mjs';
import {ByteWriter} from '../tools/blackbox-writer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RELEASES = Object.freeze({
  '4.3.0': '05570fec69fd566e713f11e84adc7b77a8d68abf',
  '4.4.0': '5fc142adfdc4031877061433c5052e473b9cdfd2',
  '4.4.1': '456633bcea79933142c7fee17922ab306028bcf9',
  '4.5.0': 'e77d192c43c4b36ef4d18b67d24859ddc0968755',
  '4.5.1': 'e69823a3c185cbf1b75fd2701e938e978591a36b',
  '4.6.0': '118e9120260bb33f46df4f92052fb0e9fd4e9ebc'
});

function logBytes({
  version = '4.6.0',
  commit = RELEASES[version],
  target = 'STM32F7X2',
  board = 'FRSK VANTAC_RF007',
  mainFrame = false,
  adjustment = false,
  floatAdjustment = false,
  resume = false,
  syncBeepCount = 0,
  unknownEvent = false,
  logEnd = true,
  identityPrelude = [],
  additionalHeaders = [],
  malformedHeaderTail = false
} = {}) {
  const writer = new ByteWriter();
  writer.ascii([
    'H Product:Blackbox flight data recorder by Nicholas Sherlock',
    'H Data version:2',
    'H Field I name:time',
    'H Field I signed:0',
    'H Field I predictor:0',
    'H Field I encoding:1',
    'H Field P predictor:1',
    'H Field P encoding:0',
    ...identityPrelude,
    'H Firmware type:Rotorflight',
    `H Firmware revision:Rotorflight ${version} (${commit}) ${target}`,
    `H Board information:${board}`,
    ...additionalHeaders,
    ''
  ].join('\n'));
  if (malformedHeaderTail) writer.ascii('H \n');
  if (mainFrame) writer.ascii('I').unsignedVB(1000);
  for (let index = 0; index < syncBeepCount; index += 1) {
    writer.ascii('E').u8(0).unsignedVB(index);
  }
  if (unknownEvent) writer.ascii('E').u8(53).u8(1);
  if (adjustment) writer.ascii('E').u8(13).u8(1).signedVB(-257);
  if (floatAdjustment) writer.ascii('E').u8(13).u8(0x80 | 2).floatLE(1.5);
  if (resume) writer.ascii('E').u8(14).unsignedVB(400).unsignedVB(500_000);
  if (logEnd) writer.ascii('E').u8(255).ascii('End of log').u8(0);
  return new Uint8Array(writer.toBuffer());
}

function inspect(bytes, options, sessionIndex = 0) {
  const result = decodeLog(bytes, options);
  return {
    result,
    report: inspectCommunityConfigSessionIntegrity(result, sessionIndex, bytes.byteLength)
  };
}

function assertClosed(report) {
  assert.equal(report.binding, 'unproven');
  assert.equal(report.complete, false);
  assert.equal(report.cohortEligible, false);
  assert.equal(report.adviceEligible, false);
  assert.equal(report.modelEligible, false);
  for (const code of [
    'EXACT_FLIGHT_BINDING_UNPROVEN',
    'COMPLETE_CONFIGURATION_BINDING_UNPROVEN',
    'CONFIGURATION_TRANSITIVE_CONTEXT_MISSING',
    'COMMUNITY_CONFIGURATION_CLOSED'
  ]) assert.equal(report.codes.includes(code), true, code);
}

test('a clean continuous body reports only that no adjustment event was observed', () => {
  const {report} = inspect(logBytes());
  assert.equal(report.sessionBody, 'clean');
  assert.equal(report.continuity, 'continuous');
  assert.equal(report.configChangeEvents, 'not-observed');
  assert.equal(report.codes.includes('SESSION_BODY_CLEAN'), true);
  assert.equal(report.codes.includes('SESSION_CONTINUITY_CONTINUOUS'), true);
  assert.equal(report.codes.includes('CONFIG_CHANGE_EVENTS_NOT_OBSERVED'), true);
  assertClosed(report);
});

test('event 13 is categorical rejection evidence and never exposes its payload', () => {
  const {report} = inspect(logBytes({adjustment: true}));
  assert.equal(report.sessionBody, 'clean');
  assert.equal(report.continuity, 'continuous');
  assert.equal(report.configChangeEvents, 'observed');
  assert.equal(report.codes.includes('CONFIG_CHANGE_EVENTS_OBSERVED'), true);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('-257'), false);
  assert.equal(serialized.includes('inflight-adjustment'), false);
  assertClosed(report);
});

test('event 14 marks a coverage gap unless positive event 13 evidence exists', () => {
  const gap = inspect(logBytes({resume: true})).report;
  assert.equal(gap.sessionBody, 'clean');
  assert.equal(gap.continuity, 'gapped');
  assert.equal(gap.configChangeEvents, 'unavailable');
  assert.equal(gap.codes.includes('CONFIG_CHANGE_EVENT_COVERAGE_GAP'), true);
  assert.equal(gap.codes.includes('CONFIG_CHANGE_EVENTS_UNAVAILABLE'), true);
  assertClosed(gap);

  const observed = inspect(logBytes({adjustment: true, resume: true})).report;
  assert.equal(observed.sessionBody, 'clean');
  assert.equal(observed.continuity, 'gapped');
  assert.equal(observed.configChangeEvents, 'observed');
  assert.equal(observed.codes.includes('CONFIG_CHANGE_EVENT_COVERAGE_GAP'), true);
  assertClosed(observed);
});

test('lazy decode and in-place release cannot create a clean unread body', () => {
  const bytes = logBytes();
  const result = decodeLog(bytes, {lazy: true});
  const before = inspectCommunityConfigSessionIntegrity(result, 0, bytes.byteLength);
  assert.equal(before.sessionBody, 'unavailable');
  assert.equal(before.codes.includes('SESSION_BODY_NOT_DECODED'), true);

  result.sessions[0].decodeFrames();
  const decoded = inspectCommunityConfigSessionIntegrity(result, 0, bytes.byteLength);
  const serialized = JSON.stringify(decoded);
  assert.equal(decoded.sessionBody, 'clean');

  result.sessions[0].releaseFrames();
  const released = inspectCommunityConfigSessionIntegrity(result, 0, bytes.byteLength);
  assert.equal(released.sessionBody, 'unavailable');
  assert.equal(released.codes.includes('SESSION_BODY_NOT_DECODED'), true);
  assert.equal(JSON.stringify(decoded), serialized, 'the captured report changed after release');
});

test('all six source-reviewed release pins accept 7, 8, and 40 commit characters', () => {
  const manifestReleases = Object.fromEntries(
    Object.values(COMMUNITY_BLACKBOX_CONFIG_MANIFESTS)
      .flatMap(manifest => manifest.sourceReleases)
      .map(release => [release.version, release.commit])
  );
  assert.deepEqual(manifestReleases, RELEASES, 'the body and header source pins drifted');
  for (const [version, commit] of Object.entries(RELEASES)) {
    for (const reportedCommit of [commit.slice(0, 7), commit.slice(0, 8), commit]) {
      for (const board of ['FRSK VANTAC_RF007', 'NEXUS']) {
        const report = inspect(logBytes({version, commit: reportedCommit, board})).report;
        assert.equal(report.sessionBody, 'clean', `${version} ${reportedCommit} ${board}`);
        assertClosed(report);
      }
    }
  }
});

test('integer and float event 13 payloads are observed across all six release pins', () => {
  for (const [version, commit] of Object.entries(RELEASES)) {
    for (const [valueType, payload] of [
      ['integer', {adjustment: true}],
      ['float', {floatAdjustment: true}]
    ]) {
      const bytes = logBytes({version, commit: commit.slice(0, 7), ...payload});
      const {result, report} = inspect(bytes);
      const adjustmentEvent = result.sessions[0].events.find(
        event => event.event === 'inflight-adjustment'
      );
      assert.equal(adjustmentEvent?.valueType, valueType, `${version} ${valueType}`);
      assert.equal(report.sessionBody, 'clean', `${version} ${valueType}`);
      assert.equal(report.configChangeEvents, 'observed', `${version} ${valueType}`);
      assertClosed(report);
    }
  }
});

test('unreviewed release, commit, target, board, or decorated identity stays closed', () => {
  for (const bytes of [
    logBytes({version: '4.6.1', commit: RELEASES['4.6.0']}),
    logBytes({commit: '0000000'}),
    logBytes({target: 'STM32H743'}),
    logBytes({board: 'PRIVATE BOARD'}),
    logBytes({version: '4.6.0-ALICE', commit: RELEASES['4.6.0']}),
    logBytes({commit: RELEASES['4.6.0'].slice(0, 7).toUpperCase()})
  ]) {
    const report = inspect(bytes).report;
    assert.equal(report.sessionBody, 'unavailable');
    assert.equal(report.codes.includes('SESSION_FIRMWARE_UNREVIEWED'), true);
    assertClosed(report);
  }
});

test('truncation and body damage cannot support a negative observation', () => {
  const truncated = inspect(logBytes({logEnd: false})).report;
  assert.equal(truncated.sessionBody, 'unavailable');
  assert.equal(truncated.configChangeEvents, 'unavailable');
  assert.equal(truncated.codes.includes('SESSION_BODY_TRUNCATED'), true);
  assert.equal(truncated.codes.includes('SESSION_BODY_INCOMPLETE'), true);

  const damaged = inspect(logBytes({unknownEvent: true})).report;
  assert.equal(damaged.sessionBody, 'unavailable');
  assert.equal(damaged.configChangeEvents, 'unavailable');
  assert.equal(damaged.codes.includes('SESSION_BODY_DAMAGED'), true);

  assertClosed(truncated);
  assertClosed(damaged);
});

test('malformed or duplicate header evidence cannot become a clean body', () => {
  const malformedBytes = logBytes({
    malformedHeaderTail: true,
    additionalHeaders: [
      'H Field H name:GPS_home[0],GPS_home[1]',
      'H Field H signed:1,1',
      'H Field H predictor:0,0',
      'H Field H encoding:1,1'
    ]
  });
  const malformed = inspect(malformedBytes);
  assert.deepEqual(malformed.result.sessions[0].errors, []);
  assert.equal(malformed.result.sessions[0].reachedLogEnd, true);
  assert.equal(malformed.report.sessionBody, 'unavailable');
  assert.equal(malformed.report.codes.includes('SESSION_EVIDENCE_INVALID'), true);

  const duplicate = inspect(logBytes({
    identityPrelude: [
      'H Firmware revision:Rotorflight 4.6.0 (0000000) STM32F7X2',
      'H Board information:PRIVATE BOARD'
    ]
  }));
  assert.deepEqual(duplicate.result.sessions[0].errors, []);
  assert.equal(duplicate.result.sessions[0].reachedLogEnd, true);
  assert.equal(duplicate.report.sessionBody, 'unavailable');
  assert.equal(duplicate.report.codes.includes('SESSION_EVIDENCE_INVALID'), true);
  assertClosed(malformed.report);
  assertClosed(duplicate.report);
});

test('decoder-owned event evidence stays compact at a large event inventory', () => {
  const bytes = logBytes({syncBeepCount: 10_000});
  const result = decodeLog(bytes);
  const evidence = captureSessionIntegrityEvidence(result, 0, bytes.byteLength);
  assert.equal(result.sessions[0].events.length, 10_001);
  assert.equal(evidence.eventSummary.count, 10_001);
  assert.deepEqual(evidence.eventSummary.tags, ['log-end', 'sync-beep']);
  assert.equal(Object.hasOwn(evidence, 'events'), false);
  assert.equal(JSON.stringify(evidence).length < 2_000, true);
  assert.equal(inspectCommunityConfigSessionIntegrity(
    result, 0, bytes.byteLength
  ).sessionBody, 'clean');

  result.sessions[0].releaseFrames();
  assert.deepEqual(
    captureSessionIntegrityEvidence(result, 0, bytes.byteLength),
    {status: 'not-decoded'}
  );
});

test('every decoder resource stop hides a later event 13 and remains unavailable', () => {
  const cases = [
    {
      name: 'maxFrames',
      bytes: logBytes({mainFrame: true, adjustment: true}),
      limits: {maxFrames: 0}
    },
    {
      name: 'maxEvents',
      bytes: logBytes({adjustment: true}),
      limits: {maxEvents: 0}
    },
    {
      name: 'maxRecords',
      bytes: logBytes({mainFrame: true, adjustment: true}),
      limits: {maxRecords: 1}
    },
    {
      name: 'maxErrors',
      bytes: logBytes({unknownEvent: true, adjustment: true}),
      limits: {maxErrors: 0}
    }
  ];
  for (const {name, bytes, limits} of cases) {
    const {result, report} = inspect(bytes, {limits});
    assert.equal(
      result.sessions[0].events.some(event => event.event === 'inflight-adjustment'),
      false,
      `${name} did not hide the later adjustment`
    );
    assert.equal(report.sessionBody, 'unavailable', name);
    assert.equal(report.continuity, 'unavailable', name);
    assert.equal(report.configChangeEvents, 'unavailable', name);
    assert.equal(report.codes.includes('SESSION_BODY_LIMIT_EXCEEDED'), true, name);
    assertClosed(report);
  }
});

test('the decode-result boundary owns the exact concatenated-session end', () => {
  const first = logBytes({version: '4.3.0', commit: RELEASES['4.3.0'].slice(0, 7)});
  const second = logBytes({adjustment: true});
  const bytes = new Uint8Array(first.byteLength + second.byteLength);
  bytes.set(first, 0);
  bytes.set(second, first.byteLength);
  const result = decodeLog(bytes);
  assert.equal(result.sessions.length, 2);
  const firstReport = inspectCommunityConfigSessionIntegrity(result, 0, bytes.byteLength);
  const secondReport = inspectCommunityConfigSessionIntegrity(result, 1, bytes.byteLength);
  assert.equal(firstReport.configChangeEvents, 'not-observed');
  assert.equal(secondReport.configChangeEvents, 'observed');
  assert.equal(firstReport.sessionBody, 'clean');
  assert.equal(secondReport.sessionBody, 'clean');
});

test('bytes after the exact LOG_END terminal keep the body incomplete', () => {
  const complete = logBytes();
  const adjustmentTail = new ByteWriter();
  adjustmentTail.ascii('E').u8(13).u8(1).signedVB(-257);

  for (const trailing of [
    new Uint8Array([0]),
    new Uint8Array(adjustmentTail.toBuffer())
  ]) {
    const bytes = new Uint8Array(complete.byteLength + trailing.byteLength);
    bytes.set(complete, 0);
    bytes.set(trailing, complete.byteLength);
    const {result, report} = inspect(bytes);

    assert.equal(result.sessions[0].reachedLogEnd, true);
    assert.equal(report.sessionBody, 'unavailable');
    assert.equal(report.continuity, 'unavailable');
    assert.equal(report.configChangeEvents, 'unavailable');
    assert.equal(report.codes.includes('SESSION_BODY_INCOMPLETE'), true);
    assertClosed(report);
  }
});

test('reordering public sessions cannot redirect the original selection evidence', () => {
  const first = logBytes({version: '4.3.0', commit: RELEASES['4.3.0'].slice(0, 7)});
  const second = logBytes({adjustment: true});
  const bytes = new Uint8Array(first.byteLength + second.byteLength);
  bytes.set(first, 0);
  bytes.set(second, first.byteLength);
  const result = decodeLog(bytes);
  const expectedFirst = inspectCommunityConfigSessionIntegrity(result, 0, bytes.byteLength);
  const expectedSecond = inspectCommunityConfigSessionIntegrity(result, 1, bytes.byteLength);

  result.sessions.reverse();
  result.sessions[0].index = 0;
  result.sessions[0].byteOffset = 0;
  result.sessions[1].index = 1;
  result.sessions[1].byteOffset = first.byteLength;

  assert.deepEqual(
    inspectCommunityConfigSessionIntegrity(result, 0, bytes.byteLength),
    expectedFirst
  );
  assert.deepEqual(
    inspectCommunityConfigSessionIntegrity(result, 1, bytes.byteLength),
    expectedSecond
  );
  assert.equal(expectedFirst.configChangeEvents, 'not-observed');
  assert.equal(expectedSecond.configChangeEvents, 'observed');
});

test('invalid selections and forged decoder lookalikes never open eligibility', () => {
  const bytes = logBytes();
  const result = decodeLog(bytes);
  const forgedSession = {
    index: 0,
    byteOffset: 0,
    firmware: result.sessions[0].firmware,
    samples: [],
    intraSampleIndices: [],
    events: [{event: 'log-end', terminal: true}],
    gps: [],
    frameCounts: {I: 0, P: 0, S: 0, G: 0, H: 0, E: 1, rejected: 0, resyncBytes: 0},
    truncated: false,
    reachedLogEnd: true,
    limitExceeded: false,
    errors: []
  };
  Object.defineProperty(forgedSession, 'framesDecoded', {
    configurable: false,
    get() { return true; }
  });
  const forged = {engine: ENGINE, sessions: [forgedSession], errors: []};
  const cases = [
    [null, 0, bytes.byteLength],
    [{}, 0, bytes.byteLength],
    [forged, 0, bytes.byteLength],
    [result, -1, bytes.byteLength],
    [result, 1, bytes.byteLength],
    [result, 0, 0],
    [new Proxy({}, {getOwnPropertyDescriptor() { throw new Error('hostile'); }}), 0,
      bytes.byteLength]
  ];
  for (const args of cases) {
    let report;
    assert.doesNotThrow(() => {
      report = inspectCommunityConfigSessionIntegrity(...args);
    });
    assert.equal(report.sessionBody, 'unavailable');
    assertClosed(report);
  }

  const forgedReport = inspectCommunityConfigSessionIntegrity(forged, 0, bytes.byteLength);
  assert.equal(forgedReport.codes.includes('DECODE_RESULT_INVALID'), true);
});

test('hostile public session views cannot change decoder-owned evidence', () => {
  const bytes = logBytes();
  const expected = inspect(bytes).report;

  const hostile = decodeLog(bytes);
  hostile.sessions[0].events = new Proxy(hostile.sessions[0].events, {
    getOwnPropertyDescriptor() { throw new Error('hostile events'); }
  });
  const report = inspectCommunityConfigSessionIntegrity(hostile, 0, bytes.byteLength);
  assert.deepEqual(report, expected);

  const accessor = decodeLog(bytes);
  let eventReads = 0;
  Object.defineProperty(accessor.sessions[0].events.at(-1), 'event', {
    configurable: true,
    get() { eventReads += 1; throw new Error('must not invoke event accessors'); }
  });
  const accessorReport = inspectCommunityConfigSessionIntegrity(
    accessor, 0, bytes.byteLength
  );
  assert.deepEqual(accessorReport, expected);
  assert.equal(eventReads, 0);

  const oversized = decodeLog(bytes);
  oversized.sessions[0].events.length = 100_001;
  oversized.sessions[0].frameCounts.E = 100_001;
  const oversizedReport = inspectCommunityConfigSessionIntegrity(
    oversized, 0, bytes.byteLength
  );
  assert.deepEqual(oversizedReport, expected);

  const revoked = decodeLog(bytes);
  const revocable = Proxy.revocable(revoked.sessions[0].events, {});
  revoked.sessions[0].events = revocable.proxy;
  revocable.revoke();
  assert.doesNotThrow(() => {
    const revokedReport = inspectCommunityConfigSessionIntegrity(
      revoked, 0, bytes.byteLength
    );
    assert.deepEqual(revokedReport, expected);
  });
});

test('public event counts and terminal mutations cannot change decoder-owned evidence', () => {
  for (const mutate of [
    session => { session.frameCounts.E += 1; },
    session => { session.reachedLogEnd = false; },
    session => { session.events.at(-1).event = 'state'; },
    session => { session.events.at(-1).terminal = false; },
    session => { delete session.events.at(-1).terminal; }
  ]) {
    const bytes = logBytes();
    const result = decodeLog(bytes);
    const expected = inspectCommunityConfigSessionIntegrity(result, 0, bytes.byteLength);
    mutate(result.sessions[0]);
    const report = inspectCommunityConfigSessionIntegrity(result, 0, bytes.byteLength);
    assert.deepEqual(report, expected);
    assert.equal(report.sessionBody, 'clean');
    assert.equal(report.configChangeEvents, 'not-observed');
  }
});

test('missing, null, or inconsistent public body arrays cannot change private evidence', () => {
  for (const mutate of [
    session => { session.samples = null; },
    session => { delete session.samples; },
    session => { session.intraSampleIndices = null; },
    session => { delete session.intraSampleIndices; },
    session => { session.gps = null; },
    session => { delete session.gps; },
    session => { session.intraSampleIndices.push(0); },
    session => { session.samples.length = 4_000_001; }
  ]) {
    const bytes = logBytes();
    const result = decodeLog(bytes);
    const expected = inspectCommunityConfigSessionIntegrity(result, 0, bytes.byteLength);
    mutate(result.sessions[0]);
    const report = inspectCommunityConfigSessionIntegrity(result, 0, bytes.byteLength);
    assert.deepEqual(report, expected);
    assert.equal(report.sessionBody, 'clean');
    assert.equal(report.configChangeEvents, 'not-observed');
  }
});

test('splicing and retagging a public event 13 cannot erase private observation', () => {
  const bytes = logBytes({adjustment: true});
  const result = decodeLog(bytes);
  const expected = inspectCommunityConfigSessionIntegrity(result, 0, bytes.byteLength);
  const adjustmentIndex = result.sessions[0].events.findIndex(
    event => event.event === 'inflight-adjustment'
  );
  assert.notEqual(adjustmentIndex, -1);

  result.sessions[0].events[adjustmentIndex].event = 'state';
  result.sessions[0].events.splice(adjustmentIndex, 1);
  result.sessions[0].frameCounts.E -= 1;

  const report = inspectCommunityConfigSessionIntegrity(result, 0, bytes.byteLength);
  assert.deepEqual(report, expected);
  assert.equal(report.sessionBody, 'clean');
  assert.equal(report.configChangeEvents, 'observed');
  assertClosed(report);
});

test('the report schema is fixed, ordered, deeply frozen, and sanitized', () => {
  const report = inspect(logBytes({adjustment: true, resume: true})).report;
  assert.equal(COMMUNITY_CONFIG_SESSION_INTEGRITY_SCHEMA_VERSION, 1);
  assert.equal(
    COMMUNITY_CONFIG_SESSION_INTEGRITY_REPORT_KIND,
    'rotorlens-community-config-session-integrity-report-v1'
  );
  assert.equal(
    COMMUNITY_CONFIG_SESSION_INTEGRITY_INSPECTOR_VERSION,
    'rotorlens-community-config-session-integrity-inspector-v1'
  );
  assert.deepEqual(Object.keys(report), [
    'schemaVersion',
    'kind',
    'inspectorVersion',
    'sessionBody',
    'continuity',
    'configChangeEvents',
    'binding',
    'complete',
    'cohortEligible',
    'adviceEligible',
    'modelEligible',
    'codes'
  ]);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.codes), true);
  assert.equal(Object.isFrozen(COMMUNITY_CONFIG_SESSION_INTEGRITY_CODES), true);
  assert.deepEqual(COMMUNITY_CONFIG_SESSION_INTEGRITY_CODES, [
    'DECODE_RESULT_INVALID',
    'SESSION_SELECTION_INVALID',
    'SESSION_EVIDENCE_INVALID',
    'SESSION_FIRMWARE_UNREVIEWED',
    'SESSION_BODY_NOT_DECODED',
    'SESSION_BODY_LIMIT_EXCEEDED',
    'SESSION_BODY_DAMAGED',
    'SESSION_BODY_TRUNCATED',
    'SESSION_BODY_INCOMPLETE',
    'SESSION_BODY_UNAVAILABLE',
    'SESSION_BODY_CLEAN',
    'SESSION_CONTINUITY_UNAVAILABLE',
    'SESSION_CONTINUITY_GAPPED',
    'SESSION_CONTINUITY_CONTINUOUS',
    'CONFIG_CHANGE_EVENT_COVERAGE_GAP',
    'CONFIG_CHANGE_EVENTS_UNAVAILABLE',
    'CONFIG_CHANGE_EVENTS_OBSERVED',
    'CONFIG_CHANGE_EVENTS_NOT_OBSERVED',
    'EXACT_FLIGHT_BINDING_UNPROVEN',
    'COMPLETE_CONFIGURATION_BINDING_UNPROVEN',
    'CONFIGURATION_TRANSITIVE_CONTEXT_MISSING',
    'COMMUNITY_CONFIGURATION_CLOSED'
  ]);
  assert.throws(() => report.codes.push('MUTATE'), TypeError);
  const indices = report.codes.map(code => COMMUNITY_CONFIG_SESSION_INTEGRITY_CODES.indexOf(code));
  assert.deepEqual(indices, [...indices].sort((left, right) => left - right));
  const serialized = JSON.stringify(report);
  for (const forbidden of [
    'FRSK VANTAC_RF007',
    RELEASES['4.6.0'].slice(0, 7),
    'STM32F7X2',
    'inflight-adjustment',
    'logging-resume',
    'End of log'
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.equal('index' in report, false);
  assert.equal('byteOffset' in report, false);
  assert.equal('sessionEnd' in report, false);
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

test('session integrity remains an offline leaf with no production caller', () => {
  const modulePath = path.join(
    ROOT, 'src', 'analysis', 'community-config-session-integrity.mjs'
  );
  const source = readFileSync(modulePath, 'utf8');
  const decoderPath = path.join(ROOT, 'src', 'blackbox', 'decode.mjs');
  const decoderSource = readFileSync(decoderPath, 'utf8');
  for (const forbidden of [
    /community-config-pairing/,
    /community-contract/,
    /community-model/,
    /flight-history/,
    /recommendations/,
    /\bfetch\s*\(/,
    /https?:\/\//,
    /node:net/,
    /WebSocket/,
    /MSP_SET/,
    /sha256/i,
    /hmac/i
  ]) assert.doesNotMatch(source, forbidden);
  assert.match(source, /captureSessionIntegrityEvidence\s*\(/);
  assert.equal(
    (decoderSource.match(/captureSessionIntegrityEvidence\s*\(/g) ?? []).length,
    1,
    'the decoder should only define the evidence capability'
  );

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
      readFileSync(candidate, 'utf8').includes('community-config-session-integrity'),
      false,
      `unexpected production reference: ${candidate}`
    );
    if (path.resolve(candidate) !== path.resolve(decoderPath)) {
      assert.equal(
        readFileSync(candidate, 'utf8').includes('captureSessionIntegrityEvidence'),
        false,
        `unexpected evidence capability caller: ${candidate}`
      );
    }
  }
});
