/**
 * Offline, categorical observation of one already-decoded Blackbox session.
 *
 * The decoder owns the immutable evidence consumed here. Public session arrays
 * remain mutable for the viewer's release lifecycle and are never trusted by
 * this boundary. Even the strongest result remains unbound and ineligible.
 */

import {captureSessionIntegrityEvidence} from '../blackbox/decode.mjs';
import {sessionIntegrity} from '../blackbox/log-integrity.mjs';
import {
  COMMUNITY_BLACKBOX_CONFIG_MANIFESTS
} from './community-config-extractor.mjs';

export const COMMUNITY_CONFIG_SESSION_INTEGRITY_SCHEMA_VERSION = 1;
export const COMMUNITY_CONFIG_SESSION_INTEGRITY_REPORT_KIND =
  'rotorlens-community-config-session-integrity-report-v1';
export const COMMUNITY_CONFIG_SESSION_INTEGRITY_INSPECTOR_VERSION =
  'rotorlens-community-config-session-integrity-inspector-v1';

export const COMMUNITY_CONFIG_SESSION_INTEGRITY_CODES = Object.freeze([
  'DECODE_RESULT_INVALID',
  'SESSION_SELECTION_INVALID',
  'SESSION_EVIDENCE_INVALID',
  'SESSION_FIRMWARE_UNREVIEWED',
  'SESSION_BODY_NOT_DECODED',
  'SESSION_BODY_LIMIT_EXCEEDED',
  'SESSION_BODY_DAMAGED',
  'SESSION_BODY_TRUNCATED',
  'SESSION_BODY_INCOMPLETE',
  'SESSION_BODY_UNAVAILABLE',
  'SESSION_BODY_CLEAN',
  'SESSION_CONTINUITY_UNAVAILABLE',
  'SESSION_CONTINUITY_GAPPED',
  'SESSION_CONTINUITY_CONTINUOUS',
  'CONFIG_CHANGE_EVENT_COVERAGE_GAP',
  'CONFIG_CHANGE_EVENTS_UNAVAILABLE',
  'CONFIG_CHANGE_EVENTS_OBSERVED',
  'CONFIG_CHANGE_EVENTS_NOT_OBSERVED',
  'EXACT_FLIGHT_BINDING_UNPROVEN',
  'COMPLETE_CONFIGURATION_BINDING_UNPROVEN',
  'CONFIGURATION_TRANSITIVE_CONTEXT_MISSING',
  'COMMUNITY_CONFIGURATION_CLOSED'
]);

const CODE_ORDER = new Map(
  COMMUNITY_CONFIG_SESSION_INTEGRITY_CODES.map((code, index) => [code, index])
);
const MAXIMUM_SAMPLES = 4_000_000;
const MAXIMUM_AUXILIARY_FRAMES = 1_000_000;
const MAXIMUM_EVENTS = 100_000;
const MAXIMUM_RECORDS = 5_000_000;
const MAXIMUM_ERRORS = 1001;
const FIRMWARE_REVISION_PATTERN =
  /^Rotorflight (4\.[3-6]\.\d{1,3}) \(([0-9a-f]{7,40})\) (STM32F7X2)$/;
const REVIEWED_BOARDS = new Set(['FRSK VANTAC_RF007', 'NEXUS']);
const REVIEWED_RELEASES = new Map(
  Object.values(COMMUNITY_BLACKBOX_CONFIG_MANIFESTS)
    .flatMap(manifest => manifest.sourceReleases)
    .map(release => [release.version, release.commit])
);
const EVENT_TAGS = new Set([
  'sync-beep',
  'logging-resume',
  'flight-mode',
  'inflight-adjustment',
  'custom-data',
  'custom-string',
  'log-end',
  'state'
]);

function addCode(codes, code) {
  if (!codes.includes(code)) codes.push(code);
}

function orderedCodes(codes) {
  return Object.freeze([...codes].sort(
    (left, right) => CODE_ORDER.get(left) - CODE_ORDER.get(right)
  ));
}

function integrityReport({sessionBody = 'unavailable', continuity = 'unavailable',
  configChangeEvents = 'unavailable', codes = []} = {}) {
  const allCodes = [...codes];
  addCode(allCodes, sessionBody === 'clean'
    ? 'SESSION_BODY_CLEAN'
    : 'SESSION_BODY_UNAVAILABLE');
  addCode(allCodes, continuity === 'continuous'
    ? 'SESSION_CONTINUITY_CONTINUOUS'
    : continuity === 'gapped'
      ? 'SESSION_CONTINUITY_GAPPED'
      : 'SESSION_CONTINUITY_UNAVAILABLE');
  addCode(allCodes, configChangeEvents === 'observed'
    ? 'CONFIG_CHANGE_EVENTS_OBSERVED'
    : configChangeEvents === 'not-observed'
      ? 'CONFIG_CHANGE_EVENTS_NOT_OBSERVED'
      : 'CONFIG_CHANGE_EVENTS_UNAVAILABLE');
  addCode(allCodes, 'EXACT_FLIGHT_BINDING_UNPROVEN');
  addCode(allCodes, 'COMPLETE_CONFIGURATION_BINDING_UNPROVEN');
  addCode(allCodes, 'CONFIGURATION_TRANSITIVE_CONTEXT_MISSING');
  addCode(allCodes, 'COMMUNITY_CONFIGURATION_CLOSED');
  return Object.freeze({
    schemaVersion: COMMUNITY_CONFIG_SESSION_INTEGRITY_SCHEMA_VERSION,
    kind: COMMUNITY_CONFIG_SESSION_INTEGRITY_REPORT_KIND,
    inspectorVersion: COMMUNITY_CONFIG_SESSION_INTEGRITY_INSPECTOR_VERSION,
    sessionBody,
    continuity,
    configChangeEvents,
    binding: 'unproven',
    complete: false,
    cohortEligible: false,
    adviceEligible: false,
    modelEligible: false,
    codes: orderedCodes(allCodes)
  });
}

function reviewedFirmware(firmware) {
  if (firmware === null || typeof firmware !== 'object'
      || firmware.type !== 'Rotorflight'
      || typeof firmware.version !== 'string'
      || typeof firmware.revision !== 'string'
      || !REVIEWED_BOARDS.has(firmware.board)) return false;
  const match = FIRMWARE_REVISION_PATTERN.exec(firmware.revision);
  if (match === null || match[1] !== firmware.version) return false;
  const reviewedCommit = REVIEWED_RELEASES.get(firmware.version);
  return reviewedCommit !== undefined && reviewedCommit.startsWith(match[2]);
}

function validCount(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function countsValid(evidence) {
  const counts = evidence.frameCounts;
  if (counts === null || typeof counts !== 'object') return false;
  const {I, P, S, G, H, E, rejected, resyncBytes} = counts;
  if (![I, P].every(value => validCount(value, MAXIMUM_SAMPLES))
      || ![S, G, H].every(value => validCount(value, MAXIMUM_AUXILIARY_FRAMES))
      || !validCount(E, MAXIMUM_EVENTS)
      || !validCount(rejected, MAXIMUM_RECORDS)
      || !Number.isSafeInteger(resyncBytes)
      || resyncBytes < 0
      || !validCount(evidence.sampleCount, MAXIMUM_SAMPLES)
      || !validCount(evidence.intraSampleCount, MAXIMUM_SAMPLES)
      || !validCount(evidence.gpsCount, MAXIMUM_AUXILIARY_FRAMES)) return false;
  const auxiliary = S + G + H;
  const records = I + P + auxiliary + E;
  return I + P === evidence.sampleCount
    && I === evidence.intraSampleCount
    && evidence.gpsCount <= G
    && auxiliary <= MAXIMUM_AUXILIARY_FRAMES
    && records <= MAXIMUM_RECORDS;
}

function errorsValid(errors) {
  return Array.isArray(errors)
    && errors.length <= MAXIMUM_ERRORS
    && errors.every(error => error !== null
      && typeof error === 'object'
      && typeof error.code === 'string');
}

function eventObservation(summary, expectedCount) {
  if (summary === null || typeof summary !== 'object'
      || !validCount(summary.count, MAXIMUM_EVENTS)
      || summary.count === 0
      || summary.count !== expectedCount
      || !Array.isArray(summary.tags)
      || summary.tags.length === 0
      || summary.tags.length > EVENT_TAGS.size
      || !summary.tags.every((tag, index) => typeof tag === 'string'
        && EVENT_TAGS.has(tag)
        && (index === 0 || summary.tags[index - 1] < tag))
      || typeof summary.adjustmentObserved !== 'boolean'
      || typeof summary.loggingResumeObserved !== 'boolean'
      || summary.adjustmentObserved !== summary.tags.includes('inflight-adjustment')
      || summary.loggingResumeObserved !== summary.tags.includes('logging-resume')
      || !validCount(summary.logEndCount, summary.count)
      || !validCount(summary.terminalCount, summary.count)
      || typeof summary.finalTag !== 'string'
      || typeof summary.finalTerminal !== 'boolean'
      || summary.logEndCount !== 1
      || summary.terminalCount !== 1
      || summary.finalTag !== 'log-end'
      || !summary.finalTerminal) return null;
  return {
    adjustmentsObserved: summary.adjustmentObserved,
    loggingResumeObserved: summary.loggingResumeObserved
  };
}

/** Inspect one decoder-owned session without retaining or echoing its data. */
export function inspectCommunityConfigSessionIntegrity(
  decodeResult,
  sessionIndex,
  byteLength
) {
  let evidence;
  try {
    evidence = captureSessionIntegrityEvidence(decodeResult, sessionIndex, byteLength);
  } catch {
    evidence = null;
  }
  if (evidence === null) return integrityReport({codes: ['DECODE_RESULT_INVALID']});
  if (evidence.status === 'invalid-selection') {
    return integrityReport({codes: ['SESSION_SELECTION_INVALID']});
  }
  if (evidence.status === 'not-decoded') {
    return integrityReport({codes: ['SESSION_BODY_NOT_DECODED']});
  }
  if (evidence.status !== 'decoded') {
    return integrityReport({codes: ['SESSION_EVIDENCE_INVALID']});
  }
  if (!reviewedFirmware(evidence.firmware)) {
    return integrityReport({codes: ['SESSION_FIRMWARE_UNREVIEWED']});
  }
  if (evidence.headerTerminationClean !== true
      || evidence.headerKeysUnique !== true) {
    return integrityReport({codes: ['SESSION_EVIDENCE_INVALID']});
  }
  if (!countsValid(evidence)
      || !errorsValid(evidence.errors)
      || typeof evidence.truncated !== 'boolean'
      || typeof evidence.reachedLogEnd !== 'boolean'
      || typeof evidence.limitExceeded !== 'boolean'
      || !Number.isSafeInteger(evidence.byteOffset)
      || !Number.isSafeInteger(evidence.bodyEndOffset)
      || !Number.isSafeInteger(evidence.sessionEnd)
      || evidence.byteOffset < 0
      || evidence.bodyEndOffset < evidence.byteOffset
      || evidence.bodyEndOffset > evidence.sessionEnd) {
    return integrityReport({codes: ['SESSION_EVIDENCE_INVALID']});
  }

  const integrity = sessionIntegrity({
    byteOffset: evidence.byteOffset,
    errors: evidence.errors,
    truncated: evidence.truncated,
    reachedLogEnd: evidence.reachedLogEnd
  }, evidence.sessionEnd);
  const failureCodes = [];
  if (evidence.limitExceeded
      || evidence.errors.some(error => error.code === 'limit-exceeded')) {
    addCode(failureCodes, 'SESSION_BODY_LIMIT_EXCEEDED');
  }
  if (integrity.state === 'damaged'
      || evidence.frameCounts.rejected !== 0
      || evidence.frameCounts.resyncBytes !== 0) {
    addCode(failureCodes, 'SESSION_BODY_DAMAGED');
  }
  if (integrity.state === 'truncated') addCode(failureCodes, 'SESSION_BODY_TRUNCATED');
  if (!evidence.reachedLogEnd || evidence.bodyEndOffset !== evidence.sessionEnd) {
    addCode(failureCodes, 'SESSION_BODY_INCOMPLETE');
  }
  if (failureCodes.length > 0) return integrityReport({codes: failureCodes});

  const observation = eventObservation(evidence.eventSummary, evidence.frameCounts.E);
  if (observation === null) {
    return integrityReport({codes: ['SESSION_EVIDENCE_INVALID']});
  }
  const continuity = observation.loggingResumeObserved ? 'gapped' : 'continuous';
  const configChangeEvents = observation.adjustmentsObserved
    ? 'observed'
    : observation.loggingResumeObserved
      ? 'unavailable'
      : 'not-observed';
  return integrityReport({
    sessionBody: 'clean',
    continuity,
    configChangeEvents,
    codes: observation.loggingResumeObserved
      ? ['CONFIG_CHANGE_EVENT_COVERAGE_GAP']
      : []
  });
}
