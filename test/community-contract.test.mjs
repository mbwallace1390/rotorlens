import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

import {
  AIRFRAME_PROFILE_LIMITS,
  AIRFRAME_SAFETY_STATES,
  COMMUNITY_CONTRIBUTION_FIELDS,
  COMMUNITY_CONTRIBUTION_KIND,
  COMMUNITY_CONTRIBUTION_SCHEMA_VERSION,
  COMMUNITY_CONFIG_FINGERPRINT_KEY_PREFIXES,
  COMMUNITY_CONFIG_FINGERPRINT_KINDS,
  COMMUNITY_CONFIG_FINGERPRINT_LIMITS,
  COMMUNITY_CONFIG_FINGERPRINT_COVERAGE,
  COMMUNITY_CONFIG_FINGERPRINT_REQUIRED_KEYS,
  COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_VERSION,
  COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_STATUS,
  COMMUNITY_MEASUREMENT_LIMITS,
  COMMUNITY_CONTROLLED_TRIAL_KIND,
  COMMUNITY_ELIGIBILITY,
  COMMUNITY_EXTRACTOR_VERSION,
  COMMUNITY_TERMS_CANONICALIZATION,
  DRAFT_COMMUNITY_CONSENT_VERSIONS,
  DRAFT_COMMUNITY_LICENCE_VERSIONS,
  DRAFT_COMMUNITY_MANUAL_CONSENT_VERSION,
  DRAFT_COMMUNITY_MANUAL_LICENCE_VERSION,
  DRAFT_COMMUNITY_TERMS_REGISTRY,
  DRAFT_COMMUNITY_TERMS_SHA256,
  COMMUNITY_TRIAL_AXES,
  COMMUNITY_TRIAL_DIRECTIONS,
  COMMUNITY_TRIAL_KINDS,
  COMMUNITY_TRIAL_TERMS,
  GUIDANCE_SOURCES,
  HEADSPEED_BAND_RATIO,
  POWER_TYPES,
  ROTOR_DIAMETER_BAND_SIZE_MM,
  SERVO_CLASSES,
  SUPPORTED_COMMUNITY_BOARD_IDENTIFIERS,
  SUPPORTED_COMMUNITY_CONSENT_VERSIONS,
  SUPPORTED_COMMUNITY_FIRMWARE_TARGETS,
  SUPPORTED_COMMUNITY_LICENCE_VERSIONS,
  SUPPORTED_COMMUNITY_ROTORFLIGHT_MINOR_VERSIONS,
  SUPPORTED_COMMUNITY_GUIDANCE_MODEL_VERSIONS,
  SUPPORTED_LOCAL_GUIDANCE_MODEL_VERSIONS,
  axisHeadspeedBandIndices,
  auditCommunityContribution,
  buildCommunityConfigFingerprint,
  buildCommunityCohortKey,
  buildCommunityContribution,
  buildCommunityTermsDigest,
  canonicalizeCommunityTermsText,
  communityCohortKey,
  canonicalCommunityConfigFingerprintPreimage,
  headspeedBandIndex,
  isCommunityBoardIdentifier,
  isCommunityConfigFingerprintPreimage,
  isCommunityContributionId,
  isCommunityLegalVersionToken,
  isGuidanceModelVersion,
  isGuidanceModelVersionToken,
  isSha256Fingerprint,
  isSupportedCommunityConsentVersion,
  isSupportedCommunityLicenceVersion,
  isSupportedRotorflightRevision,
  isSupportedGuidanceModelVersion,
  normalizeAirframeProfile,
  normalizeCommunityContributionId,
  normalizeCommunityLegalVersion,
  normalizeConfigFingerprints,
  normalizeCommunityTrial,
  normalizeGuidance,
  normalizeSafetyAssessment,
  normalizeSha256Fingerprint,
  rotorDiameterBandMm
} from '../src/analysis/community-contract.mjs';
import {
  addFlightRecord,
  buildFlightRecord,
  createHistory,
  shareableRecord
} from '../src/analysis/flight-history.mjs';
import {FlightWindowBasis} from '../src/analysis/flight-window.mjs';

const digestBody = character => `${character.repeat(42)}A`;
const FILTER_FINGERPRINT = `sha256:${digestBody('A')}`;
const GOVERNOR_FINGERPRINT = `sha256:${digestBody('b')}`;
const CONTRIBUTION_ID = `hmac-sha256:${digestBody('C')}`;
const BASELINE_CONTRIBUTION_ID = `hmac-sha256:${digestBody('D')}`;
const SHARING_ID = '01234-56789-abcde-fghjk';

function storedRecord() {
  const headers = {
    'Craft name': 'M7R test ship',
    'Board information': 'FRSK VANTAC_RF007',
    'Firmware revision': 'Rotorflight 4.6.0 (118e912) STM32F7X2',
    rates_type: '4',
    rc_rates: '5,5,12',
    rc_expo: '30,30,50',
    rates: '10,10,25',
    rollPID: '52,105,0,100,0',
    pitchPID: '64,111,40,100,0',
    yawPID: '315,145,29,3,1'
  };
  const session = {
    headers,
    craftName: headers['Craft name'],
    board: headers['Board information'],
    firmware: {revision: headers['Firmware revision']}
  };
  const axes = Object.fromEntries(
    ['roll', 'pitch', 'yaw'].map(axis => [axis, {headspeedMedianRpm: 2050}])
  );
  const built = buildFlightRecord({
    session,
    window: {basis: FlightWindowBasis.DETECTED, startUs: 10_000_000, endUs: 130_000_000},
    axes
  });
  return addFlightRecord(createHistory(), built).records[0];
}

function validContribution(overrides = {}) {
  const stored = storedRecord();
  const built = buildCommunityContribution({
    consentVersion: DRAFT_COMMUNITY_MANUAL_CONSENT_VERSION,
    licenceVersion: DRAFT_COMMUNITY_MANUAL_LICENCE_VERSION,
    contributionId: CONTRIBUTION_ID,
    airframeProfile: {
      rotorDiameterMm: 1500,
      bladeCount: 2,
      powerType: 'electric',
      cyclicServoClass: 'standard',
      tailServoClass: 'mini'
    },
    configFingerprints: {
      schemaVersion: COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_VERSION,
      filter: FILTER_FINGERPRINT,
      governor: GOVERNOR_FINGERPRINT
    },
    safetyAssessment: {airframe: 'clear'},
    guidance: {source: 'manual', modelVersion: null, communityInfluenced: false},
    trial: null,
    shareableRecord: shareableRecord(stored, SHARING_ID),
    ...overrides
  });
  return {stored, contribution: built};
}

function mutable(value) {
  if (Array.isArray(value)) {
    return value.map(mutable);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mutable(child)]));
  }
  return value;
}

function changed(base, path, value) {
  const copy = mutable(base);
  const fields = path.split('.');
  let owner = copy;
  for (const field of fields.slice(0, -1)) {
    owner = owner[field];
  }
  owner[fields.at(-1)] = value;
  return copy;
}

const DRAFT_LEGAL_BLOCKER_CODES = Object.freeze([
  'CONSENT_VERSION_NOT_ADOPTED',
  'LICENCE_VERSION_NOT_ADOPTED'
]);

function assertOnlyDraftLegalViolations(audit) {
  assert.deepEqual(
    audit.violations.map(violation => violation.code).sort(),
    [...DRAFT_LEGAL_BLOCKER_CODES].sort(),
    JSON.stringify(audit.violations)
  );
  assert.ok(audit.codes.includes('CONFIG_FINGERPRINT_SCHEMA_INCOMPLETE'));
  assert.equal(
    audit.violations.some(violation =>
      violation.code === 'CONFIG_FINGERPRINT_SCHEMA_INCOMPLETE'),
    false,
    'incomplete fingerprint coverage is a measurement-only/cohort blocker, not malformed data'
  );
  assert.equal(audit.cohortEligible, false);
  assert.equal(audit.adviceEligible, false);
}

test('a fixed draft contribution is deeply frozen but production-ineligible', () => {
  const {stored, contribution} = validContribution();
  const audit = auditCommunityContribution(contribution, stored);

  assert.equal(contribution.kind, COMMUNITY_CONTRIBUTION_KIND);
  assert.equal(contribution.schemaVersion, COMMUNITY_CONTRIBUTION_SCHEMA_VERSION);
  assert.equal(contribution.extractorVersion, COMMUNITY_EXTRACTOR_VERSION);
  assert.deepEqual(Object.keys(contribution), [
    'schemaVersion',
    'kind',
    'extractorVersion',
    'consentVersion',
    'licenceVersion',
    'contributionId',
    'airframeProfile',
    'configFingerprints',
    'safetyAssessment',
    'guidance',
    'trial',
    'shareableRecord'
  ]);
  assert.deepEqual(Object.keys(contribution.configFingerprints), [
    'schemaVersion', 'filter', 'governor'
  ]);
  assert.deepEqual(Object.keys(contribution.guidance), [
    'source', 'modelVersion', 'communityInfluenced'
  ]);
  assert.equal(audit.ok, false);
  assert.equal(audit.measurementEligible, false);
  assert.equal(audit.cohortEligible, false);
  assert.equal(audit.adviceEligible, false);
  assert.equal(audit.eligibility, COMMUNITY_ELIGIBILITY.REJECTED);
  assert.equal(audit.cohortKey, null);
  assertOnlyDraftLegalViolations(audit);

  for (const value of [
    contribution,
    contribution.airframeProfile,
    contribution.configFingerprints,
    contribution.safetyAssessment,
    contribution.guidance,
    contribution.trial,
    contribution.shareableRecord,
    contribution.shareableRecord.axes,
    contribution.shareableRecord.axes.roll,
    contribution.shareableRecord.axes.roll.hold,
    audit,
    audit.codes,
    audit.violations
  ]) {
    assert.equal(Object.isFrozen(value), true, 'every returned object/array must be frozen');
  }

  assert.deepEqual(Object.keys(COMMUNITY_CONTRIBUTION_FIELDS).sort(), [
    'airframeProfile',
    'airframeProfile.bladeCount',
    'airframeProfile.cyclicServoClass',
    'airframeProfile.powerType',
    'airframeProfile.rotorDiameterMm',
    'airframeProfile.tailServoClass',
    'configFingerprints',
    'configFingerprints.filter',
    'configFingerprints.governor',
    'configFingerprints.schemaVersion',
    'consentVersion',
    'contributionId',
    'extractorVersion',
    'guidance',
    'guidance.communityInfluenced',
    'guidance.modelVersion',
    'guidance.source',
    'kind',
    'licenceVersion',
    'safetyAssessment',
    'safetyAssessment.airframe',
    'schemaVersion',
    'shareableRecord',
    'trial',
    'trial.baselineContributionId',
    'trial.intendedAxis',
    'trial.intendedDirection',
    'trial.intendedTerm',
    'trial.kind'
  ]);
});

test('normalizers accept only closed values, strict hashes and registered legal receipts', () => {
  assert.deepEqual(normalizeAirframeProfile({
    rotorDiameterMm: 1500,
    bladeCount: 3,
    powerType: ' ELECTRIC ',
    cyclicServoClass: 'Mini',
    tailServoClass: ' LARGE-SCALE '
  }), {
    rotorDiameterMm: 1500,
    bladeCount: 3,
    powerType: 'electric',
    cyclicServoClass: 'mini',
    tailServoClass: 'large-scale'
  });
  assert.ok(POWER_TYPES.includes('nitro'));
  assert.ok(SERVO_CLASSES.includes('standard'));
  assert.ok(GUIDANCE_SOURCES.includes('rotorlens-community'));

  assert.equal(isSha256Fingerprint(FILTER_FINGERPRINT), true);
  assert.equal(normalizeSha256Fingerprint(` ${FILTER_FINGERPRINT} `), FILTER_FINGERPRINT);
  assert.equal(isSha256Fingerprint(`sha256:${'A'.repeat(42)}`), false);
  assert.equal(isSha256Fingerprint(`sha256:${'A'.repeat(43)}=`), false);
  assert.equal(isSha256Fingerprint(`sha256:${'A'.repeat(42)}B`), false,
    'non-canonical last bits must not create a second spelling for one digest');
  for (const finalCharacter of 'AEIMQUYcgkosw048') {
    assert.equal(isSha256Fingerprint(`sha256:${'A'.repeat(42)}${finalCharacter}`), true);
  }
  assert.equal(isSha256Fingerprint(`md5:${'A'.repeat(43)}`), false);
  assert.equal(normalizeSha256Fingerprint('not a hash'), null);

  assert.equal(isCommunityContributionId(CONTRIBUTION_ID), true);
  assert.equal(normalizeCommunityContributionId(` ${CONTRIBUTION_ID} `), CONTRIBUTION_ID);
  assert.equal(isCommunityContributionId(`hmac-sha256:${'C'.repeat(42)}B`), false);
  assert.equal(isCommunityContributionId(FILTER_FINGERPRINT), false,
    'a plain digest is not a keyed dedupe id');

  assert.equal(isCommunityLegalVersionToken(DRAFT_COMMUNITY_MANUAL_CONSENT_VERSION), true);
  assert.equal(isCommunityLegalVersionToken('2026-08-14'), true,
    'syntax alone is deliberately weaker than registry acceptance');
  assert.equal(isCommunityLegalVersionToken('Alice accepted this'), false);
  assert.equal(
    normalizeCommunityLegalVersion(` ${DRAFT_COMMUNITY_MANUAL_CONSENT_VERSION} `),
    DRAFT_COMMUNITY_MANUAL_CONSENT_VERSION
  );
  assert.deepEqual(DRAFT_COMMUNITY_CONSENT_VERSIONS, [
    'community-manual-consent-2026-08-14-v1'
  ]);
  assert.deepEqual(DRAFT_COMMUNITY_LICENCE_VERSIONS, [
    'community-manual-licence-2026-08-14-v1'
  ]);
  assert.deepEqual(SUPPORTED_COMMUNITY_CONSENT_VERSIONS, []);
  assert.deepEqual(SUPPORTED_COMMUNITY_LICENCE_VERSIONS, []);
  assert.equal(isSupportedCommunityConsentVersion(DRAFT_COMMUNITY_MANUAL_CONSENT_VERSION),
    false);
  assert.equal(isSupportedCommunityConsentVersion('2026-08-14'), false);
  assert.equal(isSupportedCommunityConsentVersion('community-manual-consent-2099-01-01-v1'),
    false);
  assert.equal(isSupportedCommunityLicenceVersion(DRAFT_COMMUNITY_MANUAL_LICENCE_VERSION),
    false);
  assert.equal(isSupportedCommunityLicenceVersion('2026-08-14'), false);

  assert.throws(() => normalizeConfigFingerprints({
    filter: FILTER_FINGERPRINT,
    governor: 'free text'
  }), TypeError);
  assert.deepEqual(normalizeGuidance(), {
    source: 'unknown',
    modelVersion: null,
    communityInfluenced: null
  });
  assert.deepEqual(normalizeSafetyAssessment(), {airframe: 'not-measured'});
  assert.deepEqual(normalizeSafetyAssessment({airframe: ' ATTENTION '}), {
    airframe: 'attention'
  });
  assert.throws(() => normalizeSafetyAssessment('attention'), TypeError);
  assert.deepEqual(AIRFRAME_SAFETY_STATES, [
    'clear', 'attention', 'insufficient', 'not-measured'
  ]);
  assert.throws(() => normalizeGuidance({
    source: ' ROTORLENS-COMMUNITY ',
    modelVersion: ' community-2026.08.14 ',
    communityInfluenced: true
  }), TypeError);
  assert.deepEqual(SUPPORTED_LOCAL_GUIDANCE_MODEL_VERSIONS,
    ['rotorlens-local-rules-v1']);
  assert.deepEqual(SUPPORTED_COMMUNITY_GUIDANCE_MODEL_VERSIONS, []);
  assert.equal(isGuidanceModelVersion('rotorlens-local-rules-v1'), true);
  assert.equal(isSupportedGuidanceModelVersion(
    'rotorlens-local',
    'rotorlens-local-rules-v1'
  ), true);
  assert.equal(isGuidanceModelVersion('Alice_Smith'), false);
  assert.equal(isGuidanceModelVersionToken('Alice_Smith'), true,
    'machine-token syntax is not release registration');
  assert.equal(isGuidanceModelVersion('community-2026.08.14'), false);
  assert.equal(isGuidanceModelVersion('pilot said this felt good'), false);
  assert.equal(ROTOR_DIAMETER_BAND_SIZE_MM, 50);
  assert.equal(rotorDiameterBandMm(690), 700);
  assert.equal(rotorDiameterBandMm(700), 700);
  assert.equal(rotorDiameterBandMm(724), 700);
  assert.equal(rotorDiameterBandMm(725), 750);
  assert.equal(rotorDiameterBandMm(149), null);
  assert.equal(HEADSPEED_BAND_RATIO, 1.05);
  assert.equal(headspeedBandIndex(0), null);
  assert.equal(headspeedBandIndex(100_001), null);
  assert.notEqual(headspeedBandIndex(951), headspeedBandIndex(1049));
  for (const rpm of [200, 951, 2050, 20_000]) {
    const index = headspeedBandIndex(rpm);
    const lower = HEADSPEED_BAND_RATIO ** index;
    const upper = HEADSPEED_BAND_RATIO ** (index + 1);
    assert.ok(upper / lower <= HEADSPEED_BAND_RATIO + Number.EPSILON * 8);
  }
  assert.deepEqual(axisHeadspeedBandIndices({
    axes: {
      roll: {headspeedMedianRpm: 1980},
      pitch: {headspeedMedianRpm: 2010},
      yaw: {headspeedMedianRpm: 2050}
    }
  }), {
    roll: headspeedBandIndex(1980),
    pitch: headspeedBandIndex(2010),
    yaw: headspeedBandIndex(2050)
  });
  assert.equal(axisHeadspeedBandIndices({axes: {}}), null);
  assert.deepEqual(SUPPORTED_COMMUNITY_BOARD_IDENTIFIERS, ['FRSK VANTAC_RF007', 'NEXUS']);
  assert.deepEqual(SUPPORTED_COMMUNITY_ROTORFLIGHT_MINOR_VERSIONS,
    ['4.3', '4.4', '4.5', '4.6']);
  assert.deepEqual(SUPPORTED_COMMUNITY_FIRMWARE_TARGETS, ['STM32F7X2']);
  assert.equal(isCommunityBoardIdentifier('FRSK VANTAC_RF007'), true);
  assert.equal(isCommunityBoardIdentifier('NEXUS'), true);
  assert.equal(isCommunityBoardIdentifier('ALICE HOME 5551234567'), false);
  assert.equal(isSupportedRotorflightRevision(
    'Rotorflight 4.6.0 (118e912) STM32F7X2'
  ), true);
  assert.equal(isSupportedRotorflightRevision('4.6.0'), false);
  assert.equal(isSupportedRotorflightRevision('Rotorflight 4.7.0 (118e912) STM32F7X2'), false);
});

test('prototype configuration fingerprints are canonical but explicitly incomplete', () => {
  assert.equal(COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_VERSION, 1);
  assert.equal(COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_STATUS, 'incomplete');
  assert.equal(COMMUNITY_CONFIG_FINGERPRINT_COVERAGE, 'incomplete');
  assert.deepEqual(COMMUNITY_CONFIG_FINGERPRINT_REQUIRED_KEYS, {
    filter: null,
    governor: null
  });
  assert.deepEqual(COMMUNITY_CONFIG_FINGERPRINT_KINDS, ['filter', 'governor']);
  assert.deepEqual(COMMUNITY_CONFIG_FINGERPRINT_KEY_PREFIXES, {
    filter: ['gyro_', 'dterm_', 'dyn_notch_', 'rpm_filter_'],
    governor: ['gov_']
  });
  assert.equal(COMMUNITY_CONFIG_FINGERPRINT_LIMITS.maximumSettingCount, 256);

  const first = {
    schemaVersion: 1,
    kind: 'filter',
    settings: {
      rpm_filter_enabled: true,
      gyro_lpf1_hz: 100,
      dterm_lpf1_type: 'PT1'
    }
  };
  const reordered = {
    schemaVersion: 1,
    kind: 'filter',
    settings: {
      dterm_lpf1_type: 'PT1',
      gyro_lpf1_hz: 100,
      rpm_filter_enabled: true
    }
  };
  const expectedPreimage = '{"schemaVersion":1,"kind":"filter",'
    + '"coverage":"incomplete","requiredKeys":null,"settings":'
    + '[["dterm_lpf1_type","string:PT1"],["gyro_lpf1_hz","number:100"],'
    + '["rpm_filter_enabled","boolean:true"]]}';
  assert.equal(canonicalCommunityConfigFingerprintPreimage(first), expectedPreimage);
  assert.equal(canonicalCommunityConfigFingerprintPreimage(reordered), expectedPreimage);
  assert.equal(buildCommunityConfigFingerprint(first),
    'sha256:k-P3A1RGlLsyEZqEfgcOB2AUxsq7At2tPE-UNNqKRNQ');
  assert.equal(buildCommunityConfigFingerprint(reordered),
    buildCommunityConfigFingerprint(first));
  assert.equal(isCommunityConfigFingerprintPreimage(first), true);

  const invalid = [
    {...first, schemaVersion: 2},
    {...first, kind: 'pid'},
    {...first, extra: true},
    {...first, settings: {}},
    {...first, settings: {pilot_name: 'Alice'}},
    {...first, settings: {gyro_: 100}},
    {...first, settings: {gyro_owner: 'Alice Smith'}},
    {...first, settings: {gyro_lpf1_hz: '100'}},
    {...first, settings: {gyro_enabled: 'true'}},
    {...first, settings: {gyro_lpf1_hz: Number.NaN}},
    {...first, settings: {gyro_lpf1_hz: Infinity}},
    {...first, settings: {gyro_lpf1_hz: {value: 100}}},
    {schemaVersion: 1, kind: 'governor', settings: {gyro_lpf1_hz: 100}}
  ];
  for (const candidate of invalid) {
    assert.equal(isCommunityConfigFingerprintPreimage(candidate), false);
    assert.throws(() => canonicalCommunityConfigFingerprintPreimage(candidate), TypeError);
    assert.throws(() => buildCommunityConfigFingerprint(candidate), TypeError);
  }

  const governor = {
    schemaVersion: 1,
    kind: 'governor',
    settings: {gov_mode: 'STANDARD', gov_gain: 40}
  };
  assert.equal(isCommunityConfigFingerprintPreimage(governor), true);
  assert.notEqual(buildCommunityConfigFingerprint(governor),
    buildCommunityConfigFingerprint(first), 'kind and version are part of the digest preimage');
});

test('draft terms registry pins canonical LF UTF-8 text without implying adoption', () => {
  const text = readFileSync(
    new URL('../docs/COMMUNITY_CONTRIBUTION_TERMS.md', import.meta.url),
    'utf8'
  );
  assert.equal(COMMUNITY_TERMS_CANONICALIZATION, 'utf8-lf-single-trailing-newline-v1');
  assert.equal(DRAFT_COMMUNITY_TERMS_SHA256,
    'sha256:VPBH98sdQugoUqfvVD8XfbflhuTBDyHqi7p7xG2002c');
  assert.equal(isSha256Fingerprint(DRAFT_COMMUNITY_TERMS_SHA256), true);
  assert.equal(buildCommunityTermsDigest(text), DRAFT_COMMUNITY_TERMS_SHA256);
  assert.equal(
    canonicalizeCommunityTermsText('first\r\nsecond\r\n\r\n'),
    'first\nsecond\n'
  );
  assert.deepEqual(DRAFT_COMMUNITY_TERMS_REGISTRY, [{
    consentVersion: DRAFT_COMMUNITY_MANUAL_CONSENT_VERSION,
    licenceVersion: DRAFT_COMMUNITY_MANUAL_LICENCE_VERSION,
    termsDigest: DRAFT_COMMUNITY_TERMS_SHA256,
    canonicalization: COMMUNITY_TERMS_CANONICALIZATION,
    status: 'engineering-draft'
  }]);
  assert.equal(Object.isFrozen(DRAFT_COMMUNITY_TERMS_REGISTRY), true);
  assert.equal(Object.isFrozen(DRAFT_COMMUNITY_TERMS_REGISTRY[0]), true);
  assert.throws(() => buildCommunityTermsDigest(new Uint8Array()), TypeError);
});

test('missing or incomplete fingerprints can never make a production cohort', () => {
  for (const fingerprints of [
    {schemaVersion: 1, filter: null, governor: GOVERNOR_FINGERPRINT},
    {schemaVersion: 1, filter: FILTER_FINGERPRINT, governor: null},
    {schemaVersion: 1, filter: null, governor: null}
  ]) {
    const {stored, contribution: base} = validContribution();
    const contribution = changed(base, 'configFingerprints', fingerprints);
    const audit = auditCommunityContribution(contribution, stored);

    assert.equal(audit.ok, false);
    assert.equal(audit.measurementEligible, false);
    assert.equal(audit.cohortEligible, false);
    assert.equal(audit.adviceEligible, false);
    assert.equal(audit.eligibility, COMMUNITY_ELIGIBILITY.REJECTED);
    assert.equal(audit.cohortKey, null);
    assertOnlyDraftLegalViolations(audit);
    if (fingerprints.filter === null) {
      assert.ok(audit.codes.includes('FILTER_FINGERPRINT_MISSING'));
    }
    if (fingerprints.governor === null) {
      assert.ok(audit.codes.includes('GOVERNOR_FINGERPRINT_MISSING'));
    }
  }
});

test('mechanical state remains a closed cohort gate beneath the production blockers', () => {
  const {stored, contribution} = validContribution();
  const cases = [
    ['attention', 'AIRFRAME_SAFETY_ATTENTION'],
    ['insufficient', 'AIRFRAME_SAFETY_INSUFFICIENT'],
    ['not-measured', 'AIRFRAME_SAFETY_NOT_MEASURED']
  ];

  for (const [airframe, code] of cases) {
    const candidate = changed(contribution, 'safetyAssessment.airframe', airframe);
    const audit = auditCommunityContribution(candidate, stored);
    assert.equal(audit.ok, false);
    assert.equal(audit.measurementEligible, false);
    assert.equal(audit.cohortEligible, false);
    assert.equal(audit.adviceEligible, false);
    assert.equal(audit.eligibility, COMMUNITY_ELIGIBILITY.REJECTED);
    assert.equal(audit.cohortKey, null);
    assert.equal(buildCommunityCohortKey(candidate), null);
    assert.ok(audit.codes.includes(code), JSON.stringify(audit));
    assertOnlyDraftLegalViolations(audit);
  }

  const defaulted = validContribution({safetyAssessment: undefined});
  assert.deepEqual(defaulted.contribution.safetyAssessment, {airframe: 'not-measured'});
  assertOnlyDraftLegalViolations(
    auditCommunityContribution(defaulted.contribution, defaulted.stored)
  );
  assert.equal(
    auditCommunityContribution(defaulted.contribution, defaulted.stored).adviceEligible,
    false
  );

  for (const malformed of ['unsafe', 'clear because the pilot said so', null, 42]) {
    const audit = auditCommunityContribution(
      changed(contribution, 'safetyAssessment.airframe', malformed),
      stored
    );
    assert.equal(audit.ok, false, `${String(malformed)} was accepted`);
    assert.equal(audit.measurementEligible, false);
    assert.ok(audit.codes.includes('AIRFRAME_SAFETY_STATE_INVALID'), JSON.stringify(audit));
  }

  for (const malformedInput of ['clear', 42, []]) {
    assert.throws(
      () => validContribution({safetyAssessment: malformedInput}),
      TypeError,
      `builder accepted malformed ${typeof malformedInput} input`
    );
  }
});

test('an incomplete structured profile stays non-cohort, while malformed values fail closed', () => {
  const {stored, contribution: complete} = validContribution();
  const missing = changed(complete, 'airframeProfile.tailServoClass', null);
  const missingAudit = auditCommunityContribution(missing, stored);
  assert.equal(missingAudit.ok, false);
  assert.equal(missingAudit.eligibility, COMMUNITY_ELIGIBILITY.REJECTED);
  assert.ok(missingAudit.codes.includes('AIRFRAME_PROFILE_INCOMPLETE'));
  assertOnlyDraftLegalViolations(missingAudit);

  const invalid = [
    ['airframeProfile.rotorDiameterMm', AIRFRAME_PROFILE_LIMITS.minimumRotorDiameterMm - 1,
      'AIRFRAME_ROTOR_DIAMETER_INVALID'],
    ['airframeProfile.rotorDiameterMm', Infinity, 'AIRFRAME_ROTOR_DIAMETER_INVALID'],
    ['airframeProfile.rotorDiameterMm', 700.5, 'AIRFRAME_ROTOR_DIAMETER_INVALID'],
    ['airframeProfile.bladeCount', 9, 'AIRFRAME_BLADE_COUNT_INVALID'],
    ['airframeProfile.powerType', 'electric helicopter owned by Alice',
      'AIRFRAME_POWER_TYPE_INVALID'],
    ['airframeProfile.cyclicServoClass', 'fast blue servos',
      'AIRFRAME_CYCLIC_SERVO_CLASS_INVALID'],
    ['airframeProfile.tailServoClass', 42, 'AIRFRAME_TAIL_SERVO_CLASS_INVALID']
  ];
  for (const [path, value, code] of invalid) {
    const audit = auditCommunityContribution(changed(complete, path, value), stored);
    assert.equal(audit.ok, false, `${path}=${String(value)} was accepted`);
    assert.equal(audit.eligibility, COMMUNITY_ELIGIBILITY.REJECTED);
    assert.ok(audit.codes.includes(code), JSON.stringify(audit));
  }
});

test('builder rejects malformed supplied optional context instead of erasing it to null', () => {
  const cases = [
    {airframeProfile: {powerType: 'Alice electric helicopter'}},
    {airframeProfile: new Date('2026-08-14T00:00:00Z')},
    {airframeProfile: {bladeCount: undefined}},
    {airframeProfile: {pilotName: 'Alice'}},
    {configFingerprints: {filter: 'not-a-digest'}},
    {configFingerprints: {governor: undefined}},
    {safetyAssessment: {airframe: 'pilot says clear'}},
    {guidance: {source: 'my-friend'}},
    {guidance: {source: 'manual', modelVersion: 'model-should-not-be-here'}},
    {guidance: {source: 'manual', communityInfluenced: 'maybe'}},
    {guidance: {
      source: 'rotorlens-local',
      modelVersion: 'Alice_Smith',
      communityInfluenced: false
    }},
    {guidance: {
      source: 'rotorlens-community',
      modelVersion: 'community-1',
      communityInfluenced: true
    }},
    {guidance: {
      source: 'rotorlens-community',
      modelVersion: 'community-1',
      communityInfluenced: false
    }},
    {trial: {kind: 'none', intendedAxis: 'roll'}},
    {trial: {kind: 'rotorlens-controlled-v1', intendedAxis: 'roll'}}
  ];

  for (const overrides of cases) {
    assert.throws(() => validContribution(overrides), TypeError, JSON.stringify(overrides));
  }

  assert.deepEqual(normalizeAirframeProfile({powerType: null}), {
    rotorDiameterMm: null,
    bladeCount: null,
    powerType: null,
    cyclicServoClass: null,
    tailServoClass: null
  });
  assert.deepEqual(normalizeConfigFingerprints({filter: null}), {
    schemaVersion: COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_VERSION,
    filter: null,
    governor: null
  });
});

test('consent, licence, keyed dedupe id and every semantic version are mandatory', () => {
  const {stored, contribution} = validContribution();
  const cases = [
    ['schemaVersion', 99, 'CONTRIBUTION_SCHEMA_VERSION_MISMATCH'],
    ['kind', 'rotorlens-flight-record', 'CONTRIBUTION_KIND_MISMATCH'],
    ['extractorVersion', 2, 'EXTRACTOR_VERSION_MISMATCH'],
    ['consentVersion', null, 'CONSENT_VERSION_INVALID'],
    ['consentVersion', '2026-08-14', 'CONSENT_VERSION_INVALID'],
    ['consentVersion', 'community-manual-consent-2099-01-01-v1',
      'CONSENT_VERSION_INVALID'],
    ['licenceVersion', null, 'LICENCE_VERSION_INVALID'],
    ['licenceVersion', 'August 14 2026', 'LICENCE_VERSION_INVALID'],
    ['licenceVersion', '2026-08-14', 'LICENCE_VERSION_INVALID'],
    ['licenceVersion', 'community-manual-licence-2099-01-01-v1',
      'LICENCE_VERSION_INVALID'],
    ['configFingerprints.schemaVersion', 2,
      'CONFIG_FINGERPRINT_SCHEMA_VERSION_MISMATCH'],
    ['contributionId', `sha256:${'C'.repeat(43)}`, 'CONTRIBUTION_ID_INVALID'],
    ['contributionId', `hmac-sha256:${'C'.repeat(42)}`, 'CONTRIBUTION_ID_INVALID'],
    ['shareableRecord.schemaVersion', 1, 'SHAREABLE_RECORD_SCHEMA_VERSION_MISMATCH']
  ];

  for (const [path, value, code] of cases) {
    const audit = auditCommunityContribution(changed(contribution, path, value), stored);
    assert.equal(audit.ok, false, `${path}=${String(value)} was accepted`);
    assert.equal(audit.measurementEligible, false);
    assert.ok(audit.codes.includes(code), `${code}: ${JSON.stringify(audit)}`);
  }
});

test('guidance provenance is closed and all RotorLens guidance must name its model', () => {
  const {stored, contribution} = validContribution();
  const communityWithoutVersion = changed(contribution, 'guidance', {
    source: 'rotorlens-community',
    modelVersion: null,
    communityInfluenced: true
  });
  const missingAudit = auditCommunityContribution(communityWithoutVersion, stored);
  assert.equal(missingAudit.ok, false);
  assert.ok(missingAudit.codes.includes('COMMUNITY_GUIDANCE_MODEL_VERSION_MISSING'));

  const community = changed(contribution, 'guidance', {
    source: 'rotorlens-community',
    modelVersion: 'community-1.2.0',
    communityInfluenced: true
  });
  const communityAudit = auditCommunityContribution(community, stored);
  assert.equal(communityAudit.ok, false);
  assert.ok(communityAudit.codes.includes('COMMUNITY_GUIDANCE_MODEL_VERSION_UNSUPPORTED'));

  const localWithoutVersion = changed(contribution, 'guidance', {
    source: 'rotorlens-local',
    modelVersion: null,
    communityInfluenced: false
  });
  const localMissingAudit = auditCommunityContribution(localWithoutVersion, stored);
  assert.equal(localMissingAudit.ok, false);
  assert.ok(localMissingAudit.codes.includes('LOCAL_GUIDANCE_MODEL_VERSION_MISSING'));

  const local = changed(contribution, 'guidance', {
    source: 'rotorlens-local',
    modelVersion: 'rotorlens-local-rules-v1',
    communityInfluenced: false
  });
  assertOnlyDraftLegalViolations(auditCommunityContribution(local, stored));

  const inventedLocalModel = changed(local, 'guidance.modelVersion', 'Alice_Smith');
  assert.ok(auditCommunityContribution(inventedLocalModel, stored).codes
    .includes('LOCAL_GUIDANCE_MODEL_VERSION_UNSUPPORTED'));

  const freeText = changed(contribution, 'guidance.modelVersion', 'Alice tuned this at the park');
  const freeTextAudit = auditCommunityContribution(freeText, stored);
  assert.equal(freeTextAudit.ok, false);
  assert.ok(freeTextAudit.codes.includes('GUIDANCE_MODEL_VERSION_INVALID'));

  const inventedSource = changed(contribution, 'guidance.source', 'my-friend-bob');
  assert.ok(auditCommunityContribution(inventedSource, stored).codes
    .includes('GUIDANCE_SOURCE_INVALID'));

  const manualWithModel = changed(contribution, 'guidance.modelVersion', 'community-1');
  assert.ok(auditCommunityContribution(manualWithModel, stored).codes
    .includes('GUIDANCE_MODEL_VERSION_UNEXPECTED'));

  const unknownAncestry = changed(contribution, 'guidance.communityInfluenced', null);
  assertOnlyDraftLegalViolations(auditCommunityContribution(unknownAncestry, stored));
  const influencedManual = changed(contribution, 'guidance.communityInfluenced', true);
  assertOnlyDraftLegalViolations(auditCommunityContribution(influencedManual, stored));
  const invalidAncestry = changed(contribution, 'guidance.communityInfluenced', 'maybe');
  assert.ok(auditCommunityContribution(invalidAncestry, stored).codes
    .includes('GUIDANCE_COMMUNITY_ANCESTRY_INVALID'));
  const inconsistentCommunity = changed(community, 'guidance.communityInfluenced', false);
  assert.ok(auditCommunityContribution(inconsistentCommunity, stored).codes
    .includes('COMMUNITY_GUIDANCE_ANCESTRY_INCONSISTENT'));
});

test('controlled trial metadata links one declared P/I change to an exact baseline', () => {
  assert.equal(COMMUNITY_CONTROLLED_TRIAL_KIND, 'rotorlens-controlled-v1');
  assert.deepEqual(COMMUNITY_TRIAL_KINDS, ['none', 'rotorlens-controlled-v1']);
  assert.deepEqual(COMMUNITY_TRIAL_AXES, ['roll', 'pitch', 'yaw']);
  assert.deepEqual(COMMUNITY_TRIAL_TERMS, ['P', 'I']);
  assert.deepEqual(COMMUNITY_TRIAL_DIRECTIONS, ['increase', 'decrease']);
  assert.deepEqual(normalizeCommunityTrial(), {
    kind: 'none',
    baselineContributionId: null,
    intendedAxis: null,
    intendedTerm: null,
    intendedDirection: null
  });

  const controlled = normalizeCommunityTrial({
    kind: 'rotorlens-controlled-v1',
    baselineContributionId: BASELINE_CONTRIBUTION_ID,
    intendedAxis: 'pitch',
    intendedTerm: 'I',
    intendedDirection: 'increase'
  });
  assert.equal(Object.isFrozen(controlled), true);
  const {stored, contribution} = validContribution({trial: controlled});
  assertOnlyDraftLegalViolations(auditCommunityContribution(contribution, stored));

  const malformed = [
    ['trial.kind', 'free-form', 'TRIAL_KIND_INVALID'],
    ['trial.baselineContributionId', `hmac-sha256:${'D'.repeat(42)}B`,
      'TRIAL_BASELINE_CONTRIBUTION_ID_INVALID'],
    ['trial.intendedAxis', 'collective', 'TRIAL_AXIS_INVALID'],
    ['trial.intendedTerm', 'D', 'TRIAL_TERM_INVALID'],
    ['trial.intendedDirection', 'sideways', 'TRIAL_DIRECTION_INVALID']
  ];
  for (const [path, value, code] of malformed) {
    const audit = auditCommunityContribution(changed(contribution, path, value), stored);
    assert.equal(audit.ok, false, `${path}=${value} was accepted`);
    assert.ok(audit.codes.includes(code), JSON.stringify(audit));
  }

  const unexpected = changed(validContribution().contribution, 'trial.intendedAxis', 'roll');
  const unexpectedAudit = auditCommunityContribution(unexpected, stored);
  assert.equal(unexpectedAudit.ok, false);
  assert.ok(unexpectedAudit.codes.includes('TRIAL_DETAIL_UNEXPECTED'));
});

test('the fixed allowlist rejects additions at every contribution-owned level', () => {
  const {stored, contribution} = validContribution();
  const candidates = [
    [{...mutable(contribution), flightDate: '2026-08-14'}, 'flightDate'],
    [{...mutable(contribution), sourcePath: 'C:\\Users\\pilot\\flight.bbl'}, 'sourcePath'],
    [{...mutable(contribution), rawLog: 'base64 goes here'}, 'rawLog'],
    [{...mutable(contribution), gps: {latitude: 1, longitude: 2}}, 'gps'],
    [changed(contribution, 'airframeProfile', {
      ...mutable(contribution.airframeProfile), modelName: 'OMP M7R'
    }), 'airframeProfile.modelName'],
    [changed(contribution, 'configFingerprints', {
      ...mutable(contribution.configFingerprints), rawFilterSettings: 'gyro_lpf1=100'
    }), 'configFingerprints.rawFilterSettings'],
    [changed(contribution, 'safetyAssessment', {
      ...mutable(contribution.safetyAssessment), pilotNote: 'it sounded fine'
    }), 'safetyAssessment.pilotNote'],
    [changed(contribution, 'guidance', {
      ...mutable(contribution.guidance), pilotNote: 'felt good'
    }), 'guidance.pilotNote'],
    [changed(contribution, 'trial', {
      ...mutable(contribution.trial), pilotNote: 'changed P'
    }), 'trial.pilotNote'],
    [changed(contribution, 'shareableRecord', {
      ...mutable(contribution.shareableRecord), craftName: stored.craftName
    }), 'shareableRecord.craftName']
  ];

  for (const [candidate, path] of candidates) {
    const audit = auditCommunityContribution(candidate, stored);
    assert.equal(audit.ok, false, `${path} passed the fixed allowlist`);
    assert.ok(audit.violations.some(violation => violation.path === path),
      `${path}: ${JSON.stringify(audit.violations)}`);
  }
});

test('auditShareableRecord name-by-value protection is preserved by the wrapper', () => {
  const {stored, contribution} = validContribution();
  const leaked = changed(contribution, 'shareableRecord.board', stored.craftName);
  const audit = auditCommunityContribution(leaked, stored);

  assert.equal(audit.ok, false);
  assert.ok(audit.codes.includes('SHAREABLE_RECORD_AUDIT_FAILED'));
  assert.ok(audit.violations.some(violation =>
    violation.path === 'shareableRecord.board'
      && violation.reason.includes('craftName as a value')),
  JSON.stringify(audit.violations));
});

test('cohort equipment fields are canonical identifiers, not free-text channels', () => {
  const {stored, contribution} = validContribution();
  const malformed = [
    ['shareableRecord.board', 'pilot@example.com', 'SHAREABLE_BOARD_IDENTIFIER_INVALID'],
    ['shareableRecord.board', 'ALICE HOME 5551234567', 'SHAREABLE_BOARD_IDENTIFIER_INVALID'],
    ['shareableRecord.board', 'FRSK  VANTAC_RF007', 'SHAREABLE_BOARD_IDENTIFIER_INVALID'],
    ['shareableRecord.board', 'FRSK/VANTAC', 'SHAREABLE_BOARD_IDENTIFIER_INVALID'],
    ['shareableRecord.firmwareRevision', '4.6.0', 'SHAREABLE_FIRMWARE_REVISION_INVALID'],
    ['shareableRecord.firmwareRevision', 'Rotorflight 4.7.0 (118e912) STM32F7X2',
      'SHAREABLE_FIRMWARE_REVISION_INVALID'],
    ['shareableRecord.firmwareRevision', 'Rotorflight 4.6.0 Alice tuned this',
      'SHAREABLE_FIRMWARE_REVISION_INVALID'],
    ['shareableRecord.firmwareRevision',
      'Rotorflight 4.6.0-ALICE-HOME (118e912) STM32F7X2',
      'SHAREABLE_FIRMWARE_REVISION_INVALID'],
    ['shareableRecord.firmwareRevision', 'Rotorflight 4.6.0 (118E912) STM32F7X2',
      'SHAREABLE_FIRMWARE_REVISION_INVALID'],
    ['shareableRecord.firmwareRevision', 'Rotorflight 4.6.0 (118e912) STM32H743',
      'SHAREABLE_FIRMWARE_REVISION_INVALID']
  ];

  for (const [path, value, code] of malformed) {
    const audit = auditCommunityContribution(changed(contribution, path, value), stored);
    assert.equal(audit.ok, false, `${path}=${value} was accepted`);
    assert.ok(audit.codes.includes(code), JSON.stringify(audit));
  }

  for (const revision of [
    'Rotorflight 4.3.0 (118e912) STM32F7X2',
    'Rotorflight 4.4.1 (118e912) STM32F7X2',
    'Rotorflight 4.5.2 (118e912) STM32F7X2',
    'Rotorflight 4.6.0-RC3 (aabbccd) STM32F7X2'
  ]) {
    assert.equal(isSupportedRotorflightRevision(revision), true, revision);
  }
});

test('malformed copied statuses are rejected instead of becoming free-text channels', () => {
  const {stored, contribution} = validContribution();
  const candidates = [
    ['shareableRecord.axes.roll.hold.status', 'flown by Alice',
      'SHAREABLE_HOLD_STATUS_INVALID'],
    ['shareableRecord.axes.pitch.stop.status', 'looks good to me',
      'SHAREABLE_STOP_STATUS_INVALID']
  ];

  for (const [path, value, code] of candidates) {
    const audit = auditCommunityContribution(changed(contribution, path, value), stored);
    assert.equal(audit.ok, false);
    assert.ok(audit.codes.includes(code), JSON.stringify(audit));
  }
});

test('rate fingerprints require one type scalar and exactly three values for every axis list', () => {
  const {stored, contribution} = validContribution();
  const malformed = [
    'rf-rates-v2:4,4|5,5,12|30,30,50|10,10,25',
    'rf-rates-v2:4|5,5|30,30,50|10,10,25',
    'rf-rates-v2:4|5,5,12,12|30,30,50|10,10,25',
    'rf-rates-v2:4|5,5,12|30,30|10,10,25',
    'rf-rates-v2:4|5,5,12|30,30,50|10,10,25,25',
    'rf-rates-v2:4|5,5,alice|30,30,50|10,10,25',
    'rf-rates-v2:04|5,5,12|30,30,50|10,10,25',
    'rf-rates-v2:4.0|5,5,12|30,30,50|10,10,25',
    'rf-rates-v2:4|5,-5,12|30,30,50|10,10,25',
    'rf-rates-v2:4|5,5,12|30,30,50|10,10,1000001',
    'rf-rates-v2:21|5,5,12|30,30,50|10,10,25'
  ];

  for (const ratesFingerprint of malformed) {
    const audit = auditCommunityContribution(
      changed(contribution, 'shareableRecord.ratesFingerprint', ratesFingerprint),
      stored
    );
    assert.equal(audit.ok, false, `${ratesFingerprint} was accepted`);
    assert.ok(audit.codes.includes('RATES_FINGERPRINT_INVALID'), JSON.stringify(audit));
  }
});

test('non-finite, negative, impossible and internally inconsistent measurements fail closed', () => {
  const {stored, contribution} = validContribution();
  const candidates = [
    ['shareableRecord.durationSeconds', Infinity, 'SHAREABLE_DURATION_INVALID'],
    ['shareableRecord.durationSeconds', -1, 'SHAREABLE_DURATION_INVALID'],
    ['shareableRecord.ordinal', -1, 'SHAREABLE_ORDINAL_INVALID'],
    ['shareableRecord.gains.roll.0', Number.NaN, 'SHAREABLE_GAIN_VALUE_INVALID'],
    ['shareableRecord.gains.pitch.1', -5, 'SHAREABLE_GAIN_VALUE_INVALID'],
    ['shareableRecord.axes.roll.headspeedMedianRpm', Infinity, 'SHAREABLE_HEADSPEED_INVALID'],
    ['shareableRecord.axes.roll.noise.filteredHighFrequencyRmsDps', -0.1,
      'SHAREABLE_NOISE_MEASUREMENT_INVALID'],
    ['shareableRecord.axes.yaw.stop.positive.eventCount', 2.5,
      'SHAREABLE_EVIDENCE_COUNT_INVALID'],
    ['shareableRecord.axes.yaw.stop.negative.eventCount', null,
      'SHAREABLE_EVIDENCE_COUNT_INVALID']
  ];

  for (const [path, value, code] of candidates) {
    const audit = auditCommunityContribution(changed(contribution, path, value), stored);
    assert.equal(audit.ok, false, `${path}=${String(value)} was accepted`);
    assert.ok(audit.codes.includes(code), `${code}: ${JSON.stringify(audit)}`);
  }

  let inconsistent = changed(contribution, 'shareableRecord.axes.roll.hold.status', 'captured');
  inconsistent = changed(inconsistent, 'shareableRecord.axes.roll.hold.holdCount', 3);
  inconsistent = changed(inconsistent, 'shareableRecord.axes.roll.hold.zeroHoldCount', 2);
  inconsistent = changed(inconsistent, 'shareableRecord.axes.roll.hold.sustainedHoldCount', 2);
  const inconsistentAudit = auditCommunityContribution(inconsistent, stored);
  assert.equal(inconsistentAudit.ok, false);
  assert.ok(inconsistentAudit.codes.includes('SHAREABLE_HOLD_COUNTS_INCONSISTENT'));
});

test('malformed hashes reject and explicit null remains non-cohort', () => {
  const {stored, contribution} = validContribution();
  const malformed = changed(
    contribution,
    'configFingerprints.filter',
    `sha256:${'A'.repeat(42)}=`
  );
  const malformedAudit = auditCommunityContribution(malformed, stored);
  assert.equal(malformedAudit.ok, false);
  assert.ok(malformedAudit.codes.includes('FILTER_FINGERPRINT_INVALID'));

  const absent = changed(contribution, 'configFingerprints.filter', null);
  const absentAudit = auditCommunityContribution(absent, stored);
  assert.equal(absentAudit.ok, false);
  assert.equal(absentAudit.eligibility, COMMUNITY_ELIGIBILITY.REJECTED);
  assertOnlyDraftLegalViolations(absentAudit);
});

test('production cohort keys fail closed until terms and full config manifests are adopted', () => {
  const {stored, contribution} = validContribution();
  assert.equal(buildCommunityCohortKey(contribution), null);
  assert.equal(buildCommunityCohortKey(mutable(contribution)), null);
  assert.equal(communityCohortKey(contribution), null);
  assert.equal(auditCommunityContribution(contribution, stored).cohortKey, null);
  assertOnlyDraftLegalViolations(auditCommunityContribution(contribution, stored));

  const changedGovernor = changed(
    contribution,
    'configFingerprints.governor',
    `sha256:${digestBody('d')}`
  );
  assert.equal(buildCommunityCohortKey(changedGovernor), null);
  assert.equal(
    buildCommunityCohortKey(changed(contribution, 'configFingerprints.governor', null)),
    null
  );
  assert.equal(
    buildCommunityCohortKey(changed(contribution, 'shareableRecord.ratesFingerprint', null)),
    null
  );

  const nearbyDiameter = changed(contribution, 'airframeProfile.rotorDiameterMm', 1490);
  assert.equal(buildCommunityCohortKey(nearbyDiameter), null);
  assert.equal(rotorDiameterBandMm(1490), rotorDiameterBandMm(1500));

  const nearbyHeadspeed = mutable(contribution);
  for (const axis of ['roll', 'pitch', 'yaw']) {
    nearbyHeadspeed.shareableRecord.axes[axis].headspeedMedianRpm = 2070;
  }
  assert.equal(buildCommunityCohortKey(nearbyHeadspeed), null);
  assert.deepEqual(
    axisHeadspeedBandIndices(nearbyHeadspeed.shareableRecord),
    axisHeadspeedBandIndices(contribution.shareableRecord)
  );

  const distantHeadspeed = mutable(contribution);
  for (const axis of ['roll', 'pitch', 'yaw']) {
    distantHeadspeed.shareableRecord.axes[axis].headspeedMedianRpm = 2250;
  }
  assert.equal(buildCommunityCohortKey(distantHeadspeed), null);
  assert.notDeepEqual(
    axisHeadspeedBandIndices(distantHeadspeed.shareableRecord),
    axisHeadspeedBandIndices(contribution.shareableRecord)
  );

  const lowYaw = mutable(contribution);
  const highYaw = mutable(contribution);
  for (const axis of ['roll', 'pitch']) {
    lowYaw.shareableRecord.axes[axis].headspeedMedianRpm = 2000;
    highYaw.shareableRecord.axes[axis].headspeedMedianRpm = 2000;
  }
  lowYaw.shareableRecord.axes.yaw.headspeedMedianRpm = 1200;
  highYaw.shareableRecord.axes.yaw.headspeedMedianRpm = 2800;
  assert.notDeepEqual(
    axisHeadspeedBandIndices(lowYaw.shareableRecord),
    axisHeadspeedBandIndices(highYaw.shareableRecord),
    'yaw speed cannot disappear into a representative median');

  const rpm951 = mutable(contribution);
  const rpm1049 = mutable(contribution);
  for (const axis of ['roll', 'pitch', 'yaw']) {
    rpm951.shareableRecord.axes[axis].headspeedMedianRpm = 951;
    rpm1049.shareableRecord.axes[axis].headspeedMedianRpm = 1049;
  }
  assert.notDeepEqual(
    axisHeadspeedBandIndices(rpm951.shareableRecord),
    axisHeadspeedBandIndices(rpm1049.shareableRecord),
    'fixed absolute bands must not permit large ratios at low RPM');
});

test('non-object and partial contribution shapes are rejected without throwing', () => {
  for (const candidate of [null, undefined, [], 'payload', 42, {}, {
    kind: COMMUNITY_CONTRIBUTION_KIND
  }]) {
    const audit = auditCommunityContribution(candidate);
    assert.equal(audit.ok, false, JSON.stringify(candidate));
    assert.equal(audit.eligibility, COMMUNITY_ELIGIBILITY.REJECTED);
    assert.equal(audit.measurementEligible, false);
    assert.ok(audit.violations.length > 0);
    assert.equal(Object.isFrozen(audit), true);
  }
});

test('builder and audit contain cyclic or excessively deep input', () => {
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => validContribution({shareableRecord: cycle}), TypeError);

  const deep = {};
  let cursor = deep;
  for (let index = 0; index < 70; index += 1) {
    cursor.child = {};
    cursor = cursor.child;
  }
  assert.throws(() => validContribution({shareableRecord: deep}), TypeError);

  const {contribution} = validContribution();
  const cyclicContribution = mutable(contribution);
  cyclicContribution.shareableRecord.loop = cyclicContribution.shareableRecord;
  assert.doesNotThrow(() => auditCommunityContribution(cyclicContribution));
  const audit = auditCommunityContribution(cyclicContribution);
  assert.equal(audit.ok, false);
  assert.ok(audit.codes.includes('SHAREABLE_RECORD_AUDIT_FAILED'));

  const wideContribution = mutable(contribution);
  wideContribution.shareableRecord = {};
  for (let index = 0;
    index <= COMMUNITY_MEASUREMENT_LIMITS.maximumCloneNodes;
    index += 1) {
    wideContribution.shareableRecord[`field${index}`] = index;
  }
  const wideAudit = auditCommunityContribution(wideContribution);
  assert.equal(wideAudit.ok, false);
  assert.ok(wideAudit.codes.includes('SHAREABLE_RECORD_AUDIT_FAILED'));

  const widePrototype = {};
  for (let index = 0;
    index <= COMMUNITY_MEASUREMENT_LIMITS.maximumCloneNodes;
    index += 1) {
    widePrototype[`field${index}`] = index;
  }
  const inheritedWideContribution = mutable(contribution);
  inheritedWideContribution.shareableRecord =
    Object.create(widePrototype);
  const inheritedWideAudit = auditCommunityContribution(inheritedWideContribution);
  assert.equal(inheritedWideAudit.ok, false);
  assert.ok(inheritedWideAudit.codes.includes('SHAREABLE_RECORD_AUDIT_FAILED'));
});
