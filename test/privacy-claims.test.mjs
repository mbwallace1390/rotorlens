/**
 * The privacy policy, checked against the code it describes.
 *
 * `docs/PRIVACY_POLICY.md` and the store declarations in
 * `docs/STORE_PRIVACY_ANSWERS.md` say RotorLens collects nothing and transmits
 * nothing. Both stores treat a wrong answer there as a policy violation rather
 * than a mistake.
 *
 * It stores two documented native files: a summary of each flight the pilot
 * chooses to keep, and the optional sharing preference/aircraft identities. So
 * the claim these tests defend is not "nothing is stored" — it is narrower and
 * more checkable:
 *
 *   - nothing that ships uses a BROWSER storage API (the history is a native
 *     file, so `ui/` and `src/` genuinely never touch one, and this stays a
 *     blanket ban rather than an allowlist);
 *   - nothing that is stored can leave the device, by network or by backup or by
 *     a phone-to-phone migration.
 *
 * A policy is a claim about code. These are the assertions that keep it true —
 * the absence of the INTERNET permission is asserted separately, in
 * test/provenance.test.mjs.
 */

import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every JavaScript file that ships inside the APK: `ui/` and `src/`. */
async function shippedSources(directory = null, collected = []) {
  const roots = directory ? [directory] : [
    path.join(projectRoot, 'ui'),
    path.join(projectRoot, 'src')
  ];

  for (const root of roots) {
    for (const entry of await readdir(root, {withFileTypes: true})) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        await shippedSources(full, collected);
      } else if (entry.name.endsWith('.mjs')) {
        collected.push(full);
      }
    }
  }

  return collected;
}

/**
 * Strips comments before scanning.
 *
 * Otherwise a sentence explaining that the app never uses localStorage would
 * fail the test forbidding localStorage, and the honest fix would be to delete
 * the explanation.
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('nothing that ships uses a browser storage API', async () => {
  // The policy says: no browser storage of any kind — no localStorage, no
  // IndexedDB, no web databases. That is a blanket ban and stays one: the flight
  // history is written by the native shell to a file, so nothing in `ui/` or
  // `src/` has any reason to reach for one of these, and the ban keeps its teeth.
  // One of these appearing would make the policy false without a reviewer
  // noticing, and would also put pilot data somewhere the deletion controls and
  // the backup rules below do not reach.
  const forbidden = [
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'document.cookie',
    'openDatabase',
    'caches.open'
  ];

  for (const file of await shippedSources()) {
    const code = withoutComments(await readFile(file, 'utf8'));
    for (const api of forbidden) {
      assert.ok(
        !code.includes(api),
        `${path.relative(projectRoot, file)} uses ${api}; docs/PRIVACY_POLICY.md says `
        + 'there is no browser storage of any kind'
      );
    }
  }
});

test('nothing that ships can reach the network by another route', async () => {
  const forbidden = [
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'sendBeacon',
    'navigator.geolocation',
    'importScripts'
  ];

  for (const file of await shippedSources()) {
    const code = withoutComments(await readFile(file, 'utf8'));
    for (const api of forbidden) {
      assert.ok(
        !code.includes(api),
        `${path.relative(projectRoot, file)} uses ${api}; the app must have no way off the device`
      );
    }
  }
});

test('the only fetch is the native host handing over the opened log', async () => {
  // Not a ban on fetch: the shell serves the imported log from the app's own
  // origin and the page reads it back. The point is that there is exactly one
  // call site, and it is that one.
  const callSites = [];

  for (const file of await shippedSources()) {
    const code = withoutComments(await readFile(file, 'utf8'));
    // Deliberately matches the method form too: `scope.fetch(...)` is how the
    // real call is written, and a test that missed it would pass on zero.
    for (const match of code.matchAll(/\bfetch\s*\(([^)]*)\)/g)) {
      callSites.push({file: path.relative(projectRoot, file), argument: match[1].trim()});
    }
  }

  assert.equal(callSites.length, 1, `expected one fetch, found: ${JSON.stringify(callSites)}`);
  assert.equal(callSites[0].file.replace(/\\/g, '/'), 'ui/host.mjs');
  assert.equal(callSites[0].argument, 'detail.url, {signal}',
    'the one local fetch must carry the cancellation signal for a replaced import');
});

test('the log is served from a path on the app\'s own origin, not a URL', async () => {
  // `detail.url` above is whatever MainActivity puts in the event. If that ever
  // became an absolute URL, the fetch above would leave the device — so the
  // constant it comes from must stay a path.
  const server = await readFile(
    path.join(projectRoot, 'android', 'app', 'src', 'main', 'java', 'app', 'rotorlens',
      'AssetServer.java'),
    'utf8'
  );

  const declaration = server.match(/String\s+IMPORT_PREFIX\s*=\s*"([^"]*)"/);
  assert.ok(declaration, 'IMPORT_PREFIX must still exist');
  assert.match(declaration[1], /^\/[^/]/,
    'IMPORT_PREFIX must be a same-origin path, not a URL');
  assert.match(server, /return\s+IMPORT_PREFIX\s*\+\s*id\s*;/,
    'every import URL must include its immutable generation id');

  const activity = await readFile(
    path.join(projectRoot, 'android', 'app', 'src', 'main', 'java', 'app', 'rotorlens',
      'MainActivity.java'),
    'utf8'
  );
  assert.ok(
    activity.includes('AssetServer.importPath(id)'),
    'the page must be handed the generation-bound path rather than a literal/current alias'
  );
});

test('the imported log does not outlive the session', async () => {
  // The policy makes three promises about the cached copy. Each is a specific
  // line of ImportStore, and each would be easy to remove during a tidy-up.
  const store = await readFile(
    path.join(projectRoot, 'android', 'app', 'src', 'main', 'java', 'app', 'rotorlens',
      'ImportStore.java'),
    'utf8'
  );

  assert.match(store, /private void purgeOnce\(\)/,
    'a killed process must not leave the last flight in the cache');
  assert.match(store, /purgeOnce\(\);/, 'the purge must actually be called from the constructor');
  assert.match(store, /previous\.delete\(\)/, 'opening a log must delete the previous one');
  assert.match(store, /void clear\(\)/, 'the viewer must be able to drop the log');

  const activity = await readFile(
    path.join(projectRoot, 'android', 'app', 'src', 'main', 'java', 'app', 'rotorlens',
      'MainActivity.java'),
    'utf8'
  );
  assert.match(
    activity,
    /protected void onDestroy\(\)[\s\S]*?retireImportSlot\(\);/,
    'destroy must retire the active import slot without waiting for its provider'
  );
  assert.match(
    activity,
    /private long retireImportSlot\(\)[\s\S]*?imports\.clear\(\);/,
    'retiring an import slot must unlink its cache entry'
  );
});

test('cold-start import replay is generation-bound and start precedes terminal', async () => {
  const activity = await readFile(
    path.join(
      projectRoot, 'android', 'app', 'src', 'main', 'java', 'app', 'rotorlens',
      'MainActivity.java'
    ),
    'utf8'
  );
  const body = activity.match(
    /private long retireImportSlot\(\)\s*\{([\s\S]*?)\n\s{4}\}/
  )?.[1];
  assert.ok(body, 'retireImportSlot must remain inspectable by the lifecycle regression');
  assert.match(body, /importGeneration\.incrementAndGet\(\)/);
  assert.match(body, /pendingImports\.retire\(generation\)\s*;/,
    'both queued event kinds must be retired with their import generation');
  assert.ok(
    body.indexOf('pendingImports.retire(generation)') < body.indexOf('imports.clear()'),
    'stale events must be retired as part of the same slot transition'
  );

  assert.match(activity,
    /public void onPageFinished\([^)]*\)\s*\{[\s\S]*?pendingImports\.drain\(importGeneration\.get\(\)\)/,
    'page readiness must drain only the current generation');
  assert.match(activity,
    /private void notifyImportStarted\([^)]*\)\s*\{\s*dispatchImportStart\(/,
    'a cold-start start event must be replayable, not live-only');
  assert.match(activity,
    /private void dispatchImportStart\([^)]*\)\s*\{[\s\S]*?pendingImports\.queueStart\(generation, script\)/,
    'start events must have a generation-bound queue');
  assert.match(activity,
    /private void dispatchTerminal\([^)]*\)\s*\{[\s\S]*?pendingImports\.queueTerminal\(generation, script\)/,
    'terminal events must remain separately generation-bound');

  const pending = await readFile(
    path.join(
      projectRoot, 'android', 'app', 'src', 'main', 'java', 'app', 'rotorlens',
      'PendingImportEvents.java'
    ),
    'utf8'
  );
  assert.match(pending,
    /return queuedStart \+ ";\\n" \+ queuedTerminal\s*;/,
    'cold-start replay must establish the import before its terminal event');
});

/**
 * "Nothing leaves your phone" has to survive the owner buying a new phone.
 *
 * This is the assertion that would have caught the real defect. The manifest had
 * android:allowBackup="false" and nothing else, and every test that claimed to
 * defend the sentence only grepped for `<uses-permission`. That is a test which
 * cannot reach the failure it names: no permission is involved in a backup.
 *
 * For apps targeting API 31+ — this one targets 36 — Android's Auto Backup
 * documentation states that on devices from some manufacturers allowBackup="false"
 * disables cloud backup but "doesn't disable device-to-device transfers for the
 * app", and that if the <device-transfer> section is not set "all the application
 * data will be transferred during a D2D migration". The flight history is in
 * getFilesDir(), so it was in that set.
 *
 * The chain asserted below is the whole claim, link by link: the history is
 * written into getFilesDir(); getFilesDir() is the `file` domain; the `file`
 * domain is excluded from both cloud backup and device transfer; and neither
 * section carries an <include> that would let something back in.
 */
test('what is stored cannot leave the phone by backup or by device transfer', async () => {
  const androidRoot = path.join(projectRoot, 'android', 'app', 'src', 'main');
  const manifest = await readFile(path.join(androidRoot, 'AndroidManifest.xml'), 'utf8');

  assert.match(
    manifest,
    /android:allowBackup="false"/,
    'cloud backup must stay off; without it the history goes to Google Drive'
  );

  const rulesAttribute = manifest.match(/android:dataExtractionRules="@xml\/([A-Za-z0-9_]+)"/);
  assert.ok(
    rulesAttribute,
    'the application must declare android:dataExtractionRules; at targetSdk 31+ '
    + 'android:allowBackup="false" alone does not stop a device-to-device transfer, '
    + 'so without it flight-history.json migrates to the next phone and '
    + '"Nothing leaves your phone" becomes false with no app code changing'
  );

  const rules = await readFile(
    path.join(androidRoot, 'res', 'xml', `${rulesAttribute[1]}.xml`), 'utf8'
  );

  // Comments in that file explain the domains; scanning them as if they were
  // rules would let a deleted <exclude> pass because its explanation survived.
  const withoutXmlComments = rules.replace(/<!--[\s\S]*?-->/g, '');

  for (const section of ['cloud-backup', 'device-transfer']) {
    const block = withoutXmlComments.match(
      new RegExp(`<${section}\\b[^>]*>([\\s\\S]*?)</${section}>`)
    );
    assert.ok(block, `the rules must declare a <${section}> section`);

    // Rule semantics run the wrong way round to intuition: a section holding only
    // <exclude> rules excludes those and keeps everything else. So each domain
    // that can hold app data has to be named, and one <include> anywhere flips
    // the section into an allowlist where everything unnamed is copied.
    assert.doesNotMatch(
      block[1],
      /<include\b/,
      `<${section}> must not carry an <include>; that turns the section into an `
      + 'allowlist and re-admits everything it does not name'
    );

    for (const domain of ['root', 'file', 'database', 'sharedpref', 'external']) {
      assert.match(
        block[1],
        new RegExp(`<exclude\\s+domain="${domain}"\\s+path="\\."\\s*/>`),
        `<${section}> must exclude the whole "${domain}" domain`
      );
    }
  }

  // Android 11 and earlier ignore dataExtractionRules. Resolve the legacy
  // fullBackupContent edge from the manifest and prove its separate schema
  // excludes every private-storage domain too.
  const legacyAttribute = manifest.match(
    /android:fullBackupContent="@xml\/([A-Za-z0-9_]+)"/
  );
  assert.ok(
    legacyAttribute,
    'the application must declare fullBackupContent for Android 11 and earlier'
  );
  const legacyRules = (await readFile(
    path.join(androidRoot, 'res', 'xml', `${legacyAttribute[1]}.xml`), 'utf8'
  )).replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(
    legacyRules,
    /<include\b/,
    'legacy backup rules must not re-admit a private storage path'
  );
  for (const domain of ['root', 'file', 'database', 'sharedpref', 'external']) {
    assert.match(
      legacyRules,
      new RegExp(`<exclude\\s+domain="${domain}"\\s+path="\\."\\s*/>`),
      `legacy backup rules must exclude the whole "${domain}" domain`
    );
  }

  // The link that makes the rules about this app rather than about XML: the
  // history is written into getFilesDir(), which IS the "file" domain excluded
  // above. getCacheDir() would make the history disposable; any other directory
  // would need its own domain named here.
  const activity = await readFile(
    path.join(androidRoot, 'java', 'app', 'rotorlens', 'MainActivity.java'), 'utf8'
  );
  assert.match(
    activity,
    /new HistoryStore\(\s*getFilesDir\(\)\s*\)/,
    'the history must live in getFilesDir(), which is the "file" domain the rules exclude'
  );

  const store = await readFile(
    path.join(androidRoot, 'java', 'app', 'rotorlens', 'HistoryStore.java'), 'utf8'
  );
  assert.match(
    store,
    /file\.delete\(\)/,
    'forgetting everything must unlink the file; a file containing an empty history '
    + 'is still a file saying somebody used the feature'
  );
});

test('sharing consent names the local identities it creates', async () => {
  const page = await readFile(path.join(projectRoot, 'ui', 'index.html'), 'utf8');
  const app = await readFile(path.join(projectRoot, 'ui', 'app.mjs'), 'utf8');
  assert.match(page, /creates a random local identity for each saved\s+helicopter/i);
  assert.match(page, /nothing is sent/i);
  assert.match(app, /SHARING_TERMS_VERSION\s*=\s*'2026-08-14'/,
    'materially changed consent words need a new version');
  const storedVersion = app.match(/SHARING_TERMS_VERSION\s*=\s*'(\d{4}-\d{2}-\d{2})'/)?.[1];
  const visibleVersion = page.match(/Terms version\s+(\d{4}-\d{2}-\d{2}),\s+recorded/i)?.[1];
  assert.equal(visibleVersion, storedVersion,
    'the version recorded with Yes must be the version visibly disclosed');
  assert.match(app, /sharing\.termsVersion\s*!==\s*SHARING_TERMS_VERSION/,
    'enabled consent from an older disclosure must fail closed');
});

test('the hosted policy page is generated from the policy, not typed twice', async () => {
  const {renderCommittedPolicyPage} = await import('../tools/generate-privacy-page.mjs');
  const committed = await readFile(path.join(projectRoot, 'docs', 'privacy-policy.html'), 'utf8');

  assert.equal(
    committed,
    await renderCommittedPolicyPage(),
    'docs/privacy-policy.html is stale; run `npm run privacy:generate` and commit it'
  );
});

test('the policy page renders wrapped sentences whole', async () => {
  // The converter first split every wrapped list item, turning "The copy is
  // removed when the viewer is / finished with it." into a bullet and a stray
  // paragraph. Mangling a legal document quietly is the one thing a generator
  // for it must not do.
  const {renderPolicyHtml} = await import('../tools/generate-privacy-page.mjs');
  const html = renderPolicyHtml([
    '# Title',
    '',
    '- **One log at a time.** Opening another deletes the previous',
    '  copy of it.',
    '- **Deleted when the app closes.**',
    ''
  ].join('\n'));

  assert.match(html, /Opening another deletes the previous copy of it\./);
  assert.equal((html.match(/<li>/g) ?? []).length, 2, 'two bullets, not four');
  assert.doesNotMatch(html, /<p>copy of it\.<\/p>/, 'a continuation must not become a paragraph');
});

test('the policy page loads nothing from anyone else', async () => {
  // A privacy policy that pulls a font or a script from a third party is a
  // tracking vector on the page explaining that the app does not track you.
  const page = await readFile(path.join(projectRoot, 'docs', 'privacy-policy.html'), 'utf8');
  const external = [...page.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)]
    .map(match => match[1])
    .filter(target => !target.startsWith('#') && !target.startsWith('mailto:'));

  assert.deepEqual(external, [], 'the page must be entirely self-contained');
  assert.doesNotMatch(page, /<script/i, 'a policy page needs no JavaScript');
});

test('the policy and the store answers still describe this app', async () => {
  const policy = await readFile(path.join(projectRoot, 'docs', 'PRIVACY_POLICY.md'), 'utf8');
  const answers = await readFile(
    path.join(projectRoot, 'docs', 'STORE_PRIVACY_ANSWERS.md'), 'utf8'
  );

  // The policy's load-bearing claim is a property of the manifest, not a
  // promise. If someone adds a permission, provenance.test.mjs fails first — but
  // the policy must be the thing that gets rewritten, so it has to say it.
  // Whitespace-tolerant: the prose is hard-wrapped, so a phrase can straddle a
  // line break and a literal-space pattern would report a policy that says the
  // right thing as saying nothing.
  assert.match(policy, /INTERNET/, 'the policy rests on the missing INTERNET permission');
  assert.match(policy, /no\s+sensitive\s+platform\s+permission/i);
  assert.match(policy, /location/i, 'a log can carry GPS; the policy must say so');
  assert.match(answers, /No data collected|Data Not Collected|collect or share/i);
});

test('the sharing store is disclosed field-for-field before release', async () => {
  const policy = await readFile(path.join(projectRoot, 'docs', 'PRIVACY_POLICY.md'), 'utf8');
  const answers = await readFile(
    path.join(projectRoot, 'docs', 'STORE_PRIVACY_ANSWERS.md'), 'utf8'
  );
  const page = await readFile(path.join(projectRoot, 'ui', 'app.mjs'), 'utf8');
  const nativeStore = await readFile(
    path.join(projectRoot, 'android', 'app', 'src', 'main', 'java', 'app', 'rotorlens',
      'HistoryStore.java'),
    'utf8'
  );

  assert.match(nativeStore, /SHARING_NAME\s*=\s*"sharing\.json"/);
  for (const field of ['asked', 'sharing', 'termsVersion', 'ids']) {
    assert.match(page, new RegExp(`\\b${field}\\b`), `sharing store must still write ${field}`);
  }

  for (const document of [policy, answers]) {
    assert.match(document, /sharing\.json|sharing file/i);
    assert.match(document, /100-bit/i, 'the implemented aircraft identity has 100 bits');
    assert.match(document, /aircraft key/i, 'the craft-name/board association must be disclosed');
    assert.match(document,
      /turn(?:ing)? sharing off[\s\S]{0,220}(?:does not|doesn't|retains?)[\s\S]{0,120}(?:aircraft key|identity|mapping)/i,
      'turning sharing off retains existing local aircraft identity mappings');
    for (const control of ['Erase identity', 'Forget helicopter', 'Forget everything']) {
      assert.match(document, new RegExp(control.replace(' ', '\\s+'), 'i'),
        `the disclosure must name ${control} as an identity-removal control`);
    }
    assert.match(document, /before (?:you )?(?:tap )?save|before a flight is saved/i,
      'answering the consent question can persist state before a flight is saved');
    assert.match(document, /no (?:upload|sharing) transport|never transmitted/i);
  }
});
