import {
  COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_VERSION,
  DRAFT_COMMUNITY_MANUAL_CONSENT_VERSION,
  DRAFT_COMMUNITY_MANUAL_LICENCE_VERSION,
  DRAFT_COMMUNITY_TERMS_SHA256,
  buildCommunityContribution
} from '../../../src/analysis/community-contract.mjs';
import {
  addFlightRecord,
  buildFlightRecord,
  createHistory,
  shareableRecord
} from '../../../src/analysis/flight-history.mjs';
import {FlightWindowBasis} from '../../../src/analysis/flight-window.mjs';

const digestBody = character => `${character.repeat(42)}A`;

export const TEST_CONTRIBUTION_ID = `hmac-sha256:${digestBody('C')}`;
export const TEST_DELETION_CAPABILITY = `rl-delete-v1:${digestBody('D')}`;
export const TEST_OTHER_DELETION_CAPABILITY = `rl-delete-v1:${digestBody('E')}`;
export const TEST_SHARING_ID = '01234-56789-abcde-fghjk';
export const TEST_OTHER_SHARING_ID = 'mnpqr-stvwx-yz012-34567';

export function buildDraftContribution(overrides = {}) {
  const headers = {
    'Craft name': 'private fixture name',
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
    window: {
      basis: FlightWindowBasis.DETECTED,
      startUs: 10_000_000,
      endUs: 130_000_000
    },
    axes
  });
  const stored = addFlightRecord(createHistory(), built).records[0];
  return buildCommunityContribution({
    consentVersion: DRAFT_COMMUNITY_MANUAL_CONSENT_VERSION,
    licenceVersion: DRAFT_COMMUNITY_MANUAL_LICENCE_VERSION,
    contributionId: TEST_CONTRIBUTION_ID,
    airframeProfile: {
      rotorDiameterMm: 1500,
      bladeCount: 2,
      powerType: 'electric',
      cyclicServoClass: 'standard',
      tailServoClass: 'mini'
    },
    configFingerprints: {
      schemaVersion: COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_VERSION,
      filter: `sha256:${digestBody('A')}`,
      governor: `sha256:${digestBody('b')}`
    },
    safetyAssessment: {airframe: 'clear'},
    guidance: {source: 'manual', modelVersion: null, communityInfluenced: false},
    trial: null,
    shareableRecord: shareableRecord(stored, TEST_SHARING_ID),
    ...overrides
  });
}

export function submission(contribution = buildDraftContribution(), overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'rotorlens-community-submission-v1',
    deletionCapability: TEST_DELETION_CAPABILITY,
    termsReceipt: {
      consentVersion: DRAFT_COMMUNITY_MANUAL_CONSENT_VERSION,
      licenceVersion: DRAFT_COMMUNITY_MANUAL_LICENCE_VERSION,
      termsDigest: DRAFT_COMMUNITY_TERMS_SHA256,
      completeTermsShown: true,
      affirmativelyAccepted: true
    },
    contribution,
    ...overrides
  };
}

export function deletion(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'rotorlens-community-deletion-v1',
    sharingId: TEST_SHARING_ID,
    deletionCapability: TEST_DELETION_CAPABILITY,
    ...overrides
  };
}

export function statsRequest(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'rotorlens-community-stats-request-v1',
    ...overrides
  };
}
