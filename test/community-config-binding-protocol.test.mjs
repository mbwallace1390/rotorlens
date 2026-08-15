import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {
  COMMUNITY_BLACKBOX_CONFIG_MANIFESTS
} from '../src/analysis/community-config-extractor.mjs';
import {sha256Hex} from '../src/integrity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIRMWARE_BINDING_ARTIFACT_ROOT = path.join(
  ROOT,
  'integration',
  'rotorflight-firmware',
  'binding-v1'
);
const DOMAIN = Buffer.from('RotorLens binding v1', 'ascii');
const PROTOCOL_VERSION = 1;
const HASH_ALGORITHM_ID = 1;
const MAXIMUM_ROWS = 256;
const MACHINE_TOKEN = /^[A-Za-z0-9._-]{1,32}$/;
const TYPE = Object.freeze({
  bool: 0x01,
  u8: 0x02,
  u16: 0x03,
  u32: 0x04,
  i16: 0x05,
  i32: 0x06
});
const WIDTH = Object.freeze({
  bool: 1,
  u8: 1,
  u16: 2,
  u32: 4,
  i16: 2,
  i32: 4
});

const VECTOR = Object.freeze({
  nonce: '000102030405060708090a0b0c0d0e0f',
  firmwareCommit: '00112233445566778899aabbccddeeff00112233',
  target: 'STM32F7X2',
  manifest: 'rotorlens-binding-vector-v1',
  activePidProfile: 2,
  activeRateProfile: 4,
  rows: Object.freeze([
    Object.freeze({id: 1, type: 'bool', value: true}),
    Object.freeze({id: 2, type: 'u8', value: 6}),
    Object.freeze({id: 3, type: 'u16', value: 1500}),
    Object.freeze({id: 4, type: 'u32', value: 200_000}),
    Object.freeze({id: 5, type: 'i16', value: -120}),
    Object.freeze({id: 6, type: 'i32', value: -50_000})
  ])
});

const EXPECTED_PREIMAGE_HEX =
  '526f746f724c656e732062696e64696e67207631000101000102030405060708'
  + '090a0b0c0d0e0f00112233445566778899aabbccddeeff001122330953544d33'
  + '32463758321b726f746f726c656e732d62696e64696e672d766563746f722d76'
  + '3102040006000101010100020201060003030205dc0004040400030d40000505'
  + '02ff8800060604ffff3cb0';
const EXPECTED_SHA256 =
  'fb7eef68a7f7b68917657726b37129bbdabc37088098eb1bf1cff6e1b63ae494';

function unsigned(value, maximum, width) {
  assert.equal(Number.isSafeInteger(value) && value >= 0 && value <= maximum, true);
  const bytes = Buffer.alloc(width);
  if (width === 1) bytes.writeUInt8(value);
  else if (width === 2) bytes.writeUInt16BE(value);
  else bytes.writeUInt32BE(value);
  return bytes;
}

function signed(value, minimum, maximum, width) {
  assert.equal(Number.isSafeInteger(value) && value >= minimum && value <= maximum, true);
  const bytes = Buffer.alloc(width);
  if (width === 2) bytes.writeInt16BE(value);
  else bytes.writeInt32BE(value);
  return bytes;
}

function scalar(row) {
  switch (row.type) {
    case 'bool':
      assert.equal(typeof row.value, 'boolean');
      return Buffer.from([row.value ? 1 : 0]);
    case 'u8': return unsigned(row.value, 0xff, 1);
    case 'u16': return unsigned(row.value, 0xffff, 2);
    case 'u32': return unsigned(row.value, 0xffffffff, 4);
    case 'i16': return signed(row.value, -0x8000, 0x7fff, 2);
    case 'i32': return signed(row.value, -0x80000000, 0x7fffffff, 4);
    default: throw new TypeError('unknown binding-vector scalar type');
  }
}

function machineToken(value) {
  assert.match(value, MACHINE_TOKEN);
  const bytes = Buffer.from(value, 'ascii');
  return Buffer.concat([unsigned(bytes.length, 32, 1), bytes]);
}

function fixedHex(value, byteLength) {
  assert.match(value, /^[0-9a-f]+$/);
  const bytes = Buffer.from(value, 'hex');
  assert.equal(bytes.length, byteLength);
  return bytes;
}

function canonicalPreimage(vector) {
  assert.equal(DOMAIN.length, 20);
  assert.equal(vector.rows.length > 0 && vector.rows.length <= MAXIMUM_ROWS, true);
  assert.equal(Number.isInteger(vector.activePidProfile), true);
  assert.equal(Number.isInteger(vector.activeRateProfile), true);

  const chunks = [
    DOMAIN,
    unsigned(PROTOCOL_VERSION, 0xffff, 2),
    unsigned(HASH_ALGORITHM_ID, 0xff, 1),
    fixedHex(vector.nonce, 16),
    fixedHex(vector.firmwareCommit, 20),
    machineToken(vector.target),
    machineToken(vector.manifest),
    unsigned(vector.activePidProfile, 0xff, 1),
    unsigned(vector.activeRateProfile, 0xff, 1),
    unsigned(vector.rows.length, MAXIMUM_ROWS, 2)
  ];

  let previousId = 0;
  for (const row of vector.rows) {
    assert.equal(Number.isInteger(row.id) && row.id > previousId && row.id <= 0xffff, true);
    assert.equal(Object.hasOwn(TYPE, row.type), true);
    const value = scalar(row);
    assert.equal(value.length, WIDTH[row.type]);
    chunks.push(
      unsigned(row.id, 0xffff, 2),
      unsigned(TYPE[row.type], 0xff, 1),
      unsigned(value.length, 0xff, 1),
      value
    );
    previousId = row.id;
  }
  return Buffer.concat(chunks);
}

test('the draft binding commitment vector is independently reconstructed', () => {
  const preimage = canonicalPreimage(VECTOR);
  assert.equal(preimage.toString('hex'), EXPECTED_PREIMAGE_HEX);
  assert.equal(createHash('sha256').update(preimage).digest('hex'), EXPECTED_SHA256);
  assert.equal(sha256Hex(preimage), EXPECTED_SHA256);

  const changed = {
    ...VECTOR,
    rows: VECTOR.rows.map(row => row.id === 4
      ? {...row, value: row.value + 1}
      : row)
  };
  assert.notEqual(
    createHash('sha256').update(canonicalPreimage(changed)).digest('hex'),
    EXPECTED_SHA256
  );
  assert.throws(() => canonicalPreimage({
    ...VECTOR,
    rows: [VECTOR.rows[1], VECTOR.rows[0], ...VECTOR.rows.slice(2)]
  }));
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
    else if (/\.(?:mjs|cjs|mts|cts|js|jsx|ts|tsx|c|h|cc|hh|cpp|cxx|hpp|hxx|inc|s|asm|html?|vue|svelte|java|kt|kts|gradle|json|xml|properties|css|sh|ps1|bat|cmd|patch|diff)$/i.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

function isInside(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

test('Phase 2E is a protocol-only stop with no production identifier or caller', () => {
  const protocolPath = path.join(ROOT, 'docs', 'CONFIG_FLIGHT_BINDING_PROTOCOL.md');
  const designPath = path.join(ROOT, 'docs', 'SHARED_CORPUS_DESIGN.md');
  const protocol = readFileSync(protocolPath, 'utf8');
  const design = readFileSync(designPath, 'utf8');

  assert.match(protocol, /protocol-only stop; not implemented/i);
  assert.match(protocol, /reviewed Rotorflight firmware commit/i);
  assert.match(protocol, /independently captured real log/i);
  assert.match(protocol, /consistency evidence, not attestation/i);
  assert.match(protocol, /anti-poisoning/i);
  assert.match(protocol, /all six are permanently unbound/i);
  assert.match(protocol, /rl_binding_commitment_0/);
  assert.match(protocol, /rl_binding_commitment_1/);
  assert.match(protocol, /firmware-derived values/i);
  assert.match(protocol, /stable snapshot/i);
  assert.match(protocol, /must not rescan rows or rebuild\/hash/i);
  assert.match(protocol, /76 consecutive encoded\s+bytes/i);
  assert.match(protocol, /resumable terminal-write state/i);
  assert.match(protocol, /logical\s+terminal boundary/i);
  assert.match(protocol, /Body logging may never resume/i);
  assert.match(design, /CONFIG_FLIGHT_BINDING_PROTOCOL\.md/);
  assert.match(design, /Phase 2E/i);

  const vectorSection = protocol.split('## 9. Independent canonical vector')[1]
    ?.split('## 10. Stop condition and non-goals')[0];
  assert.equal(typeof vectorSection, 'string');
  const semanticBlock = vectorSection.match(/```text\r?\n([\s\S]*?)\r?\n```/)?.[1];
  const semanticLines = semanticBlock?.split(/\r?\n/)
    .map(line => line.trim().replace(/\s+/g, ' '));
  assert.deepEqual(semanticLines, [
    `protocolVersion = ${PROTOCOL_VERSION}`,
    `hashAlgorithmId = ${HASH_ALGORITHM_ID} (SHA-256)`,
    `nonce = ${VECTOR.nonce}`,
    `firmwareCommit = ${VECTOR.firmwareCommit}`,
    `target = ${VECTOR.target}`,
    `manifest = ${VECTOR.manifest}`,
    `activePidProfile = ${VECTOR.activePidProfile}`,
    `activeRateProfile = ${VECTOR.activeRateProfile}`,
    'rows =',
    ...VECTOR.rows.map(row => (
      `${String(row.id).padStart(4, '0')} ${row.type} ${String(row.value)}`
    ))
  ]);
  const documentedBlocks = [...vectorSection.matchAll(/```text\r?\n([0-9a-f\r\n]+)```/g)]
    .map(match => match[1].replace(/\s/g, ''));
  assert.deepEqual(documentedBlocks, [EXPECTED_PREIMAGE_HEX, EXPECTED_SHA256]);

  const releases = Object.values(COMMUNITY_BLACKBOX_CONFIG_MANIFESTS)
    .flatMap(manifest => manifest.sourceReleases)
    .map(release => `${release.version}:${release.commit}`);
  assert.deepEqual(releases, [
    '4.3.0:05570fec69fd566e713f11e84adc7b77a8d68abf',
    '4.4.0:5fc142adfdc4031877061433c5052e473b9cdfd2',
    '4.4.1:456633bcea79933142c7fee17922ab306028bcf9',
    '4.5.0:e77d192c43c4b36ef4d18b67d24859ddc0968755',
    '4.5.1:e69823a3c185cbf1b75fd2701e938e978591a36b',
    '4.6.0:118e9120260bb33f46df4f92052fb0e9fd4e9ebc'
  ]);

  const productionCandidates = [
    ...sourceFiles(path.join(ROOT, 'config')),
    ...sourceFiles(path.join(ROOT, 'dist')),
    ...sourceFiles(path.join(ROOT, 'src')),
    ...sourceFiles(path.join(ROOT, 'ui')),
    ...sourceFiles(path.join(ROOT, 'android')),
    ...sourceFiles(path.join(ROOT, 'tools')),
    ...sourceFiles(path.join(ROOT, 'bin')),
    path.join(ROOT, 'package.json')
  ];
  const integrationCandidates = sourceFiles(path.join(ROOT, 'integration'))
    .filter(candidate => !isInside(FIRMWARE_BINDING_ARTIFACT_ROOT, candidate));
  const candidates = [...productionCandidates, ...integrationCandidates];
  for (const candidate of candidates) {
    const source = readFileSync(candidate, 'utf8');
    assert.doesNotMatch(source, /rl_binding_/i, candidate);
    assert.doesNotMatch(source, /RotorLens binding v1/, candidate);
    assert.doesNotMatch(source, /CONFIG_FLIGHT_BINDING_PROTOCOL/, candidate);
  }
  for (const candidate of productionCandidates) {
    const source = readFileSync(candidate, 'utf8');
    assert.doesNotMatch(
      source,
      /integration[\\/]+rotorflight-firmware/i,
      `${candidate} must not load the non-shipping firmware artifact subtree`
    );
  }
});
