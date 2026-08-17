/**
 * Generates `ui/legal-data.mjs`, the data behind the app's legal screen.
 *
 * Apache-2.0 section 4 obliges a distributor to hand every recipient the license
 * text and the attribution notices for what is *distributed*. RotorLens declares
 * one dependency and ships twenty-eight artifacts, so the only defensible source
 * for Android's section of that screen is the resolved classpath — the same file
 * the provenance test checks the notices against. iOS and web have separate,
 * currently empty component lists and must not inherit Android's Maven notices.
 *
 * Nothing here is maintained by hand. Regenerate with `npm run legal:generate`
 * and commit the result; `npm test` fails if the committed file is not what this
 * produces, exactly as it does for the fixture corpus.
 */

import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Who owns what, and what each notice must say.
 *
 * Matched longest-prefix-first so `org.jetbrains:annotations` cannot be captured
 * by the Kotlin rule. An artifact matching nothing is an error rather than a
 * silent omission: an unattributed component is exactly the failure this file
 * exists to prevent, and it would reach a store submission looking fine.
 */
const HOLDERS = [
  {
    prefix: 'androidx.',
    holder: 'The Android Open Source Project',
    url: 'https://developer.android.com/jetpack/androidx/releases',
    license: 'Apache-2.0',
    copyright: 'Copyright (c) The Android Open Source Project',
    note: 'Only androidx.activity is asked for by name, for the back-press and ' +
      'activity-result APIs. The rest arrive with it.'
  },
  {
    prefix: 'org.jetbrains.kotlin:',
    holder: 'JetBrains — Kotlin standard library',
    url: 'https://github.com/JetBrains/kotlin',
    license: 'Apache-2.0',
    copyright:
      'Copyright 2010-2023 JetBrains s.r.o. and Kotlin Programming Language contributors',
    note: 'androidx is written in Kotlin, so its runtime ships even though ' +
      'RotorLens contains no Kotlin of its own.'
  },
  {
    prefix: 'org.jetbrains.kotlinx:',
    holder: 'JetBrains — Kotlin coroutines',
    url: 'https://github.com/Kotlin/kotlinx.coroutines',
    license: 'Apache-2.0',
    copyright:
      'Copyright 2010-2023 JetBrains s.r.o. and Kotlin Programming Language contributors',
    note: null
  },
  {
    prefix: 'org.jetbrains:',
    holder: 'JetBrains — Java annotations',
    url: 'https://github.com/JetBrains/java-annotations',
    license: 'Apache-2.0',
    copyright: 'Copyright 2000-2016 JetBrains s.r.o.',
    note: null
  },
  {
    prefix: 'com.google.guava:',
    holder: 'The Guava Authors',
    url: 'https://github.com/google/guava',
    license: 'Apache-2.0',
    copyright: 'Copyright (c) The Guava Authors',
    note: 'The empty placeholder artifact Guava publishes so a transitive ' +
      'ListenableFuture does not drag in all of Guava.'
  }
];

// Accuracy is what makes the compatibility statement trademark-safe: the
// decoder accepts Rotorflight 4.3-4.6 and refuses everything else
// (src/blackbox/decode.mjs), so naming Betaflight in a sentence that reads as
// "opens their logs" outran the shipped behaviour — a Betaflight pilot with a
// .bfl registered to this app would find it refused.
const NON_AFFILIATION =
  'RotorLens is not affiliated with, endorsed by, or sponsored by the ' +
  'Rotorflight or Betaflight projects. It reads the Blackbox log format, ' +
  'which is a published interoperability format, and contains none of those ' +
  'projects’ code. This release opens logs from Rotorflight 4.3–4.6 only.';

/**
 * The disclaimer, in the app.
 *
 * This app tells people what to change on a machine with spinning blades. That
 * became true on 2026-08-12 when the owner reversed the measurements-only rule,
 * and a listing that still reads "plots your flight" is a different promise from
 * the one the app now makes.
 *
 * Every claim below is one the code actually keeps, which is the whole point — a
 * disclaimer that restates enforced behaviour is worth something, and one that
 * invents comfort is worth less than nothing:
 *
 *   "no connection to your aircraft" — there is no flight-controller transport
 *                                      and no sensitive platform permission
 *   "nothing leaves your phone"      — no upload transport in current builds;
 *                                      Android also lacks INTERNET permission
 *   "shows the measurements"         — every finding carries its basis
 *   "one change at a time"           — at most one finding is ever actNow
 *   "says so when it cannot tell"    — the airframe-ambiguity note, and the five
 *                                      gates in recommendation-gates.mjs
 *
 * The store listing carries a shortened version of the same claims, and
 * test/legal-disclaimer.test.mjs fails if the two disagree. Two copies of a
 * promise drift, and the copy that drifts is the one somebody reads back to you.
 */
const DISCLAIMER = {
  title: 'Before you use RotorLens',
  sections: [
    {
      heading: 'What this app does',
      body: 'It reads a blackbox log from your helicopter, measures how the aircraft '
        + 'responded to your inputs, and suggests what to adjust. Every suggestion shows '
        + 'the measurements behind it so you can check it yourself.'
    },
    {
      heading: 'What it cannot know',
      body: 'It sees one log from one flight. It does not know your blade weight, your '
        + 'servo speed, your linkage geometry, your head condition, or what you changed '
        + 'last time. Its suggestions are a starting point for your next test flight, not '
        + 'a setting to trust.'
    },
    {
      heading: 'It never touches your flight controller',
      body: 'RotorLens has no connection to your aircraft. All current builds contain no '
        + 'upload transport and do not send your flight data. On Android, RotorLens '
        + 'requests no INTERNET permission. Nothing leaves your phone. Every change is '
        + 'one you make yourself, deliberately, in your own configurator.'
    },
    {
      heading: 'What it keeps, and how to erase it',
      body: 'If you choose to save a flight, RotorLens keeps a small set of numbers about '
        + 'it on this device so it can tell you next time whether a change helped — about '
        + '4.4 kB per flight, measured on a handset. Answering the optional future-sharing '
        + 'question stores your answer. Turning sharing on also records the accepted wording '
        + 'version and '
        + 'creates a random 100-bit identity for each saved helicopter and associates it '
        + 'with that helicopter’s local craft-name and board key. This release has no upload '
        + 'transport. RotorLens never keeps the log itself, a position, a flight date, or a '
        + 'file name. The History and Sharing screens show the applicable stored state and '
        + 'let you erase one flight, one helicopter, the sharing preference and identities, '
        + 'or everything.'
    },
    {
      heading: 'Change one thing at a time',
      body: 'Apply a single suggestion, fly the same manoeuvre, and open the new log. '
        + 'RotorLens compares them and tells you whether it helped. Several changes at '
        + 'once make the result unreadable — for you and for the app.'
    },
    {
      heading: 'A shaking helicopter cannot be tuned',
      body: 'If RotorLens reports vibration, stop and inspect the aircraft: blade '
        + 'tracking, damper wear, bearings, loose hardware, and balance. Adjusting gains '
        + 'to mask a mechanical fault hides a problem that is getting worse. One flight '
        + 'cannot always tell a mechanical fault from a gain that is too high, and where '
        + 'it cannot, the app says so on the finding itself.'
    },
    {
      heading: 'You are the pilot in command',
      body: 'You are responsible for your aircraft’s airworthiness and for every '
        + 'setting you apply, regardless of what this app suggests. Ground-check after '
        + 'any change. Hover before you commit. Build inputs up gradually.'
    },
    {
      heading: 'Model helicopters are dangerous',
      body: 'Rotor blades cause serious injury. Fly within your ability, at a permitted '
        + 'site, and follow local law and your manufacturer’s guidance.'
    },
    {
      heading: 'Independent product',
      body: 'RotorLens is not affiliated with, endorsed by, or sponsored by the '
        + 'Rotorflight or Betaflight projects, or by any transmitter or flight-controller '
        + 'manufacturer. Those names are used only to describe log compatibility, and are '
        + 'trademarks of their respective owners.'
    }
  ]
};

function holderFor(coordinate) {
  const matches = HOLDERS
    .filter(entry => coordinate.startsWith(entry.prefix))
    .sort((left, right) => right.prefix.length - left.prefix.length);

  if (matches.length === 0) {
    throw new Error(
      `${coordinate} has no copyright holder recorded in tools/generate-legal.mjs. ` +
      'Add one — shipping an artifact with no attribution is the failure this file prevents.'
    );
  }

  return matches[0];
}

export async function buildLegalData() {
  const read = async relativePath =>
    readFile(path.join(projectRoot, relativePath), 'utf8');

  const shipping = JSON.parse(await read('android/shipping-dependencies.json'));
  const decision = JSON.parse(await read('config/parser-engine-decision.json'));
  const packageManifest = JSON.parse(await read('package.json'));
  const mpl = await read('LICENSE');
  const apache = await read('config/licenses/apache-2.0.txt');

  const repository = packageManifest.repository.url
    .replace(/^git\+/, '')
    .replace(/\.git$/, '');
  const releaseStatus = packageManifest.rotorlens.releaseStatus;
  const sourceRef = packageManifest.rotorlens.sourceRef;
  if (releaseStatus !== 'development' && releaseStatus !== 'release') {
    throw new Error('package.json rotorlens.releaseStatus must be development or release');
  }
  const isRelease = releaseStatus === 'release';
  if (isRelease && sourceRef !== `v${packageManifest.version}`) {
    throw new Error(
      `Release legal data requires sourceRef v${packageManifest.version}; ` +
      'the release process must sign that exact tag before building the binary'
    );
  }
  if (!isRelease && sourceRef !== null) {
    throw new Error('Development legal data must not claim an exact source tag');
  }

  const groups = new Map();
  for (const coordinate of shipping.components) {
    const holder = holderFor(coordinate);
    if (!groups.has(holder.holder)) {
      groups.set(holder.holder, {...holder, artifacts: []});
    }
    groups.get(holder.holder).artifacts.push(coordinate);
  }

  const components = [...groups.values()]
    .map(group => ({...group, artifacts: [...group.artifacts].sort()}))
    .sort((left, right) => left.holder.localeCompare(right.holder));

  return {
    disclaimer: DISCLAIMER,
    nonAffiliation: NON_AFFILIATION,
    project: {
      name: 'RotorLens',
      creator: packageManifest.author.name,
      attribution: `RotorLens was originally created by ${packageManifest.author.name}.`,
      copyright: 'Copyright (c) 2026 Michael Wallace and contributors',
      license: packageManifest.license,
      repository,
      sourceVersion: packageManifest.version,
      sourceRef,
      sourceLabel: sourceRef ?? 'official development repository',
      sourceStatus: sourceRef
        ? `Release source pinned to exact tag ${sourceRef}.`
        : `Development build ${packageManifest.version} — unreleased; no exact source tag has been published.`,
      sourceUrl: sourceRef ? `${repository}/tree/${sourceRef}` : repository
    },
    engine: {
      name: decision.adopted.name,
      location: decision.adopted.location,
      license: decision.adopted.license,
      copyright: decision.adopted.copyright
    },
    componentsByPlatform: {
      android: components,
      ios: [],
      web: []
    },
    licenseTexts: {'MPL-2.0': mpl, 'Apache-2.0': apache}
  };
}

/**
 * Renders the module source.
 *
 * `JSON.stringify` rather than template literals for every value, so a copyright
 * line containing a quote or a backslash cannot break the file it is written
 * into — or, worse, produce a file that parses and says something else.
 */
export function renderLegalModule(data) {
  return `/**
 * Generated by tools/generate-legal.mjs — do not edit.
 *
 * Regenerate with \`npm run legal:generate\` after any dependency change and
 * commit the result. The provenance test fails if this file drifts from the
 * resolved classpath in android/shipping-dependencies.json.
 */

export const LEGAL = ${JSON.stringify(data, null, 2)};
`;
}

export async function generateLegalModule() {
  const source = renderLegalModule(await buildLegalData());
  await writeFile(path.join(projectRoot, 'ui', 'legal-data.mjs'), source, 'utf8');
  return source;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = await generateLegalModule();
  process.stdout.write(`ui/legal-data.mjs — ${source.length} bytes\n`);
}
