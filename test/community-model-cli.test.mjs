import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  DRAFT_COMMUNITY_MANUAL_CONSENT_VERSION,
  DRAFT_COMMUNITY_MANUAL_LICENCE_VERSION,
  buildCommunityContribution
} from '../src/analysis/community-contract.mjs';
import {auditCommunityShadowModel} from '../src/analysis/community-model.mjs';
import {
  addFlightRecord,
  buildFlightRecord,
  createHistory,
  shareableRecord
} from '../src/analysis/flight-history.mjs';
import {FlightWindowBasis} from '../src/analysis/flight-window.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(projectRoot, 'tools', 'build-community-model.mjs');

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rotorlens-community-cli-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

function invoke(...arguments_) {
  return spawnSync(process.execPath, [cli, ...arguments_], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 15_000
  });
}

function measurementOnlyContribution() {
  const headers = {
    'Craft name': 'CLI fixture',
    'Board information': 'NEXUS',
    'Firmware revision': 'Rotorflight 4.6.0 (118e912) STM32F7X2',
    rates_type: '4',
    rc_rates: '5,5,12',
    rc_expo: '30,30,50',
    rates: '10,10,25',
    rollPID: '52,105,0,100,0',
    pitchPID: '64,111,40,100,0',
    yawPID: '315,145,29,3,1'
  };
  const stored = addFlightRecord(createHistory(), buildFlightRecord({
    session: {
      headers,
      craftName: headers['Craft name'],
      board: headers['Board information'],
      firmware: {revision: headers['Firmware revision']}
    },
    window: {basis: FlightWindowBasis.DETECTED, startUs: 0, endUs: 120_000_000},
    axes: Object.fromEntries(
      ['roll', 'pitch', 'yaw'].map(axis => [axis, {headspeedMedianRpm: 2000}])
    )
  })).records[0];
  const digest = character => `${character.repeat(42)}A`;
  return buildCommunityContribution({
    consentVersion: DRAFT_COMMUNITY_MANUAL_CONSENT_VERSION,
    licenceVersion: DRAFT_COMMUNITY_MANUAL_LICENCE_VERSION,
    contributionId: `hmac-sha256:${digest('C')}`,
    airframeProfile: {
      rotorDiameterMm: 700,
      bladeCount: 2,
      powerType: 'electric',
      cyclicServoClass: 'standard',
      tailServoClass: 'mini'
    },
    configFingerprints: {
      filter: `sha256:${digest('A')}`,
      governor: `sha256:${digest('B')}`
    },
    safetyAssessment: {airframe: 'not-measured'},
    guidance: {source: 'manual', modelVersion: null, communityInfluenced: false},
    shareableRecord: shareableRecord(stored, '01234-56789-abcde-fghjk')
  });
}

test('an empty corpus is refused by default', async () => {
  await withTemporaryDirectory(async directory => {
    const input = path.join(directory, 'contributions.json');
    await writeFile(input, '[]\n');

    const result = invoke(input);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /no privacy-qualified cohort evidence/);
  });
});

test('--allow-empty produces deterministic pretty shadow-model JSON for smoke tests', async () => {
  await withTemporaryDirectory(async directory => {
    const input = path.join(directory, 'contributions.json');
    await writeFile(input, '[]\n');

    const first = invoke(input, '--allow-empty');
    const second = invoke('--allow-empty', input);

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stderr, '');
    assert.equal(first.stdout, second.stdout);
    assert.ok(first.stdout.endsWith('\n'));

    const model = JSON.parse(first.stdout);
    assert.equal(auditCommunityShadowModel(model).ok, true);
    assert.equal(model.mode, 'shadow');
    assert.equal(`${JSON.stringify(model, null, 2)}\n`, first.stdout);
  });
});

test('the CLI has no import or option for the prevalidated-fixture seam', async () => {
  const source = await readFile(cli, 'utf8');

  assert.doesNotMatch(source, /PrevalidatedFixtures|test-only-prevalidated-fixtures/);
  assert.doesNotMatch(source, /allow-draft|prevalidated-fixture/i);
});

test('--out writes the same audited JSON and leaves stdout empty', async () => {
  await withTemporaryDirectory(async directory => {
    const input = path.join(directory, 'contributions.json');
    const output = path.join(directory, 'model.json');
    await writeFile(input, '[]');

    const result = invoke(input, '--out', output, '--allow-empty');

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');

    const serialized = await readFile(output, 'utf8');
    const model = JSON.parse(serialized);
    assert.equal(auditCommunityShadowModel(model).ok, true);
    assert.equal(serialized, `${JSON.stringify(model, null, 2)}\n`);
  });
});

test('--out never replaces an existing file', async () => {
  await withTemporaryDirectory(async directory => {
    const input = path.join(directory, 'contributions.json');
    const output = path.join(directory, 'existing-model.json');
    const sentinel = 'owner data that must not be overwritten\n';
    await writeFile(input, '[]');
    await writeFile(output, sentinel);

    const result = invoke(input, '--out', output, '--allow-empty');

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^model output could not be written \(EEXIST\)\n$/);
    assert.doesNotMatch(result.stderr, /existing-model\.json/);
    assert.equal(await readFile(output, 'utf8'), sentinel);
  });
});

test('one invalid contribution refuses the whole run without echoing values or paths', async () => {
  await withTemporaryDirectory(async directory => {
    const input = path.join(directory, 'private-source.json');
    const privateValue = 'C:\\Users\\Jane Doe\\Flights\\Sunday.BBL';
    await writeFile(input, JSON.stringify([{privateValue}]));

    const result = invoke(input);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /community model refused/);
    assert.match(result.stderr, /contribution\[0\] [^:\r\n]+: [^\r\n]+/);
    assert.doesNotMatch(result.stderr, /Jane Doe|Sunday\.BBL|private-source\.json/i);
    assert.ok(!result.stderr.includes(input));
  });
});

test('an envelope object is refused because only a top-level array is accepted', async () => {
  await withTemporaryDirectory(async directory => {
    const input = path.join(directory, 'contributions.json');
    await writeFile(input, JSON.stringify({contributions: []}));

    const result = invoke(input);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'input must be a top-level JSON array\n');
  });
});

test('the contribution-count limit is enforced before per-record auditing', async () => {
  await withTemporaryDirectory(async directory => {
    const input = path.join(directory, 'contributions.json');
    await writeFile(input, JSON.stringify(Array.from({length: 10_001}, () => null)));

    const result = invoke(input, '--allow-empty');

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'input exceeds the 10000 contribution limit\n');
  });
});

test('draft terms are refused even when empty smoke artifacts are allowed', async () => {
  await withTemporaryDirectory(async directory => {
    const input = path.join(directory, 'contributions.json');
    await writeFile(input, JSON.stringify([measurementOnlyContribution()]));

    const refused = invoke(input);
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /invalid contribution records/);
    assert.match(refused.stderr, /not been formally adopted/);

    const smoke = invoke(input, '--allow-empty');
    assert.equal(smoke.status, 1);
    assert.equal(smoke.stdout, '');
    assert.match(smoke.stderr, /invalid contribution records/);
  });
});

test('unknown options and multiple input files are usage errors', async () => {
  const unknown = invoke('--publish');
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, '');
  assert.match(unknown.stderr, /^unknown option\nUsage:/);
  assert.doesNotMatch(unknown.stderr, /publish/,
    'an arbitrary command-line value must not be reflected');

  const multiple = invoke('one.json', 'two.json');
  assert.equal(multiple.status, 2);
  assert.equal(multiple.stdout, '');
  assert.match(multiple.stderr, /^multiple input files are not allowed\nUsage:/);
  assert.doesNotMatch(multiple.stderr, /one\.json|two\.json/);
});

test('invalid JSON is refused without echoing its contents or source path', async () => {
  await withTemporaryDirectory(async directory => {
    const input = path.join(directory, 'secret-input.json');
    await writeFile(input, '{"pilot":"Jane Doe"');

    const result = invoke(input);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'input is not valid JSON\n');
    assert.doesNotMatch(result.stderr, /Jane Doe|secret-input\.json/);
  });
});
