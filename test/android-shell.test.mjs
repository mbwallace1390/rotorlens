/**
 * The Android shell's declarations, checked against what they are for.
 *
 * The Java in android/ cannot run under `npm test`, and its JVM tests cannot
 * reach the manifest, the platform's intent matching, or the page's own data. So
 * this file checks the parts that are data:
 *
 *   - "Open in RotorLens" must be offered for log names that contain a dot
 *     before the extension, which the old filter silently refused;
 *   - the configuration changes the activity handles itself must cover the ones
 *     that used to recreate it and delete the open log;
 *   - the links the shell will hand to the browser must be exactly the links
 *     About & Legal can render;
 *   - a dead renderer must be answered, and never by re-offering the log;
 *   - every failure reason the shell can send must have its own words on the
 *     page, rather than falling through to text about something else.
 *
 * What it cannot check is anything a phone decides at runtime. Those checks are
 * listed in android/README.md and remain device checks.
 */

import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

import {LEGAL} from '../ui/legal-data.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => readFile(path.join(projectRoot, relative), 'utf8');
const javaSource = name => read(`android/app/src/main/java/app/rotorlens/${name}`);

const withoutXmlComments = xml => xml.replace(/<!--[\s\S]*?-->/g, '');

/**
 * Java with its comments removed and its string literals intact.
 *
 * Comments are where the rules below are explained, so they must not satisfy
 * the checks. A naive `//` strip would also cut every "https://" literal in
 * half, which is how an allowlist check reads an empty list and passes.
 */
function withoutJavaComments(source) {
  let code = '';
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"' || character === '\'') {
      const start = index;
      for (index++; index < source.length && source[index] !== character; index++) {
        if (source[index] === '\\') {
          index++;
        }
      }
      code += source.slice(start, index + 1);
    } else if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') {
        index++;
      }
      code += '\n';
    } else if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 1;
    } else {
      code += character;
    }
  }
  return code;
}

// ---------------------------------------------------------------------------
// Intent-filter path matching
// ---------------------------------------------------------------------------

/**
 * An attribute value as aapt2 compiles it: `\\` in the XML is one backslash.
 * Any other escape is outside what this file models, so it fails loudly.
 */
function compiledAttribute(raw) {
  const value = raw
    .replace(/&quot;/g, '"').replace(/&apos;/g, '\'')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  let compiled = '';
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== '\\') {
      compiled += value[index];
      continue;
    }
    assert.equal(value[index + 1], '\\',
      `unmodelled escape in manifest attribute ${JSON.stringify(raw)}`);
    compiled += '\\';
    index++;
  }
  return compiled;
}

/**
 * Splits a PATTERN_SIMPLE_GLOB into the only two token kinds this manifest uses:
 * `.*` and a literal character (a `\.` is a literal dot).
 *
 * The platform's glob has more (`x*` runs, a bare `.` matching anything), but a
 * model of features nobody uses is a model nobody has checked, so a pattern
 * using them is rejected here rather than guessed at.
 */
function globTokens(pattern) {
  const tokens = [];
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '\\') {
      assert.ok(index + 1 < pattern.length, `dangling escape in ${pattern}`);
      tokens.push({literal: pattern[index + 1]});
      index++;
    } else if (character === '.' && pattern[index + 1] === '*') {
      tokens.push({wild: true});
      index++;
    } else {
      assert.ok(character !== '.' && character !== '*',
        `${pattern} uses glob syntax this test does not model`);
      tokens.push({literal: character});
    }
  }
  tokens.forEach((token, index) => {
    if (token.wild) {
      assert.ok(!tokens[index + 1]?.wild, `${pattern} has two wildcards in a row`);
    }
  });
  return tokens;
}

/**
 * Android's simple glob, for the subset above.
 *
 * The property that matters: `.*` does not backtrack. It consumes up to the
 * FIRST occurrence of the literal that follows it and commits to that, so
 * `.*\.bbl` fails on `LOG00012.bak.bbl` — it stops at the first dot and then
 * finds `bak` where it needed `bbl`. Every name with a dot before the extension,
 * and every path with a dot in a folder name, was refused that way.
 *
 * Checked against the platform's own PatternMatcher.matchGlobPattern (Android
 * 36.1 sources) over every pattern in this manifest and many thousands of
 * generated paths, with no disagreement, before it was trusted here.
 */
function globMatches(pattern, input) {
  const tokens = globTokens(pattern);
  let at = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.wild) {
      const next = tokens[index + 1];
      if (!next) {
        return true;
      }
      const found = input.indexOf(next.literal, at);
      if (found < 0) {
        return false;
      }
      at = found + 1;
      index++;
    } else {
      if (input[at] !== token.literal) {
        return false;
      }
      at++;
    }
  }
  return at === input.length;
}

/** The path rules of every VIEW filter on MainActivity. */
async function viewFilters() {
  const manifest = withoutXmlComments(await read('android/app/src/main/AndroidManifest.xml'));
  const activity = manifest.match(
    /<activity\b[^>]*android:name="\.MainActivity"[\s\S]*?<\/activity>/
  )?.[0];
  assert.ok(activity, 'MainActivity must be declared');

  const filters = [...activity.matchAll(/<intent-filter\b[\s\S]*?<\/intent-filter>/g)]
    .map(match => match[0])
    .filter(filter => filter.includes('"android.intent.action.VIEW"'));
  assert.equal(filters.length, 2, 'one typed and one typeless VIEW filter');

  return filters.map(filter => {
    const values = attribute => [...filter.matchAll(
      new RegExp(`android:${attribute}="([^"]*)"`, 'g')
    )].map(match => compiledAttribute(match[1]));
    return {
      typed: values('mimeType').length > 0,
      patterns: values('pathPattern'),
      suffixes: values('pathSuffix')
    };
  });
}

/**
 * Whether a filter's path rules accept a decoded Uri path.
 *
 * pathSuffix exists from API 31. Before that the platform ignores the attribute
 * and only the patterns can match, which is why both are modelled.
 */
function acceptsPath(filter, input, {api}) {
  return filter.patterns.some(pattern => globMatches(pattern, input))
    || (api >= 31 && filter.suffixes.some(suffix => input.endsWith(suffix)));
}

const EXTENSIONS = ['bbl', 'BBL', 'bfl', 'BFL', 'txt', 'TXT', 'log', 'LOG'];

/** Decoded paths, as IntentFilter sees them, with the number of dots in each. */
function logPaths(extension) {
  return [
    `/document/primary:LOG00012.${extension}`,
    `/storage/emulated/0/Download/LOG00012.bak.${extension}`,
    `/document/primary:Download/flight.2026.${extension}`,
    `/document/primary:Download/Rotorflight 4.6/BTFL_LOG.${extension}`,
    `/document/primary:Download/RF 4.6.0/btfl.001.${extension}`,
    `/document/1A2B-3C4D:Logs/v4.6.0/2026.10.03/LOG00007.copy.${extension}`
  ].map(input => ({input, dots: [...input].filter(character => character === '.').length}));
}

const NOT_LOGS = [
  '/document/primary:Download/photo.jpg',
  '/document/primary:Download/LOG00012.bbl.jpg',
  '/document/primary:Download/archive.bbl.zip',
  '/document/primary:Download/LOG00012.bbl.part',
  '/document/primary:Download/bbl',
  '/document/primary:Download/notes.md',
  '/document/msf:1234',
  '/document/primary:Download/Rotorflight 4.6/readme.pdf'
];

test('the glob model reproduces the failure it was written to catch', () => {
  // The old filter, verbatim. If the model ever stops refusing this, it has
  // stopped modelling Android and the assertions below prove nothing.
  assert.equal(globMatches('.*\\.bbl', '/x/LOG00012.bbl'), true);
  assert.equal(globMatches('.*\\.bbl', '/x/LOG00012.bak.bbl'), false);
  assert.equal(globMatches('.*\\.bbl', '/x/Rotorflight 4.6/LOG.bbl'), false);
  assert.equal(globMatches('.*\\..*\\.bbl', '/x/LOG00012.bak.bbl'), true);
  assert.equal(globMatches('.*\\.bbl', '/x/LOG.bbl.zip'), false);
  assert.throws(() => globTokens('a*b'), /does not model/);
});

test('both VIEW filters accept exactly the same paths', async () => {
  const [first, second] = await viewFilters();
  assert.notEqual(first.typed, second.typed, 'one filter is typed and one typeless');
  assert.deepEqual([...first.patterns].sort(), [...second.patterns].sort());
  assert.deepEqual([...first.suffixes].sort(), [...second.suffixes].sort());
});

test('Open in RotorLens is offered for log names with dots before the extension', async () => {
  for (const filter of await viewFilters()) {
    const kind = filter.typed ? 'typed' : 'typeless';
    for (const extension of EXTENSIONS) {
      assert.ok(filter.suffixes.includes(`.${extension}`),
        `the ${kind} VIEW filter needs pathSuffix ".${extension}" for Android 12+`);

      for (const {input, dots} of logPaths(extension)) {
        assert.ok(acceptsPath(filter, input, {api: 31}),
          `Android 12+: the ${kind} filter refuses ${input}`);
        if (dots <= 4) {
          assert.ok(acceptsPath(filter, input, {api: 26}),
            `Android 8-11: the ${kind} filter refuses ${input} (${dots} dots)`);
        }
      }
    }
  }
});

test('Open in RotorLens is not offered for files that are not logs', async () => {
  for (const filter of await viewFilters()) {
    for (const input of NOT_LOGS) {
      for (const api of [26, 31]) {
        assert.equal(acceptsPath(filter, input, {api}), false,
          `API ${api}: ${input} must not be offered to RotorLens`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Configuration changes
// ---------------------------------------------------------------------------

test('resizing, folding, display size, font size and locale do not recreate the viewer', async () => {
  // Recreation runs onDestroy, which unlinks the open log, and builds an empty
  // viewer. For a log chosen in the picker nothing brings it back.
  const manifest = withoutXmlComments(await read('android/app/src/main/AndroidManifest.xml'));
  const declared = manifest.match(/android:configChanges="([^"]+)"/)?.[1]?.split('|') ?? [];

  for (const change of [
    'orientation', 'screenSize', 'smallestScreenSize', 'screenLayout', 'density',
    'fontScale', 'layoutDirection', 'locale', 'keyboard', 'keyboardHidden',
    'navigation', 'uiMode'
  ]) {
    assert.ok(declared.includes(change), `android:configChanges must include ${change}`);
  }

  // Handling fontScale is a promise the activity has to keep itself: the
  // WebView takes its text zoom from the font scale only when it is built.
  const activity = withoutJavaComments(await javaSource('MainActivity.java'));
  assert.match(activity,
    /public void onConfigurationChanged\(Configuration newConfig\)\s*\{[\s\S]*?fontScale[\s\S]*?setTextZoom\(/,
    'a declared fontScale change must re-apply the WebView text zoom');
});

test('declaring uiMode loses nothing, because nothing here follows dark mode', async () => {
  // A dark-mode switch would otherwise recreate the activity and delete the
  // open log. Keeping it declared is only right while no resource or page style
  // depends on it; the day one does, this fails and the handling has to change.
  const resources = await readdir(path.join(projectRoot, 'android', 'app', 'src', 'main', 'res'));
  assert.deepEqual(resources.filter(name => /-night\b|-notnight\b/.test(name)), [],
    'a night resource variant would need recreation or explicit handling on uiMode');

  const page = await read('ui/index.html');
  assert.match(page, /color-scheme:\s*dark/);
  for (const file of (await readdir(path.join(projectRoot, 'ui'))).filter(name =>
    /\.(?:mjs|html|css)$/.test(name))) {
    assert.doesNotMatch(await read(`ui/${file}`), /prefers-color-scheme/,
      `ui/${file} follows the system theme, so uiMode changes must restyle the page`);
  }
});

// ---------------------------------------------------------------------------
// Links handed to the browser
// ---------------------------------------------------------------------------

/** Every URL About & Legal can render as a link, on any platform. */
function legalLinks() {
  const links = new Set([LEGAL.project.sourceUrl, LEGAL.project.repository]);
  for (const components of Object.values(LEGAL.componentsByPlatform)) {
    for (const component of components) {
      links.add(component.url);
    }
  }
  return links;
}

async function shellAllowlist() {
  const source = withoutJavaComments(await javaSource('ExternalLinks.java'));
  const body = source.match(/Set<String>\s+ALLOWED\s*=([\s\S]*?);/)?.[1];
  assert.ok(body, 'ExternalLinks.ALLOWED must stay readable to this test');
  return new Set([...body.matchAll(/"([^"]*)"/g)].map(match => match[1]));
}

test('the shell opens exactly the links About & Legal shows, and nothing else', async () => {
  const shown = legalLinks();
  const allowed = await shellAllowlist();

  assert.ok(shown.size > 0);
  for (const url of shown) {
    assert.ok(allowed.has(url),
      `About & Legal links to ${url}, which the Android shell will not open; `
      + 'add it to ExternalLinks.ALLOWED');
  }
  for (const url of allowed) {
    assert.ok(shown.has(url),
      `ExternalLinks.ALLOWED lets ${url} leave, but nothing in About & Legal shows it`);
  }

  for (const url of allowed) {
    // The shell compares the canonical URL the WebView reports, exactly. A
    // non-canonical entry would never match a real tap.
    assert.equal(new URL(url).href, url, `${url} is not in canonical form`);
    assert.equal(new URL(url).protocol, 'https:');
    assert.equal(new URL(url).search, '');
    assert.equal(new URL(url).hash, '');
  }
});

test('no other page markup links off the viewer', async () => {
  // A literal link anywhere else in the page would be dead on Android. Legal
  // links are interpolated from LEGAL and covered above.
  for (const file of (await readdir(path.join(projectRoot, 'ui'))).filter(name =>
    /\.(?:mjs|html)$/.test(name) && name !== 'legal-data.mjs')) {
    const text = await read(`ui/${file}`);
    const literal = [...text.matchAll(/href\s*=\s*["'](https?:[^"']+)["']/g)].map(match => match[1]);
    assert.deepEqual(literal, [], `ui/${file} links to ${literal.join(', ')}`);
  }
});

test('navigation off the app origin is never loaded in the WebView', async () => {
  const activity = withoutJavaComments(await javaSource('MainActivity.java'));
  const body = activity.match(
    /public boolean shouldOverrideUrlLoading\(WebView view, WebResourceRequest request\)\s*\{([\s\S]*?)\n\s{12}\}/
  )?.[1];
  assert.ok(body, 'shouldOverrideUrlLoading must stay readable to this test');
  assert.match(body, /AssetServer\.isAppOrigin\(/);
  assert.match(body, /ExternalLinks\.opensInBrowser\(url\.toString\(\), request\.hasGesture\(\)\)/);
  assert.match(body, /return true;\s*$/, 'everything not on the app origin must be refused');
  assert.equal((body.match(/return false;/g) ?? []).length, 1,
    'only the app origin may load in the WebView');
});

test('the asset server answers every request itself', async () => {
  const server = withoutJavaComments(await javaSource('AssetServer.java'));
  const body = server.match(/WebResourceResponse serve\(Uri url\)\s*\{([\s\S]*?)\n\s{4}\}/)?.[1];
  assert.ok(body, 'serve() must stay readable to this test');
  assert.doesNotMatch(body, /return null/,
    'null from shouldInterceptRequest hands the request to the WebView to load');
  assert.match(body, /isAppOrigin\(url\.getScheme\(\), url\.getHost\(\), url\.getPort\(\)\)/);
});

// ---------------------------------------------------------------------------
// A dead renderer
// ---------------------------------------------------------------------------

test('a dead renderer is answered, and the log it died on is never re-offered', async () => {
  const activity = withoutJavaComments(await javaSource('MainActivity.java'));

  assert.match(activity,
    /public boolean onRenderProcessGone\(WebView view, RenderProcessGoneDetail detail\)\s*\{\s*recoverFromRendererLoss\(view, detail\.didCrash\(\)\);\s*return true;\s*\}/,
    'returning false (the default) makes Android kill the app with its renderer, and the '
    + 'page cannot be told whether the log was the cause unless didCrash() is passed on');

  const recovery = activity.match(
    /private void recoverFromRendererLoss\(WebView dead, boolean crashed\)\s*\{([\s\S]*?)\n\s{4}\}/
  )?.[1];
  assert.ok(recovery, 'recoverFromRendererLoss must stay readable to this test');
  for (const reoffer of ['importFrom(', 'handleIntent(', 'notifyPage(', 'getIntent(']) {
    assert.ok(!recovery.includes(reoffer),
      `renderer recovery must not call ${reoffer}: the log may be what killed it`);
  }
  assert.match(recovery, /retireImportSlot\(\)/, 'the lost log must be unlinked, not kept');
  assert.match(recovery, /rendererRecovery\.mayRebuildAfterLoss\(\)/,
    'a replacement that dies before loading must not be replaced forever');

  // A crash (out of memory on a large log, most often) and a reclaim by the
  // system are different news for the pilot: after a reclaim the log was most
  // likely not the cause, and telling him it was sends him to cut up a good log.
  assert.match(recovery,
    /notifyFailure\(lostLog, crashed \? "viewer-restarted" : "viewer-reclaimed", generation\)/,
    'only a renderer that crashed may be reported as having died on the log');

  assert.match(activity,
    /public void onPageFinished\([^)]*\)\s*\{[\s\S]*?rendererRecovery\.pageLoaded\(\);/,
    'only a page that loaded earns the next recovery');
});

// ---------------------------------------------------------------------------
// Failure reasons the shell sends, and the words the page has for each
// ---------------------------------------------------------------------------

/**
 * The argument text of every call to `callee` in `code`, from just inside its
 * `(` to its matching `)`. String literals are skipped while counting, so a
 * parenthesis inside a reason string cannot end a call early.
 */
function callArguments(code, callee) {
  const calls = [];
  // A qualified or spaced call (`this.notifyFailure (`) is still a call; only
  // a longer identifier ending in the same name (`retryNotifyFailure(`) is not.
  const opener = new RegExp(`(?<![\\w$])${callee.replace(/\./g, '\\.')}\\s*\\(`, 'g');
  for (const match of code.matchAll(opener)) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    for (; index < code.length && depth > 0; index++) {
      const character = code[index];
      if (character === '"') {
        for (index++; index < code.length && code[index] !== '"'; index++) {
          if (code[index] === '\\') {
            index++;
          }
        }
      } else if (character === '(') {
        depth++;
      } else if (character === ')') {
        depth--;
      }
    }
    assert.equal(depth, 0, `unbalanced call to ${callee}`);
    calls.push(code.slice(start, index - 1));
  }
  return calls;
}

/** Splits an argument list at its top-level commas, literals intact. */
function topLevelArguments(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      const start = index;
      for (index++; index < text.length && text[index] !== '"'; index++) {
        if (text[index] === '\\') {
          index++;
        }
      }
      current += text.slice(start, index + 1);
      continue;
    }
    if (character === '(') depth++;
    if (character === ')') depth--;
    if (character === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  parts.push(current.trim());
  return parts;
}

const javaStringLiterals = text =>
  [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(match => match[1]);

/**
 * A reason argument this file can read completely: one literal, or a choice
 * between two. Anything else — a variable, a method call, a lookup — could
 * carry a code nobody has written words for, so it is refused rather than
 * read as "no reasons here".
 */
function literalReasons(argument, where) {
  const shape = argument.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\s+/g, ' ').trim();
  assert.match(shape, /^(?:""|[\w.()!]+ \? "" : "")$/,
    `${where} passes the reason ${argument}, which this test cannot read; `
    + 'name the code as a literal (or a ternary of two literals)');
  return javaStringLiterals(argument);
}

/**
 * Every `reason` the Android shell can put in a rotorlens-import-failed event.
 *
 * Read from the Java, not restated: MainActivity's own codes from each
 * notifyFailure call, plus every code ImportStore can return where MainActivity
 * forwards `result.reason` — less the ones it is seen to withhold right there.
 */
async function reasonsTheShellCanSend() {
  const activity = withoutJavaComments(await javaSource('MainActivity.java'));
  const store = withoutJavaComments(await javaSource('ImportStore.java'));

  const storeReasons = new Set();
  const failedCalls = callArguments(store, 'Result.failed');
  assert.ok(failedCalls.length > 0, 'ImportStore must still build failures with Result.failed');
  for (const call of failedCalls) {
    literalReasons(call, `ImportStore Result.failed(${call})`).forEach(reason => storeReasons.add(reason));
  }
  // The only other way to build a failed Result would bypass the read above.
  assert.equal((store.match(/new Result\(false/g) ?? []).length, 1,
    'a failed Result must be built only inside Result.failed');

  // A code ImportStore returns that MainActivity deliberately keeps from the
  // page — "cancelled", a superseded import — counts as withheld only when the
  // guard sits directly on the forwarding call.
  const withheld = new Set([...activity.matchAll(
    /!"([^"]+)"\.equals\(result\.reason\)\)\s*\{\s*notifyFailure\([^;]*\bresult\.reason\b/g
  )].map(match => match[1]));

  const sent = new Set();
  const calls = callArguments(activity, 'notifyFailure')
    .filter(call => !/^String name, String reason/.test(call));
  assert.ok(calls.length > 0, 'MainActivity must still report failures with notifyFailure');
  for (const call of calls) {
    const [, reason] = topLevelArguments(call);
    assert.ok(reason, `notifyFailure(${call}) has no reason argument`);
    if (reason === 'result.reason') {
      for (const code of storeReasons) {
        if (!withheld.has(code)) {
          sent.add(code);
        }
      }
    } else {
      literalReasons(reason, `notifyFailure(${call})`).forEach(code => sent.add(code));
    }
  }

  // notifyFailure must be the only way the event leaves Java, or a code sent
  // some other way escapes everything above.
  const javaDirectory = path.join(projectRoot, 'android', 'app', 'src', 'main', 'java', 'app', 'rotorlens');
  let dispatches = 0;
  for (const file of (await readdir(javaDirectory)).filter(name => name.endsWith('.java'))) {
    const code = withoutJavaComments(await javaSource(file));
    dispatches += (code.match(/rotorlens-import-failed/g) ?? []).length;
  }
  assert.equal(dispatches, 1, 'rotorlens-import-failed must be sent from notifyFailure alone');

  return sent;
}

/**
 * The page's words for each failure code, lifted out of ui/app.mjs.
 *
 * Read from the source because app.mjs wires the DOM at module scope and
 * cannot be imported in bare Node (see test/ui-direction-words.test.mjs). The
 * object literal is evaluated on its own, in an empty context, so a key that
 * appears only in a comment counts for nothing.
 */
async function pageFailureWords() {
  const source = await read('ui/app.mjs');
  const block = /\nconst HOST_FAILURE_WORDS = Object\.freeze\((\{[\s\S]*?\n\})\);/.exec(source);
  assert.ok(block, 'ui/app.mjs no longer declares HOST_FAILURE_WORDS as a frozen object literal');
  const words = runInNewContext(`(${block[1]})`, Object.create(null));

  const handler = /\nonHostFileFailed\(\(\{name, reason\}\) => \{([\s\S]*?)\n\}\);/.exec(source)?.[1];
  assert.ok(handler, 'the onHostFileFailed handler in ui/app.mjs must stay readable to this test');
  assert.match(handler, /HOST_FAILURE_WORDS/, 'the handler must take its words from HOST_FAILURE_WORDS');
  assert.doesNotMatch(handler, /reason\s*[!=]==?\s*['"]/,
    'a code compared in the handler is wording kept in a second place');
  return words;
}

test('every failure the Android shell can report has its own words on the page', async () => {
  const sent = await reasonsTheShellCanSend();
  const words = await pageFailureWords();

  // The parse must see what is known to be there, or an empty set passes.
  for (const known of ['no-file', 'too-large', 'unreadable', 'viewer-restarted', 'viewer-reclaimed']) {
    assert.ok(sent.has(known), `the Java parse no longer finds "${known}"`);
  }
  assert.ok(!sent.has('cancelled'), 'a superseded import is never reported to the page');

  for (const reason of sent) {
    assert.ok(Object.prototype.hasOwnProperty.call(words, reason),
      `the Android shell can send reason "${reason}", but ui/app.mjs has no words for it; `
      + 'the pilot would read the generic copy-failure text instead');
    assert.equal(typeof words[reason], 'string');
    assert.ok(words[reason].trim().length > 20, `the words for "${reason}" say nothing`);
  }

  const texts = Object.values(words);
  assert.equal(new Set(texts).size, texts.length, 'two failure codes share the same words');

  // The two defects this test was written for, checked by meaning.
  assert.doesNotMatch(words['viewer-restarted'], /permission/i,
    'a renderer that died on the log is not a permission problem');
  assert.match(words['viewer-restarted'], /memory/i);
  assert.doesNotMatch(words['viewer-reclaimed'], /too large|smaller|split|limit/i,
    'after a system reclaim the log was most likely not the cause, so nothing may blame its size');
  assert.match(words['viewer-reclaimed'], /open (it|the log|this log) again/i);

  // The contract is written down where the next shell's author will look.
  const hostComment = /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*export function onHostFileFailed/.exec(
    await read('ui/host.mjs'))?.[1];
  assert.ok(hostComment, 'ui/host.mjs must document onHostFileFailed');
  const javadoc = /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*private void notifyFailure/.exec(
    await javaSource('MainActivity.java'))?.[1];
  assert.ok(javadoc, 'MainActivity.notifyFailure must keep its javadoc');
  for (const reason of sent) {
    assert.ok(hostComment.includes(`'${reason}'`),
      `ui/host.mjs's onHostFileFailed comment does not list '${reason}'`);
    assert.ok(javadoc.includes(`"${reason}"`),
      `MainActivity.notifyFailure's javadoc does not list "${reason}"`);
  }
});
