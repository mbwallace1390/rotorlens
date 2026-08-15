/**
 * Offline consistency check between immutable Blackbox header evidence and an
 * already-sanitized configuration supplement. Agreement is useful rejection
 * evidence only: a header cannot prove when the supplement was acquired, and
 * this module does not inspect the session body for in-flight changes.
 */

import {extractCommunityConfiguration} from './community-config-extractor.mjs';
import {
  COMMUNITY_CONFIG_SUPPLEMENT_SNAPSHOT_KIND,
  inspectCommunityConfigSupplement
} from './community-config-supplement.mjs';

export const COMMUNITY_CONFIG_PAIRING_SCHEMA_VERSION = 1;
export const COMMUNITY_CONFIG_PAIRING_REPORT_KIND =
  'rotorlens-community-config-pairing-report-v1';
export const COMMUNITY_CONFIG_PAIRING_INSPECTOR_VERSION =
  'rotorlens-community-config-pairing-inspector-v1';

export const COMMUNITY_CONFIG_PAIRING_CODES = Object.freeze([
  'SESSION_EVIDENCE_INVALID',
  'BLACKBOX_CONTEXT_UNAVAILABLE',
  'SUPPLEMENT_SNAPSHOT_UNAVAILABLE',
  'COMMON_EVIDENCE_UNAVAILABLE',
  'COMMON_EVIDENCE_MISMATCH',
  'COMMON_EVIDENCE_MATCHED',
  'SESSION_BODY_NOT_CHECKED',
  'CONFIG_CHANGE_EVENTS_NOT_CHECKED',
  'EXACT_FLIGHT_BINDING_UNPROVEN',
  'COMPLETE_CONFIGURATION_BINDING_UNPROVEN',
  'CONFIGURATION_TRANSITIVE_CONTEXT_MISSING',
  'COMMUNITY_CONFIGURATION_CLOSED'
]);

const CODE_ORDER = new Map(
  COMMUNITY_CONFIG_PAIRING_CODES.map((code, index) => [code, index])
);
const MAXIMUM_HEADER_ENTRIES = 1024;
const MAXIMUM_HEADER_KEY_CODE_UNITS = 128;
const MAXIMUM_HEADER_VALUE_CODE_UNITS = 8192;
const MAXIMUM_HEADER_TEXT_BYTES = 1024 * 1024;
const MAXIMUM_SNAPSHOT_BYTES = 256 * 1024;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', {fatal: true});
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get;
const TYPED_ARRAY_BYTE_OFFSET = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteOffset'
).get;
const TYPED_ARRAY_BUFFER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'buffer'
).get;
const ARRAY_BUFFER_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength'
).get;
const SHARED_ARRAY_BUFFER_BYTE_LENGTH = typeof SharedArrayBuffer === 'undefined'
  ? null
  : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength').get;
const CANONICAL_UNSIGNED_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;
const CANONICAL_SIGNED_INTEGER_PATTERN = /^(?:0|-?[1-9]\d*)$/;
const FIRMWARE_REVISION_PATTERN =
  /^Rotorflight (4\.[3-6]\.\d{1,3}) \(([0-9a-f]{7,40})\) (STM32F7X2)$/;
const REVIEWED_BOARDS = new Set(['FRSK VANTAC_RF007', 'NEXUS']);

function addCode(codes, code) {
  if (!codes.includes(code)) codes.push(code);
}

function orderedCodes(codes) {
  return Object.freeze([...codes].sort(
    (left, right) => CODE_ORDER.get(left) - CODE_ORDER.get(right)
  ));
}

function pairingReport({sessionEvidence = 'unavailable',
  snapshotEvidence = 'unavailable', overlap = 'unavailable', codes = []} = {}) {
  const allCodes = [...codes];
  addCode(allCodes, overlap === 'matched'
    ? 'COMMON_EVIDENCE_MATCHED'
    : overlap === 'mismatched'
      ? 'COMMON_EVIDENCE_MISMATCH'
      : 'COMMON_EVIDENCE_UNAVAILABLE');
  addCode(allCodes, 'SESSION_BODY_NOT_CHECKED');
  addCode(allCodes, 'CONFIG_CHANGE_EVENTS_NOT_CHECKED');
  addCode(allCodes, 'EXACT_FLIGHT_BINDING_UNPROVEN');
  addCode(allCodes, 'COMPLETE_CONFIGURATION_BINDING_UNPROVEN');
  addCode(allCodes, 'CONFIGURATION_TRANSITIVE_CONTEXT_MISSING');
  addCode(allCodes, 'COMMUNITY_CONFIGURATION_CLOSED');
  return Object.freeze({
    schemaVersion: COMMUNITY_CONFIG_PAIRING_SCHEMA_VERSION,
    kind: COMMUNITY_CONFIG_PAIRING_REPORT_KIND,
    inspectorVersion: COMMUNITY_CONFIG_PAIRING_INSPECTOR_VERSION,
    sessionEvidence,
    snapshotEvidence,
    overlap,
    sessionBody: 'not-checked',
    configChangeEvents: 'not-checked',
    binding: 'unproven',
    complete: false,
    cohortEligible: false,
    adviceEligible: false,
    modelEligible: false,
    codes: orderedCodes(allCodes)
  });
}

function lockedDataSlot(value, key) {
  let slot;
  try {
    slot = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return null;
  }
  return slot !== undefined
    && Object.hasOwn(slot, 'value')
    && slot.writable === false
    && slot.configurable === false
    ? slot
    : null;
}

function captureHeaderEvidence(sessionDefinition) {
  if (sessionDefinition === null
      || typeof sessionDefinition !== 'object'
      || Array.isArray(sessionDefinition)) return null;
  const terminationSlot = lockedDataSlot(sessionDefinition, 'headerTerminationClean');
  const entriesSlot = lockedDataSlot(sessionDefinition, 'headerEntries');
  if (terminationSlot?.value !== true || entriesSlot === null) return null;
  const entries = entriesSlot.value;
  if (!Array.isArray(entries)
      || !Object.isFrozen(entries)
      || !Number.isSafeInteger(entries.length)
      || entries.length === 0
      || entries.length > MAXIMUM_HEADER_ENTRIES) return null;

  const copied = [];
  let textBytes = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entrySlot = Object.getOwnPropertyDescriptor(entries, String(index));
    if (entrySlot === undefined || !Object.hasOwn(entrySlot, 'value')) return null;
    const entry = entrySlot.value;
    if (entry === null
        || typeof entry !== 'object'
        || Array.isArray(entry)
        || !Object.isFrozen(entry)) return null;
    const keySlot = Object.getOwnPropertyDescriptor(entry, 'key');
    const valueSlot = Object.getOwnPropertyDescriptor(entry, 'value');
    if (keySlot === undefined || valueSlot === undefined
        || !Object.hasOwn(keySlot, 'value') || !Object.hasOwn(valueSlot, 'value')) {
      return null;
    }
    const key = keySlot.value;
    const value = valueSlot.value;
    if (typeof key !== 'string' || typeof value !== 'string'
        || key.length === 0 || key.length > MAXIMUM_HEADER_KEY_CODE_UNITS
        || value.length > MAXIMUM_HEADER_VALUE_CODE_UNITS) return null;
    textBytes += ENCODER.encode(key).byteLength + ENCODER.encode(value).byteLength;
    if (textBytes > MAXIMUM_HEADER_TEXT_BYTES) return null;
    copied.push(Object.freeze({key, value}));
  }
  Object.freeze(copied);
  const safeSession = {};
  Object.defineProperties(safeSession, {
    headerTerminationClean: {
      value: true,
      enumerable: true,
      writable: false,
      configurable: false
    },
    headerEntries: {
      value: copied,
      enumerable: true,
      writable: false,
      configurable: false
    }
  });
  return {entries: copied, safeSession};
}

function copySnapshotBytes(snapshotBytes) {
  if (!(snapshotBytes instanceof Uint8Array)) return null;
  let byteLength;
  let byteOffset;
  let buffer;
  try {
    byteLength = TYPED_ARRAY_BYTE_LENGTH.call(snapshotBytes);
    byteOffset = TYPED_ARRAY_BYTE_OFFSET.call(snapshotBytes);
    buffer = TYPED_ARRAY_BUFFER.call(snapshotBytes);
  } catch {
    return null;
  }
  if (byteLength > MAXIMUM_SNAPSHOT_BYTES) return null;
  if (SHARED_ARRAY_BUFFER_BYTE_LENGTH !== null) {
    try {
      SHARED_ARRAY_BUFFER_BYTE_LENGTH.call(buffer);
      return null;
    } catch {
      // The shared-buffer brand did not apply; require the ordinary ArrayBuffer
      // brand below rather than relying on realm-sensitive instanceof checks.
    }
  }
  try {
    ARRAY_BUFFER_BYTE_LENGTH.call(buffer);
  } catch {
    // A typed-array backing store that is not an ordinary ArrayBuffer is either
    // shared or unknown to this realm. Both are unsafe to validate then reread.
    return null;
  }
  try {
    // Construct the copy from an intrinsic plain view. Calling `slice` on a
    // typed-array subclass can invoke its hostile Symbol.species constructor.
    return new Uint8Array(new Uint8Array(buffer, byteOffset, byteLength));
  } catch {
    return null;
  }
}

function groupEntries(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const existing = grouped.get(entry.key);
    if (existing === undefined) grouped.set(entry.key, {count: 1, value: entry.value});
    else existing.count += 1;
  }
  return grouped;
}

function singleton(grouped, key) {
  const entry = grouped.get(key);
  return entry?.count === 1 ? entry.value : null;
}

function snapshotValues(snapshot) {
  if (snapshot?.kind !== COMMUNITY_CONFIG_SUPPLEMENT_SNAPSHOT_KIND
      || !Array.isArray(snapshot.rows)) return null;
  const values = new Map();
  for (const row of snapshot.rows) values.set(`${row[0]}\u0000${row[1]}`, row[2]);
  return values;
}

function snapshotValue(values, scope, key) {
  return values.get(`${scope}\u0000${key}`);
}

function parseUnsignedVector(raw, length) {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',');
  if (parts.length !== length
      || parts.some(part => !CANONICAL_UNSIGNED_INTEGER_PATTERN.test(part))) return null;
  const values = parts.map(Number);
  return values.every(Number.isSafeInteger) ? values : null;
}

function parseSignedVector(raw, length) {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',');
  if (parts.length !== length
      || parts.some(part => !CANONICAL_SIGNED_INTEGER_PATTERN.test(part))) return null;
  const values = parts.map(Number);
  return values.every(Number.isSafeInteger) ? values : null;
}

function arraysEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function componentsInRange(values, minimum, maximum) {
  return values.every(value => value >= minimum && value <= maximum);
}

function commonEvidenceMatches(entries, values) {
  const grouped = groupEntries(entries);
  const revision = singleton(grouped, 'Firmware revision');
  const board = singleton(grouped, 'Board information');
  const ratesType = parseUnsignedVector(singleton(grouped, 'rates_type'), 1);
  const rcRates = parseUnsignedVector(singleton(grouped, 'rc_rates'), 3);
  const rcExpo = parseUnsignedVector(singleton(grouped, 'rc_expo'), 3);
  const superRates = parseUnsignedVector(singleton(grouped, 'rates'), 3);
  const acceleration = parseUnsignedVector(singleton(grouped, 'accel_limit'), 3);
  const response = parseUnsignedVector(singleton(grouped, 'response_time'), 3);
  const firmware = typeof revision === 'string'
    ? FIRMWARE_REVISION_PATTERN.exec(revision)
    : null;
  if (firmware === null || !REVIEWED_BOARDS.has(board) || ratesType === null
      || rcRates === null || rcExpo === null || superRates === null
      || acceleration === null || response === null) return null;
  const maximumRatesType = firmware[1] === '4.6.0' ? 6 : 5;
  if (!componentsInRange(ratesType, 1, maximumRatesType)
      || !componentsInRange(rcRates, 1, 255)
      || !componentsInRange(rcExpo, 0, 100)
      || !componentsInRange(superRates, 0, 255)
      || !componentsInRange(acceleration, 0, 50000)
      || !componentsInRange(response, 0, 250)) return null;

  const governorEvidenceRequired = firmware[1] !== '4.3.0';
  const governorPid = governorEvidenceRequired
    ? parseUnsignedVector(singleton(grouped, 'govPID'), 5)
    : null;
  const yawTta = governorEvidenceRequired
    ? parseUnsignedVector(singleton(grouped, 'yaw_tta'), 2)
    : null;
  const collectiveRange = governorEvidenceRequired
    ? parseSignedVector(singleton(grouped, 'collectiveRange'), 2)
    : null;
  if (governorEvidenceRequired
      && (governorPid === null || yawTta === null || collectiveRange === null)) {
    return null;
  }
  if (governorEvidenceRequired
      && (!componentsInRange(governorPid, 0, 250)
        || !componentsInRange(yawTta, 0, 250)
        || !componentsInRange(collectiveRange, -2500, 2500)
        || collectiveRange[0] > collectiveRange[1])) return null;

  const snapshotVersion = snapshotValue(values, 'meta', 'firmware_version');
  const snapshotCommit = snapshotValue(values, 'meta', 'firmware_commit');
  const snapshotTarget = snapshotValue(values, 'meta', 'firmware_target');
  const axes = ['roll', 'pitch', 'yaw'];
  const expectedRcRates = axes.map(axis => snapshotValue(values, 'rates', `${axis}_rc_rate`));
  const expectedExpo = axes.map(axis => snapshotValue(values, 'rates', `${axis}_expo`));
  const expectedSuperRates = axes.map(axis => snapshotValue(values, 'rates', `${axis}_srate`));
  const expectedAcceleration = axes.map(
    axis => snapshotValue(values, 'rates', `${axis}_accel_limit`)
  );
  const expectedResponse = axes.map(axis => snapshotValue(values, 'rates', `${axis}_response`));
  const expectedRatesType = snapshotValue(values, 'rates', 'rates_type');
  const expectedGovernorPid = [
    'gov_p_gain',
    'gov_i_gain',
    'gov_d_gain',
    'gov_f_gain',
    'gov_gain'
  ].map(key => snapshotValue(values, 'governor-profile', key));
  const expectedYawTta = ['gov_tta_gain', 'gov_tta_limit']
    .map(key => snapshotValue(values, 'governor-profile', key));
  const expectedCollectiveRange = ['sc_min', 'sc_max']
    .map(key => snapshotValue(values, 'mixer', key));

  return firmware[1] === snapshotVersion
    && typeof snapshotCommit === 'string'
    && firmware[2].startsWith(snapshotCommit)
    && firmware[3] === snapshotTarget
    && board === snapshotValue(values, 'meta', 'board')
    && ratesType[0] === expectedRatesType
    && arraysEqual(rcRates, expectedRcRates)
    && arraysEqual(rcExpo, expectedExpo)
    && arraysEqual(superRates, expectedSuperRates)
    && arraysEqual(acceleration, expectedAcceleration)
    && arraysEqual(response, expectedResponse)
    && (!governorEvidenceRequired
      || (arraysEqual(governorPid, expectedGovernorPid)
        && arraysEqual(yawTta, expectedYawTta)
        && arraysEqual(collectiveRange, expectedCollectiveRange)));
}

/**
 * Compare reviewed overlap without retaining either side's raw values.
 * `sessionDefinition` must be parseSession(..., {retainHeaderEntries: true})
 * evidence; `snapshotBytes` must be the canonical Phase 2B JSON bytes.
 */
export function inspectCommunityConfigPairing(sessionDefinition, snapshotBytes) {
  let captured;
  try {
    captured = captureHeaderEvidence(sessionDefinition);
  } catch {
    captured = null;
  }
  if (captured === null) {
    return pairingReport({codes: ['SESSION_EVIDENCE_INVALID']});
  }

  let blackboxReport;
  try {
    blackboxReport = extractCommunityConfiguration(captured.safeSession);
  } catch {
    return pairingReport({codes: ['BLACKBOX_CONTEXT_UNAVAILABLE']});
  }
  if (blackboxReport.contextAvailable !== true) {
    return pairingReport({codes: ['BLACKBOX_CONTEXT_UNAVAILABLE']});
  }

  let snapshotCopy;
  try {
    snapshotCopy = copySnapshotBytes(snapshotBytes);
  } catch {
    snapshotCopy = null;
  }
  if (snapshotCopy === null) {
    return pairingReport({
      sessionEvidence: 'reviewed-partial',
      codes: ['SUPPLEMENT_SNAPSHOT_UNAVAILABLE']
    });
  }
  let supplementReport;
  try {
    supplementReport = inspectCommunityConfigSupplement(snapshotCopy);
  } catch {
    return pairingReport({
      sessionEvidence: 'reviewed-partial',
      codes: ['SUPPLEMENT_SNAPSHOT_UNAVAILABLE']
    });
  }
  if (supplementReport.snapshotValid !== true) {
    return pairingReport({
      sessionEvidence: 'reviewed-partial',
      codes: ['SUPPLEMENT_SNAPSHOT_UNAVAILABLE']
    });
  }

  let snapshot;
  try {
    snapshot = JSON.parse(DECODER.decode(snapshotCopy));
  } catch {
    return pairingReport({
      sessionEvidence: 'reviewed-partial',
      codes: ['SUPPLEMENT_SNAPSHOT_UNAVAILABLE']
    });
  }
  const values = snapshotValues(snapshot);
  const matches = values === null
    ? null
    : commonEvidenceMatches(captured.entries, values);
  return pairingReport({
    sessionEvidence: 'reviewed-partial',
    snapshotEvidence: 'reviewed-partial',
    overlap: matches === null ? 'unavailable' : matches ? 'matched' : 'mismatched'
  });
}
