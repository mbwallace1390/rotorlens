#!/usr/bin/env node

/** Dependency-free syntax gate for every JavaScript module that ships or tests. */

import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['bin', 'src', 'test', 'tools', 'ui'];

async function modulesIn(directory, found = []) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await modulesIn(full, found);
    } else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) {
      found.push(full);
    }
  }
  return found;
}

const modules = [];
for (const root of roots) {
  await modulesIn(path.join(projectRoot, root), modules);
}

const failures = [];
for (const file of modules.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) {
    failures.push(`${path.relative(projectRoot, file)}\n${result.stderr || result.stdout}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}

process.stdout.write(`${modules.length} JavaScript modules parsed successfully\n`);
