import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAXIMUM_FILE_BYTES,
  fromFile,
  fromHostEvent,
  forgetHistoryFile,
  forgetSharingFile,
  onHostImportProgress,
  onHostImportStarted,
  readHistoryText,
  readSharingText,
  writeHistoryText,
  writeSharingText
} from '../ui/host.mjs';

test('file sources refuse an unsafe allocation before constructing FileReader', async () => {
  const source = fromFile({name: 'huge.bbl', size: MAXIMUM_FILE_BYTES + 1});
  await assert.rejects(source.bytes(), /128 MiB safe limit/);
});

test('native sources forward cancellation to fetch and preflight declared size', async () => {
  let fetched = false;
  const tooLarge = fromHostEvent({
    name: 'huge.bbl', url: '/import/1', size: MAXIMUM_FILE_BYTES + 1
  }, {
    fetch() {
      fetched = true;
      throw new Error('must not fetch');
    }
  });
  await assert.rejects(tooLarge.bytes(), /128 MiB safe limit/);
  assert.equal(fetched, false);

  let receivedSignal = null;
  const controller = new AbortController();
  const source = fromHostEvent({name: 'flight.bbl', url: '/import/2', size: 42}, {
    fetch(_url, options) {
      receivedSignal = options.signal;
      return Promise.reject(Object.assign(new Error('aborted'), {name: 'AbortError'}));
    }
  });
  await assert.rejects(source.bytes(controller.signal), {name: 'AbortError'});
  assert.equal(receivedSignal, controller.signal);
});

test('native import event generations survive the host boundary', () => {
  const listeners = new Map();
  const scope = {
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); }
  };
  let started = null;
  let progress = null;
  const stopStarted = onHostImportStarted(value => { started = value; }, scope);
  const stopProgress = onHostImportProgress(value => { progress = value; }, scope);

  listeners.get('rotorlens-import-started')({detail: {
    name: 'flight.bbl', total: 100, generation: 17
  }});
  listeners.get('rotorlens-import-progress')({detail: {
    copied: 50, total: 100, generation: 17
  }});

  assert.deepEqual(started, {name: 'flight.bbl', total: 100, generation: 17});
  assert.deepEqual(progress, {copied: 50, total: 100, generation: 17});
  stopStarted();
  stopProgress();
  assert.equal(listeners.size, 0);
});

test('a native history read failure stays distinct from an absent file', async () => {
  const scope = {
    RotorLensNative: {
      readHistory() { return null; },
      writeHistory() { return true; }
    }
  };
  assert.equal(await readHistoryText(scope), null);
  scope.RotorLensNative.readHistory = () => '';
  assert.equal(await readHistoryText(scope), '');
});

test('storage adapters await iOS-style replies and preserve Android sync results', async () => {
  const calls = [];
  const scope = {
    RotorLensNative: {
      readHistory() { return Promise.resolve('history'); },
      writeHistory(text) { calls.push(['history', text]); return true; },
      forgetHistory() { calls.push(['forget-history']); return Promise.resolve(true); },
      readSharing() { return 'sharing'; },
      writeSharing(text) { calls.push(['sharing', text]); return Promise.resolve(true); },
      forgetSharing() { calls.push(['forget-sharing']); return true; }
    }
  };

  assert.equal(await readHistoryText(scope), 'history');
  assert.equal(await writeHistoryText('next-history', scope), true);
  assert.equal(await forgetHistoryFile(scope), true);
  assert.equal(await readSharingText(scope), 'sharing');
  assert.equal(await writeSharingText('next-sharing', scope), true);
  assert.equal(await forgetSharingFile(scope), true);
  assert.deepEqual(calls, [
    ['history', 'next-history'],
    ['forget-history'],
    ['sharing', 'next-sharing'],
    ['forget-sharing']
  ]);
});

test('rejected or non-boolean storage replies fail closed', async () => {
  const rejected = Promise.reject(new Error('native failure'));
  // The adapter installs its rejection handler immediately below, so Node does
  // not observe this deliberately rejected bridge reply as unhandled.
  const scope = {
    RotorLensNative: {
      readHistory() { return rejected; },
      writeHistory() { return Promise.resolve(1); },
      readSharing() { throw new Error('native failure'); },
      writeSharing() { return Promise.resolve('true'); }
    }
  };

  assert.equal(await readHistoryText(scope), null);
  assert.equal(await writeHistoryText('history', scope), false);
  assert.equal(await readSharingText(scope), null);
  assert.equal(await writeSharingText('sharing', scope), false);
});
