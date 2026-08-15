/**
 * The two modules the viewer fetches on demand actually arrive — and say so
 * when they do not.
 *
 * `ui/legal-data.mjs` and `src/analysis/recommendations.mjs` were static
 * imports until 13 August 2026. They are now `import()` calls, which moves a
 * link-time guarantee into a run-time one: a static import that cannot resolve
 * kills the page loudly at start-up, where nobody can miss it, while a dynamic
 * import that cannot resolve produces a rejected promise and, if nothing is
 * watching, a button that does nothing at all. On a phone that reads as a
 * broken app with no error anywhere.
 *
 * There are three ways for that to happen and this file covers all three:
 *
 *   1. The path is wrong, or the file is not packaged. Proved by driving both
 *      screens in a real browser and requiring the content to appear. The APK
 *      copies whole directories (`syncWebAssets` in android/app/build.gradle.kts
 *      takes all of `ui/` and all of `src/`) and AssetServer serves any path
 *      beneath them, so a literal relative specifier that resolves here
 *      resolves there — but only while it stays literal, which is the thing
 *      being pinned.
 *   2. Somebody puts the static import back. The saving would quietly vanish;
 *      the start-up graph is asserted directly.
 *   3. The fetch fails on the device. Forced here by refusing the request at
 *      the protocol level, which is the only honest way to reach it — the
 *      module exists on disk, so nothing short of an intercept can make it
 *      absent. Both screens must then say so where the reader is looking.
 *
 * Skipped rather than failed when no browser is present, matching
 * test/ui-browser.test.mjs, which is where the shared reasoning about driving
 * headless Chromium over the DevTools protocol lives.
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

/** The specifiers under test, exactly as they appear in the source. */
const LEGAL_DATA = '/ui/legal-data.mjs';
const RECOMMENDATIONS = '/src/analysis/recommendations.mjs';

/**
 * A module that must still be in the start-up graph.
 *
 * Without it, "recommendations.mjs is not fetched at start-up" also passes when
 * the resource timings are empty, when the page never loaded, and when the
 * shell's JavaScript is dead — three failures this test would then hide.
 */
const CONTROL = '/src/blackbox/decode.mjs';

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
async function withViewer({block = [], platform = null} = {}, body) {
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

    if (platform) {
      await client.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `globalThis.RotorLensPlatform = ${JSON.stringify(platform)};`
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

/** The module specifiers the browser actually fetched, as absolute paths. */
const FETCHED = `JSON.stringify(
  performance.getEntriesByType('resource')
    .map(entry => new URL(entry.name).pathname)
    .filter(pathname => pathname.endsWith('.mjs'))
)`;

const browserSkip = chromePath ? false : 'no Chromium found; set ROTORLENS_BROWSER to a path';

test('the deferred modules are absent from start-up and arrive when asked for', {
  skip: browserSkip
}, async () => {
  await withViewer({}, async ({evaluate, pageErrors}) => {
    const atStartup = await evaluate(FETCHED);

    // The control first. Everything below is an assertion about an ABSENCE, and
    // an absence is also what a page that never ran produces.
    assert.ok(atStartup.includes(CONTROL),
      `the start-up graph looks empty (${atStartup.length} modules) — this test would ` +
      'pass vacuously, so the assertions below prove nothing');

    assert.ok(!atStartup.includes(RECOMMENDATIONS),
      `${RECOMMENDATIONS} is fetched at start-up again; the static import is back`);
    assert.ok(!atStartup.includes(LEGAL_DATA),
      `${LEGAL_DATA} is fetched at start-up again; the static import is back`);

    // 1. About & Legal. A normal browser defaults to the web inventory, so it
    //    must show common MPL/source attribution without claiming Android Maven
    //    components or their Apache license.
    const legal = await evaluate(`(async () => {
      document.getElementById('legal-toggle').click();

      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (document.getElementById('legal-mpl')) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      return JSON.stringify({
        visible: !document.getElementById('legal-panel').classList.contains('hidden'),
        mplChars: document.getElementById('legal-mpl')?.textContent.length ?? 0,
        apachePresent: Boolean(document.getElementById('legal-apache')),
        text: document.getElementById('legal').textContent,
        fetched: performance.getEntriesByType('resource')
          .some(entry => new URL(entry.name).pathname === '${LEGAL_DATA}')
      });
    })()`);

    assert.equal(legal.visible, true, 'the About & Legal button must open the panel');
    assert.equal(legal.fetched, true,
      'opening Legal must fetch ui/legal-data.mjs — it is no longer in the start-up graph');
    assert.ok(legal.mplChars > 16000,
      `the MPL text is ${legal.mplChars} characters; the common licence did not render`);
    assert.equal(legal.apachePresent, false,
      'the web build must not render Android components or their Apache license');
    assert.match(legal.text, /Bundled components\s+—\s+Web \(0\)/);
    assert.doesNotMatch(legal.text, /androidx\.activity:activity:/,
      'the web legal screen falsely claims an Android Maven artifact');
    assert.match(legal.text, /not affiliated with/,
      'the non-affiliation statement must be on the screen a user can open');
    assert.doesNotMatch(legal.text, /could not be loaded/,
      'the notices reported a load failure on a machine where the file is present');

    // 2. Recommendations. Opening a log runs the advisor, which is the only
    //    thing that pulls the module in.
    const analysed = await evaluate(`(async () => {
      const bytes = await (await fetch(
        '/fixtures/synthetic/rf46-two-sessions.TXT'
      )).arrayBuffer();
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'LAZY.BBL'));
      const input = document.getElementById('file');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change'));

      const box = document.getElementById('recommend');
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (box.textContent && !box.textContent.includes('Working out what this flight')) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      return JSON.stringify({
        recommend: box.textContent,
        fetched: performance.getEntriesByType('resource')
          .some(entry => new URL(entry.name).pathname === '${RECOMMENDATIONS}')
      });
    })()`);

    assert.equal(analysed.fetched, true,
      'analysing a log must fetch src/analysis/recommendations.mjs');
    assert.ok(analysed.recommend.length > 0, 'the recommendation panel stayed empty');
    assert.doesNotMatch(analysed.recommend, /could not be run/,
      `the analysis reported a failure on a machine where the module is present: ` +
      analysed.recommend.slice(0, 300));
    assert.doesNotMatch(analysed.recommend, /Working out what this flight/,
      'the analysis never finished — the panel is still showing its working message');

    assert.deepEqual(pageErrors, [], 'nothing may throw on the happy path');
  });
});

test('the iOS marker selects only the iOS legal inventory', {
  skip: browserSkip
}, async () => {
  await withViewer({platform: 'ios'}, async ({evaluate, pageErrors}) => {
    const legal = await evaluate(`(async () => {
      // The explicit iOS document marker must win even if a lookalike native
      // bridge claims Android.
      globalThis.RotorLensNative = {platform() { return 'android'; }};
      document.getElementById('legal-toggle').click();
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (document.getElementById('legal-mpl')) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return JSON.stringify({
        text: document.getElementById('legal').textContent,
        apachePresent: Boolean(document.getElementById('legal-apache')),
        sourcePresent: Boolean(document.getElementById('legal-source')),
        mplChars: document.getElementById('legal-mpl')?.textContent.length ?? 0
      });
    })()`);

    assert.match(legal.text, /Bundled components\s+—\s+iOS \(0\)/);
    assert.doesNotMatch(legal.text, /androidx\.activity:activity:/,
      'the iOS legal screen falsely claims an Android Maven artifact');
    assert.equal(legal.apachePresent, false,
      'iOS must not render a license solely required by Android components');
    assert.equal(legal.sourcePresent, true, 'common creator/source attribution disappeared on iOS');
    assert.ok(legal.mplChars > 16000, 'the common MPL text disappeared on iOS');
    assert.deepEqual(pageErrors, []);
  });
});

test('a deferred module that cannot be fetched reaches the reader as a message', {
  skip: browserSkip
}, async () => {
  await withViewer({block: [LEGAL_DATA]}, async ({evaluate, refused}) => {
    const legal = await evaluate(`(async () => {
      document.getElementById('legal-toggle').click();

      // Wait for the panel to stop saying it is loading, however it ends up.
      const box = document.getElementById('legal');
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (!box.textContent.includes('Loading the licence notices')) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      return JSON.stringify({
        visible: !document.getElementById('legal-panel').classList.contains('hidden'),
        text: box.textContent.trim(),
        // The message has to be VISIBLE, not merely in the DOM. A panel that is
        // still hidden, or an element with no box, is the dead button this test
        // is named after.
        painted: box.getBoundingClientRect().height > 0
      });
    })()`);

    assert.ok(refused.length > 0,
      'the interception never fired, so this test did not exercise a failed load at all');
    assert.equal(legal.visible, true,
      'the panel must still open — a tap that does nothing is the worst outcome here');
    assert.match(legal.text, /could not be loaded/,
      `a failed load must say so; the panel reads: ${JSON.stringify(legal.text.slice(0, 200))}`);
    assert.match(legal.text, /THIRD_PARTY_NOTICES\.md/,
      'the message must point somewhere the notices can still be read');
    assert.equal(legal.painted, true, 'the message must have a box on screen, not just a node');
    assert.doesNotMatch(legal.text, /Loading the licence notices/,
      'the panel is stuck on its loading message; the rejection was never handled');
  });
});

test('an analysis module that cannot be fetched reaches the reader as a message', {
  skip: browserSkip
}, async () => {
  await withViewer({block: [RECOMMENDATIONS]}, async ({evaluate, refused}) => {
    const analysed = await evaluate(`(async () => {
      const bytes = await (await fetch(
        '/fixtures/synthetic/rf46-two-sessions.TXT'
      )).arrayBuffer();
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'LAZY.BBL'));
      const input = document.getElementById('file');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change'));

      const box = document.getElementById('recommend');
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (box.textContent && !box.textContent.includes('Working out what this flight')) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      return JSON.stringify({
        text: box.textContent.trim(),
        painted: box.getBoundingClientRect().height > 0,
        // The rest of the page does not depend on the advisor, and the panel
        // says so. Prove the claim rather than the sentence.
        sessionVisible: !document.getElementById('session-panel').classList.contains('hidden'),
        fieldRows: document.getElementById('fields').rows.length
      });
    })()`);

    assert.ok(refused.length > 0,
      'the interception never fired, so this test did not exercise a failed load at all');
    assert.match(analysed.text, /could not be run/,
      `a failed load must say so; the panel reads: ${JSON.stringify(analysed.text.slice(0, 200))}`);
    assert.equal(analysed.painted, true, 'the message must have a box on screen');
    assert.doesNotMatch(analysed.text, /Working out what this flight/,
      'the panel is stuck on its working message; the rejection was never handled');

    // The measurements below the advisor are decoded, not advised, and the
    // message promises they are still good.
    assert.equal(analysed.sessionVisible, true,
      'the panel claims the measurements below are unaffected; the session panel is hidden');
    assert.ok(analysed.fieldRows > 1,
      'the panel claims the measurements below are unaffected; the field table is empty');
  });
});
