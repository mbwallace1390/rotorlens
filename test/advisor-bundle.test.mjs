/**
 * The analysis bundle shipped to the GPL fork.
 *
 * Nothing here writes to `dist/`. It used to: every test called
 * buildAdvisorBundle() first, so the "committed bundle is up to date" check read
 * a file the tests immediately before it had just rewritten, and compared the
 * rebuild against itself. It could not fail. A stale bundle — the viewer running
 * analysis that no longer matched the module under test — was exactly what it
 * was written to catch, and it would have reported that as fine.
 *
 * So these tests load the committed artifact, the one that actually ships, and
 * compare it against what the source says it should be.
 */

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {renderAdvisorBundle, transformToUmd} from '../tools/build-advisor-bundle.mjs';
import * as moduleApi from '../src/analysis/pid-evidence.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = path.join(projectRoot, 'dist', 'rotorlens-pid-evidence.js');

function readCommittedBundle() {
  return readFile(bundlePath, 'utf8');
}

/**
 * Loads the committed bundle the way a consumer would, without requiring it off
 * disk through Node's module cache.
 */
function evaluateBundle(source) {
  const module = {exports: {}};
  new Function('module', 'exports', 'globalThis', source)(module, module.exports, {});
  return module.exports;
}

function stopEvent(commandSign, trackingRmsDps) {
  return {
    commandSign,
    commandAmplitudeDps: 120,
    trackingRmsDps,
    fastRingingRmsDps: 5,
    slowOscillationRmsDps: 2,
    headspeedRpm: 2000
  };
}

test('the committed bundle is what the current source produces', async () => {
  // The whole point of the file: if src/analysis/pid-evidence.mjs has moved on,
  // the fork is shipping different analysis from the one these tests cover.
  assert.equal(
    await readCommittedBundle(),
    await renderAdvisorBundle(),
    'dist/rotorlens-pid-evidence.js is stale; run `npm run build:advisor-bundle` and commit it'
  );
});

test('the committed bundle exposes exactly the module API', async () => {
  const bundle = evaluateBundle(await readCommittedBundle());

  assert.deepEqual(
    Object.keys(bundle).sort(),
    Object.keys(moduleApi).sort(),
    'a dropped export would fail silently in the viewer'
  );
});

test('the committed bundle produces identical results to the module', async () => {
  const bundle = evaluateBundle(await readCommittedBundle());
  const events = [
    stopEvent('positive', 10), stopEvent('positive', 12),
    stopEvent('negative', 30), stopEvent('negative', 34)
  ];

  assert.deepEqual(
    JSON.parse(JSON.stringify(bundle.buildDirectionalStopEvidence(events, {axis: 'yaw'}))),
    JSON.parse(JSON.stringify(moduleApi.buildDirectionalStopEvidence(events, {axis: 'yaw'})))
  );
});

test('the committed bundle carries its licence and provenance header', async () => {
  const bundle = await readCommittedBundle();

  assert.match(bundle, /src\/analysis\/pid-evidence\.mjs/);
  assert.match(bundle, /License:\s+MPL-2\.0/);
  assert.match(bundle, /Copyright \(c\) 2026 Michael Wallace/);
  assert.match(bundle, /Mozilla Public License/,
    'the generated source needs the MPL source-form notice in-file');
  assert.match(bundle, /Section 3\.3[\s\S]*GPL-3\.0/,
    'the GPL fork needs the MPL secondary-license basis in-file');
});

test('the committed bundle assigns a browser global when there is no module system', async () => {
  const source = await readCommittedBundle();
  const root = {};

  // Same shape as a <script> load: no module, no exports.
  new Function('globalThis', `return (function () { ${source} }).call(globalThis);`)(root);

  assert.ok(root.RotorLensPidEvidence, 'the viewer loads this with a script tag');
  assert.equal(typeof root.RotorLensPidEvidence.buildHoldEvidence, 'function');
});

test('dist/ is marked CommonJS so Node does not parse the bundle as ESM', async () => {
  // This package is "type": "module". Without the marker the .js bundle loads
  // with no exports at all, and silently.
  const marker = JSON.parse(
    await readFile(path.join(projectRoot, 'dist', 'package.json'), 'utf8')
  );

  assert.equal(marker.type, 'commonjs');
});

test('the transform refuses source it cannot faithfully convert', () => {
  assert.throws(
    () => transformToUmd('import x from "y";\nexport const a = 1;'),
    /dependency-free/
  );
  assert.throws(() => transformToUmd('export default function () {}'), /default export/);
  assert.throws(() => transformToUmd('const a = 1;\nexport {a};'), /export list/);
  assert.throws(() => transformToUmd('const a = 1;'), /exports nothing/);
});
