import assert from 'node:assert/strict';
import {access, readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  COMMUNITY_DEMO_PROJECT_ID,
  COMMUNITY_FIRESTORE_EMULATOR_HOST,
  isExactCommunityEmulatorRuntime
} from '../functions/src/backend.mjs';

const firebaseRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(firebaseRoot, '..', '..');
const read = relative => readFile(path.join(firebaseRoot, relative), 'utf8');

test('the emulator boundary is pinned to a non-production demo project', async () => {
  const manifest = JSON.parse(await read('package.json'));
  const config = JSON.parse(await read('firebase.json'));
  const runner = await read('scripts/run-emulator-tests.mjs');
  assert.equal(manifest.private, true);
  assert.equal(manifest.scripts['test:emulator'], 'node scripts/run-emulator-tests.mjs');
  assert.match(runner, /'demo-rotorlens'/);
  assert.match(runner, /'firestore,functions'/);
  assert.match(runner, /FUNCTIONS_DISCOVERY_TIMEOUT:\s*'30'/);
  assert.ok(!Object.values(manifest.scripts).some(script => /\bdeploy\b/.test(script)));
  assert.equal(config.emulators.ui.enabled, false);
  assert.equal(config.emulators.singleProjectMode, true);
  await assert.rejects(access(path.join(firebaseRoot, '.firebaserc')));
});

test('Firestore denies every direct client operation', async () => {
  const rules = await read('firestore.rules');
  assert.match(rules, /match \/\{document=\*\*\}/);
  assert.match(rules, /allow read, write: if false;/);
  assert.doesNotMatch(rules, /if\s+true|request\.auth/);
});

test('callables are App Check gated and bounded without logging payloads', async () => {
  const source = await read('functions/src/index.mjs');
  assert.match(source, /enforceAppCheck:\s*true/g);
  assert.match(source, /consumeAppCheckToken:\s*true/);
  assert.match(source, /alreadyConsumed === true/);
  assert.match(source, /initializeApp\(\{projectId: COMMUNITY_DEMO_PROJECT_ID\}\)/);
  assert.match(source, /isExactCommunityEmulatorRuntime\(process\.env, app\.options\.projectId\)/);
  assert.match(source, /BACKEND_NOT_ACTIVATED/);
  assert.match(source, /minInstances:\s*0/g);
  assert.match(source, /maxInstances:\s*[23]/g);
  assert.match(source, /cors:\s*false/g);
  assert.doesNotMatch(source, /console\.|logger\.|request\.rawRequest|request\.auth/);
});

test('the runtime latch requires the exact demo project and Firestore emulator', () => {
  const validEnvironment = {
    FUNCTIONS_EMULATOR: 'true',
    FIRESTORE_EMULATOR_HOST: COMMUNITY_FIRESTORE_EMULATOR_HOST,
    GCLOUD_PROJECT: COMMUNITY_DEMO_PROJECT_ID
  };
  assert.equal(
    isExactCommunityEmulatorRuntime(validEnvironment, COMMUNITY_DEMO_PROJECT_ID),
    true
  );
  for (const [environment, projectId] of [
    [{...validEnvironment, FUNCTIONS_EMULATOR: 'false'}, COMMUNITY_DEMO_PROJECT_ID],
    [{...validEnvironment, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8081'}, COMMUNITY_DEMO_PROJECT_ID],
    [{...validEnvironment, GCLOUD_PROJECT: 'real-project'}, COMMUNITY_DEMO_PROJECT_ID],
    [{...validEnvironment, GOOGLE_CLOUD_PROJECT: 'real-project'}, COMMUNITY_DEMO_PROJECT_ID],
    [{...validEnvironment}, 'real-project'],
    [{FUNCTIONS_EMULATOR: 'true'}, COMMUNITY_DEMO_PROJECT_ID],
    [null, COMMUNITY_DEMO_PROJECT_ID]
  ]) {
    assert.equal(isExactCommunityEmulatorRuntime(environment, projectId), false);
  }
});

test('Firebase dependencies stay outside the app and root package', async () => {
  const rootManifest = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8')
  );
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies'
  ]) {
    assert.deepEqual(rootManifest[field] ?? {}, {});
  }
  const functionsManifest = JSON.parse(await read('functions/package.json'));
  assert.deepEqual(functionsManifest.dependencies, {
    'firebase-admin': '14.2.0',
    'firebase-functions': '7.3.2'
  });
  const androidManifest = await readFile(
    path.join(projectRoot, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
    'utf8'
  );
  assert.doesNotMatch(androidManifest, /android\.permission\.INTERNET/);

  // Read the FILES, not the path strings. The original of this check asserted
  // that `path.join(projectRoot, 'src')` does not contain '/backend/firebase/'
  // — true for every input forever, so it could never fail; this repository's
  // own history is exactly that pattern. It now scans file contents itself
  // rather than deferring to test/firebase-backend-boundary.test.mjs, so
  // weakening the root test does not leave this one silently green.
  const forbidden =
    /firebase|firestore|httpsCallable|submitCommunityContribution|deleteCommunityContributions|getCommunityStats/i;
  const skipDirectories = new Set(['.firebase', '.git', '.gradle', 'build', 'node_modules']);
  for (const relative of [
    'src',
    'ui',
    'android/app/src/main',
    'ios/RotorLens',
    'tools',
    'bin'
  ]) {
    const pending = [path.join(projectRoot, relative)];
    while (pending.length > 0) {
      const current = pending.pop();
      for (const entry of await readdir(current, {withFileTypes: true})) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!skipDirectories.has(entry.name)) {
            pending.push(full);
          }
          continue;
        }
        if (!/\.(?:mjs|js|java|kt|kts|swift|html|json|xml|toml)$/i.test(entry.name)) {
          continue;
        }
        const source = await readFile(full, 'utf8');
        assert.doesNotMatch(source, forbidden,
          `${path.relative(projectRoot, full)} must not reference the emulator backend`);
      }
    }
  }
});

test('the current contract keeps production ingestion and learning closed', async () => {
  const source = await readFile(
    path.join(projectRoot, 'src', 'analysis', 'community-contract.mjs'),
    'utf8'
  );
  const backend = await read('functions/src/backend.mjs');
  const endpoints = await read('functions/src/index.mjs');
  assert.match(source, /SUPPORTED_COMMUNITY_CONSENT_VERSIONS = Object\.freeze\(\[\]\)/);
  assert.match(source, /SUPPORTED_COMMUNITY_LICENCE_VERSIONS = Object\.freeze\(\[\]\)/);
  assert.match(source, /COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_STATUS = 'incomplete'/);
  assert.match(backend, /PRODUCTION_INGESTION_CLOSED/);
  assert.match(endpoints, /rejectCommunitySubmission\(request\.data\)/);
  assert.doesNotMatch(backend, /quarantineCommunityContribution/);
  assert.match(backend, /learningStatus:\s*'closed-no-production-corpus'/);
  assert.doesNotMatch(backend, /collection\(['"]accepted|collection\(['"]models/);
});
