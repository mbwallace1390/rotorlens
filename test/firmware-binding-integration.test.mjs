import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync
} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INTEGRATION_ROOT = path.join(ROOT, 'integration', 'rotorflight-firmware');
const ARTIFACT_ROOT = path.join(INTEGRATION_ROOT, 'binding-v1');
const MANIFEST_PATH = path.join(ARTIFACT_ROOT, 'artifact-manifest.json');
const SCHEMA_PATH = path.join(ARTIFACT_ROOT, 'artifact-manifest.schema.json');

const EXPECTED_FILES = Object.freeze([
  'README.md',
  'binding-v1/LICENSES/GPL-3.0.txt',
  'binding-v1/LICENSING.md',
  'binding-v1/README.md',
  'binding-v1/artifact-manifest.json',
  'binding-v1/artifact-manifest.schema.json',
  'binding-v1/patches/rotorflight-4.6.0-binding-v1-partial.patch'
]);

const PATCH_FILES = Object.freeze([
  Object.freeze({
    path: 'src/main/common/sha256.c',
    baseBlob: null,
    resultBlob: 'ac0299274879ee74ffaa6acaaf6b7537588a4ee5'
  }),
  Object.freeze({
    path: 'src/main/common/sha256.h',
    baseBlob: null,
    resultBlob: 'd1da8af90cceface9c1ad581e87acc9d0dacc58f'
  }),
  Object.freeze({
    path: 'src/main/config/rotorlens_binding_manifest.c',
    baseBlob: null,
    resultBlob: 'fe438684e5dd1698f91baa4958a8ce345478d869'
  }),
  Object.freeze({
    path: 'src/main/config/rotorlens_binding_manifest.h',
    baseBlob: null,
    resultBlob: 'fc657d27052de149a97f49b13193641e5af7a320'
  }),
  Object.freeze({
    path: 'src/main/config/rotorlens_config_mutation_epoch.c',
    baseBlob: null,
    resultBlob: 'edbeff8a1c76196521d269e37523a0257c262a49'
  }),
  Object.freeze({
    path: 'src/main/config/rotorlens_config_mutation_epoch.h',
    baseBlob: null,
    resultBlob: '3a17a517c30cce54362eb233064112574a6a9390'
  }),
  Object.freeze({
    path: 'src/test/Makefile',
    baseBlob: 'bf02df27aece87a8d2782d5cb3bff2eddceb4ed9',
    resultBlob: '9cd87bb4a6be3726e6d8086b8a04a505b47e8a8a'
  }),
  Object.freeze({
    path: 'src/test/unit/rotorlens_binding_manifest_unittest.cc',
    baseBlob: null,
    resultBlob: '629be440b438107c59db57269a530e9d37e15db7'
  }),
  Object.freeze({
    path: 'src/test/unit/rotorlens_config_mutation_epoch_unittest.cc',
    baseBlob: null,
    resultBlob: 'a95bac4258511709f9a71703f9dc4e711a514677'
  }),
  Object.freeze({
    path: 'src/test/unit/sha256_unittest.cc',
    baseBlob: null,
    resultBlob: '29a13f2f7911d06aebbe0034fb98504f3a77740c'
  })
]);

const HOST_TEST_TARGETS = Object.freeze([
  'test_sha256_unittest',
  'test_rotorlens_binding_manifest_unittest',
  'test_rotorlens_config_mutation_epoch_unittest'
]);

const ACCEPTANCE_BLOCKERS = Object.freeze([
  'no-public-full-implementation-commit',
  'no-full-preimage-or-commitment',
  'no-live-capture-or-snapshot-stability-proof',
  'no-scoped-writer-hooks-or-pending-token',
  'no-start-headers',
  'no-terminal-atomic-seal',
  'no-target-build-or-resource-bounds',
  'no-independent-wire-captures'
]);

const EXPECTED_MANIFEST = Object.freeze({
  $schema: './artifact-manifest.schema.json',
  schemaVersion: 4,
  kind: 'rotorlens-rotorflight-firmware-binding-artifact',
  protocolVersion: 1,
  status: 'partial-candidate',
  firmwareRepository: 'https://github.com/rotorflight/rotorflight-firmware',
  gitObjectFormat: 'sha1',
  firmwarePatchLicense: 'GPL-3.0-or-later',
  license: {
    basis: 'source-file-headers',
    upstreamDeclaredSpdx: null,
    path: 'LICENSES/GPL-3.0.txt',
    upstreamBlob: 'f288702d2fa16d3cdf0035b15a9fcbc552cd88e7',
    sha256: '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986',
    byteLength: 35_149
  },
  baseCommit: '118e9120260bb33f46df4f92052fb0e9fd4e9ebc',
  baseTree: '7821f5ac9c18da9fb31844b3a9be4b1a77caac11',
  implementationCommit: null,
  resultTree: '635c01e76fad457114bfbc8a11a7a42e2e115518',
  patch: {
    path: 'patches/rotorflight-4.6.0-binding-v1-partial.patch',
    format: 'git-diff-full-index-binary',
    sha256: '0bcb2f89bc9b6af3b2953952a3e015954511c71a8c718fd0b022cde47594cb6f',
    byteLength: 89_537,
    files: PATCH_FILES
  },
  targets: [],
  toolchain: {
    firmwareTarget: null,
    hostConformance: {
      runner: 'ubuntu-24.04',
      cc: 'clang-18',
      cxx: 'clang++-18',
      ldflagsOverride: '',
      makeTargets: HOST_TEST_TARGETS
    }
  },
  manifestIds: {
    candidate: ['rotorlens-rf460-config-r1'],
    runtimeAccepted: []
  },
  candidateEncoding: {
    scope: 'row-tlv-only',
    rowCount: 90,
    firstFieldId: 1,
    lastFieldId: 90,
    valueBytes: 103,
    rowTlvBytes: 463,
    maxWriterChunkBytes: 6,
    fullPreimage: false,
    semanticValidation: {
      scope: 'caller-provided-immutable-value-buffer',
      registeredScalarDomains: true,
      crossFieldRules: [
        'rates-type-limits-roll-pitch-yaw',
        'governor-mode-throttle-type',
        'governor-idle-auto-handover-order',
        'governor-mode-flag-allowlist',
        'governor-active-throttle-order',
        'mixer-collective-min-max-order'
      ],
      normalizesValues: false,
      rejectsBeforeWriter: true,
      provesLiveOrigin: false,
      provesStableCapture: false
    },
    liveFirmwareRead: false
  },
  candidateMutationEpoch: {
    scope: 'isolated-task-context-primitive',
    generationBits: 32,
    nestingDepthBits: 16,
    stableParity: 'even',
    mutationParity: 'odd',
    faultSentinel: 4_294_967_295,
    wrapPolicy: 'latch-fault-sentinel-before-wrap',
    nestedTransitions: 'outermost-only',
    failClosedOn: [
      'generation-exhaustion',
      'depth-overflow',
      'unmatched-end',
      'impossible-state-shape',
      'interrupt-context-call'
    ],
    faultPersistence: 'sticky-source-state-with-modeled-nmi-stale-write-defense',
    productionCallers: [],
    writerHookCoverage: [],
    captureIntegration: false,
    provesStableCapture: false
  },
  acceptanceBlockers: ACCEPTANCE_BLOCKERS,
  evidence: {
    sourceConformance: {
      status: 'partial-host-only',
      covers: [
        'sha256-known-vectors',
        'immutable-90-row-registry',
        'row-tlv-independent-vector',
        'structural-rejection-before-write',
        'registered-90-row-domain-mapping',
        'scalar-domain-class-boundaries',
        'rate-type-cyclic-axis-cross-field-validation',
        'governor-cross-field-allowlist',
        'signed-mixer-domain-and-order-validation',
        'semantic-rejection-before-write',
        'input-buffer-nonmutation',
        'partial-writer-failure',
        'isolated-nested-task-context-epoch',
        'epoch-no-op-generation-advance-and-saturation',
        'epoch-fail-closed-depth-generation-and-api-boundaries',
        'host-mode-primask-ipsr-and-publication-model',
        'modeled-nmi-stale-write-fault-persistence'
      ],
      hostTestTargets: HOST_TEST_TARGETS
    },
    resourceBounds: null,
    terminalAtomicity: null,
    wireCaptures: []
  },
  runtimeAcceptance: false
});

function filesBelow(directory, prefix = '') {
  const found = [];
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const full = path.join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `${relative} must not escape the evidence root`);
    if (entry.isDirectory()) found.push(...filesBelow(full, relative));
    else if (entry.isFile()) found.push(relative);
    else assert.fail(`${relative} must be a regular file or directory`);
  }
  return found.sort();
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('Phase 2H-A firmware integration is a pinned partial non-shipping candidate', () => {
  assert.equal(lstatSync(INTEGRATION_ROOT).isDirectory(), true);
  assert.equal(lstatSync(ARTIFACT_ROOT).isDirectory(), true);
  assert.deepEqual(filesBelow(INTEGRATION_ROOT), [...EXPECTED_FILES]);

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  assert.deepEqual(manifest, EXPECTED_MANIFEST);

  const patchPath = path.join(ARTIFACT_ROOT, manifest.patch.path);
  const patchBytes = readFileSync(patchPath);
  assert.equal(lstatSync(patchPath).isFile(), true);
  assert.equal(patchBytes.length, manifest.patch.byteLength);
  assert.equal(sha256(patchBytes), manifest.patch.sha256);

  const licensePath = path.join(ARTIFACT_ROOT, manifest.license.path);
  const licenseBytes = readFileSync(licensePath);
  assert.equal(lstatSync(licensePath).isFile(), true);
  assert.equal(licenseBytes.length, manifest.license.byteLength);
  assert.equal(sha256(licenseBytes), manifest.license.sha256);

  const patchSource = patchBytes.toString('utf8');
  const diffPaths = [...patchSource.matchAll(
    /^diff --git a\/(.+) b\/(.+)\r?$/gm
  )].map(match => {
    assert.equal(match[1], match[2], `patch path pair differs: ${match[0]}`);
    return match[1];
  });
  assert.deepEqual(diffPaths, PATCH_FILES.map(file => file.path));

  const indexPairs = [...patchSource.matchAll(
    /^index ([0-9a-f]{40})\.\.([0-9a-f]{40})(?: 100644)?\r?$/gm
  )].map(match => ({base: match[1], result: match[2]}));
  assert.deepEqual(indexPairs, PATCH_FILES.map(file => ({
    base: file.baseBlob ?? '0'.repeat(40),
    result: file.resultBlob
  })));

  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), Object.keys(manifest).sort());
  assert.equal(schema.properties.schemaVersion.const, 4);
  assert.equal(schema.properties.status.const, 'partial-candidate');
  assert.equal(schema.properties.implementationCommit.type, 'null');
  assert.equal(schema.properties.resultTree.const, manifest.resultTree);
  assert.equal(schema.properties.patch.properties.sha256.const, manifest.patch.sha256);
  assert.equal(schema.properties.patch.properties.byteLength.const, manifest.patch.byteLength);
  assert.deepEqual(schema.properties.patch.properties.files.const, PATCH_FILES);
  assert.equal(schema.properties.targets.type, 'array');
  assert.equal(schema.properties.targets.maxItems, 0);
  assert.equal(schema.properties.toolchain.properties.firmwareTarget.type, 'null');
  assert.equal(schema.properties.manifestIds.type, 'object');
  assert.equal(schema.properties.manifestIds.additionalProperties, false);
  assert.deepEqual(
    [...schema.properties.manifestIds.required].sort(),
    Object.keys(EXPECTED_MANIFEST.manifestIds).sort()
  );
  assert.equal(
    schema.properties.manifestIds.properties.runtimeAccepted.type,
    'array'
  );
  assert.equal(schema.properties.manifestIds.properties.runtimeAccepted.maxItems, 0);
  const candidateSchema = schema.properties.candidateEncoding;
  assert.equal(candidateSchema.type, 'object');
  assert.equal(candidateSchema.additionalProperties, false);
  assert.deepEqual(
    [...candidateSchema.required].sort(),
    Object.keys(EXPECTED_MANIFEST.candidateEncoding).sort()
  );
  const semanticSchema = candidateSchema.properties.semanticValidation;
  assert.equal(semanticSchema.type, 'object');
  assert.equal(semanticSchema.additionalProperties, false);
  assert.deepEqual(
    [...semanticSchema.required].sort(),
    Object.keys(EXPECTED_MANIFEST.candidateEncoding.semanticValidation).sort()
  );
  assert.equal(
    semanticSchema.properties.scope.const,
    'caller-provided-immutable-value-buffer'
  );
  assert.deepEqual(
    semanticSchema.properties.crossFieldRules.const,
    EXPECTED_MANIFEST.candidateEncoding.semanticValidation.crossFieldRules
  );
  assert.equal(semanticSchema.properties.registeredScalarDomains.const, true);
  assert.equal(semanticSchema.properties.normalizesValues.const, false);
  assert.equal(semanticSchema.properties.rejectsBeforeWriter.const, true);
  assert.equal(semanticSchema.properties.provesLiveOrigin.const, false);
  assert.equal(semanticSchema.properties.provesStableCapture.const, false);
  assert.equal(
    schema.properties.candidateEncoding.properties.fullPreimage.const,
    false
  );
  assert.equal(
    schema.properties.candidateEncoding.properties.liveFirmwareRead.const,
    false
  );
  const epochSchema = schema.properties.candidateMutationEpoch;
  assert.equal(epochSchema.type, 'object');
  assert.equal(epochSchema.additionalProperties, false);
  assert.deepEqual(
    [...epochSchema.required].sort(),
    Object.keys(EXPECTED_MANIFEST.candidateMutationEpoch).sort()
  );
  assert.equal(epochSchema.properties.scope.const, 'isolated-task-context-primitive');
  assert.equal(epochSchema.properties.generationBits.const, 32);
  assert.equal(epochSchema.properties.nestingDepthBits.const, 16);
  assert.equal(epochSchema.properties.stableParity.const, 'even');
  assert.equal(epochSchema.properties.mutationParity.const, 'odd');
  assert.equal(epochSchema.properties.faultSentinel.const, 4_294_967_295);
  assert.equal(
    epochSchema.properties.wrapPolicy.const,
    'latch-fault-sentinel-before-wrap'
  );
  assert.equal(epochSchema.properties.nestedTransitions.const, 'outermost-only');
  assert.deepEqual(
    epochSchema.properties.failClosedOn.const,
    EXPECTED_MANIFEST.candidateMutationEpoch.failClosedOn
  );
  assert.equal(
    epochSchema.properties.faultPersistence.const,
    'sticky-source-state-with-modeled-nmi-stale-write-defense'
  );
  assert.equal(epochSchema.properties.productionCallers.type, 'array');
  assert.equal(epochSchema.properties.productionCallers.maxItems, 0);
  assert.equal(epochSchema.properties.writerHookCoverage.type, 'array');
  assert.equal(epochSchema.properties.writerHookCoverage.maxItems, 0);
  assert.equal(epochSchema.properties.captureIntegration.const, false);
  assert.equal(epochSchema.properties.provesStableCapture.const, false);
  assert.deepEqual(
    schema.properties.toolchain.properties.hostConformance
      .properties.makeTargets.const,
    HOST_TEST_TARGETS
  );
  assert.deepEqual(schema.properties.acceptanceBlockers.const, ACCEPTANCE_BLOCKERS);
  const evidenceSchema = schema.properties.evidence;
  assert.equal(evidenceSchema.type, 'object');
  assert.equal(evidenceSchema.additionalProperties, false);
  assert.deepEqual(
    [...evidenceSchema.required].sort(),
    Object.keys(EXPECTED_MANIFEST.evidence).sort()
  );
  const sourceSchema = evidenceSchema.properties.sourceConformance.properties;
  assert.equal(sourceSchema.status.const, 'partial-host-only');
  assert.deepEqual(
    sourceSchema.covers.const,
    EXPECTED_MANIFEST.evidence.sourceConformance.covers
  );
  assert.deepEqual(sourceSchema.hostTestTargets.const, HOST_TEST_TARGETS);
  assert.equal(evidenceSchema.properties.resourceBounds.type, 'null');
  assert.equal(evidenceSchema.properties.terminalAtomicity.type, 'null');
  assert.equal(evidenceSchema.properties.wireCaptures.type, 'array');
  assert.equal(evidenceSchema.properties.wireCaptures.maxItems, 0);
  assert.equal(schema.properties.runtimeAcceptance.const, false);

  const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const ciJob = ci.match(
    /^  firmware-binding-candidate:\r?\n[\s\S]*?(?=^  android:\r?$)/m
  )?.[0];
  assert.equal(typeof ciJob, 'string');
  assert.match(ciJob, /runs-on: ubuntu-24\.04/);
  assert.match(ciJob, /ref: 118e9120260bb33f46df4f92052fb0e9fd4e9ebc/);
  assert.match(ciJob, /PATCH_SHA256: 0bcb2f89bc9b6af3b2953952a3e015954511c71a8c718fd0b022cde47594cb6f/);
  assert.match(ciJob, /RESULT_TREE: 635c01e76fad457114bfbc8a11a7a42e2e115518/);
  assert.match(ciJob, /node --test test\/firmware-binding-integration\.test\.mjs test\/community-config-binding-protocol\.test\.mjs/);
  assert.match(ciJob, /assert\.equal\(manifest\.runtimeAcceptance, false\)/);
  assert.match(ciJob, /assert\.equal\(manifest\.candidateEncoding\.fullPreimage, false\)/);
  assert.match(ciJob, /assert\.equal\(manifest\.candidateEncoding\.liveFirmwareRead, false\)/);
  assert.match(ciJob, /assert\.equal\(semanticValidation\.provesLiveOrigin, false\)/);
  assert.match(ciJob, /assert\.equal\(semanticValidation\.provesStableCapture, false\)/);
  assert.match(ciJob, /assert\.deepEqual\(mutationEpoch\.productionCallers, \[\]\)/);
  assert.match(ciJob, /assert\.deepEqual\(mutationEpoch\.writerHookCoverage, \[\]\)/);
  assert.match(ciJob, /assert\.equal\(mutationEpoch\.captureIntegration, false\)/);
  assert.match(ciJob, /assert\.equal\(mutationEpoch\.provesStableCapture, false\)/);
  assert.match(ciJob, /CC=clang-18 CXX=clang\+\+-18 LDFLAGS= V=1/);
  assert.match(ciJob, /test_sha256_unittest/);
  assert.match(ciJob, /test_rotorlens_binding_manifest_unittest/);
  assert.match(ciJob, /test_rotorlens_config_mutation_epoch_unittest/);
  assert.match(ciJob, /git -C upstream-firmware grep -l/);
  assert.match(ciJob, /rotorlensConfigMutationEpoch/);
  assert.doesNotMatch(ciJob, /\b(?:apt|apt-get|sudo)\b/);
  assert.doesNotMatch(ciJob, /arm_sdk_install|upload-artifact|assembleDebug|bundleRelease/);

  const gradle = readFileSync(path.join(ROOT, 'android', 'app', 'build.gradle.kts'), 'utf8');
  assert.match(gradle, /from\(File\(repositoryRoot, "ui"\)\)/);
  assert.match(gradle, /from\(File\(repositoryRoot, "src"\)\)/);
  assert.doesNotMatch(gradle, /from\s*\(\s*repositoryRoot\s*\)/);
  assert.doesNotMatch(gradle, /integration[\\/]+rotorflight-firmware/i);

  const notices = readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  const provenance = readFileSync(
    path.join(ROOT, 'docs', 'ARCHITECTURE_AND_PROVENANCE.md'),
    'utf8'
  );
  assert.match(notices, /partial Rotorflight firmware source patch/i);
  assert.match(notices, /isolated task-context mutation-epoch primitive/i);
  assert.match(
    notices,
    /zero production callers,\s+scoped writer hooks, or capture consumers/i
  );
  assert.match(notices, /runtimeAcceptance` is fixed false/i);
  assert.match(
    notices,
    /The two reserved non-shipping Rotorflight integration-review artifacts[\s\S]*separately\s+GPL-covered and are not part of the app/i
  );
  assert.match(
    notices,
    /Apart from those reserved GPL artifacts, the committed materials not authored[\s\S]*build tooling, governance documents, and license text/i
  );
  assert.match(provenance, /no clean public implementation commit/i);
  assert.match(provenance, /generation zero proves nothing/i);
  assert.match(provenance, /no positive runtime registry entry/i);
});
