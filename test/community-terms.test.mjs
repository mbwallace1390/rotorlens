import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  buildCommunityTermsDigest,
  DRAFT_COMMUNITY_MANUAL_CONSENT_VERSION,
  DRAFT_COMMUNITY_MANUAL_LICENCE_VERSION,
  DRAFT_COMMUNITY_TERMS_REGISTRY,
  DRAFT_COMMUNITY_TERMS_SHA256,
  SUPPORTED_COMMUNITY_CONSENT_VERSIONS,
  SUPPORTED_COMMUNITY_LICENCE_VERSIONS
} from '../src/analysis/community-contract.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function projectText(file) {
  return readFile(path.join(projectRoot, file), 'utf8');
}

test('draft community terms are immutable but cannot authorize production intake', async () => {
  const terms = await projectText('docs/COMMUNITY_CONTRIBUTION_TERMS.md');

  assert.deepEqual(SUPPORTED_COMMUNITY_CONSENT_VERSIONS, []);
  assert.deepEqual(SUPPORTED_COMMUNITY_LICENCE_VERSIONS, []);
  assert.equal(buildCommunityTermsDigest(terms), DRAFT_COMMUNITY_TERMS_SHA256);
  assert.deepEqual(DRAFT_COMMUNITY_TERMS_REGISTRY, [{
    consentVersion: DRAFT_COMMUNITY_MANUAL_CONSENT_VERSION,
    licenceVersion: DRAFT_COMMUNITY_MANUAL_LICENCE_VERSION,
    termsDigest: DRAFT_COMMUNITY_TERMS_SHA256,
    canonicalization: 'utf8-lf-single-trailing-newline-v1',
    status: 'engineering-draft'
  }]);
  assert.ok(terms.includes(
    `consent: \`${DRAFT_COMMUNITY_MANUAL_CONSENT_VERSION}\``
  ));
  assert.ok(terms.includes(
    `licence: \`${DRAFT_COMMUNITY_MANUAL_LICENCE_VERSION}\``
  ));
  assert.match(terms, /production\s+consent and licence registries are empty/i);
  assert.match(terms, /No real contribution may be solicited or accepted/i);

  for (const disclosure of [
    'pseudonymous aircraft and contribution identifiers',
    'board target',
    'firmware revision',
    'rate-curve fingerprint',
    'installed gains',
    'per-axis headspeed',
    'hold, stop, tracking',
    'vibration',
    'rotor diameter in millimetres',
    'blade count',
    'power type',
    'servo size classes',
    'filter and governor',
    'mechanical-safety result',
    'whether any community',
    'baseline contribution',
    'P/I term'
  ]) {
    assert.ok(terms.includes(disclosure), `manual terms omit: ${disclosure}`);
  }

  assert.match(terms, /raw flight log[\s\S]+craft name[\s\S]+GPS\/location/);
  assert.match(terms, /non-exclusive, worldwide, royalty-free licence/);
  assert.match(terms, /free releases and releases offered for a fee/);
  assert.match(terms, /Individual contribution envelopes are not licensed for public release/);
  assert.match(terms, /receipt must not be embedded in the model input/);
  assert.match(terms, /Terms SHA-256: <exact digest from the adopted version registry>/);
});

test('the narrower in-app local-sharing choice is not community-corpus consent', async () => {
  const app = await projectText('ui/app.mjs');
  const design = await projectText('docs/SHARED_CORPUS_DESIGN.md');
  const match = app.match(/const SHARING_TERMS_VERSION = '([^']+)'/);

  assert.ok(match, 'the app sharing terms version is missing');
  assert.equal(match[1], '2026-08-14');
  assert.ok(!SUPPORTED_COMMUNITY_CONSENT_VERSIONS.includes(match[1]));
  assert.ok(!SUPPORTED_COMMUNITY_LICENCE_VERSIONS.includes(match[1]));
  assert.match(design, /COMMUNITY_CONTRIBUTION_TERMS\.md/);
  assert.match(design, /app's narrower `2026-08-14` local-sharing choice is also rejected/);
});
