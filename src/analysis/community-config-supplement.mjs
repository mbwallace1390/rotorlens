/**
 * Digest-only inspection of an already-sanitized Rotorflight configuration
 * supplement. Raw controller transcripts are intentionally outside this API.
 */

import {sha256Hex} from '../integrity.mjs';

export const COMMUNITY_CONFIG_SUPPLEMENT_SCHEMA_VERSION = 1;
export const COMMUNITY_CONFIG_SUPPLEMENT_SNAPSHOT_KIND =
  'rotorlens-community-config-supplement-snapshot-v1';
export const COMMUNITY_CONFIG_SUPPLEMENT_REPORT_KIND =
  'rotorlens-community-config-supplement-report-v1';
export const COMMUNITY_CONFIG_SUPPLEMENT_FINGERPRINT_KIND =
  'rotorlens-community-config-supplement-v1';
export const COMMUNITY_CONFIG_SUPPLEMENT_INSPECTOR_VERSION =
  'rotorlens-community-config-supplement-inspector-v1';

export const COMMUNITY_CONFIG_SUPPLEMENT_CODES = Object.freeze([
  'SNAPSHOT_TOO_LARGE',
  'SNAPSHOT_UTF8_INVALID',
  'SNAPSHOT_JSON_INVALID',
  'SNAPSHOT_ENCODING_NONCANONICAL',
  'SNAPSHOT_SCHEMA_INVALID',
  'SNAPSHOT_ROW_LIMIT_EXCEEDED',
  'SNAPSHOT_ROW_INVALID',
  'SNAPSHOT_ROW_UNKNOWN',
  'SNAPSHOT_ROW_DUPLICATE',
  'SNAPSHOT_ROW_MISSING',
  'SNAPSHOT_FIRMWARE_UNREVIEWED',
  'SNAPSHOT_SETTING_INVALID',
  'SNAPSHOT_CROSS_FIELD_INVALID',
  'SNAPSHOT_FLIGHT_BINDING_UNPROVEN',
  'CONFIGURATION_TRANSITIVE_CONTEXT_MISSING',
  'COMMUNITY_CONFIGURATION_CLOSED'
]);

const CODE_ORDER = new Map(
  COMMUNITY_CONFIG_SUPPLEMENT_CODES.map((code, index) => [code, index])
);
// Preserve a leading BOM so the canonical-byte boundary can reject it.
const DECODER = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const ENCODER = new TextEncoder();
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get;
const MAX_BYTES = 256 * 1024;
const MAX_ROWS = 256;
const MAX_TOKEN_LENGTH = 64;
const ACQUISITIONS = new Set(['cli']);
const BOARDS = Object.freeze(['FRSK VANTAC_RF007', 'NEXUS']);
const BASE64URL =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const COMMON_SOURCE_PATHS = Object.freeze([
  'src/main/cli/settings.c',
  'src/main/cli/cli.c',
  'src/main/msp/msp.c',
  'src/main/msp/msp_protocol.h',
  'src/main/blackbox/blackbox.c',
  'src/main/config/config.c',
  'src/main/fc/rc_rates.c',
  'src/main/fc/rc_rates.h',
  'src/main/fc/parameter_names.h',
  'src/main/flight/governor.c',
  'src/main/flight/governor.h',
  'src/main/pg/pid.h',
  'src/main/flight/mixer.c',
  'src/main/flight/mixer.h',
  'src/main/target/common_pre.h'
]);

function sourcePaths(minor) {
  return Object.freeze(minor === '4.3'
    ? [...COMMON_SOURCE_PATHS]
    : [
      ...COMMON_SOURCE_PATHS,
      'src/main/pg/governor.c',
      'src/main/pg/governor.h',
      'src/main/pg/rates.c',
      'src/main/pg/rates.h'
    ]);
}

function integer(scope, key, minimum, maximum) {
  return Object.freeze({scope, key, type: 'integer', minimum, maximum,
    length: null, values: null});
}

function vector(scope, key, minimum, maximum, length) {
  return Object.freeze({scope, key, type: 'vector', minimum, maximum,
    length, values: null});
}

function text(scope, key, values) {
  return Object.freeze({scope, key, type: 'string', minimum: null,
    maximum: null, length: null, values: Object.freeze([...values])});
}

const bool = (scope, key) => integer(scope, key, 0, 1);

function metaFields(version, shortCommit) {
  return [
    text('meta', 'firmware_version', [version]),
    text('meta', 'firmware_commit', [shortCommit]),
    text('meta', 'firmware_target', ['STM32F7X2']),
    text('meta', 'board', BOARDS),
    integer('meta', 'pid_profile', 0, 5),
    integer('meta', 'rate_profile', 0, 5)
  ];
}

function rateFields(minor) {
  const fields = [integer('rates', 'rates_type', 1, minor === '4.6' ? 6 : 5)];
  for (const axis of ['roll', 'pitch', 'yaw', 'collective']) {
    fields.push(
      integer('rates', `${axis}_rc_rate`, 1, 255),
      integer('rates', `${axis}_expo`, 0, 100),
      integer('rates', `${axis}_srate`, 0, 255),
      integer('rates', `${axis}_accel_limit`, 0, 50000),
      integer('rates', `${axis}_response`, 0, 250)
    );
  }
  fields.push(
    integer('rates', 'roll_level_expo', 0, 100),
    integer('rates', 'pitch_level_expo', 0, 100),
    integer('rates', 'cyclic_ring', 0, minor === '4.6' ? 250 : 100)
  );
  if (minor !== '4.6') fields.push(bool('rates', 'quickrates_rc_expo'));
  if (minor === '4.5' || minor === '4.6') {
    fields.push(
      vector('rates', 'setpoint_boost_gain', 0, 255, 4),
      vector('rates', 'setpoint_boost_cutoff', 0, 255, 4),
      integer('rates', 'yaw_dynamic_ceiling_gain', 0, 250),
      integer('rates', 'yaw_dynamic_deadband_gain', 0, 250),
      integer('rates', 'yaw_dynamic_deadband_filter', 0, 250),
      integer('rates', 'yaw_dynamic_deadband_cutoff', 0, 250)
    );
  }
  if (minor === '4.6') fields.push(bool('rates', 'cyclic_polar'));
  return fields;
}

function legacyGovernorMaster(minor) {
  const fields = [
    integer('governor-master', 'gov_mode', 0, 4),
    integer('governor-master', 'gov_startup_time', 0, 600),
    integer('governor-master', 'gov_spoolup_time', 0, 600),
    integer('governor-master', 'gov_tracking_time', 0, 100),
    integer('governor-master', 'gov_recovery_time', 0, 100),
    integer('governor-master', 'gov_autorotation_timeout', 0, 600),
    integer('governor-master', 'gov_autorotation_bailout_time', 0, 100),
    integer('governor-master', 'gov_autorotation_min_entry_time', 0, 600),
    integer('governor-master', 'gov_zero_throttle_timeout', 0, 100),
    integer('governor-master', 'gov_lost_headspeed_timeout', 0, 100),
    integer('governor-master', 'gov_handover_throttle', 10, 50),
    integer('governor-master', 'gov_pwr_filter', 0, 250),
    integer('governor-master', 'gov_rpm_filter', 0, 250),
    integer('governor-master', 'gov_tta_filter', 0, 250),
    integer('governor-master', 'gov_ff_filter', 0, 250)
  ];
  if (minor === '4.5') {
    fields.push(integer('governor-master', 'gov_spoolup_min_throttle', 0, 50));
  }
  return fields;
}

function legacyGovernorProfile(minor) {
  const fields = [
    integer('governor-profile', 'gov_headspeed', 0, 50000),
    integer('governor-profile', 'gov_gain', 0, 250),
    integer('governor-profile', 'gov_p_gain', 0, 250),
    integer('governor-profile', 'gov_i_gain', 0, 250),
    integer('governor-profile', 'gov_d_gain', 0, 250),
    integer('governor-profile', 'gov_f_gain', 0, 250),
    integer('governor-profile', 'gov_tta_gain', 0, 250),
    integer('governor-profile', 'gov_tta_limit', 0, 250),
    integer('governor-profile', 'gov_yaw_ff_weight', 0, 250),
    integer('governor-profile', 'gov_cyclic_ff_weight', 0, 250),
    integer('governor-profile', 'gov_collective_ff_weight', 0, 250),
    integer('governor-profile', 'gov_max_throttle', 0, 100)
  ];
  if (minor === '4.4' || minor === '4.5') {
    fields.push(integer('governor-profile', 'gov_min_throttle', 0, 100));
  }
  if (minor === '4.5') {
    for (const term of ['p', 'i', 'd', 'f']) {
      fields.push(integer('governor-profile', `gov_${term}_limit`, 0, 100));
    }
  }
  return fields;
}

function currentGovernor() {
  const fields = [
    integer('governor-master', 'gov_mode', 0, 4),
    integer('governor-master', 'gov_throttle_type', 0, 2),
    integer('governor-master', 'gov_startup_time', 0, 600),
    integer('governor-master', 'gov_spoolup_time', 0, 600),
    integer('governor-master', 'gov_tracking_time', 0, 600),
    integer('governor-master', 'gov_recovery_time', 0, 600),
    integer('governor-master', 'gov_spooldown_time', 0, 600),
    integer('governor-master', 'gov_throttle_hold_timeout', 0, 250),
    integer('governor-master', 'gov_autorotation_timeout', 0, 250),
    integer('governor-master', 'gov_handover_throttle', 10, 100),
    integer('governor-master', 'gov_idle_throttle', 0, 250),
    integer('governor-master', 'gov_auto_throttle', 0, 250),
    vector('governor-master', 'gov_bypass_throttle', 0, 255, 9),
    integer('governor-master', 'gov_pwr_filter', 0, 250),
    integer('governor-master', 'gov_rpm_filter', 0, 250),
    integer('governor-master', 'gov_tta_filter', 0, 250),
    integer('governor-master', 'gov_ff_filter', 0, 250),
    integer('governor-master', 'gov_d_filter', 0, 250)
  ];
  for (const key of [
    'gov_use_fallback_precomp',
    'gov_use_pid_spoolup',
    'gov_use_voltage_comp',
    'gov_use_dyn_min_throttle'
  ]) fields.push(bool('governor-profile', key));
  fields.push(
    integer('governor-profile', 'gov_headspeed', 0, 50000),
    integer('governor-profile', 'gov_gain', 0, 250),
    integer('governor-profile', 'gov_p_gain', 0, 250),
    integer('governor-profile', 'gov_i_gain', 0, 250),
    integer('governor-profile', 'gov_d_gain', 0, 250),
    integer('governor-profile', 'gov_f_gain', 0, 250),
    integer('governor-profile', 'gov_p_limit', 0, 100),
    integer('governor-profile', 'gov_i_limit', 0, 100),
    integer('governor-profile', 'gov_d_limit', 0, 100),
    integer('governor-profile', 'gov_f_limit', 0, 100),
    integer('governor-profile', 'gov_tta_gain', 0, 250),
    integer('governor-profile', 'gov_tta_limit', 0, 250),
    integer('governor-profile', 'gov_yaw_ff_weight', 0, 250),
    integer('governor-profile', 'gov_cyclic_ff_weight', 0, 250),
    integer('governor-profile', 'gov_collective_ff_weight', 0, 250),
    integer('governor-profile', 'gov_max_throttle', 10, 100),
    integer('governor-profile', 'gov_min_throttle', 10, 100),
    integer('governor-profile', 'gov_fallback_drop', 0, 50),
    integer('governor-profile', 'gov_collective_curve', 5, 40),
    integer('governor-profile', 'gov_dyn_min_throttle', 0, 100)
  );
  return fields;
}

function mixerFields() {
  return [
    integer('mixer', 'sc_min', -2500, 2500),
    integer('mixer', 'sc_max', -2500, 2500),
    integer('mixer', 'sc_rate', -10000, 10000)
  ];
}

function makeManifest(version, commit, minor) {
  const fields = [
    ...metaFields(version, commit.slice(0, 7)),
    ...rateFields(minor),
    ...(minor === '4.6'
      ? currentGovernor()
      : [...legacyGovernorMaster(minor), ...legacyGovernorProfile(minor)]),
    ...mixerFields()
  ];
  const identities = fields.map(field => `${field.scope}\u0000${field.key}`);
  if (new Set(identities).size !== identities.length) {
    throw new Error('Duplicate supplement manifest field');
  }
  return Object.freeze({
    id: `rotorflight-config-supplement-${version}-r1`,
    version,
    commit,
    shortCommit: commit.slice(0, 7),
    target: 'STM32F7X2',
    sourcePaths: sourcePaths(minor),
    fields: Object.freeze(fields)
  });
}

export const COMMUNITY_CONFIG_SUPPLEMENT_MANIFESTS = Object.freeze({
  '4.3.0': makeManifest(
    '4.3.0', '05570fec69fd566e713f11e84adc7b77a8d68abf', '4.3'
  ),
  '4.4.0': makeManifest(
    '4.4.0', '5fc142adfdc4031877061433c5052e473b9cdfd2', '4.4'
  ),
  '4.4.1': makeManifest(
    '4.4.1', '456633bcea79933142c7fee17922ab306028bcf9', '4.4'
  ),
  '4.5.0': makeManifest(
    '4.5.0', 'e77d192c43c4b36ef4d18b67d24859ddc0968755', '4.5'
  ),
  '4.5.1': makeManifest(
    '4.5.1', 'e69823a3c185cbf1b75fd2701e938e978591a36b', '4.5'
  ),
  '4.6.0': makeManifest(
    '4.6.0', '118e9120260bb33f46df4f92052fb0e9fd4e9ebc', '4.6'
  )
});

function addCode(codes, code) {
  if (!codes.includes(code)) codes.push(code);
}

function orderedCodes(codes) {
  return Object.freeze([...codes].sort(
    (left, right) => CODE_ORDER.get(left) - CODE_ORDER.get(right)
  ));
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function makeReport({manifest = null, fingerprint = null, rowCount = 0,
  codes = []} = {}) {
  const valid = manifest !== null && fingerprint !== null;
  const allCodes = [...codes];
  addCode(allCodes, 'SNAPSHOT_FLIGHT_BINDING_UNPROVEN');
  addCode(allCodes, 'CONFIGURATION_TRANSITIVE_CONTEXT_MISSING');
  addCode(allCodes, 'COMMUNITY_CONFIGURATION_CLOSED');
  return deepFreeze({
    schemaVersion: COMMUNITY_CONFIG_SUPPLEMENT_SCHEMA_VERSION,
    kind: COMMUNITY_CONFIG_SUPPLEMENT_REPORT_KIND,
    inspectorVersion: COMMUNITY_CONFIG_SUPPLEMENT_INSPECTOR_VERSION,
    firmwareManifest: valid ? manifest.id : null,
    supplement: valid ? fingerprint : null,
    coverage: {
      rates: valid ? 'reviewed-active-rate-profile' : 'unavailable',
      governor: valid ? 'reviewed-governor-settings-partial' : 'unavailable',
      mixer: valid ? 'reviewed-collective-input-partial' : 'unavailable'
    },
    acceptedRowCount: valid ? rowCount : 0,
    requiredRowCount: valid ? manifest.fields.length : 0,
    snapshotValid: valid,
    binding: 'unproven',
    complete: false,
    cohortEligible: false,
    adviceEligible: false,
    codes: orderedCodes(allCodes)
  });
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length === expected.length
    && expected.every(key => Object.hasOwn(value, key));
}

function validInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validValue(value, specification) {
  if (specification.type === 'string') {
    return typeof value === 'string'
      && value.length <= MAX_TOKEN_LENGTH
      && specification.values.includes(value);
  }
  if (specification.type === 'integer') {
    return validInteger(value, specification.minimum, specification.maximum);
  }
  return Array.isArray(value)
    && value.length === specification.length
    && value.every(component => validInteger(
      component, specification.minimum, specification.maximum
    ));
}

const identity = (scope, key) => `${scope}\u0000${key}`;
const get = (values, scope, key) => values.get(identity(scope, key));

const RATE_LIMITS_43_45 = Object.freeze({
  1: Object.freeze([255, 100, 100]),
  2: Object.freeze([200, 255, 100]),
  3: Object.freeze([255, 99, 100]),
  4: Object.freeze([200, 200, 100]),
  5: Object.freeze([255, 200, 100])
});
const RATE_LIMITS_46 = Object.freeze({
  1: Object.freeze([255, 90, 100]),
  2: Object.freeze([200, 255, 100]),
  3: Object.freeze([255, 90, 100]),
  4: Object.freeze([200, 200, 100]),
  5: Object.freeze([255, 200, 100]),
  6: Object.freeze([200, 100, 100])
});

function crossFieldsValid(values, manifest) {
  const ratesType = get(values, 'rates', 'rates_type');
  const limits = manifest.version === '4.6.0'
    ? RATE_LIMITS_46[ratesType]
    : RATE_LIMITS_43_45[ratesType];
  if (limits === undefined) return false;
  for (const axis of ['roll', 'pitch', 'yaw']) {
    if (get(values, 'rates', `${axis}_rc_rate`) > limits[0]
        || get(values, 'rates', `${axis}_srate`) > limits[1]
        || get(values, 'rates', `${axis}_expo`) > limits[2]) return false;
  }
  if (get(values, 'mixer', 'sc_min') > get(values, 'mixer', 'sc_max')) {
    return false;
  }
  if (manifest.version !== '4.6.0') return true;

  const mode = get(values, 'governor-master', 'gov_mode');
  const throttleType = get(values, 'governor-master', 'gov_throttle_type');
  const handover = get(values, 'governor-master', 'gov_handover_throttle');
  const idle = get(values, 'governor-master', 'gov_idle_throttle');
  const automatic = get(values, 'governor-master', 'gov_auto_throttle');
  const maximumIdle = Math.min(250, handover * 10 - 1);
  if ((mode < 3 && throttleType === 1)
      || idle > automatic
      || automatic > maximumIdle) return false;
  if (mode === 1 || mode === 2) {
    for (const key of [
      'gov_use_fallback_precomp',
      'gov_use_pid_spoolup',
      'gov_use_voltage_comp',
      'gov_use_dyn_min_throttle'
    ]) {
      if (get(values, 'governor-profile', key) !== 0) return false;
    }
  }
  if (mode !== 0) {
    const maximum = get(values, 'governor-profile', 'gov_max_throttle');
    const minimum = get(values, 'governor-profile', 'gov_min_throttle');
    if (maximum < handover || minimum > maximum) return false;
  }
  return true;
}

function hexBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function encodeBase64url(bytes) {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index;
    const first = bytes[index];
    const second = remaining > 1 ? bytes[index + 1] : 0;
    const third = remaining > 2 ? bytes[index + 2] : 0;
    encoded += BASE64URL[first >>> 2];
    encoded += BASE64URL[((first & 3) << 4) | (second >>> 4)];
    if (remaining > 1) {
      encoded += BASE64URL[((second & 15) << 2) | (third >>> 6)];
    }
    if (remaining > 2) encoded += BASE64URL[third & 63];
  }
  return encoded;
}

function buildFingerprint(manifest, rows) {
  const sorted = rows.map(row => [row[0], row[1], row[2]])
    .sort((left, right) => {
      const scope = left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
      if (scope !== 0) return scope;
      return left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0;
    });
  const canonical = JSON.stringify({
    schemaVersion: COMMUNITY_CONFIG_SUPPLEMENT_SCHEMA_VERSION,
    kind: COMMUNITY_CONFIG_SUPPLEMENT_FINGERPRINT_KIND,
    manifest: manifest.id,
    rows: sorted
  });
  const digest = encodeBase64url(hexBytes(sha256Hex(ENCODER.encode(canonical))));
  return Object.freeze({
    schemaVersion: COMMUNITY_CONFIG_SUPPLEMENT_SCHEMA_VERSION,
    kind: COMMUNITY_CONFIG_SUPPLEMENT_FINGERPRINT_KIND,
    algorithm: 'sha256',
    digest: `sha256:${digest}`
  });
}

/** Inspect canonical UTF-8 bytes and never echo rejected content. */
export function inspectCommunityConfigSupplement(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('bytes must be a Uint8Array');
  }
  let byteLength;
  try {
    byteLength = TYPED_ARRAY_BYTE_LENGTH.call(bytes);
  } catch {
    return makeReport({codes: ['SNAPSHOT_UTF8_INVALID']});
  }
  if (byteLength > MAX_BYTES) {
    return makeReport({codes: ['SNAPSHOT_TOO_LARGE']});
  }
  let source;
  try {
    source = DECODER.decode(bytes);
  } catch {
    return makeReport({codes: ['SNAPSHOT_UTF8_INVALID']});
  }
  if (source.charCodeAt(0) === 0xfeff) {
    return makeReport({codes: ['SNAPSHOT_ENCODING_NONCANONICAL']});
  }
  let snapshot;
  try {
    snapshot = JSON.parse(source);
  } catch {
    return makeReport({codes: ['SNAPSHOT_JSON_INVALID']});
  }
  let canonicalSource;
  try {
    canonicalSource = JSON.stringify(snapshot);
  } catch {
    return makeReport({codes: ['SNAPSHOT_SCHEMA_INVALID']});
  }
  if (canonicalSource !== source) {
    return makeReport({codes: ['SNAPSHOT_ENCODING_NONCANONICAL']});
  }
  if (!exactKeys(snapshot, ['schemaVersion', 'kind', 'acquisition', 'rows'])
      || snapshot.schemaVersion !== COMMUNITY_CONFIG_SUPPLEMENT_SCHEMA_VERSION
      || snapshot.kind !== COMMUNITY_CONFIG_SUPPLEMENT_SNAPSHOT_KIND
      || !ACQUISITIONS.has(snapshot.acquisition)
      || !Array.isArray(snapshot.rows)) {
    return makeReport({codes: ['SNAPSHOT_SCHEMA_INVALID']});
  }
  if (snapshot.rows.length > MAX_ROWS) {
    return makeReport({codes: ['SNAPSHOT_ROW_LIMIT_EXCEEDED']});
  }

  const values = new Map();
  const earlyCodes = [];
  for (const row of snapshot.rows) {
    if (!Array.isArray(row) || row.length !== 3
        || typeof row[0] !== 'string' || typeof row[1] !== 'string'
        || row[0].length === 0 || row[1].length === 0
        || row[0].length > MAX_TOKEN_LENGTH || row[1].length > MAX_TOKEN_LENGTH) {
      addCode(earlyCodes, 'SNAPSHOT_ROW_INVALID');
      continue;
    }
    const rowId = identity(row[0], row[1]);
    if (values.has(rowId)) addCode(earlyCodes, 'SNAPSHOT_ROW_DUPLICATE');
    else values.set(rowId, row[2]);
  }
  if (earlyCodes.length > 0) return makeReport({codes: earlyCodes});

  const version = get(values, 'meta', 'firmware_version');
  const manifest = typeof version === 'string'
    && Object.hasOwn(COMMUNITY_CONFIG_SUPPLEMENT_MANIFESTS, version)
    ? COMMUNITY_CONFIG_SUPPLEMENT_MANIFESTS[version]
    : undefined;
  if (manifest === undefined
      || get(values, 'meta', 'firmware_commit') !== manifest.shortCommit
      || get(values, 'meta', 'firmware_target') !== manifest.target) {
    return makeReport({codes: ['SNAPSHOT_FIRMWARE_UNREVIEWED']});
  }

  const specs = new Map(manifest.fields.map(specification => [
    identity(specification.scope, specification.key), specification
  ]));
  const codes = [];
  for (const rowId of values.keys()) {
    if (!specs.has(rowId)) addCode(codes, 'SNAPSHOT_ROW_UNKNOWN');
  }
  for (const [rowId, specification] of specs) {
    if (!values.has(rowId)) addCode(codes, 'SNAPSHOT_ROW_MISSING');
    else if (!validValue(values.get(rowId), specification)) {
      addCode(codes, 'SNAPSHOT_SETTING_INVALID');
    }
  }
  if (codes.length === 0 && !crossFieldsValid(values, manifest)) {
    addCode(codes, 'SNAPSHOT_CROSS_FIELD_INVALID');
  }
  if (codes.length > 0) return makeReport({codes});

  return makeReport({
    manifest,
    fingerprint: buildFingerprint(manifest, snapshot.rows),
    rowCount: snapshot.rows.length
  });
}
