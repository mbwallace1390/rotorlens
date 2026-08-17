/**
 * The disclaimer says the same thing in both places it appears.
 *
 * RotorLens now tells a pilot what to change on a machine with spinning blades.
 * That promise is made twice — once in the store listing
 * (docs/STORE_LISTING.md) and once inside the app (the generated legal screen) —
 * and two copies of a promise drift. The copy that drifts is the one somebody
 * reads back to you.
 *
 * This does not compare the two texts word for word; they are deliberately
 * different lengths for different audiences. It pins the CLAIMS: every load-
 * bearing statement must be present on both sides, and each one must still be
 * enforced by something in the repository.
 */

import {strict as assert} from 'node:assert';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import path from 'node:path';

import {LEGAL} from '../ui/legal-data.mjs';
import {buildLegalData} from '../tools/generate-legal.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => readFile(path.join(projectRoot, relative), 'utf8');

/**
 * One long line, so a claim can be matched as a sentence.
 *
 * The store copy is a markdown blockquote: every line carries a `> ` and the
 * sentences wrap wherever the column ran out. Matching raw text would make
 * these assertions depend on where somebody's editor broke a line, which is
 * the kind of test that fails for a reason nobody can act on.
 */
const flatten = text => text.replace(/^\s*>\s?/gm, ' ').replace(/\s+/g, ' ').trim();

const inAppText = () => flatten([
  LEGAL.disclaimer.title,
  ...LEGAL.disclaimer.sections.flatMap(section => [section.heading, section.body])
].join(' '));

/**
 * A claim, and how each side of the pair is expected to phrase it.
 *
 * The store copy is written for a listing and the in-app copy for a pilot who
 * has already installed it, so the wording differs on purpose. What may not
 * differ is whether the claim is made at all.
 */
const SHARED_CLAIMS = [
  {
    claim: 'never connects or writes to a flight controller',
    store: /never connects to or writes to a flight controller/i,
    inApp: /no connection to your aircraft/i
  },
  {
    claim: 'the pilot is responsible, not the app',
    store: /you are responsible for your aircraft/i,
    inApp: /you are responsible for your aircraft/i
  },
  {
    claim: 'suggestions rest on the log you provide, and nothing else',
    store: /based solely on the log you provide/i,
    inApp: /one log from one flight/i
  },
  {
    claim: 'findings point at where to look; they do not replace inspecting the aircraft',
    store: /not a substitute for physically inspecting/i,
    inApp: /stop and inspect the aircraft/i
  },
  {
    claim: 'ground-check and build inputs up gradually',
    store: /ground-check after any change/i,
    inApp: /Ground-check after any change/
  },
  {
    claim: 'model helicopters can cause serious injury',
    store: /serious injury/i,
    inApp: /serious injury/i
  },
  {
    claim: 'not affiliated with Rotorflight or Betaflight',
    store: /not affiliated with, endorsed by, or sponsored by/i,
    inApp: /not affiliated with, endorsed by, or sponsored by/i
  },
  {
    claim: 'answering the optional sharing question stores the answer',
    store: /Answering the optional future-sharing question also stores your answer/i,
    inApp: /Answering the optional future-sharing question stores your answer/i
  },
  {
    claim: 'sharing uses a random 100-bit local aircraft identity',
    store: /random 100-bit local identity for each saved helicopter/i,
    inApp: /random 100-bit identity for each saved helicopter/i
  },
  {
    claim: 'this release has no upload transport',
    store: /This release cannot send anything/i,
    inApp: /This release has no upload transport/i
  }
];

test('every load-bearing claim appears in both the store copy and the app', async () => {
  const store = flatten(await read('docs/STORE_LISTING.md'));
  const app = inAppText();

  for (const {claim, store: storePattern, inApp} of SHARED_CLAIMS) {
    assert.match(store, storePattern, `docs/STORE_LISTING.md drops the claim: ${claim}`);
    assert.match(app, inApp, `the in-app disclaimer drops the claim: ${claim}`);
  }
});

test('the in-app disclaimer is what the generator produces', async () => {
  // Regenerate into memory and compare, never onto disk. A test that rebuilds
  // its subject reports "up to date" for a file that was stale until it ran;
  // that has happened twice in this repository.
  const fresh = await buildLegalData();
  assert.deepEqual(LEGAL.disclaimer, fresh.disclaimer,
    'ui/legal-data.mjs is stale — run `npm run legal:generate` and commit the result');
});

test('the Android permission and cross-platform no-upload claims stay distinct', async () => {
  // Android has a platform permission that makes the no-network statement a
  // property of the binary. iOS has no equivalent permission, so the shared app
  // copy separately promises the behavior current builds actually implement:
  // there is no upload transport and no flight data is sent.
  const manifest = await read('android/app/src/main/AndroidManifest.xml');
  assert.doesNotMatch(manifest, /android\.permission\.INTERNET/,
    'the disclaimer says Android requests no INTERNET permission, but the manifest does');

  const app = inAppText();
  assert.match(app, /On Android, RotorLens requests no INTERNET permission/i);
  assert.match(app, /All current builds contain no upload transport and do not send your flight data/i);
  assert.match(app, /Nothing leaves your phone/i);
});

test('the disclaimer does not promise more than the engine enforces', async () => {
  const app = inAppText();

  // "one change at a time" is enforced: at most one finding is ever actNow.
  assert.match(app, /Apply a single suggestion/i);

  // "shows the measurements behind it" is enforced: every finding carries basis.
  assert.match(app, /shows\s+the measurements behind it/i);

  // And the honest limit the engine now states on the findings themselves.
  assert.match(app, /cannot always tell a mechanical fault from a gain/i);

  // Nothing here may imply the app can change a setting for the pilot.
  assert.ok(!/we (will )?(apply|write|set|change) (your |the )?(gain|setting)/i.test(app),
    'nothing may suggest RotorLens applies a change itself');
});

test('the compatibility statement never outruns the decoder', () => {
  // The trademark policy permits naming Rotorflight and Betaflight to describe
  // log compatibility WHEN ACCURATE. The decoder accepts Rotorflight 4.3-4.6
  // and refuses everything else, so a sentence reading "reads their Blackbox
  // log format" beside .bfl file registrations promised Betaflight pilots an
  // app that would refuse their logs. The statement must carry the accepted
  // range, and must not claim to read "their" format as though both projects'
  // logs open.
  const everything = JSON.stringify(LEGAL);
  assert.doesNotMatch(everything, /reads their Blackbox log format/i,
    'the legal screen claims to read both projects\' logs; the decoder does not');
  assert.match(everything, /Rotorflight 4\.3(?:–|-)4\.6 only/,
    'the legal screen must state the firmware range this release actually accepts');
});
