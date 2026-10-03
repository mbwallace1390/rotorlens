import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendRoot = path.join(projectRoot, 'backend', 'firebase');

async function filesBelow(root) {
  const result = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, {withFileTypes: true})) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if ([
          '.firebase',
          '.git',
          '.gradle',
          'build',
          'node_modules'
        ].includes(entry.name)) {
          continue;
        }
        pending.push(full);
      } else {
        result.push(full);
      }
    }
  }
  return result;
}

test('Firebase remains an emulator-only backend with no app caller', async () => {
  const packageManifest = JSON.parse(
    await readFile(path.join(backendRoot, 'package.json'), 'utf8')
  );
  const firebaseConfig = JSON.parse(
    await readFile(path.join(backendRoot, 'firebase.json'), 'utf8')
  );
  const runner = await readFile(
    path.join(backendRoot, 'scripts', 'run-emulator-tests.mjs'),
    'utf8'
  );
  const rules = await readFile(path.join(backendRoot, 'firestore.rules'), 'utf8');
  assert.equal(packageManifest.private, true);
  assert.match(packageManifest.scripts['test:emulator'], /run-emulator-tests\.mjs/);
  assert.equal(
    packageManifest.scripts['test:static'],
    'node --test emulator-tests/static-contract.mjs'
  );
  assert.match(runner, /'demo-rotorlens'/);
  assert.ok(!Object.values(packageManifest.scripts).some(script => /\bdeploy\b/.test(script)));
  assert.equal(firebaseConfig.emulators.ui.enabled, false);
  assert.match(rules, /allow read, write: if false;/);

  const productionRoots = [
    'src',
    'ui',
    'android',
    'ios/RotorLens',
    'tools',
    'bin'
  ];
  const forbidden = /firebase|submitCommunityContribution|deleteCommunityContributions|getCommunityStats|httpsCallable|firestore/i;
  for (const relative of productionRoots) {
    for (const file of await filesBelow(path.join(projectRoot, relative))) {
      if (!/\.(?:mjs|js|java|kt|kts|swift|html|json|xml|toml)$/i.test(file)) {
        continue;
      }
      const source = await readFile(file, 'utf8');
      assert.doesNotMatch(
        source,
        forbidden,
        `${path.relative(projectRoot, file)} must not call the emulator backend`
      );
    }
  }

  for (const relative of [
    'package.json',
    'package-lock.json',
    'ios/project.yml'
  ]) {
    const source = await readFile(path.join(projectRoot, relative), 'utf8');
    assert.doesNotMatch(source, forbidden, `${relative} must not add a Firebase client`);
  }

  const androidManifest = await readFile(
    path.join(projectRoot, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
    'utf8'
  );
  assert.doesNotMatch(androidManifest, /android\.permission\.INTERNET/);
});

test('the backend has no production project selection or deployment surface', async () => {
  const files = await filesBelow(backendRoot);
  const relative = files.map(file => path.relative(backendRoot, file).replaceAll('\\', '/'));
  assert.ok(!relative.includes('.firebaserc'));
  assert.ok(!relative.some(file => file.startsWith('test/')));
  assert.ok(!relative.some(file => /\.(?:spec|test)\.mjs$/.test(file)));
  for (const file of files) {
    if (path.basename(file).startsWith('package-lock')) {
      continue;
    }
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /firebase\s+deploy|projects:(?:create|addfirebase)|FIREBASE_TOKEN|GOOGLE_APPLICATION_CREDENTIALS/);
  }

  const repositoryFiles = await filesBelow(projectRoot);
  assert.ok(!repositoryFiles.some(file => path.basename(file) === '.firebaserc'));
  const rootManifest = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8')
  );
  for (const command of Object.values(rootManifest.scripts ?? {})) {
    assert.doesNotMatch(
      command,
      /firebase[^\r\n]*\bdeploy\b|gcloud[^\r\n]*\bdeploy\b/i
    );
  }
  const workflowFiles = repositoryFiles.filter(file =>
    path.relative(projectRoot, file).replaceAll('\\', '/').startsWith('.github/workflows/')
    && /\.ya?ml$/i.test(file));
  for (const file of workflowFiles) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(
      source,
      /firebase[^\r\n]*\bdeploy\b|gcloud[^\r\n]*\bdeploy\b|google-github-actions\/auth|id-token:\s*write|\bsecrets\.|npm\s+run\s+(?:deploy|publish|release)(?::[^\s]+)?(?:\s|$)|FIREBASE_TOKEN|GOOGLE_APPLICATION_CREDENTIALS/i
    );
  }
});

test('Firebase dependencies, notices and CI stay in their isolated boundaries', async () => {
  const emulatorManifest = JSON.parse(
    await readFile(path.join(backendRoot, 'package.json'), 'utf8')
  );
  const emulatorLock = JSON.parse(
    await readFile(path.join(backendRoot, 'package-lock.json'), 'utf8')
  );
  const functionsManifest = JSON.parse(
    await readFile(path.join(backendRoot, 'functions', 'package.json'), 'utf8')
  );
  const functionsLock = JSON.parse(
    await readFile(path.join(backendRoot, 'functions', 'package-lock.json'), 'utf8')
  );
  assert.deepEqual(emulatorLock.packages[''].devDependencies, emulatorManifest.devDependencies);
  assert.deepEqual(functionsLock.packages[''].dependencies, functionsManifest.dependencies);

  const notices = await readFile(path.join(projectRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  for (const [name, version] of [
    ...Object.entries(emulatorManifest.devDependencies),
    ...Object.entries(functionsManifest.dependencies)
  ]) {
    assert.match(notices, new RegExp(
      `${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*${version.replaceAll('.', '\\.')}`
    ));
  }

  // An `overrides` entry pins a package nothing here depends on directly, so no
  // other check notices when it stops taking effect: `packages['']` in the lock
  // does not record overrides, and a lock regenerated without them still
  // matches the top-level pins above. Each override must be the version the lock
  // resolves at EVERY location of that package, and must be named in the
  // notices at that version.
  for (const [manifest, lock, label] of [
    [emulatorManifest, emulatorLock, 'emulator'],
    [functionsManifest, functionsLock, 'Functions']
  ]) {
    for (const [name, version] of Object.entries(manifest.overrides ?? {})) {
      assert.equal(typeof version, 'string',
        `${label} override ${name} must be an exact version, not a nested override`);
      const resolved = Object.entries(lock.packages)
        .filter(([location]) => location === `node_modules/${name}`
          || location.endsWith(`/node_modules/${name}`))
        .map(([location, entry]) => `${location}@${entry.version}`);
      assert.ok(resolved.length > 0,
        `the ${label} override of ${name} matches nothing in its lockfile`);
      assert.deepEqual(
        resolved.filter(entry => !entry.endsWith(`@${version}`)),
        [],
        `the ${label} lockfile does not resolve ${name} to its override ${version}; `
        + 'regenerate that lockfile with npm after changing an override'
      );
      assert.match(notices, new RegExp(
        `${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*${version.replaceAll('.', '\\.')}`
      ), `THIRD_PARTY_NOTICES.md must name the ${label} override ${name} ${version}`);
    }
  }

  const workflow = await readFile(
    path.join(projectRoot, '.github', 'workflows', 'ci.yml'),
    'utf8'
  );
  assert.match(workflow, /firebase-emulator:\s+name: Firebase emulator backend/);
  assert.match(workflow, /npm ci --ignore-scripts --prefix backend\/firebase/);
  assert.match(workflow, /npm test --prefix backend\/firebase/);
  assert.doesNotMatch(
    workflow.match(/firebase-emulator:[\s\S]*?(?=\n  [a-z][a-z0-9-]+:|$)/)?.[0] ?? '',
    /firebase\s+deploy|upload-artifact|FIREBASE_TOKEN|GOOGLE_APPLICATION_CREDENTIALS/
  );

  const dependabot = await readFile(
    path.join(projectRoot, '.github', 'dependabot.yml'),
    'utf8'
  );
  assert.match(dependabot, /directory: \/backend\/firebase\b/);
  assert.match(dependabot, /directory: \/backend\/firebase\/functions\b/);
});
