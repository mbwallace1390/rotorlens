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
  addFlightRecord,
  auditFlightRecord,
  buildFlightRecord,
  buildSensitivityModel,
  compareFlightRecords,
  createHistory,
  exportHistory,
  findRecords,
  findSensitivityTerm,
  SENSITIVITY_STATE
} from '../src/analysis/flight-history.mjs';
import {DIRECTIONAL_EVIDENCE_KIND, HOLD_EVIDENCE_KIND} from '../src/analysis/pid-evidence.mjs';

/**
 * Runs the shell in a real browser.
 *
 * The engine has to work in a WebView, not only in Node — that is the whole
 * reason `Buffer` was removed from the decoder. A Node test cannot prove it,
 * because Node provides the very globals whose absence is the risk. So this
 * drives headless Chromium over the DevTools protocol directly: Node 22 ships a
 * WebSocket client, so no browser-automation dependency is needed and the
 * project stays dependency-free.
 *
 * Skipped rather than failed when no browser is present, so the suite still runs
 * on a machine without one.
 */

/**
 * Any Chromium will do — the test drives the DevTools protocol, which Chrome,
 * Chromium and Edge all speak.
 *
 * Edge is listed because it is present on essentially every Windows machine, and
 * a test that silently skips on the contributor's platform is a test that does
 * not exist. This is the only check that catches the shell rendering while its
 * JavaScript is dead, so it should run wherever it can.
 */
function findBrowser() {
  const {
    PROGRAMFILES = 'C:\\Program Files',
    'PROGRAMFILES(X86)': PROGRAMFILES_X86 = 'C:\\Program Files (x86)',
    LOCALAPPDATA = ''
  } = process.env;

  const candidates = [
    process.env.ROTORLENS_BROWSER,

    // Linux
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',

    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',

    // Windows
    `${PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
    `${PROGRAMFILES_X86}\\Google\\Chrome\\Application\\chrome.exe`,
    LOCALAPPDATA && `${LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    `${PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${PROGRAMFILES_X86}\\Microsoft\\Edge\\Application\\msedge.exe`
  ];

  return candidates.filter(Boolean).find(candidate => existsSync(candidate));
}

const chromePath = findBrowser();

// ---------------------------------------------------------------------------
// Flight-history material
//
// No synthetic fixture in this repository is admissible to the history: all
// fifteen report NO_ROTOR_START_IN_LOG, because none of them contains a rotor
// coming up to speed and a machine leaving the ground. That is correct — 72% of
// the sessions in a real dump are bench runs and the engine refuses them — but
// it means a comparison cannot be reached by opening a fixture.
//
// So the records below are built by the ENGINE from header strings and evidence
// summaries, and the verdicts are the engine's own. What is under test here is
// the renderer: given a verdict, does the pilot see the right words, and never
// an improvement the engine refused to claim. The end-to-end path — open a log,
// keep it, compare it with the last one — is exercised against a real log in the
// test below this one, which runs when ROTORLENS_REAL_LOG points at one.
// ---------------------------------------------------------------------------

function holdEvidenceWith(errorDps, holdCount = 6) {
  return {
    kind: HOLD_EVIDENCE_KIND,
    status: 'captured',
    holds: new Array(holdCount).fill(null),
    summary: {
      holdCount,
      zeroHoldCount: 0,
      sustainedHoldCount: holdCount,
      meanAbsoluteSteadyStateErrorDps: errorDps,
      worstAbsoluteSteadyStateErrorDps: errorDps * 1.4,
      meanErrorDriftDpsPerSecond: null,
      meanErrorRippleRmsDps: 0.4,
      meanErrorCrossingRateHz: 2.1,
      meanITermRms: 12.5
    }
  };
}

function stopEvidenceWith(ringingDps) {
  return {
    kind: DIRECTIONAL_EVIDENCE_KIND,
    status: 'captured',
    directions: {
      positive: {
        directionEventCount: 4,
        trackingRmsDps: 9.1,
        fastRingingRmsDps: ringingDps,
        slowOscillationRmsDps: 2.2,
        commandAmplitudeDps: 180
      },
      negative: {
        directionEventCount: 3,
        trackingRmsDps: 8.7,
        fastRingingRmsDps: ringingDps * 0.9,
        slowOscillationRmsDps: 2.4,
        commandAmplitudeDps: 175
      }
    }
  };
}

function flightRecord({yawPID, errorDps, ringingDps, firmware = 'Rotorflight 4.6.0'}) {
  return buildFlightRecord({
    session: {
      craftName: 'Bench Mule',
      board: 'STM32H743 TEST',
      headers: {
        rollPID: '50,60,30,100,0',
        pitchPID: '52,62,32,100,0',
        yawPID,
        rates_type: '4',
        rc_rates: '5,5,12',
        rc_expo: '0,0,0',
        rates: '10,10,10'
      },
      firmware: {revision: firmware}
    },
    window: {basis: 'FLIGHT_WINDOW_DETECTED', startUs: 0, endUs: 120_000_000},
    axes: {
      yaw: {
        headspeedMedianRpm: 1800,
        holdEvidence: holdEvidenceWith(errorDps),
        stopEvidence: stopEvidenceWith(ringingDps)
      }
    }
  });
}

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

/**
 * A port nothing is listening on.
 *
 * Not `uiPort + 1`: a test that binds two servers gets two ephemeral ports, and
 * the OS hands those out consecutively often enough that the second server had
 * already taken the one Chromium was told to use. The browser then failed to
 * bind its debug port and the test reported "DevTools never became ready",
 * which points at everything except the cause.
 */
async function freePort() {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function waitForDevTools(port, attempts = 60) {
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
    let nextId = 0;

    const listeners = new Set();

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

test('the engine and shell run in a real browser', {
  skip: chromePath ? false : 'no Chromium found; set ROTORLENS_BROWSER to a path'
}, async () => {
  const server = createUiServer();
  const port = await listen(server);
  const profile = await mkdtemp(path.join(tmpdir(), 'rotorlens-ui-'));
  const debugPort = port + 1;

  const browser = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    'about:blank'
  ], {stdio: 'ignore'});

  try {
    const client = await connect(await waitForDevTools(debugPort));

    const {targetId} = await client.send('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await client.send('Target.attachToTarget', {targetId, flatten: true});

    // A module that fails to load shows up here and nowhere else — the page
    // would still render, just inert.
    const pageErrors = [];
    client.on(message => {
      if (message.method === 'Runtime.exceptionThrown') {
        pageErrors.push(
          message.params.exceptionDetails.exception?.description
          ?? message.params.exceptionDetails.text
        );
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        pageErrors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
      }
    });

    await client.send('Runtime.enable', {}, sessionId);
    await client.send('Page.enable', {}, sessionId);

    await client.send('Page.navigate', {url: `http://127.0.0.1:${port}/`}, sessionId);
    await new Promise(resolve => setTimeout(resolve, 900));

    // 1. The engine decodes a generated fixture with no Node globals present.
    const decode = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        const {decodeLog} = await import('/src/blackbox/decode.mjs');
        const bytes = new Uint8Array(await (await fetch(
          '/fixtures/synthetic/rf43-single-session.TXT'
        )).arrayBuffer());
        const result = decodeLog(bytes);
        const session = result.sessions[0];
        return JSON.stringify({
          hasBuffer: typeof Buffer !== 'undefined',
          sessions: result.sessions.length,
          samples: session.samples.length,
          errors: session.errors.length,
          firmware: session.firmware.type,
          fields: session.fields.length
        });
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    assert.equal(decode.exceptionDetails, undefined,
      `decoding threw in the browser: ${JSON.stringify(decode.exceptionDetails)}`);

    const decoded = JSON.parse(decode.result.value);
    assert.equal(decoded.hasBuffer, false, 'the browser has no Buffer — that is the point');
    assert.equal(decoded.sessions, 1);
    assert.equal(decoded.samples, 320);
    assert.equal(decoded.errors, 0);
    assert.equal(decoded.firmware, 'Rotorflight');
    // 37, not 34: gyroRAW[0..2] joined the corpus on 2026-08-13. Without an
    // unfiltered gyro the airframe gate can never clear, so no fixture could
    // reach a gain finding however good its stops were.
    assert.equal(decoded.fields, 37);

    // 2. The analysis chain runs in the browser too.
    const analysis = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        const {decodeLog} = await import('/src/blackbox/decode.mjs');
        const {buildAnalysisRecords} = await import('/src/analysis/records.mjs');
        const bytes = new Uint8Array(await (await fetch(
          '/fixtures/synthetic/rf43-single-session.TXT'
        )).arrayBuffer());
        const session = decodeLog(bytes).sessions[0];
        const built = buildAnalysisRecords(session, {axis: 'roll'});
        return JSON.stringify({usable: built.usable, records: built.records.length});
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    assert.equal(analysis.exceptionDetails, undefined,
      `analysis threw in the browser: ${JSON.stringify(analysis.exceptionDetails)}`);
    const analysed = JSON.parse(analysis.result.value);
    assert.equal(analysed.usable, true, 'the fixture must carry the signals the analysis needs');
    assert.equal(analysed.records, 320);

    // 3. The shell itself loaded and wired up.
    const shell = await client.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        title: document.title,
        hasDrop: Boolean(document.getElementById('drop')),
        hasCanvas: Boolean(document.getElementById('plot')),
        axes: [...document.getElementById('axis').options].map(o => o.value),
        mentionsMassStorage: document.body.textContent.includes('mass storage')
      })`,
      returnByValue: true
    }, sessionId);

    const page = JSON.parse(shell.result.value);
    assert.equal(page.title, 'RotorLens');
    assert.equal(page.hasDrop, true);
    assert.equal(page.hasCanvas, true);
    assert.deepEqual(page.axes, ['roll', 'pitch', 'yaw']);
    assert.equal(page.mentionsMassStorage, true, 'the import flow must explain how to get the log');

    // 4. Drive a real file through the real import path.
    //
    // Everything above this point passes even when the shell's own JavaScript
    // failed to load, because it only inspects static markup. Opening a log is
    // what proves the page is wired up rather than merely rendered.
    const opened = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        const bytes = await (await fetch(
          '/fixtures/synthetic/rf46-two-sessions.TXT'
        )).arrayBuffer();
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], 'LOG00042.BBL'));
        const input = document.getElementById('file');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change'));

        for (let attempt = 0; attempt < 40; attempt += 1) {
          if (!document.getElementById('session-panel').classList.contains('hidden')) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        document.getElementById('axis').value = 'yaw';
        document.getElementById('term').value = 'I';
        document.getElementById('analyse').click();

        return JSON.stringify({
          status: document.getElementById('status').textContent,
          sessionOptions: document.getElementById('session').options.length,
          statsRendered: document.getElementById('session-stats').children.length,
          fieldRows: document.getElementById('fields').rows.length,
          plotCaption: document.getElementById('plot-caption').textContent,
          tune: document.getElementById('tune').textContent.slice(0, 200)
        });
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    assert.equal(opened.exceptionDetails, undefined,
      `opening a log threw: ${JSON.stringify(opened.exceptionDetails)}`);

    const view = JSON.parse(opened.result.value);
    assert.match(view.status, /LOG00042\.BBL/, 'the shell must report the opened file');
    assert.equal(view.sessionOptions, 2, 'both sessions must be offered');
    assert.ok(view.statsRendered > 0, 'session statistics must render');
    assert.equal(view.fieldRows, 38, '37 fields plus a header row');
    assert.match(view.plotCaption, /range/, 'the plot must draw and describe itself');
    assert.ok(view.tune.length > 0, 'the tune panel must report something');

    // 5. The native-host contract, exactly as MainActivity.java implements it.
    //
    // The Android shell cannot be exercised by this suite, so the seam between it
    // and the page is tested here instead: with a host present the page must ask
    // it to open the picker rather than using the file input, and a file the host
    // announces must be fetched and decoded.
    const bridged = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        let pickCalls = 0;
        window.RotorLensNative = {pickFile() { pickCalls += 1; }};

        const {hasNativeHost, requestFile} = await import('/ui/host.mjs');
        const detected = hasNativeHost(window);

        let fellBack = false;
        const route = requestFile(window, () => { fellBack = true; });

        // MainActivity announces the log; the page fetches the bytes itself.
        window.dispatchEvent(new CustomEvent('rotorlens-file', {detail: {
          name: 'SHARED.BBL',
          url: '/fixtures/synthetic/rf46-two-sessions.TXT'
        }}));

        // Wait for the FLIGHT, not for its name. The name is painted at
        // "Reading SHARED.BBL…", before a byte has been decoded, so a wait on
        // the name alone returned while the picker was still empty — and the
        // option count below then read whatever the PREVIOUS log had left in
        // it. This assertion was passing for that reason and not on its own
        // merit; emptying the picker when a log closes is what exposed it.
        for (let attempt = 0; attempt < 40; attempt += 1) {
          if (document.getElementById('status').textContent.includes('SHARED.BBL')
              && document.getElementById('session-stats').children.length > 0) {
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        return JSON.stringify({
          detected,
          route,
          pickCalls,
          fellBack,
          status: document.getElementById('status').textContent,
          sessionOptions: document.getElementById('session').options.length
        });
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    assert.equal(bridged.exceptionDetails, undefined,
      `the host bridge threw: ${JSON.stringify(bridged.exceptionDetails)}`);

    const host = JSON.parse(bridged.result.value);
    assert.equal(host.detected, true, 'a native host must be detected when present');
    assert.equal(host.route, 'native', 'the page must defer to the system picker');
    assert.equal(host.pickCalls, 1, 'pickFile must be called exactly once');
    assert.equal(host.fellBack, false, 'the browser file input must not be used under a host');
    assert.match(host.status, /SHARED\.BBL/, 'a shared log must open by name');
    assert.equal(host.sessionOptions, 2, 'a shared log must decode like any other');

    // 6. A log whose headers are hostile must render as text, not as markup.
    //
    // `H Craft name:` is everything after the first colon to end of line, so it
    // is arbitrary attacker-controlled text arriving in the app's own origin —
    // where the native bridge is attached.
    const hostile = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        const bytes = await (await fetch(
          '/fixtures/synthetic/rf46-hostile-strings.TXT'
        )).arrayBuffer();
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], 'HOSTILE.BBL'));
        const input = document.getElementById('file');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change'));

        // Report the timeout rather than falling through it. A loaded machine
        // used to exhaust this poll and then fail on the craft-name assertion,
        // which reads as an escaping regression in a security check when the
        // decode had simply not finished. A misleading failure on this test is
        // worse than a slow one.
        let settled = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (document.getElementById('session-stats').textContent.includes('R&D')) {
            settled = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        const stats = document.getElementById('session-stats');
        return JSON.stringify({
          settled,
          pwned: window.__rotorlensPwned === 1,
          injectedNodes: stats.querySelectorAll('img, script').length,
          // The craft name must survive intact as *text*.
          craftText: stats.textContent.includes('R&D <img src=x'),
          scriptTags: document.querySelectorAll('script:not([src])').length
        });
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    assert.equal(hostile.exceptionDetails, undefined,
      `the hostile log threw: ${JSON.stringify(hostile.exceptionDetails)}`);

    const attack = JSON.parse(hostile.result.value);
    assert.equal(attack.settled, true,
      'the hostile log never finished decoding, so the escaping assertions below ' +
      'would report an XSS failure that was really a timeout');
    assert.equal(attack.pwned, false, 'a craft name must never execute');
    assert.equal(attack.injectedNodes, 0, 'a craft name must not create elements');
    assert.equal(attack.scriptTags, 0, 'a firmware string must not create a script tag');
    assert.equal(attack.craftText, true, 'the craft name must still be readable as text');

    // 7. An import the host could not complete must say so.
    const failure = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        window.dispatchEvent(new CustomEvent('rotorlens-import-failed', {detail: {
          name: 'BROKEN.BBL', reason: 'no-file'
        }}));
        await new Promise(resolve => setTimeout(resolve, 200));
        return document.getElementById('status').textContent;
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    assert.match(failure.result.value, /could not open BROKEN\.BBL/,
      'a failed import must be reported, not leave a silent screen');
    assert.match(failure.result.value, /contained text, not a file/,
      'the reason code must become words the user can act on');

    // 8. The axis view, on a phone, with a real log open.
    //
    // This is the half of the product a pilot actually reads, and none of it can
    // be proven anywhere else: a canvas that draws nothing, a backing store sized
    // from a stale width, or a panel of em-dashes all render as a perfectly
    // healthy page. Everything below is measured after a log has gone through the
    // real file input at the width the app ships at.
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 384, height: 800, deviceScaleFactor: 2, mobile: true
    }, sessionId);

    const axisView = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        const bytes = await (await fetch(
          '/fixtures/synthetic/rf46-two-sessions.TXT'
        )).arrayBuffer();
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], 'PHONE.BBL'));
        const input = document.getElementById('file');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change'));

        let settled = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (document.getElementById('axis-stats').children.length > 0
              && document.querySelectorAll('#recommend .finding').length > 0) {
            settled = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        const {state} = await import('/ui/app.mjs');
        const canvas = document.getElementById('axis-plot');

        // Did anything actually get painted, and in both trace colours? A plot
        // that draws one signal, or none, looks identical from the DOM.
        const pixels = (() => {
          const data = canvas.getContext('2d')
            .getImageData(0, 0, canvas.width, canvas.height).data;
          let commanded = 0;
          let measured = 0;
          for (let i = 0; i < data.length; i += 4) {
            const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
            if (a < 32) continue;
            if (b > 120 && b > r + 40 && b > g + 20) commanded += 1;
            if (r > 120 && r > b + 40 && g > b) measured += 1;
          }
          return {commanded, measured};
        })();

        const tiles = [...document.querySelectorAll('#axis-stats .stat .v')]
          .map(el => el.textContent.trim());

        // Zoom and pan have to move the view, not just repaint it.
        const spanBefore = state.view.spanUs;
        const captionBefore = document.getElementById('axis-plot-caption').textContent;
        document.getElementById('axis-in').click();
        const spanZoomed = state.view.spanUs;
        const startBefore = state.view.startUs;
        document.getElementById('axis-next').click();
        const startPanned = state.view.startUs;
        document.getElementById('axis-fit').click();
        const spanRefit = state.view.spanUs;
        const captionAfter = document.getElementById('axis-plot-caption').textContent;

        // P and D used to render byte-identical output.
        document.getElementById('axis').value = 'roll';
        document.getElementById('axis').dispatchEvent(new Event('change'));
        document.getElementById('term').value = 'P';
        document.getElementById('analyse').click();
        // Template literals in the shell wrap across lines, so rendered text
        // carries newlines a reader never sees. Collapse whitespace before
        // asserting on a sentence, or the assertion is about the source layout.
        const flat = node => node.textContent.replace(/\\s+/g, ' ').trim();

        const proportional = document.getElementById('tune').innerHTML;
        const proportionalText = flat(document.getElementById('tune'));
        const marks = state.marks.length;

        document.getElementById('term').value = 'D';
        document.getElementById('analyse').click();
        const derivative = document.getElementById('tune').innerHTML;

        document.getElementById('term').value = 'I';
        document.getElementById('analyse').click();
        const integral = flat(document.getElementById('tune'));

        const grid = document.querySelector('#axis-stats');

        // The viewport override is applied asynchronously by the renderer, and
        // everything above ran at whatever width was in force when it started.
        // Measuring the page width before that reflow lands reads a layout the
        // user never sees: this assertion failed roughly one run in eight with
        // scrollWidth 517 against clientWidth 384 while NO element extended past
        // the edge — an overflow with no cause, which is the signature of a
        // measurement taken mid-resize. It is the same mistake the legal step
        // below already documents. Settle first, and report it if it never does,
        // so a real persistent overflow still fails rather than being waited out.
        let widthSettled = false;
        let previousScrollWidth = -1;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const root = document.documentElement;
          if (root.clientWidth === 384 && root.scrollWidth === previousScrollWidth) {
            widthSettled = true;
            break;
          }
          previousScrollWidth = root.scrollWidth;
          await new Promise(resolve => requestAnimationFrame(
            () => requestAnimationFrame(resolve)));
        }

        return JSON.stringify({
          settled,
          widthSettled,
          tiles,
          dashedTiles: tiles.filter(value => value === '—').length,
          backingWidth: canvas.width,
          backingHeight: canvas.height,
          clientWidth: canvas.clientWidth,
          ratio: window.devicePixelRatio,
          pixels,
          spanBefore, spanZoomed, spanRefit,
          startMoved: startPanned > startBefore,
          captionBefore, captionAfter,
          statColumns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
          pAndDDiffer: proportional !== derivative,
          pMentionsTracking: proportional.includes('Tracking error while the command was held'),
          dMentionsRinging: derivative.includes('Fast ringing after the release'),
          // The capture brief: progress against a target, and the manoeuvre.
          progress: proportionalText.includes('Captured:'),
          namesTheGate: proportionalText.includes(
            'the command was not held long enough before it was released'),
          tellsWhatToFly: proportionalText.includes('To capture stop evidence on roll'),
          // The measurement panels say what they ARE and point at the panel that
          // advises. See the 12 August 2026 note at the head of ui/app.mjs.
          boundary: proportionalText.includes(
            'these are the numbers it was built from so you can disagree with it'),
          integralBoundary: integral.includes(
            'Any I-term recommendation is made once, at the top of the page'),
          // ...and the measurement panels themselves still name no direction.
          // A gain word appearing HERE is a second opinion on the same evidence
          // reached by a different route, which is the defect the I badge was.
          directionInMeasurementPanels: /\\b(lower|raise|increase|reduce|decrease)\\b/i.test(
            [document.getElementById('tune'),
              document.getElementById('axis-stats'),
              document.getElementById('axis-note')]
              .map(node => node.textContent).join(' ')),
          marks,
          // Machine codes are allowed, but never as the answer: each must sit
          // inside a disclosure the reader chose to open.
          bareCodes: [...document.querySelectorAll('#tune code')]
            .filter(el => !el.closest('details')).length,
          // The app must no longer claim to withhold advice ANYWHERE, on any
          // panel, while a recommendations panel sits at the top of the same
          // page. One of the two would have to be a lie.
          deniesAdvising: /does not tell you (what to change|which way)/i
            .test(document.body.textContent.replace(/\\s+/g, ' ')),
          overflowX: document.documentElement.scrollWidth
            - document.documentElement.clientWidth,
          // Reported unconditionally, not only when something overflows. This
          // once failed with "nothing identified", which names no panel and no
          // element and sends the next reader looking everywhere: an overflow
          // with no element past the edge is a scrollbar or a rounding
          // artifact, and the raw widths are the only thing that says which.
          metrics: document.documentElement.scrollWidth + '/' +
            document.documentElement.clientWidth,
          widest: [...document.querySelectorAll('body *')]
            .map(el => ({
              name: el.tagName.toLowerCase()
                + (el.id ? '#' + el.id : '')
                + (typeof el.className === 'string' && el.className
                  ? '.' + el.className.trim().split(/\\s+/).join('.') : ''),
              right: Math.round(el.getBoundingClientRect().right)
            }))
            .sort((a, b) => b.right - a.right)
            .slice(0, 5)
            .map(el => el.name + ' \\u2192 ' + el.right)
        });
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    assert.equal(axisView.exceptionDetails, undefined,
      `the axis view threw: ${JSON.stringify(axisView.exceptionDetails)}`);

    const axis = JSON.parse(axisView.result.value);
    assert.equal(axis.settled, true, 'the axis panel never rendered for the opened log');

    // Always-available measurements. A panel of em-dashes is the failure this
    // whole panel exists to prevent, so it is asserted rather than eyeballed.
    assert.ok(axis.tiles.length >= 6,
      `the axis summary must carry real measurements; got ${axis.tiles.length} tiles`);
    assert.ok(axis.dashedTiles <= 1,
      `${axis.dashedTiles} of ${axis.tiles.length} axis measurements are em-dashes: ` +
      JSON.stringify(axis.tiles));
    assert.ok(axis.tiles.some(value => /^\d/.test(value)),
      'at least one measurement must be a number a pilot can read');

    // The backing store must follow the element, not a constant. At 384 CSS px
    // the old fixed 1600 put a one-second step response in under three pixels.
    const expectedBacking = Math.round(axis.clientWidth * Math.min(axis.ratio, 3));
    assert.equal(axis.backingWidth, expectedBacking,
      `the canvas backing store is ${axis.backingWidth} for a ${axis.clientWidth} CSS px ` +
      `element at ratio ${axis.ratio}; it must be sized from the element`);
    assert.notEqual(axis.backingWidth, 1600, 'a hard-coded width is the bug this replaced');
    assert.ok(axis.clientWidth <= 384, 'the plot must fit the phone it is measured on');

    // Two traces, actually painted. The DOM cannot tell an empty canvas from a
    // full one, and a one-trace plot is the thing this panel was added to fix.
    assert.ok(axis.pixels.commanded > 50,
      `the commanded trace painted ${axis.pixels.commanded} pixels`);
    assert.ok(axis.pixels.measured > 50,
      `the measured trace painted ${axis.pixels.measured} pixels`);

    assert.ok(axis.spanZoomed < axis.spanBefore * 0.75, 'zooming in must narrow the view');
    assert.equal(axis.startMoved, true, 'panning must move the view along the flight');
    assert.equal(axis.spanRefit, axis.spanBefore, 'refitting must return to the whole flight');
    assert.notEqual(axis.captionBefore, '', 'the plot must describe the window it is showing');
    assert.match(axis.captionBefore, /samples/, 'the caption must say what is on screen');

    assert.equal(axis.statColumns, 2,
      'stat tiles must pair up at 384px; a single tall column is the 150px-minimum bug');

    // Priority 1: a blank panel must become an explanation and a manoeuvre.
    assert.equal(axis.progress, true, 'the panel must show progress against a capture target');
    assert.equal(axis.namesTheGate, true,
      'the detector refused every release in this fixture; the panel must say which gate');
    assert.equal(axis.tellsWhatToFly, true, 'the panel must name the manoeuvre to fly');
    assert.equal(axis.boundary, true,
      'each measurement panel must say what it is — the numbers the recommendation was ' +
      'built from — and point at the panel that does the advising');
    assert.equal(axis.integralBoundary, true,
      'the I panel must say plainly that the I verdict is made once, above, and not here');
    assert.equal(axis.directionInMeasurementPanels, false,
      'a measurement panel must not name a gain direction. The one place a direction is ' +
      'drawn is a recommendations card, from the engine\'s own `direction` field — a ' +
      'second opinion reached down here by another route is exactly the defect the old ' +
      '"suggests less I" badge was');
    assert.ok(axis.marks > 0,
      'refused stop candidates must be drawn on the trace, so "no evidence" is visible');
    assert.equal(axis.bareCodes, 0,
      'machine codes must live behind a disclosure, not stand in for the answer');

    // Priority: selecting P and selecting D must not be the same screen.
    assert.equal(axis.pAndDDiffer, true, 'P and D must not render identical output');
    assert.equal(axis.pMentionsTracking, true, 'P is judged on tracking error while held');
    assert.equal(axis.dMentionsRinging, true, 'D is judged on ringing after the release');

    // 12 August 2026: the owner reversed the product's defining rule. The app
    // now DOES tell a pilot what to change — see the note at the head of
    // ui/app.mjs. What must not survive the reversal is a sentence still
    // claiming the opposite while the recommendations panel sits above it.
    assert.equal(axis.deniesAdvising, false,
      'a panel still says RotorLens "does not tell you what to change" while the ' +
      'recommendations panel is on the same page. Only one of those can be true');

    assert.equal(axis.widthSettled, true,
      `the page never settled at 384 CSS px, so the width below was measured mid-resize ` +
      `and means nothing: scrollWidth/clientWidth ${axis.metrics}`);
    assert.equal(axis.overflowX, 0,
      `the axis panel must not scroll the page sideways on a phone. ` +
      `scrollWidth/clientWidth ${axis.metrics}; widest elements: ${axis.widest.join(', ')}`);

    // 8b. The asymmetry sentence is gated by the ENGINE, not by this view.
    //
    // Until 12 August 2026 `renderStopEvidence` carried its own `ratio >= 1.2`,
    // invented in the view, on a different scale from the engine's own
    // `directionalAsymmetryWarnRatio` of 0.30 — which is 1.43 on the scale the
    // sentence quotes. Mutating that literal to 1e9 or to 1.0 left all 225
    // tests green, and on the reference log it printed "Measured 1.4× higher…"
    // for yaw P from a gap the engine had simultaneously classified as NOT
    // asymmetric and explicitly refused to comment on.
    //
    // No fixture in this repo produces a stop in both directions, so the
    // sentence cannot be reached by opening one. It is reached instead through
    // the real shipped renderer, fed evidence the real engine built from real
    // stop events — and the gate is found by BISECTION rather than by restating
    // a number, so a constant that moves in the view is caught wherever it
    // moves to.
    const gate = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        const app = await import('/ui/app.mjs');
        const pid = await import('/src/analysis/pid-evidence.mjs');
        const engineGate = pid.EVIDENCE_LIMITS.directionalAsymmetryWarnRatio;
        // The engine measures |p - n| / max(|p|, |n|); the sentence quotes
        // max/min. r = 1 / (1 - gap) converts one to the other.
        const gateRatio = 1 / (1 - engineGate);

        const BASE = {trackingRmsDps: 1, fastRingingRmsDps: 1, slowOscillationRmsDps: 1,
                      commandAmplitudeDps: 120, headspeedRpm: 2000};
        function build(metric, ratio) {
          const events = [];
          for (let i = 0; i < 3; i += 1) {
            const positive = Object.assign({}, BASE, {commandSign: 'positive'});
            positive[metric] = 1;
            events.push(positive);
            const negative = Object.assign({}, BASE, {commandSign: 'negative'});
            negative[metric] = 1 / ratio;
            events.push(negative);
          }
          return {events, evidence: pid.buildDirectionalStopEvidence(events, {axis: 'yaw'})};
        }
        function render(metric, term, ratio) {
          const built = build(metric, ratio);
          return app.renderStopEvidence('yaw', term, {events: built.events},
            built.evidence, null);
        }
        const claims = html => html.indexOf('</b> higher') !== -1;

        // Smallest ratio at which the shipped renderer makes the claim.
        function boundary(metric, term) {
          if (!claims(render(metric, term, 6))) return null;
          if (claims(render(metric, term, 1.0001))) return 1;
          let lo = 1.0001, hi = 6;
          for (let i = 0; i < 60; i += 1) {
            const mid = (lo + hi) / 2;
            if (claims(render(metric, term, mid))) hi = mid; else lo = mid;
          }
          return hi;
        }

        // The renderer and the engine must agree on every gap, not just at the
        // edge. Randomised, because a hand-picked pair is how the last four
        // defects here got through.
        let disagreements = 0;
        let firstDisagreement = null;
        let above = 0;
        let below = 0;
        for (let trial = 0; trial < 800; trial += 1) {
          const ratio = 1 + Math.random() * 2.5;
          const metric = trial % 2 === 0 ? 'trackingRmsDps' : 'fastRingingRmsDps';
          const term = metric === 'trackingRmsDps' ? 'P' : 'D';
          const built = build(metric, ratio);
          const engineSaysAsymmetric = built.evidence.asymmetry[metric] > engineGate;
          const viewClaims = claims(app.renderStopEvidence('yaw', term,
            {events: built.events}, built.evidence, null));
          if (engineSaysAsymmetric) above += 1; else below += 1;
          if (engineSaysAsymmetric !== viewClaims) {
            disagreements += 1;
            if (!firstDisagreement) {
              firstDisagreement = {ratio, metric,
                gap: built.evidence.asymmetry[metric], engineSaysAsymmetric, viewClaims};
            }
          }
        }

        // Below the gate the CLAIM is withheld; the NUMBERS never are.
        const quiet = render('trackingRmsDps', 'P', gateRatio * 0.9);

        return JSON.stringify({
          engineGate,
          gateRatio,
          boundaryP: boundary('trackingRmsDps', 'P'),
          boundaryD: boundary('fastRingingRmsDps', 'D'),
          justAbove: claims(render('trackingRmsDps', 'P', gateRatio * 1.02)),
          justBelow: claims(render('trackingRmsDps', 'P', gateRatio * 0.98)),
          disagreements, firstDisagreement, above, below,
          quietStillShowsBothDirections:
            quiet.indexOf('nose left') !== -1 && quiet.indexOf('nose right') !== -1,
          quietStillShowsTheTable: quiet.indexOf('Tracking RMS') !== -1,
          quietMakesNoClaim: !claims(quiet)
        });
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    assert.equal(gate.exceptionDetails, undefined,
      `the asymmetry gate probe threw: ${JSON.stringify(gate.exceptionDetails)}`);

    const asym = JSON.parse(gate.result.value);

    // The engine's own number, pinned. Moving it is allowed and is a decision;
    // moving it silently is not.
    assert.equal(asym.engineGate, 0.30,
      'the engine\'s directionalAsymmetryWarnRatio moved; the viewer follows it, so ' +
      'update this pin deliberately rather than letting the two drift apart');

    assert.ok(asym.boundaryP !== null,
      'the shipped renderer never makes the asymmetry claim at any gap up to 6x — ' +
      'the threshold in the view has been raised out of reach');
    assert.ok(Math.abs(asym.boundaryP - asym.gateRatio) < 0.002,
      `the view starts claiming asymmetry at ${asym.boundaryP}x, but the engine's gate ` +
      `of ${asym.engineGate} is ${asym.gateRatio}x. The view is deciding this itself.`);
    assert.ok(Math.abs(asym.boundaryD - asym.gateRatio) < 0.002,
      `the D view starts claiming asymmetry at ${asym.boundaryD}x against the engine's ` +
      `${asym.gateRatio}x; the per-metric routing is wrong`);

    assert.equal(asym.justAbove, true, 'just above the engine\'s gate the claim must appear');
    assert.equal(asym.justBelow, false, 'just below the engine\'s gate it must not');

    // A sweep that never crossed the gate would pass whatever the view did.
    assert.ok(asym.above > 100 && asym.below > 100,
      `the sweep landed ${asym.above} above the gate and ${asym.below} below it; it is ` +
      'not exercising both sides');
    assert.equal(asym.disagreements, 0,
      `the view and the engine disagreed on ${asym.disagreements} of 800 randomised gaps; ` +
      `first: ${JSON.stringify(asym.firstDisagreement)}`);

    // Gating the claim must not gate the measurement.
    assert.equal(asym.quietStillShowsBothDirections, true,
      'below the gate the per-direction measurements must still be on screen');
    assert.equal(asym.quietStillShowsTheTable, true,
      'below the gate the directional table must still be on screen');
    assert.equal(asym.quietMakesNoClaim, true,
      'below the gate the app must not claim the two directions differ');

    // 8c. Vibration: reachable, legible on a phone, and honest about the three
    //     rotor states.
    //
    // `src/analysis/advisor/mechanical-spectrum.mjs` was 2,274 tested lines no
    // screen could reach. The half of it that matters most is the distinction
    // between "a rotor was compared and does not explain this tone" and
    // "nothing was compared" — collapsing those tells a pilot his main rotor is
    // ruled out on a window where its speed was never read, and sends him
    // hunting the tail, the frame or the servos. On the reference log that is
    // the COMMON case, because the headspeed moves across the recording.
    //
    // Two halves: the button is driven on the log that is actually open, which
    // proves the wiring; and sessions synthesized in the page reach all three
    // rotor states, which no fixture in this repo does.
    const vibration = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        const app = await import('/ui/app.mjs');
        const mech = await import('/src/analysis/advisor/mechanical-spectrum.mjs');
        const flat = node => node.textContent.replace(/\\s+/g, ' ').trim();
        const box = document.getElementById('vibration');

        // --- half one: the real button, on the log that is open --------------
        const button = document.getElementById('vibration-run');
        const enabledForRealLog = !button.disabled;
        const rangeLabel = document.getElementById('vibration-range').textContent;
        button.click();
        let ran = false;
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const shown = flat(box);
          if (shown.length > 0 && shown.indexOf('Measuring') === -1) { ran = true; break; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        const live = flat(box);
        const liveOverflow = document.documentElement.scrollWidth
          - document.documentElement.clientWidth;

        // --- half two: every rotor state, from sessions built right here -----
        function synth(options) {
          const withHeadspeed = options.withHeadspeed;
          const toneHz = options.toneHz;
          const rpm = options.rpm;
          const filtered = options.filtered === true;
          const seconds = options.seconds === undefined ? 20 : options.seconds;
          const rateHz = 1000;
          const prefix = filtered ? 'gyroADC[' : 'gyroRAW[';
          const fields = [{name: 'time'}, {name: prefix + '0]'},
            {name: prefix + '1]'}, {name: prefix + '2]'}];
          if (withHeadspeed) fields.push({name: 'headspeed'});
          fields.forEach((field, i) => { field.index = i; });

          const count = Math.round(seconds * rateHz);
          const samples = new Array(count);
          let seed = 12345;
          const noise = () => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed / 0x7fffffff - 0.5;
          };
          for (let i = 0; i < count; i += 1) {
            const t = i / rateHz;
            const tone = 12 * Math.sin(2 * Math.PI * toneHz * t);
            const row = [Math.round(t * 1e6), tone + noise() * 2,
              tone * 0.5 + noise() * 2, noise() * 2];
            if (withHeadspeed) row.push(rpm);
            samples[i] = row;
          }
          return {fields, samples};
        }
        async function measure(options) {
          const session = synth(options);
          const started = performance.now();
          const view = await mech.summarizeMechanicalVibration(session, {
            timeRangeUs: {startTimeUs: 0,
              endTimeUs: session.samples[session.samples.length - 1][0]}
          });
          return {view, html: app.vibrationHtml(view),
            elapsedMs: performance.now() - started};
        }
        const rotorStates = view => {
          const out = [];
          view.axes.forEach(axis => axis.peaks.forEach(
            peak => out.push(peak.rotorHarmonic.state)));
          return out;
        };

        // 2040 rpm head = 34 Hz; 102 Hz is its third order.
        const explained = await measure({withHeadspeed: true, rpm: 2040, toneHz: 102});
        // Same tone, no rotor column at all: nothing was compared.
        const notChecked = await measure({withHeadspeed: false, toneHz: 102});
        // Rotor readable, tone is not any of its orders.
        const notExplained = await measure({withHeadspeed: true, rpm: 2040, toneHz: 77});
        // A filtered gyro publishes no peaks and cannot read as clear.
        const filtered = await measure({withHeadspeed: true, rpm: 2040, toneHz: 102,
          filtered: true});

        // Render the not-checked one into the live panel and measure it at 384.
        box.innerHTML = notChecked.html;
        const notCheckedOverflow = document.documentElement.scrollWidth
          - document.documentElement.clientWidth;
        const notCheckedWidest = [...document.querySelectorAll('#vibration *')]
          .map(el => ({
            name: el.tagName.toLowerCase()
              + (el.className && typeof el.className === 'string'
                ? '.' + el.className.trim().split(/\\s+/).join('.') : ''),
            right: Math.round(el.getBoundingClientRect().right)
          }))
          .sort((a, b) => b.right - a.right)
          .slice(0, 5)
          .map(el => el.name + ' \\u2192 ' + el.right);
        const notCheckedMetrics = document.documentElement.scrollWidth + '/' +
          document.documentElement.clientWidth;
        const notCheckedText = flat(box);

        return JSON.stringify({
          enabledForRealLog, rangeLabel, ran, live, liveOverflow,
          liveStatus: (function () {
            const parsed = {};
            parsed.saysNotMeasured = live.indexOf('not measured') !== -1;
            parsed.explainsNotMeasured =
              live.indexOf('not the same as a quiet aircraft') !== -1;
            parsed.claimsClear =
              live.indexOf('no persistent vibration above the attention threshold') !== -1;
            parsed.showsThresholdCaveat = live.indexOf('not a published limit') !== -1;
            return parsed;
          })(),
          explained: {status: explained.view.status, states: rotorStates(explained.view),
            saysOrder: explained.html.indexOf('main 3/rev') !== -1,
            ms: explained.elapsedMs},
          notChecked: {status: notChecked.view.status, states: rotorStates(notChecked.view),
            saysNotChecked: notChecked.html.indexOf('rotor not checked') !== -1,
            saysNeither: notChecked.html.indexOf('neither blamed nor ruled out') !== -1,
            wronglySaysNoHarmonic: notChecked.html.indexOf('no rotor harmonic') !== -1,
            namesTheMissingRotor: notChecked.html.indexOf('headspeed') !== -1,
            ms: notChecked.elapsedMs},
          notExplained: {states: rotorStates(notExplained.view),
            saysNoHarmonic: notExplained.html.indexOf('no rotor harmonic') !== -1,
            wronglySaysNotChecked:
              notExplained.html.indexOf('rotor not checked') !== -1},
          filtered: {status: filtered.view.status,
            peaks: filtered.view.axes.reduce((n, a) => n + a.peaks.length, 0),
            saysFilterChain: filtered.html.indexOf('filter chain') !== -1,
            saysNotQuiet: filtered.html.indexOf('not a quiet aircraft') !== -1,
            claimsClear: filtered.html.indexOf(
              'no persistent vibration above the attention threshold') !== -1},
          notCheckedOverflow, notCheckedWidest, notCheckedMetrics, notCheckedText,
          instructions: /suggests (more|less)|reduce your|increase your|raise the|lower the/i
            .test(notCheckedText + ' ' + live)
        });
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    assert.equal(vibration.exceptionDetails, undefined,
      `the vibration panel threw: ${JSON.stringify(vibration.exceptionDetails)}`);

    const vib = JSON.parse(vibration.result.value);

    // The wiring: a button a pilot can actually reach, on the log he opened.
    assert.equal(vib.enabledForRealLog, true,
      'the vibration button must be live once a log with a usable axis is open');
    assert.match(vib.rangeLabel, /s of flight/,
      'the panel must say which window it is about to measure');
    assert.equal(vib.ran, true,
      'the vibration measurement never completed on the open log; the panel is stuck ' +
      'on "Measuring…", which on a phone is a frozen screen');

    // This fixture is 0.1 s long, so nothing can be measured on it. That must
    // never render like a quiet aircraft.
    assert.equal(vib.liveStatus.claimsClear, false,
      'an unmeasurable window must never claim the aircraft is clear — "insufficient" ' +
      'means nothing was measured, and rendering it like "clear" tells a pilot his ' +
      'helicopter was checked and passed when it was never checked at all');
    assert.equal(vib.liveStatus.saysNotMeasured, true,
      'an unmeasurable window must say so');
    assert.equal(vib.liveStatus.explainsNotMeasured, true,
      '"nothing was measured" must be spelled out as different from "nothing is wrong"');
    assert.equal(vib.liveStatus.showsThresholdCaveat, true,
      'the attention threshold is one experimental scalar and must say so wherever it shows');
    assert.equal(vib.liveOverflow, 0,
      'the vibration panel must not scroll the page sideways on a phone');

    // The three rotor states, each reached and each rendered as itself.
    assert.ok(vib.explained.states.includes('explained'),
      `a 102 Hz tone on a steady 2040 rpm head is its 3rd order and must be explained; ` +
      `got ${JSON.stringify(vib.explained.states)}`);
    assert.equal(vib.explained.saysOrder, true, 'an explained peak must name the order');

    assert.ok(vib.notChecked.states.includes('not-checked'),
      `the same tone with no rotor column must be "not-checked"; got ` +
      `${JSON.stringify(vib.notChecked.states)}`);
    assert.equal(vib.notChecked.wronglySaysNoHarmonic, false,
      'THE defect this panel exists to avoid: "nothing was compared" rendered as ' +
      '"no rotor harmonic" tells a pilot his head is ruled out and sends him to the ' +
      'tail, the frame or the servos');
    assert.equal(vib.notChecked.saysNotChecked, true,
      'a peak nothing was compared against must say it was not checked');
    assert.equal(vib.notChecked.saysNeither, true,
      'the panel must say plainly that "not checked" neither blames nor clears the rotor');
    assert.equal(vib.notChecked.namesTheMissingRotor, true,
      'the panel must name which rotor could not be read');

    assert.ok(vib.notExplained.states.includes('not-explained'),
      `a 77 Hz tone against a readable 2040 rpm head is not any of its orders; got ` +
      `${JSON.stringify(vib.notExplained.states)}`);
    assert.equal(vib.notExplained.saysNoHarmonic, true,
      'a peak that WAS compared and does not match must say so');
    assert.equal(vib.notExplained.wronglySaysNotChecked, false,
      'a peak that was compared must not be drawn as unchecked');

    // A filtered gyro publishes no peaks. An empty list is a missing
    // measurement, not a quiet aircraft.
    assert.equal(vib.filtered.peaks, 0, 'a filtered gyro must publish no peaks');
    assert.notEqual(vib.filtered.status, 'clear',
      'a filtered gyro can never establish that an aircraft is quiet');
    assert.equal(vib.filtered.claimsClear, false,
      'the filtered-gyro panel must not render the "clear" sentence');
    assert.equal(vib.filtered.saysFilterChain, true,
      'the panel must say the samples came out of the filter chain');
    assert.equal(vib.filtered.saysNotQuiet, true,
      'an empty peak list from a filtered gyro must say it is not a quiet aircraft');

    // Legible on the phone this app ships to.
    assert.equal(vib.notCheckedOverflow, 0,
      `a rendered vibration result must fit a 384px phone. scrollWidth/clientWidth ` +
      `${vib.notCheckedMetrics}; widest elements: ${vib.notCheckedWidest.join(', ')}`);
    assert.ok(vib.notCheckedText.length > 200,
      'the vibration result rendered almost nothing');

    // Constraint 4, on the newest panel too.
    assert.equal(vib.instructions, false,
      'the vibration panel must not tell a pilot what to change on the aircraft');

    // Responsiveness. Order-of-magnitude guard only — a phone WebView is several
    // times slower than this headless browser, and nobody has run it on the
    // handset. See the note on runVibration for why this is a button.
    assert.ok(vib.explained.ms < 3000,
      `a 20 s window took ${Math.round(vib.explained.ms)} ms in the browser; that is no ` +
      'longer a tap, it is a freeze, and the work belongs in a Worker');

    // 10. THE RECOMMENDATIONS PANEL, on a log driven through the real file input.
    //
    // This is the screen the owner reversed the product's defining rule for on
    // 12 August 2026 — see the note at the head of ui/app.mjs. Everything here
    // is measured after a real log has gone through the real file input at the
    // width the app ships at, with NOTHING clicked: the whole point is that a
    // pilot who opens a log is told what to fix without hunting for a button.
    //
    // rf46-stop-manoeuvres.TXT is used because it reaches a full captured
    // directional result with a deliberate 2.8x asymmetry built in, so the
    // engine has real evidence to rank rather than a page of empty gates.
    const advice = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        const bytes = await (await fetch(
          '/fixtures/synthetic/rf46-stop-manoeuvres.TXT'
        )).arrayBuffer();
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], 'STOPS.BBL'));
        const input = document.getElementById('file');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change'));

        // Wait for THIS log, not for the cards the previous one left behind.
        let settled = false;
        for (let attempt = 0; attempt < 400; attempt += 1) {
          if (document.getElementById('status').textContent.indexOf('STOPS.BBL') !== -1
              && document.querySelectorAll('#recommend .finding').length > 0) {
            settled = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        const {state} = await import('/ui/app.mjs');
        const flat = value => String(value).replace(/\\s+/g, ' ').trim();
        const cards = [...document.querySelectorAll('#recommend .finding')];
        const findings = state.recommendations ? state.recommendations.findings : [];
        const panelText = flat(document.getElementById('recommend').textContent);

        const sections = [...document.querySelectorAll('main > section')].map(el => el.id);

        // Every card, in the order the DOM has them, against the finding the
        // engine put at that index. A renderer that sorts, filters or drops one
        // reorders the tuning ladder, which is the one thing the list IS.
        let misordered = 0;
        let firstMisordered = null;
        findings.forEach((finding, at) => {
          const card = cards[at];
          const text = card ? flat(card.textContent) : '';
          if (!card || text.indexOf(flat(finding.headline)) === -1) {
            misordered += 1;
            if (!firstMisordered) {
              firstMisordered = {at: at, id: finding.id,
                headline: flat(finding.headline).slice(0, 70),
                card: text.slice(0, 120)};
            }
          }
        });

        const changeBoxes = [...document.querySelectorAll('#recommend .finding .change')];
        const adjustments = findings.filter(
          finding => finding.kind === 'adjustment' && finding.direction);

        // Which cards carry things only certain kinds may carry.
        let cardsWithoutTwoPills = 0;
        let cardsMissingWhy = 0;
        let cardsMissingBasis = 0;
        let blockersWithoutUnblock = 0;
        let candidatesMissing = 0;
        let confirmsMissing = 0;
        findings.forEach((finding, at) => {
          const text = cards[at] ? flat(cards[at].textContent) : '';
          if (text.indexOf('Why') === -1
              || text.indexOf(flat(finding.reasoning)) === -1) {
            cardsMissingWhy += 1;
          }
          // The kind and the confidence, both, on every card: "what this is"
          // and "how sure" are the two things a pilot needs before the wording.
          if (!cards[at] || cards[at].querySelectorAll('.step .pill').length !== 2) {
            cardsWithoutTwoPills += 1;
          }
          if (finding.basis.length > 0
              && text.indexOf('The measurements behind this') === -1) {
            cardsMissingBasis += 1;
          }
          if (finding.kind === 'blocker' && finding.confirm
              && text.indexOf('What would unblock this') === -1) {
            blockersWithoutUnblock += 1;
          }
          for (const candidate of finding.candidates) {
            if (text.indexOf(flat(candidate)) === -1) {
              candidatesMissing += 1;
            }
          }
          if (finding.confirm && text.indexOf(flat(finding.confirm)) === -1) {
            confirmsMissing += 1;
          }
        });

        // Is any card's headline sentence actually written in a pilot's words,
        // or is the plain-English layer echoing the engine?
        let rewritten = 0;
        findings.forEach((finding, at) => {
          const plain = cards[at] ? cards[at].querySelector('.plain') : null;
          if (plain && flat(plain.textContent) !== flat(finding.headline)) {
            rewritten += 1;
          }
        });

        const yawAsymmetry = findings.find(
          finding => finding.id === 'DIRECTIONAL_ASYMMETRY_MECHANICAL'
            && finding.axis === 'yaw');
        const yawCard = yawAsymmetry
          ? flat(cards[findings.indexOf(yawAsymmetry)].textContent) : '';

        // 44px, measured on the laid-out element rather than asserted from CSS.
        const controls = [...document.querySelectorAll(
          'main select, main button, main input[type=range]')]
          .filter(el => el.offsetParent !== null);
        const small = controls
          .filter(el => el.getBoundingClientRect().height < 44)
          .map(el => (el.id || el.tagName.toLowerCase()) + ' \\u2192 '
            + Math.round(el.getBoundingClientRect().height));

        return JSON.stringify({
          settled,
          sections,
          recommendIndex: sections.indexOf('recommend-panel'),
          windowIndex: sections.indexOf('window-panel'),
          axisIndex: sections.indexOf('axis-panel'),
          tuneIndex: sections.indexOf('tune-panel'),
          statusIndex: sections.indexOf('status-panel'),
          // The measurement panels must all still be on the page.
          keepsPlot: sections.indexOf('plot-panel') !== -1,
          keepsFields: sections.indexOf('fields-panel') !== -1,
          // ...and the tune panel must still be waiting to be asked, which is
          // how we know the advice above did not come from pressing Analyse.
          tuneUntouched: flat(document.getElementById('tune').textContent)
            .indexOf('Pick a term and analyse') === 0,
          cardCount: cards.length,
          findingCount: findings.length,
          misordered, firstMisordered,
          actNowCards: document.querySelectorAll('#recommend .finding.act-now').length,
          actNowFindings: findings.filter(finding => finding.actNow).length,
          // A coloured border is not a label. The one change must be named.
          actNowSaysStartHere: (() => {
            const card = document.querySelector('#recommend .finding.act-now');
            return card ? /Start here/.test(card.textContent) : null;
          })(),
          blockerPillIsNotAnImperativePerCard:
            (panelText.match(/sort this out first/gi) || []).length,
          actNowIndexMatches: (() => {
            const at = findings.findIndex(finding => finding.actNow);
            if (at === -1) return document.querySelector('#recommend .act-now') === null;
            return cards[at] ? cards[at].classList.contains('act-now') : false;
          })(),
          changeBoxes: changeBoxes.length,
          adjustments: adjustments.length,
          // A direction may only ever be drawn inside an adjustment card.
          strayDirections: changeBoxes.filter(box =>
            !box.closest('.finding').classList.contains('kind-adjustment')).length,
          cardsMissingWhy, cardsMissingBasis, blockersWithoutUnblock, cardsWithoutTwoPills,
          candidatesMissing, confirmsMissing, rewritten,
          yawSaysTail: yawCard.indexOf('tail') !== -1,
          kinds: findings.map(finding => finding.kind),
          ids: findings.map(finding => finding.id),
          // Machine codes are allowed, never as the answer.
          bareCodes: [...document.querySelectorAll('#recommend code')]
            .filter(el => !el.closest('details')).length,
          gatePills: document.querySelectorAll('#recommend .gate-row .pill').length,
          showsBoundary: state.recommendations
            ? panelText.indexOf(flat(state.recommendations.boundary)) !== -1 : false,
          refusesToGuessAmount: panelText.indexOf('One step, then fly it again') !== -1,
          explainsConfidence: panelText.indexOf('What the confidence words mean') !== -1,
          // A blocked gate must say what would unblock it, in words. "Insufficient
          // evidence" is the phrasing this panel exists to not use.
          saysInsufficientEvidence: /insufficient evidence/i.test(panelText),
          statusLine: flat(document.getElementById('recommend-status').textContent),
          small,
          overflowX: document.documentElement.scrollWidth
            - document.documentElement.clientWidth,
          metrics: document.documentElement.scrollWidth + '/'
            + document.documentElement.clientWidth,
          widest: [...document.querySelectorAll('#recommend-panel *')]
            .map(el => ({
              name: el.tagName.toLowerCase()
                + (el.id ? '#' + el.id : '')
                + (typeof el.className === 'string' && el.className
                  ? '.' + el.className.trim().split(/\\s+/).join('.') : ''),
              right: Math.round(el.getBoundingClientRect().right)
            }))
            .sort((a, b) => b.right - a.right).slice(0, 5)
            .map(el => el.name + ' \\u2192 ' + el.right)
        });
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    assert.equal(advice.exceptionDetails, undefined,
      `the recommendations panel threw: ${JSON.stringify(advice.exceptionDetails)}`);

    const said = JSON.parse(advice.result.value);
    assert.equal(said.settled, true,
      'no recommendation ever appeared for a log opened through the real file input; ' +
      `the panels present were ${said.sections}`);

    // It is the FIRST thing after the log opens: not behind an Analyse button,
    // not behind an axis picker, not below the session summary.
    assert.ok(said.recommendIndex > said.statusIndex,
      'the recommendations panel must come after the status line');
    assert.ok(said.recommendIndex < said.axisIndex && said.recommendIndex < said.tuneIndex,
      `the recommendations panel is at ${said.recommendIndex}, below the axis panel at ` +
      `${said.axisIndex}; a pilot opened the log to find out what to fix`);
    assert.ok(said.windowIndex < said.axisIndex,
      'the flight window every number is measured over must be above the numbers');
    assert.equal(said.tuneUntouched, true,
      'the tune panel has rendered, so the advice above may have come from pressing ' +
      'Analyse rather than from opening the log');

    // The raw numbers stay reachable — requirement 3.
    assert.equal(said.keepsPlot, true, 'the any-signal plot must not be removed');
    assert.equal(said.keepsFields, true, 'the field list must not be removed');

    assert.ok(said.findingCount >= 4,
      `this fixture should produce a full ladder of findings; got ${said.findingCount}`);
    assert.equal(said.cardCount, said.findingCount,
      `${said.cardCount} cards rendered for ${said.findingCount} findings`);
    assert.equal(said.misordered, 0,
      'a card does not carry the finding the engine put at its index, so the rendered ' +
      'order is not the engine\'s order — and the order IS the advice. First: ' +
      JSON.stringify(said.firstMisordered));

    // At most one change to make, and it is the one the engine named.
    assert.ok(said.actNowFindings <= 1, 'the engine may mark at most one finding actNow');
    assert.equal(said.actNowCards, said.actNowFindings,
      `${said.actNowCards} cards are drawn as the one change to make against ` +
      `${said.actNowFindings} in the result`);
    assert.equal(said.actNowIndexMatches, true,
      'the card drawn as "the one change" is not the finding the engine marked');
    assert.equal(said.actNowSaysStartHere, said.actNowFindings === 1 ? true : null,
      'the one change to make must be NAMED, not only drawn in a different border — a ' +
      'colour is not a label to someone who has never seen this screen before');
    assert.equal(said.blockerPillIsNotAnImperativePerCard, 0,
      'several findings can be blockers at once, so a per-card imperative reads as three ' +
      'things to do. Exactly one card may say where to start');

    // Only an adjustment may show a direction. The engine's contract, enforced
    // on the shipped renderer rather than restated in it.
    assert.equal(said.changeBoxes, said.adjustments,
      `${said.changeBoxes} direction boxes for ${said.adjustments} adjustments in the ` +
      `result; kinds were ${said.kinds}`);
    assert.equal(said.strayDirections, 0,
      'a direction is drawn on a card that is not an adjustment');

    assert.equal(said.cardsWithoutTwoPills, 0,
      `${said.cardsWithoutTwoPills} cards do not carry both a kind and a confidence pill`);
    assert.equal(said.cardsMissingWhy, 0,
      `${said.cardsMissingWhy} cards do not carry the engine's reasoning; a headline with ` +
      'no "why" is an oracle');
    assert.equal(said.cardsMissingBasis, 0,
      `${said.cardsMissingBasis} findings with measurements behind them do not show them. ` +
      'The basis is what makes a recommendation checkable against the trace');
    assert.equal(said.confirmsMissing, 0,
      `${said.confirmsMissing} findings do not show what to fly next`);
    assert.equal(said.blockersWithoutUnblock, 0,
      `${said.blockersWithoutUnblock} blockers do not say what would unblock them`);
    assert.equal(said.candidatesMissing, 0,
      'a finding names candidate causes the card does not list');

    assert.ok(said.rewritten >= 1,
      'not one card is written in anything but the engine\'s own wording, so the ' +
      'plain-English layer is doing nothing at all');
    assert.equal(said.yawSaysTail, true,
      'a yaw finding must reach the pilot as his tail, not as an axis index');

    assert.equal(said.bareCodes, 0,
      'machine codes must live behind a disclosure, not stand in for the answer');
    assert.equal(said.gatePills, 2,
      'the airframe and head-speed gates must both show their own status');
    assert.equal(said.showsBoundary, true,
      'the never-writes-to-a-flight-controller sentence must be on every result');
    assert.equal(said.refusesToGuessAmount, true,
      '`magnitudes` is empty by contract, and the panel must say so — "how far" is the ' +
      'next question a pilot asks and silence there invites him to invent an answer');
    assert.equal(said.explainsConfidence, true,
      'the confidence words must be defined somewhere the reader can reach');
    assert.equal(said.saysInsufficientEvidence, false,
      'a gate that blocked advice must say what would unblock it, in words a pilot can ' +
      'act on — "insufficient evidence" is exactly the phrasing this panel replaced');
    assert.match(said.statusLine, /flight window/,
      'the panel must say which window it was measured over');

    assert.deepEqual(said.small, [],
      `every control must be at least 44px on the handset; these are not: ${said.small}`);
    assert.equal(said.overflowX, 0,
      `the recommendations panel must not scroll the page sideways at 384px. ` +
      `scrollWidth/clientWidth ${said.metrics}; widest: ${said.widest.join(', ')}`);

    // 11. THE FLIGHT WINDOW, and every panel keyed off it.
    //
    // The owner: "i dont see where they can set the I/O on their .bbl because
    // you only need the log to show from the time it takes off to the time it
    // lands". Two panels quoting numbers from two different stretches of flight
    // is worse than either panel not existing, so what is proven here is not
    // that a slider moves — it is that moving it MOVES THE NUMBERS.
    const flightWindow = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        const {state} = await import('/ui/app.mjs');
        const flat = node => node.textContent.replace(/\\s+/g, ' ').trim();
        const tiles = () => [...document.querySelectorAll('#axis-stats .stat .v')]
          .map(el => el.textContent.trim());
        const strip = document.getElementById('window-plot');
        window.__errs = [];
        window.addEventListener('error', e => window.__errs.push(String(e.message)));
        window.addEventListener('unhandledrejection',
          e => window.__errs.push('rej ' + String(e.reason && e.reason.stack)));

        // How much TRACE is still legible in one vertical slice of a canvas.
        //
        // Not mean brightness, which was the first attempt and was a test that
        // agreed with the bug: a canvas is cleared to TRANSPARENT black, so a
        // dark translucent overlay lightens every empty pixel by as much as it
        // darkens the drawn ones, and the mean barely moves. Counting the
        // pixels still bright enough to read as a trace measures the thing the
        // requirement is actually about — whether a pilot can see that this
        // stretch of flight was thrown away.
        //
        // A trace pixel is #4aa8ff (sum 497) or #f0a33c (sum 545); under the
        // 0.74 overlay both fall to about 168, so 300 separates them cleanly.
        const legibleTrace = (canvas, fromFraction, toFraction) => {
          const context = canvas.getContext('2d');
          const x = Math.round(canvas.width * fromFraction);
          const width = Math.max(1,
            Math.round(canvas.width * (toFraction - fromFraction)));
          const data = context.getImageData(x, 0, width, canvas.height).data;
          let bright = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] > 32 && data[i] + data[i + 1] + data[i + 2] > 300) {
              bright += 1;
            }
          }
          return bright;
        };
        const brightness = (fromFraction, toFraction) =>
          legibleTrace(strip, fromFraction, toFraction);

        const settle = async () => {
          for (let attempt = 0; attempt < 400; attempt += 1) {
            if (document.querySelectorAll('#recommend .finding').length > 0
                && document.getElementById('axis-stats').children.length > 0) {
              return true;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          return false;
        };

        const drag = async (startPermille, endPermille) => {
          const start = document.getElementById('window-start');
          const end = document.getElementById('window-end');
          start.value = String(startPermille);
          end.value = String(endPermille);
          start.dispatchEvent(new Event('input', {bubbles: true}));
          end.dispatchEvent(new Event('input', {bubbles: true}));
          // 'change' is what a slider fires when the finger comes off, and it
          // is what the app commits on. If it committed on 'input' instead, a
          // phone would re-run seconds of hold sweeps at 60 Hz.
          end.dispatchEvent(new Event('change', {bubbles: true}));
          await new Promise(resolve => setTimeout(resolve, 50));
          return settle();
        };

        const detectedBasis = state.window.basis;
        const detectedStartUs = state.window.startUs;
        const wholeLogTiles = tiles();
        const wholeLogExcursions = state.axisSummary.commandExcursionCount;
        const leftBefore = brightness(0, 0.25);

        // The same question of the axis trace, which is the picture a pilot
        // checks a recommendation against. Both readings are taken with the
        // view showing the whole recording, so the only thing that differs
        // between them is the overlay.
        const plot = document.getElementById('axis-plot');
        const plotBrightness = (fromFraction, toFraction) =>
          legibleTrace(plot, fromFraction, toFraction);
        document.getElementById('axis-fit').click();
        document.getElementById('axis-out').click();
        document.getElementById('axis-out').click();
        const plotLeftBefore = plotBrightness(0.12, 0.3);
        const shownTimes = flat(document.getElementById('window-times'));
        const basisText = flat(document.getElementById('window-basis'));

        // --- drag the takeoff end a long way in --------------------------
        const dragged = await drag(400, 900);
        const afterDrag = {
          cards: document.querySelectorAll('#recommend .finding').length,
          tiles: document.querySelectorAll('#axis-stats .stat').length,
          text: document.getElementById('recommend').textContent
            .replace(/\s+/g, ' ').trim().slice(0, 200),
          status: document.getElementById('recommend-status').textContent
        };
        const draggedTiles = tiles();
        const leftAfter = brightness(0, 0.25);
        const draggedExcursions = state.axisSummary.commandExcursionCount;
        const logSpan = state.window.logEndUs - state.window.logStartUs;
        const wantedStartUs = state.window.logStartUs + logSpan * 0.4;
        const draggedEndUs = state.window.endUs;

        // The axis trace, FIRST and on the same axis and the same view as the
        // reading taken before the drag. Everything below this changes the axis
        // or draws stop marks on the plot, and a brightness reading taken after
        // either of those is comparing two different pictures — which is how
        // this assertion passed against a plot that was not dimmed at all.
        document.getElementById('axis-fit').click();
        const viewStartUs = state.view.startUs;
        const viewSpanUs = state.view.spanUs;
        document.getElementById('axis-out').click();
        document.getElementById('axis-out').click();
        const plotLeftAfter = plotBrightness(0.12, 0.3);
        const axisCaption = flat(document.getElementById('axis-plot-caption'));

        // Does the tune panel measure the same window? Switch the axis first,
        // which drops the cached records: otherwise analyse() reuses the array
        // the recommendations run left behind and the tune panel's OWN build
        // path is never exercised at all.
        document.getElementById('axis').value = 'yaw';
        document.getElementById('axis').dispatchEvent(new Event('change'));
        document.getElementById('term').value = 'P';
        document.getElementById('analyse').click();
        const firstRecordUs = state.records && state.records.length
          ? state.records[0].timeUs : null;
        const lastRecordUs = state.records && state.records.length
          ? state.records[state.records.length - 1].timeUs : null;

        // --- an impossible window must be refused, not obeyed ------------
        await drag(500, 500);
        const refusedBasis = state.window.basis;
        const refusedCheck = state.window.overrideCheck
          ? state.window.overrideCheck.code : null;
        const refusedNote = flat(document.getElementById('window-note'));

        // --- whole log, then back to the detected flight -----------------
        document.getElementById('window-whole').click();
        await settle();
        const wholeBasis = state.window.basis;
        const wholeCovers = state.window.startUs === state.window.logStartUs
          && state.window.endUs === state.window.logEndUs;

        document.getElementById('window-detect').click();
        await settle();

        return JSON.stringify({
          detectedBasis, basisText, shownTimes,
          dragged,
          // Carried so that "never re-settled" names WHY. It reported "The
          // requested time range lies outside this session" the first time this
          // ran, which was a real defect — the mechanical analysis rejects a
          // range starting before the first sample it was handed, and a window
          // dragged with a finger lands between samples essentially always. A
          // bare timeout would have sent the next reader looking at the poll.
          errs: window.__errs, afterDrag,
          leftBefore, leftAfter, plotLeftBefore, plotLeftAfter,
          wholeLogTiles, draggedTiles,
          wholeLogExcursions, draggedExcursions,
          firstRecordUs, lastRecordUs, draggedEndUs,
          viewStartUs, viewSpanUs,
          axisCaption,
          refusedBasis, refusedCheck, refusedNote,
          wholeBasis, wholeCovers,
          restoredBasis: state.window.basis,
          restoredStartUs: state.window.startUs,
          detectedStartUs,
          overrideCleared: state.windowOverride === null,
          wantedStartUs
        });
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    assert.equal(flightWindow.exceptionDetails, undefined,
      `the flight window threw: ${JSON.stringify(flightWindow.exceptionDetails)}`);

    const win = JSON.parse(flightWindow.result.value);
    assert.equal(win.dragged, true, 'the page never re-settled after the window was dragged: '
      + JSON.stringify({errs: win.errs, afterDrag: win.afterDrag}));
    assert.match(win.shownTimes, /Takeoff/,
      'the detected takeoff must be shown, not just used');
    assert.match(win.shownTimes, /Landing/, 'and the detected landing');
    assert.ok(win.basisText.length > 40,
      `the window must say WHY it is where it is; got "${win.basisText}"`);

    // What is outside the window is visible on the trace, not only as two times.
    assert.ok(win.leftBefore > 50,
      `only ${win.leftBefore} legible trace pixels in the left quarter of the window strip ` +
      'before anything was trimmed, so the comparison below would prove nothing');
    assert.ok(win.leftAfter < win.leftBefore * 0.25,
      `trimming the first 40% of the recording did not visibly dim it on the window strip: ` +
      `${win.leftBefore} legible trace pixels there before, ${win.leftAfter} after. Two ` +
      'timestamps are not a picture of what was thrown away');
    assert.match(win.axisCaption, /outside the flight window/,
      'the axis trace must say that its dimmed stretch is outside the window');
    assert.ok(win.plotLeftBefore > 50,
      `only ${win.plotLeftBefore} legible trace pixels in that slice of the axis plot ` +
      'before the window was trimmed, so the comparison below would prove nothing');
    assert.ok(win.plotLeftAfter < win.plotLeftBefore * 0.25,
      `the axis trace says in its caption that part of it is outside the window, but that ` +
      `part is not actually painted over: ${win.plotLeftBefore} legible trace pixels in ` +
      `the same slice with the same view before, ${win.plotLeftAfter} after. A caption ` +
      'claiming a picture that is not there is worse than no caption');

    // ...and every analysis on the page moved with it.
    assert.notDeepEqual(win.draggedTiles, win.wholeLogTiles,
      'the axis summary is identical over 100% and 50% of the recording, so it is not ' +
      'measured over the flight window at all');
    assert.ok(win.draggedExcursions < win.wholeLogExcursions,
      `${win.draggedExcursions} command excursions over half the flight against ` +
      `${win.wholeLogExcursions} over all of it — the summary is not being windowed`);
    assert.ok(win.firstRecordUs >= win.wantedStartUs - 100_000,
      `the tune panel's records start at ${win.firstRecordUs} us, before the window at ` +
      `${win.wantedStartUs} us; two panels are measuring different stretches of flight`);
    assert.ok(win.lastRecordUs <= win.draggedEndUs,
      `the tune panel's records run to ${win.lastRecordUs} us, past the window's landing ` +
      `end at ${win.draggedEndUs} us — the far end of the window is not being obeyed`);
    assert.ok(Math.abs(win.viewStartUs - win.wantedStartUs) < 200_000,
      '"Flight window" must fit the trace to the window the numbers came from');

    // A window nothing can be measured over is refused and explained, not obeyed.
    assert.equal(win.refusedCheck, 'WINDOW_INVERTED',
      `a zero-length window must be reported as such; got ${win.refusedCheck}`);
    assert.notEqual(win.refusedBasis, 'CALLER_SUPPLIED_WINDOW',
      'a window nothing can be measured over must not be accepted');
    assert.ok(win.refusedNote.length > 10,
      'a refused window must say why on screen, not silently snap back');

    assert.equal(win.wholeCovers, true, '"Whole log" must select the whole recording');
    assert.equal(win.wholeBasis, 'CALLER_SUPPLIED_WINDOW',
      'and it must go through the override path like any other pilot-set window');
    assert.equal(win.restoredBasis, win.detectedBasis,
      '"Use the detected flight" must go back to what was detected');
    assert.equal(win.restoredStartUs, win.detectedStartUs,
      'and to the same instant it detected the first time');
    assert.equal(win.overrideCleared, true,
      'and it must clear the override rather than pinning the detected times as one');

    // 11b. EVERY window basis, and the drawing path no fixture in this repository
    //      can reach.
    //
    // Neither log here contains a spool-up followed by a liftoff, so
    // FLIGHT_WINDOW_DETECTED — the ordinary case for every real flight — is a
    // branch that opening a log cannot exercise, and so are the takeoff and
    // landing markers and the threshold rules drawn beside them. A throw in any
    // of them reaches the phone as a broken window panel on every flight that
    // works.
    const windowCopy = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        const app = await import('/ui/app.mjs');
        const fw = await import('/src/analysis/flight-window.mjs');
        const flat = value => String(value).replace(/\\s+/g, ' ').trim();

        // Every basis the engine can return must have words here. An unmapped
        // one falls through to its raw code, which is not a sentence.
        const probe = document.createElement('div');
        const unexplained = [];
        const rendered = {};
        for (const basis of Object.values(fw.FlightWindowBasis)) {
          probe.innerHTML = app.windowBasisHtml({
            basis,
            corroboration: {airborneEvent: {state: 'absent', timeUs: null, transitions: 0},
              airborneEventAgreementUs: null}
          });
          const text = flat(probe.textContent);
          rendered[basis] = text.slice(0, 60);
          if (text.indexOf(basis) !== -1 || text.length < 60) {
            unexplained.push(basis);
          }
        }

        // The corroboration branches, each fed directly.
        probe.innerHTML = app.windowBasisHtml({
          basis: fw.FlightWindowBasis.DETECTED,
          corroboration: {airborneEvent: {state: 'latched', timeUs: 5, transitions: 1},
            airborneEventAgreementUs: 1250000}
        });
        const agreeing = flat(probe.textContent);

        probe.innerHTML = app.windowBasisHtml({
          basis: fw.FlightWindowBasis.CALLER_SUPPLIED,
          corroboration: {airborneEvent: {state: 'latched', timeUs: 5, transitions: 1},
            airborneEventAgreementUs: null}
        });
        const latchedNoGap = flat(probe.textContent);

        // ---- the strip, drawn for a DETECTED flight ----------------------
        // state.window is replaced with a detected-shaped one whose times lie
        // inside the log that is actually open, then the redraw the app does on
        // a rotation is triggered. That runs the marker, threshold and
        // rotor-mark paths over real sample data.
        const {state} = await import('/ui/app.mjs');
        const span = state.window.logEndUs - state.window.logStartUs;
        const at = fraction => state.window.logStartUs + span * fraction;
        state.window = Object.assign({}, state.window, {
          basis: fw.FlightWindowBasis.DETECTED,
          startUs: at(0.25), endUs: at(0.8), durationUs: span * 0.55,
          takeoff: {timeUs: at(0.25), sampleIndex: 0,
            signal: 'collective-above-ground-with-rotor-at-speed',
            basis: fw.FlightWindowBasis.DETECTED, detail: {}},
          landing: {timeUs: at(0.8), sampleIndex: 1,
            signal: 'collective-returned-to-ground-and-stayed',
            basis: fw.FlightWindowBasis.DETECTED, detail: {}},
          thresholds: {medianHeadspeed: 2049, flightSpeedRpm: 1844, groundCollective: -74,
            groundSpread: 33, groundSpreadWasFloored: false, liftLevel: 25,
            settleLevel: -41},
          marks: {rotorSpinUs: at(0.05), rotorAtSpeedUs: at(0.18),
            rotorSpinIndex: 1, rotorAtSpeedIndex: 2},
          corroboration: {airborneEvent: {state: 'latched', timeUs: at(0.55),
            transitions: 1}, airborneEventAgreementUs: span * 0.01}
        });
        state.windowTrace = null;
        let threw = null;
        try {
          window.dispatchEvent(new Event('resize'));
        } catch (error) {
          threw = String(error && error.stack);
        }
        await new Promise(resolve => setTimeout(resolve, 120));

        // The takeoff marker is a green triangle in the top rows of the strip,
        // the landing marker an amber one, the firmware flag a violet ring.
        // None of the three is drawn anywhere else on this canvas.
        const strip = document.getElementById('window-plot');
        const top = strip.getContext('2d').getImageData(0, 0, strip.width, 10).data;
        let green = 0;
        let amber = 0;
        let violet = 0;
        for (let i = 0; i < top.length; i += 4) {
          const r = top[i];
          const g = top[i + 1];
          const b = top[i + 2];
          if (top[i + 3] < 32) continue;
          if (g > 120 && g > r + 40 && g > b + 40) green += 1;
          if (r > 150 && g > 100 && g < r && b < 80) amber += 1;
          if (b > 180 && r > 120 && r < b - 40 && g < 150 && g < r) violet += 1;
        }

        return JSON.stringify({
          unexplained, rendered, agreeing, latchedNoGap, threw, green, amber, violet,
          bases: Object.values(fw.FlightWindowBasis).length
        });
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    assert.equal(windowCopy.exceptionDetails, undefined,
      `the window copy probe threw: ${JSON.stringify(windowCopy.exceptionDetails)}`);

    const copy = JSON.parse(windowCopy.result.value);
    assert.ok(copy.bases >= 10,
      `the flight-window module declares ${copy.bases} bases; the sweep below is meant to ` +
      'cover all of them');
    assert.deepEqual(copy.unexplained, [],
      'these window bases reach the pilot as a raw code rather than a sentence, and every ' +
      'one of them is exactly what he sees when detection could not find his flight: ' +
      JSON.stringify(copy.unexplained));
    assert.match(copy.agreeing, /airborne flag went up 1\.3 s after/,
      `the firmware's own airborne flag must be shown beside our marker, with the gap; ` +
      `got "${copy.agreeing}"`);
    assert.match(copy.agreeing, /not used to place the marker/,
      'and it must say plainly that it was not used to place it — it is corroboration, ' +
      'and a reader who thinks it IS the marker cannot judge a disagreement');
    assert.match(copy.latchedNoGap, /airborne flag/,
      'a latched flag with no detected liftoff to compare against must still be mentioned');

    assert.equal(copy.threw, null,
      `drawing a DETECTED window threw: ${copy.threw}. That branch is the one every real ` +
      'flight takes, and no fixture in this repository reaches it');
    assert.ok(copy.green > 8,
      `the detected takeoff must be marked on the strip; found ${copy.green} green pixels ` +
      'in its top rows');
    assert.ok(copy.amber > 8,
      `the detected landing must be marked on the strip; found ${copy.amber} amber pixels`);
    assert.ok(copy.violet > 4,
      `the firmware's airborne flag must be marked too; found ${copy.violet} violet pixels`);

    // 12. THE RENDERER, against faults the engine can actually name.
    //
    // No default fixture is an owner-supplied flight that earns a gain change;
    // generated fixtures are intentionally blocked or isolate one defect. That
    // means the adjustment path — the whole point of the reversal — is never
    // exercised merely by opening one. So the same closed-form fixtures
    // test/recommendations.test.mjs injects faults with are built HERE, run
    // through the REAL engine, and rendered by the SHIPPED renderer.
    //
    // Then the invariant that matters is swept over thousands of findings:
    // a direction word appears if and only if the engine said `adjustment` and
    // gave one, and it is the engine's word.
    const renderer = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        const app = await import('/ui/app.mjs');
        const engine = await import('/src/analysis/recommendations.mjs');
        const flat = value => String(value).replace(/\\s+/g, ' ').trim();

        // ---- a flight written as a named physical response ----------------
        // Identical in form to buildStopFlight in test/recommendations.test.mjs:
        // a fixture is specified by a damping ratio, a frequency and how much
        // rate was left in the commanded direction — never by the quantities the
        // engine measures.
        const AXIS_INDEX = {roll: 0, pitch: 1, yaw: 2};
        function rng(seed) {
          let value = seed >>> 0;
          return () => {
            value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
            return value / 4294967296;
          };
        }
        function buildStopFlight(options) {
          const axis = options.axis || 'yaw';
          const amplitudeDps = 200;
          const stopCount = 4;
          const holdS = 1.6, rampS = 0.1, releaseS = 0.02, gapS = 2.6, sampleHz = 1000;
          const residualDps = options.residualDps;
          const residualTauS = options.residualTauS === undefined ? 0.05 : options.residualTauS;
          const ringAmplitudeDps = options.ringAmplitudeDps;
          const zeta = options.zeta;
          const frequencyHz = options.frequencyHz;
          const trackingOffsetDps = options.trackingOffsetDps;
          const plateauRippleDps = options.plateauRippleDps;
          const plateauRippleHz = options.plateauRippleHz === undefined
            ? 18 : options.plateauRippleHz;
          const noiseDps = 0.5;
          const index = AXIS_INDEX[axis];
          const random = rng(options.seed === undefined ? 4242 : options.seed);
          const dt = 1 / sampleHz;
          const period = rampS + holdS + releaseS + gapS;
          const samples = Math.round((period * stopCount + 1.5) / dt);
          const w = 2 * Math.PI * frequencyHz;
          const records = [];

          for (let step = 0; step < samples; step += 1) {
            const t = step * dt;
            const which = Math.floor(t / period);
            const local = t - which * period;
            const sign = which % 2 === 0 ? 1 : -1;
            const active = which < stopCount;
            let command = 0;
            let rate = 0;
            if (active && local < rampS) {
              command = sign * amplitudeDps * (local / rampS);
              rate = command - sign * trackingOffsetDps * (local / rampS);
            } else if (active && local < rampS + holdS) {
              command = sign * amplitudeDps;
              rate = command - sign * trackingOffsetDps
                + plateauRippleDps * Math.sin(2 * Math.PI * plateauRippleHz * t);
            } else if (active && local < rampS + holdS + releaseS) {
              const through = (local - rampS - holdS) / releaseS;
              command = sign * amplitudeDps * (1 - through);
              rate = command - sign * trackingOffsetDps * (1 - through);
            } else if (active) {
              const since = local - rampS - holdS - releaseS;
              rate = sign * (
                residualDps * Math.exp(-since / residualTauS)
                + ringAmplitudeDps * Math.exp(-zeta * w * since) * Math.sin(w * since));
            }
            const noise = (random() - 0.5) * 2 * noiseDps;
            const setpoint = [0, 0, 0];
            const gyro = [0, 0, 0];
            const raw = [0, 0, 0];
            setpoint[index] = command;
            gyro[index] = rate + noise;
            for (let other = 0; other < 3; other += 1) {
              raw[other] = gyro[other] + (random() - 0.5) * 2 * noiseDps;
            }
            records.push({
              timeUs: Math.round(t * 1e6),
              setpoint, gyro, raw, terms: [0, 0, 0],
              headspeed: 1800 + (random() - 0.5) * 8,
              collective: 0,
              vbat: 24
            });
          }
          return records;
        }

        function cleanAirframe(overrides) {
          return Object.assign({
            status: 'clear', reasonCodes: [],
            tuningEvidenceGate: {status: 'permitted', reasonCodes: []},
            harmonicCorrelation: {state: 'evaluated'},
            rpmEvidence: {headspeed: {relativeSpread: 0.03, state: 'trustworthy'}},
            attentionThreshold: {bandRmsDps: 8,
              basis: 'experimental-synthetic-calibration'},
            range: {startTimeUs: 0, endTimeUs: 10000000000},
            analyzedBandHz: [5, 450],
            axes: ['roll', 'pitch', 'yaw'].map(axis => ({
              axis, source: 'gyroRAW', available: true,
              medianNoisePsdDps2PerHz: 0.0002, broadbandRmsDps: 1.2, peaks: []
            }))
          }, overrides || {});
        }

        function recommend(records, axis, mechanical) {
          return engine.buildRecommendations({
            records,
            mechanical: mechanical || cleanAirframe(),
            axes: {[axis]: Object.assign({}, engine.analyseAxisEvidence(records, axis),
              {records})},
            axisSummaries: {[axis]: {gyroHighFrequencyRmsDps: 0.5}}
          });
        }

        const FAULTS = {
          tooMuchD: {residualDps: 2, zeta: 0.002, frequencyHz: 26, ringAmplitudeDps: 14,
            trackingOffsetDps: 1.5, plateauRippleDps: 0.3},
          tooLittleP: {residualDps: 75, residualTauS: 0.14, zeta: 0.85, frequencyHz: 7,
            ringAmplitudeDps: 3, trackingOffsetDps: 24, plateauRippleDps: 0.5},
          underdamped: {residualDps: 2, zeta: 0.28, frequencyHz: 5,
            ringAmplitudeDps: -48, trackingOffsetDps: 1.5, plateauRippleDps: 0.3}
        };

        // A SHAKING airframe carrying the very same too-much-D flight. The
        // gain finding is suppressed — mechanical outranks gains — and what
        // was seen has to be said out loud rather than vanishing, or the pilot
        // is left believing the app looked at his stops and found nothing.
        const SHAKING = {
          status: 'attention', reasonCodes: ['PERSISTENT_NARROWBAND_ENERGY'],
          tuningEvidenceGate: {status: 'blocked',
            reasonCodes: ['PERSISTENT_NARROWBAND_ENERGY']}
        };

        const box = document.getElementById('recommend');
        const cases = {};
        const withMechanical = {blockedAirframe: cleanAirframe(SHAKING)};
        const plans = Object.assign({blockedAirframe: FAULTS.tooMuchD}, FAULTS);
        for (const name of Object.keys(plans)) {
          const result = recommend(
            buildStopFlight(Object.assign({axis: 'yaw'}, plans[name])), 'yaw',
            withMechanical[name]);
          box.innerHTML = app.recommendationsHtml(result, {});
          const text = flat(box.textContent);
          const changeBoxes = [...box.querySelectorAll('.finding .change')];
          const adjustments = result.findings.filter(
            finding => finding.kind === 'adjustment' && finding.direction);
          cases[name] = {
            ids: result.findings.map(finding => finding.id),
            adjustments: adjustments.map(finding => ({
              id: finding.id, adjust: finding.adjust, direction: finding.direction})),
            changeText: changeBoxes.map(node => flat(node.textContent)),
            strayDirections: changeBoxes.filter(node =>
              !node.closest('.finding').classList.contains('kind-adjustment')).length,
            candidates: result.findings.reduce(
              (total, finding) => total + finding.candidates.length, 0),
            candidatesOnScreen: result.findings.every(finding =>
              finding.candidates.every(candidate => text.indexOf(flat(candidate)) !== -1)),
            saysUnseparated: text.indexOf('The evidence does not separate these') !== -1,
            withheld: result.withheld.map(entry => entry.sentence),
            withheldDetails: result.withheld.map(entry => ({
              findingId: entry.findingId ?? null,
              reason: entry.reason ?? null,
              gateStatus: entry.gateStatus ?? {}
            })),
            withheldOnScreen: result.withheld.every(
              entry => text.indexOf(flat(entry.sentence)) !== -1),
            saysSeenAndWithheld:
              text.indexOf('Seen, and deliberately not turned into advice') !== -1,
            // Not a keyword sweep over the whole card: 'tracking error' is a
            // measurement label and would match one. What must not happen is
            // the card being DRAWN as a failure — an error style, a failure
            // kind, or a headline sentence that opens by apologising.
            errorStyled: box.querySelectorAll('.error').length,
            unseparatedKinds: result.findings
              .filter(finding => finding.candidates.length > 0)
              .map(finding => {
                const at = result.findings.indexOf(finding);
                const card = box.querySelectorAll('.finding')[at];
                return card ? card.className : 'MISSING';
              }),
            unseparatedPlain: result.findings
              .filter(finding => finding.candidates.length > 0)
              .map(finding => {
                const at = result.findings.indexOf(finding);
                const card = box.querySelectorAll('.finding')[at];
                const plain = card ? card.querySelector('.plain') : null;
                return plain ? flat(plain.textContent) : 'MISSING';
              }),
            overflowX: document.documentElement.scrollWidth
              - document.documentElement.clientWidth
          };
        }

        // Confidence has to be visible, and visibly different. Four renders of
        // one finding that differ only in their confidence must produce four
        // different cards, or the word is decorative.
        const confidenceRenders = ['high', 'medium', 'low', 'none'].map(level => {
          box.innerHTML = app.findingHtml({
            id: 'D_TOO_HIGH', rung: 'gain-D', rungOrder: 5, axis: 'yaw',
            kind: 'adjustment', adjust: 'yaw D', direction: 'decrease',
            confidence: level, headline: 'Lower yaw D.', reasoning: 'because',
            basis: [], confirm: 'fly it', candidates: [], codes: [],
            actNow: false, sequence: 0
          });
          return flat(box.textContent);
        });

        // ---- the invariant, swept -----------------------------------------
        // findingHtml is pure, so this can go wide: 6000 findings across every
        // kind, every direction, every combination of the optional fields, and
        // hostile text in each of them.
        const random = rng(20260812);
        const KINDS = ['blocker', 'adjustment', 'observation', 'next-flight'];
        const DIRECTIONS = ['increase', 'decrease', null];
        const HOSTILE = '<img src=x onerror=window.__pwn2=1>';
        let injectedNodes = 0;
        let wrongDirectionWord = 0;
        let directionWithoutAdjustment = 0;
        let missingDirection = 0;
        let missingAdjust = 0;
        let firstFailure = null;
        for (let trial = 0; trial < 6000; trial += 1) {
          const kind = KINDS[Math.floor(random() * KINDS.length)];
          const direction = DIRECTIONS[Math.floor(random() * DIRECTIONS.length)];
          const axis = ['roll', 'pitch', 'yaw'][Math.floor(random() * 3)];
          const term = ['P', 'I', 'D'][Math.floor(random() * 3)];
          const adjust = random() < 0.75 ? axis + ' ' + term : 'linkage or servo';
          const finding = {
            id: random() < 0.5 ? 'D_TOO_HIGH' : 'AN_ID_THE_VIEWER_HAS_NEVER_SEEN',
            rung: ['airframe', 'gain-P', 'gain-D', 'gain-I', 'evidence'][
              Math.floor(random() * 5)],
            rungOrder: 1, axis, kind,
            adjust: kind === 'adjustment' || kind === 'blocker' ? adjust : null,
            // Deliberately allowed to be non-null on kinds that may not carry
            // one, because that is the mistake being guarded against.
            direction,
            confidence: ['high', 'medium', 'low', 'none'][Math.floor(random() * 4)],
            headline: 'headline ' + HOSTILE,
            reasoning: 'reasoning ' + HOSTILE,
            basis: [{label: 'label ' + HOSTILE, value: random() < 0.2 ? null : 1.25,
              unit: 'deg/s', source: 'source ' + HOSTILE}],
            confirm: random() < 0.8 ? 'confirm ' + HOSTILE : null,
            candidates: random() < 0.4 ? ['candidate ' + HOSTILE, 'another'] : [],
            codes: ['A_CODE'], actNow: random() < 0.2, sequence: trial
          };

          box.innerHTML = app.findingHtml(finding);
          // Counted here rather than at the end: an onerror handler fires a
          // tick later and the next iteration has already replaced the node, so
          // a sweep that only looked afterwards would pass against a renderer
          // that interpolates a log's own text straight into innerHTML.
          injectedNodes += box.querySelectorAll('img, script, iframe').length;
          const change = box.querySelector('.change');
          const shouldShow = kind === 'adjustment' && direction !== null;

          if (shouldShow) {
            if (!change) {
              missingDirection += 1;
              if (!firstFailure) firstFailure = {why: 'no direction drawn', kind, direction};
              continue;
            }
            const shown = flat(change.textContent);
            const wanted = direction === 'increase' ? 'Increase' : 'Lower';
            const other = direction === 'increase' ? 'Lower' : 'Increase';
            if (shown.indexOf(wanted) === -1 || shown.indexOf(other) !== -1) {
              wrongDirectionWord += 1;
              if (!firstFailure) firstFailure = {why: 'wrong word', direction, shown};
            }
            if (shown.indexOf(adjust) === -1) {
              missingAdjust += 1;
              if (!firstFailure) firstFailure = {why: 'adjust missing', adjust, shown};
            }
          } else if (change) {
            directionWithoutAdjustment += 1;
            if (!firstFailure) {
              firstFailure = {why: 'direction on a non-adjustment', kind, direction};
            }
          }
        }

        box.innerHTML = '';
        return JSON.stringify({
          cases,
          confidenceRenders,
          distinctConfidenceRenders: new Set(confidenceRenders).size,
          wrongDirectionWord, directionWithoutAdjustment, missingDirection, missingAdjust,
          firstFailure,
          pwned: window.__pwn2 === 1,
          injected: injectedNodes
        });
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    assert.equal(renderer.exceptionDetails, undefined,
      `the recommendation renderer threw: ${JSON.stringify(renderer.exceptionDetails)}`);

    const drawn = JSON.parse(renderer.result.value);

    // An injected fault the engine CAN name: the shipped renderer must put the
    // direction on screen.
    const tooMuchD = drawn.cases.tooMuchD;
    assert.ok(tooMuchD.ids.includes('D_TOO_HIGH'),
      `the too-much-D fixture no longer produces D_TOO_HIGH; got ${tooMuchD.ids}`);
    assert.deepEqual(tooMuchD.adjustments,
      [{id: 'D_TOO_HIGH', adjust: 'yaw D', direction: 'decrease'}],
      'the engine must earn exactly one adjustment here');
    assert.equal(tooMuchD.changeText.length, 1, 'and the renderer must draw exactly one');
    assert.match(tooMuchD.changeText[0], /Lower/,
      `a 'decrease' must reach the pilot as a word he can act on; got ` +
      `"${tooMuchD.changeText[0]}"`);
    assert.match(tooMuchD.changeText[0], /yaw D/, 'and must name what to move');
    assert.match(tooMuchD.changeText[0], /One step/,
      'one change at a time is the rule, and it belongs beside the change');

    const tooLittleP = drawn.cases.tooLittleP;
    assert.deepEqual(tooLittleP.adjustments, [],
      'too-little P is diagnosed, but mandatory stability must withhold a gain change');
    assert.deepEqual(tooLittleP.changeText, [],
      'the renderer must not draw a direction for advice the stability gate withheld');
    const withheldP = tooLittleP.withheldDetails.find(entry => entry.findingId === 'P_TOO_LOW');
    assert.ok(withheldP,
      `the P_TOO_LOW diagnosis must remain visible in withheld; got `
      + JSON.stringify(tooLittleP.withheldDetails));
    assert.equal(withheldP.reason, 'GATES_NOT_PASSED');
    assert.notEqual(withheldP.gateStatus.stability, 'passed',
      'stability must be the gate preventing the P increase');
    assert.equal(tooLittleP.withheldOnScreen, true,
      'the withheld P diagnosis and reason must be shown to the pilot');

    // MECHANICAL FAULTS OUTRANK GAINS: the same flight, on a shaking airframe,
    // must not produce the gain change — and what was seen must still be said.
    const blocked = drawn.cases.blockedAirframe;
    assert.deepEqual(blocked.adjustments, [],
      'a gain change was recommended for a helicopter that is shaking. A machine with a ' +
      'vibration problem cannot be tuned, and advising a gain change on one makes it worse');
    assert.equal(blocked.changeText.length, 0,
      'and no direction may be drawn for it either');
    assert.ok(blocked.ids.includes('AIRFRAME_VIBRATION_PRESENT'),
      `the airframe must be what the pilot is told about instead; got ${blocked.ids}`);
    assert.ok(blocked.withheld.length > 0,
      'the engine saw a ringing signature in both directions and withheld it; that is the ' +
      'case `withheld` exists for and the fixture must reach it');
    assert.equal(blocked.saysSeenAndWithheld, true,
      'what was seen and deliberately not turned into advice must have its own heading — ' +
      'a finding that simply vanishes tells a pilot his stops were looked at and were fine');
    assert.equal(blocked.withheldOnScreen, true,
      `every withheld sentence must be on screen; got ${JSON.stringify(blocked.withheld)}`);

    // ...and one it CANNOT. This is the common case and it must read as an
    // answer, not as a failure.
    const underdamped = drawn.cases.underdamped;
    assert.equal(underdamped.adjustments.length, 0,
      'an unseparated overshoot must not produce a gain change');
    assert.equal(underdamped.changeText.length, 0,
      'and the renderer must not invent a direction where the engine gave none');
    assert.ok(underdamped.candidates >= 3,
      `the engine must name the candidates it cannot separate; got ` +
      underdamped.candidates);
    assert.equal(underdamped.candidatesOnScreen, true,
      'every candidate the engine named must be on screen');
    assert.equal(underdamped.saysUnseparated, true,
      'the panel must say plainly that the evidence does not separate them');
    assert.equal(underdamped.errorStyled, 0,
      '"I can see it and I cannot name it" is the common case and must not be drawn in ' +
      'the error style this app uses for a broken screen');
    assert.ok(underdamped.unseparatedKinds.every(name => /kind-next-flight/.test(name)),
      `the unseparated finding must be drawn as a next-flight card, not a fault; got ` +
      JSON.stringify(underdamped.unseparatedKinds));
    assert.ok(underdamped.unseparatedPlain.every(
      sentence => !/^(could not|unable|failed|no result|sorry)/i.test(sentence)),
      `an unseparated finding must lead with what WAS seen, not with an apology; got ` +
      JSON.stringify(underdamped.unseparatedPlain));

    for (const name of Object.keys(drawn.cases)) {
      assert.equal(drawn.cases[name].strayDirections, 0,
        `${name} drew a direction outside an adjustment card`);
      assert.equal(drawn.cases[name].overflowX, 0,
        `${name} scrolled the page sideways at 384px`);
    }

    assert.equal(drawn.distinctConfidenceRenders, 4,
      'four findings differing only in confidence rendered ' +
      `${drawn.distinctConfidenceRenders} distinct cards. "How confident" is half of what ` +
      'the owner asked for, and a word that does not change with the value is decoration: ' +
      JSON.stringify(drawn.confidenceRenders.map(text => text.slice(0, 60))));

    // The invariant, over 6000 randomised findings.
    assert.equal(drawn.directionWithoutAdjustment, 0,
      `${drawn.directionWithoutAdjustment} findings that are not adjustments were drawn ` +
      `with a direction. First: ${JSON.stringify(drawn.firstFailure)}`);
    assert.equal(drawn.missingDirection, 0,
      `${drawn.missingDirection} adjustments were drawn with no direction at all. ` +
      `First: ${JSON.stringify(drawn.firstFailure)}`);
    assert.equal(drawn.wrongDirectionWord, 0,
      `${drawn.wrongDirectionWord} adjustments were drawn with the WRONG direction word — ` +
      `a pilot moving a gain the wrong way on this app's say-so. First: ` +
      JSON.stringify(drawn.firstFailure));
    assert.equal(drawn.missingAdjust, 0,
      `${drawn.missingAdjust} adjustments did not name what to move`);

    // A finding is data, and every string in it can come from a log.
    assert.equal(drawn.pwned, false, 'a finding\'s text must never execute');
    assert.equal(drawn.injected, 0, 'a finding\'s text must not create elements');

    // 13. IMPORT PROGRESS, on the events MainActivity actually sends.
    //
    // Reading a full dataflash over USB takes over two minutes, and the app used
    // to show nothing at all for the whole of it — the owner read that blank
    // screen as "it's broken", twice. The shell has emitted these events all
    // along and nothing listened, so this is the only thing that can prove the
    // page now does. The events are dispatched exactly as
    // MainActivity.notifyImportStarted and notifyImportProgress build them.
    const copying = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        const panel = () => document.getElementById('import-progress');
        const label = () => document.getElementById('import-progress-label').textContent;
        const bar = () => document.getElementById('import-bar');
        const started = (name, total) => window.dispatchEvent(
          new CustomEvent('rotorlens-import-started', {detail: {name, total}}));
        const advanced = (copied, total) => window.dispatchEvent(
          new CustomEvent('rotorlens-import-progress', {detail: {copied, total}}));

        // 128 MiB, the size of the dump that started this.
        started('DATAFLASH.BBL', 134217728);
        advanced(4194304, 134217728);
        // Still inside the settle delay: a local file lands faster than this and
        // must not flash a bar.
        await new Promise(resolve => setTimeout(resolve, 120));
        const early = {hidden: panel().classList.contains('hidden'), label: label()};

        await new Promise(resolve => setTimeout(resolve, 400));
        const shown = {
          hidden: panel().classList.contains('hidden'),
          label: label(),
          width: bar().style.width,
          sweeping: bar().classList.contains('sweeping')
        };

        advanced(67108864, 134217728);
        const half = {label: label(), width: bar().style.width};

        // A provider that will not say how big the file is. MainActivity sends
        // -1 for it, which is documented as ordinary rather than exceptional.
        started('UNKNOWN.BBL', -1);
        await new Promise(resolve => setTimeout(resolve, 400));
        advanced(3145728, -1);
        const unknown = {
          hidden: panel().classList.contains('hidden'),
          label: label(),
          sweeping: bar().classList.contains('sweeping')
        };

        // And the copy ending: the log itself arrives, and the bar goes away.
        window.dispatchEvent(new CustomEvent('rotorlens-file', {detail: {
          name: 'COPIED.BBL', url: '/fixtures/synthetic/rf46-two-sessions.TXT'
        }}));
        for (let attempt = 0; attempt < 60; attempt += 1) {
          if (document.getElementById('status').textContent.includes('COPIED.BBL —')) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const finished = {hidden: panel().classList.contains('hidden')};

        return JSON.stringify({early, shown, half, unknown, finished});
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    assert.equal(copying.exceptionDetails, undefined,
      `import progress threw: ${JSON.stringify(copying.exceptionDetails)}`);

    const bar = JSON.parse(copying.result.value);
    assert.equal(bar.early.hidden, true,
      'a copy that has run for 120 ms must show nothing; a bar that appears and vanishes ' +
      'inside one blink reads as a rendering fault, not as progress');
    assert.equal(bar.early.label, '', 'nothing at all may be written before the delay elapses');

    assert.equal(bar.shown.hidden, false, 'a copy still running after 300 ms must be visible');
    assert.match(bar.shown.label, /DATAFLASH\.BBL/, 'the file being copied must be named');
    assert.match(bar.shown.label, /3% of 128\.0 MiB/,
      `4 MiB of 128 MiB is 3%: ${bar.shown.label}`);
    assert.equal(bar.shown.sweeping, false, 'a known total must draw a real fraction');
    // Compared as numbers: the browser normalises "50.0%" to "50%" when it
    // parses the declaration back out.
    assert.equal(Math.round(parseFloat(bar.shown.width) * 10) / 10, 3.1,
      `the bar must follow the bytes: ${bar.shown.width}`);
    assert.equal(parseFloat(bar.half.width), 50, 'the bar must move as bytes land');
    assert.match(bar.half.label, /50%/, bar.half.label);

    assert.equal(bar.unknown.hidden, false, 'an unknown size must still show something');
    assert.match(bar.unknown.label, /3\.0 MiB so far/,
      `an unknown total must count bytes: ${bar.unknown.label}`);
    // THE assertion of this section. `total` is -1 whenever the provider will
    // not say, and a percentage computed from that is a bar that fills while the
    // copy carries on — a lie told to somebody already waiting two minutes.
    assert.doesNotMatch(bar.unknown.label, /%/,
      `an unknown total must never be rendered as a percentage: ${bar.unknown.label}`);
    assert.equal(bar.unknown.sweeping, true,
      'an unknown total must draw an indeterminate bar rather than a fraction');

    assert.equal(bar.finished.hidden, true,
      'the bar must go away when the log arrives, not sit at 100% under the decoded log');

    // 14. "Decoding NAME…" has to REACH THE SCREEN before the decoder runs.
    //
    // decodeLog is synchronous and holds the thread for 8.1 s on a 128 MB log, so
    // nothing can be dispatched from inside it: the only chance to paint a name
    // is before the call. And an assignment is not a paint — resuming from await
    // is a microtask, and microtasks run before the frame is presented, so a
    // decode started from one blocks the very paint it was waiting for.
    //
    // So this samples #status from inside requestAnimationFrame callbacks, which
    // only run between tasks. If the message is written and the decoder runs in
    // the same task, no frame callback can ever observe it — which is exactly
    // what happens without the yield in openFile.
    const painted = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        const bytes = await (await fetch(
          '/fixtures/synthetic/rf46-two-sessions.TXT'
        )).arrayBuffer();
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], 'PAINTED.BBL'));

        const frames = [];
        let sampling = true;
        const sample = () => {
          if (!sampling) return;
          frames.push(document.getElementById('status').textContent);
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);

        const input = document.getElementById('file');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change'));

        let settledAfter = -1;
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (document.getElementById('status').textContent.includes('PAINTED.BBL —')) {
            settledAfter = frames.length;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }

        // Keep sampling past the finish line. The guard below wants to know
        // whether this browser services frames AT ALL — without that, "the
        // message was never on screen" and "nothing was ever looked at" are the
        // same reading. Counting only the frames the open itself spanned made a
        // FAST open indistinguishable from a dead one: a 14 KiB log settles
        // inside two or three frames, so the guard rejected the run about half
        // the time on an idle machine and the whole suite was non-deterministic
        // for that reason alone. What the message was doing while the open ran
        // is already captured in \`frames\`; these extra samples only establish
        // that the sampler works.
        for (let attempt = 0; attempt < 120 && frames.length < 12; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 16));
        }
        sampling = false;

        return JSON.stringify({
          frames: frames.length,
          // Frames serviced while the open was actually running. Reported so a
          // regression that made the open span NO frames at all is still
          // visible rather than being hidden by the padding above.
          framesDuringOpen: settledAfter,
          onScreen: frames.some(text => text.includes('Decoding PAINTED.BBL')),
          settled: document.getElementById('status').textContent.includes('PAINTED.BBL —')
        });
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    assert.equal(painted.exceptionDetails, undefined,
      `the decode message check threw: ${JSON.stringify(painted.exceptionDetails)}`);

    const decoding = JSON.parse(painted.result.value);
    assert.equal(decoding.settled, true, 'the log must finish opening for this to mean anything');
    // Separates "the message never painted" from "this browser services no
    // frames at all", which would make the assertion below meaningless.
    assert.ok(decoding.frames > 3,
      `only ${decoding.frames} frames were serviced, so this check proves nothing`);
    // And the open itself has to have spanned at least one frame boundary, or
    // the message below had no opportunity to be seen and the padded sample
    // count above would be covering for it.
    assert.ok(decoding.framesDuringOpen >= 1,
      `the open spanned ${decoding.framesDuringOpen} frames, so the decoder ran in one `
      + 'unbroken task and "Decoding NAME…" could not have been observed by anything');
    assert.equal(decoding.onScreen, true,
      'the decoder ran in the same task as the message announcing it, so "Decoding NAME…" ' +
      'was never on screen. On a 128 MB log that is 8 seconds of a page that looks frozen');

    // 9. The legal screen renders what the app actually ships.
    //
    // The provenance tests prove ui/legal-data.mjs matches the resolved
    // classpath. They cannot prove a user can reach it: a throw in legal.mjs, a
    // button wired to nothing, or a panel that never unhides all leave the
    // attribution obligation unmet while every data assertion stays green.
    // At a desktop width every Maven coordinate fits and this step proves
    // nothing about a phone. The app's only shipping target is a phone, and the
    // longest coordinate here is wider than one, so measure at that width.
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 384, height: 800, deviceScaleFactor: 0, mobile: true
    }, sessionId);

    const legal = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        // Exercise the same synchronous fallback the Android Java bridge uses.
        // iOS supplies the explicit pre-document RotorLensPlatform marker, while
        // a normal browser supplies neither and defaults to web.
        window.RotorLensNative = Object.assign(window.RotorLensNative || {}, {
          platform() { return 'android'; }
        });
        const button = document.getElementById('legal-toggle');
        button.click();

        // Wait for the CONTENT, not for the panel. The panel unhides on the tap
        // itself, but ui/legal-data.mjs is fetched with import() and the notices
        // are drawn when it lands — so a loop that stops at "visible" reads an
        // empty container and every assertion below it becomes a coin toss.
        // #legal-apache exists only once the notices have been drawn.
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (document.getElementById('legal-apache')) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }

        // The panel scrolls itself into view smoothly. Measuring before that
        // settles reads a position the user never sees — and one of the
        // assertions below passed against a real layout bug because of it.
        let previous = -1;
        for (let attempt = 0; attempt < 60; attempt += 1) {
          if (window.scrollY === previous) break;
          previous = window.scrollY;
          await new Promise(resolve => setTimeout(resolve, 50));
        }

        const panel = document.getElementById('legal-panel');
        const shown = document.getElementById('legal').textContent;
        const {LEGAL} = await import('/ui/legal-data.mjs');

        return JSON.stringify({
          visible: !panel.classList.contains('hidden'),
          expanded: button.getAttribute('aria-expanded'),
          // Every shipped artifact must be on screen, not merely in the data.
          missing: LEGAL.componentsByPlatform.android
            .flatMap(component => component.artifacts)
            .filter(artifact => !shown.includes(artifact)),
          holders: LEGAL.componentsByPlatform.android.filter(
            component => !shown.includes(component.copyright)
          ).length,
          foreignPlatformArtifact: [
            ...LEGAL.componentsByPlatform.ios,
            ...LEGAL.componentsByPlatform.web
          ].some(component => component.artifacts.some(artifact => shown.includes(artifact))),
          creator: shown.includes(LEGAL.project.attribution),
          sourceHref: document.getElementById('legal-source')?.href ?? null,
          sourceText: document.getElementById('legal-source')?.textContent ?? null,
          sourceStatus: document.getElementById('legal-source-status')?.textContent ?? null,
          expectedSourceHref: LEGAL.project.sourceUrl,
          expectedSourceLabel: LEGAL.project.sourceLabel,
          expectedSourceStatus: LEGAL.project.sourceStatus,
          repositoryHref: document.getElementById('legal-repository')?.href ?? null,
          expectedRepositoryHref: LEGAL.project.repository,
          nonAffiliation: shown.includes('not affiliated with'),
          mplChars: document.getElementById('legal-mpl').textContent.length,
          mplExhibit: document.getElementById('legal-mpl')
            .textContent.includes('Exhibit A - Source Code Form License Notice'),
          licenseChars: document.getElementById('legal-apache').textContent.length,
          licenseSection4: document.getElementById('legal-apache')
            .textContent.includes('4. Redistribution'),
          // The licence must scroll inside its own box, not stretch the page.
          licenceScrollsInPlace: (() => {
            const pre = document.getElementById('legal-apache');
            return pre.scrollHeight > pre.clientHeight;
          })(),
          overflowX: document.documentElement.scrollWidth
            - document.documentElement.clientWidth,
          // Caught on a real handset and invisible to every measurement above: the
          // panel scrolls itself into view, the header is sticky, and the first
          // line landed underneath it. Creator attribution is now the first
          // paragraph and must not be hidden there.
          firstLineClearsHeader: (() => {
            const header = document.querySelector('header').getBoundingClientRect();
            const first = document.querySelector('#legal p').getBoundingClientRect();
            return first.top >= header.bottom;
          })(),
          // Name what overflowed. A bare pixel count sends the reader looking in
          // the wrong panel — it did exactly that once already.
          widest: [...document.querySelectorAll('body *')]
            .filter(el => el.getBoundingClientRect().right
              > document.documentElement.clientWidth + 1)
            .slice(0, 5)
            .map(el => el.tagName.toLowerCase()
              + (el.id ? '#' + el.id : '')
              + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : '')
              + ' → ' + Math.round(el.getBoundingClientRect().right))
        });
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    assert.equal(legal.exceptionDetails, undefined,
      `opening the legal screen threw: ${JSON.stringify(legal.exceptionDetails)}`);

    const notices = JSON.parse(legal.result.value);
    assert.equal(notices.visible, true, 'the About & Legal button must open the panel');
    assert.equal(notices.expanded, 'true', 'the toggle must report its state to a screen reader');
    assert.deepEqual(notices.missing, [],
      'every artifact in the APK must appear on the legal screen the user can read');
    assert.equal(notices.holders, 0, 'every copyright line must be displayed');
    assert.equal(notices.foreignPlatformArtifact, false,
      'Android About & Legal must not render another platform\'s components');
    assert.equal(notices.creator, true, 'the original creator attribution must be displayed');
    assert.equal(notices.sourceHref, notices.expectedSourceHref,
      'the development build must link the official source repository');
    assert.equal(notices.sourceText, notices.expectedSourceLabel);
    assert.equal(notices.sourceStatus.trim(), notices.expectedSourceStatus,
      'the unreleased build must not imply an exact source tag already exists');
    assert.equal(notices.repositoryHref, notices.expectedRepositoryHref,
      'the official repository link must be displayed');
    assert.equal(notices.nonAffiliation, true, 'the non-affiliation statement must be shown');
    assert.ok(notices.mplChars > 16_000, 'the full MPL-2.0 text must be displayed');
    assert.equal(notices.mplExhibit, true, 'the MPL source-form notice must be complete');
    assert.ok(notices.licenseChars > 10_000, 'the full Apache-2.0 text must be displayed');
    assert.equal(notices.licenseSection4, true,
      'the attribution clause is the one that obliges us to show this at all');
    assert.equal(notices.licenceScrollsInPlace, true,
      'the licence must scroll within its own box rather than stretch the page');
    assert.equal(notices.firstLineClearsHeader, true,
      'the creator attribution must not open underneath the sticky header');
    // Caught on a real handset: a Maven coordinate and a docs URL are unbroken
    // tokens wider than a phone, so the whole page scrolled sideways and every
    // other panel shifted with it.
    assert.equal(notices.overflowX, 0,
      `the page must not scroll horizontally on a phone; overflowing: ${
        notices.widest.join(', ') || 'nothing identified'}`);

    // 15. THE FLIGHT HISTORY: what is kept, what it says, and deleting it.
    //
    // The store is a file the native shell owns — not localStorage, which
    // docs/PRIVACY_POLICY.md promises never to use and
    // test/privacy-claims.test.mjs refuses to let appear in anything that ships.
    // That makes this seam the only place the feature can be tested, and it is
    // tested the way MainActivity really behaves: the bridge is installed BEFORE
    // the document loads, so the page reads its history during start-up rather
    // than being handed one afterwards.
    let seeded = createHistory();
    seeded = addFlightRecord(seeded, flightRecord({
      yawPID: '315,145,29,3,1', errorDps: 3.0, ringingDps: 34.8
    }));
    seeded = addFlightRecord(seeded, flightRecord({
      yawPID: '315,135,29,3,1', errorDps: 1.2, ringingDps: 21.2
    }));
    const seedText = exportHistory(seeded);
    const stored = findRecords(seeded, seeded.records[0].aircraftKey);

    // The engine decides the verdicts; the page only has to render them. Taking
    // them from here rather than asserting them inside the page keeps this a
    // test of the renderer and not a second copy of the comparison.
    const improved = compareFlightRecords(stored[0], stored[1]);
    const unchanged = compareFlightRecords(
      flightRecord({yawPID: '315,145,29,3,1', errorDps: 3.0, ringingDps: 34.8}),
      {
        ...flightRecord({yawPID: '315,135,29,3,1', errorDps: 2.95, ringingDps: 34.1}),
        ordinal: 1
      }
    );
    const refused = compareFlightRecords(
      flightRecord({yawPID: '315,145,29,3,1', errorDps: 3.0, ringingDps: 34.8}),
      {
        ...flightRecord({
          yawPID: '315,135,29,3,1', errorDps: 1.2, ringingDps: 21.2,
          firmware: 'Rotorflight 4.6.1'
        }),
        ordinal: 1
      }
    );

    // These three are the whole point of the section, so they are checked here
    // before anything renders them. A renderer test whose inputs all carry the
    // same verdict would pass whatever the renderer said.
    assert.equal(improved.outcome, 'improved', JSON.stringify(improved));
    assert.equal(improved.changedTerm, 'I');
    assert.equal(unchanged.outcome, 'no-detectable-change');
    assert.equal(refused.outcome, 'not-enough-evidence');
    assert.equal(refused.comparable, false);

    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      // The Android shell, in the smallest form that is still the same contract:
      // one file, read and written as text, deleted outright by forgetHistory.
      source: `(() => {
        let file = ${JSON.stringify(seedText)};
        // A switch the test can throw, because a delete that FAILS is the case
        // the app got wrong: it rendered an empty history unconditionally, so a
        // failed unlink told the pilot their flights were gone while the file
        // still held every one. A stub that can only succeed cannot reach that.
        let forgetWorks = true;
        window.RotorLensNative = {
          pickFile() {},
          readHistory() { return file; },
          writeHistory(text) { file = text; return true; },
          forgetHistory() {
            if (!forgetWorks) { return false; }
            file = '';
            return true;
          }
        };
        window.__shellFile = () => file;
        window.__breakForget = broken => { forgetWorks = !broken; };
      })();`
    }, sessionId);

    await client.send('Page.navigate', {url: `http://127.0.0.1:${port}/`}, sessionId);
    await new Promise(resolve => setTimeout(resolve, 900));
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 384, height: 800, deviceScaleFactor: 2, mobile: true
    }, sessionId);

    const history = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        const app = await import('/ui/app.mjs');

        // A. The history the shell was already holding is on screen, with no
        //    log opened and nothing asked of the page.
        const panel = document.getElementById('history-panel');
        const onStart = {
          visible: !panel.classList.contains('hidden'),
          summary: document.getElementById('history-summary').textContent,
          text: document.getElementById('history').textContent,
          flights: document.querySelectorAll('#history .flight').length,
          forgetButtons: document.querySelectorAll('#history [data-forget-flight]').length,
          aircraftButtons: document.querySelectorAll('#history [data-forget-aircraft]').length
        };

        // B. A real log, through the real file input. This one never left the
        //    ground — every fixture in the repo is a bench run — so the panel
        //    has to say why it is not kept rather than vanish.
        const bytes = await (await fetch(
          '/fixtures/synthetic/rf46-two-sessions.TXT'
        )).arrayBuffer();
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], 'GROUNDRUN.BBL'));
        const input = document.getElementById('file');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change'));

        let settled = false;
        for (let attempt = 0; attempt < 150; attempt += 1) {
          if (!document.getElementById('since-panel').classList.contains('hidden')) {
            settled = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const grounded = {
          settled,
          text: document.getElementById('since').textContent,
          saveOffered: Boolean(document.getElementById('since-save'))
        };

        // C. The renderer, against the engine's own verdicts, in the live panel
        //    at 384 px.
        const verdicts = ${JSON.stringify({
    improved, unchanged, refused,
    before: stored[0], after: stored[1]
  })};
        const shown = {};
        for (const name of ['improved', 'unchanged', 'refused']) {
          document.getElementById('since').innerHTML = app.comparisonHtml(
            verdicts[name], verdicts.before, verdicts.after
          );
          shown[name] = {
            text: document.getElementById('since').textContent,
            overflowX: document.documentElement.scrollWidth
              - document.documentElement.clientWidth,
            injected: document.querySelectorAll('#since img, #since script').length
          };
        }

        // D. Deleting. The buttons are the ones the page rendered, found the way
        //    a finger finds them, and what matters is that the SHELL'S FILE
        //    changes — a panel that empties while the file keeps the flight is
        //    the failure this is here to catch.
        document.getElementById('history-forget-all').scrollIntoView();
        const firstForget = document.querySelector('#history [data-forget-flight]');
        const smallest = [...document.querySelectorAll(
          '#history button, #history-panel .controls button'
        )].map(button => Math.round(button.getBoundingClientRect().height))
          .sort((left, right) => left - right)[0];

        firstForget.click();
        await new Promise(resolve => setTimeout(resolve, 50));
        const afterOne = {
          flights: document.querySelectorAll('#history .flight').length,
          fileRecords: (window.__shellFile().match(/rotorlens-flight-record/g) ?? []).length
        };

        // Forget everything is behind a second tap: window.confirm cannot be
        // used, because this WebView has no WebChromeClient and confirm() would
        // return false without ever showing a dialog.
        const forgetAll = document.getElementById('history-forget-all');
        forgetAll.click();
        const armed = {
          label: forgetAll.textContent,
          flights: document.querySelectorAll('#history .flight').length,
          fileRecords: (window.__shellFile().match(/rotorlens-flight-record/g) ?? []).length
        };

        // The unlink fails. The panel must not claim the flights are gone.
        window.__breakForget(true);
        forgetAll.click();
        await new Promise(resolve => setTimeout(resolve, 50));
        const refusedForget = {
          flights: document.querySelectorAll('#history .flight').length,
          fileRecords: (window.__shellFile().match(/rotorlens-flight-record/g) ?? []).length,
          text: document.getElementById('history').textContent
        };

        window.__breakForget(false);
        forgetAll.click();
        const rearmed = forgetAll.textContent;
        forgetAll.click();
        await new Promise(resolve => setTimeout(resolve, 50));
        const emptied = {
          flights: document.querySelectorAll('#history .flight').length,
          file: window.__shellFile(),
          text: document.getElementById('history').textContent
        };

        return JSON.stringify({
          onStart, grounded, shown, smallest, afterOne, armed, refusedForget, rearmed, emptied,
          seenFile: window.__shellFile()
        });
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    assert.equal(history.exceptionDetails, undefined,
      `the flight history threw: ${JSON.stringify(history.exceptionDetails)}`);

    const kept = JSON.parse(history.result.value);

    // A. read at start-up, from the host, with no log open
    assert.equal(kept.onStart.visible, true,
      'a history the shell was already holding must be on screen at start-up');
    assert.equal(kept.onStart.flights, 2, 'both stored flights must be listed');
    assert.match(kept.onStart.text, /Bench Mule/, 'the helicopter must be named as the pilot typed it');
    assert.match(kept.onStart.text, /yaw 315\/145\/29/, 'the stored gains must be visible');
    assert.match(kept.onStart.text, /yaw 315\/135\/29/, 'both flights\' gains must be visible');
    assert.equal(kept.onStart.forgetButtons, 2, 'every flight needs its own Forget');
    assert.equal(kept.onStart.aircraftButtons, 1, 'a whole helicopter must be forgettable');
    assert.match(kept.onStart.summary, /no location/i,
      'the panel must say what is not in the file, where the pilot is looking at it');

    // B. a real log, through the real file input
    assert.equal(kept.grounded.settled, true,
      'opening a log must reach the flight-history panel');
    assert.match(kept.grounded.text, /not kept/i,
      'a log that is not remembered must say so; one that silently vanishes looks like a bug');
    assert.match(kept.grounded.text, /never lifted off|rotor never came up/i,
      `the reason must be in words: ${kept.grounded.text.slice(0, 200)}`);
    assert.equal(kept.grounded.saveOffered, false,
      'a ground run must not offer to be saved');

    // C. the renderer, against three verdicts the engine produced
    assert.match(kept.shown.improved.text, /yaw I went 145 to 135/,
      `the headline must name what changed: ${kept.shown.improved.text.slice(0, 200)}`);
    assert.match(kept.shown.improved.text, /That helped/, kept.shown.improved.text.slice(0, 200));
    assert.match(kept.shown.improved.text, /34\.8/, 'the ringing before the change must be shown');
    assert.match(kept.shown.improved.text, /21\.2/, 'and after it');
    assert.match(kept.shown.improved.text, /no floor measured/,
      'the stop metrics have no measured floor, and the panel must say so beside them');

    // THE assertion this whole feature turns on. The engine says the movement
    // cannot be told from a different day; the screen must not say it helped.
    assert.doesNotMatch(kept.shown.unchanged.text, /helped|improved|better|worse/i,
      `a movement inside the noise floor was rendered as a result: ${
        kept.shown.unchanged.text.slice(0, 300)}`);
    assert.match(kept.shown.unchanged.text, /no difference RotorLens can see/,
      kept.shown.unchanged.text.slice(0, 200));

    // ...and its opposite must not borrow its words.
    assert.match(kept.shown.refused.text, /Not enough to compare/,
      kept.shown.refused.text.slice(0, 200));
    assert.match(kept.shown.refused.text, /firmware changed/i,
      'a refusal must give its reason in words, not as a code');
    assert.doesNotMatch(kept.shown.refused.text, /no difference RotorLens can see/,
      '"we could not tell" and "nothing moved" are opposite answers and must never be ' +
      'rendered in the same words');
    assert.doesNotMatch(kept.shown.unchanged.text, /Not enough to compare/,
      'the same, in the other direction');

    for (const name of ['improved', 'unchanged', 'refused']) {
      // Both halves of the floor sentence, and the second is the load-bearing
      // one. It read "differ by up to 0.39" until 2026-08-13, which claimed a
      // bound it does not have: 0.39 is the p90 of 47 identical-gain pairs and
      // the observed maximum is 1.39. This is the sentence a pilot uses to tell
      // a result from weather, so the worst case has to survive to the screen.
      const floor = name === 'refused' ? '0.39' : '0.1';
      assert.match(kept.shown[name].text,
        new RegExp(`usually differ by less than ${floor.replace('.', '\\.')}°/s`),
        `${name} must print the measured noise floor beside its numbers`);
      assert.match(kept.shown[name].text, /as much as 1\.39°\/s/,
        `${name} must print the worst observed case, not only the p90`);
      assert.equal(kept.shown[name].overflowX, 0,
        `${name} scrolled the page sideways at 384px`);
      assert.equal(kept.shown[name].injected, 0, 'a record\'s text must not create elements');
    }

    // D. deletion, and the file behind it
    assert.ok(kept.smallest >= 44,
      `the smallest control in the history panel is ${kept.smallest}px; a thumb needs 44`);
    assert.equal(kept.afterOne.flights, 1, 'forgetting one flight must remove one row');
    assert.equal(kept.afterOne.fileRecords, 1,
      'the row went but the flight stayed in the file the shell holds — a history that ' +
      'looks deleted and is not is worse than one that was never offered');

    assert.match(kept.armed.label, /Tap again/,
      'Forget everything must ask once; window.confirm cannot be used in this WebView');
    assert.equal(kept.armed.flights, 1, 'one tap must not delete anything');
    assert.equal(kept.armed.fileRecords, 1, 'and must not touch the file');

    // A privacy control that fails must say so. Rendering an empty history over
    // a file that still holds every flight is worse than failing loudly: the
    // person who most wanted the data gone is the one told it is gone.
    assert.equal(kept.refusedForget.fileRecords, 1,
      'the stub was told to fail, so the file must still hold the flight');
    assert.equal(kept.refusedForget.flights, 1,
      'a failed erase must keep showing the flights that are still there');
    assert.doesNotMatch(kept.refusedForget.text, /No flights are stored/,
      'a failed erase must not report an empty history');
    assert.match(kept.refusedForget.text, /could not erase/i,
      'a failed erase must tell the pilot it failed');

    assert.equal(kept.emptied.flights, 0, 'the second tap must empty the panel');
    assert.equal(kept.emptied.file, '',
      'forgetting everything must delete the file, not write an empty history into it');
    assert.match(kept.emptied.text, /No flights are stored/,
      'an empty history must say it is empty');

    // Nothing that was ever written may be a coordinate, a clock, or a log.
    assert.doesNotMatch(seedText, /\d{4}-\d{2}-\d{2}/, 'a date reached the stored file');
    assert.doesNotMatch(seedText, /GPS|latitude|longitude|\.bbl/i,
      'location or a file name reached the stored file');
    for (const record of seeded.records) {
      assert.deepEqual(auditFlightRecord(record).violations, [],
        'a stored record broke the never-store rules');
    }

    await client.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);

    assert.deepEqual(pageErrors, [], 'the shell must load with no page errors');
    client.close();
  } finally {
    browser.kill('SIGKILL');
    // Chromium keeps writing its profile for a moment after the signal; removing
    // it before the process is gone fails with ENOTEMPTY.
    await new Promise(resolve => browser.once('exit', resolve));
    await rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
    await new Promise(resolve => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// The flight history, end to end, on a real flight
//
// Every synthetic fixture in this repository is a bench run — all fifteen report
// NO_ROTOR_START_IN_LOG — so none of them can be admitted to the history at all.
// That is the engine being right rather than the fixtures being poor: 72% of the
// sessions in a real dump never left the ground. It does mean the only way to
// prove the whole path — open a log, keep it, compare the next one against it —
// is to open a real flight.
//
// Skipped rather than failed when no log is provided, like every other real-log
// test in this suite.
// ---------------------------------------------------------------------------

const REAL_LOG = process.env.ROTORLENS_REAL_LOG;

test('a real flight is remembered, compared, and can be deleted', {
  skip: chromePath
    ? (REAL_LOG ? false : 'set ROTORLENS_REAL_LOG to a .bbl path to run this')
    : 'no Chromium found; set ROTORLENS_BROWSER to a path'
}, async () => {
  const server = createUiServer();
  const port = await listen(server);

  // The real log lives outside the repository and must stay there — it is
  // somebody's flight, and this repository is public. So it is served from a
  // second, throwaway origin rather than copied into the tree.
  const logBytes = await readFile(REAL_LOG);
  const logServer = createServer((request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    response.end(logBytes);
  });
  const logPort = await listen(logServer);

  const profile = await mkdtemp(path.join(tmpdir(), 'rotorlens-history-'));
  const debugPort = await freePort();

  const browser = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    'about:blank'
  ], {stdio: 'ignore'});

  try {
    const client = await connect(await waitForDevTools(debugPort));
    const {targetId} = await client.send('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await client.send('Target.attachToTarget', {targetId, flatten: true});

    const pageErrors = [];
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

    // The shell, installed before the document loads — the ordering MainActivity
    // really has, and the one that lets the page read its history at start-up.
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        let file = '';
        window.RotorLensNative = {
          pickFile() {},
          readHistory() { return file; },
          writeHistory(text) { file = text; return true; },
          forgetHistory() { file = ''; return true; }
        };
        window.__shellFile = () => file;
      })();`
    }, sessionId);

    await client.send('Page.navigate', {url: `http://127.0.0.1:${port}/`}, sessionId);
    await new Promise(resolve => setTimeout(resolve, 900));
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 384, height: 800, deviceScaleFactor: 2, mobile: true
    }, sessionId);

    const flown = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        const openLog = async name => {
          const bytes = await (await fetch('http://127.0.0.1:${logPort}/log')).arrayBuffer();
          const transfer = new DataTransfer();
          transfer.items.add(new File([bytes], name));
          const input = document.getElementById('file');
          input.files = transfer.files;
          input.dispatchEvent(new Event('change'));

          // A 134k-sample flight runs the hold sweeps for several seconds in a
          // headless browser. Report the timeout rather than falling through it.
          for (let attempt = 0; attempt < 1800; attempt += 1) {
            if (!document.getElementById('since-panel').classList.contains('hidden')) {
              return true;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          return false;
        };

        const first = {settled: await openLog('FIRST-FLIGHT.BBL')};
        first.text = document.getElementById('since').textContent;
        first.saveOffered = Boolean(document.getElementById('since-save'));
        first.fileBefore = window.__shellFile();

        // The pilot chooses to keep it. Nothing was written before this tap.
        if (first.saveOffered) {
          document.getElementById('since-save').click();
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const saved = {
          file: window.__shellFile(),
          rows: document.querySelectorAll('#history .flight').length,
          stillOffersSave: Boolean(document.getElementById('since-save')),
          offersForget: Boolean(document.querySelector('#since [data-forget-flight]'))
        };

        // ...and the next flight of the same helicopter. The same log, so nothing
        // was adjusted between them: the engine must say so rather than credit a
        // movement to a change nobody made.
        const second = {settled: await openLog('SECOND-FLIGHT.BBL')};
        second.text = document.getElementById('since').textContent;
        second.overflowX = document.documentElement.scrollWidth
          - document.documentElement.clientWidth;

        // And a window the pilot moved. checkFlightAdmissible refuses a
        // hand-picked window with the SAME code a bench run gets, so without a
        // sentence of its own the app tells somebody who has just watched their
        // helicopter fly that it never left the ground.
        document.getElementById('since-panel').classList.add('hidden');
        document.getElementById('window-whole').click();
        let moved = false;
        for (let attempt = 0; attempt < 1800; attempt += 1) {
          if (!document.getElementById('since-panel').classList.contains('hidden')) {
            moved = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const dragged = {settled: moved, text: document.getElementById('since').textContent};

        return JSON.stringify({first, saved, second, dragged});
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    assert.equal(flown.exceptionDetails, undefined,
      `the real flight threw: ${JSON.stringify(flown.exceptionDetails)}`);

    const run = JSON.parse(flown.result.value);

    assert.equal(run.first.settled, true, 'a real flight must reach the flight-history panel');
    assert.match(run.first.text, /first flight RotorLens has seen/i,
      `an unseen helicopter must say so: ${run.first.text.slice(0, 200)}`);
    assert.equal(run.first.saveOffered, true, 'an admissible flight must offer to be kept');
    assert.equal(run.first.fileBefore, '',
      'nothing may be written before the pilot chooses to keep the flight');

    assert.ok(run.saved.file.length > 0, 'saving must write the history file');
    assert.equal(run.saved.rows, 1, 'the saved flight must appear in the history');
    assert.equal(run.saved.stillOffersSave, false,
      'a saved flight must not offer to be saved a second time');
    assert.equal(run.saved.offersForget, true,
      'a saved flight must be deletable where it was saved');

    // The privacy rules, on the file that was actually written from a real log —
    // the one that carries a start datetime in its header, and in the reference
    // log GPS frames as well.
    assert.doesNotMatch(run.saved.file, /\d{4}-\d{2}-\d{2}/,
      'the log\'s own start date reached the stored history');
    assert.doesNotMatch(run.saved.file, /FIRST-FLIGHT|\.bbl/i,
      'the imported file name reached the stored history');
    assert.doesNotMatch(run.saved.file, /latitude|longitude|GPS_home|GPS_coord/i,
      'a location field reached the stored history');

    const readBack = JSON.parse(run.saved.file);
    assert.equal(readBack.kind, 'rotorlens-flight-history');
    assert.equal(readBack.records.length, 1);
    assert.deepEqual(auditFlightRecord(readBack.records[0]).violations, [],
      'the record written from a real log broke the never-store rules');

    assert.equal(run.second.settled, true, 'the second flight must reach the panel too');

    // RE-OPENING THE SAME LOG IS NOT A SECOND FLIGHT, and this assertion used to
    // require that it was. It expected "Nothing in the header changed", which
    // only appears when a comparison ran — so it was pinning the app comparing a
    // flight WITH ITSELF, a before/after table whose two columns agree by
    // construction. Reproduced on a handset from the other direction: save,
    // switch the window to "Whole log", switch back, and the panel showed
    // 19.00 against 19.00 and offered Save again, storing a third copy.
    //
    // The correct answer for the same log twice is that it is already stored and
    // there is nothing to compare it against. Two genuinely different flights
    // with identical gains are covered in test/flight-history.test.mjs, where
    // the records can be built directly instead of inferred from one file.
    assert.doesNotMatch(run.second.text, /Nothing in the header changed/i,
      `re-opening one log must not be compared with itself: ${run.second.text.slice(0, 300)}`);
    assert.doesNotMatch(run.second.text, /That helped|made it worse/,
      'a verdict was claimed for a change nobody made');
    assert.match(run.second.text, /first flight RotorLens has seen|Kept on this device/i,
      `the same flight re-derived must read as already stored: ${run.second.text.slice(0, 300)}`);
    assert.equal(run.second.overflowX, 0, 'the panel must not scroll the page sideways at 384px');

    assert.equal(run.dragged.settled, true, 'moving the window must re-run the comparison');
    assert.match(run.dragged.text, /window was set by hand/i,
      `a hand-picked window needs its own reason: ${run.dragged.text.slice(0, 300)}`);
    assert.doesNotMatch(run.dragged.text, /never lifted off/,
      'a flight the pilot watched take off was told it never left the ground, because a ' +
      'moved window is refused with the same code as a bench run');

    assert.deepEqual(pageErrors, [], 'the shell must run a real flight with no page errors');
    client.close();
  } finally {
    browser.kill('SIGKILL');
    await new Promise(resolve => browser.once('exit', resolve));
    await rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
    await new Promise(resolve => logServer.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// What the app has learned, what it still needs, and forgetting it again
//
// The learning itself is `buildSensitivityModel` in flight-history.mjs. What is
// under test here is the screen it is read off, and the screen has one job the
// model cannot do for itself: let a pilot DISAGREE with it. On a machine with
// blades that is a safety feature, so each assertion below is about a way the
// panel could look finished while making disagreement impossible.
//
//  1. "NOT YET" AND "NEVER" MUST NOT LOOK ALIKE. The model separates a gain
//     that needs more flying from one this instrument can never measure, and
//     rendering both as an empty count is how patience comes to look like
//     progress. The seeded history reaches both states at once.
//  2. A BELIEF MUST NAME ITS EVIDENCE AND LOSE IT AGAIN. Forgetting a flight
//     re-fits over what is left; forgetting the right one takes the belief away
//     entirely. Both are asserted, because a count that falls while the claim
//     stands is worse than either.
//  3. AN AMOUNT MAY ONLY NARROW ADVICE THAT IS ALREADY ON SCREEN. A magnitude
//     naming a finding the engine did not publish, or pointing the opposite way
//     to the one it names, must render nowhere at all.
//
// It runs against a real flight through the real file input at phone metrics,
// because the panel lives under the advice a real log produces, and a renderer
// proved only against hand-built input is one that has never met a helicopter.
// ---------------------------------------------------------------------------

/**
 * Eight flights of one helicopter, sweeping yaw P and nothing else.
 *
 * Built to reach three different model states at once, and every one of them is
 * the model's verdict rather than this test's:
 *
 *   yaw P  — eight flights at five values, and three at 100 which give the
 *            aircraft its OWN measured noise floor. That is what lets a
 *            magnitude exist at all; without it the model is judging a slope
 *            against somebody else's machine and refuses.
 *   yaw D  — permanently unmeasurable on this response metric, whatever is
 *            flown. D acts on how fast the error is changing, and during a hold
 *            that is nothing.
 *   roll P — never changed, so there is nothing to learn from yet.
 */
/**
 * Eight flights, and the ORDER of them is load-bearing.
 *
 * These are the same eight (gain, measurement) pairs the fixture always had, but
 * they are no longer flown as a ladder. A gain that only ever climbs is
 * indistinguishable from the calendar climbing with it, and the model now
 * refuses that design outright — so a ladder here would have made the whole
 * belief half of this test unreachable, silently. The pilot flies 100, then 400,
 * then back to 100: the gain goes both ways, which is what lets the fit separate
 * it from anything that merely drifted.
 *
 * Flight #1 is one of the three at gain 100 that give this aircraft its own
 * measured noise floor, and #4 is a middle value. Both are forgotten below, and
 * which flight sits at which number is what those assertions are keyed to.
 */
const SWEEP_FLIGHTS = Object.freeze([
  [100, 6.6], [400, 1.2], [100, 6.0], [200, 2.8],
  [140, 4.2], [400, 1.0], [100, 5.4], [280, 1.9]
]);

function sweepRecord(yawP, errorDps) {
  return buildFlightRecord({
    session: {
      craftName: 'Bench Mule',
      board: 'STM32H743 TEST',
      headers: {
        rollPID: '50,60,30,100,0',
        pitchPID: '52,62,32,100,0',
        yawPID: `${yawP},145,29,3,1`,
        rates_type: '4',
        rc_rates: '5,5,12',
        rates: '10,10,10'
      },
      firmware: {revision: 'Rotorflight 4.6.0'}
    },
    window: {basis: 'FLIGHT_WINDOW_DETECTED', startUs: 0, endUs: 120_000_000},
    axes: {
      yaw: {
        headspeedMedianRpm: 1800,
        holdEvidence: holdEvidenceWith(errorDps),
        stopEvidence: null
      }
    }
  });
}

test('what RotorLens has learned is on screen, and can be forgotten again', {
  skip: chromePath
    ? (REAL_LOG ? false : 'set ROTORLENS_REAL_LOG to a .bbl path to run this')
    : 'no Chromium found; set ROTORLENS_BROWSER to a path'
}, async () => {
  let seeded = createHistory();
  for (const [yawP, errorDps] of SWEEP_FLIGHTS) {
    seeded = addFlightRecord(seeded, sweepRecord(yawP, errorDps));
  }
  const seedText = exportHistory(seeded);
  const aircraftKey = seeded.records[0].aircraftKey;

  // The model's own verdicts, taken here rather than asserted inside the page,
  // so this stays a test of what the pilot is shown and not a second copy of
  // the fit. If these three ever stop holding, the fixture has drifted and the
  // assertions below would be checking a renderer against nothing.
  const model = buildSensitivityModel(seeded, aircraftKey);
  const yawP = findSensitivityTerm(model, 'yaw', 'P');
  const yawD = findSensitivityTerm(model, 'yaw', 'D');
  const rollP = findSensitivityTerm(model, 'roll', 'P');

  assert.equal(yawP.state, SENSITIVITY_STATE.USABLE,
    'the sweep must reach a believable fit, or the belief half of this test is unreachable');
  assert.ok(yawP.magnitude !== null, 'and must earn a magnitude');
  assert.equal(yawP.pointCount, 8);
  assert.equal(model.floors.yaw.source, 'own-aircraft',
    'the magnitude rests on the aircraft\'s OWN measured floor; without that it is judged '
    + 'against somebody else\'s machine and the model refuses it');
  assert.equal(yawD.state, SENSITIVITY_STATE.UNDERPOWERED);
  assert.ok(yawD.codes.includes('RESPONSE_METRIC_NOT_SENSITIVE_TO_TERM'),
    'yaw D must be unmeasurable-in-principle, not merely short of flights — the two are '
    + 'the states this panel most has to keep apart');
  assert.equal(rollP.state, SENSITIVITY_STATE.NO_EVIDENCE);

  const server = createUiServer();
  const port = await listen(server);

  const logBytes = await readFile(REAL_LOG);
  const logServer = createServer((request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    response.end(logBytes);
  });
  const logPort = await listen(logServer);

  const profile = await mkdtemp(path.join(tmpdir(), 'rotorlens-learn-'));
  const debugPort = await freePort();

  const browser = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    'about:blank'
  ], {stdio: 'ignore'});

  try {
    const client = await connect(await waitForDevTools(debugPort));
    const {targetId} = await client.send('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await client.send('Target.attachToTarget', {targetId, flatten: true});

    const pageErrors = [];
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

    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        let file = ${JSON.stringify(seedText)};
        window.RotorLensNative = {
          pickFile() {},
          readHistory() { return file; },
          writeHistory(text) { file = text; return true; },
          forgetHistory() { file = ''; return true; }
        };
        window.__shellFile = () => file;
      })();`
    }, sessionId);

    await client.send('Page.navigate', {url: `http://127.0.0.1:${port}/`}, sessionId);
    await new Promise(resolve => setTimeout(resolve, 900));
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 384, height: 800, deviceScaleFactor: 2, mobile: true
    }, sessionId);

    const learned = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        const app = await import('/ui/app.mjs');
        const mule = () => [...document.querySelectorAll('#history .aircraft')]
          .find(block => block.textContent.includes('Bench Mule'));
        const cell = gain => {
          const found = mule()?.querySelector(
            '.learn-grid td[data-gain="' + gain + '"]'
          );
          return found === undefined || found === null
            ? null : found.textContent.replace(/\\s+/g, ' ').trim();
        };
        const learnText = () => mule()?.querySelector('.learn')?.textContent ?? '';

        // A. What eight saved flights add up to, with nothing asked of the page.
        const start = {
          text: learnText(),
          yawP: cell('yaw P'),
          yawD: cell('yaw D'),
          rollP: cell('roll P'),
          next: mule()?.querySelector('.learn-next')?.textContent ?? null,
          flights: mule()?.querySelectorAll('.flight').length ?? 0
        };

        // A closed <details> is not something the pilot has been shown.
        for (const box of document.querySelectorAll('#history details')) {
          box.open = true;
        }
        start.detail = learnText();
        start.smallestControl = [...document.querySelectorAll(
          '#history button, #history summary'
        )].map(node => Math.round(node.getBoundingClientRect().height))
          .sort((left, right) => left - right)[0];
        start.overflowX = document.documentElement.scrollWidth
          - document.documentElement.clientWidth;

        // B. A real flight, through the real file input, at phone metrics.
        const bytes = await (await fetch('http://127.0.0.1:${logPort}/log')).arrayBuffer();
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], 'LEARNING.BBL'));
        const input = document.getElementById('file');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change'));

        let settled = false;
        for (let attempt = 0; attempt < 1800; attempt += 1) {
          if (!document.getElementById('since-panel').classList.contains('hidden')) {
            settled = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        const opened = {
          settled,
          // The seeded helicopter's model must survive another machine's log
          // being opened over the top of it.
          yawP: cell('yaw P'),
          advice: document.getElementById('recommend').textContent,
          overflowX: document.documentElement.scrollWidth
            - document.documentElement.clientWidth
        };

        const save = document.getElementById('since-save');
        opened.saveOffered = Boolean(save);
        if (save) {
          save.click();
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        opened.history = document.getElementById('history').textContent;

        // C. Forgetting, twice, by the flight number the pilot can see.
        //
        //    Scoped to that helicopter's own block: the real flight saved above
        //    added a SECOND aircraft to the panel, and a selector across the
        //    whole list reaches its row instead.
        const forget = ordinalLabel => {
          const row = [...mule().querySelectorAll('.flight')].find(
            node => node.querySelector('.ord')?.textContent.trim() === ordinalLabel
          );
          row.querySelector('[data-forget-flight]').click();
          return new Promise(resolve => setTimeout(resolve, 200));
        };

        // #4 is one of the middle values. The fit survives it and is re-made
        // over what is left, so the claim has to change without vanishing.
        await forget('#4');
        const refitted = {
          yawP: cell('yaw P'),
          text: learnText(),
          flights: mule().querySelectorAll('.flight').length
        };

        // #1 is one of the three flights at the same gain that gave this
        // aircraft its own measured noise floor. Without them the scatter can
        // no longer be told from the machine, and the belief has to go.
        await forget('#1');
        const unlearned = {
          yawP: cell('yaw P'),
          text: learnText(),
          next: mule().querySelector('.learn-next')?.textContent ?? null,
          rows: mule().querySelectorAll('.flight').length,
          fileRecords: (window.__shellFile().match(/rotorlens-flight-record/g) ?? []).length
        };

        // D. The advice cards. A hand-built result, because the direction and
        //    the amount have to be separable whatever a log happens to say, and
        //    because the states below are ones no history reaches.
        const box = document.getElementById('history');
        const learning = app.learningFromHistory(
          ${JSON.stringify(seeded)}, ${JSON.stringify(aircraftKey)},
          ${JSON.stringify(model)}
        );
        const finding = {
          id: 'yaw-p-tracking', kind: 'adjustment', rung: 'gain', axis: 'yaw',
          confidence: 'medium', actNow: true, adjust: 'yaw P', direction: 'increase',
          headline: 'Yaw is not keeping up with the command.',
          reasoning: 'Standing error through every hold, no ringing after the stops.',
          candidates: [], confirm: 'Raise it one step and fly the same holds again.',
          basis: [], codes: []
        };
        const resultWith = magnitudes => ({
          gates: {}, findings: [finding], withheld: [], magnitudes,
          magnitudeBasis: null, boundary: 'One log, one flight.'
        });
        const advice = magnitudes => {
          box.innerHTML = app.recommendationsHtml(resultWith(magnitudes), {}, learning);
          return box.textContent;
        };
        // The same card shape for a gain the model has ruled out FOREVER.
        // D_TOO_HIGH ships, and buildSensitivityModel returns a non-null state
        // for D from the very first flight, so this card is on every screen from
        // day one — which is what made the sentence it used to carry a day-one,
        // every-user contradiction with the grid four lines below it.
        const dFinding = {
          ...finding, id: 'yaw-d-ringing', adjust: 'yaw D', direction: 'decrease',
          headline: 'Yaw rings after the stops.'
        };
        const dCard = () => {
          box.innerHTML = app.recommendationsHtml(
            {gates: {}, findings: [dFinding], withheld: [], magnitudes: [],
              magnitudeBasis: null, boundary: 'One log, one flight.'},
            {}, learning
          );
          return box.textContent;
        };
        const cards = {
          permanentlyUnmeasurable: dCard(),
          convention: advice([]),
          measured: advice([{
            findingId: 'yaw-p-tracking', direction: 'increase', experiments: 8,
            sentence: 'MEASURED STEP, from your own flights.'
          }]),
          orphan: advice([{
            findingId: 'a-finding-that-is-not-on-screen', direction: 'increase',
            experiments: 8, sentence: 'ORPHANED AMOUNT.'
          }]),
          contrary: advice([{
            findingId: 'yaw-p-tracking', direction: 'decrease', experiments: 8,
            sentence: 'CONTRARY AMOUNT.'
          }])
        };

        return JSON.stringify({start, opened, refitted, unlearned, cards});
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    assert.equal(learned.exceptionDetails, undefined,
      `the learning panel threw: ${JSON.stringify(learned.exceptionDetails)}`);

    const run = JSON.parse(learned.result.value);

    // A. the three states, side by side, in one grid
    assert.match(run.start.text, /What RotorLens has learned about this helicopter/,
      `the panel must be on screen: ${run.start.text.slice(0, 300)}`);
    assert.equal(run.start.yawP, '8 measured',
      'a gain the model believes must show the flights behind it and say it is measured');
    assert.equal(run.start.yawD, '— not measurable',
      'a gain this instrument can NEVER read must not be rendered as a gain that merely '
      + 'needs more flying; that is how patience comes to look like progress');
    assert.equal(run.start.rollP, '0 of 6',
      'a gain that has never been changed must say how many flights it would take, in units');

    assert.match(run.start.text, /8 flights saved/, run.start.text.slice(0, 300));
    assert.match(run.start.text, /measured on your helicopter/,
      'a fitted amount must be labelled as measured on this machine');
    // The model's own sentence, not one composed on this screen.
    assert.ok(run.start.text.includes(yawP.magnitude.sentence),
      `the panel must print the model's own words: ${run.start.text.slice(0, 600)}`);
    assert.match(run.start.text, /from 8 of your own flights/,
      'a belief must name how much evidence is behind it');
    assert.match(run.start.text, /Forget one of them and this changes/,
      'and must say what would remove it');

    // The per-aircraft noise floor: the first thing this app can honestly learn,
    // and the bar every other result has to clear.
    assert.match(run.start.text, /Measured on your own flights where nothing was changed/,
      `the learned floor must be reported: ${run.start.text.slice(0, 600)}`);
    assert.match(run.start.text, new RegExp(`yaw wanders by up to ${
      model.floors.yaw.appliedDps.toFixed(2)}`),
      'and must quote the model\'s own figure rather than the corpus one');

    assert.equal(typeof run.start.next, 'string', 'the panel must ask for a specific flight');
    assert.ok(run.start.detail.includes(yawP.needs.sentence)
      || run.start.next.includes(rollP.needs.sentence),
      `the ask must be the model's own sentence: ${run.start.next}`);

    assert.ok(run.start.smallestControl >= 44,
      `the smallest control beside the learning panel is ${run.start.smallestControl}px; `
      + 'a thumb needs 44');
    assert.equal(run.start.overflowX, 0,
      'the learning panel scrolled the page sideways at 384px');

    // B. a real flight, through the real file input
    assert.equal(run.opened.settled, true, 'a real flight must reach the flight-history panel');
    assert.equal(run.opened.yawP, '8 measured',
      'opening another helicopter\'s log must not disturb what was learned about this one');
    assert.equal(run.opened.overflowX, 0,
      'the page must not scroll sideways at 384px with a real flight open');
    assert.match(run.opened.advice, /Flight history panel counts how many/,
      'with no amount published for THIS helicopter, the advice must point at the evidence '
      + 'that could ever produce one');
    assert.doesNotMatch(run.opened.advice, /measured on your helicopter/,
      'nothing has been measured on the helicopter in the open log, and its advice must not '
      + 'borrow the belief held about a different machine');
    assert.equal(run.opened.saveOffered, true,
      'a real flight of an unseen helicopter must offer to be kept');
    assert.match(run.opened.history, /One flight saved, and nothing to compare it against/,
      `a helicopter's first flight must say what it is waiting for: ${
        run.opened.history.slice(0, 400)}`);

    // C. forgetting un-learns, in two different ways
    assert.equal(run.refitted.flights, 7, 'forgetting one flight must remove one row');
    assert.equal(run.refitted.yawP, '7 measured',
      'the belief survives losing a middle value, but the count behind it must fall with it');
    assert.match(run.refitted.text, /from 7 of your own flights/,
      `the claim must be re-made over what is left: ${run.refitted.text.slice(0, 400)}`);
    assert.doesNotMatch(run.refitted.text, /from 8 of your own flights/,
      'a belief still citing a flight the pilot has deleted is the app claiming evidence '
      + 'that no longer exists');

    assert.equal(run.unlearned.yawP, '6 disagree',
      'losing the flights that measured this aircraft\'s own noise must take the belief with '
      + 'them — the scatter can no longer be told from the machine');
    assert.doesNotMatch(run.unlearned.text, /measured on your helicopter/,
      'the belief must be gone from the screen, not merely re-worded');
    assert.ok(!run.unlearned.text.includes(yawP.magnitude.sentence),
      'and the amount it claimed must be gone with it');
    assert.match(run.unlearned.text, /disagree with each other/,
      `the reason must be the model's own: ${run.unlearned.text.slice(0, 400)}`);
    assert.equal(run.unlearned.rows, 6, 'two of the eight rows must be gone from the panel');
    // Six of this helicopter's, plus the real flight saved in section B. The
    // screen emptying while the file keeps the flight is the failure this
    // catches, and it is the one that makes a privacy control a lie.
    assert.equal(run.unlearned.fileRecords, 7,
      'the flights must be gone from the file the shell holds, not only from the screen');

    // D. an amount may only narrow advice that is already on screen
    assert.match(run.cards.convention, /general convention/,
      `an amount-free adjustment must be labelled as a convention: ${
        run.cards.convention.slice(0, 400)}`);
    // The card must say what this machine's own flights have taught, IN THE
    // GRID'S OWN WORDS. It reads them out of `learningCell`, the same function
    // the nine-cell grid uses, so the card and the grid cannot disagree about
    // the same gain on the same screen — which they did, in both directions: a
    // D card promised that six flights would buy an amount for a gain the grid
    // called permanently unmeasurable, and a term past six points read "8 out of
    // the 6 at the very least" beside a cell saying those eight disagreed.
    assert.match(run.cards.convention, /Your own flights so far for yaw P: 8 measured/,
      'and must say how much of its own machine\'s evidence it has, in the grid\'s words');
    // A card for a gain that can NEVER be measured must not ask for flights
    // towards measuring it. The grid says `— not measurable` for yaw D in the
    // same panel; a card promising that six flights would buy an amount is the
    // two surfaces contradicting each other about the same gain on one screen.
    assert.match(run.cards.permanentlyUnmeasurable, /No number of flights can put an amount on/,
      'a permanently unmeasurable gain must be named as such on the card, not counted towards');
    assert.doesNotMatch(run.cards.permanentlyUnmeasurable, /out of the \d+/,
      'and must carry no target a pilot could fly towards');
    assert.doesNotMatch(run.cards.permanentlyUnmeasurable, /Your own flights so far/,
      'and must not be given a running count either, which reads as progress');

    assert.match(run.cards.measured, /measured on your helicopter/,
      'an amount fitted to this pilot\'s flights must say so on the card');
    assert.match(run.cards.measured, /MEASURED STEP/,
      'and must print the amount\'s own sentence rather than one invented here');
    assert.match(run.cards.measured, /From 8 of your own flights/,
      'a pilot must be able to see how much evidence is behind an amount');
    assert.doesNotMatch(run.cards.measured, /general convention/, 'a card cannot be both');

    assert.doesNotMatch(run.cards.orphan, /ORPHANED AMOUNT/,
      'an amount naming a finding that is not on screen must render nowhere; the airframe '
      + 'interlock suppresses findings, and an amount that outlives the finding it belongs '
      + 'to is advice the gates refused');
    assert.match(run.cards.orphan, /general convention/,
      'and the card it failed to attach to must fall back to the honest label');
    assert.doesNotMatch(run.cards.contrary, /CONTRARY AMOUNT/,
      'an amount pointing the opposite way to the finding it names must render nowhere');

    assert.deepEqual(pageErrors, [], 'the learning panel must run with no page errors');
    await client.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
    client.close();
  } finally {
    browser.kill('SIGKILL');
    await new Promise(resolve => browser.once('exit', resolve));
    await rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
    await new Promise(resolve => logServer.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// Shared measurements: the question, the identity, the payload, and the erase
//
// NOTHING IN THIS APP SENDS ANYTHING ANYWHERE, and the first thing this test
// does is prove it: the DevTools Network domain is watching, and every request
// the page makes from the moment a log has finished loading to the end of the
// run is counted. Turning sharing on, reading the payload and erasing the
// identity must issue ZERO of them. That assertion is the one this whole feature
// is built around — the app requests no INTERNET or sensitive platform
// permission, and other tests pin that precise claim to the merged Android
// manifest. This one checks the page's behaviour rather than its text, which is
// the half those tests cannot reach.
//
// What else is under test here is a screen, and screens fail in ways a unit test
// cannot see. Each assertion below is a way this one could look finished while
// being dishonest:
//
//  1. ASKED AFTER THE APP HAS DONE SOMETHING, NOT AT FIRST RUN. A dialog on a
//     blank page is a dialog people learn to tap through, and consent taught by
//     reflex is not consent. It must not be on screen before a log is, and it
//     must be on screen once a flight has actually been measured.
//  2. OFF BY DEFAULT, AND ASKED ONCE. "Not now" is a choice that has to stick
//     across a re-analysis, or the app is nagging.
//  3. NOTHING IS WRITTEN BEFORE AN ANSWER. The same rule the flight history
//     already keeps: the file is empty until somebody presses something.
//  4. THE PAYLOAD ON SCREEN IS THE REAL ONE. It is built by `shareableRecord`
//     from a record made out of a real .bbl, and the helicopter's own name — the
//     one that is in the log, in the history file and on the screen above —
//     appears nowhere in it. The needle is read out of the stored record rather
//     than hard-coded, and asserted to be a real name first, because a needle
//     that is empty finds nothing and proves nothing.
//  5. THE ERASE ERASES, AND ERASES ONLY WHAT IT SAYS. The sharing file goes; the
//     flights stay. A control that took the history with it is one nobody dares
//     press, and one nobody presses is one that does not work.
//  6. EVERY CONTROL IS A FINGER TARGET, measured on the handset's metrics rather
//     than assumed, and the two buttons in the dialog are THE SAME SIZE — a
//     larger "yes" than "no" is the cheapest dark pattern there is and this is
//     the one screen where it would matter most.
// ---------------------------------------------------------------------------

test('sharing is asked once, shows what would leave, erases — and sends nothing', {
  skip: chromePath
    ? (REAL_LOG ? false : 'set ROTORLENS_REAL_LOG to a .bbl path to run this')
    : 'no Chromium found; set ROTORLENS_BROWSER to a path'
}, async () => {
  const server = createUiServer();
  const port = await listen(server);

  const logBytes = await readFile(REAL_LOG);
  const logServer = createServer((request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    response.end(logBytes);
  });
  const logPort = await listen(logServer);

  const profile = await mkdtemp(path.join(tmpdir(), 'rotorlens-sharing-'));
  const debugPort = await freePort();

  const browser = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    'about:blank'
  ], {stdio: 'ignore'});

  try {
    const client = await connect(await waitForDevTools(debugPort));
    const {targetId} = await client.send('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await client.send('Target.attachToTarget', {targetId, flatten: true});

    const pageErrors = [];
    /**
     * Every request the page makes, in order.
     *
     * `Network.requestWillBeSent` fires before anything leaves, and it fires for
     * fetch, XHR, WebSocket handshakes, beacons, images, scripts and anything
     * else with a URL — which is the point. A test that grepped the source for
     * `fetch(` would pass on `window[atob('ZmV0Y2g=')]`; this one does not care
     * how a request is written.
     */
    const requests = [];
    client.on(message => {
      if (message.method === 'Runtime.exceptionThrown') {
        pageErrors.push(
          message.params.exceptionDetails.exception?.description
          ?? message.params.exceptionDetails.text
        );
      }
      if (message.method === 'Network.requestWillBeSent') {
        requests.push(message.params.request.url);
      }
    });

    await client.send('Runtime.enable', {}, sessionId);
    await client.send('Network.enable', {}, sessionId);
    await client.send('Page.enable', {}, sessionId);

    // The shell, with the two independent file outcomes HistoryStore.java
    // provides. The page invokes both for Forget everything so a partial unlink
    // cannot make either result look different from what happened on disk.
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        let history = '';
        let sharing = '';
        window.RotorLensNative = {
          pickFile() {},
          readHistory() { return history; },
          writeHistory(text) { history = text; return true; },
          forgetHistory() { history = ''; return true; },
          readSharing() { return sharing; },
          writeSharing(text) { sharing = text; return true; },
          forgetSharing() { sharing = ''; return true; }
        };
        window.__shellFile = () => history;
        window.__shellSharing = () => sharing;
      })();`
    }, sessionId);

    await client.send('Page.navigate', {url: `http://127.0.0.1:${port}/`}, sessionId);
    await new Promise(resolve => setTimeout(resolve, 900));
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 384, height: 800, deviceScaleFactor: 2, mobile: true
    }, sessionId);

    // ---- before a log: nothing asked, nothing stored ---------------------
    const cold = await client.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        consentShown: !document.getElementById('consent').classList.contains('hidden'),
        panelShown: !document.getElementById('sharing-panel').classList.contains('hidden'),
        sharingFile: window.__shellSharing()
      })`,
      returnByValue: true
    }, sessionId);
    const before = JSON.parse(cold.result.value);

    // ---- open a real flight, through the real file input ------------------
    const opened = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        const bytes = await (await fetch('http://127.0.0.1:${logPort}/log')).arrayBuffer();
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], 'BELL-222UT.BBL'));
        const input = document.getElementById('file');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change'));

        for (let attempt = 0; attempt < 1800; attempt += 1) {
          if (!document.getElementById('since-panel').classList.contains('hidden')) {
            // The dialog is raised at the very end of the same run that fills
            // that panel, so give the tail of it a turn of the loop.
            await new Promise(resolve => setTimeout(resolve, 200));
            return true;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return false;
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);
    assert.equal(opened.exceptionDetails, undefined,
      `opening the log threw: ${JSON.stringify(opened.exceptionDetails)}`);
    assert.equal(opened.result.value, true, 'a real flight must reach the flight-history panel');

    // Everything from here on is the sharing screen, and NOTHING FROM HERE ON
    // MAY TOUCH THE NETWORK. The log has finished loading, so any request after
    // this mark came from the code under test.
    const requestsBeforeSharing = requests.length;

    // THE COVERAGE GUARD FOR THE ASSERTION BELOW, and it is not decoration.
    // That assertion is `deepEqual(madeRequests, [])`, which is exactly what a
    // dead capture also produces: if `Network.enable` had silently failed, or
    // the handler had stopped matching `Network.requestWillBeSent`, the strongest
    // test in this repository would pass by seeing nothing at all and would be
    // indistinguishable from working. The page and the log were both loaded over
    // HTTP by this point, so a live capture cannot be empty here.
    assert.ok(requestsBeforeSharing > 0,
      'no requests were captured while LOADING the page, so the network capture is not working '
      + 'and the no-network assertion below would pass vacuously');

    const flown = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        const $ = id => document.getElementById(id);
        const settle = () => new Promise(resolve => setTimeout(resolve, 120));
        // Width and font size as well as height. The actions row is a flexbox
        // whose items stretch by default, so both answers are the same HEIGHT
        // whatever anyone does to one of them — an assertion on height alone
        // could not fail, and would have been a test that agrees with whatever
        // it finds. Width and type size are the dimensions somebody could
        // actually use to make one answer louder than the other.
        const sizes = selector => [...document.querySelectorAll(selector)]
          .filter(node => node.offsetParent !== null)
          .map(node => {
            const box = node.getBoundingClientRect();
            return {
              text: node.textContent.trim().slice(0, 40),
              height: Math.round(box.height),
              width: Math.round(box.width),
              fontSize: getComputedStyle(node).fontSize
            };
          });

        // ---- the question ------------------------------------------------
        const asked = {
          shown: !$('consent').classList.contains('hidden'),
          text: $('consent').textContent.replace(/\\s+/g, ' ').trim(),
          buttons: sizes('#consent button'),
          // The licence sentence must be OUTSIDE the privacy paragraph, in its
          // own block. Bundling a commercial grant into a privacy notice makes
          // the consent weaker rather than the licence stronger.
          licenceSeparated: Boolean(
            $('consent').querySelector('.consent-licence')
          ) && $('consent').querySelector('.consent-licence').textContent
            .includes('keep ownership of your measurements'),
          privacyParagraphHasLicence: [...$('consent').querySelectorAll('p')]
            .some(p => p.textContent.includes('never leaves your phone')
              && p.textContent.includes('distributed for a fee')),
          fileBefore: window.__shellSharing()
        };

        // ---- "Not now" ---------------------------------------------------
        $('consent-not-now').click();
        await settle();
        const declined = {
          shown: !$('consent').classList.contains('hidden'),
          file: window.__shellSharing(),
          panel: $('sharing').textContent.replace(/\\s+/g, ' ').trim()
        };

        // ---- keep the flight, so there is something to describe ----------
        if ($('since-save')) { $('since-save').click(); }
        await settle();

        const off = {
          panel: $('sharing').textContent.replace(/\\s+/g, ' ').trim(),
          idShown: Boolean(document.querySelector('#sharing .share-id')),
          file: window.__shellSharing()
        };

        // ---- read the payload BEFORE agreeing to anything ----------------
        document.querySelector('#sharing [data-share-show]').click();
        await settle();
        const preview = {
          payload: document.querySelector('#sharing pre.export').textContent,
          text: $('sharing').textContent.replace(/\\s+/g, ' ').trim(),
          file: window.__shellSharing()
        };

        // ---- ask again from the panel, then switch it on -----------------
        // The payload is left OPEN across the repaint on purpose: what is read
        // below is the same panel a moment later, so the example identity being
        // replaced by this helicopter's real one is the only thing that changed.
        const fileBeforeReconsidering = window.__shellSharing();
        $('sharing-toggle').click();
        await settle();
        const reconsider = {
          shown: !$('consent').classList.contains('hidden'),
          text: $('consent').textContent.replace(/\s+/g, ' ').trim(),
          file: window.__shellSharing(),
          fileBefore: fileBeforeReconsidering
        };
        $('consent-not-now').click();
        await settle();
        const reconsiderDeclined = {
          shown: !$('consent').classList.contains('hidden'),
          file: window.__shellSharing(),
          focus: document.activeElement?.id ?? null
        };
        $('sharing-toggle').click();
        await settle();
        const reconsiderAgain = {
          shown: !$('consent').classList.contains('hidden'),
          file: window.__shellSharing()
        };
        $('consent-share').click();
        await settle();
        const on = {
          panel: $('sharing').textContent.replace(/\\s+/g, ' ').trim(),
          id: document.querySelector('#sharing .share-id code')?.textContent ?? null,
          payload: document.querySelector('#sharing pre.export')?.textContent ?? '',
          file: window.__shellSharing(),
          controls: sizes('#sharing button'),
          focus: document.activeElement?.id ?? null
        };

        // ---- re-analyse: the question must not come back ------------------
        //
        // "Use the detected flight" rather than "Whole log", and the difference
        // is the whole assertion. A hand-picked window is INADMISSIBLE — the
        // engine refuses it with the same code a bench run gets — so the flight
        // would produce no record, and the dialog is deliberately not raised
        // when there is nothing to point at. Re-running with the detected window
        // keeps the flight admissible, which leaves "it has already been asked"
        // as the only thing standing between the pilot and a second dialog.
        // That is what is under test; the admissible flag below proves it.
        $('since-panel').classList.add('hidden');
        $('window-detect').click();
        let rerun = false;
        for (let attempt = 0; attempt < 1800; attempt += 1) {
          if (!$('since-panel').classList.contains('hidden')) {
            await new Promise(resolve => setTimeout(resolve, 400));
            rerun = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const again = {
          rerun,
          consentShown: !$('consent').classList.contains('hidden'),
          admissible: Boolean($('since-save')
            || document.querySelector('#since [data-forget-flight]'))
        };

        // ---- erase, behind the second tap --------------------------------
        const armed = {oneTap: null};
        $('sharing-forget').click();
        await settle();
        armed.oneTap = {
          file: window.__shellSharing(),
          label: $('sharing-forget').textContent.trim()
        };
        $('sharing-forget').click();
        await settle();

        const erased = {
          sharingFile: window.__shellSharing(),
          historyFile: window.__shellFile(),
          panel: $('sharing').textContent.replace(/\\s+/g, ' ').trim(),
          rows: document.querySelectorAll('#history .flight').length,
          overflowX: document.documentElement.scrollWidth
            - document.documentElement.clientWidth
        };

        return JSON.stringify({
          asked, declined, off, preview, reconsider, reconsiderDeclined,
          reconsiderAgain, on, again, armed, erased
        });
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    assert.equal(flown.exceptionDetails, undefined,
      `the sharing screen threw: ${JSON.stringify(flown.exceptionDetails)}`);
    const run = JSON.parse(flown.result.value);

    // =====================================================================
    // THE ONE THAT ENDS THE FEATURE IF IT FAILS
    // =====================================================================
    const madeRequests = requests.slice(requestsBeforeSharing);
    assert.deepEqual(madeRequests, [],
      'the sharing screen made a network request. Nothing in this app may reach the network: '
      + 'the app has no INTERNET or sensitive platform permission, the store copy says it has '
      + `no network permission, and the consent dialog says nothing is sent. Requests: ${
        JSON.stringify(madeRequests)}`);

    // =====================================================================
    // 1. asked after the app has done something, never at first run
    // =====================================================================
    assert.equal(before.consentShown, false,
      'the consent dialog was on screen before a log had been opened. Asking before the app '
      + 'has done anything useful is how consent becomes a reflex tap');
    assert.equal(before.sharingFile, '',
      'a sharing file existed before anyone was asked anything; off by default must cost '
      + 'nothing on disk');
    assert.equal(run.asked.shown, true,
      'the consent dialog must appear once a real flight has actually been measured');
    assert.equal(run.asked.fileBefore, '',
      'nothing may be written while the question is still on screen and unanswered');

    // The design's own wording, section 4. Checked rather than paraphrased,
    // because these sentences are the promise the whole feature rests on.
    assert.match(run.asked.text, /Help RotorLens get better at this\?/);
    assert.match(run.asked.text, /Your log never leaves your phone/,
      'the dialog must say what does NOT go');
    assert.match(run.asked.text,
      /Never the log, never your location, never a date, never a file name, and never your/,
      'the dialog must list what is never sent, item by item');
    assert.match(run.asked.text, /see everything that has been sent, and delete all of it/,
      'the dialog must promise the deletion the panel then has to provide');

    // Section 4a: one sentence, in the dialog, visually separated.
    assert.equal(run.asked.licenceSeparated, true,
      'the licence grant must be its own block. Burying a commercial grant inside the privacy '
      + 'paragraph makes the consent weaker rather than the licence stronger');
    assert.equal(run.asked.privacyParagraphHasLicence, false,
      'the licence sentence is inside the privacy paragraph, which is the shape section 4a '
      + 'specifically rules out');
    assert.match(run.asked.text, /including free releases and releases distributed for a fee/,
      'the grant must name commercial use rather than leave it to be discovered later');
    assert.match(run.asked.text,
      /cannot be recalculated to exclude records that no longer exist/,
      'the terms must state the deletion wrinkle: a threshold already computed cannot be '
      + 'un-computed, and finding that out after a deletion request would not be honest');

    // 4. The dialog must not imply anything is going anywhere.
    assert.match(run.asked.text, /Nothing is sent yet, and this version cannot send/,
      'a dialog offering to send from an app that cannot send must say so');
    assert.match(run.asked.text, /has no internet or sensitive platform permission/i,
      'and must point at the checkable fact rather than only promising');

    // 6. Both buttons the same size, and both a finger target.
    assert.equal(run.asked.buttons.length, 2, 'the dialog offers exactly two answers');
    const [notNow, share] = run.asked.buttons;
    assert.match(notNow.text, /^Not now$/,
      '"Not now" rather than "No": it is asked once, and a pilot who declines can turn it on '
      + 'later from the panel without feeling the door closed');
    assert.ok(notNow.height >= 44 && share.height >= 44,
      `both answers must be finger targets: ${JSON.stringify(run.asked.buttons)}`);
    // Height is equalised by the flexbox and proves nothing on its own; these
    // two are the dimensions a designer could actually lean on.
    assert.ok(Math.abs(notNow.width - share.width) <= 4,
      `the declining answer is ${notNow.width}px wide and the agreeing one is ${share.width}px. `
      + 'Making the button that benefits the app bigger is the cheapest dark pattern there is');
    assert.equal(notNow.fontSize, share.fontSize,
      `the declining answer is set in ${notNow.fontSize} and the agreeing one in `
      + `${share.fontSize}; the two answers must carry the same weight`);

    // =====================================================================
    // 2 and 3. off by default, recorded once, and not asked again
    // =====================================================================
    assert.equal(run.declined.shown, false, '"Not now" must close the dialog');
    const declinedFile = JSON.parse(run.declined.file);
    assert.equal(declinedFile.sharing, false, '"Not now" must leave sharing off');
    assert.equal(declinedFile.asked, true, 'and must record that the question was asked');
    assert.equal(declinedFile.termsVersion, null,
      '"Not now" agreed to nothing, so there is no version of anything to record');
    assert.deepEqual(declinedFile.ids, {},
      'declining must not leave an identity behind');

    assert.equal(run.again.rerun, true, 're-analysing the flight must actually re-run');
    // Without this the assertion below cannot fail. The dialog is only ever
    // raised over an admissible flight, so a re-run that produced an
    // inadmissible one would report "not asked again" for the wrong reason and
    // would have been a test agreeing with a bug it could not see.
    assert.equal(run.again.admissible, true,
      'the re-run must leave an admissible flight on screen, or the assertion below is '
      + 'satisfied by the flight being refused rather than by the question having been asked');
    assert.equal(run.again.consentShown, false,
      'the consent dialog came back after being answered. It is asked ONCE; a dialog that '
      + 'reappears is one people learn to tap through');

    // =====================================================================
    // The panel, in the state a pilot who declined is left in
    // =====================================================================
    assert.match(run.off.panel, /Nothing is sent, and this version cannot send/,
      'every state of this panel must say plainly that nothing goes anywhere');
    assert.match(run.off.panel, /Sharing is off/, 'and must say which way the switch is set');
    assert.equal(run.off.idShown, false,
      'an identity was created for a pilot who has not opted in; off by default must mean off');
    assert.match(run.off.panel, /No sharing identity has been created/,
      'and the panel must say so rather than leaving a blank');
    assert.deepEqual(JSON.parse(run.off.file).ids, {},
      'and nothing may be written down for it');

    // =====================================================================
    // 4. the payload on screen is the real projection of a real flight
    // =====================================================================
    // Checked before it is parsed. Without this line the mutation that makes the
    // erase take the flight history with it fails here with "Unexpected end of
    // JSON input" — red, but naming nothing, and a failure that does not say
    // what broke costs the next person the hour it took to find it.
    assert.notEqual(run.erased.historyFile, '',
      'the flight history file was emptied by the sharing screen. Erasing the sharing identity '
      + 'and erasing the flights are different asks, and only one of them was made');
    const stored = JSON.parse(run.erased.historyFile).records[0];
    // The needle first. A test whose search term is empty finds nothing and
    // proves nothing, which is the defect class this repository keeps meeting.
    assert.ok(typeof stored.craftName === 'string' && stored.craftName.trim().length >= 4,
      `the stored record must carry a real craft name for this test to be able to look for it, `
      + `and it carries ${JSON.stringify(stored.craftName)}`);
    assert.ok(typeof stored.aircraftKey === 'string' && stored.aircraftKey.length > 0);

    for (const [label, payload] of [['before opting in', run.preview.payload],
      ['after opting in', run.on.payload]]) {
      assert.ok(payload.length > 200, `the payload shown ${label} must be a real record`);
      const shared = JSON.parse(payload);
      assert.equal(shared.kind, 'rotorlens-shared-flight-record',
        `the payload shown ${label} must be the shared shape, not the local one`);
      assert.ok(typeof shared.sharingId === 'string' && shared.sharingId.length > 0,
        `the payload shown ${label} must carry the identity that replaces the name`);

      const haystack = payload.toLowerCase();
      assert.ok(!haystack.includes(stored.craftName.toLowerCase()),
        `the helicopter's name reached the payload shown ${label}. People name helicopters `
        + `after themselves; that is the whole reason the shared shape is narrower`);
      assert.ok(!haystack.includes(stored.aircraftKey.toLowerCase()),
        `the aircraft key reached the payload shown ${label}; it is the name with the board `
        + 'appended and leaks exactly as much');
      assert.ok(!haystack.includes(stored.recordId.toLowerCase()),
        `the record id reached the payload shown ${label}; it carries the key, and so the name`);
      assert.ok(!/craftname|aircraftkey|recordid/i.test(payload),
        `a never-shared field name is present in the payload shown ${label}`);
      assert.doesNotMatch(payload, /\d{4}-\d{2}-\d{2}/,
        `the log's own start date reached the payload shown ${label}`);
      assert.doesNotMatch(payload, /BELL-222UT|\.bbl/i,
        `the imported file name reached the payload shown ${label}`);
      assert.doesNotMatch(payload, /latitude|longitude|GPS_home|GPS_coord/i,
        `a location field reached the payload shown ${label}`);
    }

    // Read before agreeing, which is the order that makes disagreement possible
    // — and reading it must not have created anything.
    assert.match(run.preview.text, /the sharingId below is an example/i,
      'a payload shown before opting in must say the identity in it is not a real one, or a '
      + 'pilot could write down a value that will never be used');
    assert.deepEqual(JSON.parse(run.preview.file).ids, {},
      'looking at a sample payload must not write an identity to disk');
    assert.match(run.preview.text, /auditShareableRecord/,
      'the audit must run in front of the reader, as it does before a flight is stored');

    assert.equal(run.reconsider.shown, true,
      'Share from the panel must reopen the complete terms, not record unseen consent');
    assert.equal(run.reconsider.file, run.reconsider.fileBefore,
      'opening the terms is not itself an affirmative answer and must not change the file');
    assert.match(run.reconsider.text, /keep ownership of your measurements/i);
    assert.match(run.reconsider.text,
      /including free releases and releases distributed for a fee/i,
      'the commercial-use licence must be visible before the panel can enable sharing');
    assert.equal(run.reconsiderDeclined.shown, false);
    assert.equal(run.reconsiderDeclined.focus, 'sharing-toggle',
      'declining panel-opened terms must focus the replacement panel control');
    assert.equal(run.reconsiderAgain.shown, true,
      'a later panel tap must show the terms again after declining them');
    assert.equal(run.reconsiderAgain.file, run.reconsiderDeclined.file,
      'reopening the terms must not itself change the stored answer');

    // =====================================================================
    // Switching it on: the identity appears, and it is the one in the file
    // =====================================================================
    const onFile = JSON.parse(run.on.file);
    assert.equal(run.on.focus, 'sharing-toggle',
      'accepting panel-opened terms must focus the replacement panel control');
    assert.equal(onFile.sharing, true, 'the switch must record that sharing is on');
    assert.equal(typeof onFile.termsVersion, 'string',
      'the version of the terms agreed to must be recorded with the choice, so it is '
      + 'answerable later which wording was on screen');
    const ids = Object.values(onFile.ids);
    assert.equal(ids.length, 1, 'one identity, for the one helicopter that has flights');
    assert.match(ids[0], /^[0-9abcdefghjkmnpqrstvwxyz]{5}(-[0-9abcdefghjkmnpqrstvwxyz]{5}){3}$/,
      'the identity must be the transcribable shape a pilot can copy off the screen');
    assert.equal(run.on.id, ids[0],
      'the identity ON SCREEN must be the one in the file. It is the only thing that survives '
      + 'a wiped phone, and an identity shown that is not the stored one is worse than none');
    assert.equal(JSON.parse(run.on.payload).sharingId, ids[0],
      'and the payload must carry that same identity once it exists');
    assert.match(run.on.panel, /Sharing is on/);
    assert.match(run.on.panel, /nothing has been sent, because there is nowhere to send it/i,
      'a switch that is on must still say that nothing has gone anywhere');

    // 3. The honest limit, on screen rather than buried in a document.
    assert.match(run.on.panel, /Write the identity down/,
      'the pilot must be told to write the identity down, because it is the only thing that '
      + 'survives clearing the app');
    assert.match(run.on.panel, /permanently anonymous and no longer deletable/,
      'and told plainly what clearing storage costs: records already sent stay in the '
      + 'collection and can no longer be deleted by anyone');
    assert.ok(run.on.panel.includes(ids[0]),
      'and the identity itself must be on the screen that says to write it down');

    assert.equal(run.armed.oneTap.file, run.on.file,
      'one tap must not erase anything; this WebView has no confirm() dialog, so the second '
      + 'tap is the confirmation');
    assert.match(run.armed.oneTap.label, /Tap again/,
      'and the button must say that it is armed');

    // =====================================================================
    // 5. the erase erases, and erases only what it says
    // =====================================================================
    assert.equal(run.erased.sharingFile, '',
      'erasing the identity must leave no sharing file at all. A file recording "asked, '
      + 'declined" is still a file about somebody\'s choices');
    assert.equal(run.erased.rows, 1,
      'erasing the sharing identity took the flight history with it. They are different asks, '
      + 'and a control that costs a pilot their flights is one nobody dares press');
    assert.equal(JSON.parse(run.erased.historyFile).records.length, 1,
      'and the flights must still be in the file, not merely on the screen');
    assert.match(run.erased.panel, /Sharing is off/,
      'erasing the identity must switch sharing off; leaving it on would regenerate an '
      + 'identity on the next repaint, which is a control that undoes itself');
    assert.match(run.erased.panel, /Nothing about sharing is stored on this device/,
      'and must say that nothing is left, including that the question will come back once');

    // =====================================================================
    // 6. a phone, not a desk
    // =====================================================================
    const smallest = Math.min(...run.on.controls.map(control => control.height));
    assert.ok(smallest >= 44,
      `the smallest control on the sharing panel is ${smallest}px; a thumb needs 44. `
      + `${JSON.stringify(run.on.controls)}`);
    assert.equal(run.erased.overflowX, 0,
      'the sharing panel scrolled the page sideways at 384px');

    assert.deepEqual(pageErrors, [], 'the sharing screen must run with no page errors');
    await client.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
    client.close();
  } finally {
    browser.kill('SIGKILL');
    await new Promise(resolve => browser.once('exit', resolve));
    await rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
    await new Promise(resolve => logServer.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// A DATAFLASH DUMP OPENS ONE FLIGHT, NOT ALL OF THEM
//
// This is the memory ceiling, and it is the largest crash risk in the app. The
// owner's own 125 MiB chip image holds 73 independent flights; decoding all of
// them cost 8.1 s of frozen UI and 241 MB of RSS on his handset, against an
// Android per-process cap commonly 192-256 MB. He then looks at ONE of them.
//
// Nothing already in this suite can catch a regression here. Every existing
// assertion is about a session that IS on screen, and an app that decoded all 73
// to show one would satisfy every one of them — it did, for months. What this
// test asserts is about the seventy-two that must NOT have been read:
//
//   1. every session is LISTED, from its header block alone
//   2. exactly ONE has had its frames read
//   3. an unopened session says so, rather than showing a zero — "0 samples" is
//      what a session with unreadable frames looks like, and a pilot has to be
//      able to tell those two apart
//   4. switching flights reads the new one, and switching BACK reads nothing.
//      Only a counter can prove that: a needless re-decode produces identical
//      numbers and is invisible to every other assertion on this page
//   5. the numbers the lazy path puts on screen are the eager decoder's numbers,
//      compared against a fresh eager decode of the same bytes in the same page
//   6. a decode long enough to notice SAYS how far it has got, and one too short
//      to notice says nothing at all
//   7. all of it at 384 px with 44 px controls, because that is the only screen
//      this app ships to
//
// The log is built in memory by concatenating a committed fixture: sessions are
// independent and concatenated with no separator, which is the very property
// this whole change rests on, so a dump of 320 flights is 160 copies of a
// two-session fixture. Nothing is written to disk.
//
// WHAT THIS AND THE EVICTION TEST BELOW CANNOT REACH, checked by reintroducing
// each defect and watching for a failure that never came:
//
//   - The empty-bar flash on switching BACK to a flight already read. It only
//     appears for a session over DECODE_PROGRESS_MIN_BYTES, and the largest
//     single session in fixtures/synthetic/ is 477 KiB. A fixture gap, not a
//     test gap: it needs one committed session of a few MiB.
//   - The second `sessionOpenRun` guard, after `decodeFrames()`. Nothing can
//     move that counter across one synchronous call, so removing it changes
//     nothing today. See the note on it in ui/app.mjs.
// ---------------------------------------------------------------------------

test('a dump of many flights opens the one you picked, and says so', {
  skip: chromePath ? false : 'no Chromium found; set ROTORLENS_BROWSER to a path'
}, async () => {
  const server = createUiServer();
  const port = await listen(server);
  const profile = await mkdtemp(path.join(tmpdir(), 'rotorlens-lazy-'));
  const debugPort = await freePort();

  const browser = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    'about:blank'
  ], {stdio: 'ignore'});

  try {
    const client = await connect(await waitForDevTools(debugPort));
    const {targetId} = await client.send('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await client.send('Target.attachToTarget', {targetId, flatten: true});

    const pageErrors = [];
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
    await client.send('Page.navigate', {url: `http://127.0.0.1:${port}/`}, sessionId);
    await new Promise(resolve => setTimeout(resolve, 900));

    // The screen the app ships to, before a single measurement is taken.
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 384, height: 800, deviceScaleFactor: 2, mobile: true
    }, sessionId);

    const run = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        const $ = id => document.getElementById(id);
        const options = () => [...$('session').options].map(option => option.textContent);
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

        // ---- the dump -----------------------------------------------------
        const one = new Uint8Array(await (await fetch(
          '/fixtures/synthetic/rf46-two-sessions.TXT'
        )).arrayBuffer());
        const COPIES = 160;
        const dump = new Uint8Array(one.length * COPIES);
        for (let copy = 0; copy < COPIES; copy += 1) {
          dump.set(one, copy * one.length);
        }

        // Sampled from frame callbacks, which only run BETWEEN tasks. A decode
        // holds this thread, so anything written and then decoded in the same
        // task can never be observed here — which is precisely the failure this
        // is looking for.
        let sampling = true;
        const seen = [];
        const snap = () => {
          seen.push({
            hidden: $('decode-progress').classList.contains('hidden'),
            label: $('decode-progress-label').textContent,
            width: $('decode-bar').style.width
          });
        };
        const sample = () => {
          if (!sampling) return;
          snap();
          requestAnimationFrame(sample);
        };

        const openBytes = async (bytes, name) => {
          const transfer = new DataTransfer();
          transfer.items.add(new File([bytes], name));
          const input = $('file');
          input.files = transfer.files;
          input.dispatchEvent(new Event('change'));
          for (let attempt = 0; attempt < 800; attempt += 1) {
            // Sampled from the poll loop as well as from frame callbacks. A
            // 14 KiB log settles inside a handful of frames, and a guard reading
            // "too few frames to judge" would then be the only thing the
            // no-flash section ever reported. A timeout task runs between tasks
            // exactly as a frame callback does, so it can see the same flash.
            if (sampling) snap();
            if ($('session-stats').children.length > 0
                && $('status').textContent.includes(name + ' \\u2014')) {
              return true;
            }
            await sleep(20);
          }
          return false;
        };

        // ---- 1. open the dump ---------------------------------------------
        requestAnimationFrame(sample);
        const settled = await openBytes(dump, 'DATAFLASH.BBL');
        sampling = false;

        const {state} = await import('/ui/app.mjs');
        const sessions = state.result.sessions;

        const opened = {
          settled,
          listed: $('session').options.length,
          // \`samples\` is null until a session's frames are read, and an array
          // afterwards. THIS is the assertion the whole change exists for.
          framesRead: sessions.filter(session => session.samples !== null).length,
          decodeCount: state.frameDecodeCount,
          firstOption: options()[0],
          secondOption: options()[1],
          lastOption: options()[sessions.length - 1],
          statsRendered: $('session-stats').children.length,
          // Header facts must be on the unopened ones, or the picker is blank.
          unopenedNamed: sessions.slice(1).every(
            session => Boolean(session.craftName || session.firmware.type)
          ),
          unopenedOffsets: sessions.slice(1).every(
            session => Number.isFinite(session.byteOffset)
          ),
          progressShown: seen.some(frame => !frame.hidden),
          progressLabels: [...new Set(seen.filter(f => !f.hidden).map(f => f.label))],
          // A bar that reaches the end while the work carries on is the one lie
          // the copy bar above refuses to tell, and this must refuse it too.
          fullWhileWorking: seen.some(
            frame => !frame.hidden && parseFloat(frame.width) >= 100 && frame.label !== ''
          ),
          // ...and a bar that never leaves zero is not reporting progress either.
          advanced: seen.some(
            frame => !frame.hidden && parseFloat(frame.width) > 0 && parseFloat(frame.width) < 100
          ),
          progressHiddenAtEnd: $('decode-progress').classList.contains('hidden'),
          frames: seen.length
        };

        // ---- 2. the lazy numbers are the eager numbers ---------------------
        //
        // Decoded again, in this page, the old way, and compared value by
        // value. A refactor of the decode path that is merely "tested" is not
        // enough here: every one of the four defects this decoder has shipped
        // decoded without error, held frame sync, and produced wrong numbers.
        //
        // The dump is 160 copies of a TWO-session fixture, so session i is
        // fixture session i % 2 — and the two are not the same length. That is
        // what makes this able to fail: comparing against the wrong one is a
        // mismatch, so an off-by-one anywhere between the picker and the
        // decoder shows up here rather than as a plausible screen of somebody
        // else's flight.
        const {decodeLog} = await import('/src/blackbox/decode.mjs');
        const eager = decodeLog(one).sessions;
        const compare = (a, b) => ({
          samples: a.samples.length === b.samples.length,
          everySample: a.samples.length === b.samples.length && a.samples.every((row, index) =>
            row.length === b.samples[index].length
            && row.every((value, column) => value === b.samples[index][column])),
          fields: JSON.stringify(a.fields) === JSON.stringify(b.fields),
          events: JSON.stringify(a.events) === JSON.stringify(b.events),
          gps: JSON.stringify(a.gps) === JSON.stringify(b.gps),
          intra: JSON.stringify(a.intraSampleIndices) === JSON.stringify(b.intraSampleIndices),
          counts: JSON.stringify(a.frameCounts) === JSON.stringify(b.frameCounts),
          errors: JSON.stringify(a.errors) === JSON.stringify(b.errors),
          truncated: a.truncated === b.truncated,
          reachedLogEnd: a.reachedLogEnd === b.reachedLogEnd,
          sampleCount: a.samples.length
        });

        const same = compare(eager[0], sessions[state.sessionIndex]);
        // The control on the control: if the fixture's two sessions were alike,
        // every comparison here would pass whichever one it was handed.
        same.fixtureSessionsDiffer = eager[0].samples.length !== eager[1].samples.length;
        same.shownIndex = state.sessionIndex;

        // ---- 3. switch flights, and switch back ---------------------------
        const pick = async index => {
          const picker = $('session');
          picker.value = String(index);
          picker.dispatchEvent(new Event('change'));
          for (let attempt = 0; attempt < 400; attempt += 1) {
            if (state.sessionIndex === index && state.result.sessions[index].samples !== null
                && $('session-stats').children.length > 0) {
              // The whole chain below the picker re-runs off this change; give
              // it the tick it needs before reading the screen.
              await sleep(60);
              return true;
            }
            await sleep(50);
          }
          return false;
        };

        const away = {settled: await pick(7)};
        away.decodeCount = state.frameDecodeCount;
        away.framesRead = sessions.filter(session => session.samples !== null).length;
        away.option = options()[7];
        away.stats = $('session-stats').textContent.length;
        away.shownIndex = state.sessionIndex;
        // Session 7 of the dump is the fixture's SECOND session, which is 192
        // samples against the first one's 160. Comparing it against the right
        // one is the whole point.
        away.same = compare(eager[1], sessions[state.sessionIndex]);
        away.matchesTheOtherSession = compare(eager[0], sessions[state.sessionIndex]).samples;

        const back = {settled: await pick(0)};
        back.decodeCount = state.frameDecodeCount;
        back.stats = $('session-stats').textContent.length;

        // ---- 4. taps that land on top of each other -----------------------
        //
        // Reading a flight yields before it decodes, so five taps in one task
        // put five reads in flight at once — all on flights not read before, so
        // every one of them takes the slow path. Four are obsolete before they
        // resume. An obsolete read that carries on does not read ITS flight
        // onto the screen; it reads a flight nobody asked for into memory and
        // then paints whatever the picker has since become, which at that
        // moment has no samples in it.
        const picker = $('session');
        const beforeStorm = state.frameDecodeCount;
        for (const index of [11, 12, 13, 14, 15]) {
          picker.value = String(index);
          picker.dispatchEvent(new Event('change'));
        }
        for (let attempt = 0; attempt < 600; attempt += 1) {
          if (state.sessionIndex === 15 && sessions[15].samples
              && $('session-stats').children.length > 0) {
            break;
          }
          await sleep(20);
        }
        const storm = {
          shownIndex: state.sessionIndex,
          decodes: state.frameDecodeCount - beforeStorm,
          rendered: $('session-stats').textContent.length,
          // 15 is odd, so it is the fixture's SECOND session.
          same: sessions[15].samples ? compare(eager[1], sessions[15]) : {everySample: false}
        };

        // ---- 5. a small log must not flash a bar --------------------------
        sampling = true;
        seen.length = 0;
        requestAnimationFrame(sample);
        const smallSettled = await openBytes(one, 'SMALL.BBL');
        sampling = false;
        const small = {
          settled: smallSettled,
          everShown: seen.some(frame => !frame.hidden),
          frames: seen.length,
          listed: $('session').options.length,
          decodeCount: state.frameDecodeCount
        };

        // ---- 5. a phone, not a desk ---------------------------------------
        const controls = [...document.querySelectorAll(
          '#session-panel select, #session-panel button, #status-panel button'
        )].map(el => ({
          id: el.id || el.tagName.toLowerCase(),
          height: Math.round(el.getBoundingClientRect().height)
        }));
        const overflowX = document.documentElement.scrollWidth
          - document.documentElement.clientWidth;

        return JSON.stringify({opened, same, away, back, storm, small, controls, overflowX});
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    assert.equal(run.exceptionDetails, undefined,
      `opening a many-session dump threw: ${JSON.stringify(run.exceptionDetails)}`);

    const {opened, same, away, back, storm, small, controls, overflowX} =
      JSON.parse(run.result.value);

    // =====================================================================
    // 1. every flight listed, ONE flight read
    // =====================================================================
    assert.equal(opened.settled, true,
      'the dump never finished opening, so nothing below this means anything');
    assert.equal(opened.listed, 320,
      `160 copies of a two-session fixture is 320 flights; the picker offered ${opened.listed}`);

    // THE assertion of this file. 241 MB of RSS and 8.1 s of frozen UI came from
    // this number being 320 rather than 1.
    assert.equal(opened.framesRead, 1,
      `${opened.framesRead} of 320 sessions had their frames read to show one. `
      + 'That is the 241 MB and the 8.1 s freeze, back again');
    assert.equal(opened.decodeCount, 1,
      `the decoder was run ${opened.decodeCount} times to open one flight`);
    assert.ok(opened.statsRendered > 0,
      'the session that WAS opened has to render, or this is measuring a broken page');

    // =====================================================================
    // 2. an unopened flight is described, not blanked and not zeroed
    // =====================================================================
    assert.match(opened.firstOption, /samples/,
      `the opened session must quote its sample count: ${opened.firstOption}`);
    // "0 samples" is what a session whose frames are unreadable looks like. A
    // pilot must be able to tell that from one nobody has opened yet.
    assert.match(opened.secondOption, /not opened yet/,
      `an unopened session must say so rather than show a count it has not `
      + `measured: ${opened.secondOption}`);
    assert.doesNotMatch(opened.secondOption, /\d+ samples/,
      `an unopened session must not quote a sample count: ${opened.secondOption}`);
    assert.match(opened.secondOption, /KiB|MiB|B,/,
      `an unopened session must still say how big it is — the byte span is exact `
      + `from the header: ${opened.secondOption}`);
    assert.equal(opened.unopenedNamed, true,
      'every unopened session must carry its craft or firmware name from its header block');
    assert.equal(opened.unopenedOffsets, true,
      'every unopened session must carry its byte offset; sessionEndOffset reads the NEXT '
      + 'session\'s offset to judge the integrity of this one, and it must not have to '
      + 'decode it to get it');

    // =====================================================================
    // 3. the lazy numbers are the eager numbers
    // =====================================================================
    assert.ok(same.sampleCount > 0, 'the fixture must actually carry samples');
    // Without this, every comparison below would pass whichever of the two
    // fixture sessions it was handed, and would prove nothing about indexing.
    assert.equal(same.fixtureSessionsDiffer, true,
      'the two sessions in rf46-two-sessions.TXT are the same length, so comparing the '
      + 'wrong one would still pass and this whole section is inert');
    assert.equal(same.shownIndex, 0, 'the first session of the dump must be the one shown');
    assert.equal(same.samples, true, 'lazy and eager disagreed on the sample count');
    assert.equal(same.everySample, true,
      'a sample decoded lazily differs from the same sample decoded eagerly. Every one of '
      + 'the four decoder defects this repo has shipped decoded without error and held '
      + 'frame sync; only the numbers were wrong');
    for (const key of ['fields', 'events', 'gps', 'intra', 'counts', 'errors',
      'truncated', 'reachedLogEnd']) {
      assert.equal(same[key], true, `lazy and eager disagreed on ${key}`);
    }

    // =====================================================================
    // 4. switching flights, and switching back
    // =====================================================================
    assert.equal(away.settled, true, 'switching to session 8 never settled');
    assert.equal(away.decodeCount, 2,
      `switching flights must read exactly one more session; the decoder ran `
      + `${away.decodeCount} times in total`);
    assert.equal(away.framesRead, 2,
      `${away.framesRead} sessions are decoded after opening two. Anything more means the `
      + 'picker is decoding sessions nobody asked for');
    assert.match(away.option, /samples/,
      `the newly opened session's option must stop saying "not opened yet": ${away.option}`);
    assert.ok(away.stats > 0, 'the switched-to session must render its own statistics');

    // Session 7 of the dump is the fixture's SECOND session. Reading the wrong
    // one is a screen full of somebody else's flight that looks perfectly
    // healthy — the same shape as HOME_COORD being paired by the wrong index.
    assert.equal(away.shownIndex, 7, 'the picker must show the session it was asked for');
    assert.equal(away.same.samples, true,
      `session 7 of the dump must decode to the fixture's second session `
      + `(${away.same.sampleCount} samples read)`);
    assert.equal(away.same.everySample, true,
      'session 7 of the dump decoded to values the eager decoder does not produce for the '
      + 'same bytes');
    assert.equal(away.matchesTheOtherSession, false,
      'session 7 decoded to the FIRST fixture session\'s content, so the picker and the '
      + 'decoder disagree about which flight is on screen');

    assert.equal(back.settled, true, 'switching back never settled');
    // A re-decode is invisible: same numbers, same screen, just seconds of frozen
    // UI and a second copy of the samples. Only the counter can see it.
    assert.equal(back.decodeCount, 2,
      `switching back to a session already read decoded it again — the counter went to `
      + `${back.decodeCount}. On a large flight that is seconds of frozen UI for a screen `
      + 'that was already computed');
    assert.ok(back.stats > 0, 'switching back must still render the session');

    // =====================================================================
    // 4b. five taps in one task
    //
    // A pilot mashing the picker during a two-second read is not an edge case,
    // and every one of these taps starts a read that yields before it decodes.
    // =====================================================================
    assert.equal(storm.shownIndex, 15,
      `after five taps in one task the app is showing session ${storm.shownIndex}, not the last `
      + 'one tapped');
    assert.equal(storm.decodes, 1,
      `five taps in one task read ${storm.decodes} flights. Four of them were obsolete before `
      + 'they resumed, and on a real dump each one is 6 MiB and a third of a second spent on a '
      + 'screen nobody will see');
    assert.ok(storm.rendered > 0,
      'five taps in one task left the session panel empty; every read decided it had been '
      + 'overtaken and none of them painted');
    assert.equal(storm.same.everySample, true,
      'the flight on screen after five taps in one task is not the flight those bytes decode to');

    // =====================================================================
    // 5. progress on a long decode, silence on a short one
    // =====================================================================
    assert.ok(opened.frames > 3,
      `only ${opened.frames} frames were serviced during the open, so the progress `
      + 'assertions below prove nothing');
    assert.equal(opened.progressShown, true,
      'a 2.2 MiB, 320-flight dump decoded with nothing on screen but a frozen "Decoding…". '
      + 'That silence is what the owner read as "it is broken", twice');
    assert.ok(
      opened.progressLabels.some(label => /Reading session 1 of 320/.test(label)),
      'the progress line must name the flight being read and how many there are, not just '
      + `say "working": ${JSON.stringify(opened.progressLabels)}`);
    assert.ok(
      opened.progressLabels.every(label => !label.includes('%')),
      'the decode reports steps, whose denominator it knows exactly. A percentage here '
      + `would be invented: ${JSON.stringify(opened.progressLabels)}`);
    assert.equal(opened.fullWhileWorking, false,
      'the bar reached 100% while a step was still running. It counts steps FINISHED for '
      + 'exactly this reason');
    assert.equal(opened.advanced, true,
      'the bar never moved off zero, so it reported that something was happening and '
      + 'nothing about how far it had got');
    assert.equal(opened.progressHiddenAtEnd, true,
      'the decode bar must go away when the flight is on screen, not sit at 100% under it');

    assert.equal(small.settled, true, 'the small log never opened');
    assert.ok(small.frames > 3,
      `only ${small.frames} frames were serviced opening the small log, so the no-flash `
      + 'assertion below proves nothing');
    assert.equal(small.everShown, false,
      'a 14 KiB log flashed the decode bar. A bar that appears and vanishes inside one '
      + 'blink reads as a rendering fault, not as progress — the same reason the copy bar '
      + 'waits 300 ms');
    assert.equal(small.listed, 2, 'the small log must open normally afterwards');

    // =====================================================================
    // 6. a phone, not a desk
    // =====================================================================
    const smallest = Math.min(...controls.map(control => control.height));
    assert.ok(smallest >= 44,
      `the smallest control around the session picker is ${smallest}px; a thumb needs 44. `
      + JSON.stringify(controls));
    assert.equal(overflowX, 0,
      'the session picker scrolled the page sideways at 384px. Its options carry the craft '
      + 'name, which the log chose and this app did not');

    assert.deepEqual(pageErrors, [],
      `the lazy decode path must run with no page errors: ${JSON.stringify(pageErrors)}`);

    await client.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
    client.close();
  } finally {
    browser.kill('SIGKILL');
    await new Promise(resolve => browser.once('exit', resolve));
    await rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
    await new Promise(resolve => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// KEEPING A FLIGHT IS BOUNDED, AND LETTING ONE GO PUTS IT BACK EXACTLY
//
// "Switching back must not decode again" and "the memory ceiling is the whole
// point" pull against each other, and the resolution is a budget: a flight
// already read is kept, up to DECODED_SESSION_CACHE_BYTES of them, and beyond
// that the oldest is released. Two of the big sessions from the owner's own dump
// are 220 MiB together, so an unbounded cache would reintroduce the crash this
// change exists to prevent — one session at a time instead of all 73, but over
// the cap all the same.
//
// Neither half of that can be seen from the screen. A released session and a
// kept one render identically; so do a correctly re-read session and one whose
// release left stale samples behind. What this measures instead is the DECODER'S
// own answer — `samples === null` after a release — and the sample values after
// the round trip.
//
// The dump is seven copies of a 19,400-sample fixture, which is 6.2 MiB of
// decoded flight each by the same 9 bytes-per-cell that sets the budget. Five
// fit beside the one on screen; the sixth pushes the oldest out.
// ---------------------------------------------------------------------------

test('a flight already read is kept, but only while it fits', {
  skip: chromePath ? false : 'no Chromium found; set ROTORLENS_BROWSER to a path'
}, async () => {
  const server = createUiServer();
  const port = await listen(server);
  const profile = await mkdtemp(path.join(tmpdir(), 'rotorlens-evict-'));
  const debugPort = await freePort();

  const browser = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    'about:blank'
  ], {stdio: 'ignore'});

  try {
    const client = await connect(await waitForDevTools(debugPort));
    const {targetId} = await client.send('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await client.send('Target.attachToTarget', {targetId, flatten: true});

    const pageErrors = [];
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
    await client.send('Page.navigate', {url: `http://127.0.0.1:${port}/`}, sessionId);
    await new Promise(resolve => setTimeout(resolve, 900));
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 384, height: 800, deviceScaleFactor: 2, mobile: true
    }, sessionId);

    const run = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        const $ = id => document.getElementById(id);
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

        const one = new Uint8Array(await (await fetch(
          '/fixtures/synthetic/rf46-gain-fault.TXT'
        )).arrayBuffer());
        const COPIES = 7;
        const dump = new Uint8Array(one.length * COPIES);
        for (let copy = 0; copy < COPIES; copy += 1) {
          dump.set(one, copy * one.length);
        }

        const transfer = new DataTransfer();
        transfer.items.add(new File([dump], 'BIGDUMP.BBL'));
        const input = $('file');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change'));

        const {state} = await import('/ui/app.mjs');
        for (let attempt = 0; attempt < 600; attempt += 1) {
          if (state.result && state.result.sessions[0] && state.result.sessions[0].samples) break;
          await sleep(50);
        }
        const sessions = state.result.sessions;

        // The flight as the eager decoder reads it, kept for the round trip
        // below. Taken from the single fixture, not from the dump, so it is
        // independent of anything the page has done.
        const {decodeLog} = await import('/src/blackbox/decode.mjs');
        const truth = decodeLog(one).sessions[0];

        const pick = async index => {
          const picker = $('session');
          picker.value = String(index);
          picker.dispatchEvent(new Event('change'));
          for (let attempt = 0; attempt < 600; attempt += 1) {
            if (state.sessionIndex === index && sessions[index].samples) return true;
            await sleep(50);
          }
          return false;
        };

        const held = () => sessions.filter(session => session.samples !== null).length;
        const heldBytes = () => sessions.reduce((total, session) => total
          + (session.samples ? session.samples.length * session.fields.length * 9 : 0), 0);

        // This first walk is about the ordinary decoded-session cache. An
        // analysis that is still retiring deliberately pins its session outside
        // that budget, and slower runners can otherwise make this assertion
        // sample the separate in-flight-analysis case below. Wait only for
        // analyses from sessions that are no longer on screen; the current
        // session's automatic analysis may keep running.
        const retiredAnalysesSettled = async currentIndex => {
          for (let attempt = 0; attempt < 900; attempt += 1) {
            if ([...state.analysesInFlight.keys()].every(key => key === currentIndex)) {
              return true;
            }
            await sleep(50);
          }
          return false;
        };

        const walk = [];
        for (let index = 1; index < COPIES; index += 1) {
          const settled = await pick(index);
          const retired = await retiredAnalysesSettled(index);
          walk.push({
            index,
            settled,
            retired,
            held: held(),
            heldMiB: Math.round(heldBytes() / 1048576),
            zeroStillRead: sessions[0].samples !== null,
            decodeCount: state.frameDecodeCount
          });
        }

        // Session 0 has been let go by now. Going back to it must read it again
        // and must produce the same flight, not a half-reset one.
        const returned = {settled: await pick(0)};
        returned.decodeCount = state.frameDecodeCount;
        returned.samples = sessions[0].samples.length;
        returned.truthSamples = truth.samples.length;
        returned.everySample = truth.samples.length === sessions[0].samples.length
          && truth.samples.every((row, index) =>
            row.length === sessions[0].samples[index].length
            && row.every((value, column) => value === sessions[0].samples[index][column]));
        returned.errors = JSON.stringify(truth.errors) === JSON.stringify(sessions[0].errors);
        returned.counts =
          JSON.stringify(truth.frameCounts) === JSON.stringify(sessions[0].frameCounts);
        returned.statsRendered = $('session-stats').children.length;
        returned.heldMiB = Math.round(heldBytes() / 1048576);

        // ---- mashing the picker -------------------------------------------
        //
        // Reading a flight yields before it decodes and the analysis behind it
        // runs for seconds, so a pilot who taps the picker again during either
        // has two decodes and several analyses overlapping. Everything here is
        // reachable only that way: a decode painting its flight over a newer
        // one, an analysis measuring a session whose frames have not arrived,
        // and an eviction taking the samples out from under an analysis that is
        // still reading them. All three render as a healthy page or a blank one,
        // never as a wrong number, so this section watches the invariants rather
        // than the screen.
        const picker = $('session');
        const violations = [];
        const watch = () => {
          for (const index of state.analysesInFlight.keys()) {
            if (sessions[index] && sessions[index].samples === null) {
              violations.push(index);
            }
          }
        };

        const runsBefore = state.recommendationRun;
        for (let index = 0; index < COPIES; index += 1) {
          picker.value = String(index);
          picker.dispatchEvent(new Event('change'));
          // Retirement has to be synchronous with the tap: openSession bumps
          // the run counter before its first await, so a pending analysis
          // cannot resume against a session whose frames are not in yet.
          if (state.recommendationRun <= runsBefore + index) {
            violations.push('no-retire@' + index);
          }
          watch();
          await sleep(index % 2 === 0 ? 0 : 30);
          watch();
        }

        for (let attempt = 0; attempt < 900; attempt += 1) {
          watch();
          if (state.sessionIndex === COPIES - 1
              && sessions[COPIES - 1].samples
              && state.analysesInFlight.size === 0
              && $('session-stats').children.length > 0) {
            break;
          }
          await sleep(50);
        }

        const mashed = {
          violations: [...new Set(violations)].slice(0, 10),
          shownIndex: state.sessionIndex,
          rendered: $('session-stats').textContent.length,
          heldMiB: Math.round(heldBytes() / 1048576),
          // The flight left on screen must be the last one asked for, decoded
          // to the same values as ever.
          everySample: sessions[COPIES - 1].samples
            && truth.samples.length === sessions[COPIES - 1].samples.length
            && truth.samples.every((row, index) =>
              row.every((value, column) => value === sessions[COPIES - 1].samples[index][column]))
        };

        // And again with no gap at all, which is the case that actually
        // overlaps: every one of these handlers is entered before any of them
        // resumes from its paint, so seven reads of seven different flights are
        // in flight at once and six of them are already obsolete. An obsolete
        // one that goes on to paint does not paint ITS flight — it paints
        // whatever the picker has since become, which at that moment is a
        // session with no samples in it.
        const decodesBeforeStorm = state.frameDecodeCount;
        for (let index = COPIES - 1; index >= 0; index -= 1) {
          picker.value = String(index);
          picker.dispatchEvent(new Event('change'));
          watch();
        }
        for (let attempt = 0; attempt < 900; attempt += 1) {
          watch();
          if (state.sessionIndex === 0
              && sessions[0].samples
              && state.analysesInFlight.size === 0
              && $('session-stats').children.length > 0) {
            break;
          }
          await sleep(50);
        }
        const stormed = {
          shownIndex: state.sessionIndex,
          rendered: $('session-stats').textContent.length,
          heldMiB: Math.round(heldBytes() / 1048576),
          // Seven taps, but only the last one is still wanted by the time any of
          // them can run. Every flight read for one of the other six is work the
          // pilot has already moved past, and memory held for a screen nobody
          // will see.
          decodes: state.frameDecodeCount - decodesBeforeStorm,
          everySample: sessions[0].samples
            && truth.samples.length === sessions[0].samples.length
            && truth.samples.every((row, index) =>
              row.every((value, column) => value === sessions[0].samples[index][column]))
        };

        mashed.violations = [...new Set(violations)].slice(0, 10);

        // ---- a flight an analysis is still reading -------------------------
        //
        // The watcher above can only catch this if the timing lines up, and it
        // does not: an analysis retires within a frame of the tap that retired
        // it, so an eviction pass almost never runs while one is genuinely in
        // flight. MEASURED: deleting the \`analysesInFlight\` half of the
        // eviction guard leaves every assertion above green, four runs out of
        // four. So this states the condition rather than waiting to be lucky.
        //
        // \`state.analysesInFlight\` is a live Map, exposed for exactly this. An
        // entry in it is the whole contract between an analysis and the evictor
        // — \`analysisStarted\` writes one and \`evictDecodedSessions\` reads it —
        // so putting one there is not a mock of the condition, it IS the
        // condition. That a real run writes one is asserted separately, below.
        const PROTECTED = 0;
        const settledOnProtected = await pick(PROTECTED);

        // Let the automatic analysis of this flight retire FIRST. It counts
        // down with \`(get(index) ?? 1) - 1\`, which does not care who counted
        // up — so pinning while it is still running means it deletes the pin
        // on its way out and this section silently tests nothing.
        let drained = false;
        for (let attempt = 0; attempt < 900; attempt += 1) {
          if (state.analysesInFlight.size === 0) { drained = true; break; }
          await sleep(50);
        }
        state.analysesInFlight.set(PROTECTED, 1);

        // Open every OTHER flight. Session 0 is no longer on screen and each of
        // these is ~6 MiB decoded, so the 32 MiB budget is crossed several
        // times over. Nothing but the guard is keeping session 0 now.
        //
        // While walking, watch for a REAL analysis appearing in the map on some
        // other index. The evictor honouring an entry is worth nothing if
        // nothing but this test ever writes one, and that is the half of the
        // guard that would otherwise be protecting a condition that never
        // occurs. Any key other than the one pinned here had to be put there by
        // \`analysisStarted\`.
        let sawRealRunInFlight = false;
        for (let index = 1; index < COPIES; index += 1) {
          await pick(index);
          for (const key of state.analysesInFlight.keys()) {
            if (key !== PROTECTED) sawRealRunInFlight = true;
          }
        }
        const analysed = {
          settledOnProtected,
          drained,
          stillPinned: state.analysesInFlight.has(PROTECTED),
          keptWhileReading: sessions[PROTECTED].samples !== null,
          heldMiB: Math.round(heldBytes() / 1048576)
        };

        // And it must NOT be kept for ever. The moment the analysis retires,
        // the next eviction pass has to let it go, or the guard has traded one
        // leak for another.
        state.analysesInFlight.delete(PROTECTED);

        // Every OTHER flight is pinned too — each \`pick\` above started its own
        // automatic analysis, and a pinned session is skipped before its cost
        // is counted, so while five of them are in flight the budget binds on
        // almost nothing. Wait for the page to go quiet before asking whether
        // the unpinned flight was let go.
        let quiet = false;
        for (let attempt = 0; attempt < 900; attempt += 1) {
          if (state.analysesInFlight.size === 0) { quiet = true; break; }
          await sleep(50);
        }
        await pick(COPIES - 1);
        await pick(COPIES - 2);
        analysed.quiet = quiet;
        analysed.releasedWhenDone = sessions[PROTECTED].samples === null;
        analysed.finalHeldMiB = Math.round(heldBytes() / 1048576);

        analysed.sawRealRunInFlight = sawRealRunInFlight;

        return JSON.stringify({copies: COPIES, walk, returned, mashed, stormed, analysed,
          perSessionMiB:
          Math.round(truth.samples.length * truth.fields.length * 9 / 1048576 * 10) / 10});
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    assert.equal(run.exceptionDetails, undefined,
      `walking a big dump threw: ${JSON.stringify(run.exceptionDetails)}`);

    const {walk, returned, mashed, stormed, analysed, perSessionMiB} =
      JSON.parse(run.result.value);

    // The fixture has to be big enough to cross the budget, or every assertion
    // below passes for the wrong reason.
    assert.ok(perSessionMiB >= 5,
      `each session is only ${perSessionMiB} MiB decoded, so seven of them never reach the `
      + '32 MiB budget and nothing here is being tested');
    assert.ok(walk.every(step => step.settled),
      `a session in the walk never settled: ${JSON.stringify(walk)}`);
    assert.ok(walk.every(step => step.retired),
      'an analysis from a session no longer on screen did not retire before the cache was ' +
      `measured: ${JSON.stringify(walk)}`);

    // THE bound. Without it, seven flights of the owner's dump would be held at
    // once — one at a time was the fix, and an unbounded cache undoes it.
    const worst = Math.max(...walk.map(step => step.heldMiB));
    assert.ok(worst <= 40,
      `${worst} MiB of decoded flight was held at once. The budget is 32 MiB beside the `
      + `session on screen: ${JSON.stringify(walk)}`);

    const released = walk.find(step => !step.zeroStillRead);
    assert.ok(released,
      'the first session was still held after opening all seven, so nothing was ever '
      + `released and the budget does not bind: ${JSON.stringify(walk)}`);
    assert.equal(released.index, 6,
      `the first session was released at step ${released.index}. Five 6.2 MiB flights fit `
      + 'beside the one on screen, so it is the sixth switch that should push it out');

    // And a released flight comes back whole. A release that left stale samples
    // behind, or a re-read that produced different numbers, both render as a
    // perfectly healthy screen of wrong values.
    assert.equal(returned.settled, true, 'going back to the released session never settled');
    assert.ok(returned.decodeCount > walk[walk.length - 1].decodeCount,
      'going back to a RELEASED session must read it again; it was not re-read, which '
      + 'means it was never released');
    assert.equal(returned.samples, returned.truthSamples,
      `a re-read session came back with ${returned.samples} samples instead of `
      + `${returned.truthSamples}`);
    assert.equal(returned.everySample, true,
      'a session released and read again does not decode to the same values. That is a '
      + 'screen of wrong numbers with nothing on it to say so');
    assert.equal(returned.errors, true, 'a re-read session came back with different errors');
    assert.equal(returned.counts, true, 'a re-read session came back with different frame counts');
    assert.ok(returned.statsRendered > 0, 'and it has to render');

    // =====================================================================
    // mashing the picker
    //
    // The three races below all come from the same thing: reading a flight
    // yields, and `releaseFrames` empties a session object IN PLACE, so anything
    // still holding that object across an await reads `null.length`. On a phone
    // that is a blank screen with no error on it anywhere.
    // =====================================================================
    assert.deepEqual(mashed.violations, [],
      'switching flights while work was still running broke an invariant. '
      + 'A number means a session was RELEASED while an analysis was still reading it; '
      + '"no-retire@N" means the pending analysis was not retired when the picker moved, '
      + 'so it went on to measure a session whose frames had not arrived yet');
    assert.equal(mashed.shownIndex, 6,
      `after mashing the picker the app is showing session ${mashed.shownIndex}, not the last `
      + 'one asked for');
    assert.ok(mashed.rendered > 0,
      'mashing the picker left the session panel empty; an overtaken decode returned without '
      + 'the one that won ever painting');
    assert.equal(mashed.everySample, true,
      'the flight left on screen after mashing the picker is not the flight those bytes '
      + 'decode to');
    assert.ok(mashed.heldMiB <= 40,
      `${mashed.heldMiB} MiB was held after mashing the picker; overlapping decodes must not `
      + 'each keep their own flight');

    // Seven taps in one task. Six of the reads they start are obsolete before
    // they resume, and an obsolete read that paints does not paint its own
    // flight — it paints whatever the picker has since become, which at that
    // moment has no samples in it.
    assert.equal(stormed.shownIndex, 0,
      `after seven taps in one task the app is showing session ${stormed.shownIndex}, not the `
      + 'last one tapped');
    assert.ok(stormed.rendered > 0,
      'seven taps in one task left the session panel empty; every read decided it had been '
      + 'overtaken and none of them painted');
    assert.equal(stormed.everySample, true,
      'the flight on screen after seven taps in one task is not the flight those bytes '
      + 'decode to');
    assert.ok(stormed.heldMiB <= 40,
      `${stormed.heldMiB} MiB was held after seven overlapping reads; each one keeping its `
      + 'own flight is the ceiling this change exists to stay under');
    // Only the last tap is still wanted by the time any of them can run. Reading
    // the six flights the pilot has already moved past costs 6.2 MiB and a third
    // of a second each, for screens nobody will see.
    assert.ok(stormed.decodes <= 2,
      `seven taps in one task read ${stormed.decodes} flights. A read that has been overtaken `
      + 'before it starts must not start');

    // =====================================================================
    // a flight an analysis is still reading
    //
    // `releaseFrames` empties the session object IN PLACE, so an analysis
    // holding that object across an await finds its samples become null
    // underneath it — `Cannot read properties of null (reading 'length')`, and
    // a blank screen on a phone. `evictDecodedSessions` refuses to release a
    // session listed in `state.analysesInFlight` for that reason.
    //
    // The invariant watcher above cannot reach this on its own: an analysis
    // retires within a frame of the tap that retired it, so an eviction pass
    // essentially never runs while one is in flight. Deleting the guard leaves
    // every assertion above green — four runs out of four. These two do not.
    // =====================================================================
    // The setup has to have held, or the two assertions after it are vacuous.
    assert.equal(analysed.settledOnProtected, true, 'the pinned flight never opened');
    assert.equal(analysed.drained, true,
      'the automatic analysis never retired, so the pin below was placed on top of a live '
      + 'count and would be deleted by it rather than honoured');
    assert.equal(analysed.stillPinned, true,
      'the pin was gone by the end of the walk, so nothing asked the evictor to honour it');
    assert.equal(analysed.keptWhileReading, true,
      'a flight was released while an analysis was still reading it. The analysis holds that '
      + 'session object across its awaits and releaseFrames empties it IN PLACE, so the next '
      + 'thing it touches is null — a blank screen with no error on it');
    assert.ok(analysed.heldMiB <= 46,
      `${analysed.heldMiB} MiB was held while one flight was pinned by an analysis. The pin `
      + 'must protect ONE session, not suspend the budget');
    assert.equal(analysed.quiet, true, 'the page never went quiet, so the check below is not '
      + 'about the pin at all — every other flight was still pinned by its own analysis');
    assert.equal(analysed.releasedWhenDone, true,
      'a flight pinned by an analysis was still held after the analysis finished, so the '
      + `guard has traded a crash for a leak: ${JSON.stringify(analysed)}`);

    // Anti-vacuity for the pair above: the evictor honouring an entry in the
    // map is worth nothing if a real analysis never writes one.
    assert.equal(analysed.sawRealRunInFlight, true,
      'no analysis this test did not write itself ever appeared in state.analysesInFlight, '
      + 'so the guard above protects a condition nothing in the app ever creates');

    assert.deepEqual(pageErrors, [],
      `releasing and re-reading sessions must run with no page errors: ${JSON.stringify(pageErrors)}`);

    await client.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
    client.close();
  } finally {
    browser.kill('SIGKILL');
    await new Promise(resolve => browser.once('exit', resolve));
    await rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
    await new Promise(resolve => server.close(resolve));
  }
});
