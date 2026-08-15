/**
 * Opening a log: overlapping opens, and an open that fails.
 *
 * Both cases exist because `openFile` became DESTRUCTIVE BEFORE IT SUSPENDS. A
 * lazy decoder reads its input on demand, so an open log holds the whole file —
 * 125 MiB for the owner's dataflash dump — and the previous log therefore has to
 * be released BEFORE the next one's bytes are read, or two dumps are resident at
 * the peak and the phone is killed doing exactly what this design exists to make
 * survivable. That ordering is right and it is kept. What it created is a window,
 * two `await`s wide, in which the app has no log and the screen has not been told.
 *
 * Two things fall into that window, and neither had a test:
 *
 *   1. A SECOND OPEN entering while the first is suspended. The first resumes,
 *      finds its state cleared, decodes a session nobody will see and throws
 *      painting it. `openSession` has carried a run token since it was written;
 *      the call above it did not.
 *
 *   2. AN OPEN THAT FAILS. A share intent whose URL the shell can no longer
 *      serve makes `source.bytes()` throw — `fromHostEvent` rejects on any
 *      non-ok response. The log was already gone; the panels were not. The
 *      previous flight stayed on screen looking live over a null log, and the
 *      two controls a pilot reaches for next threw inside their own handlers
 *      where nothing reports it. From the seat: Analyse and the field picker
 *      stopped working, silently, with the wrong flight still on screen.
 *
 * Both are driven here through the real host bridge in a real browser, because
 * both are about ordering between event handlers and neither is visible to a
 * function-level test. Skipped rather than failed when no browser is present,
 * matching test/ui-browser.test.mjs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createUiServer} from '../tools/serve-ui.mjs';
import {
  addFlightRecord, buildFlightRecord, createHistory, exportHistory
} from '../src/analysis/flight-history.mjs';

function findBrowser() {
  const {
    PROGRAMFILES = 'C:\\Program Files',
    'PROGRAMFILES(X86)': PROGRAMFILES_X86 = 'C:\\Program Files (x86)',
    LOCALAPPDATA = ''
  } = process.env;

  return [
    process.env.ROTORLENS_BROWSER,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    `${PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
    `${PROGRAMFILES_X86}\\Google\\Chrome\\Application\\chrome.exe`,
    LOCALAPPDATA && `${LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    `${PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${PROGRAMFILES_X86}\\Microsoft\\Edge\\Application\\msedge.exe`
  ].filter(Boolean).find(candidate => existsSync(candidate));
}

const chromePath = findBrowser();

const listen = server => new Promise(resolve => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

async function freePort() {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function waitForDevTools(port, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        return (await response.json()).webSocketDebuggerUrl;
      }
    } catch {
      // Browser not up yet.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Chromium DevTools endpoint never became ready');
}

/** Minimal CDP client: send a command, await the matching id. */
function connect(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    const pending = new Map();
    const listeners = new Set();
    let nextId = 0;

    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) {
        listeners.forEach(listener => listener(message));
        return;
      }
      const handler = pending.get(message.id);
      if (handler) {
        pending.delete(message.id);
        handler(message);
      }
    });
    socket.addEventListener('error', reject);
    socket.addEventListener('open', () => resolve({
      send(method, params = {}, sessionId) {
        const id = nextId += 1;
        return new Promise((settle, fail) => {
          pending.set(id, message => (
            message.error ? fail(new Error(`${method}: ${message.error.message}`)) : settle(message.result)
          ));
          socket.send(JSON.stringify({id, method, params, sessionId}));
        });
      },
      on: listener => listeners.add(listener),
      close: () => socket.close()
    }));
  });
}

/**
 * Runs `body` against a freshly loaded viewer.
 *
 * `block` is a list of paths the browser must refuse, intercepted before the
 * request leaves — the same thing the WebView sees when an asset is missing
 * from the APK.
 */
async function withViewer({block = [], startupScript = null} = {}, body) {
  const server = createUiServer();
  const port = await listen(server);
  const debugPort = await freePort();
  const profile = await mkdtemp(path.join(tmpdir(), 'rotorlens-lazy-'));

  const browser = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    'about:blank'
  ], {stdio: 'ignore'});

  let client;
  try {
    client = await connect(await waitForDevTools(debugPort));

    const {targetId} = await client.send('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await client.send('Target.attachToTarget', {targetId, flatten: true});

    const pageErrors = [];
    const refused = [];
    client.on(message => {
      if (message.method === 'Runtime.exceptionThrown') {
        pageErrors.push(
          message.params.exceptionDetails.exception?.description
          ?? message.params.exceptionDetails.text
        );
      }
    });

    await client.send('Runtime.enable', {}, sessionId);
    await client.send('Page.enable', {}, sessionId);

    if (startupScript !== null) {
      await client.send('Page.addScriptToEvaluateOnNewDocument', {
        source: startupScript
      }, sessionId);
    }

    if (block.length > 0) {
      await client.send('Fetch.enable', {
        patterns: block.map(target => ({urlPattern: `*${target}`, requestStage: 'Request'}))
      }, sessionId);

      client.on(message => {
        if (message.method !== 'Fetch.requestPaused' || message.sessionId !== sessionId) {
          return;
        }
        refused.push(message.params.request.url);
        client.send('Fetch.failRequest', {
          requestId: message.params.requestId,
          errorReason: 'Failed'
        }, sessionId).catch(() => { /* the page may already be gone */ });
      });
    }

    await client.send('Page.navigate', {url: `http://127.0.0.1:${port}/ui/`}, sessionId);
    await new Promise(resolve => setTimeout(resolve, 900));

    const evaluate = async expression => {
      const outcome = await client.send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true
      }, sessionId);
      assert.equal(outcome.exceptionDetails, undefined,
        `the page threw: ${JSON.stringify(outcome.exceptionDetails)}`);
      return JSON.parse(outcome.result.value);
    };

    return await body({evaluate, pageErrors, refused});
  } finally {
    client?.close();
    browser.kill();
    await new Promise(resolve => server.close(resolve));
    await rm(profile, {recursive: true, force: true}).catch(() => {});
  }
}

const browserSkip = chromePath ? false : 'no Chromium found; set ROTORLENS_BROWSER to a path';

test('an unreadable native history is write-blocked until explicitly erased', {
  skip: browserSkip
}, async () => {
  const startupScript = `(() => {
    let forgets = 0;
    let writes = 0;
    window.RotorLensNative = {
      pickFile() {},
      readHistory() { return null; },
      writeHistory() { writes += 1; return true; },
      forgetHistory() { forgets += 1; return true; },
      readSharing() { return ''; },
      writeSharing() { return true; },
      forgetSharing() { return true; }
    };
    window.__historyCalls = () => ({forgets, writes});
  })();`;

  await withViewer({startupScript}, async ({evaluate, pageErrors}) => {
    const result = await evaluate(`(async () => {
      const {state} = await import('/ui/app.mjs');
      const summary = document.getElementById('history-summary').textContent;
      const before = {
        summary,
        list: document.getElementById('history').textContent,
        writable: state.historyWritable
      };
      const button = document.getElementById('history-forget-all');
      button.click();
      button.click();
      await new Promise(resolve => setTimeout(resolve, 30));
      return JSON.stringify({
        before,
        after: {
          writable: state.historyWritable,
          summary: document.getElementById('history-summary').textContent,
          calls: window.__historyCalls()
        }
      });
    })()`);

    assert.equal(result.before.writable, false);
    assert.match(result.before.summary, /could not read|saving is disabled/i);
    assert.doesNotMatch(
      `${result.before.summary} ${result.before.list}`,
      /(?:\b0 flights stored\b|No flights are stored)/i,
      'an unreadable store has an unknown count, not zero flights'
    );
    assert.equal(result.after.calls.writes, 0,
      'an unreadable file must never be replaced as though it were empty');
    assert.equal(result.after.calls.forgets, 1);
    assert.equal(result.after.writable, true,
      'an explicit successful erase must make a fresh history writable again');
    assert.deepEqual(pageErrors, []);
  });
});

test('a partial history cannot be exported or edited as though it were complete', {
  skip: browserSkip
}, async () => {
  const session = {
    firmware: {revision: 'Rotorflight 4.6.0'},
    headers: {
      'Craft name': 'TEST',
      'Board information': 'BOARD',
      rollPID: '50,50,20',
      pitchPID: '50,50,20',
      yawPID: '50,50,20',
      rates_type: '6',
      rc_rates: '50,50,50',
      rc_expo: '30,30,30',
      rates: '12,12,12'
    }
  };
  const record = buildFlightRecord({
    session,
    window: {startUs: 0, endUs: 10_000_000, basis: 'airborne'}
  });
  const partial = JSON.parse(exportHistory(addFlightRecord(createHistory(), record)));
  partial.records.push({kind: 'unreadable-record'});
  const storedHistory = JSON.stringify(partial);
  const startupScript = `(() => {
    let writes = 0;
    let sharingWrites = 0;
    window.RotorLensNative = {
      pickFile() {},
      readHistory() { return ${JSON.stringify(storedHistory)}; },
      writeHistory() { writes += 1; return true; },
      forgetHistory() { return true; },
      readSharing() { return ''; },
      writeSharing() { sharingWrites += 1; return true; },
      forgetSharing() { return true; }
    };
    window.__historyWrites = () => writes;
    window.__sharingWrites = () => sharingWrites;
  })();`;

  await withViewer({startupScript}, async ({evaluate, pageErrors}) => {
    const result = await evaluate(`(async () => {
      const {state} = await import('/ui/app.mjs');
      const app = await import('/ui/app.mjs');
      const buttons = [...document.querySelectorAll(
        '#history [data-forget-flight], #history [data-forget-aircraft]'
      )];
      buttons[0]?.click();
      const exportButton = document.getElementById('history-export');
      exportButton.click();
      await new Promise(resolve => setTimeout(resolve, 30));
      const box = document.getElementById('history-export-text');

      // Exercise the two derived safety paths, not only the controls. The
      // readable record matches this craft but the current log changes yaw I,
      // so removing the historyReadBlocked guard would select it as a baseline.
      state.result = {sessions: [{
        craftName: 'TEST',
        firmware: {revision: 'Rotorflight 4.6.0', board: 'BOARD'}
      }]};
      state.sessionIndex = 0;
      state.sessionHeaders = [{
        craftName: 'TEST', board: 'BOARD', headers: {
          'Craft name': 'TEST', 'Board information': 'BOARD',
          rollPID: '50,50,20', pitchPID: '50,50,20', yawPID: '50,60,20',
          rates_type: '6', rc_rates: '50,50,50', rc_expo: '30,30,30',
          rates: '12,12,12'
        }
      }];
      state.window = {
        startUs: 0, endUs: 10_000_000, basis: 'FLIGHT_WINDOW_DETECTED'
      };
      app.considerFlight({});
      const learned = app.learningForOpenLog();
      const sharingToggle = document.getElementById('sharing-toggle');
      sharingToggle.click();

      return JSON.stringify({
        blocked: state.historyReadBlocked,
        records: state.history.records.length,
        buttons: buttons.map(button => button.disabled),
        exportDisabled: exportButton.disabled,
        exportLabel: exportButton.textContent,
        exportHidden: box.classList.contains('hidden'),
        exportText: box.textContent,
        summary: document.getElementById('history-summary').textContent,
        historyText: document.getElementById('history').textContent,
        learned,
        comparison: state.comparison,
        sinceText: document.getElementById('since').textContent,
        sharingText: document.getElementById('sharing').textContent,
        learningPanels: document.querySelectorAll('#history .learn').length,
        writes: window.__historyWrites(),
        sharingToggleDisabled: sharingToggle.disabled,
        consentHidden: document.getElementById('consent').classList.contains('hidden'),
        sharingWrites: window.__sharingWrites()
      });
    })()`);

    assert.equal(result.blocked, true);
    assert.equal(result.records, 1, 'the readable record should remain visible, not be discarded');
    assert.ok(result.buttons.length > 0 && result.buttons.every(Boolean));
    assert.equal(result.exportDisabled, true);
    assert.match(result.exportLabel, /unavailable/i);
    assert.equal(result.exportHidden, true);
    assert.equal(result.exportText, '');
    assert.match(result.summary, /1 readable flight.*total stored count is unavailable/is);
    assert.match(result.historyText, /Learning and before\/after comparison are unavailable/i);
    assert.equal(result.learningPanels, 0,
      'a readable subset must not be rendered as a fitted learning model');
    assert.equal(result.learned, null,
      'a partial history must not feed the open-log recommendation magnitude');
    assert.equal(result.comparison, null,
      'a readable partial record must not become a before/after baseline');
    assert.match(result.sinceText, /cannot safely use a partial history/i);
    assert.doesNotMatch(result.sinceText, /This is the first flight/i);
    assert.match(result.sharingText, /will not create or remove sharing identities/i);
    assert.doesNotMatch(result.sharingText, /Nothing about sharing is stored on this device/i);
    assert.equal(result.writes, 0);
    assert.equal(result.sharingToggleDisabled, true,
      'sharing cannot be enabled while helicopter identities are incomplete');
    assert.equal(result.consentHidden, true);
    assert.equal(result.sharingWrites, 0);
    assert.deepEqual(pageErrors, []);
  });
});

test('an unreadable history cannot prune stored sharing identities', {
  skip: browserSkip
}, async () => {
  const sharingId = 'abcde-fghjk-mnpqr-stvwx';
  const sharing = JSON.stringify({
    schemaVersion: 1,
    kind: 'rotorlens-sharing-preference',
    asked: true,
    sharing: true,
    termsVersion: '2026-08-14',
    ids: {'test::board': sharingId}
  });
  const startupScript = `(() => {
    let preference = ${JSON.stringify(sharing)};
    let writes = 0;
    window.RotorLensNative = {
      pickFile() {},
      readHistory() { return null; },
      writeHistory() { return true; },
      forgetHistory() { return true; },
      readSharing() { return preference; },
      writeSharing(text) { writes += 1; preference = text; return true; },
      forgetSharing() { return true; }
    };
    window.__sharingFile = () => ({preference, writes});
  })();`;

  await withViewer({startupScript}, async ({evaluate, pageErrors}) => {
    const result = await evaluate(`(async () => {
      const {state} = await import('/ui/app.mjs');
      return JSON.stringify({
        blocked: state.historyReadBlocked,
        id: state.sharing.ids['test::board'],
        file: window.__sharingFile(),
        text: document.getElementById('sharing').textContent
      });
    })()`);

    assert.equal(result.blocked, true);
    assert.equal(result.id, sharingId);
    assert.equal(result.file.preference, sharing,
      'the stored sharing file must remain byte-for-byte untouched');
    assert.equal(result.file.writes, 0,
      'repainting from an unreadable history must not reconcile identities');
    assert.match(result.text, /identity is being preserved|identities have not been changed/i);
    assert.deepEqual(pageErrors, []);
  });
});

test('Forget everything adopts a deleted history even when sharing deletion fails', {
  skip: browserSkip
}, async () => {
  const session = {
    firmware: {revision: 'Rotorflight 4.6.0'},
    headers: {
      'Craft name': 'TEST',
      'Board information': 'BOARD',
      rollPID: '50,50,20',
      pitchPID: '50,50,20',
      yawPID: '50,50,20',
      rates_type: '6',
      rc_rates: '50,50,50',
      rc_expo: '30,30,30',
      rates: '12,12,12'
    }
  };
  const record = buildFlightRecord({
    session,
    window: {startUs: 0, endUs: 10_000_000, basis: 'airborne'}
  });
  const storedHistory = exportHistory(addFlightRecord(createHistory(), record));
  const sharingId = 'abcde-fghjk-mnpqr-stvwx';
  const storedSharing = JSON.stringify({
    schemaVersion: 1,
    kind: 'rotorlens-sharing-preference',
    asked: true,
    sharing: false,
    termsVersion: null,
    ids: {'test::board': sharingId}
  });
  const startupScript = `(() => {
    let history = ${JSON.stringify(storedHistory)};
    let sharing = ${JSON.stringify(storedSharing)};
    let sharingWrites = 0;
    window.RotorLensNative = {
      pickFile() {},
      readHistory() { return history; },
      writeHistory(text) { history = text; return true; },
      forgetHistory() { history = ''; return true; },
      readSharing() { return sharing; },
      writeSharing(text) { sharingWrites += 1; sharing = text; return true; },
      forgetSharing() { return false; }
    };
    window.__storedFiles = () => ({history, sharing, sharingWrites});
  })();`;

  await withViewer({startupScript}, async ({evaluate, pageErrors}) => {
    const result = await evaluate(`(async () => {
      const {state} = await import('/ui/app.mjs');
      const before = state.history.records.length;
      const button = document.getElementById('history-forget-all');
      button.click();
      button.click();
      await new Promise(resolve => setTimeout(resolve, 30));
      return JSON.stringify({
        before,
        after: state.history.records.length,
        historyForgetFailed: state.historyForgetFailed,
        sharingForgetFailed: state.sharingForgetFailed,
        files: window.__storedFiles()
      });
    })()`);

    assert.equal(result.before, 1);
    assert.equal(result.after, 0,
      'a successful history unlink must be adopted despite a separate sharing failure');
    assert.equal(result.historyForgetFailed, false);
    assert.equal(result.sharingForgetFailed, true);
    assert.equal(result.files.history, '');
    assert.equal(result.files.sharing, storedSharing);
    assert.equal(result.files.sharingWrites, 0,
      'a failed unlink must not be followed by reconciliation that drops the retained ID');
    assert.equal(JSON.parse(result.files.sharing).ids['test::board'], sharingId);
    assert.deepEqual(pageErrors, []);
  });
});

test('repainting the sharing panel cannot leave its new erase button armed', {
  skip: browserSkip
}, async () => {
  const history = exportHistory(createHistory());
  const sharing = JSON.stringify({
    schemaVersion: 1,
    kind: 'rotorlens-sharing-preference',
    asked: true,
    sharing: true,
    termsVersion: '2026-08-14',
    ids: {}
  });
  const startupScript = `(() => {
    let preference = ${JSON.stringify(sharing)};
    let forgets = 0;
    window.RotorLensNative = {
      pickFile() {},
      readHistory() { return ${JSON.stringify(history)}; },
      writeHistory() { return true; },
      forgetHistory() { return true; },
      readSharing() { return preference; },
      writeSharing(text) { preference = text; return true; },
      forgetSharing() { forgets += 1; preference = ''; return true; }
    };
    window.__sharingState = () => ({preference, forgets});
  })();`;

  await withViewer({startupScript}, async ({evaluate, pageErrors}) => {
    const result = await evaluate(`(async () => {
      const first = document.getElementById('sharing-forget');
      first.click();
      const armedLabel = first.textContent;

      // This persists and repaints the whole panel while the old button's
      // five-second confirmation window is still live.
      document.getElementById('sharing-toggle').click();
      await new Promise(resolve => setTimeout(resolve, 0));
      const replacement = document.getElementById('sharing-forget');
      replacement.click();
      return JSON.stringify({
        armedLabel,
        replacementLabel: replacement.textContent,
        sameButton: first === replacement,
        native: window.__sharingState()
      });
    })()`);

    assert.match(result.armedLabel, /Tap again/);
    assert.equal(result.sameButton, false, 'the panel setup did not actually repaint');
    assert.match(result.replacementLabel, /Tap again/,
      'a replacement erase button must require its own first confirmation tap');
    assert.equal(result.native.forgets, 0,
      'one tap on a newly rendered button erased the identity');
    assert.notEqual(result.native.preference, '');
    assert.deepEqual(pageErrors, []);
  });
});

test('async native writes are confirmed before repaint and stale taps do not reorder them', {
  skip: browserSkip
}, async () => {
  const history = exportHistory(createHistory());
  const sharing = JSON.stringify({
    schemaVersion: 1,
    kind: 'rotorlens-sharing-preference',
    asked: true,
    sharing: true,
    termsVersion: '2026-08-14',
    ids: {}
  });
  const startupScript = `(() => {
    let preference = ${JSON.stringify(sharing)};
    const pending = [];
    const writes = [];
    window.RotorLensNative = {
      pickFile() {},
      readHistory() { return ${JSON.stringify(history)}; },
      writeHistory() { return true; },
      forgetHistory() { return true; },
      readSharing() { return preference; },
      writeSharing(text) {
        writes.push(text);
        return new Promise(resolve => pending.push(() => {
          preference = text;
          resolve(true);
        }));
      },
      forgetSharing() { preference = ''; return Promise.resolve(true); }
    };
    window.__asyncStore = {
      settle() { pending.shift()?.(); },
      snapshot() { return {preference, writes: [...writes], pending: pending.length}; }
    };
  })();`;

  await withViewer({startupScript}, async ({evaluate, pageErrors}) => {
    const result = await evaluate(`(async () => {
      const first = document.getElementById('sharing-toggle');
      first.click();
      first.click();
      await Promise.resolve();
      const beforeReply = {
        label: document.getElementById('sharing-toggle').textContent,
        native: window.__asyncStore.snapshot()
      };

      window.__asyncStore.settle();
      for (let index = 0; index < 20; index += 1) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (document.getElementById('sharing-toggle').textContent.includes('Share measurements')) {
          break;
        }
      }
      return JSON.stringify({
        beforeReply,
        afterReply: {
          label: document.getElementById('sharing-toggle').textContent,
          native: window.__asyncStore.snapshot()
        }
      });
    })()`);

    assert.match(result.beforeReply.label, /Turn sharing off/,
      'the page must not paint success before the native Promise resolves');
    assert.equal(JSON.parse(result.beforeReply.native.preference).sharing, true);
    assert.equal(result.beforeReply.native.pending, 1);
    assert.match(result.afterReply.label, /Share measurements/);
    assert.equal(JSON.parse(result.afterReply.native.preference).sharing, false);
    assert.equal(result.afterReply.native.writes.length, 1,
      'the second tap was calculated from stale state and must not reach native storage');
    assert.deepEqual(pageErrors, []);
  });
});

test('the automatic consent path defers while About is the topmost in-app page', {
  skip: browserSkip
}, async () => {
  const history = exportHistory(createHistory());
  const startupScript = `(() => {
    let writes = 0;
    window.RotorLensNative = {
      pickFile() {},
      readHistory() { return ${JSON.stringify(history)}; },
      writeHistory() { return true; },
      forgetHistory() { return true; },
      readSharing() { return ''; },
      writeSharing() { writes += 1; return true; },
      forgetSharing() { return true; }
    };
    window.__sharingWrites = () => writes;
  })();`;

  await withViewer({startupScript}, async ({evaluate, pageErrors}) => {
    const result = await evaluate(`(async () => {
      const app = await import('/ui/app.mjs');
      const toggle = document.getElementById('legal-toggle');
      const legal = document.getElementById('legal-panel');
      const consent = document.getElementById('consent');
      const header = document.querySelector('body > header');
      const main = document.querySelector('body > main');

      toggle.focus();
      toggle.click();
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
      app.state.candidate = {forced: 'automatic-consent-path'};
      app.maybeAskToShare();

      const covered = {
        legalOpen: !legal.classList.contains('hidden'),
        consentOpen: !consent.classList.contains('hidden'),
        headerInert: header.hasAttribute('inert'),
        mainInert: main.hasAttribute('inert'),
        focus: document.activeElement?.id ?? null,
        writes: window.__sharingWrites()
      };

      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true
      }));
      await new Promise(resolve => setTimeout(resolve, 0));

      toggle.click();
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
      const handledBack = window.RotorLensHandleBack();
      await new Promise(resolve => setTimeout(resolve, 0));
      return JSON.stringify({
        covered,
        afterEscape: {
          legalOpen: !legal.classList.contains('hidden'),
          consentOpen: !consent.classList.contains('hidden'),
          headerInert: header.hasAttribute('inert'),
          mainInert: main.hasAttribute('inert'),
          focus: document.activeElement?.id ?? null,
          writes: window.__sharingWrites()
        },
        afterAndroidBack: {
          handled: handledBack,
          legalOpen: !legal.classList.contains('hidden'),
          consentOpen: !consent.classList.contains('hidden'),
          headerInert: header.hasAttribute('inert'),
          mainInert: main.hasAttribute('inert'),
          focus: document.activeElement?.id ?? null,
          writes: window.__sharingWrites()
        }
      });
    })()`);

    assert.equal(result.covered.legalOpen, true);
    assert.equal(result.covered.consentOpen, false,
      'the automatic prompt must not compose underneath About & Legal');
    assert.equal(result.covered.headerInert, true);
    assert.equal(result.covered.mainInert, true);
    assert.equal(result.covered.focus, 'legal-back');
    assert.equal(result.covered.writes, 0);

    assert.equal(result.afterEscape.legalOpen, false,
      'Escape must close the topmost About page');
    assert.equal(result.afterEscape.consentOpen, false,
      'the same Escape must not answer or reveal consent underneath');
    assert.equal(result.afterEscape.headerInert, false);
    assert.equal(result.afterEscape.mainInert, false);
    assert.equal(result.afterEscape.focus, 'legal-toggle');
    assert.equal(result.afterEscape.writes, 0);

    assert.equal(result.afterAndroidBack.handled, true,
      'the native Back hook must consume the topmost About page');
    assert.equal(result.afterAndroidBack.legalOpen, false);
    assert.equal(result.afterAndroidBack.consentOpen, false);
    assert.equal(result.afterAndroidBack.headerInert, false);
    assert.equal(result.afterAndroidBack.mainInert, false);
    assert.equal(result.afterAndroidBack.focus, 'legal-toggle');
    assert.equal(result.afterAndroidBack.writes, 0);
    assert.deepEqual(pageErrors, []);
  });
});

test('a failed erase is reported even when an unreadable sharing file blocked writes', {
  skip: browserSkip
}, async () => {
  const startupScript = `(() => {
    let sharingForgets = 0;
    window.RotorLensNative = {
      pickFile() {},
      readHistory() { return ''; },
      writeHistory() { return true; },
      forgetHistory() { return true; },
      readSharing() { return null; },
      writeSharing() { return true; },
      forgetSharing() { sharingForgets += 1; return false; }
    };
    window.__sharingForgets = () => sharingForgets;
  })();`;

  await withViewer({startupScript}, async ({evaluate, pageErrors}) => {
    const result = await evaluate(`(async () => {
      const {state} = await import('/ui/app.mjs');
      const erase = document.getElementById('sharing-forget');
      erase.click();
      erase.click();
      await new Promise(resolve => setTimeout(resolve, 30));
      const direct = {
        failed: state.sharingForgetFailed,
        text: document.getElementById('sharing').textContent,
        calls: window.__sharingForgets()
      };

      const forgetAll = document.getElementById('history-forget-all');
      forgetAll.click();
      forgetAll.click();
      await new Promise(resolve => setTimeout(resolve, 30));
      return JSON.stringify({
        direct,
        all: {
          failed: state.sharingForgetFailed,
          text: document.getElementById('sharing').textContent,
          calls: window.__sharingForgets()
        }
      });
    })()`);

    assert.equal(result.direct.calls, 1);
    assert.equal(result.direct.failed, true);
    assert.match(result.direct.text, /could not erase the sharing identity/i);
    assert.equal(result.all.calls, 2);
    assert.equal(result.all.failed, true,
      'Forget everything must report a sharing unlink failure too');
    assert.match(result.all.text, /could not erase the sharing identity/i);
    assert.deepEqual(pageErrors, []);
  });
});

test('enabled consent from an older disclosure fails closed on upgrade', {
  skip: browserSkip
}, async () => {
  const session = {
    firmware: {revision: 'Rotorflight 4.6.0'},
    headers: {
      'Craft name': 'TEST',
      'Board information': 'BOARD',
      rollPID: '50,50,20',
      pitchPID: '50,50,20',
      yawPID: '50,50,20',
      rates_type: '6',
      rc_rates: '50,50,50',
      rc_expo: '30,30,30',
      rates: '12,12,12'
    }
  };
  const record = buildFlightRecord({
    session,
    window: {startUs: 0, endUs: 10_000_000, basis: 'airborne'}
  });
  const storedHistory = exportHistory(addFlightRecord(createHistory(), record));
  const sharingId = 'abcde-fghjk-mnpqr-stvwx';
  const oldPreference = JSON.stringify({
    schemaVersion: 1,
    kind: 'rotorlens-sharing-preference',
    asked: true,
    sharing: true,
    termsVersion: '2026-08-13',
    ids: {'test::board': sharingId}
  });
  const startupScript = `(() => {
    let writes = 0;
    window.RotorLensNative = {
      pickFile() {},
      readHistory() { return ${JSON.stringify(storedHistory)}; },
      writeHistory() { return true; },
      forgetHistory() { return true; },
      readSharing() { return ${JSON.stringify(oldPreference)}; },
      writeSharing() { writes += 1; return true; },
      forgetSharing() { return true; }
    };
    window.__sharingWrites = () => writes;
  })();`;

  await withViewer({startupScript}, async ({evaluate, pageErrors}) => {
    const result = await evaluate(`(async () => {
      const {state} = await import('/ui/app.mjs');
      return JSON.stringify({
        sharing: state.sharing.sharing,
        asked: state.sharing.asked,
        termsVersion: state.sharing.termsVersion,
        id: state.sharing.ids['test::board'],
        text: document.getElementById('sharing').textContent,
        writes: window.__sharingWrites()
      });
    })()`);

    assert.equal(result.sharing, false,
      'old enabled consent must never remain effective under changed words');
    assert.equal(result.asked, false, 'the current disclosure must be eligible to ask again');
    assert.equal(result.termsVersion, null);
    assert.equal(result.id, sharingId, 'terms migration must retain the existing deletion handle');
    assert.match(result.text, /older disclosure.*off now/is);
    assert.doesNotMatch(result.text, /Nothing about sharing is stored on this device/i);
    assert.equal(result.writes, 0,
      'loading old consent may disable it in memory without rewriting user data');
    assert.deepEqual(pageErrors, []);
  });
});

test('sharing cannot be enabled without a recorded affirmative answer', {
  skip: browserSkip
}, async () => {
  const sharingId = 'abcde-fghjk-mnpqr-stvwx';
  const impossiblePreference = JSON.stringify({
    schemaVersion: 1,
    kind: 'rotorlens-sharing-preference',
    asked: false,
    sharing: true,
    termsVersion: '2026-08-14',
    ids: {'test::board': sharingId}
  });
  const startupScript = `(() => {
    let writes = 0;
    window.RotorLensNative = {
      pickFile() {},
      readHistory() { return null; },
      writeHistory() { return true; },
      forgetHistory() { return true; },
      readSharing() { return ${JSON.stringify(impossiblePreference)}; },
      writeSharing() { writes += 1; return true; },
      forgetSharing() { return true; }
    };
    window.__sharingWrites = () => writes;
  })();`;

  await withViewer({startupScript}, async ({evaluate, pageErrors}) => {
    const result = await evaluate(`(async () => {
      const {state} = await import('/ui/app.mjs');
      return JSON.stringify({
        asked: state.sharing.asked,
        sharing: state.sharing.sharing,
        termsVersion: state.sharing.termsVersion,
        id: state.sharing.ids['test::board'],
        writes: window.__sharingWrites()
      });
    })()`);

    assert.equal(result.asked, false);
    assert.equal(result.sharing, false, 'sharing:true without asked:true must fail closed');
    assert.equal(result.termsVersion, null);
    assert.equal(result.id, sharingId, 'fail-closed import must retain the deletion handle');
    assert.equal(result.writes, 0);
    assert.deepEqual(pageErrors, []);
  });
});

test('a host with no sharing store renders the enable control disabled', {
  skip: browserSkip
}, async () => {
  const session = {
    firmware: {revision: 'Rotorflight 4.6.0'},
    headers: {
      'Craft name': 'TEST',
      'Board information': 'BOARD',
      rollPID: '50,50,20',
      pitchPID: '50,50,20',
      yawPID: '50,50,20',
      rates_type: '6',
      rc_rates: '50,50,50',
      rc_expo: '30,30,30',
      rates: '12,12,12'
    }
  };
  const storedHistory = exportHistory(addFlightRecord(createHistory(), buildFlightRecord({
    session,
    window: {
      startUs: 0, endUs: 10_000_000, basis: 'FLIGHT_WINDOW_DETECTED'
    }
  })));
  const startupScript = `(() => {
    window.RotorLensNative = {
      pickFile() {},
      readHistory() { return ${JSON.stringify(storedHistory)}; },
      writeHistory() { return true; },
      forgetHistory() { return true; }
    };
  })();`;

  await withViewer({startupScript}, async ({evaluate, pageErrors}) => {
    const result = await evaluate(`(async () => {
      await import('/ui/app.mjs');
      const toggle = document.getElementById('sharing-toggle');
      return JSON.stringify({
        disabled: toggle.disabled,
        ariaDisabled: toggle.getAttribute('aria-disabled'),
        text: document.getElementById('sharing').textContent
      });
    })()`);

    assert.equal(result.disabled, true);
    assert.equal(result.ariaDisabled, 'true');
    assert.match(result.text, /sharing cannot be enabled here/i);
    assert.deepEqual(pageErrors, []);
  });
});

test('turning sharing on from the panel requires the complete consent dialog', {
  skip: browserSkip
}, async () => {
  const session = {
    firmware: {revision: 'Rotorflight 4.6.0'},
    headers: {
      'Craft name': 'TEST',
      'Board information': 'BOARD',
      rollPID: '50,50,20', pitchPID: '50,50,20', yawPID: '50,50,20',
      rates_type: '6', rc_rates: '50,50,50', rc_expo: '30,30,30',
      rates: '12,12,12'
    }
  };
  const storedHistory = exportHistory(addFlightRecord(createHistory(), buildFlightRecord({
    session,
    window: {startUs: 0, endUs: 10_000_000, basis: 'FLIGHT_WINDOW_DETECTED'}
  })));
  const storedSharing = JSON.stringify({
    schemaVersion: 1,
    kind: 'rotorlens-sharing-preference',
    asked: true,
    sharing: false,
    termsVersion: null,
    ids: {}
  });
  const startupScript = `(() => {
    let preference = ${JSON.stringify(storedSharing)};
    let writes = 0;
    window.RotorLensNative = {
      pickFile() {},
      readHistory() { return ${JSON.stringify(storedHistory)}; },
      writeHistory() { return true; },
      forgetHistory() { return true; },
      readSharing() { return preference; },
      writeSharing(text) { writes += 1; preference = text; return true; },
      forgetSharing() { preference = ''; return true; }
    };
    window.__sharingFile = () => ({preference, writes});
  })();`;

  await withViewer({startupScript}, async ({evaluate, pageErrors}) => {
    const result = await evaluate(`(async () => {
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const waitFor = async (condition, message) => {
        for (let attempt = 0; attempt < 400; attempt += 1) {
          const value = condition();
          if (value) return value;
          await sleep(25);
        }
        throw new Error(message);
      };
      const {state} = await import('/ui/app.mjs');
      const modal = document.getElementById('consent');

      const firstToggle = await waitFor(() => (
        state.history?.records?.length === 1
          && state.sharing?.asked === true
          && state.sharing?.sharing === false
          && state.sharingWritable
          && document.getElementById('sharing-toggle')
      ), 'the stored sharing preference never rendered');
      firstToggle.click();
      await waitFor(() => (
        state.consentOpen && !modal.classList.contains('hidden')
      ), 'the first consent dialog never opened');
      const firstPrompt = {
        shown: !modal.classList.contains('hidden'),
        licence: modal.querySelector('.consent-licence')?.textContent ?? '',
        file: window.__sharingFile()
      };

      document.getElementById('consent-not-now').click();
      await waitFor(() => (
        !state.consentOpen
          && modal.classList.contains('hidden')
          && window.__sharingFile().writes === 1
          && document.activeElement?.id === 'sharing-toggle'
      ), 'the declined consent choice never settled');
      const declined = {
        shown: !modal.classList.contains('hidden'),
        focus: document.activeElement?.id ?? null,
        file: window.__sharingFile()
      };

      document.getElementById('sharing-toggle').click();
      await waitFor(() => (
        state.consentOpen && !modal.classList.contains('hidden')
      ), 'the second consent dialog never opened');
      const secondPrompt = {
        shown: !modal.classList.contains('hidden'),
        file: window.__sharingFile()
      };
      document.getElementById('consent-share').click();
      await waitFor(() => {
        const file = window.__sharingFile();
        const preference = JSON.parse(file.preference);
        return !state.consentOpen
          && modal.classList.contains('hidden')
          && document.activeElement?.id === 'sharing-toggle'
          && preference.sharing === true
          && preference.termsVersion === '2026-08-14'
          && Object.keys(preference.ids).length === 1;
      }, 'the accepted consent choice never settled');
      const acceptedFile = window.__sharingFile();
      return JSON.stringify({
        firstPrompt,
        declined,
        secondPrompt,
        accepted: {
          shown: !modal.classList.contains('hidden'),
          focus: document.activeElement?.id ?? null,
          writes: acceptedFile.writes,
          preference: JSON.parse(acceptedFile.preference)
        }
      });
    })()`);

    assert.equal(result.firstPrompt.shown, true);
    assert.match(result.firstPrompt.licence,
      /keep ownership.*free releases.*releases distributed for a fee/is);
    assert.equal(result.firstPrompt.file.writes, 0,
      'opening the terms is not itself consent');
    assert.equal(result.firstPrompt.file.preference, storedSharing);

    assert.equal(result.declined.shown, false);
    assert.equal(result.declined.focus, 'sharing-toggle');
    assert.equal(result.declined.file.writes, 1,
      'Not now records exactly the declined choice');
    assert.equal(JSON.parse(result.declined.file.preference).sharing, false);

    assert.equal(result.secondPrompt.shown, true);
    assert.equal(result.secondPrompt.file.writes, result.declined.file.writes,
      'reopening the terms must not enable or write anything');
    assert.equal(result.accepted.shown, false);
    assert.equal(result.accepted.focus, 'sharing-toggle');
    assert.equal(result.accepted.preference.asked, true);
    assert.equal(result.accepted.preference.sharing, true);
    assert.equal(result.accepted.preference.termsVersion, '2026-08-14');
    assert.equal(Object.keys(result.accepted.preference.ids).length, 1);
    assert.ok(result.accepted.writes > result.secondPrompt.file.writes);
    assert.deepEqual(pageErrors, []);
  });
});

test('a host import dismisses consent without recording an answer', {
  skip: browserSkip
}, async () => {
  const startupScript = `(() => {
    let sharingWrites = 0;
    window.RotorLensNative = {
      pickFile() {},
      readHistory() { return ''; },
      writeHistory() { return true; },
      forgetHistory() { return true; },
      readSharing() { return ''; },
      writeSharing() { sharingWrites += 1; return true; },
      forgetSharing() { return true; }
    };
    window.__sharingWrites = () => sharingWrites;
  })();`;

  await withViewer({startupScript}, async ({evaluate, pageErrors}) => {
    const result = await evaluate(`(async () => {
      const {state} = await import('/ui/app.mjs');
      state.consentOpen = true;
      document.querySelector('header').inert = true;
      document.querySelector('main').inert = true;
      document.getElementById('consent').classList.remove('hidden');
      document.getElementById('consent-not-now').focus();

      window.dispatchEvent(new CustomEvent('rotorlens-import-started', {detail: {
        name: 'replacement.LOG', total: -1, generation: 41
      }}));
      await new Promise(resolve => setTimeout(resolve, 20));
      return JSON.stringify({
        open: state.consentOpen,
        hidden: document.getElementById('consent').classList.contains('hidden'),
        headerInert: document.querySelector('header').inert,
        mainInert: document.querySelector('main').inert,
        active: document.activeElement?.id ?? null,
        writes: window.__sharingWrites()
      });
    })()`);

    assert.equal(result.open, false);
    assert.equal(result.hidden, true);
    assert.equal(result.headerInert, false);
    assert.equal(result.mainInert, false);
    assert.equal(result.active, 'drop', 'focus must leave the dismissed modal safely');
    assert.equal(result.writes, 0, 'replacement is not an answer to the old consent question');
    assert.deepEqual(pageErrors, []);
  });
});

/**
 * Two committed fixtures with DIFFERENT session counts.
 *
 * The count is what says which file won a race. A caption can be painted by an
 * open that later loses; two sessions in `state.result` can only have come from
 * the two-session file actually being decoded.
 */
const TWO_SESSIONS = '/fixtures/synthetic/rf46-two-sessions.TXT';
const ONE_SESSION = '/fixtures/synthetic/rf43-single-session.TXT';

test('a second log picked during the first one still opens the second', {
  skip: browserSkip
}, async () => {
  // Two share intents in quick succession, with the gap SWEPT across the range
  // where the first open is suspended. Measured before the fix: gaps of 1, 5,
  // 10 and 20 ms produced `TypeError: Cannot read properties of null (reading
  // 'sessions')` from `currentSession` <- `renderSession` <- `openSession` <-
  // `await openFile`, while 0, 40, 80 and 150 ms did not. That narrow window is
  // exactly why the flagship browser test failed about one run in three instead
  // of every time, and it is why the gap is swept rather than picked: a single
  // gap is a guess about where the window is, and the window moves with load.
  await withViewer({}, async ({evaluate, pageErrors}) => {
    const run = await evaluate(`(async () => {
      const $ = id => document.getElementById(id);
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const share = (name, url) => window.dispatchEvent(
        new CustomEvent('rotorlens-file', {detail: {name, url}}));

      const {state} = await import('/ui/app.mjs');
      const attempts = [];

      for (const gap of [0, 1, 2, 5, 10, 20, 40, 80]) {
        // FIRST is the one-session file, SECOND the two-session one, so the
        // session count below says which of them the app actually decoded.
        share('FIRST-' + gap + '.BBL', '${ONE_SESSION}');
        await sleep(gap);
        share('SECOND-' + gap + '.BBL', '${TWO_SESSIONS}');

        let settled = false;
        for (let attempt = 0; attempt < 400; attempt += 1) {
          if ($('status').textContent.includes('SECOND-' + gap + '.BBL \\u2014')
              && $('session-stats').children.length > 0) {
            settled = true;
            break;
          }
          await sleep(25);
        }

        // Let anything still in flight land, so a late paint from the LOSING
        // open is read here rather than at the start of the next round.
        await sleep(200);

        attempts.push({
          gap,
          settled,
          status: $('status').textContent.slice(0, 60),
          sessions: state.result ? state.result.sessions.length : -1,
          options: $('session').options.length,
          stats: $('session-stats').children.length
        });
      }

      return JSON.stringify(attempts);
    })()`);

    assert.equal(run.length, 8, 'the sweep did not run');

    for (const attempt of run) {
      assert.equal(attempt.settled, true,
        `at a ${attempt.gap} ms gap the second log never opened: ${JSON.stringify(attempt)}`);
      assert.equal(attempt.sessions, 2,
        `at a ${attempt.gap} ms gap the app is holding ${attempt.sessions} sessions. The FIRST `
        + `log won a race it entered first and should have left first: ${JSON.stringify(attempt)}`);
      assert.equal(attempt.options, 2,
        `at a ${attempt.gap} ms gap the picker lists ${attempt.options} flights, not the two `
        + 'in the file that was asked for last');
      assert.ok(attempt.stats > 0,
        `at a ${attempt.gap} ms gap the session panel is empty — the open that won returned `
        + 'without ever painting');
      assert.match(attempt.status, new RegExp(`SECOND-${attempt.gap}\\.BBL`),
        `at a ${attempt.gap} ms gap the status line names the wrong file: ${attempt.status}`);
    }

    // THE assertion. The crash was a TypeError inside an async handler: it
    // changes nothing on screen and is reported nowhere but here.
    assert.deepEqual(pageErrors, [],
      `overlapping opens threw in the page: ${JSON.stringify(pageErrors)}`);
  });
});

test('a log that cannot be read takes the previous flight off the screen with it', {
  skip: browserSkip
}, async () => {
  await withViewer({}, async ({evaluate, pageErrors}) => {
    const run = await evaluate(`(async () => {
      const $ = id => document.getElementById(id);
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const share = (name, url) => window.dispatchEvent(
        new CustomEvent('rotorlens-file', {detail: {name, url}}));

      const {state} = await import('/ui/app.mjs');

      // 1. A good log, all the way to a flight on screen.
      share('GOOD.BBL', '${TWO_SESSIONS}');
      let opened = false;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if ($('session-stats').children.length > 0
            && $('status').textContent.includes('GOOD.BBL \\u2014')) {
          opened = true;
          break;
        }
        await sleep(25);
      }
      const before = {
        opened,
        stats: $('session-stats').children.length,
        options: $('session').options.length,
        panelsUp: !$('session-panel').classList.contains('hidden')
      };

      // 2. A share intent the shell can no longer serve. fromHostEvent rejects
      //    on any non-ok response, which is what a content URI revoked between
      //    the share and the read looks like from in here.
      share('GONE.BBL', '/fixtures/synthetic/does-not-exist.BBL');
      let reported = false;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if ($('status').textContent.includes('Could not read')) { reported = true; break; }
        await sleep(25);
      }
      await sleep(250);

      const after = {
        reported,
        message: $('status').textContent,
        // Every one of these must be DOWN. A panel left up over a null log is
        // the previous flight's numbers standing under the new file's name.
        sessionPanelUp: !$('session-panel').classList.contains('hidden'),
        plotPanelUp: !$('plot-panel').classList.contains('hidden'),
        fieldsPanelUp: !$('fields-panel').classList.contains('hidden'),
        axisPanelUp: !$('axis-panel').classList.contains('hidden'),
        statsLeft: $('session-stats').children.length,
        optionsLeft: $('session').options.length,
        fieldsLeft: $('fields').children.length,
        logHeld: state.result !== null
      };

      // 3. Press the two controls that used to throw. They are hidden now, so a
      //    pilot cannot reach them — but a hidden control still answers a
      //    dispatched event, and the point is that nothing anywhere throws.
      $('analyse').click();
      $('field').dispatchEvent(new Event('change'));
      await sleep(400);

      // 4. And the app is not wedged: a good log after a bad one still opens.
      share('AGAIN.BBL', '${TWO_SESSIONS}');
      let recovered = false;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if ($('session-stats').children.length > 0
            && $('status').textContent.includes('AGAIN.BBL \\u2014')) {
          recovered = true;
          break;
        }
        await sleep(25);
      }
      after.recovered = recovered;
      after.recoveredOptions = $('session').options.length;

      return JSON.stringify({before, after});
    })()`);

    // The setup has to have worked, or everything below passes for the wrong
    // reason: a screen that never had a flight on it cannot fail to clear one.
    assert.equal(run.before.opened, true, 'the first log never opened');
    assert.ok(run.before.stats > 0, 'the first log never rendered a session panel');
    assert.equal(run.before.options, 2, 'the first log never populated the picker');
    assert.equal(run.before.panelsUp, true, 'the first log never showed its panels');

    assert.equal(run.after.reported, true,
      'a share intent the shell could not read said nothing at all');
    assert.match(run.after.message, /Could not read the file/);

    // The heart of it: the log is gone, so the flight has to be gone too.
    assert.equal(run.after.logHeld, false, 'a failed open must not leave a log behind');
    assert.equal(run.after.sessionPanelUp, false,
      'the previous flight is still on screen under a file that could not be read. '
      + 'state.result is null underneath it, so every number on it belongs to another log '
      + 'and every control on it throws');
    assert.equal(run.after.plotPanelUp, false, 'the previous flight\'s plot is still up');
    assert.equal(run.after.fieldsPanelUp, false,
      'the previous flight\'s field table is still up');
    assert.equal(run.after.axisPanelUp, false, 'the previous flight\'s axis panel is still up');
    assert.equal(run.after.statsLeft, 0,
      'the stats markup was left inside a hidden panel — one CSS change from being back, and '
      + 'enough to make "is a flight on screen?" unanswerable from the DOM');
    assert.equal(run.after.optionsLeft, 0,
      'the picker still lists the previous log\'s flights');
    assert.equal(run.after.fieldsLeft, 0,
      'the field table still lists the previous log\'s fields');

    // A failed open that wedges the app is no better than one that lies.
    assert.equal(run.after.recovered, true, 'a good log after a failed one never opened');
    assert.equal(run.after.recoveredOptions, 2,
      'the recovered log did not populate the picker');

    // THE assertion. Both controls threw before, inside their own handlers,
    // where the pilot sees only a control that does nothing.
    assert.deepEqual(pageErrors, [],
      `a failed open left controls that throw when pressed: ${JSON.stringify(pageErrors)}`);
  });
});

test('a flight whose header is damaged says so instead of showing another flight\'s numbers', {
  skip: browserSkip
}, async () => {
  // A dataflash dump is a concatenation of independent sessions, so ONE of them
  // can be corrupt while the rest are fine — and that is not hypothetical on a
  // chip that has been power-cycled mid-write. The decoder already handled it:
  // such a session comes back with its errors attached and nothing to decode,
  // and the picker indexes by position so it must still be listed.
  //
  // What did not handle it was the screen. The option said "not opened yet",
  // indistinguishable from a healthy unopened flight; selecting it decoded
  // nothing and then died on `samples.length`; and the session panel was left
  // holding the PREVIOUS flight's firmware, craft, duration and sample count
  // under a picker that named the broken one. Wrong numbers under the right
  // heading, with nothing on screen to say so.
  //
  // The dump is built in memory by concatenating a committed fixture around a
  // junk header block. Nothing is written to disk — legitimate precisely
  // because sessions are independent and concatenated with no separator, which
  // is the property the whole lazy design rests on.
  await withViewer({}, async ({evaluate, pageErrors}) => {
    const run = await evaluate(`(async () => {
      const $ = id => document.getElementById(id);
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

      const good = new Uint8Array(await (await fetch('${TWO_SESSIONS}')).arrayBuffer());

      // A session header the parser rejects: the marker line that makes
      // findSessionStarts treat it as a session, then a field table declaring
      // two fields, one predictor and two encodings. parseSession raises
      // corrupt-header on that and never reaches a frame.
      //
      // It goes LAST. A header block is read until a line that is not a header,
      // so a junk block in the MIDDLE reads straight on into the next session's
      // headers and parses perfectly — measured: it came back with that
      // session's craft name and all 37 of its fields, and no error at all.
      const junk = new TextEncoder().encode(
        'H Product:Blackbox flight data recorder by Nicholas Sherlock\\n'
        + 'H Data version:2\\n'
        + 'H Field I name:time,gyroADC[0]\\n'
        + 'H Field I signed:0,1\\n'
        + 'H Field I predictor:0\\n'
        + 'H Field I encoding:1,0\\n'
      );

      const dump = new Uint8Array(good.length * 2 + junk.length);
      dump.set(good, 0);
      dump.set(good, good.length);
      dump.set(junk, good.length * 2);

      const transfer = new DataTransfer();
      transfer.items.add(new File([dump], 'MIXED.BBL'));
      const input = $('file');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change'));

      const {state} = await import('/ui/app.mjs');
      let opened = false;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (state.result && $('session-stats').children.length > 0) { opened = true; break; }
        await sleep(25);
      }

      const options = () => [...$('session').options].map(option => option.textContent);
      const sessions = state.result ? state.result.sessions : [];
      // Found by its errors rather than by position, so the assertion below
      // cannot pass by naming an index that happens to be something else.
      const brokenIndex = sessions.findIndex(
        session => Array.isArray(session.errors) && session.errors.length > 0
      );

      const listed = options();
      const healthyStats = $('session-stats').textContent;

      // Select the broken flight, the way a pilot would.
      const picker = $('session');
      picker.value = String(brokenIndex);
      picker.dispatchEvent(new Event('change'));
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (state.sessionIndex === brokenIndex) break;
        await sleep(25);
      }
      await sleep(300);

      const broken = {
        shownIndex: state.sessionIndex,
        stats: $('session-stats').textContent,
        issues: $('session-issues').textContent,
        // These measure samples there are none of, so they must be down.
        plotUp: !$('plot-panel').classList.contains('hidden'),
        fieldsUp: !$('fields-panel').classList.contains('hidden'),
        sessionPanelUp: !$('session-panel').classList.contains('hidden')
      };

      // And the rest of the dump still works: back to a healthy flight.
      picker.value = '0';
      picker.dispatchEvent(new Event('change'));
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (state.sessionIndex === 0 && sessions[0].samples
            && $('session-stats').children.length > 3) {
          break;
        }
        await sleep(25);
      }
      await sleep(200);

      return JSON.stringify({
        opened,
        count: sessions.length,
        brokenIndex,
        listed,
        healthyStats,
        broken,
        recoveredStats: $('session-stats').textContent,
        recoveredPlotUp: !$('plot-panel').classList.contains('hidden')
      });
    })()`);

    // The fixture has to actually contain a broken session, or nothing below is
    // about anything.
    assert.equal(run.opened, true, 'the mixed dump never opened');
    assert.equal(run.count, 5, `the mixed dump decoded ${run.count} sessions, not 5`);
    assert.ok(run.brokenIndex >= 0,
      `no session in the dump reported an error, so the junk header block parsed cleanly `
      + `and this test exercises nothing: ${JSON.stringify(run.listed)}`);

    // 1. The picker must not describe an unreadable flight as merely unopened.
    //    They are the two states a pilot has to be able to tell apart, and the
    //    difference is whether tapping it can ever do anything.
    assert.match(run.listed[run.brokenIndex], /cannot be read/,
      `the broken flight is offered as "${run.listed[run.brokenIndex]}" — a tap that can only `
      + 'fail, described exactly like one that will work');
    assert.ok(run.listed.filter(label => /not opened yet/.test(label)).length > 0,
      'no option says "not opened yet", so the assertion above cannot tell the two apart');

    // 2. Selecting it must not leave the previous flight's numbers standing.
    assert.equal(run.broken.shownIndex, run.brokenIndex, 'the broken flight was never selected');
    assert.notEqual(run.broken.stats, run.healthyStats,
      'the session panel still shows the HEALTHY flight\'s numbers under the broken flight\'s '
      + 'name. Every figure on screen belongs to a different flight');
    assert.match(run.broken.issues, /cannot be read/,
      `the panel must say why: it reads "${run.broken.issues.slice(0, 120)}"`);
    assert.equal(run.broken.plotUp, false,
      'the plot is still up over a flight with no samples in it');
    assert.equal(run.broken.fieldsUp, false,
      'the field table is still up over a flight with no fields in it');
    assert.equal(run.broken.sessionPanelUp, true,
      'the session panel went away entirely, so nothing tells the pilot what happened');

    // 3. One broken header costs one flight, not the file. Sessions are
    //    independent — that is the property this whole design rests on.
    assert.notEqual(run.recoveredStats, run.broken.stats,
      'going back to a healthy flight after a broken one did not re-render it');
    assert.equal(run.recoveredPlotUp, true,
      'the panels never came back, so one broken flight cost the whole dump');

    assert.deepEqual(pageErrors, [],
      `opening a damaged flight threw in the page: ${JSON.stringify(pageErrors)}`);
  });
});
