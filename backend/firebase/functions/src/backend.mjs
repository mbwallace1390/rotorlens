/**
 * Emulator-first community persistence boundary.
 *
 * Submission is deliberately closed while the only legal envelope is an
 * engineering draft. It has no promotion, model-build, advice, or raw-log path.
 * The shared app auditor remains the authority for the contribution shape; the
 * backend only proves rejection, deletion-tombstone, and public-stats mechanics.
 */

import {createHash, timingSafeEqual} from 'node:crypto';
import {
  DRAFT_COMMUNITY_TERMS_REGISTRY,
  auditCommunityContribution
} from '../../../../src/analysis/community-contract.mjs';
import {isSharingId} from '../../../../src/analysis/flight-history.mjs';

export const COMMUNITY_BACKEND_SCHEMA_VERSION = 1;
export const COMMUNITY_SUBMISSION_KIND = 'rotorlens-community-submission-v1';
export const COMMUNITY_DELETION_KIND = 'rotorlens-community-deletion-v1';
export const COMMUNITY_STATS_REQUEST_KIND = 'rotorlens-community-stats-request-v1';
export const COMMUNITY_STATS_KIND = 'rotorlens-community-public-stats-v1';
export const COMMUNITY_BACKEND_STATUS = 'emulator-only';
export const COMMUNITY_DEMO_PROJECT_ID = 'demo-rotorlens';
export const COMMUNITY_FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
export const MAXIMUM_SUBMISSION_BYTES = 256 * 1024;
export const MAXIMUM_CONTRIBUTIONS_PER_AIRCRAFT = 200;

const HASH_BODY = '[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]';
const DELETION_CAPABILITY_PATTERN = new RegExp(`^rl-delete-v1:${HASH_BODY}$`);
const MAXIMUM_JSON_DEPTH = 64;
const MAXIMUM_JSON_NODES = 50_000;
const REQUIRED_DRAFT_VIOLATIONS = Object.freeze([
  'CONSENT_VERSION_NOT_ADOPTED',
  'LICENCE_VERSION_NOT_ADOPTED'
]);
const REQUIRED_DRAFT_VIOLATION_SET = new Set(REQUIRED_DRAFT_VIOLATIONS);
const SUBMISSION_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'deletionCapability',
  'termsReceipt',
  'contribution'
]);
const TERMS_RECEIPT_FIELDS = Object.freeze([
  'consentVersion',
  'licenceVersion',
  'termsDigest',
  'completeTermsShown',
  'affirmativelyAccepted'
]);
const DELETION_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'sharingId',
  'deletionCapability'
]);
const STATS_REQUEST_FIELDS = Object.freeze(['schemaVersion', 'kind']);
const INTERNAL_STATS_KIND = 'rotorlens-community-internal-stats-v1';
const INTERNAL_STATS_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'validatedAircraftCount',
  'validatedFlightCount',
  'modelEligibleFlightCount'
]);
const AIRCRAFT_KIND = 'rotorlens-community-aircraft-v1';
const AIRCRAFT_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'deletionCapabilityDigest',
  'contributionCount',
  'validatedContributionCount',
  'modelEligibleContributionCount'
]);
const TOMBSTONE_KIND = 'rotorlens-community-deletion-tombstone-v1';
const TOMBSTONE_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'status',
  'deletionCapabilityDigest'
]);

export class CommunityBackendError extends Error {
  constructor(status, code, details = null) {
    super(code);
    this.name = 'CommunityBackendError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function refuse(status, code, details = null) {
  throw new CommunityBackendError(status, code, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value, fields) {
  if (!isPlainObject(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length === fields.length
    && fields.every(field => Object.hasOwn(value, field));
}

function assertBoundedJsonTree(root) {
  const seen = new WeakSet();
  const stack = [{value: root, depth: 0}];
  let nodes = 0;

  while (stack.length > 0) {
    const {value, depth} = stack.pop();
    nodes += 1;
    if (nodes > MAXIMUM_JSON_NODES || depth > MAXIMUM_JSON_DEPTH) {
      refuse('invalid-argument', 'REQUEST_COMPLEXITY_INVALID');
    }
    if (value === null
        || typeof value === 'string'
        || typeof value === 'boolean') {
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        refuse('invalid-argument', 'REQUEST_JSON_INVALID');
      }
      continue;
    }
    if (typeof value !== 'object' || seen.has(value)) {
      refuse('invalid-argument', 'REQUEST_JSON_INVALID');
    }
    seen.add(value);

    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const names = Object.keys(descriptors).filter(name => name !== 'length');
      if (names.length !== value.length
          || names.some((name, index) => name !== String(index))) {
        refuse('invalid-argument', 'REQUEST_JSON_INVALID');
      }
      for (const name of names) {
        const descriptor = descriptors[name];
        if (!Object.hasOwn(descriptor, 'value')) {
          refuse('invalid-argument', 'REQUEST_JSON_INVALID');
        }
        stack.push({value: descriptor.value, depth: depth + 1});
      }
      continue;
    }

    if (!isPlainObject(value)) {
      refuse('invalid-argument', 'REQUEST_JSON_INVALID');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const stringKeys = Object.keys(descriptors);
    if (Reflect.ownKeys(value).length !== stringKeys.length) {
      refuse('invalid-argument', 'REQUEST_JSON_INVALID');
    }
    for (const name of stringKeys) {
      const descriptor = descriptors[name];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        refuse('invalid-argument', 'REQUEST_JSON_INVALID');
      }
      stack.push({value: descriptor.value, depth: depth + 1});
    }
  }
}

function boundedJsonClone(value) {
  try {
    assertBoundedJsonTree(value);
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string'
        || Buffer.byteLength(serialized, 'utf8') > MAXIMUM_SUBMISSION_BYTES) {
      refuse('invalid-argument', 'REQUEST_SIZE_INVALID');
    }
    return JSON.parse(serialized);
  } catch (error) {
    if (error instanceof CommunityBackendError) {
      throw error;
    }
    refuse('invalid-argument', 'REQUEST_JSON_INVALID');
  }
}

function domainDigest(domain, value) {
  return createHash('sha256')
    .update(`rotorlens-community-backend-v1\0${domain}\0`, 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

function equalDigest(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string'
      || left.length !== 64 || right.length !== 64) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
  } catch {
    return false;
  }
}

export function isExactCommunityEmulatorRuntime(environment, projectId) {
  if (environment === null || typeof environment !== 'object') {
    return false;
  }
  const declaredProjects = [
    environment.GCLOUD_PROJECT,
    environment.GOOGLE_CLOUD_PROJECT
  ].filter(value => value !== undefined);
  return environment.FUNCTIONS_EMULATOR === 'true'
    && environment.FIRESTORE_EMULATOR_HOST === COMMUNITY_FIRESTORE_EMULATOR_HOST
    && projectId === COMMUNITY_DEMO_PROJECT_ID
    && declaredProjects.length > 0
    && declaredProjects.every(value => value === COMMUNITY_DEMO_PROJECT_ID);
}

function auditClosedContribution(contribution, termsReceipt) {
  if (!hasExactFields(termsReceipt, TERMS_RECEIPT_FIELDS)
      || termsReceipt.completeTermsShown !== true
      || termsReceipt.affirmativelyAccepted !== true
      || termsReceipt.consentVersion !== contribution?.consentVersion
      || termsReceipt.licenceVersion !== contribution?.licenceVersion) {
    refuse('invalid-argument', 'LEGAL_RECEIPT_INVALID');
  }
  const registeredDraft = DRAFT_COMMUNITY_TERMS_REGISTRY.find(entry =>
    entry.consentVersion === termsReceipt.consentVersion
    && entry.licenceVersion === termsReceipt.licenceVersion
    && entry.termsDigest === termsReceipt.termsDigest);
  if (!registeredDraft) {
    refuse('failed-precondition', 'TERMS_PAIR_NOT_ADOPTED');
  }
  const audit = auditCommunityContribution(contribution);
  const violationCodes = audit.violations.map(violation => violation.code);
  const exactDraftBlockers = audit.ok === false
    && violationCodes.length === REQUIRED_DRAFT_VIOLATIONS.length
    && violationCodes.every(code => REQUIRED_DRAFT_VIOLATION_SET.has(code))
    && REQUIRED_DRAFT_VIOLATIONS.every(code => violationCodes.includes(code));
  if (!exactDraftBlockers) {
    refuse('invalid-argument', 'CONTRIBUTION_REJECTED');
  }
  refuse(
    'failed-precondition',
    'PRODUCTION_INGESTION_CLOSED',
    Object.freeze({auditCodes: Object.freeze([...audit.codes])})
  );
}

function requireCounter(value) {
  if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    refuse('internal', 'BACKEND_STATE_INVALID');
  }
  return value;
}

function statsFromSnapshot(snapshot) {
  if (!snapshot.exists) {
    return {
      validatedAircraftCount: 0,
      validatedFlightCount: 0,
      modelEligibleFlightCount: 0
    };
  }
  const value = snapshot.data();
  if (!hasExactFields(value, INTERNAL_STATS_FIELDS)
      || value.schemaVersion !== COMMUNITY_BACKEND_SCHEMA_VERSION
      || value.kind !== INTERNAL_STATS_KIND) {
    refuse('internal', 'BACKEND_STATE_INVALID');
  }
  const result = {
    validatedAircraftCount: requireCounter(value?.validatedAircraftCount),
    validatedFlightCount: requireCounter(value?.validatedFlightCount),
    modelEligibleFlightCount: requireCounter(value?.modelEligibleFlightCount)
  };
  if (result.validatedAircraftCount > result.validatedFlightCount
      || result.modelEligibleFlightCount > result.validatedFlightCount) {
    refuse('internal', 'BACKEND_STATE_INVALID');
  }
  return result;
}

function publicLowerBound(value) {
  const count = requireCounter(value);
  if (count < 5) return null;
  if (count < 10) return 5;
  if (count < 25) return 10;
  if (count < 50) return 25;
  if (count < 100) return 50;
  if (count < 250) return 100;
  if (count < 500) return 250;
  if (count < 1000) return 500;
  return 1000;
}

export function rejectCommunitySubmission(data) {
  const request = boundedJsonClone(data);
  if (!hasExactFields(request, SUBMISSION_FIELDS)
      || request.schemaVersion !== COMMUNITY_BACKEND_SCHEMA_VERSION
      || request.kind !== COMMUNITY_SUBMISSION_KIND
      || !DELETION_CAPABILITY_PATTERN.test(request.deletionCapability)) {
    refuse('invalid-argument', 'SUBMISSION_REQUEST_INVALID');
  }
  auditClosedContribution(request.contribution, request.termsReceipt);
  refuse('failed-precondition', 'PRODUCTION_INGESTION_CLOSED');
}

function validateDeletion(data) {
  const request = boundedJsonClone(data);
  if (!hasExactFields(request, DELETION_FIELDS)
      || request.schemaVersion !== COMMUNITY_BACKEND_SCHEMA_VERSION
      || request.kind !== COMMUNITY_DELETION_KIND
      || !isSharingId(request.sharingId)
      || !DELETION_CAPABILITY_PATTERN.test(request.deletionCapability)) {
    refuse('invalid-argument', 'DELETION_REQUEST_INVALID');
  }
  return request;
}

function validateStatsRequest(data) {
  const request = boundedJsonClone(data);
  if (!hasExactFields(request, STATS_REQUEST_FIELDS)
      || request.schemaVersion !== COMMUNITY_BACKEND_SCHEMA_VERSION
      || request.kind !== COMMUNITY_STATS_REQUEST_KIND) {
    refuse('invalid-argument', 'STATS_REQUEST_INVALID');
  }
}

export async function deleteCommunityAircraft(db, data) {
  const request = validateDeletion(data);
  const aircraftDigest = domainDigest('aircraft', request.sharingId);
  const capabilityDigest = domainDigest('deletion-capability', request.deletionCapability);
  const aircraftRef = db.collection('communityAircraft').doc(aircraftDigest);
  const contributionsQuery = aircraftRef.collection('contributions')
    .limit(MAXIMUM_CONTRIBUTIONS_PER_AIRCRAFT + 1);
  const tombstoneRef = db.collection('communityDeletionTombstones').doc(aircraftDigest);
  const statsRef = db.collection('communityInternal').doc('stats');

  return db.runTransaction(async transaction => {
    const [aircraftSnapshot, tombstoneSnapshot] = await Promise.all([
      transaction.get(aircraftRef),
      transaction.get(tombstoneRef)
    ]);
    if (!aircraftSnapshot.exists) {
      if (tombstoneSnapshot.exists) {
        const tombstone = tombstoneSnapshot.data();
        if (!hasExactFields(tombstone, TOMBSTONE_FIELDS)
            || tombstone.schemaVersion !== COMMUNITY_BACKEND_SCHEMA_VERSION
            || tombstone.kind !== TOMBSTONE_KIND
            || tombstone.status !== 'deleted') {
          refuse('internal', 'BACKEND_STATE_INVALID');
        }
        if (equalDigest(tombstone.deletionCapabilityDigest, capabilityDigest)) {
          return Object.freeze({
            schemaVersion: COMMUNITY_BACKEND_SCHEMA_VERSION,
            status: COMMUNITY_BACKEND_STATUS,
            code: 'ALREADY_DELETED',
            deletedFlights: 0
          });
        }
      }
      refuse('permission-denied', 'DELETION_NOT_AUTHORIZED');
    }
    if (tombstoneSnapshot.exists) {
      refuse('internal', 'BACKEND_STATE_INVALID');
    }
    const aircraft = aircraftSnapshot.data();
    if (!hasExactFields(aircraft, AIRCRAFT_FIELDS)
        || aircraft.schemaVersion !== COMMUNITY_BACKEND_SCHEMA_VERSION
        || aircraft.kind !== AIRCRAFT_KIND) {
      refuse('internal', 'BACKEND_STATE_INVALID');
    }
    if (!equalDigest(aircraft.deletionCapabilityDigest, capabilityDigest)) {
      refuse('permission-denied', 'DELETION_NOT_AUTHORIZED');
    }

    const [contributionsSnapshot, statsSnapshot] = await Promise.all([
      transaction.get(contributionsQuery),
      transaction.get(statsRef)
    ]);
    if (contributionsSnapshot.size > MAXIMUM_CONTRIBUTIONS_PER_AIRCRAFT) {
      refuse('internal', 'BACKEND_STATE_INVALID');
    }
    const storedCount = requireCounter(aircraft.contributionCount);
    const validatedContributionCount = requireCounter(
      aircraft.validatedContributionCount
    );
    const modelEligibleContributionCount = requireCounter(
      aircraft.modelEligibleContributionCount
    );
    if (storedCount !== contributionsSnapshot.size) {
      refuse('internal', 'BACKEND_STATE_INVALID');
    }
    const stats = statsFromSnapshot(statsSnapshot);
    const validatedAircraftDelta = validatedContributionCount > 0 ? 1 : 0;
    if (validatedContributionCount > contributionsSnapshot.size
        || modelEligibleContributionCount > validatedContributionCount
        || stats.validatedAircraftCount < validatedAircraftDelta
        || stats.validatedFlightCount < validatedContributionCount
        || stats.modelEligibleFlightCount < modelEligibleContributionCount) {
      refuse('internal', 'BACKEND_STATE_INVALID');
    }
    const nextStats = {
      validatedAircraftCount: stats.validatedAircraftCount - validatedAircraftDelta,
      validatedFlightCount: stats.validatedFlightCount - validatedContributionCount,
      modelEligibleFlightCount:
        stats.modelEligibleFlightCount - modelEligibleContributionCount
    };
    if (nextStats.validatedAircraftCount > nextStats.validatedFlightCount
        || nextStats.modelEligibleFlightCount > nextStats.validatedFlightCount) {
      refuse('internal', 'BACKEND_STATE_INVALID');
    }

    for (const contributionSnapshot of contributionsSnapshot.docs) {
      transaction.delete(contributionSnapshot.ref);
      transaction.delete(
        db.collection('communityContributionClaims').doc(contributionSnapshot.id)
      );
    }
    transaction.delete(aircraftRef);
    transaction.set(tombstoneRef, {
      schemaVersion: COMMUNITY_BACKEND_SCHEMA_VERSION,
      kind: TOMBSTONE_KIND,
      status: 'deleted',
      deletionCapabilityDigest: capabilityDigest
    });
    transaction.set(statsRef, {
      schemaVersion: COMMUNITY_BACKEND_SCHEMA_VERSION,
      kind: INTERNAL_STATS_KIND,
      ...nextStats
    });

    return Object.freeze({
      schemaVersion: COMMUNITY_BACKEND_SCHEMA_VERSION,
      status: COMMUNITY_BACKEND_STATUS,
      code: 'DELETED',
      deletedFlights: contributionsSnapshot.size
    });
  });
}

export async function readCommunityStats(db, data) {
  validateStatsRequest(data);
  const snapshot = await db.collection('communityInternal').doc('stats').get();
  const stats = statsFromSnapshot(snapshot);
  const populationAvailable = stats.validatedAircraftCount >= 5;
  return Object.freeze({
    schemaVersion: COMMUNITY_BACKEND_SCHEMA_VERSION,
    kind: COMMUNITY_STATS_KIND,
    code: populationAvailable ? 'PUBLIC_STATS_AVAILABLE' : 'PUBLIC_STATS_WITHHELD',
    contributingHelicoptersLowerBound: populationAvailable
      ? publicLowerBound(stats.validatedAircraftCount)
      : null,
    validatedFlightsLowerBound: populationAvailable
      ? publicLowerBound(stats.validatedFlightCount)
      : null,
    modelEligibleFlightsLowerBound: populationAvailable
      ? publicLowerBound(stats.modelEligibleFlightCount)
      : null,
    learningStatus: 'closed-no-production-corpus'
  });
}
