import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_VERSION,
  DRAFT_COMMUNITY_MANUAL_CONSENT_VERSION,
  DRAFT_COMMUNITY_MANUAL_LICENCE_VERSION,
  axisHeadspeedBandIndices,
  buildCommunityContribution,
  auditCommunityContribution
} from '../src/analysis/community-contract.mjs';
import {
  COMMUNITY_MAXIMUM_ABS_EFFECT_DPS_PER_LOG_GAIN_RATIO,
  COMMUNITY_EFFECT_SUPPORT_KIND,
  COMMUNITY_MINIMUM_ABS_LOG_GAIN_RATIO,
  COMMUNITY_MINIMUM_AIRCRAFT_SUPPORT,
  COMMUNITY_SHADOW_MODEL_KIND,
  COMMUNITY_SHADOW_MODEL_MODE,
  COMMUNITY_SHADOW_MODEL_TRUST_BOUNDARY,
  COMMUNITY_FIXTURE_MODEL_KIND,
  COMMUNITY_FIXTURE_MODEL_MODE,
  COMMUNITY_FIXTURE_TRUST_BOUNDARY,
  buildCommunityShadowModel as buildProductionCommunityShadowModel,
  buildCommunityShadowModelForPrevalidatedFixtures,
  profileCommunityShadowModelForPrevalidatedFixtures,
  auditCommunityShadowModel as auditProductionCommunityShadowModel,
  auditCommunityShadowModelForPrevalidatedFixtures
} from '../src/analysis/community-model.mjs';
import {FLIGHT_HISTORY_SCHEMA_VERSION, SHARED_RECORD_KIND} from
  '../src/analysis/flight-history.mjs';
import {FlightWindowBasis} from '../src/analysis/flight-window.mjs';

const AXES = ['roll', 'pitch', 'yaw'];
const RATES = 'rf-rates-v2:4|100,100,100|20,20,20|800,800,800';
const FILTER_HASH = `sha256:${Buffer.alloc(32, 1).toString('base64url')}`;
const GOVERNOR_HASH = `sha256:${Buffer.alloc(32, 2).toString('base64url')}`;

function contributionId(index) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(index, 28);
  return `hmac-sha256:${bytes.toString('base64url')}`;
}

function sharingId(index) {
  return `00000-00000-00000-${String(index).padStart(5, '0')}`;
}

function cloneGains(gains) {
  return Object.fromEntries(AXES.map(axis => [axis, [...gains[axis]]]));
}

function baseGains() {
  return {
    roll: [50, 100, 10, 0, 0],
    pitch: [50, 100, 10, 0, 0],
    yaw: [50, 100, 10, 0, 0]
  };
}

function stopSummary() {
  const direction = () => ({
    eventCount: 0,
    trackingRmsDps: null,
    fastRingingRmsDps: null,
    slowOscillationRmsDps: null,
    commandAmplitudeDps: null
  });
  return {
    status: 'inconclusive',
    positive: direction(),
    negative: direction()
  };
}

function axisSummary({
  error = 5,
  headspeed = 2000,
  holdCount = 3,
  holdKind = 'zero',
  holdStatus = 'captured'
} = {}) {
  const zeroHoldCount = holdKind === 'zero' ? holdCount : 0;
  const sustainedHoldCount = holdKind === 'sustained' ? holdCount : 0;
  return {
    headspeedMedianRpm: headspeed,
    hold: {
      status: holdStatus,
      holdCount,
      zeroHoldCount,
      sustainedHoldCount,
      meanAbsoluteSteadyStateErrorDps: error,
      worstAbsoluteSteadyStateErrorDps: error + 0.5,
      meanErrorDriftDpsPerSecond: 0,
      meanErrorRippleRmsDps: 0.2,
      meanErrorCrossingRateHz: 1,
      meanITermRms: 10
    },
    stop: stopSummary(),
    noise: {
      filteredHighFrequencyRmsDps: 0.2,
      unfilteredHighFrequencyRmsDps: 0.4
    }
  };
}

function contribution({
  id,
  aircraft,
  ordinal,
  gains = baseGains(),
  errors = {},
  headspeeds = {},
  holdCounts = {},
  holdKinds = {},
  holdStatuses = {},
  rotorDiameterMm = 700,
  firmwareRevision = 'Rotorflight 4.6.0 (118e912) STM32F7X2',
  ratesFingerprint = RATES,
  safetyAssessment = {airframe: 'clear'},
  guidance = {source: 'manual', modelVersion: null, communityInfluenced: false},
  trial = {
    kind: 'none',
    baselineContributionId: null,
    intendedAxis: null,
    intendedTerm: null,
    intendedDirection: null
  }
}) {
  const axes = {};
  for (const axis of AXES) {
    axes[axis] = axisSummary({
      error: errors[axis] ?? 5,
      headspeed: headspeeds[axis] ?? 2000,
      holdCount: holdCounts[axis] ?? 3,
      holdKind: holdKinds[axis] ?? 'zero',
      holdStatus: holdStatuses[axis] ?? 'captured'
    });
  }
  const shared = {
    schemaVersion: FLIGHT_HISTORY_SCHEMA_VERSION,
    kind: SHARED_RECORD_KIND,
    sharingId: sharingId(aircraft),
    ordinal,
    board: 'NEXUS',
    firmwareRevision,
    windowBasis: FlightWindowBasis.DETECTED,
    durationSeconds: 120,
    ratesFingerprint,
    gains: cloneGains(gains),
    axes
  };
  // The production contract intentionally has no released community model,
  // so its builder must reject that source. Build the fixed fixture envelope
  // with a safe source, then inject the unsupported source for the two tests
  // that prove feedback-derived transitions are excluded.
  const builderGuidance = guidance.source === 'rotorlens-community'
    ? {source: 'manual', modelVersion: null, communityInfluenced: false}
    : guidance;
  const builtEnvelope = buildCommunityContribution({
    consentVersion: DRAFT_COMMUNITY_MANUAL_CONSENT_VERSION,
    licenceVersion: DRAFT_COMMUNITY_MANUAL_LICENCE_VERSION,
    contributionId: contributionId(id),
    airframeProfile: {
      rotorDiameterMm,
      bladeCount: 2,
      powerType: 'electric',
      cyclicServoClass: 'standard',
      tailServoClass: 'mini'
    },
    configFingerprints: {
      schemaVersion: COMMUNITY_CONFIG_FINGERPRINT_SCHEMA_VERSION,
      filter: FILTER_HASH,
      governor: GOVERNOR_HASH
    },
    safetyAssessment,
    guidance: builderGuidance,
    trial,
    shareableRecord: shared
  });
  const built = guidance.source === 'rotorlens-community'
    ? Object.freeze({...builtEnvelope, guidance: Object.freeze({...guidance})})
    : builtEnvelope;
  const audit = auditCommunityContribution(built);
  assert.equal(audit.ok, false, 'draft legal receipts are intentionally not adopted');
  const expectedViolations = [
    'CONSENT_VERSION_NOT_ADOPTED',
    'LICENCE_VERSION_NOT_ADOPTED'
  ];
  if (guidance.source === 'rotorlens-community') {
    expectedViolations.push('COMMUNITY_GUIDANCE_MODEL_VERSION_UNSUPPORTED');
  }
  assert.deepEqual(audit.violations.map(value => value.code).sort(),
    expectedViolations.sort());
  assert.ok(audit.codes.includes('CONFIG_FINGERPRINT_SCHEMA_INCOMPLETE'));
  return built;
}

function nullSequence({
  firstId,
  aircraft,
  errors,
  rotorDiameterMm = 700,
  headspeed = 2000
}) {
  return errors.map((error, ordinal) => contribution({
    id: firstId + ordinal,
    aircraft,
    ordinal,
    rotorDiameterMm,
    headspeeds: {roll: headspeed, pitch: headspeed, yaw: headspeed},
    errors: {roll: error, pitch: error, yaw: error}
  }));
}

function effectSequence({
  firstId,
  aircraft,
  effect,
  gains,
  axis = 'yaw',
  term = 'I',
  guidance = {source: 'manual', modelVersion: null, communityInfluenced: false},
  rotorDiameterMm = 700,
  controlled = true,
  headspeeds = {}
}) {
  const index = {P: 0, I: 1, D: 2}[term];
  return gains.map((gain, ordinal) => {
    const lines = baseGains();
    lines[axis][index] = gain;
    const selectedHeadspeeds = Array.isArray(headspeeds)
      ? headspeeds[ordinal]
      : headspeeds;
    const flightHeadspeeds = Number.isFinite(selectedHeadspeeds)
      ? Object.fromEntries(AXES.map(candidate => [candidate, selectedHeadspeeds]))
      : selectedHeadspeeds;
    return contribution({
      id: firstId + ordinal,
      aircraft,
      ordinal,
      rotorDiameterMm,
      guidance,
      gains: lines,
      headspeeds: flightHeadspeeds,
      trial: controlled && ordinal > 0 ? {
        kind: 'rotorlens-controlled-v1',
        baselineContributionId: contributionId(firstId + ordinal - 1),
        intendedAxis: axis,
        intendedTerm: term === 'P' || term === 'I' ? term : 'P',
        intendedDirection: gain > gains[ordinal - 1] ? 'increase' : 'decrease'
      } : undefined,
      errors: {[axis]: 5 + effect * Math.log(gain / gains[0])}
    });
  });
}

function fixtureCohortKey(contribution) {
  const bands = axisHeadspeedBandIndices(contribution.shareableRecord);
  return 'prevalidated-fixture-cohort-v1:'
    + `r${contribution.airframeProfile.rotorDiameterMm}`
    + `-h${bands.roll}.${bands.pitch}.${bands.yaw}`;
}

function fixtureEntries(contributions) {
  return contributions.map(item => ({
    contribution: item,
    cohortKey: fixtureCohortKey(item)
  }));
}

function buildCommunityShadowModel(contributions = []) {
  return buildCommunityShadowModelForPrevalidatedFixtures(fixtureEntries(contributions));
}

function profileCommunityShadowModel(contributions = []) {
  return profileCommunityShadowModelForPrevalidatedFixtures(fixtureEntries(contributions));
}

function auditCommunityShadowModel(model) {
  return auditCommunityShadowModelForPrevalidatedFixtures(model);
}

function testMedian(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function bruteForceCommonSupport(aircraftRectangles) {
  const gains = [...new Set(aircraftRectangles.flatMap(rectangles =>
    rectangles.flatMap(rectangle => [rectangle.gainLow, rectangle.gainHigh])))]
    .sort((left, right) => left - right);
  const rpms = [...new Set(aircraftRectangles.flatMap(rectangles =>
    rectangles.flatMap(rectangle => [rectangle.rpmLow, rectangle.rpmHigh])))]
    .sort((left, right) => left - right);
  let bestMatches = [];
  for (const gain of gains) {
    for (const rpm of rpms) {
      const matches = aircraftRectangles.map(rectangles => rectangles.filter(rectangle =>
        rectangle.gainLow <= gain && gain <= rectangle.gainHigh
          && rectangle.rpmLow <= rpm && rpm <= rectangle.rpmHigh))
        .filter(rectangles => rectangles.length > 0);
      if (matches.length > bestMatches.length) {
        bestMatches = matches;
      }
    }
  }
  const aircraftEffects = bestMatches.map(rectangles =>
    testMedian(rectangles.map(rectangle => rectangle.effect)));
  return {
    aircraftCount: bestMatches.length,
    transitionCount: bestMatches.reduce((sum, rectangles) => sum + rectangles.length, 0),
    medianEffect: testMedian(aircraftEffects)
  };
}

function deterministicRandom(seed) {
  let state = seed >>> 0;
  return maximum => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % maximum;
  };
}

test('the empty artifact is fixed, frozen, shadow-only, and rejects unknown fields', () => {
  const model = buildProductionCommunityShadowModel([]);
  assert.equal(model.kind, COMMUNITY_SHADOW_MODEL_KIND);
  assert.equal(model.mode, COMMUNITY_SHADOW_MODEL_MODE);
  assert.equal(model.trustBoundary, COMMUNITY_SHADOW_MODEL_TRUST_BOUNDARY);
  assert.equal(model.contract.minimumAircraftSupport, COMMUNITY_MINIMUM_AIRCRAFT_SUPPORT);
  assert.equal(model.contract.controlledTrialKind, 'rotorlens-controlled-v1');
  assert.equal(model.contract.effectSupportKind, COMMUNITY_EFFECT_SUPPORT_KIND);
  assert.equal(model.contract.minimumAbsLogGainRatio,
    Math.round(COMMUNITY_MINIMUM_ABS_LOG_GAIN_RATIO * 1e12) / 1e12);
  assert.equal(model.contract.maximumAbsEffectDpsPerLogGainRatio,
    COMMUNITY_MAXIMUM_ABS_EFFECT_DPS_PER_LOG_GAIN_RATIO);
  assert.deepEqual(model.cohorts, []);
  assert.equal(Object.isFrozen(model), true);
  assert.deepEqual(auditProductionCommunityShadowModel(model), {ok: true, violations: []});

  const extra = {...model, deployment: {enabled: true}};
  const audit = auditProductionCommunityShadowModel(extra);
  assert.equal(audit.ok, false);
  assert.ok(audit.violations.some(entry => entry.path === 'deployment'
    && entry.reason === 'unknown field'));

  const live = {...model, mode: 'production'};
  assert.equal(auditProductionCommunityShadowModel(live).ok, false);
  assert.throws(() => buildProductionCommunityShadowModel(null), TypeError);
  assert.throws(() => buildProductionCommunityShadowModel({}), TypeError);
});

test('the prevalidated-fixture seam has a production-rejected fixed identity', () => {
  const fixture = buildCommunityShadowModel([]);
  assert.equal(fixture.kind, COMMUNITY_FIXTURE_MODEL_KIND);
  assert.equal(fixture.mode, COMMUNITY_FIXTURE_MODEL_MODE);
  assert.equal(fixture.trustBoundary, COMMUNITY_FIXTURE_TRUST_BOUNDARY);
  assert.deepEqual(auditCommunityShadowModel(fixture), {ok: true, violations: []});
  assert.equal(auditProductionCommunityShadowModel(fixture).ok, false);
  assert.equal(auditCommunityShadowModel(
    buildProductionCommunityShadowModel([])
  ).ok, false);
});

test('deduplication, cohort ordering, adjacent pairing, and output are deterministic', () => {
  const input = [];
  let nextId = 100;
  for (let aircraft = 1; aircraft <= 5; aircraft += 1) {
    const errors = aircraft === 1
      ? Array.from({length: 21}, (_, index) => index % 2 === 0 ? 0 : 100)
      : [0, 1];
    input.push(...nullSequence({firstId: nextId, aircraft, errors, rotorDiameterMm: 700}));
    nextId += errors.length;
  }
  for (let aircraft = 11; aircraft <= 15; aircraft += 1) {
    input.push(...nullSequence({
      firstId: nextId,
      aircraft,
      errors: [0, aircraft - 10],
      rotorDiameterMm: 800
    }));
    nextId += 2;
  }
  input.push(input[0]);

  const forward = buildCommunityShadowModel(input);
  const reversed = buildCommunityShadowModel([...input].reverse());
  assert.equal(JSON.stringify(forward), JSON.stringify(reversed));
  assert.deepEqual(auditCommunityShadowModel(forward), {ok: true, violations: []});
  assert.equal(forward.exclusions.duplicateContributionIdCount, 1);
  assert.equal(forward.summary.deduplicatedContributionCount, input.length - 1);
  assert.equal(forward.cohorts.length, 2);
  assert.deepEqual(
    forward.cohorts.map(entry => entry.cohortKey),
    ['shadow-cohort-000001', 'shadow-cohort-000002']
  );

  const sevenHundred = forward.cohorts.find(entry => entry.axes.yaw.noise.pairCount === 24);
  const noise = sevenHundred.axes.yaw.noise;
  assert.equal(noise.aircraftCount, 5);
  assert.equal(noise.pairCount, 24,
    'twenty adjacent transitions plus four pairs; never all combinations');
  assert.equal(noise.medianAbsoluteDeltaDps, 1,
    'one prolific aircraft is one aircraft median, not twenty votes');
});

test('effect fitting gives every aircraft one vote despite one prolific aircraft', () => {
  const input = [];
  input.push(...effectSequence({
    firstId: 1000,
    aircraft: 1,
    effect: 10,
    gains: Array.from({length: 21}, (_, index) => index % 2 === 0 ? 100 : 200)
  }));
  for (let aircraft = 2; aircraft <= 5; aircraft += 1) {
    input.push(...effectSequence({
      firstId: 1100 + aircraft * 10,
      aircraft,
      effect: -1,
      gains: [100, 200]
    }));
  }

  const model = buildCommunityShadowModel(input);
  const effect = model.cohorts[0].axes.yaw.effects.I;
  assert.equal(effect.state, 'available');
  assert.equal(effect.aircraftCount, 5);
  assert.equal(effect.transitionCount, 24);
  assert.ok(Math.abs(effect.medianEffectDpsPerLogGainRatio - (-1)) < 1e-9);
  assert.deepEqual(effect.signAgreement, {
    agreeingAircraftCount: 4,
    evaluatedAircraftCount: 5,
    ratio: 0.8
  });
  assert.equal(Object.hasOwn(effect, 'observedGainRange'), false);
  assert.equal(Object.hasOwn(effect, 'aircraftMedianEffectRangeDpsPerLogGainRatio'), false);
});

test('effects require an exact controlled-trial link and explicit non-community guidance', () => {
  const input = [];
  for (let aircraft = 1; aircraft <= 5; aircraft += 1) {
    input.push(...effectSequence({
      firstId: 1400 + aircraft * 10,
      aircraft,
      effect: -1,
      gains: [100, 200]
    }));
  }
  input.push(...effectSequence({
    firstId: 1500,
    aircraft: 6,
    effect: -1,
    gains: [100, 200],
    controlled: false
  }));

  const mismatchedBefore = contribution({id: 1520, aircraft: 7, ordinal: 0});
  const mismatchedGains = baseGains();
  mismatchedGains.yaw[1] = 200;
  const mismatchedAfter = contribution({
    id: 1521,
    aircraft: 7,
    ordinal: 1,
    gains: mismatchedGains,
    errors: {yaw: 4},
    trial: {
      kind: 'rotorlens-controlled-v1',
      baselineContributionId: contributionId(999_999),
      intendedAxis: 'yaw',
      intendedTerm: 'I',
      intendedDirection: 'increase'
    }
  });
  input.push(mismatchedBefore, mismatchedAfter);

  input.push(...effectSequence({
    firstId: 1540,
    aircraft: 8,
    effect: -1,
    gains: [100, 200],
    guidance: {source: 'unknown', modelVersion: null, communityInfluenced: null}
  }));
  input.push(...effectSequence({
    firstId: 1560,
    aircraft: 9,
    effect: -1,
    gains: [100, 200],
    guidance: {
      source: 'rotorlens-community',
      modelVersion: 'shadow-feedback-1',
      communityInfluenced: true
    }
  }));
  input.push(...effectSequence({
    firstId: 1580,
    aircraft: 10,
    effect: -1,
    gains: [100, 200],
    guidance: {
      source: 'rotorlens-local',
      modelVersion: 'rotorlens-local-rules-v1',
      communityInfluenced: false
    }
  }));
  input.push(...effectSequence({
    firstId: 1600,
    aircraft: 11,
    effect: -1,
    gains: [100, 200],
    guidance: {source: 'manual', modelVersion: null, communityInfluenced: null}
  }));
  input.push(...effectSequence({
    firstId: 1620,
    aircraft: 12,
    effect: -1,
    gains: [100, 200],
    guidance: {source: 'manual', modelVersion: null, communityInfluenced: true}
  }));

  const model = buildCommunityShadowModel(input);
  const effect = model.cohorts[0].axes.yaw.effects.I;
  assert.equal(effect.transitionCount, 6, 'five manual and one explicit local trial qualify');
  assert.equal(model.exclusions.uncontrolledTransitionCount, 1);
  assert.equal(model.exclusions.trialMismatchTransitionCount, 1);
  assert.equal(model.exclusions.unknownGuidanceTransitionCount, 1);
  assert.equal(model.exclusions.unknownGuidanceAncestryTransitionCount, 1);
  assert.equal(model.exclusions.communityInfluencedTransitionCount, 1);
  assert.equal(model.exclusions.communityGuidedTransitionCount, 1);
  assert.equal(JSON.stringify(model).includes('shadow-feedback-1'), false);
});

test('axis-specific logarithmic RPM bands prevent distant headspeeds from pooling', () => {
  const input = [];
  let firstId = 1600;
  for (let aircraft = 1; aircraft <= 5; aircraft += 1) {
    input.push(...nullSequence({firstId, aircraft, errors: [0, 1], headspeed: 1200}));
    firstId += 2;
  }
  for (let aircraft = 11; aircraft <= 15; aircraft += 1) {
    input.push(...nullSequence({firstId, aircraft, errors: [0, 3], headspeed: 2800}));
    firstId += 2;
  }

  const model = buildCommunityShadowModel(input);
  assert.equal(model.cohorts.length, 2);
  assert.deepEqual(model.cohorts.map(entry => entry.cohortKey),
    ['shadow-cohort-000001', 'shadow-cohort-000002']);
  assert.deepEqual(model.cohorts.map(entry => entry.axes.yaw.noise.medianAbsoluteDeltaDps)
    .sort((left, right) => left - right), [1, 3]);
  const text = JSON.stringify(model);
  assert.equal(text.includes('1200'), false);
  assert.equal(text.includes('2800'), false);
});

test('effect publication requires one common gain and RPM point across five aircraft', () => {
  const input = [];
  const gainIntervals = [
    [80, 120],
    [90, 130],
    [100, 140],
    [70, 110],
    [95, 105]
  ];
  for (let index = 0; index < gainIntervals.length; index += 1) {
    input.push(...effectSequence({
      firstId: 1800 + index * 10,
      aircraft: index + 1,
      effect: -2,
      gains: gainIntervals[index]
    }));
  }

  const model = buildCommunityShadowModel(input);
  const effect = model.cohorts[0].axes.yaw.effects.I;
  assert.equal(effect.state, 'available');
  assert.equal(effect.aircraftCount, 5);
  assert.equal(effect.transitionCount, 5);
  assert.equal(effect.medianEffectDpsPerLogGainRatio, -2);
  assert.deepEqual(Object.keys(effect), [
    'state',
    'aircraftCount',
    'transitionCount',
    'medianEffectDpsPerLogGainRatio',
    'signAgreement'
  ], 'the selected operating point and interval endpoints stay private');
});

test('disjoint gain or exact RPM support cannot be combined to clear k=5', () => {
  const disjointGain = [];
  for (let aircraft = 1; aircraft <= 6; aircraft += 1) {
    disjointGain.push(...effectSequence({
      firstId: 1900 + aircraft * 10,
      aircraft,
      effect: -1,
      gains: aircraft <= 3 ? [20, 40] : [400, 800]
    }));
  }
  const gainModel = buildCommunityShadowModel(disjointGain);
  assert.deepEqual(gainModel.cohorts, [],
    'six total aircraft are insufficient when no gain point has five-aircraft support');

  const disjointRpm = [];
  for (let aircraft = 1; aircraft <= 6; aircraft += 1) {
    const rpm = aircraft <= 3 ? 1950 : 2020;
    disjointRpm.push(...effectSequence({
      firstId: 2000 + aircraft * 10,
      aircraft,
      effect: -1,
      gains: [100, 200],
      headspeeds: {roll: rpm, pitch: rpm, yaw: rpm}
    }));
  }
  const rpmModel = buildCommunityShadowModel(disjointRpm);
  assert.equal(rpmModel.summary.cohortMatchedPairCount, 6,
    'both exact RPM groups intentionally occupy the same logarithmic cohort band');
  assert.deepEqual(rpmModel.cohorts, [],
    'six total aircraft are insufficient when no exact RPM point has five-aircraft support');
});

test('the endpoint sweep matches a randomized brute-force colored-rectangle oracle', () => {
  const random = deterministicRandom(0x5eed1234);
  for (let scenario = 0; scenario < 12; scenario += 1) {
    const input = [];
    const rectangles = [];
    for (let aircraft = 1; aircraft <= 6; aircraft += 1) {
      const gains = [70 + random(20), 120 + random(20), 90 + random(20)];
      const rpms = [1950 + random(20), 2000 + random(20), 1960 + random(20)];
      const aircraftEffect = aircraft;
      input.push(...effectSequence({
        firstId: 8000 + scenario * 100 + aircraft * 10,
        aircraft,
        effect: aircraftEffect,
        gains,
        headspeeds: rpms
      }));
      rectangles.push([0, 1].map(index => ({
        effect: aircraftEffect,
        gainLow: Math.min(gains[index], gains[index + 1]),
        gainHigh: Math.max(gains[index], gains[index + 1]),
        rpmLow: Math.min(rpms[index], rpms[index + 1]),
        rpmHigh: Math.max(rpms[index], rpms[index + 1])
      })));
    }

    const expected = bruteForceCommonSupport(rectangles);
    const actual = buildCommunityShadowModel(input).cohorts[0].axes.yaw.effects.I;
    assert.ok(expected.aircraftCount >= COMMUNITY_MINIMUM_AIRCRAFT_SUPPORT);
    assert.equal(actual.aircraftCount, expected.aircraftCount, `scenario ${scenario}`);
    assert.equal(actual.transitionCount, expected.transitionCount, `scenario ${scenario}`);
    assert.ok(Math.abs(actual.medianEffectDpsPerLogGainRatio - expected.medianEffect) < 1e-9,
      `scenario ${scenario}`);
  }
});

test('the endpoint sweep has a deterministic quadratic event bound at 480 aircraft', () => {
  const input = [];
  const rectangleCount = 480;
  for (let index = 0; index < rectangleCount; index += 1) {
    input.push(...effectSequence({
      firstId: 100_000 + index * 2,
      aircraft: index + 1,
      effect: -1,
      gains: [100 + index * 0.25, 400 - index * 0.25],
      headspeeds: [1950 + index * 0.05, 2020 - index * 0.05]
    }));
  }

  const {model, diagnostics} = profileCommunityShadowModel(input);
  const effect = model.cohorts[0].axes.yaw.effects.I;
  assert.equal(effect.aircraftCount, rectangleCount);
  assert.equal(effect.transitionCount, rectangleCount);
  assert.equal(diagnostics.effectTransitionRectangleCount, rectangleCount);
  assert.ok(diagnostics.effectSupportEventOperationCount
      <= 6 * rectangleCount ** 2 + 3 * rectangleCount,
  'closed-endpoint sweep work must remain quadratic, never endpoint Cartesian-cubic');
});

test('duplicate ordinals are quarantined and ordinal gaps cannot hide unobserved changes', () => {
  const input = [];
  for (let aircraft = 1; aircraft <= 5; aircraft += 1) {
    input.push(...effectSequence({
      firstId: 1700 + aircraft * 10,
      aircraft,
      effect: -1,
      gains: [100, 200]
    }));
  }

  const gainsAt = value => {
    const gains = baseGains();
    gains.yaw[1] = value;
    return gains;
  };
  input.push(
    contribution({id: 1800, aircraft: 6, ordinal: 0, gains: gainsAt(100)}),
    contribution({id: 1801, aircraft: 6, ordinal: 1, gains: gainsAt(200), errors: {yaw: 4}}),
    contribution({id: 1802, aircraft: 6, ordinal: 1, gains: gainsAt(300), errors: {yaw: 3}}),
    contribution({id: 1803, aircraft: 6, ordinal: 2, gains: gainsAt(400), errors: {yaw: 2}})
  );

  const model = buildCommunityShadowModel(input);
  assert.equal(model.exclusions.duplicateOrdinalContributionCount, 2,
    'both conflicting claimants must be removed');
  assert.equal(model.exclusions.ordinalGapPairCount, 1,
    'ordinal zero and two must not become adjacent after quarantine');
  assert.equal(model.cohorts[0].axes.yaw.effects.I.transitionCount, 5,
    'the ambiguous aircraft must add no effect');
});

test('zero-effect aircraft stay in the sign-agreement denominator', () => {
  const input = [];
  const effects = [-1, -1, -1, -1, 0];
  for (let index = 0; index < effects.length; index += 1) {
    input.push(...effectSequence({
      firstId: 1850 + index * 10,
      aircraft: index + 1,
      effect: effects[index],
      gains: [100, 200]
    }));
  }
  const agreement = buildCommunityShadowModel(input)
    .cohorts[0].axes.yaw.effects.I.signAgreement;
  assert.deepEqual(agreement, {
    agreeingAircraftCount: 4,
    evaluatedAircraftCount: 5,
    ratio: 0.8
  });
});

test('D, multi-change, unsupported, and community-guided transitions never enter effects', () => {
  const input = [];
  for (let aircraft = 1; aircraft <= 5; aircraft += 1) {
    input.push(...effectSequence({
      firstId: 2000 + aircraft * 10,
      aircraft,
      effect: -2,
      gains: [100, 200],
      term: 'P'
    }));
  }

  input.push(...effectSequence({
    firstId: 2100,
    aircraft: 6,
    effect: 1,
    gains: [10, 20],
    term: 'D'
  }));

  const multiBefore = contribution({id: 2120, aircraft: 7, ordinal: 0});
  const multiGains = baseGains();
  multiGains.roll[0] = 60;
  multiGains.yaw[1] = 120;
  const multiAfter = contribution({id: 2121, aircraft: 7, ordinal: 1, gains: multiGains});
  input.push(multiBefore, multiAfter);

  const unsupportedBefore = contribution({id: 2140, aircraft: 8, ordinal: 0});
  const unsupportedGains = baseGains();
  unsupportedGains.yaw[3] = 5;
  const unsupportedAfter = contribution({
    id: 2141,
    aircraft: 8,
    ordinal: 1,
    gains: unsupportedGains
  });
  input.push(unsupportedBefore, unsupportedAfter);

  input.push(...effectSequence({
    firstId: 2160,
    aircraft: 9,
    effect: -2,
    gains: [100, 200],
    guidance: {
      source: 'rotorlens-community',
      modelVersion: 'community-shadow-1',
      communityInfluenced: true
    }
  }));

  const model = buildCommunityShadowModel(input);
  assert.equal(model.exclusions.dTermPairCount, 1);
  assert.equal(model.exclusions.multiGainPairCount, 1);
  assert.equal(model.exclusions.unsupportedTermPairCount, 1);
  assert.equal(model.exclusions.communityGuidedTransitionCount, 1);
  assert.equal(model.cohorts[0].axes.yaw.effects.P.transitionCount, 5);
  assert.deepEqual(Object.keys(model.cohorts[0].axes.yaw.effects), ['P', 'I']);
  assert.equal(JSON.stringify(model).includes('community-shadow-1'), false,
    'the source model version must not echo into the aggregate');
});

test('evidence checks enforce RPM cohorting, captured same-kind holds, and two holds', () => {
  const input = [];
  for (let aircraft = 1; aircraft <= 5; aircraft += 1) {
    input.push(...effectSequence({
      firstId: 3000 + aircraft * 10,
      aircraft,
      effect: -1,
      gains: [100, 200]
    }));
  }

  const invalidCases = [
    {
      aircraft: 6,
      before: {},
      after: {headspeeds: {yaw: 2200}}
    },
    {
      aircraft: 7,
      before: {},
      after: {holdCounts: {yaw: 1}}
    },
    {
      aircraft: 8,
      before: {},
      after: {holdKinds: {yaw: 'sustained'}}
    },
    {
      aircraft: 9,
      before: {},
      after: {holdStatuses: {yaw: 'inconclusive'}}
    }
  ];
  let nextId = 3100;
  for (const candidate of invalidCases) {
    const beforeGains = baseGains();
    const afterGains = baseGains();
    afterGains.yaw[1] = 200;
    input.push(
      contribution({
        id: nextId,
        aircraft: candidate.aircraft,
        ordinal: 0,
        gains: beforeGains,
        ...candidate.before
      }),
      contribution({
        id: nextId + 1,
        aircraft: candidate.aircraft,
        ordinal: 1,
        gains: afterGains,
        errors: {yaw: 4},
        trial: {
          kind: 'rotorlens-controlled-v1',
          baselineContributionId: contributionId(nextId),
          intendedAxis: 'yaw',
          intendedTerm: 'I',
          intendedDirection: 'increase'
        },
        ...candidate.after
      })
    );
    nextId += 2;
  }

  const model = buildCommunityShadowModel(input);
  assert.equal(model.cohorts[0].axes.yaw.effects.I.transitionCount, 5);
  assert.equal(model.exclusions.cohortMismatchPairCount, 1);
  assert.equal(model.exclusions.headspeedPairAxisCount, 0,
    'the narrower axis-specific cohort band rejects the pair first');
  assert.equal(model.exclusions.holdCountPairAxisCount, 1);
  assert.equal(model.exclusions.holdKindPairAxisCount, 1);
  assert.equal(model.exclusions.holdCapturePairAxisCount, 1);
});

test('tiny gain moves and implausibly amplified effects are excluded', () => {
  const input = [];
  for (let aircraft = 1; aircraft <= 5; aircraft += 1) {
    input.push(...effectSequence({
      firstId: 3500 + aircraft * 10,
      aircraft,
      effect: -1,
      gains: [100, 200]
    }));
  }
  input.push(...effectSequence({
    firstId: 3600,
    aircraft: 6,
    effect: -1,
    gains: [100, 104]
  }));
  input.push(...effectSequence({
    firstId: 3620,
    aircraft: 7,
    effect: COMMUNITY_MAXIMUM_ABS_EFFECT_DPS_PER_LOG_GAIN_RATIO + 1,
    gains: [100, 106]
  }));

  const model = buildCommunityShadowModel(input);
  assert.equal(model.cohorts[0].axes.yaw.effects.I.transitionCount, 5);
  assert.equal(model.exclusions.invalidGainRatioPairCount, 1);
  assert.equal(model.exclusions.effectMagnitudePairAxisCount, 1);
});

test('the privacy floor emits neither a rare cohort key nor a rare effect', () => {
  const input = [];
  for (let aircraft = 1; aircraft < COMMUNITY_MINIMUM_AIRCRAFT_SUPPORT; aircraft += 1) {
    input.push(...effectSequence({
      firstId: 4000 + aircraft * 10,
      aircraft,
      effect: -1,
      gains: [100, 200]
    }));
  }
  const model = buildCommunityShadowModel(input);
  assert.deepEqual(model.cohorts, []);
  assert.equal(model.exclusions.privacyWithheldMetricCount, 1);
  assert.equal(model.exclusions.privacyWithheldCohortCount, 1);
  assert.equal(auditCommunityShadowModel(model).ok, true);
});

test('production rejects draft legal receipts and incomplete fingerprint coverage', () => {
  const input = [0, 1].map(ordinal => contribution({
    id: 4500 + ordinal,
    aircraft: 1,
    ordinal
  }));
  const model = buildProductionCommunityShadowModel(input);
  assert.deepEqual(model.cohorts, []);
  assert.equal(model.summary.contractValidContributionCount, 0);
  assert.equal(model.summary.modelEligibleContributionCount, 0);
  assert.equal(model.exclusions.invalidContributionCount, 2);
  assert.deepEqual(auditProductionCommunityShadowModel(model), {ok: true, violations: []});
});

test('the artifact contains no exact extrema, identities, cohort inputs, or control fields', () => {
  const input = [];
  for (let aircraft = 1; aircraft <= 5; aircraft += 1) {
    input.push(...effectSequence({
      firstId: 5000 + aircraft * 10,
      aircraft,
      effect: -1,
      gains: [80, 120]
    }));
  }
  const model = buildCommunityShadowModel(input);
  const effect = model.cohorts[0].axes.yaw.effects.I;
  const noise = model.cohorts[0].axes.yaw.noise;
  assert.equal(Object.hasOwn(effect, 'observedGainRange'), false);
  assert.equal(Object.hasOwn(effect, 'aircraftMedianEffectRangeDpsPerLogGainRatio'), false);
  assert.equal(Object.hasOwn(noise, 'aircraftMedianRangeDps'), false);

  const forbiddenKeys = /^(?:sharingId|contributionId|shareableRecord|raw|rawRecord|rawRecords|action|actions|setting|settings|gateOverride|gateOverrides|recommendedGain|targetGain|prediction|extrapolation|observedGainRange|aircraftMedianRangeDps|aircraftMedianEffectRangeDpsPerLogGainRatio)$/i;
  const visit = value => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        assert.doesNotMatch(key, forbiddenKeys, `forbidden output key ${key}`);
        visit(child);
      }
    }
  };
  visit(model);

  const text = JSON.stringify(model);
  for (const item of input) {
    assert.equal(text.includes(item.contributionId), false);
    assert.equal(text.includes(item.shareableRecord.sharingId), false);
  }
  assert.equal(text.includes('NEXUS'), false);
  assert.equal(text.includes('Rotorflight'), false);
  assert.equal(text.includes(FILTER_HASH), false);
  assert.equal(text.includes(GOVERNOR_HASH), false);
});

test('the artifact audit rejects fabricated cohort keys, impossible counts, and bad provenance', () => {
  const input = [];
  for (let aircraft = 1; aircraft <= 5; aircraft += 1) {
    input.push(...effectSequence({
      firstId: 6000 + aircraft * 10,
      aircraft,
      effect: -1,
      gains: [80, 120]
    }));
  }
  const model = buildCommunityShadowModel(input);
  const copy = () => JSON.parse(JSON.stringify(model));

  const missingCount = copy();
  missingCount.cohorts[0].axes.yaw.effects.I.transitionCount = null;
  assert.equal(auditCommunityShadowModel(missingCount).ok, false);

  const leakedRange = copy();
  leakedRange.cohorts[0].axes.yaw.effects.I.observedGainRange = {minimum: 80, maximum: 120};
  assert.equal(auditCommunityShadowModel(leakedRange).ok, false);

  const wrongRatio = copy();
  wrongRatio.cohorts[0].axes.yaw.effects.I.signAgreement.ratio = 0.25;
  assert.equal(auditCommunityShadowModel(wrongRatio).ok, false);

  const unsafeCount = copy();
  unsafeCount.cohorts[0].axes.yaw.effects.I.aircraftCount = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(auditCommunityShadowModel(unsafeCount).ok, false);

  const hiddenContributionId = copy();
  hiddenContributionId.cohorts[0].cohortKey =
    `hmac-sha256:${'A'.repeat(43)}`;
  assert.equal(auditCommunityShadowModel(hiddenContributionId).ok, false);

  const fabricatedName = copy();
  fabricatedName.cohorts[0].cohortKey = 'Jane%20Doe';
  assert.equal(auditCommunityShadowModel(fabricatedName).ok, false);

  const wrongAnonymousOrdinal = copy();
  wrongAnonymousOrdinal.cohorts[0].cohortKey = 'shadow-cohort-000999';
  assert.equal(auditCommunityShadowModel(wrongAnonymousOrdinal).ok, false);

  const nestedUnknown = copy();
  nestedUnknown.cohorts[0].axes.yaw.effects.I.prediction = 42;
  assert.equal(auditCommunityShadowModel(nestedUnknown).ok, false);

  const impossibleSummary = copy();
  impossibleSummary.summary.contractValidContributionCount =
    impossibleSummary.summary.inputContributionCount + 1;
  assert.equal(auditCommunityShadowModel(impossibleSummary).ok, false);

  const wrongPublishedCount = copy();
  wrongPublishedCount.summary.publishedAircraftCount += 1;
  assert.equal(auditCommunityShadowModel(wrongPublishedCount).ok, false);

  const forgedCrossTotals = copy();
  assert.equal(forgedCrossTotals.summary.deduplicatedContributionCount, 10);
  forgedCrossTotals.cohorts[0].aircraftCount = 100;
  forgedCrossTotals.cohorts[0].flightCount = 105;
  forgedCrossTotals.summary.publishedAircraftCount = 100;
  const forgedAudit = auditCommunityShadowModel(forgedCrossTotals);
  assert.equal(forgedAudit.ok, false);
  assert.equal(forgedAudit.violations.filter(entry =>
    entry.path === 'summary.deduplicatedContributionCount').length, 2,
    'both published aircraft and flight totals must be bounded by deduplicated input');

  const impossiblePairCapacity = copy();
  impossiblePairCapacity.cohorts[0].adjacentPairCount =
    impossiblePairCapacity.cohorts[0].flightCount
      - impossiblePairCapacity.cohorts[0].aircraftCount + 1;
  assert.equal(auditCommunityShadowModel(impossiblePairCapacity).ok, false);

  const excessiveMetricAircraft = copy();
  excessiveMetricAircraft.cohorts[0].axes.yaw.effects.I.aircraftCount =
    excessiveMetricAircraft.cohorts[0].aircraftCount + 1;
  excessiveMetricAircraft.cohorts[0].axes.yaw.effects.I.signAgreement.evaluatedAircraftCount =
    excessiveMetricAircraft.cohorts[0].aircraftCount + 1;
  assert.equal(auditCommunityShadowModel(excessiveMetricAircraft).ok, false);

  const excessiveMetricPairs = copy();
  excessiveMetricPairs.cohorts[0].axes.yaw.effects.I.transitionCount =
    excessiveMetricPairs.cohorts[0].adjacentPairCount + 1;
  assert.equal(auditCommunityShadowModel(excessiveMetricPairs).ok, false);

  const noiseInput = [];
  for (let aircraft = 20; aircraft <= 24; aircraft += 1) {
    noiseInput.push(...nullSequence({
      firstId: 7000 + aircraft * 10,
      aircraft,
      errors: [0, 1]
    }));
  }
  const excessiveNoisePairs = JSON.parse(JSON.stringify(
    buildCommunityShadowModel(noiseInput)
  ));
  excessiveNoisePairs.cohorts[0].axes.yaw.noise.pairCount =
    excessiveNoisePairs.cohorts[0].adjacentPairCount + 1;
  assert.equal(auditCommunityShadowModel(excessiveNoisePairs).ok, false);

  const brokenSummaryEquation = copy();
  brokenSummaryEquation.exclusions.invalidContributionCount += 1;
  assert.equal(auditCommunityShadowModel(brokenSummaryEquation).ok, false);

  const untrustedBoundary = copy();
  untrustedBoundary.trustBoundary = 'untrusted-public-upload';
  assert.equal(auditCommunityShadowModel(untrustedBoundary).ok, false);

  const excessiveEffect = copy();
  excessiveEffect.cohorts[0].axes.yaw.effects.I.medianEffectDpsPerLogGainRatio =
    COMMUNITY_MAXIMUM_ABS_EFFECT_DPS_PER_LOG_GAIN_RATIO + 1;
  assert.equal(auditCommunityShadowModel(excessiveEffect).ok, false);
});
