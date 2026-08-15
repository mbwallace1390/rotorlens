import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMUNITY_BLACKBOX_CONFIG_EXTRACTOR_VERSION,
  COMMUNITY_BLACKBOX_CONFIG_MANIFESTS,
  COMMUNITY_BLACKBOX_FILTER_COVERAGE,
  COMMUNITY_BLACKBOX_FILTER_FINGERPRINT_KIND,
  COMMUNITY_BLACKBOX_FILTER_FINGERPRINT_SCHEMA_VERSION,
  COMMUNITY_CONFIG_EXTRACTION_CODES,
  extractCommunityConfiguration
} from '../src/analysis/community-config-extractor.mjs';
import {
  isSha256Fingerprint,
  normalizeConfigFingerprints
} from '../src/analysis/community-contract.mjs';
import {parseSession} from '../src/blackbox/headers.mjs';

const RELEASES = Object.freeze({
  '4.3': 'Rotorflight 4.3.0 (05570fe) STM32F7X2',
  '4.4': 'Rotorflight 4.4.1 (456633b) STM32F7X2',
  '4.5': 'Rotorflight 4.5.1 (e69823a) STM32F7X2',
  '4.6': 'Rotorflight 4.6.0 (118e912) STM32F7X2'
});

// This list is intentionally independent of the implementation manifests. A
// newly emitted load-bearing field must be classified here before tests pass.
const BASE_KEYS = Object.freeze([
  'features',
  'I interval',
  'P interval',
  'P ratio',
  'looptime',
  'gyro_sync_denom',
  'pid_process_denom',
  'filter_process_denom',
  'response_time',
  'accel_limit',
  'deadband',
  'yaw_deadband',
  'gyro_to_use',
  'gyro_hardware_lpf',
  'gyro_decimation_hz',
  'gyro_lpf1_type',
  'gyro_lpf1_static_hz',
  'gyro_lpf1_dyn_hz',
  'gyro_lpf2_type',
  'gyro_lpf2_static_hz',
  'gyro_notch_hz',
  'gyro_notch_cutoff',
  'dyn_notch_count',
  'dyn_notch_q',
  'dyn_notch_min_hz',
  'dyn_notch_max_hz',
  'dshot_bidir',
  'acc_lpf_hz',
  'acc_hardware',
  'acc_1G',
  'gyro_cal_on_first_arm',
  'serialrx_provider',
  'use_unsynced_pwm',
  'motor_pwm_protocol',
  'motor_pwm_rate',
  'minthrottle',
  'maxthrottle'
]);

const CONTROLLER_KEYS = Object.freeze([
  'collectiveRange',
  'levelPID',
  'rollBW',
  'pitchBW',
  'yawBW',
  'iterm_relax_type',
  'iterm_relax_cutoff',
  'error_limit',
  'error_decay',
  'error_decay_ground',
  'cyclic_coupling',
  'yaw_stop_gain',
  'yaw_precomp',
  'hsi_gain',
  'hsi_limit',
  'pitch_compensation'
]);

const LEGACY_RPM_KEYS = Object.freeze([
  'gyro_rpm_filter_bank_rpm_source',
  'gyro_rpm_filter_bank_rpm_ratio',
  'gyro_rpm_filter_bank_rpm_limit',
  'gyro_rpm_filter_bank_notch_q'
]);

const CURRENT_RPM_KEYS = Object.freeze([
  'gyro_rpm_notch_preset',
  'gyro_rpm_notch_min_hz',
  'gyro_rpm_notch_source_pitch',
  'gyro_rpm_notch_center_pitch',
  'gyro_rpm_notch_q_pitch',
  'gyro_rpm_notch_source_roll',
  'gyro_rpm_notch_center_roll',
  'gyro_rpm_notch_q_roll',
  'gyro_rpm_notch_source_yaw',
  'gyro_rpm_notch_center_yaw',
  'gyro_rpm_notch_q_yaw'
]);

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

const ZERO_3 = '0,0,0';
const ZERO_16 = Array(16).fill('0').join(',');
const GOLDEN_COMMON_VALUES = Object.freeze({
  features: '0',
  'I interval': '64',
  'P interval': '2',
  'P ratio': '32',
  looptime: '125',
  gyro_sync_denom: '1',
  pid_process_denom: '4',
  filter_process_denom: '1',
  response_time: ZERO_3,
  accel_limit: ZERO_3,
  deadband: '0',
  yaw_deadband: '0',
  gyro_to_use: '0',
  gyro_hardware_lpf: '0',
  gyro_decimation_hz: '0',
  gyro_lpf1_type: '0',
  gyro_lpf1_static_hz: '0',
  gyro_lpf1_dyn_hz: '0,0',
  gyro_lpf2_type: '0',
  gyro_lpf2_static_hz: '0',
  gyro_notch_hz: '0,0',
  gyro_notch_cutoff: '0,0',
  dyn_notch_count: '0',
  dyn_notch_q: '10',
  dyn_notch_min_hz: '10',
  dyn_notch_max_hz: '100',
  dshot_bidir: '0',
  acc_lpf_hz: '0',
  acc_hardware: '0',
  acc_1G: '256',
  gyro_cal_on_first_arm: '0',
  serialrx_provider: '0',
  use_unsynced_pwm: '0',
  motor_pwm_protocol: '7',
  motor_pwm_rate: '50',
  minthrottle: '500',
  maxthrottle: '1000',
  fields_mask: '0'
});
const GOLDEN_CONTROLLER_VALUES = Object.freeze({
  collectiveRange: '-1000,1000',
  levelPID: '0,10,0,0',
  rollBW: ZERO_3,
  pitchBW: ZERO_3,
  yawBW: ZERO_3,
  iterm_relax_type: '0',
  iterm_relax_cutoff: ZERO_3,
  error_limit: ZERO_3,
  error_decay: '0,0',
  error_decay_ground: '0',
  cyclic_coupling: '0,0,1',
  yaw_stop_gain: '25,25',
  yaw_precomp: ZERO_3,
  hsi_gain: '0,0',
  hsi_limit: '0,0',
  pitch_compensation: '0'
});
const GOLDEN_LEGACY_RPM_VALUES = Object.freeze({
  gyro_rpm_filter_bank_rpm_source: ZERO_16,
  gyro_rpm_filter_bank_rpm_ratio: ZERO_16,
  gyro_rpm_filter_bank_rpm_limit: ZERO_16,
  gyro_rpm_filter_bank_notch_q: ZERO_16
});
const GOLDEN_CURRENT_RPM_VALUES = Object.freeze({
  gyro_rpm_notch_preset: '0',
  gyro_rpm_notch_min_hz: '1',
  gyro_rpm_notch_source_pitch: ZERO_16,
  gyro_rpm_notch_center_pitch: ZERO_16,
  gyro_rpm_notch_q_pitch: ZERO_16,
  gyro_rpm_notch_source_roll: ZERO_16,
  gyro_rpm_notch_center_roll: ZERO_16,
  gyro_rpm_notch_q_roll: ZERO_16,
  gyro_rpm_notch_source_yaw: ZERO_16,
  gyro_rpm_notch_center_yaw: ZERO_16,
  gyro_rpm_notch_q_yaw: ZERO_16
});

function manifestForRevision(revision) {
  const minor = /^Rotorflight (4\.[3-6])\./.exec(revision)?.[1];
  return COMMUNITY_BLACKBOX_CONFIG_MANIFESTS[minor];
}

function valueFor(specification) {
  const values = specification.domains.map(component =>
    component.values?.[0] ?? component.minimum);
  if (specification.key === 'collectiveRange') return '-1000,1000';
  if (specification.key === 'minthrottle') return '500';
  if (specification.key === 'maxthrottle') return '1000';
  if (specification.key === 'I interval') return '64';
  if (specification.key === 'P interval') return '2';
  if (specification.key === 'P ratio') return '32';
  if (specification.key === 'looptime') return '125';
  if (specification.key === 'pid_process_denom') return '4';
  if (specification.key === 'filter_process_denom') return '1';
  if (specification.key === 'motor_pwm_protocol') return '7';
  if (specification.key.startsWith('gyro_rpm_notch_center_')) {
    return Array(specification.arity).fill('0').join(',');
  }
  return values.join(',');
}

function entriesFor(revision = RELEASES['4.6']) {
  const manifest = manifestForRevision(revision);
  return [
    {key: 'Product', value: 'Blackbox flight data recorder by Nicholas Sherlock'},
    {key: 'Data version', value: '2'},
    {key: 'Firmware type', value: 'Rotorflight'},
    {key: 'Firmware revision', value: revision},
    {key: 'gyro_scale', value: '0x3f800000'},
    {key: 'Craft name', value: 'PRIVATE-CRAFT-NAME'},
    {key: 'Log start datetime', value: '2026-08-14T12:34:56.000'},
    {key: 'Unrelated private path', value: 'C:\\private\\flight.bbl'},
    ...manifest.fields.map(specification => ({
      key: specification.key,
      value: valueFor(specification)
    }))
  ];
}

function goldenEntriesFor(revision) {
  const minor = /^Rotorflight (4\.[3-6])\./.exec(revision)?.[1];
  const manifest = manifestForRevision(revision);
  const values = {
    ...GOLDEN_COMMON_VALUES,
    ...(minor === '4.3' ? {} : GOLDEN_CONTROLLER_VALUES),
    ...(minor === '4.3' || minor === '4.4'
      ? GOLDEN_LEGACY_RPM_VALUES
      : GOLDEN_CURRENT_RPM_VALUES)
  };
  if (minor === '4.4') {
    values.yaw_precomp_impulse = '0,1';
    values.piro_compensation = '0';
  } else if (minor === '4.5') {
    values.yaw_inertia_precomp = '0,0';
    values.piro_compensation = '0';
  } else if (minor === '4.6') {
    values.yaw_inertia_precomp = '0,0';
  }
  return [
    {key: 'Product', value: 'Blackbox flight data recorder by Nicholas Sherlock'},
    {key: 'Data version', value: '2'},
    {key: 'Firmware type', value: 'Rotorflight'},
    {key: 'Firmware revision', value: revision},
    {key: 'gyro_scale', value: '0x3f800000'},
    ...manifest.fields.map(field => {
      assert.equal(typeof values[field.key], 'string',
        `golden value missing for ${field.key}`);
      return {key: field.key, value: values[field.key]};
    })
  ];
}

function evidenceSession(entries, session = {}) {
  const definition = {...session};
  const headerTerminationClean = Object.hasOwn(definition, 'headerTerminationClean')
    ? definition.headerTerminationClean
    : true;
  delete definition.headerTerminationClean;
  delete definition.headerEntries;
  const descriptors = {
    headerTerminationClean: {
      value: headerTerminationClean,
      enumerable: true,
      writable: false,
      configurable: false
    }
  };
  if (entries !== undefined) {
    descriptors.headerEntries = {
      value: entries,
      enumerable: true,
      writable: false,
      configurable: false
    };
  }
  return Object.defineProperties(definition, descriptors);
}

function extract(entries, session = {}) {
  for (let index = 0; index < entries.length; index += 1) {
    Object.freeze(entries[index]);
  }
  Object.freeze(entries);
  return extractCommunityConfiguration(evidenceSession(entries, session));
}

function replaceValue(entries, key, value) {
  return entries.map(entry => entry.key === key ? {...entry, value} : entry);
}

function removeKey(entries, key) {
  return entries.filter(entry => entry.key !== key);
}

function headerBytes(entries, tail = '') {
  const structural = [
    {key: 'Field I name', value: 'time'},
    {key: 'Field I signed', value: '0'},
    {key: 'Field I predictor', value: '0'},
    {key: 'Field I encoding', value: '1'},
    {key: 'Field P predictor', value: '1'},
    {key: 'Field P encoding', value: '0'}
  ];
  const preamble = entries.filter(entry => entry.key === 'Product'
    || entry.key === 'Data version');
  const remainder = entries.filter(entry => entry.key !== 'Product'
    && entry.key !== 'Data version');
  const text = [...preamble, ...structural, ...remainder]
    .map(entry => `H ${entry.key}:${entry.value}`)
    .join('\n') + '\n' + tail;
  return new TextEncoder().encode(text);
}

function spec(manifest, key) {
  return manifest.fields.find(candidate => candidate.key === key);
}

test('reviewed manifests pin official releases, sources, and exact era key sets', () => {
  const m43 = COMMUNITY_BLACKBOX_CONFIG_MANIFESTS['4.3'];
  const m44 = COMMUNITY_BLACKBOX_CONFIG_MANIFESTS['4.4'];
  const m45 = COMMUNITY_BLACKBOX_CONFIG_MANIFESTS['4.5'];
  const m46 = COMMUNITY_BLACKBOX_CONFIG_MANIFESTS['4.6'];
  const keys = manifest => manifest.fields.map(field => field.key);

  assert.deepEqual(m43.sourceReleases, [
    {version: '4.3.0', commit: '05570fec69fd566e713f11e84adc7b77a8d68abf'}
  ]);
  assert.deepEqual(m44.sourceReleases, [
    {version: '4.4.0', commit: '5fc142adfdc4031877061433c5052e473b9cdfd2'},
    {version: '4.4.1', commit: '456633bcea79933142c7fee17922ab306028bcf9'}
  ]);
  assert.deepEqual(m45.sourceReleases, [
    {version: '4.5.0', commit: 'e77d192c43c4b36ef4d18b67d24859ddc0968755'},
    {version: '4.5.1', commit: 'e69823a3c185cbf1b75fd2701e938e978591a36b'}
  ]);
  assert.deepEqual(m46.sourceReleases, [
    {version: '4.6.0', commit: '118e9120260bb33f46df4f92052fb0e9fd4e9ebc'}
  ]);

  assert.deepEqual(keys(m43), [...BASE_KEYS, ...LEGACY_RPM_KEYS, 'fields_mask']);
  assert.deepEqual(keys(m44), [
    ...BASE_KEYS,
    ...CONTROLLER_KEYS,
    'yaw_precomp_impulse',
    'piro_compensation',
    ...LEGACY_RPM_KEYS,
    'fields_mask'
  ]);
  assert.deepEqual(keys(m45), [
    ...BASE_KEYS,
    ...CONTROLLER_KEYS,
    'yaw_inertia_precomp',
    'piro_compensation',
    ...CURRENT_RPM_KEYS,
    'fields_mask'
  ]);
  assert.deepEqual(keys(m46), [
    ...BASE_KEYS,
    ...CONTROLLER_KEYS,
    'yaw_inertia_precomp',
    ...CURRENT_RPM_KEYS,
    'fields_mask'
  ]);

  for (const manifest of [m43, m44, m45, m46]) {
    assert.equal(manifest.sourceRepository,
      'https://github.com/rotorflight/rotorflight-firmware');
    assert.deepEqual(manifest.sourcePaths, SOURCE_PATHS);
    assert.equal(Object.isFrozen(manifest), true);
    assert.equal(Object.isFrozen(manifest.fields), true);
    assert.equal(new Set(keys(manifest)).size, manifest.fields.length);
  }
});

test('manifest domains encode reviewed wire signedness and release-specific limits', () => {
  const m44 = COMMUNITY_BLACKBOX_CONFIG_MANIFESTS['4.4'];
  const m45 = COMMUNITY_BLACKBOX_CONFIG_MANIFESTS['4.5'];
  const m46 = COMMUNITY_BLACKBOX_CONFIG_MANIFESTS['4.6'];

  assert.equal(spec(m44, 'cyclic_coupling').domains[0].minimum, 0);
  assert.equal(spec(m44, 'yaw_stop_gain').domains[0].minimum, 25);
  assert.deepEqual(
    spec(m44, 'yaw_precomp_impulse').domains.map(item => [item.minimum, item.maximum]),
    [[0, 255], [1, 250]]
  );
  assert.equal(spec(m45, 'yaw_inertia_precomp').domains[0].minimum, 0);
  assert.equal(spec(m45, 'gyro_rpm_notch_center_roll').domains[0].minimum, -32768);
  assert.equal(spec(m44, 'deadband').domains[0].maximum, 32);
  assert.equal(spec(m46, 'deadband').domains[0].maximum, 100);
  assert.equal(spec(m44, 'motor_pwm_protocol').domains[0].maximum, 9);
  assert.equal(spec(m45, 'motor_pwm_protocol').domains[0].maximum, 10);
  assert.equal(spec(m46, 'features').domains[0].maximum, 4294967295);
  assert.equal(spec(m46, 'gyro_hardware_lpf').domains[0].maximum, 2);
  assert.equal(spec(m46, 'P interval').domains[0].maximum, 8000);
  assert.equal(spec(m46, 'P ratio').domains[0].maximum, 64);
  assert.equal(spec(m46, 'acc_lpf_hz').domains[0].step, 100);
  assert.deepEqual(spec(m44, 'acc_1G').domains[0].values,
    [256, 1024, 2048, 4096]);
  assert.deepEqual(spec(m45, 'acc_1G').domains[0].values,
    [256, 1024, 2048, 2731, 4096]);
  assert.deepEqual(spec(m46, 'acc_1G').domains[0].values,
    [256, 2048, 2731]);
  assert.equal(spec(m44, 'acc_hardware').domains[0].maximum, 20);
  assert.equal(spec(m45, 'acc_hardware').domains[0].maximum, 21);
  assert.equal(spec(m46, 'acc_hardware').domains[0].maximum, 22);
  assert.equal(spec(m44, 'serialrx_provider').domains[0].maximum, 14);
  assert.equal(spec(m45, 'serialrx_provider').domains[0].maximum, 18);
  assert.equal(spec(m46, 'serialrx_provider').domains[0].maximum, 19);
  assert.equal(spec(m44, 'fields_mask').domains[0].maximum, 4194303);
  assert.equal(spec(m46, 'fields_mask').domains[0].maximum, 8388607);
});

test('independent golden legacy and current header states extract successfully', () => {
  for (const revision of [RELEASES['4.4'], RELEASES['4.5']]) {
    const report = extract(goldenEntriesFor(revision));
    assert.equal(report.contextAvailable, true, revision);
    assert.equal(isSha256Fingerprint(report.configFingerprints.filter.digest), true);
    assert.deepEqual(report.codes, [
      'BLACKBOX_CONFIGURATION_PARTIAL',
      'GOVERNOR_CONFIGURATION_NOT_LOGGED'
    ]);
  }
});

test('every reviewed release yields only a partial, versioned, governor-closed digest', () => {
  const reports = Object.values(RELEASES).map(revision => extract(entriesFor(revision)));
  for (const report of reports) {
    assert.equal(report.extractorVersion, COMMUNITY_BLACKBOX_CONFIG_EXTRACTOR_VERSION);
    assert.equal(report.contextAvailable, true);
    assert.equal(report.filterComplete, false);
    assert.equal(report.governorComplete, false);
    assert.equal(report.complete, false);
    assert.equal(report.coverage.filter, COMMUNITY_BLACKBOX_FILTER_COVERAGE);
    assert.equal(report.coverage.governor, 'insufficient');
    assert.equal(report.configFingerprints.schemaVersion,
      COMMUNITY_BLACKBOX_FILTER_FINGERPRINT_SCHEMA_VERSION);
    assert.equal(report.configFingerprints.filter.schemaVersion,
      COMMUNITY_BLACKBOX_FILTER_FINGERPRINT_SCHEMA_VERSION);
    assert.equal(report.configFingerprints.filter.kind,
      COMMUNITY_BLACKBOX_FILTER_FINGERPRINT_KIND);
    assert.equal(report.configFingerprints.filter.algorithm, 'sha256');
    assert.equal(isSha256Fingerprint(report.configFingerprints.filter.digest), true);
    assert.equal(report.configFingerprints.governor, null);
    assert.deepEqual(report.codes, [
      'BLACKBOX_CONFIGURATION_PARTIAL',
      'GOVERNOR_CONFIGURATION_NOT_LOGGED'
    ]);
  }
  assert.equal(new Set(reports.map(report =>
    report.configFingerprints.filter.digest)).size, 4);
});

test('header order cannot change a digest, while one required setting does', () => {
  const original = entriesFor();
  const first = extract(original);
  const reordered = extract([...original].reverse());
  const changed = extract(replaceValue(original, 'gyro_lpf1_static_hz', '100'));
  const rescaledAcceleration = extract(replaceValue(original, 'acc_1G', '2731'));

  assert.deepEqual(first.configFingerprints.filter, reordered.configFingerprints.filter);
  assert.notDeepEqual(first.configFingerprints.filter, changed.configFingerprints.filter);
  assert.notDeepEqual(first.configFingerprints.filter,
    rescaledAcceleration.configFingerprints.filter);
});

test('patches with identical reviewed writers share one manifest and digest', () => {
  const pairs = [
    ['Rotorflight 4.4.0 (5fc142a) STM32F7X2', RELEASES['4.4']],
    ['Rotorflight 4.5.0 (e77d192) STM32F7X2', RELEASES['4.5']]
  ];
  for (const [left, right] of pairs) {
    const leftReport = extract(entriesFor(left));
    const rightReport = extract(entriesFor(right));
    assert.equal(leftReport.firmwareManifest, rightReport.firmwareManifest);
    assert.deepEqual(leftReport.configFingerprints.filter,
      rightReport.configFingerprints.filter);
  }
});

test('missing, duplicate, noncanonical, wrong-width and cross-invalid settings fail closed', () => {
  const base = entriesFor();
  assert.equal(extract(replaceValue(base, 'features', '8')).contextAvailable, true,
    'one compiled receiver mode is a valid post-validation feature state');
  const equalNotch = replaceValue(
    replaceValue(base, 'gyro_notch_hz', '100,100'),
    'gyro_notch_cutoff',
    '100,99'
  );
  const dynamicOutsideStatic = replaceValue(
    replaceValue(base, 'gyro_lpf1_static_hz', '100'),
    'gyro_lpf1_dyn_hz',
    '0,50'
  );
  const cases = [
    [removeKey(base, 'features'), 'FILTER_SETTING_MISSING'],
    [[...base, {key: 'features', value: '0'}], 'FILTER_SETTING_DUPLICATE'],
    [replaceValue(base, 'gyro_lpf1_static_hz', '01'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'response_time', '1,2'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'features', '4294967296'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'features', '2147483648'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'features', '2'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'features', '512'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'features', '131072'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'features', '262144'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'features', '33554432'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'features', '9'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'fields_mask', '8388608'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'I interval', '63'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'P interval', '8001'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'P ratio', '65'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'looptime', '250'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'pid_process_denom', '2'), 'FILTER_SETTING_INVALID'],
    [replaceValue(
      replaceValue(base, 'pid_process_denom', '3'),
      'filter_process_denom',
      '2'
    ), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'gyro_to_use', '3'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'gyro_hardware_lpf', '3'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'gyro_decimation_hz', '99'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'gyro_lpf1_type', '1'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'gyro_lpf2_type', '1'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'acc_lpf_hz', '150'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'acc_hardware', '23'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'acc_1G', '65536'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'acc_1G', '0'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'serialrx_provider', '20'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'use_unsynced_pwm', '1'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'motor_pwm_protocol', '0'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'cyclic_coupling', '-1,0,1'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'yaw_stop_gain', '24,25'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'collectiveRange', '100,100'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'gyro_lpf1_dyn_hz', '200,100'), 'FILTER_SETTING_INVALID'],
    [dynamicOutsideStatic, 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'dyn_notch_min_hz', '200'), 'FILTER_SETTING_INVALID'],
    [equalNotch, 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'minthrottle', '1000'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'maxthrottle', '500'), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'gyro_rpm_notch_source_roll',
      ['1', ...Array(15).fill('0')].join(',')), 'FILTER_SETTING_INVALID'],
    [replaceValue(base, 'gyro_rpm_notch_q_yaw',
      ['9', ...Array(15).fill('0')].join(',')), 'FILTER_SETTING_INVALID']
  ];
  for (const [candidate, expected] of cases) {
    const report = extract(candidate);
    assert.equal(report.contextAvailable, false);
    assert.equal(report.configFingerprints.filter, null);
    assert.equal(report.codes.includes(expected), true);
    assert.equal(report.codes.includes('GOVERNOR_CONFIGURATION_NOT_LOGGED'), true);
  }
});

test('cadence and motor invariants match the reviewed firmware derivations', () => {
  const base = entriesFor();

  assert.equal(extract(base).contextAvailable, true);
  assert.equal(extract(replaceValue(base, 'pid_process_denom', '2'))
    .contextAvailable, false,
  '8 kHz / 2 makes the Blackbox I/P ratio 64, not the reported 32');

  let validFasterPid = replaceValue(base, 'pid_process_denom', '2');
  validFasterPid = replaceValue(validFasterPid, 'I interval', '128');
  validFasterPid = replaceValue(validFasterPid, 'P ratio', '64');
  assert.equal(extract(validFasterPid).contextAvailable, true);

  let validStandard = replaceValue(base, 'motor_pwm_protocol', '0');
  validStandard = replaceValue(validStandard, 'use_unsynced_pwm', '1');
  assert.equal(extract(validStandard).contextAvailable, true);
  assert.equal(extract(replaceValue(validStandard, 'motor_pwm_rate', '481'))
    .contextAvailable, false);

  let validCastleLink = replaceValue(base, 'motor_pwm_protocol', '9');
  validCastleLink = replaceValue(validCastleLink, 'use_unsynced_pwm', '1');
  validCastleLink = replaceValue(validCastleLink, 'motor_pwm_rate', '100');
  assert.equal(extract(validCastleLink).contextAvailable, true);
  assert.equal(extract(replaceValue(validCastleLink, 'motor_pwm_rate', '101'))
    .contextAvailable, false,
  'Castle Link output is clamped to CASTLE_PWM_HZ_MAX before logging');

  assert.equal(extract(replaceValue(base, 'use_unsynced_pwm', '1'))
    .contextAvailable, false,
  'firmware forces DSHOT output synchronised');
  assert.equal(extract(replaceValue(base, 'dshot_bidir', '1'))
    .contextAvailable, true,
  'DSHOT600 at a 2 kHz PID rate satisfies the halved telemetry ceiling');

  let dshot150TooFast = replaceValue(base, 'motor_pwm_protocol', '5');
  dshot150TooFast = replaceValue(dshot150TooFast, 'dshot_bidir', '1');
  dshot150TooFast = replaceValue(dshot150TooFast, 'pid_process_denom', '2');
  dshot150TooFast = replaceValue(dshot150TooFast, 'I interval', '128');
  dshot150TooFast = replaceValue(dshot150TooFast, 'P ratio', '64');
  assert.equal(extract(dshot150TooFast).contextAvailable, false,
  'bidirectional DSHOT150 limits the PID rate to 2 kHz');

  let validDshot150 = replaceValue(base, 'motor_pwm_protocol', '5');
  validDshot150 = replaceValue(validDshot150, 'dshot_bidir', '1');
  assert.equal(extract(validDshot150).contextAvailable, true);

  let fourKilohertz = entriesFor(RELEASES['4.5']);
  fourKilohertz = replaceValue(fourKilohertz, 'looptime', '250');
  fourKilohertz = replaceValue(fourKilohertz, 'pid_process_denom', '1');
  fourKilohertz = replaceValue(fourKilohertz, 'I interval', '128');
  fourKilohertz = replaceValue(fourKilohertz, 'P ratio', '64');
  assert.equal(extract(fourKilohertz).contextAvailable, true,
  'RF 4.5 has the reviewed 4 kHz gyro path');

  let pre45FourKilohertz = entriesFor(RELEASES['4.4']);
  pre45FourKilohertz = replaceValue(pre45FourKilohertz, 'looptime', '250');
  pre45FourKilohertz = replaceValue(pre45FourKilohertz, 'pid_process_denom', '1');
  pre45FourKilohertz = replaceValue(pre45FourKilohertz, 'I interval', '128');
  pre45FourKilohertz = replaceValue(pre45FourKilohertz, 'P ratio', '64');
  assert.equal(extract(pre45FourKilohertz).contextAvailable, false,
  'the reviewed RF 4.4 gyro_sync.c has no 4 kHz sample-rate path');

  let legacyF7NineKilohertz = entriesFor(RELEASES['4.4']);
  legacyF7NineKilohertz = replaceValue(legacyF7NineKilohertz, 'looptime', '111');
  legacyF7NineKilohertz = replaceValue(legacyF7NineKilohertz, 'P ratio', '36');
  legacyF7NineKilohertz = replaceValue(legacyF7NineKilohertz, 'I interval', '72');
  assert.equal(extract(legacyF7NineKilohertz).contextAvailable, true,
    'RF 4.4 STM32F7X2 includes the 9 kHz gyro path');

  let currentF7NineKilohertz = entriesFor(RELEASES['4.6']);
  currentF7NineKilohertz = replaceValue(currentF7NineKilohertz, 'looptime', '111');
  currentF7NineKilohertz = replaceValue(currentF7NineKilohertz, 'P ratio', '36');
  currentF7NineKilohertz = replaceValue(currentF7NineKilohertz, 'I interval', '72');
  assert.equal(extract(currentF7NineKilohertz).contextAvailable, false,
    'the RF 4.6 9 kHz branch is compiled only for STM32H7');

  let rf45Lsm6dso = entriesFor(RELEASES['4.5']);
  rf45Lsm6dso = replaceValue(rf45Lsm6dso, 'looptime', '150');
  rf45Lsm6dso = replaceValue(rf45Lsm6dso, 'pid_process_denom', '2');
  rf45Lsm6dso = replaceValue(rf45Lsm6dso, 'P ratio', '53');
  rf45Lsm6dso = replaceValue(rf45Lsm6dso, 'I interval', '106');
  assert.equal(extract(rf45Lsm6dso).contextAvailable, true,
    'RF 4.5 STM32F7X2 includes the 6664 Hz LSM6DSO path');

  let rf46DisabledLsm6dso = entriesFor(RELEASES['4.6']);
  rf46DisabledLsm6dso = replaceValue(rf46DisabledLsm6dso, 'looptime', '150');
  rf46DisabledLsm6dso = replaceValue(rf46DisabledLsm6dso, 'pid_process_denom', '2');
  rf46DisabledLsm6dso = replaceValue(rf46DisabledLsm6dso, 'P ratio', '53');
  rf46DisabledLsm6dso = replaceValue(rf46DisabledLsm6dso, 'I interval', '106');
  assert.equal(extract(rf46DisabledLsm6dso).contextAvailable, false,
    'the RF 4.6 unified target disables the LSM6DSO path');

  let experimentalBmi270 = entriesFor(RELEASES['4.5']);
  experimentalBmi270 = replaceValue(experimentalBmi270, 'looptime', '156');
  experimentalBmi270 = replaceValue(experimentalBmi270, 'pid_process_denom', '2');
  experimentalBmi270 = replaceValue(experimentalBmi270, 'P ratio', '51');
  experimentalBmi270 = replaceValue(experimentalBmi270, 'I interval', '102');
  assert.equal(extract(experimentalBmi270).contextAvailable, false,
    'the reviewed production target does not compile the experimental 6400 Hz path');
});

test('sample-rate filter ceilings match writer-era config validation and lrintf rounding', () => {
  const oneKilohertz = revision => {
    let entries = entriesFor(revision);
    entries = replaceValue(entries, 'looptime', '1000');
    entries = replaceValue(entries, 'pid_process_denom', '1');
    entries = replaceValue(entries, 'filter_process_denom', '1');
    entries = replaceValue(entries, 'I interval', '32');
    entries = replaceValue(entries, 'P ratio', '16');
    return entries;
  };

  const legacy = oneKilohertz(RELEASES['4.5']);
  assert.equal(extract(replaceValue(legacy, 'gyro_decimation_hz', '500'))
    .contextAvailable, true);
  assert.equal(extract(replaceValue(legacy, 'gyro_decimation_hz', '501'))
    .contextAvailable, false);

  const current = oneKilohertz(RELEASES['4.6']);
  assert.equal(extract(replaceValue(current, 'gyro_decimation_hz', '300'))
    .contextAvailable, true);
  assert.equal(extract(replaceValue(current, 'gyro_decimation_hz', '301'))
    .contextAvailable, false);
  assert.equal(extract(replaceValue(current, 'gyro_lpf1_static_hz', '450'))
    .contextAvailable, true);
  assert.equal(extract(replaceValue(current, 'gyro_lpf1_static_hz', '451'))
    .contextAvailable, false);
  assert.equal(extract(replaceValue(current, 'gyro_notch_hz', '451,0'))
    .contextAvailable, false);
  assert.equal(extract(replaceValue(current, 'gyro_notch_cutoff', '451,0'))
    .contextAvailable, false);

  let legacyTie = entriesFor(RELEASES['4.5']);
  legacyTie = replaceValue(legacyTie, 'looptime', '888');
  legacyTie = replaceValue(legacyTie, 'pid_process_denom', '1');
  legacyTie = replaceValue(legacyTie, 'filter_process_denom', '1');
  legacyTie = replaceValue(legacyTie, 'I interval', '36');
  legacyTie = replaceValue(legacyTie, 'P ratio', '18');
  assert.equal(extract(replaceValue(legacyTie, 'gyro_decimation_hz', '562'))
    .contextAvailable, true,
  'lrintf(562.5) rounds to the even integer');
  assert.equal(extract(replaceValue(legacyTie, 'gyro_decimation_hz', '563'))
    .contextAvailable, false);

  let pre45F7 = entriesFor(RELEASES['4.4']);
  pre45F7 = replaceValue(pre45F7, 'looptime', '888');
  pre45F7 = replaceValue(pre45F7, 'pid_process_denom', '1');
  pre45F7 = replaceValue(pre45F7, 'filter_process_denom', '1');
  pre45F7 = replaceValue(pre45F7, 'I interval', '36');
  pre45F7 = replaceValue(pre45F7, 'P ratio', '18');
  assert.equal(extract(pre45F7).contextAvailable, false,
    'the RF 4.4 1125 Hz branch is compiled only for F411/G4');
});

test('version-specific domains accept only values valid for that firmware writer', () => {
  const m44 = entriesFor(RELEASES['4.4']);
  const m45 = entriesFor(RELEASES['4.5']);
  const m46 = entriesFor(RELEASES['4.6']);

  assert.equal(extract(replaceValue(m44, 'yaw_precomp_impulse', '255,250'))
    .contextAvailable, true);
  assert.equal(extract(replaceValue(m44, 'yaw_precomp_impulse', '-1,250'))
    .contextAvailable, false);
  assert.equal(extract(replaceValue(m44, 'deadband', '33')).contextAvailable, false);
  assert.equal(extract(replaceValue(m46, 'deadband', '100')).contextAvailable, true);
  assert.equal(extract(replaceValue(m44, 'motor_pwm_protocol', '10'))
    .contextAvailable, false);
  assert.equal(extract(replaceValue(m45, 'motor_pwm_protocol', '10'))
    .contextAvailable, true);
  assert.equal(extract(replaceValue(m46, 'motor_pwm_protocol', '11'))
    .contextAvailable, false);
  assert.equal(extract(replaceValue(m44, 'acc_1G', '4096')).contextAvailable, true);
  assert.equal(extract(replaceValue(m46, 'acc_1G', '4096')).contextAvailable, false);
  assert.equal(extract(replaceValue(m46, 'acc_1G', '2731')).contextAvailable, true);

  let signedCenter = replaceValue(m45, 'gyro_rpm_notch_source_pitch',
    ['10', ...Array(15).fill('0')].join(','));
  signedCenter = replaceValue(signedCenter, 'gyro_rpm_notch_q_pitch',
    ['10', ...Array(15).fill('0')].join(','));
  signedCenter = replaceValue(signedCenter, 'gyro_rpm_notch_center_pitch',
    ['-32768', ...Array(15).fill('0')].join(','));
  assert.equal(extract(signedCenter).contextAvailable, true);
  const tooLow = ['-32769', ...Array(15).fill('0')].join(',');
  assert.equal(extract(replaceValue(signedCenter, 'gyro_rpm_notch_center_pitch', tooLow))
    .contextAvailable, false);

  assert.equal(extract(replaceValue(m45, 'gyro_rpm_notch_preset', '1'))
    .contextAvailable, false);
  const noncanonicalDisabled = ['-1', ...Array(15).fill('0')].join(',');
  assert.equal(extract(replaceValue(m45,
    'gyro_rpm_notch_center_pitch', noncanonicalDisabled)).contextAvailable, false);

  const legacyInvalidSource = ['5', ...Array(15).fill('0')].join(',');
  assert.equal(extract(replaceValue(m44,
    'gyro_rpm_filter_bank_rpm_source', legacyInvalidSource)).contextAvailable, false);

  const q101 = ['101', ...Array(15).fill('0')].join(',');
  assert.equal(extract(replaceValue(entriesFor(RELEASES['4.3']),
    'gyro_rpm_filter_bank_notch_q', q101)).contextAvailable, false);
  assert.equal(extract(replaceValue(m44,
    'gyro_rpm_filter_bank_notch_q', q101)).contextAvailable, true);

  const canonicalizationCandidate = ['1', ...Array(15).fill('0')].join(',');
  let legacyInconsistent = replaceValue(m44, 'gyro_rpm_filter_bank_rpm_ratio',
    canonicalizationCandidate);
  legacyInconsistent = replaceValue(legacyInconsistent,
    'gyro_rpm_filter_bank_notch_q',
    ['5', ...Array(15).fill('0')].join(','));
  assert.equal(extract(legacyInconsistent).contextAvailable, true,
    'the firmware does not rewrite the legacy bank while the feature is off');
  legacyInconsistent = replaceValue(legacyInconsistent, 'features', '1073741824');
  assert.equal(extract(legacyInconsistent).contextAvailable, false,
    'an enabled RPM filter rewrites a zero-source bank to all zeros');

  assert.equal(extract(replaceValue(m46, 'gyro_notch_cutoff', '100,0'))
    .contextAvailable, true,
    'a disabled notch retains its cutoff after firmware validation');
  assert.equal(extract(replaceValue(m46, 'gyro_lpf1_static_hz', '100'))
    .contextAvailable, true,
    'a disabled dynamic LPF may coexist with an enabled static LPF');
});

test('unreviewed patches, commits, release candidates and targets cannot borrow a manifest', () => {
  for (const revision of [
    'Rotorflight 4.6.1 (118e912) STM32F7X2',
    'Rotorflight 4.6.0 (fffffff) STM32F7X2',
    'Rotorflight 4.6.0-RC3 (37e705a) STM32F7X2',
    'Rotorflight 4.6.0 (118e912) STM32H743'
  ]) {
    const report = extract(replaceValue(entriesFor(), 'Firmware revision', revision));
    assert.equal(report.firmwareManifest, null, revision);
    assert.equal(report.contextAvailable, false, revision);
    assert.deepEqual(report.codes, ['FIRMWARE_RELEASE_NOT_REVIEWED'], revision);
  }

  assert.deepEqual(extract([...entriesFor(),
    {key: 'Firmware type', value: 'Rotorflight'}]).codes,
  ['FIRMWARE_HEADER_INVALID']);
  assert.deepEqual(extract(removeKey(entriesFor(), 'Data version')).codes,
    ['FIRMWARE_HEADER_INVALID']);
  assert.deepEqual(extract(removeKey(entriesFor(), 'gyro_scale')).codes,
    ['FIRMWARE_HEADER_INVALID']);
  assert.deepEqual(extract(replaceValue(entriesFor(), 'gyro_scale', '0x3f000000')).codes,
    ['FIRMWARE_HEADER_INVALID']);
});

test('ordered header evidence is opt-in, immutable, duplicate-aware, and must terminate cleanly', () => {
  const entries = entriesFor();
  const ordinary = parseSession(headerBytes(entries), 0, 0);
  assert.equal('headerEntries' in ordinary, false);
  assert.deepEqual(extractCommunityConfiguration(ordinary).codes,
    ['HEADER_ENTRIES_UNAVAILABLE']);

  const parsed = parseSession(headerBytes(entries), 0, 0, {retainHeaderEntries: true});
  assert.equal(parsed.headerTerminationClean, true);
  assert.equal(Object.isFrozen(parsed.headerEntries), true);
  assert.equal(Object.isFrozen(parsed.headerEntries[0]), true);
  assert.equal(Object.getOwnPropertyDescriptor(parsed, 'headerTerminationClean')
    .configurable, false);
  assert.equal(Object.getOwnPropertyDescriptor(parsed, 'headerEntries').writable, false);
  const proxiedParsed = new Proxy(parsed, {});
  const firstParsedReport = extractCommunityConfiguration(proxiedParsed);
  const secondParsedReport = extractCommunityConfiguration(proxiedParsed);
  assert.equal(firstParsedReport.contextAvailable, true);
  assert.deepEqual(secondParsedReport, firstParsedReport);

  const duplicated = [...entries, {key: 'gyro_lpf1_static_hz', value: '999'}];
  const parsedDuplicate = parseSession(
    headerBytes(duplicated), 0, 0, {retainHeaderEntries: true}
  );
  assert.equal(parsedDuplicate.headers.gyro_lpf1_static_hz, '999');
  assert.equal(extractCommunityConfiguration(parsedDuplicate).codes
    .includes('FILTER_SETTING_DUPLICATE'), true);

  const truncated = parseSession(
    headerBytes(entries, 'H broken'), 0, 0, {retainHeaderEntries: true}
  );
  assert.equal(truncated.headerTerminationClean, false);
  assert.deepEqual(extractCommunityConfiguration(truncated).codes,
    ['HEADER_TERMINATION_UNCLEAN']);
  assert.deepEqual(extract(entries, {headerTerminationClean: false}).codes,
    ['HEADER_TERMINATION_UNCLEAN']);

  const newlineBoundaryCut = parseSession(
    headerBytes(removeKey(entriesFor(), 'fields_mask')),
    0,
    0,
    {retainHeaderEntries: true}
  );
  assert.equal(newlineBoundaryCut.headerTerminationClean, true);
  const cutReport = extractCommunityConfiguration(newlineBoundaryCut);
  assert.equal(cutReport.contextAvailable, false);
  assert.equal(cutReport.codes.includes('FILTER_SETTING_MISSING'), true);
});

test('hostile arrays, accessors, and oversized evidence remain bounded and deterministic', () => {
  const entries = entriesFor();
  Object.defineProperty(entries, Symbol.iterator, {
    configurable: true,
    value: function* hostileIterator() {
      throw new Error('must use indexed reads');
    }
  });
  assert.equal(extract(entries).contextAvailable, true);

  const getterEntries = entriesFor();
  const index = getterEntries.findIndex(entry => entry.key === 'features');
  let keyReads = 0;
  let valueReads = 0;
  getterEntries[index] = Object.defineProperties({}, {
    key: {get() { keyReads += 1; return keyReads === 1 ? 'features' : 'Craft name'; }},
    value: {get() { valueReads += 1; return valueReads === 1 ? '0' : 'PRIVATE'; }}
  });
  assert.deepEqual(extract(getterEntries).codes,
    ['HEADER_ENTRIES_UNAVAILABLE']);
  assert.deepEqual(extract(getterEntries).codes,
    ['HEADER_ENTRIES_UNAVAILABLE']);
  assert.equal(keyReads, 0);
  assert.equal(valueReads, 0);

  const indexedAccessor = entriesFor();
  const first = indexedAccessor[0];
  Object.defineProperty(indexedAccessor, '0', {
    configurable: true,
    get() { return first; }
  });
  for (let entryIndex = 0; entryIndex < indexedAccessor.length; entryIndex += 1) {
    Object.freeze(indexedAccessor[entryIndex]);
  }
  Object.freeze(indexedAccessor);
  assert.deepEqual(extractCommunityConfiguration(evidenceSession(indexedAccessor)).codes,
    ['HEADER_ENTRIES_UNAVAILABLE']);

  const tooMany = Array.from({length: 1025}, (_, entryIndex) => ({
    key: `x${entryIndex}`,
    value: '0'
  }));
  assert.deepEqual(extract(tooMany).codes, ['HEADER_EVIDENCE_LIMIT_EXCEEDED']);
  assert.deepEqual(extract([{key: 'x'.repeat(129), value: '0'}]).codes,
    ['HEADER_EVIDENCE_LIMIT_EXCEEDED']);
  assert.deepEqual(extract([{key: 'x', value: '0'.repeat(8193)}]).codes,
    ['HEADER_EVIDENCE_LIMIT_EXCEEDED']);
  const overAggregate = Array.from({length: 129}, (_, entryIndex) => ({
    key: `x${entryIndex}`,
    value: '0'.repeat(8192)
  }));
  assert.deepEqual(extract(overAggregate).codes,
    ['HEADER_EVIDENCE_LIMIT_EXCEEDED']);
});

test('mutable ordered evidence is rejected instead of being raced after validation', () => {
  const mutableArray = entriesFor();
  assert.deepEqual(extractCommunityConfiguration(evidenceSession(mutableArray)).codes,
    ['HEADER_ENTRIES_MUTABLE']);

  const mutableEntry = entriesFor();
  for (let index = 1; index < mutableEntry.length; index += 1) {
    Object.freeze(mutableEntry[index]);
  }
  Object.freeze(mutableEntry);
  assert.deepEqual(extractCommunityConfiguration(evidenceSession(mutableEntry)).codes,
    ['HEADER_ENTRIES_MUTABLE']);

  const mutableSlot = evidenceSession(undefined);
  Object.defineProperty(mutableSlot, 'headerEntries', {
    value: Object.freeze([]),
    enumerable: true,
    writable: true,
    configurable: true
  });
  assert.deepEqual(extractCommunityConfiguration(mutableSlot).codes,
    ['HEADER_ENTRIES_MUTABLE']);
});

test('invalid session shapes and throwing accessors fail closed with closed reason codes', () => {
  assert.deepEqual(extractCommunityConfiguration(null).codes,
    ['SESSION_DEFINITION_INVALID']);
  assert.deepEqual(extractCommunityConfiguration(evidenceSession(undefined, {
    headers: Object.fromEntries(entriesFor().map(entry => [entry.key, entry.value]))
  })).codes, ['HEADER_ENTRIES_UNAVAILABLE']);

  const hostile = evidenceSession(undefined);
  let hostileReads = 0;
  Object.defineProperty(hostile, 'headerEntries', {
    get() { hostileReads += 1; throw new Error('hostile getter'); }
  });
  assert.deepEqual(extractCommunityConfiguration(hostile).codes,
    ['HEADER_ENTRIES_UNAVAILABLE']);
  assert.deepEqual(extractCommunityConfiguration(hostile).codes,
    ['HEADER_ENTRIES_UNAVAILABLE']);
  assert.equal(hostileReads, 0);

  let terminationReads = 0;
  const hostileTermination = {headerEntries: Object.freeze([])};
  Object.defineProperty(hostileTermination, 'headerTerminationClean', {
    get() { terminationReads += 1; return true; }
  });
  assert.deepEqual(extractCommunityConfiguration(hostileTermination).codes,
    ['SESSION_DEFINITION_INVALID']);
  assert.equal(terminationReads, 0);

  const frozenEntries = entriesFor();
  for (const entry of frozenEntries) Object.freeze(entry);
  Object.freeze(frozenEntries);
  let alternatingReads = 0;
  const alternatingSession = new Proxy({}, {
    getOwnPropertyDescriptor(_target, key) {
      if (key === 'headerTerminationClean') {
        alternatingReads += 1;
        return {
          value: alternatingReads % 2 === 1,
          enumerable: true,
          writable: true,
          configurable: true
        };
      }
      if (key === 'headerEntries') {
        return {
          value: alternatingReads % 2 === 1 ? frozenEntries : Object.freeze([]),
          enumerable: true,
          writable: true,
          configurable: true
        };
      }
      return undefined;
    }
  });
  assert.equal(Object.isExtensible(alternatingSession), true);
  assert.deepEqual(extractCommunityConfiguration(alternatingSession).codes,
    ['SESSION_DEFINITION_INVALID']);
  assert.deepEqual(extractCommunityConfiguration(alternatingSession).codes,
    ['SESSION_DEFINITION_INVALID']);
  assert.equal(alternatingReads, 2);
  assert.deepEqual(COMMUNITY_CONFIG_EXTRACTION_CODES, [
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
});

test('reports are deeply frozen and expose no raw setting or private header text', () => {
  const report = extract(entriesFor());
  const rendered = JSON.stringify(report);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.configFingerprints), true);
  assert.equal(Object.isFrozen(report.configFingerprints.filter), true);
  assert.equal(Object.isFrozen(report.coverage), true);
  assert.equal(Object.isFrozen(report.codes), true);
  for (const forbidden of [
    'PRIVATE-CRAFT-NAME',
    '2026-08-14T12:34:56.000',
    'C:\\private\\flight.bbl',
    'gyro_lpf1_static_hz'
  ]) {
    assert.equal(rendered.includes(forbidden), false, forbidden);
  }
});

test('schema-2 partial evidence cannot enter the still-closed schema-1 contract', () => {
  const report = extract(entriesFor());
  assert.throws(
    () => normalizeConfigFingerprints(report.configFingerprints),
    /schemaVersion is unsupported/
  );
  assert.throws(
    () => normalizeConfigFingerprints({
      schemaVersion: 1,
      filter: report.configFingerprints.filter,
      governor: null
    }),
    /filter is malformed/
  );
});
