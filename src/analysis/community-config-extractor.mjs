/**
 * Offline, fail-closed extraction of the tuning context Rotorflight writes to
 * a Blackbox session header.
 *
 * This is deliberately a partial fingerprint. Rotorflight 4.3-4.6 omits
 * load-bearing collective-rate and governor configuration, so this module can
 * never make a contribution cohort- or advice-eligible by itself. It returns
 * only a versioned digest and closed diagnostics; raw settings, names, dates,
 * paths, and arbitrary header text never leave this boundary.
 */

import {sha256Hex} from '../integrity.mjs';

export const COMMUNITY_CONFIG_EXTRACTION_SCHEMA_VERSION = 1;
export const COMMUNITY_BLACKBOX_CONFIG_EXTRACTOR_VERSION =
  'rotorlens-blackbox-context-v2';
export const COMMUNITY_BLACKBOX_FILTER_FINGERPRINT_SCHEMA_VERSION = 2;
export const COMMUNITY_BLACKBOX_FILTER_FINGERPRINT_KIND =
  'rotorlens-blackbox-tuning-context-v2';
export const COMMUNITY_BLACKBOX_FILTER_COVERAGE =
  'reviewed-blackbox-tuning-context-partial';
export const COMMUNITY_BLACKBOX_GOVERNOR_COVERAGE = 'insufficient';

export const COMMUNITY_CONFIG_EXTRACTION_CODES = Object.freeze([
  'SESSION_DEFINITION_INVALID',
  'HEADER_ENTRIES_UNAVAILABLE',
  'HEADER_ENTRIES_MUTABLE',
  'HEADER_TERMINATION_UNCLEAN',
  'HEADER_EVIDENCE_LIMIT_EXCEEDED',
  'FIRMWARE_HEADER_INVALID',
  'FIRMWARE_RELEASE_NOT_REVIEWED',
  'FILTER_SETTING_MISSING',
  'FILTER_SETTING_DUPLICATE',
  'FILTER_SETTING_INVALID',
  'BLACKBOX_CONFIGURATION_PARTIAL',
  'GOVERNOR_CONFIGURATION_NOT_LOGGED'
]);

const CODE_ORDER = new Map(
  COMMUNITY_CONFIG_EXTRACTION_CODES.map((code, index) => [code, index])
);
const MAXIMUM_HEADER_ENTRIES = 1024;
const MAXIMUM_HEADER_KEY_CODE_UNITS = 128;
const MAXIMUM_HEADER_VALUE_CODE_UNITS = 8192;
const MAXIMUM_HEADER_TEXT_BYTES = 1024 * 1024;
const BLACKBOX_PRODUCT = 'Blackbox flight data recorder by Nicholas Sherlock';
const ROTORFLIGHT_GYRO_SCALE = '0x3f800000';
const FIRMWARE_REVISION_PATTERN =
  /^Rotorflight (4\.[3-6]\.\d{1,3}) \(([0-9a-f]{7,40})\) (STM32F7X2)$/;
const CANONICAL_UNSIGNED_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;
const CANONICAL_SIGNED_INTEGER_PATTERN = /^(?:0|-?[1-9]\d*)$/;
const TEXT_ENCODER = new TextEncoder();
const BASE64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function domain(minimum, maximum, {step = 1, values = null} = {}) {
  return Object.freeze({
    minimum,
    maximum,
    step,
    values: values === null ? null : Object.freeze([...values])
  });
}

function repeated(value, count) {
  return Array.from({length: count}, () => value);
}

function field(key, domains) {
  const components = Array.isArray(domains) ? domains : [domains];
  return Object.freeze({
    key,
    arity: components.length,
    domains: Object.freeze([...components])
  });
}

const BOOL = domain(0, 1, {values: [0, 1]});
const U8 = domain(0, 255);
const U16 = domain(0, 65535);
const I16 = domain(-32768, 32767);
const UINT32 = domain(0, 4294967295);
// The unified STM32F7X2 target does not compile rangefinder, dashboard, OSD,
// or RX_SPI support; validateAndFixConfig() removes those bits before
// Blackbox writes `features`.
const ROTORFLIGHT_NAMED_FEATURE_MASK = 0x7c09e4c9;
const ROTORFLIGHT_RX_FEATURE_MASK = 0x00006009;
// `gyro.sampleLooptime` is integer microseconds derived from the concrete
// sample rates assigned by gyro_sync.c for the reviewed STM32F7X2 target build.
// Restricting the inverse lookup to target- and writer-era rates keeps cadence
// checks deterministic instead of borrowing paths compiled only for another
// MCU, an experimental build, or a sensor disabled by the target.
const GYRO_SAMPLE_RATES_BY_MINOR = Object.freeze({
  '4.3': Object.freeze([3200, 6664, 8000, 9000]),
  '4.4': Object.freeze([3200, 6664, 8000, 9000]),
  '4.5': Object.freeze([1000, 1125, 2000, 3200, 4000, 6664, 8000]),
  '4.6': Object.freeze([1000, 1125, 2000, 3200, 4000, 8000])
});
const MINIMUM_F7_PID_RATE_HZ = 800;
const MAXIMUM_F7_PID_RATE_HZ = 4000;
const RPM_LEGACY_SOURCE = domain(0, 28, {
  values: [0, 1, 2, 3, 4,
    10, 11, 12, 13, 14, 15, 16, 17, 18,
    20, 21, 22, 23, 24, 25, 26, 27, 28]
});
const RPM_CURRENT_SOURCE = domain(0, 28, {
  values: [0, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    20, 21, 22, 23, 24, 25, 26, 27, 28]
});
const RPM_LEGACY_Q_43 = domain(0, 100, {
  values: [0, ...Array.from({length: 96}, (_, index) => index + 5)]
});
const RPM_LEGACY_Q_44 = domain(0, 250, {
  values: [0, ...Array.from({length: 246}, (_, index) => index + 5)]
});
const RPM_CURRENT_Q = domain(0, 250, {
  values: [0, ...Array.from({length: 241}, (_, index) => index + 10)]
});

function baseContextFields({
  deadbandMaximum,
  motorProtocolMaximum,
  accHardwareMaximum,
  acc1GValues,
  serialProviderMaximum,
  collective
}) {
  const fields = [
    field('features', UINT32),
    field('I interval', domain(1, 512000)),
    field('P interval', domain(1, 8000)),
    field('P ratio', domain(1, 64)),
    field('looptime', domain(1, 4294967295)),
    field('gyro_sync_denom', domain(1, 1, {values: [1]})),
    field('pid_process_denom', domain(1, 16)),
    field('filter_process_denom', domain(1, 16)),
    field('response_time', repeated(domain(0, 250), 3)),
    field('accel_limit', repeated(domain(0, 50000), 3)),
    field('deadband', domain(0, deadbandMaximum)),
    field('yaw_deadband', domain(0, 100)),
    field('gyro_to_use', domain(0, 2, {values: [0, 1, 2]})),
    field('gyro_hardware_lpf', domain(0, 2, {values: [0, 1, 2]})),
    field('gyro_decimation_hz', domain(0, 1000, {
      values: [0, ...Array.from({length: 901}, (_, index) => index + 100)]
    })),
    field('gyro_lpf1_type', domain(0, 9)),
    field('gyro_lpf1_static_hz', domain(0, 1000)),
    field('gyro_lpf1_dyn_hz', repeated(domain(0, 1000), 2)),
    field('gyro_lpf2_type', domain(0, 9)),
    field('gyro_lpf2_static_hz', domain(0, 1000)),
    field('gyro_notch_hz', repeated(domain(0, 1000), 2)),
    field('gyro_notch_cutoff', repeated(domain(0, 1000), 2)),
    field('dyn_notch_count', domain(0, 8)),
    field('dyn_notch_q', domain(10, 100)),
    field('dyn_notch_min_hz', domain(10, 200)),
    field('dyn_notch_max_hz', domain(100, 500)),
    field('dshot_bidir', BOOL),
    field('acc_lpf_hz', domain(0, 40000, {step: 100})),
    field('acc_hardware', domain(0, accHardwareMaximum)),
    field('acc_1G', domain(
      Math.min(...acc1GValues),
      Math.max(...acc1GValues),
      {values: acc1GValues}
    )),
    field('gyro_cal_on_first_arm', BOOL),
    field('serialrx_provider', domain(0, serialProviderMaximum)),
    field('use_unsynced_pwm', BOOL),
    field('motor_pwm_protocol', domain(0, motorProtocolMaximum)),
    field('motor_pwm_rate', domain(50, 8000)),
    field('minthrottle', domain(50, 2500)),
    field('maxthrottle', domain(50, 2500))
  ];
  if (collective) {
    fields.push(field('collectiveRange', repeated(domain(-2500, 2500), 2)));
  }
  return fields;
}

const CONTROLLER_FIELDS_44_PLUS = Object.freeze([
  field('levelPID', [domain(0, 200), domain(10, 90), domain(0, 200), domain(0, 200)]),
  field('rollBW', repeated(domain(0, 250), 3)),
  field('pitchBW', repeated(domain(0, 250), 3)),
  field('yawBW', repeated(domain(0, 250), 3)),
  field('iterm_relax_type', domain(0, 2, {values: [0, 1, 2]})),
  field('iterm_relax_cutoff', repeated(U8, 3)),
  field('error_limit', repeated(U8, 3)),
  field('error_decay', repeated(domain(0, 250), 2)),
  field('error_decay_ground', domain(0, 250)),
  field('cyclic_coupling', [domain(0, 250), domain(0, 200), domain(1, 250)]),
  field('yaw_stop_gain', repeated(domain(25, 250), 2)),
  field('yaw_precomp', repeated(domain(0, 250), 3)),
  field('hsi_gain', repeated(domain(0, 1000), 2)),
  field('hsi_limit', repeated(U8, 2)),
  field('pitch_compensation', domain(0, 250))
]);

function legacyRpmFilterFields(notchQDomain) {
  return [
    field('gyro_rpm_filter_bank_rpm_source', repeated(RPM_LEGACY_SOURCE, 16)),
    field('gyro_rpm_filter_bank_rpm_ratio', repeated(domain(0, 50000), 16)),
    field('gyro_rpm_filter_bank_rpm_limit', repeated(U16, 16)),
    field('gyro_rpm_filter_bank_notch_q', repeated(notchQDomain, 16))
  ];
}

const CURRENT_RPM_FILTER_FIELDS = Object.freeze([
  field('gyro_rpm_notch_preset', domain(0, 3)),
  field('gyro_rpm_notch_min_hz', domain(1, 100)),
  field('gyro_rpm_notch_source_pitch', repeated(RPM_CURRENT_SOURCE, 16)),
  field('gyro_rpm_notch_center_pitch', repeated(I16, 16)),
  field('gyro_rpm_notch_q_pitch', repeated(RPM_CURRENT_Q, 16)),
  field('gyro_rpm_notch_source_roll', repeated(RPM_CURRENT_SOURCE, 16)),
  field('gyro_rpm_notch_center_roll', repeated(I16, 16)),
  field('gyro_rpm_notch_q_roll', repeated(RPM_CURRENT_Q, 16)),
  field('gyro_rpm_notch_source_yaw', repeated(RPM_CURRENT_SOURCE, 16)),
  field('gyro_rpm_notch_center_yaw', repeated(I16, 16)),
  field('gyro_rpm_notch_q_yaw', repeated(RPM_CURRENT_Q, 16))
]);

function release(version, commit) {
  return Object.freeze({version, commit});
}

const SOURCE_PATHS = Object.freeze([
  'src/main/blackbox/blackbox.c',
  'src/main/blackbox/blackbox_fielddefs.h',
  'src/main/flight/pid.h',
  'src/main/pg/pid.h',
  'src/main/pg/rpm_filter.h',
  'src/main/flight/rpm_filter.c',
  'src/main/config/config.c',
  'src/main/config/feature.h',
  'src/main/cli/settings.c',
  'src/main/fc/parameter_names.h',
  'src/main/rx/rx.h',
  'src/main/drivers/accgyro/accgyro.h',
  'src/main/drivers/accgyro/gyro_sync.c',
  'src/main/drivers/motor.c',
  'src/main/drivers/motor.h',
  'src/main/drivers/castle_telemetry_decode.h',
  'src/main/drivers/pwm_output.h',
  'src/main/drivers/accgyro/accgyro_mpu6050.c',
  'src/main/drivers/accgyro/accgyro_spi_bmi088.c',
  'src/main/drivers/accgyro/accgyro_spi_bmi160.c',
  'src/main/drivers/accgyro/accgyro_spi_bmi323.c',
  'src/main/drivers/accgyro_legacy/accgyro_adxl345.c',
  'src/main/target/STM32_UNIFIED/target.h',
  'src/main/target/common_pre.h',
  'src/main/target/common_post.h'
]);

function manifest({id, minor, sourceReleases, fields}) {
  const seen = new Set();
  for (const spec of fields) {
    if (seen.has(spec.key)) {
      throw new Error(`Duplicate community configuration manifest key: ${spec.key}`);
    }
    seen.add(spec.key);
  }
  return Object.freeze({
    id,
    minor,
    sourceRepository: 'https://github.com/rotorflight/rotorflight-firmware',
    sourcePaths: SOURCE_PATHS,
    sourceReleases: Object.freeze(sourceReleases),
    fields: Object.freeze(fields)
  });
}

const MANIFEST_43 = manifest({
  id: 'rotorflight-blackbox-context-4.3-r2',
  minor: '4.3',
  sourceReleases: [
    release('4.3.0', '05570fec69fd566e713f11e84adc7b77a8d68abf')
  ],
  fields: [
    ...baseContextFields({
      deadbandMaximum: 32,
      motorProtocolMaximum: 9,
      accHardwareMaximum: 20,
      acc1GValues: [256, 1024, 2048, 4096],
      serialProviderMaximum: 14,
      collective: false
    }),
    ...legacyRpmFilterFields(RPM_LEGACY_Q_43),
    field('fields_mask', domain(0, 524287))
  ]
});

const MANIFEST_44 = manifest({
  id: 'rotorflight-blackbox-context-4.4-r2',
  minor: '4.4',
  sourceReleases: [
    release('4.4.0', '5fc142adfdc4031877061433c5052e473b9cdfd2'),
    release('4.4.1', '456633bcea79933142c7fee17922ab306028bcf9')
  ],
  fields: [
    ...baseContextFields({
      deadbandMaximum: 32,
      motorProtocolMaximum: 9,
      accHardwareMaximum: 20,
      acc1GValues: [256, 1024, 2048, 4096],
      serialProviderMaximum: 14,
      collective: true
    }),
    ...CONTROLLER_FIELDS_44_PLUS,
    field('yaw_precomp_impulse', [domain(0, 255), domain(1, 250)]),
    field('piro_compensation', BOOL),
    ...legacyRpmFilterFields(RPM_LEGACY_Q_44),
    field('fields_mask', domain(0, 4194303))
  ]
});

const MANIFEST_45 = manifest({
  id: 'rotorflight-blackbox-context-4.5-r2',
  minor: '4.5',
  sourceReleases: [
    release('4.5.0', 'e77d192c43c4b36ef4d18b67d24859ddc0968755'),
    release('4.5.1', 'e69823a3c185cbf1b75fd2701e938e978591a36b')
  ],
  fields: [
    ...baseContextFields({
      deadbandMaximum: 32,
      motorProtocolMaximum: 10,
      accHardwareMaximum: 21,
      acc1GValues: [256, 1024, 2048, 2731, 4096],
      serialProviderMaximum: 18,
      collective: true
    }),
    ...CONTROLLER_FIELDS_44_PLUS,
    field('yaw_inertia_precomp', repeated(domain(0, 250), 2)),
    field('piro_compensation', BOOL),
    ...CURRENT_RPM_FILTER_FIELDS,
    field('fields_mask', domain(0, 4194303))
  ]
});

const MANIFEST_46 = manifest({
  id: 'rotorflight-blackbox-context-4.6-r2',
  minor: '4.6',
  sourceReleases: [
    release('4.6.0', '118e9120260bb33f46df4f92052fb0e9fd4e9ebc')
  ],
  fields: [
    ...baseContextFields({
      deadbandMaximum: 100,
      motorProtocolMaximum: 10,
      accHardwareMaximum: 22,
      acc1GValues: [256, 2048, 2731],
      serialProviderMaximum: 19,
      collective: true
    }),
    ...CONTROLLER_FIELDS_44_PLUS,
    field('yaw_inertia_precomp', repeated(domain(0, 250), 2)),
    ...CURRENT_RPM_FILTER_FIELDS,
    field('fields_mask', domain(0, 8388607))
  ]
});

export const COMMUNITY_BLACKBOX_CONFIG_MANIFESTS = Object.freeze({
  '4.3': MANIFEST_43,
  '4.4': MANIFEST_44,
  '4.5': MANIFEST_45,
  '4.6': MANIFEST_46
});

function addCode(codes, code) {
  if (!codes.includes(code)) codes.push(code);
}

function orderedCodes(codes) {
  return Object.freeze([...codes].sort(
    (left, right) => CODE_ORDER.get(left) - CODE_ORDER.get(right)
  ));
}

function emptyFingerprints() {
  return Object.freeze({
    schemaVersion: COMMUNITY_BLACKBOX_FILTER_FINGERPRINT_SCHEMA_VERSION,
    filter: null,
    governor: null
  });
}

function extractionReport({manifestId = null, fingerprint = null, codes = []} = {}) {
  return Object.freeze({
    schemaVersion: COMMUNITY_CONFIG_EXTRACTION_SCHEMA_VERSION,
    extractorVersion: COMMUNITY_BLACKBOX_CONFIG_EXTRACTOR_VERSION,
    firmwareManifest: manifestId,
    configFingerprints: fingerprint === null
      ? emptyFingerprints()
      : Object.freeze({
        schemaVersion: COMMUNITY_BLACKBOX_FILTER_FINGERPRINT_SCHEMA_VERSION,
        filter: fingerprint,
        governor: null
      }),
    coverage: Object.freeze({
      filter: fingerprint === null ? 'unavailable' : COMMUNITY_BLACKBOX_FILTER_COVERAGE,
      governor: COMMUNITY_BLACKBOX_GOVERNOR_COVERAGE
    }),
    contextAvailable: fingerprint !== null,
    filterComplete: false,
    governorComplete: false,
    complete: false,
    codes: orderedCodes(codes)
  });
}

function groupEntries(entries) {
  if (!Array.isArray(entries)) return {code: 'HEADER_ENTRIES_UNAVAILABLE'};
  if (!Object.isFrozen(entries)) return {code: 'HEADER_ENTRIES_MUTABLE'};
  const length = entries.length;
  if (!Number.isSafeInteger(length) || length <= 0) {
    return {code: 'HEADER_ENTRIES_UNAVAILABLE'};
  }
  if (length > MAXIMUM_HEADER_ENTRIES) {
    return {code: 'HEADER_EVIDENCE_LIMIT_EXCEEDED'};
  }
  const grouped = new Map();
  let textBytes = 0;
  for (let index = 0; index < length; index += 1) {
    const slot = Object.getOwnPropertyDescriptor(entries, String(index));
    if (slot === undefined || !Object.hasOwn(slot, 'value')) {
      return {code: 'HEADER_ENTRIES_UNAVAILABLE'};
    }
    const entry = slot.value;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return {code: 'HEADER_ENTRIES_UNAVAILABLE'};
    }
    if (!Object.isFrozen(entry)) return {code: 'HEADER_ENTRIES_MUTABLE'};
    const keySlot = Object.getOwnPropertyDescriptor(entry, 'key');
    const valueSlot = Object.getOwnPropertyDescriptor(entry, 'value');
    if (keySlot === undefined
        || valueSlot === undefined
        || !Object.hasOwn(keySlot, 'value')
        || !Object.hasOwn(valueSlot, 'value')) {
      return {code: 'HEADER_ENTRIES_UNAVAILABLE'};
    }
    const key = keySlot.value;
    const value = valueSlot.value;
    if (typeof key !== 'string' || typeof value !== 'string') {
      return {code: 'HEADER_ENTRIES_UNAVAILABLE'};
    }
    if (key.length === 0
        || key.length > MAXIMUM_HEADER_KEY_CODE_UNITS
        || value.length > MAXIMUM_HEADER_VALUE_CODE_UNITS) {
      return {code: 'HEADER_EVIDENCE_LIMIT_EXCEEDED'};
    }
    textBytes += TEXT_ENCODER.encode(key).byteLength;
    textBytes += TEXT_ENCODER.encode(value).byteLength;
    if (textBytes > MAXIMUM_HEADER_TEXT_BYTES) {
      return {code: 'HEADER_EVIDENCE_LIMIT_EXCEEDED'};
    }
    const existing = grouped.get(key);
    if (existing === undefined) grouped.set(key, {count: 1, value});
    else existing.count += 1;
  }
  return {grouped};
}

function singleton(grouped, key) {
  const entry = grouped.get(key);
  return entry?.count === 1 ? entry.value : null;
}

function reviewedFirmware(grouped) {
  const product = singleton(grouped, 'Product');
  const dataVersion = singleton(grouped, 'Data version');
  const firmwareType = singleton(grouped, 'Firmware type');
  const revision = singleton(grouped, 'Firmware revision');
  const gyroScale = singleton(grouped, 'gyro_scale');
  if (product !== BLACKBOX_PRODUCT
      || dataVersion !== '2'
      || firmwareType !== 'Rotorflight'
      || revision === null
      || gyroScale !== ROTORFLIGHT_GYRO_SCALE) {
    return {code: 'FIRMWARE_HEADER_INVALID'};
  }
  const match = FIRMWARE_REVISION_PATTERN.exec(revision);
  if (match === null) return {code: 'FIRMWARE_RELEASE_NOT_REVIEWED'};
  const [, version, reportedCommit] = match;
  const selected = COMMUNITY_BLACKBOX_CONFIG_MANIFESTS[version.slice(0, 3)];
  const reviewed = selected?.sourceReleases.some(source =>
    source.version === version && source.commit.startsWith(reportedCommit));
  return reviewed ? {manifest: selected} : {code: 'FIRMWARE_RELEASE_NOT_REVIEWED'};
}

function componentValid(value, specification) {
  if (value < specification.minimum || value > specification.maximum) return false;
  if ((value - specification.minimum) % specification.step !== 0) return false;
  return specification.values === null || specification.values.includes(value);
}

function parseSetting(raw, specification) {
  const parts = raw.split(',');
  if (parts.length !== specification.arity) return null;
  const values = [];
  for (let index = 0; index < parts.length; index += 1) {
    const component = specification.domains[index];
    const pattern = component.minimum < 0
      ? CANONICAL_SIGNED_INTEGER_PATTERN
      : CANONICAL_UNSIGNED_INTEGER_PATTERN;
    if (!pattern.test(parts[index])) return null;
    const value = Number(parts[index]);
    if (!Number.isSafeInteger(value) || !componentValid(value, component)) return null;
    values.push(value);
  }
  return values.length === 1 ? values[0] : Object.freeze(values);
}

function sampleRateForLooptime(minor, looptime) {
  const rates = GYRO_SAMPLE_RATES_BY_MINOR[minor];
  if (rates === undefined) return null;
  const matches = rates.filter(rate => Math.trunc(1000000 / rate) === looptime);
  return matches.length === 1 ? matches[0] : null;
}

function roundTiesToEven(value) {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (fraction < 0.5) return lower;
  if (fraction > 0.5) return lower + 1;
  return lower % 2 === 0 ? lower : lower + 1;
}

// Match the reviewed C expressions: each arithmetic operation is binary32,
// then lrintf applies the default round-to-nearest, ties-to-even mode.
function lrintfProductQuotient(factor, numerator, denominator = 1) {
  const product = Math.fround(Math.fround(factor) * Math.fround(numerator));
  const quotient = Math.fround(product / Math.fround(denominator));
  return roundTiesToEven(quotient);
}

function gyroFilterCadenceValid(settings, minor, sampleRate) {
  const decimation = settings.get('gyro_decimation_hz');
  if (minor === '4.6') {
    const maximum = lrintfProductQuotient(0.3, sampleRate);
    if (decimation !== 0 && (decimation < 100 || decimation > maximum)) return false;
  } else {
    const maximum = lrintfProductQuotient(
      0.5,
      sampleRate,
      settings.get('pid_process_denom')
    );
    if (decimation > maximum) return false;
  }

  const cutoffLimit = lrintfProductQuotient(
    0.45,
    sampleRate,
    settings.get('filter_process_denom')
  );
  if (settings.get('gyro_lpf1_static_hz') > cutoffLimit
      || settings.get('gyro_lpf2_static_hz') > cutoffLimit) {
    return false;
  }
  for (const key of ['gyro_notch_hz', 'gyro_notch_cutoff']) {
    if (settings.get(key).some(value => value > cutoffLimit)) return false;
  }
  return true;
}

function motorCadenceValid(settings, minor, sampleRate, pidRate) {
  const protocol = settings.get('motor_pwm_protocol');
  const unsynced = settings.get('use_unsynced_pwm');
  const bidirectionalDshot = settings.get('dshot_bidir');
  const pwmRate = settings.get('motor_pwm_rate');
  const isDshot = protocol >= 5 && protocol <= 8;
  const isCastleLink = (minor === '4.5' || minor === '4.6') && protocol === 9;

  // validateAndFixConfig() forces STANDARD and CASTLE_LINK unsynchronised,
  // and forces every DSHOT variant synchronised before the header is written.
  if ((protocol === 0 || isCastleLink) && unsynced !== 1) return false;
  if (isDshot && unsynced !== 0) return false;
  if (bidirectionalDshot === 1 && !isDshot) return false;

  let updateRestriction = null;
  switch (protocol) {
  case 0: updateRestriction = 480; break;
  case 1: updateRestriction = 2000; break;
  case 2: updateRestriction = 10000; break;
  case 3: updateRestriction = 32000; break;
  case 5: updateRestriction = 4000; break;
  case 6: updateRestriction = 10000; break;
  case 7:
  case 8: updateRestriction = 32000; break;
  default:
    if (isCastleLink) updateRestriction = 100;
  }

  if (updateRestriction === null) return true;
  if (unsynced === 1) {
    // Unsynchronised analogue output is clamped to the protocol ceiling.
    return pwmRate <= updateRestriction;
  }
  if (bidirectionalDshot === 1) updateRestriction = Math.trunc(updateRestriction / 2);
  return pidRate <= updateRestriction;
}

function crossFieldValid(settings, manifestDefinition) {
  const orderedPair = key => {
    const value = settings.get(key);
    return !Array.isArray(value) || value[0] <= value[1];
  };
  if (!orderedPair('collectiveRange')) return false;
  if (settings.get('I interval')
      !== settings.get('P interval') * settings.get('P ratio')) {
    return false;
  }
  if (settings.get('filter_process_denom') > settings.get('pid_process_denom')
      || settings.get('pid_process_denom') % settings.get('filter_process_denom') !== 0) {
    return false;
  }
  const sampleRate = sampleRateForLooptime(
    manifestDefinition.minor,
    settings.get('looptime')
  );
  if (sampleRate === null) return false;
  const pidRate = Math.trunc(sampleRate / settings.get('pid_process_denom'));
  if (pidRate < MINIMUM_F7_PID_RATE_HZ || pidRate > MAXIMUM_F7_PID_RATE_HZ) {
    return false;
  }
  const pInterval = settings.get('P interval');
  const multiplier = Math.trunc((32 * pidRate) / (1000 * pInterval));
  const expectedRatio = multiplier > 64 ? 64 : Math.max(multiplier, 1);
  if (settings.get('P ratio') !== expectedRatio
      || settings.get('I interval') !== pInterval * expectedRatio) {
    return false;
  }
  if (!motorCadenceValid(settings, manifestDefinition.minor, sampleRate, pidRate)) {
    return false;
  }
  if (!gyroFilterCadenceValid(settings, manifestDefinition.minor, sampleRate)) {
    return false;
  }
  if ((settings.get('features') & (~ROTORFLIGHT_NAMED_FEATURE_MASK >>> 0)) !== 0) {
    return false;
  }
  const receiverFeatures = (settings.get('features') & ROTORFLIGHT_RX_FEATURE_MASK) >>> 0;
  if (receiverFeatures !== 0
      && (receiverFeatures & (receiverFeatures - 1)) !== 0) {
    return false;
  }
  if (settings.has('collectiveRange')) {
    const range = settings.get('collectiveRange');
    if (range[0] === range[1]) return false;
  }
  if (settings.get('dyn_notch_min_hz') > settings.get('dyn_notch_max_hz')) return false;
  if (settings.get('minthrottle') >= settings.get('maxthrottle')) return false;
  const dynamicLpf = settings.get('gyro_lpf1_dyn_hz');
  const staticLpf = settings.get('gyro_lpf1_static_hz');
  if ((staticLpf === 0 && settings.get('gyro_lpf1_type') !== 0)
      || (settings.get('gyro_lpf2_static_hz') === 0
        && settings.get('gyro_lpf2_type') !== 0)) {
    return false;
  }
  if (!(dynamicLpf[0] === 0 && dynamicLpf[1] === 0)
      && (dynamicLpf[0] > staticLpf || staticLpf > dynamicLpf[1])) {
    return false;
  }
  const notchHz = settings.get('gyro_notch_hz');
  const notchCutoff = settings.get('gyro_notch_cutoff');
  for (let index = 0; index < 2; index += 1) {
    if (notchHz[index] !== 0 && notchCutoff[index] >= notchHz[index]) return false;
  }
  if ((settings.get('features') & 0x40000000) !== 0
      && settings.has('gyro_rpm_filter_bank_rpm_source')) {
    const sources = settings.get('gyro_rpm_filter_bank_rpm_source');
    const ratios = settings.get('gyro_rpm_filter_bank_rpm_ratio');
    const limits = settings.get('gyro_rpm_filter_bank_rpm_limit');
    const qs = settings.get('gyro_rpm_filter_bank_notch_q');
    for (let index = 0; index < sources.length; index += 1) {
      if ((sources[index] === 0 || ratios[index] === 0 || qs[index] === 0)
          && (sources[index] !== 0
            || ratios[index] !== 0
            || limits[index] !== 0
            || qs[index] !== 0)) {
        return false;
      }
    }
  }
  if (settings.has('gyro_rpm_notch_preset')) {
    // Rotorflight rewrites preset 1..3 to built-in tables before writing the
    // header. Until those release-specific tables are embedded and pinned,
    // accept only the custom preset and its post-validation canonical form.
    if (settings.get('gyro_rpm_notch_preset') !== 0) return false;
    for (const axis of ['pitch', 'roll', 'yaw']) {
      const sources = settings.get(`gyro_rpm_notch_source_${axis}`);
      const centers = settings.get(`gyro_rpm_notch_center_${axis}`);
      const qs = settings.get(`gyro_rpm_notch_q_${axis}`);
      for (let index = 0; index < sources.length; index += 1) {
        if ((sources[index] === 0 || qs[index] === 0)
            && (sources[index] !== 0 || centers[index] !== 0 || qs[index] !== 0)) {
          return false;
        }
      }
    }
  }
  return true;
}

function hexToBase64url(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
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
    if (remaining > 2) encoded += BASE64URL_ALPHABET[third & 0x3f];
  }
  return encoded;
}

function tuningContextFingerprint(manifestDefinition, settings) {
  const canonical = JSON.stringify({
    schemaVersion: COMMUNITY_BLACKBOX_FILTER_FINGERPRINT_SCHEMA_VERSION,
    kind: COMMUNITY_BLACKBOX_FILTER_FINGERPRINT_KIND,
    coverage: COMMUNITY_BLACKBOX_FILTER_COVERAGE,
    manifest: manifestDefinition.id,
    requiredKeys: manifestDefinition.fields.map(specification => specification.key),
    settings
  });
  const digest = `sha256:${hexToBase64url(sha256Hex(TEXT_ENCODER.encode(canonical)))}`;
  return Object.freeze({
    schemaVersion: COMMUNITY_BLACKBOX_FILTER_FINGERPRINT_SCHEMA_VERSION,
    kind: COMMUNITY_BLACKBOX_FILTER_FINGERPRINT_KIND,
    algorithm: 'sha256',
    digest
  });
}

/** Extract from `parseSession(..., {retainHeaderEntries: true})` output. */
export function extractCommunityConfiguration(sessionDefinition) {
  if (sessionDefinition === null
      || typeof sessionDefinition !== 'object'
      || Array.isArray(sessionDefinition)) {
    return extractionReport({codes: ['SESSION_DEFINITION_INVALID']});
  }
  let terminationSlot;
  let entriesSlot;
  let groupedResult;
  try {
    terminationSlot =
      Object.getOwnPropertyDescriptor(sessionDefinition, 'headerTerminationClean');
  } catch {
    return extractionReport({codes: ['SESSION_DEFINITION_INVALID']});
  }
  if (terminationSlot === undefined
      || !Object.hasOwn(terminationSlot, 'value')
      || terminationSlot.writable !== false
      || terminationSlot.configurable !== false) {
    return extractionReport({codes: ['SESSION_DEFINITION_INVALID']});
  }
  if (terminationSlot.value !== true) {
    return extractionReport({codes: ['HEADER_TERMINATION_UNCLEAN']});
  }
  try {
    entriesSlot = Object.getOwnPropertyDescriptor(sessionDefinition, 'headerEntries');
  } catch {
    return extractionReport({codes: ['HEADER_ENTRIES_UNAVAILABLE']});
  }
  if (entriesSlot === undefined || !Object.hasOwn(entriesSlot, 'value')) {
    return extractionReport({codes: ['HEADER_ENTRIES_UNAVAILABLE']});
  }
  if (entriesSlot.writable !== false || entriesSlot.configurable !== false) {
    return extractionReport({codes: ['HEADER_ENTRIES_MUTABLE']});
  }
  try {
    groupedResult = groupEntries(entriesSlot.value);
  } catch {
    return extractionReport({codes: ['HEADER_ENTRIES_UNAVAILABLE']});
  }
  if (groupedResult.grouped === undefined) {
    return extractionReport({codes: [groupedResult.code]});
  }
  const firmware = reviewedFirmware(groupedResult.grouped);
  if (firmware.manifest === undefined) {
    return extractionReport({codes: [firmware.code]});
  }

  const codes = [
    'BLACKBOX_CONFIGURATION_PARTIAL',
    'GOVERNOR_CONFIGURATION_NOT_LOGGED'
  ];
  const settings = [];
  const settingsByKey = new Map();
  for (const specification of firmware.manifest.fields) {
    const entry = groupedResult.grouped.get(specification.key);
    if (entry === undefined) {
      addCode(codes, 'FILTER_SETTING_MISSING');
      continue;
    }
    if (entry.count !== 1) {
      addCode(codes, 'FILTER_SETTING_DUPLICATE');
      continue;
    }
    const parsed = parseSetting(entry.value, specification);
    if (parsed === null) {
      addCode(codes, 'FILTER_SETTING_INVALID');
      continue;
    }
    settingsByKey.set(specification.key, parsed);
    settings.push(Object.freeze([specification.key, parsed]));
  }
  if (!codes.some(code => code.startsWith('FILTER_SETTING_'))
      && !crossFieldValid(settingsByKey, firmware.manifest)) {
    addCode(codes, 'FILTER_SETTING_INVALID');
  }
  const invalid = codes.some(code => code.startsWith('FILTER_SETTING_'));
  return extractionReport({
    manifestId: firmware.manifest.id,
    fingerprint: invalid ? null : tuningContextFingerprint(firmware.manifest, settings),
    codes
  });
}
