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
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createUiServer} from '../tools/serve-ui.mjs';
import {
  addFlightRecord, buildFlightRecord, createHistory, exportHistory
} from '../src/analysis/flight-history.mjs';
import {HOLD_EVIDENCE_KIND} from '../src/analysis/pid-evidence.mjs';

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
 * The decoder as the page receives it when a test asks for `faultableDecoder`.
 *
 * `decodeLog` is a module binding inside ui/app.mjs, so nothing in the page can
 * reach the sessions a FIRST open creates before `openSession(0)` has captured
 * one and started reading it. This stands in for src/blackbox/decode.mjs,
 * re-exports the real module (fetched under a query string, which the UI
 * server ignores and the interception does not match), and hands each result
 * to `globalThis.__rotorlensDecodeFault` when a test has set one — which is
 * where a test swaps in a session whose `decodeFrames` throws.
 *
 * Nothing in src/ or ui/ changes for it; this exists only on the wire.
 */
const FAULTABLE_DECODER = `
export * from './decode.mjs?real';
import {decodeLog as realDecodeLog} from './decode.mjs?real';
export function decodeLog(bytes, options) {
  const result = realDecodeLog(bytes, options);
  const fault = globalThis.__rotorlensDecodeFault;
  if (typeof fault === 'function') {
    fault(result);
  }
  return result;
}
`;

/**
 * Runs `body` against a freshly loaded viewer.
 *
 * `block` is a list of paths the browser must refuse, intercepted before the
 * request leaves — the same thing the WebView sees when an asset is missing
 * from the APK. `faultableDecoder` serves FAULTABLE_DECODER in place of the
 * decoder module.
 */
async function withViewer({block = [], startupScript = null, faultableDecoder = false} = {},
  body) {
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

    const decoderPath = '/src/blackbox/decode.mjs';
    const patterns = [
      ...block.map(target => ({urlPattern: `*${target}`, requestStage: 'Request'})),
      ...(faultableDecoder ? [{urlPattern: `*${decoderPath}`, requestStage: 'Request'}] : [])
    ];
    if (patterns.length > 0) {
      await client.send('Fetch.enable', {patterns}, sessionId);

      client.on(message => {
        if (message.method !== 'Fetch.requestPaused' || message.sessionId !== sessionId) {
          return;
        }
        const requested = new URL(message.params.request.url);
        if (faultableDecoder && requested.pathname === decoderPath && requested.search === '') {
          client.send('Fetch.fulfillRequest', {
            requestId: message.params.requestId,
            responseCode: 200,
            responseHeaders: [
              {name: 'Content-Type', value: 'text/javascript; charset=utf-8'},
              {name: 'Cache-Control', value: 'no-store'}
            ],
            body: Buffer.from(FAULTABLE_DECODER).toString('base64')
          }, sessionId).catch(() => { /* the page may already be gone */ });
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

/**
 * OWNER DECISION, 2 October 2026: the consent dialog is no longer raised by
 * itself after an analysis. It asks for a licence on community-contribution
 * terms that its own footnote calls an unreviewed draft, and this build cannot
 * send anything anyway. `AUTOMATIC_SHARING_PROMPT` in ui/app.mjs is the switch.
 *
 * This test used to pin the opposite — that the automatic prompt fired, and
 * deferred while About & Legal was on top. It now pins that the automatic path
 * stays shut even over an admissible flight with nothing covering it, and keeps
 * the About deferral covered through the path that still exists: the Share
 * button on the sharing panel.
 */
test('the consent dialog is never raised automatically, and the panel path defers to About', {
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
      const sharingToggle = () => document.getElementById('sharing-toggle');

      for (let attempt = 0; attempt < 200 && !(app.state.sharingWritable && sharingToggle());
        attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }

      // 1. The automatic path, with every condition it used to need met: a
      //    candidate flight, a writable store, a question never answered, and
      //    nothing on top of the page.
      app.state.candidate = {forced: 'automatic-consent-path'};
      app.maybeAskToShare();
      await new Promise(resolve => setTimeout(resolve, 0));
      const automatic = {
        flag: app.AUTOMATIC_SHARING_PROMPT,
        writable: app.state.sharingWritable,
        asked: app.state.sharing?.asked ?? null,
        consentOpen: !consent.classList.contains('hidden'),
        stateOpen: app.state.consentOpen,
        mainInert: main.hasAttribute('inert'),
        writes: window.__sharingWrites()
      };

      // 2. About on top, and the panel's Share button pressed underneath it.
      //    The click is counted where the app's own delegated handler listens,
      //    so the assertion below cannot pass merely because the inert page
      //    swallowed the click before the consent gate ever saw it.
      let panelClicks = 0;
      document.getElementById('sharing').addEventListener('click', () => {
        panelClicks += 1;
      });
      toggle.focus();
      toggle.click();
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
      sharingToggle().click();
      await new Promise(resolve => setTimeout(resolve, 0));

      const covered = {
        panelClicks,
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

      const afterEscape = {
        legalOpen: !legal.classList.contains('hidden'),
        consentOpen: !consent.classList.contains('hidden'),
        headerInert: header.hasAttribute('inert'),
        mainInert: main.hasAttribute('inert'),
        focus: document.activeElement?.id ?? null,
        writes: window.__sharingWrites()
      };

      toggle.click();
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
      const handledBack = window.RotorLensHandleBack();
      await new Promise(resolve => setTimeout(resolve, 0));
      const afterAndroidBack = {
        handled: handledBack,
        legalOpen: !legal.classList.contains('hidden'),
        consentOpen: !consent.classList.contains('hidden'),
        headerInert: header.hasAttribute('inert'),
        mainInert: main.hasAttribute('inert'),
        focus: document.activeElement?.id ?? null,
        writes: window.__sharingWrites()
      };

      // 3. The manual path, with nothing on top: the dialog still opens, on
      //    the declining answer, and opening it records nothing.
      sharingToggle().click();
      await new Promise(resolve => setTimeout(resolve, 0));
      const manual = {
        consentOpen: !consent.classList.contains('hidden'),
        stateOpen: app.state.consentOpen,
        mainInert: main.hasAttribute('inert'),
        focus: document.activeElement?.id ?? null,
        writes: window.__sharingWrites()
      };
      document.getElementById('consent-not-now').click();
      for (let attempt = 0; attempt < 200 && app.state.consentOpen; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const declined = {
        consentOpen: !consent.classList.contains('hidden'),
        mainInert: main.hasAttribute('inert'),
        writes: window.__sharingWrites()
      };

      return JSON.stringify({
        automatic, covered, afterEscape, afterAndroidBack, manual, declined
      });
    })()`);

    // 1. Never automatically. The setup lines first: the old gate refused
    //    without a writable store or with the question already answered, so
    //    "not shown" proves nothing unless both were in the asking state.
    assert.equal(result.automatic.writable, true,
      'the sharing store is not writable, so the automatic gate would refuse for that reason');
    assert.equal(result.automatic.asked, false,
      'the question was already answered, so the automatic gate would refuse for that reason');
    assert.equal(result.automatic.consentOpen, false,
      'the consent dialog opened by itself after an analysis. Its licence terms are an '
      + 'unreviewed draft, and the owner turned the automatic prompt off on 2 October 2026');
    assert.equal(result.automatic.stateOpen, false);
    assert.equal(result.automatic.mainInert, false,
      'the page was made inert behind a dialog nobody asked for');
    assert.equal(result.automatic.writes, 0);
    assert.equal(result.automatic.flag, false,
      'AUTOMATIC_SHARING_PROMPT must stay false until the owner adopts reviewed terms');

    // 2. The panel path, pressed underneath About & Legal.
    assert.equal(result.covered.panelClicks, 1,
      'the Share click never reached the sharing panel, so this does not test the consent gate');
    assert.equal(result.covered.legalOpen, true);
    assert.equal(result.covered.consentOpen, false,
      'the consent dialog must not compose underneath About & Legal');
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

    // 3. The path that remains still works.
    assert.equal(result.manual.consentOpen, true,
      'the Share button on the sharing panel must still open the complete terms');
    assert.equal(result.manual.stateOpen, true);
    assert.equal(result.manual.mainInert, true);
    assert.equal(result.manual.focus, 'consent-not-now',
      'the dialog must open on the declining answer');
    assert.equal(result.manual.writes, 0, 'opening the terms is not itself an answer');
    assert.equal(result.declined.consentOpen, false);
    assert.equal(result.declined.mainInert, false);
    assert.equal(result.declined.writes, 1, '"Not now" records exactly one declined answer');
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
    // The automatic prompt is off, so "RotorLens will ask again" would be a
    // promise this build does not keep.
    assert.doesNotMatch(result.text, /will ask again/i);
    assert.match(result.text, /will not ask on its own/i);
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
    assert.doesNotMatch(result.text, /press Share measurements/i,
      'the panel sends the pilot to the button it has just disabled');
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
      // Opened the way it can still open: from the Share button on the sharing
      // panel. The automatic prompt is off since 2 October 2026 (see
      // AUTOMATIC_SHARING_PROMPT), so forcing the dialog up through state would
      // be testing a screen no pilot can reach.
      for (let attempt = 0; attempt < 200
        && !(state.sharingWritable && document.getElementById('sharing-toggle'));
        attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      document.getElementById('sharing-toggle').click();
      await new Promise(resolve => setTimeout(resolve, 0));
      const opened = {
        open: state.consentOpen,
        shown: !document.getElementById('consent').classList.contains('hidden'),
        mainInert: document.querySelector('main').inert,
        writes: window.__sharingWrites()
      };

      window.dispatchEvent(new CustomEvent('rotorlens-import-started', {detail: {
        name: 'replacement.LOG', total: -1, generation: 41
      }}));
      await new Promise(resolve => setTimeout(resolve, 20));
      return JSON.stringify({
        opened,
        open: state.consentOpen,
        hidden: document.getElementById('consent').classList.contains('hidden'),
        headerInert: document.querySelector('header').inert,
        mainInert: document.querySelector('main').inert,
        active: document.activeElement?.id ?? null,
        writes: window.__sharingWrites()
      });
    })()`);

    assert.equal(result.opened.open, true, 'the Share button never opened the consent dialog');
    assert.equal(result.opened.shown, true);
    assert.equal(result.opened.mainInert, true);
    assert.equal(result.opened.writes, 0);
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

      // Let the healthy flight's analysis finish, so its advice and its
      // before/after panel are on screen to be left behind. Selecting the broken
      // flight before then would retire the analysis mid-run and prove nothing.
      let analysed = false;
      for (let attempt = 0; attempt < 800; attempt += 1) {
        if ($('recommend-status').textContent.length > 0
            && !$('since-panel').classList.contains('hidden')) {
          analysed = true;
          break;
        }
        await sleep(25);
      }
      const healthy = {
        analysed,
        answer: $('recommend-answer').textContent,
        sinceUp: !$('since-panel').classList.contains('hidden')
      };

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
        sessionPanelUp: !$('session-panel').classList.contains('hidden'),
        // The before/after lives outside the measurement panels, so it needs
        // its own check: it carries a Save button for the PREVIOUS flight.
        sinceUp: !$('since-panel').classList.contains('hidden'),
        since: $('since').textContent,
        answer: $('recommend-answer').textContent,
        admission: state.candidateAdmission
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
        healthy,
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

    // The healthy flight's advice and its before/after panel. The setup first:
    // a panel that was never up cannot fail to come down.
    assert.equal(run.healthy.analysed, true, 'the healthy flight never finished its analysis');
    assert.notEqual(run.healthy.answer, '', 'the healthy flight never put an answer up');
    assert.equal(run.healthy.sinceUp, true, 'the healthy flight never showed its before/after');
    assert.equal(run.broken.sinceUp, false,
      'the HEALTHY flight\'s before/after panel, Save button and all, is still up under a flight '
      + `that cannot be read: "${run.broken.since.slice(0, 120)}"`);
    assert.equal(run.broken.since, '', 'the before/after markup was left behind');
    assert.equal(run.broken.admission, null,
      'the healthy flight is still the candidate for saving under the broken one');
    assert.equal(run.broken.answer, '',
      'the healthy flight\'s answer is still in the page under the broken flight');

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

/**
 * In-page helpers shared by the tests below. Plain text spliced into each
 * `evaluate` body, so every test drives the same real controls the same way.
 *
 * `screen()` reads every panel that measures a flight, because the defects
 * these tests guard all have one shape: a panel left up, or a panel's markup
 * left in place, after the flight it described has gone.
 */
const PAGE_HELPERS = `
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const up = id => !$(id).classList.contains('hidden');
  const waitFor = async (condition, attempts = 800) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (condition()) return true;
      await sleep(25);
    }
    return false;
  };
  const openBytes = (bytes, name) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], name));
    const input = $('file');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));
  };
  // A flight that has been analysed all the way: the advice has its provenance
  // line, the before/after panel has had its say, and the axis numbers are up.
  const analysed = () => $('recommend-status').textContent.length > 0
    && up('since-panel') && $('axis-stats').children.length > 0;
  const screen = () => ({
    answer: $('recommend-answer').textContent,
    recommend: $('recommend').textContent,
    recommendStatus: $('recommend-status').textContent,
    recommendUp: up('recommend-panel'),
    since: $('since').textContent,
    sinceUp: up('since-panel'),
    axisStats: $('axis-stats').textContent,
    axisUp: up('axis-panel'),
    windowUp: up('window-panel'),
    tuneUp: up('tune-panel'),
    plotUp: up('plot-panel'),
    fieldsUp: up('fields-panel'),
    sessionUp: up('session-panel'),
    issues: $('session-issues').textContent,
    status: $('status').textContent,
    progressUp: up('decode-progress')
  });
`;

const TRUNCATED_HEADER = '/fixtures/synthetic/rf46-truncated-header.TXT';
const STOP_MANOEUVRES = '/fixtures/synthetic/rf46-stop-manoeuvres.TXT';

/** Every panel that measures a flight must be down, and its numbers gone. */
function assertFlightTakenDown(view, label) {
  assert.equal(view.answer, '',
    `${label}: the previous flight's "What to change" answer is still on the page: `
    + `"${view.answer.slice(0, 120)}"`);
  assert.equal(view.recommend, '',
    `${label}: the previous flight's advice cards are still in the page`);
  assert.equal(view.recommendStatus, '',
    `${label}: the previous flight's "Measured over…" line is still in the page`);
  assert.equal(view.recommendUp, false, `${label}: the advice panel is still up`);
  assert.equal(view.sinceUp, false,
    `${label}: the previous flight's before/after panel is still up, Save button and all`);
  assert.equal(view.since, '', `${label}: the before/after markup was left behind`);
  assert.equal(view.axisStats, '',
    `${label}: the previous flight's axis numbers are still in the page: `
    + `"${view.axisStats.slice(0, 120)}"`);
  assert.equal(view.axisUp, false, `${label}: the axis panel is still up`);
  assert.equal(view.windowUp, false, `${label}: the flight-window panel is still up`);
  assert.equal(view.tuneUp, false, `${label}: the tune panel is still up`);
  assert.equal(view.plotUp, false, `${label}: the plot panel is still up`);
  assert.equal(view.fieldsUp, false, `${label}: the field table is still up`);
  assert.equal(view.sessionUp, true,
    `${label}: the session panel went away, so nothing on screen says what happened`);
}

test('a flight with a header and no frames takes the previous flight down and says why', {
  skip: browserSkip
}, async () => {
  // rf46-truncated-header.TXT parses to 37 fields and 0 samples: a log whose
  // header was written and whose frames never arrived, which is what a power
  // loss or an immediate disarm leaves. `summarizeAxis` returns null for no
  // samples, and the axis panel dereferenced that and threw — inside an async
  // handler, so the previous flight's advice and axis numbers stayed on screen
  // under the new file's name, and the open never finished.
  //
  // Driven three ways: as the only flight in a file opened after a healthy
  // one, as the last flight of a dump reached through the picker, and back to
  // a healthy flight afterwards.
  await withViewer({}, async ({evaluate, pageErrors}) => {
    const run = await evaluate(`(async () => {
      ${PAGE_HELPERS}
      const {state} = await import('/ui/app.mjs');
      const good = new Uint8Array(await (await fetch('${TWO_SESSIONS}')).arrayBuffer());
      const empty = new Uint8Array(await (await fetch('${TRUNCATED_HEADER}')).arrayBuffer());

      // 1. A healthy flight, analysed all the way to advice and axis numbers.
      openBytes(good, 'GOOD.BBL');
      const goodReady = await waitFor(analysed);
      const before = screen();

      // 2. A file whose only flight has a header and no frames.
      openBytes(empty, 'EMPTY.TXT');
      const emptyOpened = await waitFor(() => state.result?.sessions?.[0]?.framesDecoded === true
        && $('status').textContent.includes('EMPTY.TXT'));
      await sleep(400);
      const emptySession = state.result?.sessions?.[0];
      const afterOpen = {
        ...screen(),
        fields: emptySession?.fields?.length ?? -1,
        samples: emptySession?.samples?.length ?? -1
      };

      // 3. The same shape as the LAST flight of a dump cut after its header,
      //    reached through the picker. Built in memory; sessions are
      //    concatenated with no separator, so this is a real dump's layout.
      const dump = new Uint8Array(good.length + empty.length);
      dump.set(good, 0);
      dump.set(empty, good.length);
      openBytes(dump, 'CUT.BBL');
      const dumpReady = await waitFor(() => state.result?.sessions?.length === 3
        && $('status').textContent.includes('CUT.BBL') && analysed());
      const beforeSwitch = screen();
      const picker = $('session');
      picker.value = '2';
      picker.dispatchEvent(new Event('change'));
      const switched = await waitFor(() => state.sessionIndex === 2
        && state.result.sessions[2].framesDecoded === true);
      await sleep(400);
      const cut = state.result.sessions[2];
      const afterSwitch = {
        ...screen(),
        picked: picker.value,
        fields: cut.fields.length,
        samples: cut.samples ? cut.samples.length : -1
      };

      // 4. And back. One empty flight costs one flight, not the file.
      picker.value = '0';
      picker.dispatchEvent(new Event('change'));
      const recovered = await waitFor(() => state.sessionIndex === 0 && analysed());

      return JSON.stringify({
        goodReady, before, emptyOpened, afterOpen,
        dumpReady, beforeSwitch, switched, afterSwitch,
        recovered, recoveredScreen: screen()
      });
    })()`);

    // The setup has to have worked, or every assertion below passes for the
    // wrong reason: a screen that never had advice on it cannot fail to clear it.
    assert.equal(run.goodReady, true, 'the healthy log never finished its analysis');
    assert.notEqual(run.before.answer, '', 'the healthy log never put an answer up');
    assert.notEqual(run.before.axisStats, '', 'the healthy log never put axis numbers up');
    assert.equal(run.emptyOpened, true, 'the header-only file never finished opening');
    assert.ok(run.afterOpen.fields > 0 && run.afterOpen.samples === 0,
      `the fixture must be a parsed header with no frames, and it decoded to `
      + `${run.afterOpen.fields} fields and ${run.afterOpen.samples} samples`);

    // A file opened after a healthy one.
    assertFlightTakenDown(run.afterOpen, 'header-only file');
    assert.match(run.afterOpen.issues, /no flight data was recorded/i,
      `the session panel must say why there is nothing: "${run.afterOpen.issues.slice(0, 160)}"`);
    // The fixture's decoder skipped 11 bytes after its header: too few to have
    // held a single frame, so "ends at, or just after, its header" is what the
    // bytes say. A header followed by kilobytes nobody could decode is a
    // different fault with a different sentence — see the test after this one.
    assert.match(run.afterOpen.issues, /ends at, or just after, its header/i);
    assert.doesNotMatch(run.afterOpen.issues, /could not be decoded/i,
      'a log that simply stops after its header was described as an undecodable one');
    assert.doesNotMatch(run.afterOpen.issues, /header block is damaged/i,
      'the header was read; calling it damaged sends the pilot after the wrong fault');
    assert.match(run.afterOpen.status, /EMPTY\.TXT/);
    assert.match(run.afterOpen.status, /read in \d+ ms/,
      'the open never completed: the status line is the one painted BEFORE the flight was read, '
      + `so everything after the read was skipped: "${run.afterOpen.status}"`);
    // NOT asserted here: whether the decode progress bar came down. A 1.3 KiB
    // file never shows it (the bar waits for 2 MiB or 300 ms), so that
    // assertion held with `endDecodeProgress` deleted. The test of the bar
    // opens a file big enough to raise it.

    // The last flight of a dump, through the picker.
    assert.equal(run.dumpReady, true, 'the cut dump never finished its first analysis');
    assert.notEqual(run.beforeSwitch.answer, '',
      'the first flight of the cut dump never put an answer up');
    assert.equal(run.switched, true, 'the header-only flight was never selected');
    assert.equal(run.afterSwitch.picked, '2');
    assert.ok(run.afterSwitch.fields > 0 && run.afterSwitch.samples === 0,
      `the last flight of the dump must be a header with no frames: `
      + `${run.afterSwitch.fields} fields, ${run.afterSwitch.samples} samples`);
    assertFlightTakenDown(run.afterSwitch, 'header-only flight in a dump');
    assert.match(run.afterSwitch.issues, /no flight data was recorded/i);
    assert.match(run.afterSwitch.status, /session 3 read in \d+ ms/,
      `the switch never completed: "${run.afterSwitch.status}"`);

    assert.equal(run.recovered, true, 'going back to a healthy flight never re-analysed it');
    assert.equal(run.recoveredScreen.recommendUp, true);
    assert.notEqual(run.recoveredScreen.axisStats, '');

    assert.deepEqual(pageErrors, [],
      `a flight with no frames threw in the page: ${JSON.stringify(pageErrors)}`);
  });
});

test('moving the flight window retires tune evidence measured over the old window', {
  skip: browserSkip
}, async () => {
  // The Tune evidence panel is a measurement of the flight window, like every
  // other number on the page. All three ways of moving the window re-measured
  // everything else and left it standing — still counting stops that now lay
  // outside the window — while the marks it had drawn on the trace were wiped.
  await withViewer({}, async ({evaluate, pageErrors}) => {
    const run = await evaluate(`(async () => {
      ${PAGE_HELPERS}
      const placeholder = () => /Pick a term and analyse/.test($('tune').textContent);
      const tune = () => ({
        text: $('tune').textContent.replace(/[ ]+/g, ' ').trim().slice(0, 160),
        placeholder: placeholder()
      });
      const analyseNow = () => {
        $('analyse').click();
        return tune();
      };

      const bytes = new Uint8Array(await (await fetch('${STOP_MANOEUVRES}')).arrayBuffer());
      openBytes(bytes, 'STOPS.BBL');
      const ready = await waitFor(analysed);

      $('axis').value = 'roll';
      $('axis').dispatchEvent(new Event('change'));
      $('term').value = 'P';

      const analysedWhole = analyseNow();
      $('window-whole').click();
      const afterWhole = tune();

      const analysedDetect = analyseNow();
      $('window-detect').click();
      const afterDetect = tune();

      const analysedSlider = analyseNow();
      const start = $('window-start');
      const sliderUsable = !start.disabled;
      start.value = String(Math.min(900, Number(start.value) + 100));
      start.dispatchEvent(new Event('input'));
      start.dispatchEvent(new Event('change'));
      const afterSlider = tune();

      return JSON.stringify({
        ready, sliderUsable,
        analysedWhole, afterWhole,
        analysedDetect, afterDetect,
        analysedSlider, afterSlider
      });
    })()`);

    assert.equal(run.ready, true, 'the log never finished its first analysis');
    assert.equal(run.sliderUsable, true, 'the window sliders were disabled on this log');

    for (const [path, analysed, after] of [
      ['Whole log', run.analysedWhole, run.afterWhole],
      ['Use the detected flight', run.analysedDetect, run.afterDetect],
      ['dragging Takeoff', run.analysedSlider, run.afterSlider]
    ]) {
      // Without this the assertion after it cannot fail: a panel that never
      // left the placeholder cannot be shown to return to it.
      assert.equal(analysed.placeholder, false,
        `Analyse did not replace the placeholder before ${path}: "${analysed.text}"`);
      assert.equal(after.placeholder, true,
        `after ${path} the Tune evidence panel still shows evidence measured over the OLD `
        + `window: "${after.text}"`);
    }
    // There used to be a check here, 600 ms later, that the re-run analysis had
    // not put old tune evidence back. Nothing in the analysis writes #tune, so
    // once the three assertions above hold it could not fail; it was removed
    // rather than kept as a check that only looks like one.
    assert.deepEqual(pageErrors, []);
  });
});

test('a decoder fault on a session switch stays on screen and takes the previous flight down', {
  skip: browserSkip
}, async () => {
  // `decodeFrames()` throwing is a decoder defect or an allocation failure
  // under memory pressure — rare, and exactly when the pilot most needs to be
  // told. openSession wrote "Decoder fault" and returned; the picker's handler
  // then repainted the status line over it with a normal "read in 0 ms", and
  // the previous flight's advice, before/after and axis numbers stayed up under
  // a picker naming the flight that failed.
  //
  // The decoder defines `decodeFrames` non-writable, so the fault is injected
  // by standing a session in front of the real one that inherits everything
  // from it and throws from `decodeFrames` — the one thing that differs.
  await withViewer({}, async ({evaluate, pageErrors}) => {
    const run = await evaluate(`(async () => {
      ${PAGE_HELPERS}
      const {state} = await import('/ui/app.mjs');
      const bytes = new Uint8Array(await (await fetch('${TWO_SESSIONS}')).arrayBuffer());
      openBytes(bytes, 'PAIR.BBL');
      const ready = await waitFor(() => state.result?.sessions?.length === 2 && analysed());
      const before = screen();

      const beforeAdmission = state.candidateAdmission;
      const real = state.result.sessions[1];
      const unopened = real.framesDecoded === false;
      // What was still on screen at the moment the new flight began to be
      // read — the one moment a slow decode lets a pilot see. Every end state
      // is cleared again later by the fault, so only this can show whether the
      // previous flight's advice was retired BEFORE the read.
      let duringRead = null;
      state.result.sessions[1] = Object.create(real, {
        decodeFrames: {value() {
          duringRead = {
            answer: $('recommend-answer').textContent,
            recommend: $('recommend').textContent,
            sinceUp: up('since-panel'),
            since: $('since').textContent,
            admission: state.candidateAdmission
          };
          throw new RangeError('Invalid array length');
        }}
      });

      const picker = $('session');
      picker.value = '1';
      picker.dispatchEvent(new Event('change'));
      const switched = await waitFor(() => state.sessionIndex === 1);
      await sleep(400);
      return JSON.stringify({
        ready, before, beforeAdmission, unopened, switched, duringRead,
        after: {
          ...screen(),
          picked: picker.value,
          admission: state.candidateAdmission
        }
      });
    })()`);

    assert.equal(run.ready, true, 'the log never finished its first analysis');
    assert.notEqual(run.before.answer, '', 'the first flight never put an answer up');
    assert.equal(run.before.sinceUp, true, 'the first flight never showed its before/after panel');
    assert.equal(run.unopened, true,
      'the second flight was already read, so the switch never reaches decodeFrames()');
    assert.equal(run.switched, true);
    assert.equal(run.after.picked, '1');

    assert.match(run.after.status, /Decoder fault: Invalid array length/,
      `the fault was painted over: the status line reads "${run.after.status}"`);
    assertFlightTakenDown(run.after, 'decoder fault');
    assert.match(run.after.issues, /could not read this flight/i,
      `the session panel must say this flight was not read: "${run.after.issues.slice(0, 160)}"`);
    // The setup line for the two below: the first flight had been judged for
    // saving, so there was a before/after to retire. (It is not admissible, so
    // `state.candidate` was null all along and is not asserted on.)
    assert.notEqual(run.beforeAdmission, null, 'the first flight was never judged for saving');
    assert.equal(run.after.admission, null,
      'the previous flight is still the candidate for saving under a flight that failed');

    // RETIRED BEFORE THE READ, not merely by the time it failed. Picking a
    // flight must take the previous one's advice and before/after down before
    // reading a byte of the new one: on a large dump that read takes seconds,
    // and for all of them the old answer stood under a picker naming the new
    // flight.
    assert.ok(run.duringRead, 'decodeFrames() was never entered, so nothing here was measured');
    assert.equal(run.duringRead.answer, '',
      `while the new flight was being read, the previous flight's answer was still up: `
      + `"${run.duringRead.answer.slice(0, 120)}"`);
    assert.equal(run.duringRead.recommend, '', 'and its advice cards');
    assert.equal(run.duringRead.sinceUp, false, 'and its before/after panel');
    assert.equal(run.duringRead.since, '', 'and its before/after markup');
    assert.equal(run.duringRead.admission, null, 'and it was still the candidate for saving');
    // The progress bar is not asserted here: a 14 KiB session never raises it,
    // so the check could not fail. The bar has its own test with a session big
    // enough to show it.
    assert.deepEqual(pageErrors, []);
  });
});

/**
 * In-page, after PAGE_HELPERS: the two-session fixture, where its first
 * flight's header block ends, and a builder for that header followed by bytes
 * no decoder can read as a frame. Built in memory; nothing is written to disk.
 *
 * A newline every KiB of junk keeps the header parser from reading the junk as
 * one header line longer than it allows, so the junk reaches the FRAME
 * decoder — which is the case being built.
 */
const BODY_BUILDERS = `
  const good = new Uint8Array(await (await fetch('${TWO_SESSIONS}')).arrayBuffer());
  let headerEnd = 0;
  for (let index = 0; index < good.length - 1; index += 1) {
    if (good[index] === 10 && good[index + 1] !== 72) { headerEnd = index + 1; break; }
  }
  const undecodable = length => {
    const bytes = new Uint8Array(headerEnd + length);
    bytes.set(good.subarray(0, headerEnd), 0);
    bytes.fill(0xff, headerEnd);
    for (let index = headerEnd + 1023; index < bytes.length; index += 1024) {
      bytes[index] = 10;
    }
    return bytes;
  };
`;

test('a flight whose frames cannot be decoded, or that holds one sample, says exactly that', {
  skip: browserSkip
}, async () => {
  // MEASURED. A header followed by kilobytes the decoder cannot read decodes to
  // the same shape as a log that stops at its header — fields, no samples, one
  // corrupt-frame error — apart from how many bytes the decoder skipped. The
  // panel told both that the log ended at its header, "what a log looks like
  // when power was lost or the model was disarmed", with the decoder's own
  // corrupt-frame code printed directly above: the pilot was sent after the
  // wrong fault. And a flight cut one frame after its header went the whole
  // analysis path, which put "The analysis could not be run" over axis numbers
  // measured from a single sample.
  await withViewer({}, async ({evaluate, pageErrors}) => {
    const run = await evaluate(`(async () => {
      ${PAGE_HELPERS}
      ${BODY_BUILDERS}
      const {state} = await import('/ui/app.mjs');
      const {decodeLog} = await import('/src/blackbox/decode.mjs');

      // The shortest cut of the first flight that holds exactly one sample.
      let oneSample = null;
      for (let length = headerEnd; length < good.length && oneSample === null; length += 1) {
        const probe = decodeLog(good.subarray(0, length), {lazy: true}).sessions[0];
        probe.decodeFrames();
        if (probe.samples.length === 1) { oneSample = good.slice(0, length); }
        if (probe.samples.length > 1) { break; }
      }

      // Each one opened over a healthy flight that was analysed all the way, so
      // there is advice on screen to be left behind.
      const openAfterHealthy = async (bytes, name) => {
        openBytes(good, 'GOOD-' + name);
        const ready = await waitFor(analysed);
        openBytes(bytes, name);
        const opened = await waitFor(() => state.result?.sessions?.[0]?.framesDecoded === true
          && $('status').textContent.includes(name + ' ')
          && $('status').textContent.includes('read in'));
        await sleep(400);
        const session = state.result?.sessions?.[0];
        return {
          ready,
          opened,
          ...screen(),
          samples: session?.samples?.length ?? -1,
          fields: session?.fields?.length ?? -1,
          skipped: session?.frameCounts?.resyncBytes ?? -1
        };
      };

      return JSON.stringify({
        headerEnd,
        found: oneSample !== null,
        junk: await openAfterHealthy(undecodable(6000), 'JUNK.BBL'),
        single: oneSample === null ? null : await openAfterHealthy(oneSample, 'ONE.BBL')
      });
    })()`);

    assert.ok(run.headerEnd > 0, 'the header block was never found, so nothing was built from it');

    // A header, then 6000 bytes that are not frames.
    const {junk} = run;
    assert.equal(junk.ready, true, 'the healthy flight before it never finished its analysis');
    assert.equal(junk.opened, true, 'the undecodable flight never finished opening');
    assert.ok(junk.fields > 0 && junk.samples === 0 && junk.skipped >= 6000,
      `the fixture must be a parsed header and 6000 skipped bytes: ${junk.fields} fields, `
      + `${junk.samples} samples, ${junk.skipped} bytes skipped`);
    assertFlightTakenDown(junk, 'undecodable flight');
    assert.match(junk.issues, /could not be decoded/i,
      `the panel must say the recorded data could not be read: "${junk.issues.slice(0, 240)}"`);
    assert.match(junk.issues, /\d+ KiB/, 'and how much of it there was');
    assert.match(junk.issues, /Unrecognized frame marker/,
      'and what the decoder itself said, so the code above it means something');
    assert.doesNotMatch(junk.issues,
      /no flight data was recorded|ends at, or just after|power was lost|disarmed/i,
      'kilobytes of unreadable frames were explained as a log that stopped at its header');

    // A flight with exactly one sample.
    assert.equal(run.found, true, 'no cut of the fixture holds exactly one sample');
    const {single} = run;
    assert.equal(single.ready, true, 'the healthy flight before it never finished its analysis');
    assert.equal(single.opened, true, 'the one-sample flight never finished opening');
    assert.equal(single.samples, 1, `the fixture must hold one sample, not ${single.samples}`);
    assertFlightTakenDown(single, 'one-sample flight');
    assert.match(single.issues, /one sample/i,
      `the panel must say there is one sample: "${single.issues.slice(0, 240)}"`);
    assert.doesNotMatch(single.issues, /could not be decoded/i,
      'a cleanly cut flight was described as an undecodable one');

    assert.deepEqual(pageErrors, [],
      `an unreadable or one-sample flight threw in the page: ${JSON.stringify(pageErrors)}`);
  });
});

test('the decode progress bar comes down after an open that shows no flight, and after a '
  + 'decoder fault on the first open', {
  skip: browserSkip
}, async () => {
  // The bar appears only for 2 MiB or more, or after 300 ms, so every fixture
  // the other tests open is too small to raise it — and their "the bar is not
  // up" assertions held with `endDecodeProgress` deleted. These open a 2.2 MiB
  // flight built in memory, and first check the bar did appear.
  //
  // The first-open fault needs the fault inside `openFile`'s own
  // `openSession(0)`, which nothing in the page can reach in time:
  // `faultableDecoder` hands each decode result to the hook below.
  await withViewer({faultableDecoder: true}, async ({evaluate, pageErrors}) => {
    const run = await evaluate(`(async () => {
      ${PAGE_HELPERS}
      ${BODY_BUILDERS}
      const {state} = await import('/ui/app.mjs');
      let raised = false;
      new MutationObserver(() => {
        if (up('decode-progress')) { raised = true; }
      }).observe($('decode-progress'), {attributes: true, attributeFilter: ['class']});

      const big = undecodable(Math.round(2.2 * 1024 * 1024));
      const dump = new Uint8Array(good.length + big.length);
      dump.set(good, 0);
      dump.set(big, good.length);

      // 1. A first open of a file whose only flight has no readable frames.
      raised = false;
      openBytes(big, 'BIG.BBL');
      const bigOpened = await waitFor(() => state.result?.sessions?.[0]?.framesDecoded === true
        && $('status').textContent.includes('BIG.BBL ')
        && $('status').textContent.includes('read in'));
      await sleep(300);
      const firstOpen = {
        opened: bigOpened, raised, upAfter: up('decode-progress'),
        issues: $('session-issues').textContent
      };

      // 2. A picker switch to such a flight, inside a dump.
      openBytes(dump, 'DUMP.BBL');
      const dumpReady = await waitFor(() => state.result?.sessions?.length === 3 && analysed());
      const picker = $('session');
      raised = false;
      picker.value = '2';
      picker.dispatchEvent(new Event('change'));
      const switchedTo = await waitFor(() => state.sessionIndex === 2
        && state.result.sessions[2].framesDecoded === true);
      await sleep(300);
      const switched = {
        ready: dumpReady, switched: switchedTo, raised, upAfter: up('decode-progress')
      };

      // 3. A decoder fault on the FIRST open of a file, with a healthy flight
      //    on screen beforehand to be taken down.
      openBytes(good, 'GOOD.BBL');
      const goodReady = await waitFor(analysed);
      const beforeFault = screen();
      globalThis.__rotorlensDecodeFault = result => {
        globalThis.__rotorlensDecodeFault = null;
        const real = result.sessions[0];
        result.sessions[0] = Object.create(real, {
          decodeFrames: {value() { throw new RangeError('PROBE fault'); }}
        });
      };
      raised = false;
      openBytes(dump, 'FAULT.BBL');
      const faulted = await waitFor(() => $('status').textContent.includes('Decoder fault'), 400);
      await sleep(400);
      const fault = {
        faulted,
        raised,
        ...screen(),
        options: $('session').options.length,
        upAfter: up('decode-progress')
      };

      // 4. One failed flight costs one flight: the rest of the file opens.
      picker.value = '1';
      picker.dispatchEvent(new Event('change'));
      const recovered = await waitFor(() => state.sessionIndex === 1 && analysed());

      return JSON.stringify({firstOpen, switched, goodReady, beforeFault, fault, recovered});
    })()`);

    assert.equal(run.firstOpen.opened, true, 'the 2.2 MiB flight never finished opening');
    assert.equal(run.firstOpen.raised, true,
      'the progress bar never appeared, so its coming down below would prove nothing');
    assert.equal(run.firstOpen.upAfter, false,
      'the decode progress bar was left up after a first open that showed no flight');
    assert.match(run.firstOpen.issues, /could not be decoded/i);

    assert.equal(run.switched.ready, true, 'the dump never finished its first analysis');
    assert.equal(run.switched.switched, true, 'the 2.2 MiB flight was never selected');
    assert.equal(run.switched.raised, true,
      'the progress bar never appeared for the switch, so its coming down would prove nothing');
    assert.equal(run.switched.upAfter, false,
      'the decode progress bar was left up after switching to a flight with nothing to show');

    assert.equal(run.goodReady, true, 'the healthy flight never finished its analysis');
    assert.notEqual(run.beforeFault.answer, '', 'the healthy flight never put an answer up');
    assert.equal(run.fault.raised, true,
      'the progress bar never appeared for the faulting open, so its state proves nothing');
    assert.equal(run.fault.faulted, true,
      `the decoder fault never stayed on the status line, which reads "${run.fault.status}"`);
    assert.match(run.fault.status, /Decoder fault: PROBE fault/);
    assertFlightTakenDown(run.fault, 'decoder fault on the first open');
    assert.match(run.fault.issues, /could not read this flight/i,
      `the session panel must say this flight was not read: "${run.fault.issues.slice(0, 160)}"`);
    assert.equal(run.fault.options, 3,
      'the picker must list the file\'s flights, so another one can be chosen');
    assert.equal(run.fault.upAfter, false,
      'the decode progress bar was left up after a decoder fault on the first open');
    assert.equal(run.recovered, true, 'another flight of the same file never opened after it');

    assert.deepEqual(pageErrors, [], `the page threw: ${JSON.stringify(pageErrors)}`);
  });
});

test('the sharing panel promises no question this build never asks, and points at no control '
  + 'it has disabled', {
  skip: browserSkip
}, async () => {
  // The two sentences rewritten when the automatic prompt was switched off
  // were pinned only by a test that needs a private real log and had never
  // run. `sharingHtml` is pure, so they are pinned here, in every run.
  await withViewer({}, async ({evaluate, pageErrors}) => {
    const run = await evaluate(`(async () => {
      const {sharingHtml, AUTOMATIC_SHARING_PROMPT} = await import('/ui/app.mjs');
      const {createHistory} = await import('/src/analysis/flight-history.mjs');
      const fresh = {
        schemaVersion: 1, kind: 'rotorlens-sharing-preference',
        asked: false, sharing: false, termsVersion: null, ids: {}
      };
      const render = options => {
        const holder = document.createElement('div');
        holder.innerHTML = sharingHtml(createHistory(), fresh, options);
        const toggle = holder.querySelector('#sharing-toggle');
        return {text: holder.textContent, toggleDisabled: toggle ? toggle.disabled : null};
      };
      return JSON.stringify({
        automatic: AUTOMATIC_SHARING_PROMPT,
        writable: render({}),
        noStore: render({writable: false}),
        outdated: render({codes: ['SHARING_TERMS_OUTDATED']}),
        // An old consent beside a history that could not be read, or beside a
        // host with no sharing store: both disable the Share button.
        outdatedHistoryBlocked: render({historyBlocked: true, codes: ['SHARING_TERMS_OUTDATED']}),
        outdatedNoStore: render({writable: false, codes: ['SHARING_TERMS_OUTDATED']})
      });
    })()`);

    assert.equal(run.automatic, false,
      'these sentences are pinned for the automatic prompt switched off, as the owner decided');

    assert.equal(run.writable.toggleDisabled, false);
    assert.match(run.writable.text, /does not ask about sharing on its own/);
    assert.match(run.writable.text, /press Share measurements below/);
    assert.doesNotMatch(run.writable.text, /will ask/i,
      'the panel promises a question this build never asks');

    // A host with no sharing store: the button is disabled, and the sentence
    // must not send the pilot to it.
    assert.equal(run.noStore.toggleDisabled, true, 'the Share button is not disabled here');
    assert.match(run.noStore.text, /sharing cannot be enabled here/);
    assert.match(run.noStore.text, /Nothing about sharing is stored on this device/);
    assert.doesNotMatch(run.noStore.text, /press Share measurements/,
      'the panel tells the pilot to press a button it has disabled');
    assert.doesNotMatch(run.noStore.text, /will ask/i);

    assert.match(run.outdated.text, /older disclosure/);
    assert.match(run.outdated.text, /will not ask on its own/);
    assert.doesNotMatch(run.outdated.text, /will ask again/,
      'an outdated consent promises a question this build never asks');
    // Positive control: where the button works, the outdated sentence does
    // point at it, so the two cases below are distinguishing something.
    assert.equal(run.outdated.toggleDisabled, false);
    assert.match(run.outdated.text, /Share measurements shows the current terms/);

    // The panel's words point at the Share button only where it works. The
    // button's own label is "Share measurements", so the pointer is matched by
    // the sentences that send the pilot to it, not by the label.
    for (const [name, panel] of [['history unreadable', run.outdatedHistoryBlocked],
      ['no sharing store', run.outdatedNoStore]]) {
      assert.equal(panel.toggleDisabled, true, `${name}: the Share button is not disabled here`);
      assert.match(panel.text, /older disclosure/, `${name}: the outdated consent is not reported`);
      assert.match(panel.text, /will not ask on its own/, name);
      assert.doesNotMatch(panel.text, /Share measurements (shows|below)|press Share measurements/,
        `${name}: the panel sends the pilot to a Share button it has disabled`);
      assert.doesNotMatch(panel.text, /will ask/i, name);
    }
    assert.deepEqual(pageErrors, []);
  });
});

test('a flight saved twice reads as one flight saved twice, and Forget takes every save of it', {
  skip: browserSkip
}, async () => {
  // Histories written before a reopened flight could be recognised can hold
  // one flight twice. The model counts each later save under
  // DUPLICATE_OF_STORED_FLIGHT, and the learning panel printed that code bare
  // to the pilot. Forget took the one save it was bound to and left the other
  // standing in for the flight, at the place it was saved again.
  const session = yawI => ({
    firmware: {revision: 'Rotorflight 4.6.0 (118e912) STM32F7X2'},
    headers: {
      'Craft name': 'TEST',
      'Board information': 'BOARD',
      rollPID: '52,105,0,100,0',
      pitchPID: '64,111,40,100,0',
      yawPID: `315,${yawI},29,3,1`,
      rates_type: '4',
      rc_rates: '5,5,12',
      rc_expo: '30,30,50',
      rates: '10,10,25'
    }
  });
  const hold = (axis, errorDps) => ({
    schemaVersion: 1,
    kind: HOLD_EVIDENCE_KIND,
    axis,
    term: 'I',
    status: 'captured',
    codes: [],
    holds: [],
    summary: {
      holdCount: 4,
      zeroHoldCount: 4,
      sustainedHoldCount: 0,
      totalMeasuredDurationUs: 20_000_000,
      meanSteadyStateErrorDps: errorDps,
      meanAbsoluteSteadyStateErrorDps: errorDps,
      worstAbsoluteSteadyStateErrorDps: errorDps * 1.4,
      meanErrorDriftDpsPerSecond: null,
      driftMeasuredHoldCount: 0,
      meanErrorRippleRmsDps: 0.3,
      meanErrorCrossingRateHz: 5,
      meanErrorNoiseRmsDps: 0.1,
      meanITermRms: 385.6,
      meanITermDriftPerSecond: 0
    }
  });
  const flight = ({yawI, seconds}) => buildFlightRecord({
    session: session(yawI),
    window: {basis: 'FLIGHT_WINDOW_DETECTED', startUs: 0, endUs: seconds * 1e6},
    axes: Object.fromEntries(['roll', 'pitch', 'yaw'].map(axis => [axis, {
      headspeedMedianRpm: 2000,
      noise: {filteredHighFrequencyRmsDps: 1.2, unfilteredHighFrequencyRmsDps: 3.4},
      holdEvidence: hold(axis, 60 / yawI)
    }]))
  });
  // Three flights, then the first and the second saved again.
  const flights = [{yawI: 80, seconds: 90}, {yawI: 100, seconds: 101}, {yawI: 120, seconds: 112}];
  let history = createHistory();
  for (const entry of [...flights, flights[0], flights[1]]) {
    history = addFlightRecord(history, flight(entry));
  }
  const startupScript = `(() => {
    let file = ${JSON.stringify(exportHistory(history))};
    window.RotorLensNative = {
      pickFile() {},
      readHistory() { return file; },
      writeHistory(text) { file = text; return true; },
      forgetHistory() { file = ''; return true; },
      readSharing() { return ''; },
      writeSharing() { return true; },
      forgetSharing() { return true; }
    };
    window.__historyIds = () => (file === ''
      ? [] : JSON.parse(file).records.map(record => record.recordId));
  })();`;

  await withViewer({startupScript}, async ({evaluate, pageErrors}) => {
    const run = await evaluate(`(async () => {
      await import('/ui/app.mjs');
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const panel = () => ({
        text: document.getElementById('history').textContent,
        rows: document.querySelectorAll('#history .flight').length,
        ids: window.__historyIds()
      });
      const before = panel();

      // The before/after panel's Forget. Its button is drawn only over an open,
      // admissible flight that is already kept, bound to that flight's first
      // save; it is put where the panel puts it and pressed, so the delegated
      // handler on #since — the code under test — is what runs.
      const since = document.getElementById('since');
      since.innerHTML = '<button type="button" data-forget-flight="test::board#0">'
        + 'Forget this flight</button>';
      since.querySelector('button').click();
      await sleep(150);
      const afterSince = panel();

      // The history panel's own Forget, on the row of the LATER save of the
      // second flight.
      document.querySelector('#history [data-forget-flight="test::board#4"]').click();
      await sleep(150);
      const afterRow = panel();
      return JSON.stringify({before, afterSince, afterRow});
    })()`);

    assert.equal(run.before.rows, 5, 'the seeded history must list all five saves');
    assert.match(run.before.text, /the same flight saved again/,
      'the learning panel must say in words why a save was not used');
    assert.match(run.before.text, /counted once/);
    assert.doesNotMatch(run.before.text, /DUPLICATE_OF_STORED_FLIGHT/,
      'an engine code reached the pilot\'s screen instead of a sentence');
    assert.match(run.before.text, /same flight as #1, saved again/,
      'the row of a later save must say which flight it is a save of');
    assert.match(run.before.text, /same flight as #2, saved again/);

    assert.deepEqual(run.afterSince.ids, ['test::board#1', 'test::board#2', 'test::board#4'],
      'Forget this flight left a save of it behind, which then stood in for the flight');
    assert.deepEqual(run.afterRow.ids, ['test::board#2'],
      'the history panel\'s Forget left a save of the flight behind');
    assert.equal(run.afterRow.rows, 1);
    assert.deepEqual(pageErrors, []);
  });

  // Forget must also recompute the before/after on screen. The since-panel
  // reuses the comparison `considerFlight` made; when the record forgotten is
  // its baseline — reachable from a "saved again" row, which now deletes the
  // first save too — the panel kept comparing against a deleted record.
  // `considerFlight` is the real entry point, fed state shaped as an opened log.
  const candidateScript = `
      const app = await import('/ui/app.mjs');
      const {state} = app;
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const sessionOf = ${JSON.stringify(session(140))};
      state.result = {sessions: [{
        craftName: 'TEST',
        firmware: {revision: sessionOf.firmware.revision, board: 'BOARD'}
      }]};
      state.sessionIndex = 0;
      state.sessionHeaders = [{craftName: 'TEST', board: 'BOARD', headers: sessionOf.headers}];
      state.window = {basis: 'FLIGHT_WINDOW_DETECTED', startUs: 0, endUs: 123e6};
      app.considerFlight(${JSON.stringify(Object.fromEntries(['roll', 'pitch', 'yaw'].map(axis => [
        axis, {
          headspeedMedianRpm: 2000,
          noise: {filteredHighFrequencyRmsDps: 1.2, unfilteredHighFrequencyRmsDps: 3.4},
          holdEvidence: hold(axis, 60 / 140)
        }])))});
      const look = () => ({
        ids: window.__historyIds(),
        candidate: state.candidate !== null,
        storedAs: state.candidateStoredId,
        beforeId: state.comparisonBefore?.recordId ?? null,
        since: document.getElementById('since').textContent
      });`;
  // Two flights, the newer saved again, so the on-screen baseline has a
  // "saved again" row of its own.
  let twice = createHistory();
  for (const entry of [flights[0], flights[1], flights[1]]) {
    twice = addFlightRecord(twice, flight(entry));
  }
  const twiceScript = startupScript.replace(JSON.stringify(exportHistory(history)),
    JSON.stringify(exportHistory(twice)));
  assert.notEqual(twiceScript, startupScript, 'the second history was not seeded');
  for (const route of ['copy row', 'first-save row', 'forget everything']) {
    await withViewer({startupScript: twiceScript}, async ({evaluate, pageErrors}) => {
      const run = await evaluate(`(async () => {
        ${candidateScript}
        const before = look();
        // The row that deletes the on-screen baseline: either the baseline's own
        // row, or the row of a later save of the same flight.
        // The seeded history saved its newest flight, #1, again as #2.
        const savedAgainAs = {'test::board#1': 'test::board#2'};
        const route = ${JSON.stringify(route)};
        if (route === 'forget everything') {
          // Behind a second tap, as the pilot does it.
          const all = document.getElementById('history-forget-all');
          all.click();
          all.click();
          await sleep(150);
          return JSON.stringify({before, target: 'all', pressed: true, after: look()});
        }
        const target = route === 'first-save row'
          ? before.beforeId
          : savedAgainAs[before.beforeId] ?? null;
        const button = target === null ? null
          : document.querySelector('#history [data-forget-flight="' + target + '"]');
        button?.click();
        await sleep(150);
        return JSON.stringify({before, target, pressed: button !== null, after: look()});
      })()`);

      // Setup guards: a candidate exists, it is not stored, and it is compared
      // against a stored record the chosen row deletes.
      assert.equal(run.before.candidate, true, `${route}: considerFlight built no candidate`);
      assert.equal(run.before.storedAs, null, `${route}: the new flight read as already stored`);
      assert.ok(run.before.beforeId !== null && run.before.ids.includes(run.before.beforeId),
        `${route}: the candidate had no stored baseline: ${JSON.stringify(run.before)}`);
      assert.equal(run.pressed, true, `${route}: no row deletes the baseline (${run.target})`);
      assert.ok(!run.after.ids.includes(run.before.beforeId),
        `${route}: the Forget did not delete the baseline record`);

      assert.ok(run.after.beforeId === null || run.after.ids.includes(run.after.beforeId),
        `${route}: the before/after still compares against ${run.after.beforeId}, which Forget `
        + `deleted; the history now holds ${JSON.stringify(run.after.ids)}`);
      assert.equal(run.after.beforeId, route === 'forget everything' ? null : 'test::board#0',
        `${route}: the flight left standing is the one to compare against`);
      assert.notEqual(run.after.since, run.before.since,
        `${route}: the before/after panel was not redrawn against the new baseline`);
      assert.deepEqual(pageErrors, []);
    });
  }

  // The before/after panel's own Forget, on the open flight just saved: Save
  // must come back, and the baseline must stay the flight it followed.
  await withViewer({startupScript: twiceScript}, async ({evaluate, pageErrors}) => {
    const run = await evaluate(`(async () => {
      ${candidateScript}
      const before = look();
      document.getElementById('since-save').click();
      await sleep(150);
      const saved = look();
      const forget = document.querySelector('#since [data-forget-flight]');
      forget?.click();
      await sleep(150);
      return JSON.stringify({
        before, saved, pressed: forget !== null, after: look(),
        offersSave: document.getElementById('since-save') !== null
      });
    })()`);
    assert.equal(run.before.storedAs, null, 'the new flight read as already stored');
    assert.ok(run.saved.storedAs !== null && run.saved.ids.includes(run.saved.storedAs),
      `Save did not store the open flight: ${JSON.stringify(run.saved)}`);
    assert.equal(run.pressed, true, 'the before/after panel offered no Forget for a kept flight');
    assert.deepEqual(run.after.ids, run.before.ids, 'Forget did not remove exactly the save');
    assert.equal(run.after.storedAs, null,
      'the open flight still reads as stored after its only save was forgotten');
    assert.equal(run.offersSave, true, 'Save did not come back after Forget');
    assert.equal(run.after.beforeId, run.before.beforeId,
      'forgetting the open flight moved its baseline');
    assert.deepEqual(pageErrors, []);
  });

  // The before/after panel's Forget on a REOPENED flight that sits in the MIDDLE
  // of the history. Kept as [F0, Fc, F2], the open flight is Fc and compares
  // against F0, the flight it followed. Once Fc is forgotten it is a new flight
  // again, and a new flight follows the newest one kept — F2. A handler that only
  // cleared the stored id when it matched went on comparing against F0, a flight
  // the open one no longer follows, which no other case here could tell apart:
  // in each of them the baseline either vanished or stayed correct.
  let middle = createHistory();
  for (const entry of [flights[0], {yawI: 140, seconds: 123}, flights[1]]) {
    middle = addFlightRecord(middle, flight(entry));
  }
  const middleScript = startupScript.replace(JSON.stringify(exportHistory(history)),
    JSON.stringify(exportHistory(middle)));
  assert.notEqual(middleScript, startupScript, 'the middle-flight history was not seeded');
  await withViewer({startupScript: middleScript}, async ({evaluate, pageErrors}) => {
    const run = await evaluate(`(async () => {
      ${candidateScript}
      const {selectBaseline} = await import('/src/analysis/flight-history.mjs');
      const before = look();
      // The button the panel itself drew, so the delegated handler on #since is
      // what runs, bound to whatever id the panel bound it to.
      const forget = document.querySelector('#since [data-forget-flight]');
      forget?.click();
      await sleep(150);
      const after = look();
      const expected = selectBaseline(state.history, state.candidate);
      return JSON.stringify({
        before, after, pressed: forget !== null,
        expectedBeforeId: expected.baseline?.recordId ?? null,
        expectedStoredAs: expected.storedAs,
        offersSave: document.getElementById('since-save') !== null
      });
    })()`);

    // Setup guards: the open flight is recognised as the MIDDLE stored flight,
    // not freshly saved, and compared against the flight before it.
    assert.deepEqual(run.before.ids, ['test::board#0', 'test::board#1', 'test::board#2'],
      'the seeded history must hold three flights');
    assert.equal(run.before.storedAs, 'test::board#1',
      `the reopened flight was not recognised as the middle one: ${JSON.stringify(run.before)}`);
    assert.equal(run.before.beforeId, 'test::board#0',
      'a reopened middle flight must compare against the flight it followed');
    assert.equal(run.pressed, true, 'the before/after panel offered no Forget for a kept flight');

    assert.deepEqual(run.after.ids, ['test::board#0', 'test::board#2'],
      'Forget did not remove exactly the open flight');
    assert.equal(run.after.storedAs, null,
      'the open flight still reads as stored after it was forgotten');
    assert.equal(run.offersSave, true, 'Save did not come back after Forget');
    assert.equal(run.expectedBeforeId, 'test::board#2',
      'selectBaseline must make the newest flight kept the baseline of a new flight');
    assert.equal(run.after.beforeId, run.expectedBeforeId,
      `after Forget the before/after compares against ${run.after.beforeId}, but on the `
      + `history as it now stands the baseline is ${run.expectedBeforeId}`);
    assert.equal(run.after.storedAs, run.expectedStoredAs);
    assert.deepEqual(pageErrors, []);
  });
});

test('the plain copy added on 3 October renders as a sentence, never a code', {
  skip: browserSkip
}, async () => {
  // Three branches of the app's plain-English copy, added by the 3 October
  // review fix, that no other browser test renders: the head speed that moved
  // only where another axis still measured a hold, the I term not judged because
  // the holds changed side, and an axis that did not arrest whose commanded rate
  // was never measured. A branch that is deleted or renamed falls back to the
  // engine's headline, or to another branch's words, and nothing would notice.
  //
  // Each case is the card the engine builds for that branch: the id and the code
  // that selects the branch are read back out of the engine's source here, so a
  // rename on either side fails this rather than leaving it rendering a shape
  // the engine no longer emits.
  const engine = await readFile(
    new URL('../src/analysis/recommendations.mjs', import.meta.url), 'utf8');
  const cases = [
    {id: 'HEADSPEED_MOVED_WHERE_A_HOLD_WAS_STILL_MEASURED', axes: [null], rung: 'headspeed',
      kind: 'observation',
      codes: ['HEADSPEED_MOVED_ONLY_WHERE_A_HOLD_WAS_MEASURED'],
      words: /each of those stretches still gave a usable hold.*nothing was lost/},
    {id: 'I_TERM_NOT_JUDGED', axes: ['roll', 'pitch', 'yaw'], rung: 'gain-I',
      kind: 'next-flight',
      codes: ['STANDING_ERROR_CHANGES_SIDE_BETWEEN_HOLDS'],
      words: /on one side in some holds and on the other side in others.*could not be read as that.*not an all-clear/},
    {id: 'AXIS_DOES_NOT_ARREST', axes: ['roll', 'pitch', 'yaw'], rung: 'gain-P',
      kind: 'next-flight',
      codes: ['RESIDUAL_RATE_IN_COMMAND_DIRECTION', 'COMMANDED_RATE_NOT_MEASURED'],
      words: /rate you asked for could not be measured.*Nothing to change yet/}
  ];
  for (const {id, codes} of cases) {
    assert.ok(engine.includes(`id: '${id}'`), `the engine no longer builds ${id}`);
    for (const code of codes) {
      assert.ok(engine.includes(`'${code}'`), `the engine no longer emits ${code}`);
    }
  }

  await withViewer({}, async ({evaluate, pageErrors}) => {
    const rendered = await evaluate(`(async () => {
      const app = await import('/ui/app.mjs');
      const box = document.createElement('div');
      document.body.appendChild(box);
      const flat = text => text.replace(/\\s+/g, ' ').trim();
      const out = [];
      for (const entry of ${JSON.stringify(cases.map(({words, ...rest}) => rest))}) {
        for (const axis of entry.axes) {
          box.innerHTML = app.findingHtml({
            id: entry.id, rung: entry.rung, rungOrder: 1, axis, kind: entry.kind,
            adjust: null, direction: null, confidence: 'low',
            headline: 'the engine headline stands here', reasoning: 'because',
            basis: [], confirm: null, candidates: [], codes: entry.codes,
            actNow: false, sequence: 0
          });
          const plain = box.querySelector('p.plain');
          out.push({id: entry.id, axis, plain: plain ? flat(plain.textContent) : null});
        }
      }
      box.remove();
      return JSON.stringify(out);
    })()`);

    assert.equal(rendered.length, 7, 'every branch must be rendered on every axis it carries');
    const thing = {roll: 'roll', pitch: 'pitch', yaw: 'tail'};
    for (const {id, axis, plain} of rendered) {
      const label = `${id} on ${axis ?? 'no axis'}`;
      assert.ok(plain, `${label}: no plain sentence was drawn`);
      assert.notEqual(plain, 'the engine headline stands here',
        `${label}: fell back to the engine's headline; the plain copy is missing`);
      assert.match(plain, cases.find(entry => entry.id === id).words,
        `${label}: rendered another branch's words: ${plain}`);
      assert.doesNotMatch(plain, /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/,
        `${label}: an engine code reached the pilot: ${plain}`);
      assert.doesNotMatch(plain, /\b(?:null|undefined|NaN)\b/, `${label}: ${plain}`);
      if (axis !== null) {
        assert.match(plain, new RegExp(`\\b${thing[axis]}\\b`),
          `${label}: the sentence does not name the ${thing[axis]}: ${plain}`);
      }
    }
    assert.deepEqual(pageErrors, []);
  });
});
