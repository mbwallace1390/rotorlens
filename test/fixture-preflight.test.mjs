import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {inspectFixtureHeaders} from '../src/fixture-preflight.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(projectRoot, 'fixtures', 'synthetic');

async function inspect(file) {
  return inspectFixtureHeaders(await readFile(path.join(fixtureDir, file)), file);
}

function fieldsOf(session, frameType) {
  return session.fieldGroups.find(group => group.frameType === frameType)?.fields ?? [];
}

test('header inventory reports firmware, craft, and declared fields', async () => {
  const report = await inspect('rf43-single-session.TXT');
  assert.equal(report.sessionCount, 1);

  const [session] = report.sessions;
  assert.equal(session.firmware.type, 'Rotorflight');
  assert.match(session.firmware.revision, /Rotorflight 4\.3\.0/);
  assert.equal(session.craftName, 'RL-SYNTH-1');
  assert.equal(session.dataVersion, '2');

  const mainFields = fieldsOf(session, 'I');
  assert.ok(mainFields.includes('headspeed'));
  assert.ok(mainFields.includes('tailspeed'));
  assert.ok(mainFields.includes('gyroADC[0]'));
  assert.ok(mainFields.includes('motor[0]'));
  assert.equal(session.locationFieldsDeclared, false);
});

test('P frames reuse the main field names with their own encodings', async () => {
  const [session] = (await inspect('rf43-single-session.TXT')).sessions;

  assert.deepEqual(
    fieldsOf(session, 'P'),
    fieldsOf(session, 'I'),
    'delta frames describe the same fields as the keyframes'
  );
});

test('concatenated sessions are found and summarized independently', async () => {
  const report = await inspect('rf46-two-sessions.TXT');

  assert.equal(report.sessionCount, 2);
  assert.ok(report.sessions[1].byteOffset > report.sessions[0].dataOffset);
  assert.equal(report.sessions[1].craftName, 'RL-SYNTH-2');
});

test('declared GPS fields are flagged for the fixture privacy policy', async () => {
  const [session] = (await inspect('rf46-gps-declared.TXT')).sessions;

  assert.equal(session.locationFieldsDeclared, true);
  assert.ok(session.locationFields.includes('GPS_coord[0]'));
});

test('a header truncated mid-line degrades instead of throwing', async () => {
  const [session] = (await inspect('rf46-truncated-header.TXT')).sessions;

  assert.equal(session.firmware.type, 'Rotorflight');
  assert.equal(session.craftName, null, 'the cut header line must not be reported as parsed');
});

test('header preflight rejects unsupported input types', () => {
  assert.throws(() => inspectFixtureHeaders('not bytes'), /Buffer or Uint8Array/);
});
