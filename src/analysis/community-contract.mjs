/**
 * The offline contract between RotorLens measurements and a future community
 * service.
 *
 * This module deliberately contains no transport, persistence, clock or crypto
 * implementation. It only builds and audits the JSON-shaped value that a
 * transport may eventually carry. Hashes are produced by the platform layer;
 * this module validates their algorithm-tagged, fixed-length representation.
 *
 * A valid contribution can be useful in two different ways:
 *
 *   - measurement-only: aggregate distributions and calibration;
 *   - advice-eligible: a fully described aircraft/controller cohort.
 *
 * Missing optional cohort context, or any mechanical result other than
 * `clear`, keeps an otherwise valid contribution in the first category.
 * Malformed context rejects it. Matching unknown or malformed configuration is
 * never treated as proof that two helicopters are comparable.
 */

import {FlightWindowBasis} from './flight-window.mjs';
import {
  AIRBORNE_WINDOW_BASES,
  FLIGHT_HISTORY_SCHEMA_VERSION,
  SHARED_RECORD_KIND,
  auditShareableRecord
} from './flight-history.mjs';
import {sha256Hex} from '../integrity.mjs';

export const COMMUNITY_CONTRIBUTION_KIND = 'rotorlens-community-contribution';
export const COMMUNITY_CONTRIBUTION_SCHEMA_VERSION = 2;
export const COMMUNITY_EXTRACTOR_VERSION = 1;
export const COMMUNITY_COHORT_VERSION = 2;
export const ROTOR_DIAMETER_BAND_SIZE_MM = 50;
export const HEADSPEED_BAND_RATIO = 1.05;

export const DRAFT_COMMUNITY_MANUAL_CONSENT_VERSION =
  'community-manual-consent-2026-08-14-v1';
export const DRAFT_COMMUNITY_MANUAL_LICENCE_VERSION =
  'community-manual-licence-2026-08-14-v1';
export const COMMUNITY_TERMS_CANONICALIZATION = 'utf8-lf-single-trailing-newline-v1';
export const DRAFT_COMMUNITY_TERMS_SHA256 =
  'sha256:VPBH98sdQugoUqfvVD8XfbflhuTBDyHqi7p7xG2002c';

/**
 * Closed legal-text registries. A date-looking UI version is not consent: the
 * exact manual receipt terms must be registered here before their contributions
 * can be ingested.
 */
export const DRAFT_COMMUNITY_CONSENT_VERSIONS = Object.freeze([
  DRAFT_COMMUNITY_MANUAL_CONSENT_VERSION
]);
export const DRAFT_COMMUNITY_LICENCE_VERSIONS = Object.freeze([
  DRAFT_COMMUNITY_MANUAL_LICENCE_VERSION
]);
// Deliberately empty until the owner records formal adoption outside this code.
export const SUPPORTED_COMMUNITY_CONSENT_VERSIONS = Object.freeze([]);
export const SUPPORTED_COMMUNITY_LICENCE_VERSIONS = Object.freeze([]);
export const DRAFT_COMMUNITY_TERMS_REGISTRY = Object.freeze([
  Object.freeze({
    consentVersion: DRAFT_COMMUNITY_MANUAL_CONSENT_VERSION,
    licenceVersion: DRAFT_COMMUNITY_MANUAL_LICENCE_VERSION,
    termsDigest: DRAFT_COMMUNITY_TERMS_SHA256,
    canonicalization: COMMUNITY_TERMS_CANONICALIZATION,
    status: 'engineering-draft'
  })
]);

export const SUPPORTED_COMMUNITY_BOARD_IDENTIFIERS = Object.freeze([
  'FRSK VANTAC_RF007',
  'NEXUS'
]);
export const SUPPORTED_COMMUNITY_ROTORFLIGHT_MINOR_VERSIONS = Object.freeze([
  '4.3',
  '4.4',
  '4.5',
  '4.6'
]);
export const SUPPORTED_COMMUNITY_FIRMWARE_TARGETS = Object.freeze([
  'STM32F7X2'
]);

export const COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_VERSION = 1;
export const COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_STATUS = 'incomplete';
export const COMMUNITY_CONFIG_FINGERPRINT_COVERAGE = 'incomplete';
export const COMMUNITY_CONFIG_FINGERPRINT_KINDS = Object.freeze([
  'filter',
  'governor'
]);
export const COMMUNITY_CONFIG_FINGERPRINT_KEY_PREFIXES = Object.freeze({
  filter: Object.freeze(['gyro_', 'dterm_', 'dyn_notch_', 'rpm_filter_']),
  governor: Object.freeze(['gov_'])
});
/**
 * Null means the exhaustive Rotorflight 4.3-4.6 manifest has not been reviewed.
 * No v1 digest can therefore claim complete filter or governor coverage.
 */
export const COMMUNITY_CONFIG_FINGERPRINT_REQUIRED_KEYS = Object.freeze({
  filter: null,
  governor: null
});
export const COMMUNITY_CONFIG_FINGERPRINT_LIMITS = Object.freeze({
  maximumSettingCount: 256,
  maximumKeyLength: 64,
  maximumStringTokenLength: 64,
  maximumAbsoluteNumericValue: 1_000_000_000_000,
  maximumPreimageLength: 65_536
});

export const COMMUNITY_CONTROLLED_TRIAL_KIND = 'rotorlens-controlled-v1';
export const COMMUNITY_TRIAL_KINDS = Object.freeze([
  'none',
  COMMUNITY_CONTROLLED_TRIAL_KIND
]);

export const COMMUNITY_TRIAL_AXES = Object.freeze(['roll', 'pitch', 'yaw']);
export const COMMUNITY_TRIAL_TERMS = Object.freeze(['P', 'I']);
export const COMMUNITY_TRIAL_DIRECTIONS = Object.freeze(['increase', 'decrease']);

export const COMMUNITY_ELIGIBILITY = Object.freeze({
  REJECTED: 'rejected',
  MEASUREMENT_ONLY: 'measurement-only',
  ADVICE: 'advice'
});

export const POWER_TYPES = Object.freeze([
  'electric',
  'nitro',
  'gasoline',
  'turbine'
]);

export const SERVO_CLASSES = Object.freeze([
  'micro',
  'mini',
  'standard',
  'large-scale'
]);

export const GUIDANCE_SOURCES = Object.freeze([
  'unknown',
  'manual',
  'rotorlens-local',
  'rotorlens-community'
]);

export const SUPPORTED_LOCAL_GUIDANCE_MODEL_VERSIONS = Object.freeze([
  'rotorlens-local-rules-v1'
]);
export const SUPPORTED_COMMUNITY_GUIDANCE_MODEL_VERSIONS = Object.freeze([]);

/** Matches the closed airframe state vocabulary from mechanical-spectrum. */
export const AIRFRAME_SAFETY_STATES = Object.freeze([
  'clear',
  'attention',
  'insufficient',
  'not-measured'
]);

/** Broad physical bounds; cohorts retain the exact integer within them. */
export const AIRFRAME_PROFILE_LIMITS = Object.freeze({
  minimumRotorDiameterMm: 150,
  maximumRotorDiameterMm: 3000,
  minimumBladeCount: 2,
  maximumBladeCount: 8
});

/**
 * Defensive ingestion bounds, not tuning thresholds. They distinguish a
 * physical summary from corrupt/non-finite input without clipping a result.
 */
export const COMMUNITY_MEASUREMENT_LIMITS = Object.freeze({
  maximumOrdinal: 2_147_483_647,
  maximumDurationSeconds: 24 * 60 * 60,
  maximumGain: 1_000_000,
  maximumGainFieldsPerAxis: 8,
  maximumHeadspeedRpm: 100_000,
  maximumEvidenceCount: 1_000_000,
  maximumRateDps: 1_000_000,
  maximumRateDpsPerSecond: 1_000_000,
  maximumFrequencyHz: 100_000,
  maximumITermRms: 1_000_000_000,
  maximumEquipmentTextLength: 160,
  maximumBoardIdentifierLength: 64,
  maximumRatesFingerprintLength: 512,
  maximumModelVersionLength: 64,
  maximumCloneDepth: 64,
  maximumCloneNodes: 50_000
});

/** Every outer and nested field is explicit; payload internals have their own audit. */
export const COMMUNITY_CONTRIBUTION_FIELDS = Object.freeze({
  schemaVersion: 'version of this contribution envelope',
  kind: 'keeps a community contribution distinct from a local or shared flight record',
  extractorVersion: 'version of the measurement semantics that produced the payload',
  consentVersion: 'version of the privacy consent accepted by the contributor',
  licenceVersion: 'version of the contribution and derivative-use licence accepted by the contributor',
  contributionId: 'keyed, opaque id used to deduplicate one contributed flight without exposing a raw-log hash',
  airframeProfile: 'closed, non-free-text airframe facts used only for safe cohorting',
  'airframeProfile.rotorDiameterMm': 'main-rotor diameter in millimetres',
  'airframeProfile.bladeCount': 'integer main-blade count',
  'airframeProfile.powerType': 'closed power-system class',
  'airframeProfile.cyclicServoClass': 'closed cyclic-servo size class',
  'airframeProfile.tailServoClass': 'closed tail-servo size class',
  configFingerprints: 'one-way fingerprints for controller configuration that can confound advice',
  'configFingerprints.filter': 'sha256 fingerprint of the complete filter configuration',
  'configFingerprints.governor': 'sha256 fingerprint of the complete governor configuration',
  'configFingerprints.schemaVersion': 'version of the canonical configuration-fingerprint preimage contract',
  safetyAssessment: 'closed mechanical safety result that gates gain-effect cohorting',
  'safetyAssessment.airframe': 'airframe state from the mechanical-spectrum safety gate',
  guidance: 'provenance of the settings flown, preventing community output from becoming unlabeled training input',
  'guidance.source': 'closed source of the settings flown',
  'guidance.modelVersion': 'bounded machine-readable model token when RotorLens supplied the guidance',
  'guidance.communityInfluenced': 'whether any community-model output influenced the settings flown; null means unknown',
  trial: 'closed link from an after-flight contribution to its exact controlled baseline',
  'trial.kind': 'none or the versioned RotorLens controlled-trial protocol',
  'trial.baselineContributionId': 'opaque id of the exact baseline contribution for a controlled trial',
  'trial.intendedAxis': 'single roll, pitch or yaw axis intentionally changed',
  'trial.intendedTerm': 'single P or I term intentionally changed',
  'trial.intendedDirection': 'closed sign of the candidate value relative to its baseline',
  shareableRecord: 'the already-audited, name-free measurement projection'
});

const OUTER_FIELDS = Object.freeze([
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

const AIRFRAME_FIELDS = Object.freeze([
  'rotorDiameterMm',
  'bladeCount',
  'powerType',
  'cyclicServoClass',
  'tailServoClass'
]);

const CONFIG_FIELDS = Object.freeze(['schemaVersion', 'filter', 'governor']);
const CONFIG_FINGERPRINT_PREIMAGE_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'settings'
]);
const SAFETY_ASSESSMENT_FIELDS = Object.freeze(['airframe']);
const GUIDANCE_FIELDS = Object.freeze(['source', 'modelVersion', 'communityInfluenced']);
const TRIAL_FIELDS = Object.freeze([
  'kind',
  'baselineContributionId',
  'intendedAxis',
  'intendedTerm',
  'intendedDirection'
]);
const AXES = Object.freeze(['roll', 'pitch', 'yaw']);
const DIRECTIONS = Object.freeze(['positive', 'negative']);
const HOLD_STATUSES = new Set(['not-measured', 'inconclusive', 'captured']);
const STOP_STATUSES = new Set(['not-measured', 'inconclusive', 'captured']);
const WINDOW_BASES = new Set(Object.values(FlightWindowBasis));
const POWER_TYPE_SET = new Set(POWER_TYPES);
const SERVO_CLASS_SET = new Set(SERVO_CLASSES);
const GUIDANCE_SOURCE_SET = new Set(GUIDANCE_SOURCES);
const AIRFRAME_SAFETY_STATE_SET = new Set(AIRFRAME_SAFETY_STATES);
const COMMUNITY_CONSENT_VERSION_SET = new Set(SUPPORTED_COMMUNITY_CONSENT_VERSIONS);
const COMMUNITY_LICENCE_VERSION_SET = new Set(SUPPORTED_COMMUNITY_LICENCE_VERSIONS);
const DRAFT_COMMUNITY_CONSENT_VERSION_SET = new Set(DRAFT_COMMUNITY_CONSENT_VERSIONS);
const DRAFT_COMMUNITY_LICENCE_VERSION_SET = new Set(DRAFT_COMMUNITY_LICENCE_VERSIONS);
const COMMUNITY_TRIAL_KIND_SET = new Set(COMMUNITY_TRIAL_KINDS);
const COMMUNITY_TRIAL_AXIS_SET = new Set(COMMUNITY_TRIAL_AXES);
const COMMUNITY_TRIAL_TERM_SET = new Set(COMMUNITY_TRIAL_TERMS);
const COMMUNITY_TRIAL_DIRECTION_SET = new Set(COMMUNITY_TRIAL_DIRECTIONS);
const COMMUNITY_BOARD_IDENTIFIER_SET = new Set(SUPPORTED_COMMUNITY_BOARD_IDENTIFIERS);
const COMMUNITY_ROTORFLIGHT_MINOR_VERSION_SET =
  new Set(SUPPORTED_COMMUNITY_ROTORFLIGHT_MINOR_VERSIONS);
const COMMUNITY_FIRMWARE_TARGET_SET = new Set(SUPPORTED_COMMUNITY_FIRMWARE_TARGETS);
const COMMUNITY_CONFIG_FINGERPRINT_KIND_SET =
  new Set(COMMUNITY_CONFIG_FINGERPRINT_KINDS);
const LOCAL_GUIDANCE_MODEL_VERSION_SET =
  new Set(SUPPORTED_LOCAL_GUIDANCE_MODEL_VERSIONS);
const COMMUNITY_GUIDANCE_MODEL_VERSION_SET =
  new Set(SUPPORTED_COMMUNITY_GUIDANCE_MODEL_VERSIONS);

// A 32-byte unpadded base64url value is 43 characters. Its final character
// contains only four significant bits, so accepting every base64url character
// there would permit multiple text aliases for the same bytes.
const HASH_BODY = '[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]';
const SHA256_PATTERN = new RegExp(`^sha256:${HASH_BODY}$`);
const CONTRIBUTION_ID_PATTERN = new RegExp(`^hmac-sha256:${HASH_BODY}$`);
const LEGAL_VERSION_TOKEN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MODEL_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const CLOCK_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const PATH_PATTERN = /^[A-Za-z]:[\\/]|^\/(?!\/)|\.(?:bbl|bfl|cfl|log|txt|csv)$/i;
const ROTORFLIGHT_REVISION_PATTERN =
  /^Rotorflight (4\.[3-6])\.(?:0|[1-9]\d{0,2})(?:-RC(?:0|[1-9]\d{0,2}))? \(([0-9a-f]{7,64})\) ([A-Z0-9][A-Z0-9._-]{0,31})$/;
const CANONICAL_UNSIGNED_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;
const CONFIG_SETTING_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const CONFIG_STRING_TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9._+-]*$/;
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const HOLD_NUMBER_FIELDS = Object.freeze({
  meanAbsoluteSteadyStateErrorDps: [0, COMMUNITY_MEASUREMENT_LIMITS.maximumRateDps],
  worstAbsoluteSteadyStateErrorDps: [0, COMMUNITY_MEASUREMENT_LIMITS.maximumRateDps],
  meanErrorDriftDpsPerSecond: [
    -COMMUNITY_MEASUREMENT_LIMITS.maximumRateDpsPerSecond,
    COMMUNITY_MEASUREMENT_LIMITS.maximumRateDpsPerSecond
  ],
  meanErrorRippleRmsDps: [0, COMMUNITY_MEASUREMENT_LIMITS.maximumRateDps],
  meanErrorCrossingRateHz: [0, COMMUNITY_MEASUREMENT_LIMITS.maximumFrequencyHz],
  meanITermRms: [0, COMMUNITY_MEASUREMENT_LIMITS.maximumITermRms]
});

const STOP_NUMBER_FIELDS = Object.freeze([
  'trackingRmsDps',
  'fastRingingRmsDps',
  'slowOscillationRmsDps',
  'commandAmplitudeDps'
]);

/** True only for an algorithm-tagged SHA-256 digest without base64 padding. */
export function isSha256Fingerprint(value) {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

/** Canonical SHA-256 shape, or null. Digest case is significant and preserved. */
export function normalizeSha256Fingerprint(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return isSha256Fingerprint(normalized) ? normalized : null;
}

/** True only for the keyed digest used to deduplicate contributions. */
export function isCommunityContributionId(value) {
  return typeof value === 'string' && CONTRIBUTION_ID_PATTERN.test(value);
}

export function normalizeCommunityContributionId(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return isCommunityContributionId(normalized) ? normalized : null;
}

/** Bounded receipt id. Registry membership, not date syntax, proves acceptance. */
export function isCommunityLegalVersionToken(value) {
  return typeof value === 'string'
    && value.length <= COMMUNITY_MEASUREMENT_LIMITS.maximumEquipmentTextLength
    && LEGAL_VERSION_TOKEN_PATTERN.test(value);
}

export function normalizeCommunityLegalVersion(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return isCommunityLegalVersionToken(normalized) ? normalized : null;
}

export function isSupportedCommunityConsentVersion(value) {
  return typeof value === 'string' && COMMUNITY_CONSENT_VERSION_SET.has(value);
}

export function isSupportedCommunityLicenceVersion(value) {
  return typeof value === 'string' && COMMUNITY_LICENCE_VERSION_SET.has(value);
}

function normalizeEnum(value, allowed) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return allowed.has(normalized) ? normalized : null;
}

function boundedInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function assertKnownInputFields(value, fields, name) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${name} must be null or a plain object`);
  }
  const allowed = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${name}.${key} is not an allowed field`);
    }
  }
}

function optionalSuppliedValue(owner, field, path) {
  if (!Object.hasOwn(owner, field)) {
    return null;
  }
  const value = owner[field];
  if (value === undefined) {
    throw new TypeError(`${path} cannot be undefined when supplied`);
  }
  return value;
}

function requireValidOptional(value, normalized, path) {
  if (value !== null && normalized === null) {
    throw new TypeError(`${path} is malformed`);
  }
  return normalized;
}

function canonicalConfigScalarToken(value, path) {
  if (typeof value === 'boolean') {
    return `boolean:${String(value)}`;
  }
  if (typeof value === 'number'
      && Number.isFinite(value)
      && Math.abs(value)
        <= COMMUNITY_CONFIG_FINGERPRINT_LIMITS.maximumAbsoluteNumericValue) {
    const normalized = Object.is(value, -0) ? 0 : value;
    return `number:${String(normalized)}`;
  }
  if (typeof value === 'string'
      && value.length <= COMMUNITY_CONFIG_FINGERPRINT_LIMITS.maximumStringTokenLength
      && CONFIG_STRING_TOKEN_PATTERN.test(value)
      && !/^(?:true|false)$/i.test(value)) {
    return `string:${value}`;
  }
  throw new TypeError(`${path} must be a bounded boolean, finite number, or machine token`);
}

/**
 * Canonical, versioned preimage for a bounded partial filter or governor
 * settings map. Key order cannot change the output, type prefixes prevent
 * scalar aliases, and the serialized `coverage` marker prevents this draft
 * digest from ever being mistaken for an exhaustive configuration digest.
 */
export function canonicalCommunityConfigFingerprintPreimage(preimage) {
  assertKnownInputFields(
    preimage,
    CONFIG_FINGERPRINT_PREIMAGE_FIELDS,
    'configFingerprintPreimage'
  );
  if (preimage.schemaVersion !== COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_VERSION) {
    throw new TypeError('configFingerprintPreimage.schemaVersion is unsupported');
  }
  if (typeof preimage.kind !== 'string'
      || !COMMUNITY_CONFIG_FINGERPRINT_KIND_SET.has(preimage.kind)) {
    throw new TypeError('configFingerprintPreimage.kind is unsupported');
  }
  if (!isPlainObject(preimage.settings)) {
    throw new TypeError('configFingerprintPreimage.settings must be a plain object');
  }

  const keys = Object.keys(preimage.settings).sort();
  if (keys.length === 0
      || keys.length > COMMUNITY_CONFIG_FINGERPRINT_LIMITS.maximumSettingCount) {
    throw new TypeError('configFingerprintPreimage.settings count is outside the bound');
  }
  const prefixes = COMMUNITY_CONFIG_FINGERPRINT_KEY_PREFIXES[preimage.kind];
  const settings = keys.map(key => {
    if (key.length > COMMUNITY_CONFIG_FINGERPRINT_LIMITS.maximumKeyLength
        || !CONFIG_SETTING_KEY_PATTERN.test(key)
        || !prefixes.some(prefix => key.startsWith(prefix) && key.length > prefix.length)) {
      throw new TypeError(`configFingerprintPreimage.settings.${key} is not a documented key`);
    }
    return [
      key,
      canonicalConfigScalarToken(
        preimage.settings[key],
        `configFingerprintPreimage.settings.${key}`
      )
    ];
  });
  const serialized = JSON.stringify({
    schemaVersion: COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_VERSION,
    kind: preimage.kind,
    coverage: COMMUNITY_CONFIG_FINGERPRINT_COVERAGE,
    requiredKeys: COMMUNITY_CONFIG_FINGERPRINT_REQUIRED_KEYS[preimage.kind],
    settings
  });
  if (serialized.length > COMMUNITY_CONFIG_FINGERPRINT_LIMITS.maximumPreimageLength) {
    throw new TypeError('config fingerprint preimage exceeds the serialized length bound');
  }
  return serialized;
}

export function isCommunityConfigFingerprintPreimage(preimage) {
  try {
    canonicalCommunityConfigFingerprintPreimage(preimage);
    return true;
  } catch {
    return false;
  }
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function base64urlEncode(bytes) {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index;
    const first = bytes[index];
    const second = remaining > 1 ? bytes[index + 1] : 0;
    const third = remaining > 2 ? bytes[index + 2] : 0;
    encoded += BASE64URL_ALPHABET[first >>> 2];
    encoded += BASE64URL_ALPHABET[((first & 0x03) << 4) | (second >>> 4)];
    if (remaining > 1) {
      encoded += BASE64URL_ALPHABET[((second & 0x0f) << 2) | (third >>> 6)];
    }
    if (remaining > 2) {
      encoded += BASE64URL_ALPHABET[third & 0x3f];
    }
  }
  return encoded;
}

/** Canonical text bytes used by a terms registry and its separate receipt. */
export function canonicalizeCommunityTermsText(text) {
  if (typeof text !== 'string') {
    throw new TypeError('community terms must be a string');
  }
  return `${text.replace(/\r\n?/g, '\n').replace(/\n*$/, '')}\n`;
}

export function buildCommunityTermsDigest(text) {
  const canonical = canonicalizeCommunityTermsText(text);
  const digest = hexToBytes(sha256Hex(new TextEncoder().encode(canonical)));
  return `sha256:${base64urlEncode(digest)}`;
}

/** Portable synchronous SHA-256 fingerprint of the canonical UTF-8 preimage. */
export function buildCommunityConfigFingerprint(preimage) {
  const canonical = canonicalCommunityConfigFingerprintPreimage(preimage);
  const digest = hexToBytes(sha256Hex(new TextEncoder().encode(canonical)));
  return `sha256:${base64urlEncode(digest)}`;
}

/** Fixed, non-free-text profile. Null means genuinely not supplied. */
export function normalizeAirframeProfile(profile = null) {
  if (profile === null || profile === undefined) {
    return Object.freeze({
      rotorDiameterMm: null,
      bladeCount: null,
      powerType: null,
      cyclicServoClass: null,
      tailServoClass: null
    });
  }
  assertKnownInputFields(profile, AIRFRAME_FIELDS, 'airframeProfile');
  const rotorDiameterMm = optionalSuppliedValue(
    profile,
    'rotorDiameterMm',
    'airframeProfile.rotorDiameterMm'
  );
  const bladeCount = optionalSuppliedValue(
    profile,
    'bladeCount',
    'airframeProfile.bladeCount'
  );
  const powerType = optionalSuppliedValue(profile, 'powerType', 'airframeProfile.powerType');
  const cyclicServoClass = optionalSuppliedValue(
    profile,
    'cyclicServoClass',
    'airframeProfile.cyclicServoClass'
  );
  const tailServoClass = optionalSuppliedValue(
    profile,
    'tailServoClass',
    'airframeProfile.tailServoClass'
  );
  return Object.freeze({
    rotorDiameterMm: requireValidOptional(
      rotorDiameterMm,
      boundedInteger(
        rotorDiameterMm,
        AIRFRAME_PROFILE_LIMITS.minimumRotorDiameterMm,
        AIRFRAME_PROFILE_LIMITS.maximumRotorDiameterMm
      ),
      'airframeProfile.rotorDiameterMm'
    ),
    bladeCount: requireValidOptional(
      bladeCount,
      boundedInteger(
        bladeCount,
        AIRFRAME_PROFILE_LIMITS.minimumBladeCount,
        AIRFRAME_PROFILE_LIMITS.maximumBladeCount
      ),
      'airframeProfile.bladeCount'
    ),
    powerType: requireValidOptional(
      powerType,
      normalizeEnum(powerType, POWER_TYPE_SET),
      'airframeProfile.powerType'
    ),
    cyclicServoClass: requireValidOptional(
      cyclicServoClass,
      normalizeEnum(cyclicServoClass, SERVO_CLASS_SET),
      'airframeProfile.cyclicServoClass'
    ),
    tailServoClass: requireValidOptional(
      tailServoClass,
      normalizeEnum(tailServoClass, SERVO_CLASS_SET),
      'airframeProfile.tailServoClass'
    )
  });
}

/**
 * Nearest 50 mm size band used for cohorting. The exact bounded measurement is
 * retained in the contribution, but a rare exact diameter is neither useful
 * for pooling nor appropriate as part of a public model key.
 */
export function rotorDiameterBandMm(value) {
  const diameter = boundedInteger(
    value,
    AIRFRAME_PROFILE_LIMITS.minimumRotorDiameterMm,
    AIRFRAME_PROFILE_LIMITS.maximumRotorDiameterMm
  );
  return diameter === null
    ? null
    : Math.round(diameter / ROTOR_DIAMETER_BAND_SIZE_MM) * ROTOR_DIAMETER_BAND_SIZE_MM;
}

/**
 * Logarithmic band index whose within-band upper/lower ratio is strictly below
 * 1.05. An index is not an RPM value and is safe to use as cohort context.
 */
export function headspeedBandIndex(value) {
  return Number.isFinite(value)
    && value >= 1
    && value <= COMMUNITY_MEASUREMENT_LIMITS.maximumHeadspeedRpm
    ? Math.floor(Math.log(value) / Math.log(HEADSPEED_BAND_RATIO))
    : null;
}

/** Every flight axis retains its own operating-speed band. */
export function axisHeadspeedBandIndices(shareable) {
  const indices = Object.fromEntries(AXES.map(axis => [
    axis,
    headspeedBandIndex(shareable?.axes?.[axis]?.headspeedMedianRpm)
  ]));
  return AXES.some(axis => indices[axis] === null) ? null : Object.freeze(indices);
}

/** Fixed fingerprint object; null is an explicit measurement-only state. */
export function normalizeConfigFingerprints(fingerprints = null) {
  if (fingerprints === null || fingerprints === undefined) {
    return Object.freeze({
      schemaVersion: COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_VERSION,
      filter: null,
      governor: null
    });
  }
  assertKnownInputFields(fingerprints, CONFIG_FIELDS, 'configFingerprints');
  const schemaVersion = Object.hasOwn(fingerprints, 'schemaVersion')
    ? optionalSuppliedValue(
      fingerprints,
      'schemaVersion',
      'configFingerprints.schemaVersion'
    )
    : COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_VERSION;
  if (schemaVersion !== COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_VERSION) {
    throw new TypeError('configFingerprints.schemaVersion is unsupported');
  }
  const filter = optionalSuppliedValue(fingerprints, 'filter', 'configFingerprints.filter');
  const governor = optionalSuppliedValue(
    fingerprints,
    'governor',
    'configFingerprints.governor'
  );
  return Object.freeze({
    schemaVersion,
    filter: requireValidOptional(
      filter,
      normalizeSha256Fingerprint(filter),
      'configFingerprints.filter'
    ),
    governor: requireValidOptional(
      governor,
      normalizeSha256Fingerprint(governor),
      'configFingerprints.governor'
    )
  });
}

/** Missing mechanical evidence is explicit and can never be mistaken for clear. */
export function normalizeSafetyAssessment(assessment = null) {
  if (assessment === null || assessment === undefined) {
    return Object.freeze({airframe: 'not-measured'});
  }
  assertKnownInputFields(assessment, SAFETY_ASSESSMENT_FIELDS, 'safetyAssessment');
  const supplied = optionalSuppliedValue(
    assessment,
    'airframe',
    'safetyAssessment.airframe'
  );
  const airframe = supplied === null
    ? 'not-measured'
    : requireValidOptional(
      supplied,
      normalizeEnum(supplied, AIRFRAME_SAFETY_STATE_SET),
      'safetyAssessment.airframe'
    );
  return Object.freeze({airframe});
}

export function isGuidanceModelVersionToken(value) {
  return typeof value === 'string'
    && value.length <= COMMUNITY_MEASUREMENT_LIMITS.maximumModelVersionLength
    && MODEL_VERSION_PATTERN.test(value);
}

/** True only for a model id that has actually been registered for use. */
export function isGuidanceModelVersion(value) {
  return typeof value === 'string'
    && (LOCAL_GUIDANCE_MODEL_VERSION_SET.has(value)
      || COMMUNITY_GUIDANCE_MODEL_VERSION_SET.has(value));
}

export function isSupportedGuidanceModelVersion(source, value) {
  if (source === 'rotorlens-local') {
    return LOCAL_GUIDANCE_MODEL_VERSION_SET.has(value);
  }
  if (source === 'rotorlens-community') {
    return COMMUNITY_GUIDANCE_MODEL_VERSION_SET.has(value);
  }
  return false;
}

/** Missing guidance becomes explicit `unknown`; invalid free text never survives. */
export function normalizeGuidance(guidance = null) {
  if (guidance === null || guidance === undefined) {
    return Object.freeze({
      source: 'unknown',
      modelVersion: null,
      communityInfluenced: null
    });
  }
  assertKnownInputFields(guidance, GUIDANCE_FIELDS, 'guidance');
  const suppliedSource = optionalSuppliedValue(guidance, 'source', 'guidance.source');
  const suppliedModelVersion = optionalSuppliedValue(
    guidance,
    'modelVersion',
    'guidance.modelVersion'
  );
  const communityInfluenced = optionalSuppliedValue(
    guidance,
    'communityInfluenced',
    'guidance.communityInfluenced'
  );
  if (communityInfluenced !== null && typeof communityInfluenced !== 'boolean') {
    throw new TypeError('guidance.communityInfluenced must be true, false, or null');
  }
  const source = suppliedSource === null
    ? 'unknown'
    : requireValidOptional(
      suppliedSource,
      normalizeEnum(suppliedSource, GUIDANCE_SOURCE_SET),
      'guidance.source'
    );
  const modelVersion = suppliedModelVersion === null
    ? null
    : requireValidOptional(
      suppliedModelVersion,
      typeof suppliedModelVersion === 'string'
        && isGuidanceModelVersionToken(suppliedModelVersion.trim())
        ? suppliedModelVersion.trim()
        : null,
      'guidance.modelVersion'
    );
  if ((source === 'rotorlens-local' || source === 'rotorlens-community')
      && modelVersion === null) {
    throw new TypeError('guidance.modelVersion is required for RotorLens guidance');
  }
  if ((source === 'unknown' || source === 'manual') && modelVersion !== null) {
    throw new TypeError('guidance.modelVersion is not allowed for unknown or manual guidance');
  }
  if (source === 'rotorlens-local'
      && modelVersion !== null
      && !LOCAL_GUIDANCE_MODEL_VERSION_SET.has(modelVersion)) {
    throw new TypeError('guidance.modelVersion is not a supported local model');
  }
  if (source === 'rotorlens-community'
      && modelVersion !== null
      && !COMMUNITY_GUIDANCE_MODEL_VERSION_SET.has(modelVersion)) {
    throw new TypeError('no community guidance model has been released');
  }
  if (source === 'rotorlens-community' && communityInfluenced !== true) {
    throw new TypeError('community guidance must declare communityInfluenced true');
  }
  return Object.freeze({source, modelVersion, communityInfluenced});
}

/**
 * Fixed experiment link. `none` cannot smuggle trial metadata; a controlled
 * entry must identify its exact baseline and one intended P/I change.
 */
export function normalizeCommunityTrial(trial = null) {
  if (trial === null || trial === undefined) {
    return Object.freeze({
      kind: 'none',
      baselineContributionId: null,
      intendedAxis: null,
      intendedTerm: null,
      intendedDirection: null
    });
  }
  assertKnownInputFields(trial, TRIAL_FIELDS, 'trial');
  const suppliedKind = optionalSuppliedValue(trial, 'kind', 'trial.kind');
  const kind = suppliedKind === null ? 'none' : suppliedKind;
  if (typeof kind !== 'string' || !COMMUNITY_TRIAL_KIND_SET.has(kind)) {
    throw new TypeError('trial.kind is malformed');
  }
  const baselineContributionId = optionalSuppliedValue(
    trial,
    'baselineContributionId',
    'trial.baselineContributionId'
  );
  const intendedAxis = optionalSuppliedValue(trial, 'intendedAxis', 'trial.intendedAxis');
  const intendedTerm = optionalSuppliedValue(trial, 'intendedTerm', 'trial.intendedTerm');
  const intendedDirection = optionalSuppliedValue(
    trial,
    'intendedDirection',
    'trial.intendedDirection'
  );

  if (kind === 'none') {
    if ([baselineContributionId, intendedAxis, intendedTerm, intendedDirection]
      .some(value => value !== null)) {
      throw new TypeError('trial kind none requires all trial detail fields to be null');
    }
  } else {
    if (!isCommunityContributionId(baselineContributionId)) {
      throw new TypeError('trial.baselineContributionId is malformed');
    }
    if (!COMMUNITY_TRIAL_AXIS_SET.has(intendedAxis)) {
      throw new TypeError('trial.intendedAxis is malformed');
    }
    if (!COMMUNITY_TRIAL_TERM_SET.has(intendedTerm)) {
      throw new TypeError('trial.intendedTerm is malformed');
    }
    if (!COMMUNITY_TRIAL_DIRECTION_SET.has(intendedDirection)) {
      throw new TypeError('trial.intendedDirection is malformed');
    }
  }

  return Object.freeze({
    kind,
    baselineContributionId,
    intendedAxis,
    intendedTerm,
    intendedDirection
  });
}

function cloneAndFreeze(value, state = {
  ancestors: new WeakSet(),
  depth: 0,
  nodes: 0
}) {
  state.nodes += 1;
  if (state.nodes > COMMUNITY_MEASUREMENT_LIMITS.maximumCloneNodes) {
    throw new TypeError('shareableRecord exceeds the bounded clone node count');
  }
  if (state.depth > COMMUNITY_MEASUREMENT_LIMITS.maximumCloneDepth) {
    throw new TypeError('shareableRecord exceeds the bounded clone depth');
  }
  if (Array.isArray(value)) {
    if (state.ancestors.has(value)) {
      throw new TypeError('shareableRecord cannot contain a reference cycle');
    }
    state.ancestors.add(value);
    state.depth += 1;
    const copied = value.map(item => cloneAndFreeze(item, state));
    state.depth -= 1;
    state.ancestors.delete(value);
    return Object.freeze(copied);
  }
  if (value !== null && typeof value === 'object') {
    if (state.ancestors.has(value)) {
      throw new TypeError('shareableRecord cannot contain a reference cycle');
    }
    state.ancestors.add(value);
    state.depth += 1;
    const copied = {};
    for (const [key, child] of Object.entries(value)) {
      copied[key] = cloneAndFreeze(child, state);
    }
    state.depth -= 1;
    state.ancestors.delete(value);
    return Object.freeze(copied);
  }
  return value;
}

/**
 * Builds the immutable, fixed outer envelope. Malformed supplied optional
 * context throws instead of being erased into an indistinguishable missing
 * value. Callers must still pass the result through
 * `auditCommunityContribution` before any transport; invalid required values
 * and unsupported legal-text versions fail at that boundary.
 */
export function buildCommunityContribution({
  consentVersion = null,
  licenceVersion = null,
  contributionId = null,
  airframeProfile = null,
  configFingerprints = null,
  safetyAssessment = null,
  guidance = null,
  trial = null,
  shareableRecord = null
} = {}) {
  return Object.freeze({
    schemaVersion: COMMUNITY_CONTRIBUTION_SCHEMA_VERSION,
    kind: COMMUNITY_CONTRIBUTION_KIND,
    extractorVersion: COMMUNITY_EXTRACTOR_VERSION,
    consentVersion: normalizeCommunityLegalVersion(consentVersion),
    licenceVersion: normalizeCommunityLegalVersion(licenceVersion),
    contributionId: normalizeCommunityContributionId(contributionId),
    airframeProfile: normalizeAirframeProfile(airframeProfile),
    configFingerprints: normalizeConfigFingerprints(configFingerprints),
    safetyAssessment: normalizeSafetyAssessment(safetyAssessment),
    guidance: normalizeGuidance(guidance),
    trial: normalizeCommunityTrial(trial),
    shareableRecord: cloneAndFreeze(shareableRecord)
  });
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pushViolation(violations, codes, path, code, reason) {
  if (!codes.includes(code)) {
    codes.push(code);
  }
  violations.push(Object.freeze({path, code, reason}));
}

function addCode(codes, code) {
  if (!codes.includes(code)) {
    codes.push(code);
  }
}

function auditShape(value, fields, path, violations, codes) {
  if (!isPlainObject(value)) {
    pushViolation(
      violations,
      codes,
      path,
      'CONTRIBUTION_SHAPE_INVALID',
      `${path || 'contribution'} must be an object with a fixed allowlisted shape`
    );
    return false;
  }

  const allowed = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      pushViolation(
        violations,
        codes,
        childPath,
        'CONTRIBUTION_FIELD_NOT_ALLOWED',
        'field is not in the fixed community contribution allowlist'
      );
    }
  }
  for (const key of fields) {
    if (!Object.hasOwn(value, key)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      pushViolation(
        violations,
        codes,
        childPath,
        'CONTRIBUTION_FIELD_MISSING',
        'documented field is absent; the contribution shape must be fixed, not conditional'
      );
    }
  }
  return true;
}

function auditRequiredVersion(value, expected, path, code, violations, codes) {
  if (value !== expected) {
    pushViolation(violations, codes, path, code, `must equal ${expected}`);
  }
}

function auditLegalVersion(
  value,
  supported,
  drafts,
  path,
  invalidCode,
  notAdoptedCode,
  violations,
  codes
) {
  if (drafts.has(value) && !supported.has(value)) {
    pushViolation(
      violations,
      codes,
      path,
      notAdoptedCode,
      'draft engineering terms have not been formally adopted for production contributions'
    );
    return;
  }
  if (!isCommunityLegalVersionToken(value) || !supported.has(value)) {
    pushViolation(
      violations,
      codes,
      path,
      invalidCode,
      supported.size === 0
        ? 'no production terms version has been formally adopted'
        : `must name one registered accepted-text version: ${[...supported].join(', ')}`
    );
  }
}

function auditNullableInteger(value, minimum, maximum, path, code, violations, codes) {
  if (value !== null && boundedInteger(value, minimum, maximum) === null) {
    pushViolation(
      violations,
      codes,
      path,
      code,
      `must be null or an integer from ${minimum} through ${maximum}`
    );
  }
}

function auditNullableEnum(value, allowed, path, code, violations, codes) {
  if (value !== null && (typeof value !== 'string' || !allowed.has(value))) {
    pushViolation(
      violations,
      codes,
      path,
      code,
      `must be null or one of: ${[...allowed].join(', ')}`
    );
  }
}

function auditAirframe(profile, violations, codes) {
  if (!auditShape(profile, AIRFRAME_FIELDS, 'airframeProfile', violations, codes)) {
    return false;
  }
  auditNullableInteger(
    profile.rotorDiameterMm,
    AIRFRAME_PROFILE_LIMITS.minimumRotorDiameterMm,
    AIRFRAME_PROFILE_LIMITS.maximumRotorDiameterMm,
    'airframeProfile.rotorDiameterMm',
    'AIRFRAME_ROTOR_DIAMETER_INVALID',
    violations,
    codes
  );
  auditNullableInteger(
    profile.bladeCount,
    AIRFRAME_PROFILE_LIMITS.minimumBladeCount,
    AIRFRAME_PROFILE_LIMITS.maximumBladeCount,
    'airframeProfile.bladeCount',
    'AIRFRAME_BLADE_COUNT_INVALID',
    violations,
    codes
  );
  auditNullableEnum(
    profile.powerType,
    POWER_TYPE_SET,
    'airframeProfile.powerType',
    'AIRFRAME_POWER_TYPE_INVALID',
    violations,
    codes
  );
  auditNullableEnum(
    profile.cyclicServoClass,
    SERVO_CLASS_SET,
    'airframeProfile.cyclicServoClass',
    'AIRFRAME_CYCLIC_SERVO_CLASS_INVALID',
    violations,
    codes
  );
  auditNullableEnum(
    profile.tailServoClass,
    SERVO_CLASS_SET,
    'airframeProfile.tailServoClass',
    'AIRFRAME_TAIL_SERVO_CLASS_INVALID',
    violations,
    codes
  );

  const complete = AIRFRAME_FIELDS.every(field => profile[field] !== null);
  if (!complete) {
    addCode(codes, 'AIRFRAME_PROFILE_INCOMPLETE');
  }
  return complete;
}

function auditConfigFingerprints(fingerprints, violations, codes) {
  if (!auditShape(fingerprints, CONFIG_FIELDS, 'configFingerprints', violations, codes)) {
    return false;
  }
  let complete = true;
  if (COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_STATUS !== 'complete'
      || COMMUNITY_CONFIG_FINGERPRINT_REQUIRED_KEYS.filter === null
      || COMMUNITY_CONFIG_FINGERPRINT_REQUIRED_KEYS.governor === null) {
    complete = false;
    addCode(codes, 'CONFIG_FINGERPRINT_SCHEMA_INCOMPLETE');
  }
  if (fingerprints.schemaVersion !== COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_VERSION) {
    complete = false;
    pushViolation(
      violations,
      codes,
      'configFingerprints.schemaVersion',
      'CONFIG_FINGERPRINT_SCHEMA_VERSION_MISMATCH',
      `must equal ${COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_VERSION}`
    );
  }
  for (const field of ['filter', 'governor']) {
    const value = fingerprints[field];
    if (value === null) {
      complete = false;
      addCode(codes, field === 'filter'
        ? 'FILTER_FINGERPRINT_MISSING'
        : 'GOVERNOR_FINGERPRINT_MISSING');
      continue;
    }
    if (!isSha256Fingerprint(value)) {
      complete = false;
      pushViolation(
        violations,
        codes,
        `configFingerprints.${field}`,
        field === 'filter' ? 'FILTER_FINGERPRINT_INVALID' : 'GOVERNOR_FINGERPRINT_INVALID',
        'must be sha256 followed by one unpadded 32-byte base64url digest'
      );
    }
  }
  return complete;
}

function auditGuidance(guidance, violations, codes) {
  if (!auditShape(guidance, GUIDANCE_FIELDS, 'guidance', violations, codes)) {
    return;
  }
  if (typeof guidance.source !== 'string' || !GUIDANCE_SOURCE_SET.has(guidance.source)) {
    pushViolation(
      violations,
      codes,
      'guidance.source',
      'GUIDANCE_SOURCE_INVALID',
      `must be one of: ${GUIDANCE_SOURCES.join(', ')}`
    );
  }
  if (guidance.modelVersion !== null
      && !isGuidanceModelVersionToken(guidance.modelVersion)) {
    pushViolation(
      violations,
      codes,
      'guidance.modelVersion',
      'GUIDANCE_MODEL_VERSION_INVALID',
      'must be null or a bounded machine-readable token, never user-entered text'
    );
  }
  if ((guidance.source === 'rotorlens-local' || guidance.source === 'rotorlens-community')
      && guidance.modelVersion === null) {
    pushViolation(
      violations,
      codes,
      'guidance.modelVersion',
      guidance.source === 'rotorlens-community'
        ? 'COMMUNITY_GUIDANCE_MODEL_VERSION_MISSING'
        : 'LOCAL_GUIDANCE_MODEL_VERSION_MISSING',
      'RotorLens-supplied guidance must name the model version so it cannot become unlabeled training input'
    );
  }
  if (guidance.source === 'rotorlens-local'
      && isGuidanceModelVersionToken(guidance.modelVersion)
      && !LOCAL_GUIDANCE_MODEL_VERSION_SET.has(guidance.modelVersion)) {
    pushViolation(
      violations,
      codes,
      'guidance.modelVersion',
      'LOCAL_GUIDANCE_MODEL_VERSION_UNSUPPORTED',
      `must be one released local model: ${SUPPORTED_LOCAL_GUIDANCE_MODEL_VERSIONS.join(', ')}`
    );
  }
  if (guidance.source === 'rotorlens-community'
      && isGuidanceModelVersionToken(guidance.modelVersion)
      && !COMMUNITY_GUIDANCE_MODEL_VERSION_SET.has(guidance.modelVersion)) {
    pushViolation(
      violations,
      codes,
      'guidance.modelVersion',
      'COMMUNITY_GUIDANCE_MODEL_VERSION_UNSUPPORTED',
      'no community guidance model has been released'
    );
  }
  if ((guidance.source === 'unknown' || guidance.source === 'manual')
      && guidance.modelVersion !== null) {
    pushViolation(
      violations,
      codes,
      'guidance.modelVersion',
      'GUIDANCE_MODEL_VERSION_UNEXPECTED',
      'unknown or manual guidance cannot truthfully carry a RotorLens model version'
    );
  }
  if (guidance.communityInfluenced !== null
      && typeof guidance.communityInfluenced !== 'boolean') {
    pushViolation(
      violations,
      codes,
      'guidance.communityInfluenced',
      'GUIDANCE_COMMUNITY_ANCESTRY_INVALID',
      'must be true, false, or null when ancestry is unknown'
    );
  }
  if (guidance.source === 'rotorlens-community'
      && guidance.communityInfluenced !== true) {
    pushViolation(
      violations,
      codes,
      'guidance.communityInfluenced',
      'COMMUNITY_GUIDANCE_ANCESTRY_INCONSISTENT',
      'community-supplied guidance must declare communityInfluenced true'
    );
  }
}

function auditTrial(trial, violations, codes) {
  if (!auditShape(trial, TRIAL_FIELDS, 'trial', violations, codes)) {
    return false;
  }
  if (typeof trial.kind !== 'string' || !COMMUNITY_TRIAL_KIND_SET.has(trial.kind)) {
    pushViolation(
      violations,
      codes,
      'trial.kind',
      'TRIAL_KIND_INVALID',
      `must be one of: ${COMMUNITY_TRIAL_KINDS.join(', ')}`
    );
    return false;
  }

  if (trial.kind === 'none') {
    for (const field of TRIAL_FIELDS.slice(1)) {
      if (trial[field] !== null) {
        pushViolation(
          violations,
          codes,
          `trial.${field}`,
          'TRIAL_DETAIL_UNEXPECTED',
          'trial kind none requires every detail field to be null'
        );
      }
    }
    return false;
  }

  if (!isCommunityContributionId(trial.baselineContributionId)) {
    pushViolation(
      violations,
      codes,
      'trial.baselineContributionId',
      'TRIAL_BASELINE_CONTRIBUTION_ID_INVALID',
      'must be one canonical hmac-sha256 32-byte base64url contribution id'
    );
  }
  if (typeof trial.intendedAxis !== 'string'
      || !COMMUNITY_TRIAL_AXIS_SET.has(trial.intendedAxis)) {
    pushViolation(
      violations,
      codes,
      'trial.intendedAxis',
      'TRIAL_AXIS_INVALID',
      `must be one of: ${COMMUNITY_TRIAL_AXES.join(', ')}`
    );
  }
  if (typeof trial.intendedTerm !== 'string'
      || !COMMUNITY_TRIAL_TERM_SET.has(trial.intendedTerm)) {
    pushViolation(
      violations,
      codes,
      'trial.intendedTerm',
      'TRIAL_TERM_INVALID',
      `must be one of: ${COMMUNITY_TRIAL_TERMS.join(', ')}`
    );
  }
  if (typeof trial.intendedDirection !== 'string'
      || !COMMUNITY_TRIAL_DIRECTION_SET.has(trial.intendedDirection)) {
    pushViolation(
      violations,
      codes,
      'trial.intendedDirection',
      'TRIAL_DIRECTION_INVALID',
      `must be one of: ${COMMUNITY_TRIAL_DIRECTIONS.join(', ')}`
    );
  }
  return true;
}

function auditSafetyAssessment(assessment, violations, codes) {
  if (!auditShape(
    assessment,
    SAFETY_ASSESSMENT_FIELDS,
    'safetyAssessment',
    violations,
    codes
  )) {
    return false;
  }
  if (typeof assessment.airframe !== 'string'
      || !AIRFRAME_SAFETY_STATE_SET.has(assessment.airframe)) {
    pushViolation(
      violations,
      codes,
      'safetyAssessment.airframe',
      'AIRFRAME_SAFETY_STATE_INVALID',
      `must be one of: ${AIRFRAME_SAFETY_STATES.join(', ')}`
    );
    return false;
  }
  if (assessment.airframe !== 'clear') {
    addCode(codes, assessment.airframe === 'attention'
      ? 'AIRFRAME_SAFETY_ATTENTION'
      : assessment.airframe === 'insufficient'
        ? 'AIRFRAME_SAFETY_INSUFFICIENT'
        : 'AIRFRAME_SAFETY_NOT_MEASURED');
  }
  return assessment.airframe === 'clear';
}

function auditNullableFinite(value, minimum, maximum, path, code, violations, codes) {
  if (value === null) {
    return;
  }
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    pushViolation(
      violations,
      codes,
      path,
      code,
      `must be null or a finite number from ${minimum} through ${maximum}`
    );
  }
}

function auditNullableCount(value, path, violations, codes) {
  auditNullableInteger(
    value,
    0,
    COMMUNITY_MEASUREMENT_LIMITS.maximumEvidenceCount,
    path,
    'SHAREABLE_EVIDENCE_COUNT_INVALID',
    violations,
    codes
  );
}

function auditRequiredCount(value, path, violations, codes) {
  if (!Number.isInteger(value)
      || value < 0
      || value > COMMUNITY_MEASUREMENT_LIMITS.maximumEvidenceCount) {
    pushViolation(
      violations,
      codes,
      path,
      'SHAREABLE_EVIDENCE_COUNT_INVALID',
      'must be a bounded non-negative integer'
    );
  }
}

function auditGainLine(line, path, violations, codes) {
  if (line === null) {
    return false;
  }
  if (!Array.isArray(line)
      || line.length < 3
      || line.length > COMMUNITY_MEASUREMENT_LIMITS.maximumGainFieldsPerAxis) {
    pushViolation(
      violations,
      codes,
      path,
      'SHAREABLE_GAIN_LINE_INVALID',
      'must be null or an array of three through eight finite, non-negative gains'
    );
    return false;
  }
  let valid = true;
  for (let index = 0; index < line.length; index += 1) {
    const value = line[index];
    if (!Number.isFinite(value)
        || value < 0
        || value > COMMUNITY_MEASUREMENT_LIMITS.maximumGain) {
      valid = false;
      pushViolation(
        violations,
        codes,
        `${path}.${index}`,
        'SHAREABLE_GAIN_VALUE_INVALID',
        'gain must be finite, non-negative and inside the ingestion bound'
      );
    }
  }
  return valid;
}

export function isCommunityBoardIdentifier(value) {
  return typeof value === 'string'
    && value.length <= COMMUNITY_MEASUREMENT_LIMITS.maximumBoardIdentifierLength
    && COMMUNITY_BOARD_IDENTIFIER_SET.has(value);
}

export function isSupportedRotorflightRevision(value) {
  if (typeof value !== 'string'
      || value.length > COMMUNITY_MEASUREMENT_LIMITS.maximumEquipmentTextLength) {
    return false;
  }
  const match = ROTORFLIGHT_REVISION_PATTERN.exec(value);
  return match !== null
    && COMMUNITY_ROTORFLIGHT_MINOR_VERSION_SET.has(match[1])
    && COMMUNITY_FIRMWARE_TARGET_SET.has(match[3]);
}

function auditBoardIdentifier(value, violations, codes) {
  if (value === null) {
    return false;
  }
  if (!isCommunityBoardIdentifier(value)) {
    pushViolation(
      violations,
      codes,
      'shareableRecord.board',
      'SHAREABLE_BOARD_IDENTIFIER_INVALID',
      `must be one reviewed board identifier: ${SUPPORTED_COMMUNITY_BOARD_IDENTIFIERS.join(', ')}`
    );
    return false;
  }
  return true;
}

function auditFirmwareRevision(value, violations, codes) {
  if (value === null) {
    return false;
  }
  if (!isSupportedRotorflightRevision(value)
      || CONTROL_CHARACTER_PATTERN.test(value)
      || CLOCK_PATTERN.test(value)
      || PATH_PATTERN.test(value)) {
    pushViolation(
      violations,
      codes,
      'shareableRecord.firmwareRevision',
      'SHAREABLE_FIRMWARE_REVISION_INVALID',
      'must be a reviewed Rotorflight 4.3 through 4.6 header with hex commit and target'
    );
    return false;
  }
  return true;
}

function auditRatesFingerprint(value, violations, codes) {
  if (value === null) {
    addCode(codes, 'RATES_FINGERPRINT_MISSING');
    return false;
  }
  if (typeof value !== 'string'
      || value.length > COMMUNITY_MEASUREMENT_LIMITS.maximumRatesFingerprintLength
      || !isRatesFingerprint(value)) {
    pushViolation(
      violations,
      codes,
      'shareableRecord.ratesFingerprint',
      'RATES_FINGERPRINT_INVALID',
      'must be the numeric rf-rates-v2 fingerprint emitted by the current history extractor'
    );
    return false;
  }
  return true;
}

function isRatesFingerprint(value) {
  if (typeof value !== 'string' || !value.startsWith('rf-rates-v2:')) {
    return false;
  }
  const parts = value.slice('rf-rates-v2:'.length).split('|');
  if (parts.length !== 4) {
    return false;
  }
  const expectedWidths = [1, 3, 3, 3];
  return parts.every((part, index) => {
    const values = part.split(',');
    return values.length === expectedWidths[index]
      && values.every(token => CANONICAL_UNSIGNED_INTEGER_PATTERN.test(token)
        && Number.isSafeInteger(Number(token))
        && Number(token) <= (index === 0
          ? 20
          : COMMUNITY_MEASUREMENT_LIMITS.maximumRateDps));
  });
}

function auditHold(hold, axis, violations, codes) {
  const base = `shareableRecord.axes.${axis}.hold`;
  if (!isPlainObject(hold)) {
    pushViolation(violations, codes, base, 'SHAREABLE_HOLD_INVALID', 'hold summary must be an object');
    return;
  }
  if (!HOLD_STATUSES.has(hold.status)) {
    pushViolation(
      violations,
      codes,
      `${base}.status`,
      'SHAREABLE_HOLD_STATUS_INVALID',
      'status must be not-measured, inconclusive or captured'
    );
  }
  for (const field of ['holdCount', 'zeroHoldCount', 'sustainedHoldCount']) {
    auditNullableCount(hold[field], `${base}.${field}`, violations, codes);
  }
  for (const [field, [minimum, maximum]] of Object.entries(HOLD_NUMBER_FIELDS)) {
    auditNullableFinite(
      hold[field],
      minimum,
      maximum,
      `${base}.${field}`,
      'SHAREABLE_HOLD_MEASUREMENT_INVALID',
      violations,
      codes
    );
  }
  if (Number.isInteger(hold.holdCount)
      && Number.isInteger(hold.zeroHoldCount)
      && Number.isInteger(hold.sustainedHoldCount)
      && hold.zeroHoldCount + hold.sustainedHoldCount !== hold.holdCount) {
    pushViolation(
      violations,
      codes,
      base,
      'SHAREABLE_HOLD_COUNTS_INCONSISTENT',
      'zero and sustained hold counts must sum to the total hold count'
    );
  }
  if (hold.status === 'captured' && !(hold.holdCount > 0)) {
    pushViolation(
      violations,
      codes,
      `${base}.holdCount`,
      'SHAREABLE_CAPTURE_WITHOUT_EVIDENCE',
      'captured hold evidence must contain at least one measured hold'
    );
  }
  if (Number.isFinite(hold.meanAbsoluteSteadyStateErrorDps)
      && Number.isFinite(hold.worstAbsoluteSteadyStateErrorDps)
      && hold.worstAbsoluteSteadyStateErrorDps < hold.meanAbsoluteSteadyStateErrorDps) {
    pushViolation(
      violations,
      codes,
      `${base}.worstAbsoluteSteadyStateErrorDps`,
      'SHAREABLE_HOLD_SUMMARY_INCONSISTENT',
      'the worst absolute error cannot be smaller than the mean absolute error'
    );
  }
}

function auditStop(stop, axis, violations, codes) {
  const base = `shareableRecord.axes.${axis}.stop`;
  if (!isPlainObject(stop)) {
    pushViolation(violations, codes, base, 'SHAREABLE_STOP_INVALID', 'stop summary must be an object');
    return;
  }
  if (!STOP_STATUSES.has(stop.status)) {
    pushViolation(
      violations,
      codes,
      `${base}.status`,
      'SHAREABLE_STOP_STATUS_INVALID',
      'status must be not-measured, inconclusive or captured'
    );
  }
  let totalEvents = 0;
  for (const direction of DIRECTIONS) {
    const measured = stop[direction];
    const path = `${base}.${direction}`;
    if (!isPlainObject(measured)) {
      pushViolation(
        violations,
        codes,
        path,
        'SHAREABLE_STOP_DIRECTION_INVALID',
        'direction summary must be an object'
      );
      continue;
    }
    auditRequiredCount(measured.eventCount, `${path}.eventCount`, violations, codes);
    if (Number.isInteger(measured.eventCount) && measured.eventCount > 0) {
      totalEvents += measured.eventCount;
    }
    for (const field of STOP_NUMBER_FIELDS) {
      auditNullableFinite(
        measured[field],
        0,
        COMMUNITY_MEASUREMENT_LIMITS.maximumRateDps,
        `${path}.${field}`,
        'SHAREABLE_STOP_MEASUREMENT_INVALID',
        violations,
        codes
      );
    }
  }
  if (stop.status === 'captured' && totalEvents === 0) {
    pushViolation(
      violations,
      codes,
      base,
      'SHAREABLE_CAPTURE_WITHOUT_EVIDENCE',
      'captured stop evidence must contain at least one measured event'
    );
  }
}

function hasBoundedJsonTree(value) {
  const seen = new WeakSet();
  const stack = [{value, depth: 0}];
  let nodes = 1;
  let enumeratedKeys = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.depth > COMMUNITY_MEASUREMENT_LIMITS.maximumCloneDepth) {
      return false;
    }
    if (current.value === null || typeof current.value !== 'object') {
      continue;
    }
    if (seen.has(current.value)) {
      return false;
    }
    seen.add(current.value);
    // Walk incrementally. Object.values() first materialized every child and
    // then queued all of them, so one very wide hostile object could create a
    // large transient allocation before the node budget was examined.
    for (const key in current.value) {
      enumeratedKeys += 1;
      if (enumeratedKeys > COMMUNITY_MEASUREMENT_LIMITS.maximumCloneNodes) {
        return false;
      }
      if (!Object.hasOwn(current.value, key)) {
        continue;
      }
      nodes += 1;
      if (nodes > COMMUNITY_MEASUREMENT_LIMITS.maximumCloneNodes) {
        return false;
      }
      stack.push({value: current.value[key], depth: current.depth + 1});
    }
  }
  return true;
}

function auditSharedMeasurements(shared, sourceRecord, violations, codes) {
  if (!hasBoundedJsonTree(shared)
      || (sourceRecord !== null && sourceRecord !== undefined
        && !hasBoundedJsonTree(sourceRecord))) {
    pushViolation(
      violations,
      codes,
      'shareableRecord',
      'SHAREABLE_RECORD_AUDIT_FAILED',
      'must be an acyclic JSON tree inside the bounded audit depth and node count'
    );
    return false;
  }
  const sharedAudit = auditShareableRecord(shared, sourceRecord);
  if (!sharedAudit.ok) {
    addCode(codes, 'SHAREABLE_RECORD_AUDIT_FAILED');
    for (const violation of sharedAudit.violations) {
      pushViolation(
        violations,
        codes,
        violation.path ? `shareableRecord.${violation.path}` : 'shareableRecord',
        'SHAREABLE_RECORD_AUDIT_FAILED',
        violation.reason
      );
    }
  }

  if (!isPlainObject(shared)) {
    pushViolation(
      violations,
      codes,
      'shareableRecord',
      'SHAREABLE_RECORD_INVALID',
      'must be the object produced by shareableRecord'
    );
    return false;
  }
  auditRequiredVersion(
    shared.schemaVersion,
    FLIGHT_HISTORY_SCHEMA_VERSION,
    'shareableRecord.schemaVersion',
    'SHAREABLE_RECORD_SCHEMA_VERSION_MISMATCH',
    violations,
    codes
  );
  if (shared.kind !== SHARED_RECORD_KIND) {
    // auditShareableRecord also reports this; the stable code is useful to an
    // endpoint deciding whether to retry or permanently reject.
    addCode(codes, 'SHAREABLE_RECORD_KIND_MISMATCH');
  }

  let contextComplete = true;
  if (shared.ordinal === null) {
    contextComplete = false;
    addCode(codes, 'SHAREABLE_ORDINAL_MISSING');
  } else if (!Number.isInteger(shared.ordinal)
      || shared.ordinal < 0
      || shared.ordinal > COMMUNITY_MEASUREMENT_LIMITS.maximumOrdinal) {
    contextComplete = false;
    pushViolation(
      violations,
      codes,
      'shareableRecord.ordinal',
      'SHAREABLE_ORDINAL_INVALID',
      'must be null or a bounded non-negative integer'
    );
  }

  const boardPresent = auditBoardIdentifier(shared.board, violations, codes);
  const firmwarePresent = auditFirmwareRevision(shared.firmwareRevision, violations, codes);
  if (!boardPresent) {
    contextComplete = false;
    if (shared.board === null) {
      addCode(codes, 'BOARD_INFORMATION_MISSING');
    }
  }
  if (!firmwarePresent) {
    contextComplete = false;
    if (shared.firmwareRevision === null) {
      addCode(codes, 'FIRMWARE_REVISION_MISSING');
    }
  }

  if (!WINDOW_BASES.has(shared.windowBasis)
      || !AIRBORNE_WINDOW_BASES.includes(shared.windowBasis)) {
    pushViolation(
      violations,
      codes,
      'shareableRecord.windowBasis',
      'SHAREABLE_FLIGHT_NOT_AIRBORNE',
      'community measurements must come from an airborne window'
    );
  }
  if (!Number.isFinite(shared.durationSeconds)
      || shared.durationSeconds <= 0
      || shared.durationSeconds > COMMUNITY_MEASUREMENT_LIMITS.maximumDurationSeconds) {
    pushViolation(
      violations,
      codes,
      'shareableRecord.durationSeconds',
      'SHAREABLE_DURATION_INVALID',
      'must be a finite positive flight duration inside the ingestion bound'
    );
  }

  if (!auditRatesFingerprint(shared.ratesFingerprint, violations, codes)) {
    contextComplete = false;
  }

  if (!isPlainObject(shared.gains)) {
    contextComplete = false;
    pushViolation(
      violations,
      codes,
      'shareableRecord.gains',
      'SHAREABLE_GAINS_INVALID',
      'gains must contain roll, pitch and yaw lines'
    );
  } else {
    for (const axis of AXES) {
      if (!auditGainLine(shared.gains[axis], `shareableRecord.gains.${axis}`, violations, codes)) {
        contextComplete = false;
      }
    }
    if (AXES.some(axis => shared.gains[axis] === null)) {
      addCode(codes, 'SHAREABLE_GAINS_INCOMPLETE');
    }
  }

  if (!isPlainObject(shared.axes)) {
    pushViolation(
      violations,
      codes,
      'shareableRecord.axes',
      'SHAREABLE_AXES_INVALID',
      'axes must contain roll, pitch and yaw summaries'
    );
    return false;
  }

  for (const axis of AXES) {
    const measured = shared.axes[axis];
    const base = `shareableRecord.axes.${axis}`;
    if (!isPlainObject(measured)) {
      pushViolation(
        violations,
        codes,
        base,
        'SHAREABLE_AXIS_INVALID',
        'axis summary must be an object'
      );
      continue;
    }
    auditNullableFinite(
      measured.headspeedMedianRpm,
      1,
      COMMUNITY_MEASUREMENT_LIMITS.maximumHeadspeedRpm,
      `${base}.headspeedMedianRpm`,
      'SHAREABLE_HEADSPEED_INVALID',
      violations,
      codes
    );
    if (measured.headspeedMedianRpm === null) {
      contextComplete = false;
      addCode(codes, 'SHAREABLE_HEADSPEED_INCOMPLETE');
    }
    auditHold(measured.hold, axis, violations, codes);
    auditStop(measured.stop, axis, violations, codes);
    if (!isPlainObject(measured.noise)) {
      pushViolation(
        violations,
        codes,
        `${base}.noise`,
        'SHAREABLE_NOISE_INVALID',
        'noise summary must be an object'
      );
    } else {
      for (const field of ['filteredHighFrequencyRmsDps', 'unfilteredHighFrequencyRmsDps']) {
        auditNullableFinite(
          measured.noise[field],
          0,
          COMMUNITY_MEASUREMENT_LIMITS.maximumRateDps,
          `${base}.noise.${field}`,
          'SHAREABLE_NOISE_MEASUREMENT_INVALID',
          violations,
          codes
        );
      }
    }
  }
  return contextComplete;
}

function completeAirframe(profile) {
  return isPlainObject(profile) && AIRFRAME_FIELDS.every(field => profile[field] !== null);
}

function completeFingerprints(fingerprints) {
  return isPlainObject(fingerprints)
    && COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_STATUS === 'complete'
    && Array.isArray(COMMUNITY_CONFIG_FINGERPRINT_REQUIRED_KEYS.filter)
    && Array.isArray(COMMUNITY_CONFIG_FINGERPRINT_REQUIRED_KEYS.governor)
    && fingerprints.schemaVersion === COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_VERSION
    && ['filter', 'governor'].every(field => isSha256Fingerprint(fingerprints[field]));
}

function completeSharedContext(shared) {
  return isPlainObject(shared)
    && Number.isInteger(shared.ordinal)
    && shared.ordinal >= 0
    && isCommunityBoardIdentifier(shared.board)
    && isSupportedRotorflightRevision(shared.firmwareRevision)
    && typeof shared.ratesFingerprint === 'string'
    && isRatesFingerprint(shared.ratesFingerprint)
    && isPlainObject(shared.gains)
    && AXES.every(axis => Array.isArray(shared.gains[axis]))
    && isPlainObject(shared.axes)
    && AXES.every(axis => Number.isFinite(shared.axes?.[axis]?.headspeedMedianRpm));
}

function cohortKeyFromValidContribution(contribution) {
  const headspeedBands = axisHeadspeedBandIndices(contribution?.shareableRecord);
  if (!completeAirframe(contribution?.airframeProfile)
      || !completeFingerprints(contribution?.configFingerprints)
      || contribution?.safetyAssessment?.airframe !== 'clear'
      || !completeSharedContext(contribution?.shareableRecord)
      || headspeedBands === null
      || contribution?.extractorVersion !== COMMUNITY_EXTRACTOR_VERSION) {
    return null;
  }
  const profile = contribution.airframeProfile;
  const shared = contribution.shareableRecord;
  const config = contribution.configFingerprints;
  const fields = [
    COMMUNITY_EXTRACTOR_VERSION,
    rotorDiameterBandMm(profile.rotorDiameterMm),
    profile.bladeCount,
    profile.powerType,
    profile.cyclicServoClass,
    profile.tailServoClass,
    headspeedBands.roll,
    headspeedBands.pitch,
    headspeedBands.yaw,
    shared.board,
    shared.firmwareRevision,
    shared.ratesFingerprint,
    config.schemaVersion,
    config.filter,
    config.governor
  ];
  return `rotorlens-community-cohort-v${COMMUNITY_COHORT_VERSION}:`
    + fields.map(value => encodeURIComponent(String(value))).join('|');
}

/**
 * Deterministic cohort key, or null when any confound is missing/malformed.
 * The key contains only structured airframe/configuration facts; never the
 * sharing id, contribution id, ordinal, legal versions or guidance source.
 */
export function buildCommunityCohortKey(contribution) {
  const candidate = cohortKeyFromValidContribution(contribution);
  if (candidate === null) {
    return null;
  }
  // The public helper must also fail closed for malformed-but-complete values.
  const audit = auditCommunityContribution(contribution);
  return audit.ok && audit.cohortEligible ? candidate : null;
}

/** Short alias used by offline model builders. */
export const communityCohortKey = buildCommunityCohortKey;

/**
 * Audits a contribution at the last boundary before transport or ingestion.
 *
 * @param {object} contribution candidate community envelope
 * @param {object|null} sourceRecord optional local source record. Supplying it
 *   enables `auditShareableRecord`'s by-value name-leak check.
 * @returns frozen audit result with stable machine-readable codes
 */
export function auditCommunityContribution(contribution, sourceRecord = null) {
  const violations = [];
  const codes = [];

  if (!auditShape(contribution, OUTER_FIELDS, '', violations, codes)) {
    return Object.freeze({
      ok: false,
      eligibility: COMMUNITY_ELIGIBILITY.REJECTED,
      measurementEligible: false,
      cohortEligible: false,
      adviceEligible: false,
      cohortKey: null,
      codes: Object.freeze(codes),
      violations: Object.freeze(violations)
    });
  }

  auditRequiredVersion(
    contribution.schemaVersion,
    COMMUNITY_CONTRIBUTION_SCHEMA_VERSION,
    'schemaVersion',
    'CONTRIBUTION_SCHEMA_VERSION_MISMATCH',
    violations,
    codes
  );
  if (contribution.kind !== COMMUNITY_CONTRIBUTION_KIND) {
    pushViolation(
      violations,
      codes,
      'kind',
      'CONTRIBUTION_KIND_MISMATCH',
      `must be ${COMMUNITY_CONTRIBUTION_KIND}`
    );
  }
  auditRequiredVersion(
    contribution.extractorVersion,
    COMMUNITY_EXTRACTOR_VERSION,
    'extractorVersion',
    'EXTRACTOR_VERSION_MISMATCH',
    violations,
    codes
  );
  auditLegalVersion(
    contribution.consentVersion,
    COMMUNITY_CONSENT_VERSION_SET,
    DRAFT_COMMUNITY_CONSENT_VERSION_SET,
    'consentVersion',
    'CONSENT_VERSION_INVALID',
    'CONSENT_VERSION_NOT_ADOPTED',
    violations,
    codes
  );
  auditLegalVersion(
    contribution.licenceVersion,
    COMMUNITY_LICENCE_VERSION_SET,
    DRAFT_COMMUNITY_LICENCE_VERSION_SET,
    'licenceVersion',
    'LICENCE_VERSION_INVALID',
    'LICENCE_VERSION_NOT_ADOPTED',
    violations,
    codes
  );
  if (!isCommunityContributionId(contribution.contributionId)) {
    pushViolation(
      violations,
      codes,
      'contributionId',
      'CONTRIBUTION_ID_INVALID',
      'must be hmac-sha256 followed by one unpadded 32-byte base64url digest'
    );
  }

  const profileComplete = auditAirframe(contribution.airframeProfile, violations, codes);
  const fingerprintsComplete = auditConfigFingerprints(
    contribution.configFingerprints,
    violations,
    codes
  );
  const airframeSafetyClear = auditSafetyAssessment(
    contribution.safetyAssessment,
    violations,
    codes
  );
  auditGuidance(contribution.guidance, violations, codes);
  auditTrial(contribution.trial, violations, codes);
  let sharedContextComplete = false;
  try {
    sharedContextComplete = auditSharedMeasurements(
      contribution.shareableRecord,
      sourceRecord,
      violations,
      codes
    );
  } catch {
    pushViolation(
      violations,
      codes,
      'shareableRecord',
      'SHAREABLE_RECORD_AUDIT_FAILED',
      'shareable record exceeded bounded audit complexity or could not be safely inspected'
    );
  }

  const ok = violations.length === 0;
  const measurementEligible = ok;
  const cohortEligible = ok
    && profileComplete
    && fingerprintsComplete
    && airframeSafetyClear
    && sharedContextComplete;
  const adviceEligible = cohortEligible;
  const cohortKey = cohortEligible ? cohortKeyFromValidContribution(contribution) : null;
  const eligibility = !measurementEligible
    ? COMMUNITY_ELIGIBILITY.REJECTED
    : adviceEligible
      ? COMMUNITY_ELIGIBILITY.ADVICE
      : COMMUNITY_ELIGIBILITY.MEASUREMENT_ONLY;

  if (measurementEligible && !adviceEligible) {
    addCode(codes, 'COMMUNITY_MEASUREMENT_ONLY');
  }

  return Object.freeze({
    ok,
    eligibility,
    measurementEligible,
    cohortEligible,
    adviceEligible,
    cohortKey,
    codes: Object.freeze(codes),
    violations: Object.freeze(violations)
  });
}
