#!/usr/bin/env node

import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {inspectFixtureHeaders} from '../src/fixture-preflight.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(projectRoot, 'fixtures', 'synthetic');
const fixturePath = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.join(fixtureDir, 'rf43-single-session.TXT');

const [fixtureBytes, manifestBytes] = await Promise.all([
  readFile(fixturePath),
  readFile(path.join(fixtureDir, 'manifest.json'), 'utf8')
]);
const fixtureName = path.basename(fixturePath);
const report = inspectFixtureHeaders(fixtureBytes, fixtureName);

// Known fixtures must match their recorded identity; arbitrary user logs are
// inspected as-is, since the point of the tool is reading logs you own.
const known = JSON.parse(manifestBytes).fixtures.find(entry => entry.file === fixtureName);
if (known && (report.sha256 !== known.sha256 || report.byteLength !== known.byteLength)) {
  throw new Error(
    `Fixture integrity check failed: received ${report.byteLength} bytes / ${report.sha256}`
  );
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
