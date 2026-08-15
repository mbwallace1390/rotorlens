import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const firebaseRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const packagePath = require.resolve('firebase-tools/package.json');
const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
const cli = path.resolve(path.dirname(packagePath), manifest.bin.firebase);
const args = [
  cli,
  'emulators:exec',
  '--project',
  'demo-rotorlens',
  '--only',
  'firestore,functions',
  '--log-verbosity',
  'QUIET',
  'node --test emulator-tests/emulator.mjs'
];

const child = spawn(process.execPath, args, {
  cwd: firebaseRoot,
  env: {
    ...process.env,
    FUNCTIONS_DISCOVERY_TIMEOUT: '30'
  },
  stdio: 'inherit',
  windowsHide: true
});

child.once('error', error => {
  process.stderr.write(`Firebase emulator launch failed: ${error.message}\n`);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`Firebase emulator stopped by ${signal}.\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
