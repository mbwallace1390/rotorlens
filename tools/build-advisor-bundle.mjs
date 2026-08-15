#!/usr/bin/env node

/**
 * Emits a browser-loadable UMD build of the PID evidence analysis.
 *
 * The analysis lives in RotorLens as MPL-2.0 code we own. The Rotorflight Blackbox
 * viewer fork is GPL-3.0 and needs the same logic as a plain script. Rather than
 * copying the file into that repository — where it would drift and where its
 * licensing would get muddled — this generates a build from the single source
 * and stamps its provenance into the header.
 *
 * Licensing note carried into the generated file: MPL-2.0 section 3.3 permits
 * the covered file to be additionally distributed under GPL-3.0 when it is part
 * of that Larger Work. The original RotorLens source remains available under
 * MPL-2.0.
 *
 * The transform is deliberately tiny — strip `export` from top-level
 * declarations and return them from a factory — because a transform nobody can
 * audit is a transform that silently changes behavior. `test/advisor-bundle.test.mjs`
 * loads the generated bundle and asserts it behaves identically to the module.
 */

import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(projectRoot, 'src', 'analysis', 'pid-evidence.mjs');
const outputPath = path.join(projectRoot, 'dist', 'rotorlens-pid-evidence.js');

export const GLOBAL_NAME = 'RotorLensPidEvidence';

const EXPORT_DECLARATION = /^export\s+(const|let|function|class)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * Converts the ES module source into a UMD factory body.
 *
 * Throws rather than guessing if the source grows a construct the transform does
 * not handle — a bundle that silently dropped an export would fail far from here.
 */
export function transformToUmd(source, globalName = GLOBAL_NAME) {
  if (/^\s*import\s/m.test(source)) {
    throw new Error('Bundled source must stay dependency-free: found an import statement');
  }
  if (/^export\s+default/m.test(source)) {
    throw new Error('Bundled source must not use a default export');
  }
  if (/^export\s*\{/m.test(source)) {
    throw new Error('Bundled source must not use an export list; export declarations directly');
  }

  const exported = [];
  for (const match of source.matchAll(EXPORT_DECLARATION)) {
    exported.push(match[2]);
  }
  if (exported.length === 0) {
    throw new Error('Bundled source exports nothing');
  }

  const body = source.replace(/^export\s+(?=(const|let|function|class)\s)/gm, '');
  const returned = exported.map(name => `    ${name}: ${name}`).join(',\n');

  return `/**
 * ${globalName} — generated build. Do not edit.
 *
 * Source:    src/analysis/pid-evidence.mjs (RotorLens)
 * Generated: tools/build-advisor-bundle.mjs
 * License:   MPL-2.0
 * Copyright: Copyright (c) 2026 Michael Wallace
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/.
 *
 * MPL-2.0 Section 3.3 permits this covered file to be additionally distributed
 * under GPL-3.0 as part of that Larger Work. The RotorLens source remains
 * available under MPL-2.0. Edit the source and regenerate; edits here are lost.
 */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module && module.exports) {
    module.exports = factory();
  } else {
    root.${globalName} = factory();
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

${body.split('\n').map(line => (line.trim() === '' ? '' : `  ${line}`)).join('\n')}

  return {
${returned}
  };
}));
`;
}

/**
 * The bundle the current source would produce, without touching the disk.
 *
 * Separated from the write so a test can compare the committed artifact against
 * what the source says it should be. A test that rebuilds before checking is a
 * test that repairs its own subject: it reports "up to date" for a bundle that
 * was stale until the moment it ran.
 */
export async function renderAdvisorBundle() {
  return transformToUmd(await readFile(sourcePath, 'utf8'));
}

export async function buildAdvisorBundle() {
  const bundle = await renderAdvisorBundle();

  await mkdir(path.dirname(outputPath), {recursive: true});
  await writeFile(outputPath, bundle);

  // This package is `"type": "module"`, which would make Node parse the bundle's
  // .js extension as ESM — it would load with no exports at all, silently. The
  // scope marker keeps dist/ CommonJS for Node; a browser script tag is
  // unaffected either way.
  await writeFile(
    path.join(path.dirname(outputPath), 'package.json'),
    `${JSON.stringify({type: 'commonjs'}, null, 2)}\n`
  );

  return {outputPath, byteLength: Buffer.byteLength(bundle)};
}

// process.argv[1] is a Windows path (C:...) while import.meta.url is a file:// URL,
// so comparing them as strings made every one of these CLIs a silent no-op on
// Windows: `npm run fixtures:generate` printed nothing and wrote nothing.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildAdvisorBundle();
  process.stdout.write(
    `Wrote ${path.relative(projectRoot, result.outputPath)} (${result.byteLength} bytes)\n`
  );
}
