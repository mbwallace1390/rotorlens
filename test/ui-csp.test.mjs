/**
 * The viewer's Content-Security-Policy: strict, and still not in the way.
 *
 * The shell declares its policy in a `<meta http-equiv>` rather than a response
 * header because it has three hosts and only one of them is a web server we
 * write: tools/serve-ui.mjs on a desktop, AssetServer on Android
 * (https://appassets.rotorlens.app) and the WKURLSchemeHandler on iOS
 * (rotorlens-app://app). A meta policy travels inside index.html, so every host
 * enforces the same one without three copies drifting apart.
 *
 * The policy exists for one reason above the usual ones. Without INTERNET on
 * Android the app cannot upload a flight; iOS has no such permission gate, so
 * on iOS the guarantee is only as good as the code. `connect-src 'self'` makes
 * the page itself refuse to talk to any other origin, whatever a future change
 * or an injected string tries — and the imported log is served from the page's
 * own origin on both phones, so 'self' is all it needs.
 *
 * Two halves, because a strict policy has two ways to be wrong:
 *
 *   1. Static: the declared policy is the strict one, and it sits before
 *      anything it governs. A meta policy applies only to what follows it, so
 *      one placed after the <style> block silently does not cover it. Runs
 *      without a browser.
 *   2. Live: a real Chromium loads the shell, opens a real fixture through the
 *      real file input AND through the native host bridge, pulls in both lazy
 *      modules, and must record ZERO violations. Then the same page must refuse
 *      a remote fetch, a remote WebSocket, a remote image, an inline script and
 *      eval — each with a violation event, and the remote ones without the
 *      request ever reaching the network.
 *
 * Why style-src carries 'unsafe-inline': the shell's own <style> block and
 * dozens of `style="…"` attributes written by ui/app.mjs and ui/legal.mjs into
 * innerHTML. A hash cannot cover attributes, and when a hash is present
 * 'unsafe-inline' is ignored, so the two cannot be mixed. Script is the
 * dangerous half and script stays 'self' only.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createUiServer} from '../tools/serve-ui.mjs';

const SHELL = fileURLToPath(new URL('../ui/index.html', import.meta.url));

/** A host that must never be reached. Reserved by RFC 2606, so even a leak goes nowhere. */
const REMOTE = 'https://csp-probe.example.com';

/** The directives the shell must declare, exactly. */
const EXPECTED_POLICY = {
  'default-src': ["'none'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'connect-src': ["'self'"],
  'img-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"]
};

function parsePolicy(text) {
  const policy = {};
  for (const part of text.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) {
      policy[name.toLowerCase()] = sources;
    }
  }
  return policy;
}

/** The CSP meta element's content, its index in <head>, and what precedes it. */
function readShellPolicy(html) {
  const head = html.slice(0, html.indexOf('</head>'));
  const pattern = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*>/gi;
  const matches = [...head.matchAll(pattern)];
  return {
    count: matches.length,
    content: matches[0]?.[1] ?? null,
    before: matches[0] ? head.slice(0, matches[0].index) : ''
  };
}

test('the shell declares the strict policy, before anything it governs', async () => {
  const html = await readFile(SHELL, 'utf8');
  const {count, content, before} = readShellPolicy(html);

  assert.equal(count, 1, 'ui/index.html must declare exactly one CSP meta element in <head>');
  assert.deepEqual(parsePolicy(content), EXPECTED_POLICY,
    `the declared policy is not the strict one: ${content}`);

  // A meta policy governs only what is parsed after it.
  assert.doesNotMatch(before, /<(style|script|link)\b/i,
    'the CSP meta must come before every <style>, <script> and <link>');

  // Nothing in the shell may need what the policy forbids.
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i,
    'an inline <script> would be blocked by script-src \'self\'');
  assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i,
    'an inline event handler attribute would be blocked by script-src \'self\'');
  assert.doesNotMatch(html, /href\s*=\s*["']\s*javascript:/i,
    'a javascript: URL would be blocked by script-src \'self\'');
});

// ---------------------------------------------------------------------------
// The live half. Helpers are copied from test/ui-browser.test.mjs on purpose:
// test files do not import each other.

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

/** Returns once the shell has loaded AND ui/app.mjs has finished running. */
async function waitForShell(client, sessionId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = 'nothing evaluated yet';
  while (Date.now() < deadline) {
    let probe;
    try {
      probe = await client.send('Runtime.evaluate', {
        expression: `(async () => {
          if (location.pathname !== '/ui/' || document.readyState !== 'complete') {
            return location.href + ' (' + document.readyState + ')';
          }
          const app = await import('/ui/app.mjs');
          return typeof app.openFile === 'function' && document.getElementById('file')
            ? 'ready'
            : 'loaded without a wired file input';
        })()`,
        awaitPromise: true,
        returnByValue: true
      }, sessionId);
    } catch (error) {
      lastSeen = error.message;
      await new Promise(resolve => setTimeout(resolve, 50));
      continue;
    }
    if (probe.exceptionDetails) {
      throw new Error('the shell loaded but ui/app.mjs failed: '
        + (probe.exceptionDetails.exception?.description ?? probe.exceptionDetails.text));
    }
    if (probe.result.value === 'ready') {
      return;
    }
    lastSeen = probe.result.value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`the shell never became ready to take a file; last seen: ${lastSeen}`);
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
 * Installed before any document script runs, so a violation raised while the
 * shell is still parsing is caught too. Capture phase on window: element-level
 * violations (a style attribute) are dispatched at the element and bubble.
 */
const VIOLATION_RECORDER = `(() => {
  const seen = [];
  globalThis.__cspViolations = seen;
  addEventListener('securitypolicyviolation', event => {
    seen.push({
      directive: event.effectiveDirective || event.violatedDirective,
      blocked: String(event.blockedURI || ''),
      source: String(event.sourceFile || ''),
      line: event.lineNumber,
      sample: String(event.sample || '')
    });
  }, true);
})();`;

const VIOLATIONS = 'JSON.stringify(globalThis.__cspViolations ?? null)';

test('the policy blocks nothing the viewer does, and blocks the network and inline code', {
  skip: chromePath ? false : 'no Chromium found; set ROTORLENS_BROWSER to a path'
}, async () => {
  const server = createUiServer();
  const port = await listen(server);
  const debugPort = await freePort();
  const profile = await mkdtemp(path.join(tmpdir(), 'rotorlens-csp-'));

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
    // Chromium also reports each violation to the console. Collected as a
    // second witness: the event listener could in principle miss one raised
    // before it was attached; the console cannot.
    const consoleCsp = [];
    // Any request to the remote host that reaches the network layer. CSP
    // refuses in the renderer, before interception, so this must stay empty.
    const leaked = [];

    client.on(message => {
      if (message.sessionId !== sessionId) {
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        pageErrors.push(
          message.params.exceptionDetails.exception?.description
          ?? message.params.exceptionDetails.text
        );
      }
      if (message.method === 'Log.entryAdded'
        && /Content Security Policy/i.test(message.params.entry.text)) {
        consoleCsp.push(message.params.entry.text);
      }
      if (message.method === 'Runtime.consoleAPICalled'
        || message.method === 'Runtime.exceptionThrown') {
        const text = JSON.stringify(message.params);
        if (/Content Security Policy/i.test(text)) {
          consoleCsp.push(text.slice(0, 400));
        }
      }
      if (message.method === 'Fetch.requestPaused') {
        leaked.push(message.params.request.url);
        client.send('Fetch.failRequest', {
          requestId: message.params.requestId,
          errorReason: 'BlockedByClient'
        }, sessionId).catch(() => { /* the page may already be gone */ });
      }
    });

    await client.send('Runtime.enable', {}, sessionId);
    await client.send('Page.enable', {}, sessionId);
    await client.send('Log.enable', {}, sessionId);
    await client.send('Fetch.enable', {
      patterns: [{urlPattern: `${REMOTE}/*`, requestStage: 'Request'}]
    }, sessionId);
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: VIOLATION_RECORDER
    }, sessionId);

    await client.send('Page.navigate', {url: `http://127.0.0.1:${port}/ui/`}, sessionId);
    await waitForShell(client, sessionId);

    const evaluate = async expression => {
      const outcome = await client.send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true
      }, sessionId);
      assert.equal(outcome.exceptionDetails, undefined,
        `the page threw: ${JSON.stringify(outcome.exceptionDetails)}`);
      return JSON.parse(outcome.result.value);
    };

    // The control. Every assertion below about "zero violations" is also what
    // a page with no policy at all would produce, so prove one is in force.
    const enforced = await evaluate(`JSON.stringify({
      recorder: Array.isArray(globalThis.__cspViolations),
      meta: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null
    })`);
    assert.equal(enforced.recorder, true, 'the violation recorder never installed');
    assert.ok(enforced.meta, 'the loaded shell carries no CSP meta element');

    // 1. A real fixture through the real file input — FileReader, the decoder,
    //    every panel's first paint and the lazily imported advisor.
    const viaInput = await evaluate(`(async () => {
      const bytes = await (await fetch('/fixtures/synthetic/rf46-two-sessions.TXT')).arrayBuffer();
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'CSP-INPUT.BBL'));
      const input = document.getElementById('file');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change'));

      const box = document.getElementById('recommend');
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (box.textContent && !box.textContent.includes('Working out what this flight')) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return JSON.stringify({
        status: document.getElementById('status').textContent,
        recommend: box.textContent,
        advisorFetched: performance.getEntriesByType('resource')
          .some(entry => new URL(entry.name).pathname === '/src/analysis/recommendations.mjs')
      });
    })()`);
    assert.match(viaInput.status, /CSP-INPUT\.BBL/, 'the file-input open never painted');
    assert.equal(viaInput.advisorFetched, true, 'the advisor module was never imported');
    assert.doesNotMatch(viaInput.recommend, /could not be run|Working out what this flight/,
      `the analysis did not finish under the policy: ${viaInput.recommend.slice(0, 300)}`);

    // 2. The same through the native host bridge: a fetch of a same-origin URL,
    //    which is exactly what Android and iOS hand the page.
    const viaHost = await evaluate(`(async () => {
      window.dispatchEvent(new CustomEvent('rotorlens-file', {detail: {
        name: 'CSP-HOST.BBL', url: '/fixtures/synthetic/rf46-two-sessions.TXT'
      }}));
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (document.getElementById('status').textContent.includes('CSP-HOST.BBL —')) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return JSON.stringify({status: document.getElementById('status').textContent});
    })()`);
    assert.match(viaHost.status, /CSP-HOST\.BBL —/,
      `the host-bridge open never finished: ${viaHost.status.slice(0, 300)}`);

    // 3. About & Legal: the other lazy module, rendered through innerHTML full
    //    of style attributes.
    const legal = await evaluate(`(async () => {
      document.getElementById('legal-toggle').click();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (document.getElementById('legal-mpl')) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return JSON.stringify({
        mplChars: document.getElementById('legal-mpl')?.textContent.length ?? 0,
        text: document.getElementById('legal').textContent.slice(0, 2000)
      });
    })()`);
    assert.ok(legal.mplChars > 16000, `the licence text did not render (${legal.mplChars})`);
    assert.doesNotMatch(legal.text, /could not be loaded/);

    // Let anything asynchronous the panels kicked off settle, then read.
    await new Promise(resolve => setTimeout(resolve, 300));
    const clean = await evaluate(VIOLATIONS);
    assert.deepEqual(clean, [],
      `the policy blocked something the viewer does: ${JSON.stringify(clean, null, 2)}`);
    assert.deepEqual(consoleCsp, [],
      `Chromium reported a CSP violation: ${consoleCsp.join('\n')}`);
    assert.deepEqual(pageErrors, [], `the page threw under the policy: ${pageErrors.join('\n')}`);

    // 4. Now the things the policy exists to stop.
    const probes = await evaluate(`(async () => {
      const outcome = {};

      try {
        await fetch('${REMOTE}/flight-upload', {method: 'POST', body: 'x'});
        outcome.fetch = 'sent';
      } catch (error) {
        outcome.fetch = error.name;
      }

      outcome.socket = await new Promise(resolve => {
        try {
          const socket = new WebSocket('${REMOTE.replace('https', 'wss')}/live');
          socket.onopen = () => resolve('open');
          socket.onerror = () => resolve('error');
          setTimeout(() => resolve('timeout'), 3000);
        } catch (error) {
          resolve(error.name);
        }
      });

      outcome.image = await new Promise(resolve => {
        const image = new Image();
        image.onload = () => resolve('loaded');
        image.onerror = () => resolve('error');
        image.src = '${REMOTE}/pixel.png';
        setTimeout(() => resolve('timeout'), 3000);
      });

      globalThis.__inlineRan = false;
      const inline = document.createElement('script');
      inline.textContent = 'globalThis.__inlineRan = true;';
      document.body.append(inline);
      inline.remove();
      outcome.inlineRan = globalThis.__inlineRan;

      try {
        outcome.eval = eval('1 + 1');
      } catch (error) {
        outcome.eval = error.name;
      }

      await new Promise(resolve => setTimeout(resolve, 200));
      outcome.violations = globalThis.__cspViolations;
      return JSON.stringify(outcome);
    })()`);

    assert.equal(probes.fetch, 'TypeError', 'a remote fetch was not refused');
    assert.notEqual(probes.socket, 'open', 'a remote WebSocket opened');
    assert.equal(probes.image, 'error', 'a remote image was not refused');
    assert.equal(probes.inlineRan, false, 'an inline script ran');
    assert.equal(probes.eval, 'EvalError', 'eval was not refused');

    const directives = probes.violations.map(entry => entry.directive);
    const remote = probes.violations.filter(entry => entry.blocked.includes('csp-probe.example.com'));
    assert.ok(remote.some(entry => entry.directive === 'connect-src'
        && entry.blocked.startsWith('https:')),
      `the remote fetch raised no connect-src violation: ${JSON.stringify(probes.violations)}`);
    assert.ok(remote.some(entry => entry.directive === 'connect-src'
        && entry.blocked.startsWith('wss:')),
      `the remote WebSocket raised no connect-src violation: ${JSON.stringify(probes.violations)}`);
    assert.ok(remote.some(entry => entry.directive === 'img-src'),
      `the remote image raised no img-src violation: ${JSON.stringify(probes.violations)}`);
    assert.ok(directives.filter(name => name === 'script-src-elem' || name === 'script-src')
      .length >= 2, `inline script and eval raised no script-src violations: ${directives}`);

    // And none of it reached the network: refused in the renderer, not by
    // failing to resolve a hostname.
    assert.deepEqual(leaked, [], `requests to ${REMOTE} reached the network layer`);
  } finally {
    client?.close();
    browser.kill();
    await new Promise(resolve => server.close(resolve));
    await rm(profile, {recursive: true, force: true}).catch(() => {});
  }
});
