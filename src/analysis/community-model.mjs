/**
 * Deterministic, aircraft-balanced community measurements.
 *
 * This module deliberately stops at a shadow artifact. It does not produce a
 * setting, an instruction, a gate override, or anything the app can execute.
 * Its only input is the narrow contribution contract, and its only output is
 * aggregate evidence that can be inspected offline. P/I effects additionally
 * require a declared controlled trial linked to the exact baseline envelope,
 * explicit non-community ancestry, and a common gain/RPM support point.
 */

import {
  COMMUNITY_CONTROLLED_TRIAL_KIND,
  COMMUNITY_CONTRIBUTION_KIND,
  COMMUNITY_CONTRIBUTION_SCHEMA_VERSION,
  COMMUNITY_COHORT_VERSION,
  COMMUNITY_EXTRACTOR_VERSION,
  auditCommunityContribution,
  buildCommunityCohortKey
} from './community-contract.mjs';

export const COMMUNITY_SHADOW_MODEL_KIND = 'rotorlens-community-shadow-model';
export const COMMUNITY_SHADOW_MODEL_SCHEMA_VERSION = 1;
export const COMMUNITY_SHADOW_MODEL_MODE = 'shadow';
export const COMMUNITY_SHADOW_MODEL_TRUST_BOUNDARY = 'licensed-manual-corpus';
export const COMMUNITY_EFFECT_SUPPORT_KIND = 'common-gain-rpm-rectangle-v1';
export const COMMUNITY_FIXTURE_MODEL_KIND = 'rotorlens-community-shadow-model-fixture';
export const COMMUNITY_FIXTURE_MODEL_MODE = 'test-fixture';
export const COMMUNITY_FIXTURE_TRUST_BOUNDARY = 'test-only-prevalidated-fixtures';

/** No rare cohort key or cohort-derived value is emitted below this support. */
export const COMMUNITY_MINIMUM_AIRCRAFT_SUPPORT = 5;
/** Smaller gain movements are too noise-sensitive for effect fitting. */
export const COMMUNITY_MINIMUM_ABS_LOG_GAIN_RATIO = Math.log(1.05);
/** Defensive ceiling for a finite but implausibly amplified response. */
export const COMMUNITY_MAXIMUM_ABS_EFFECT_DPS_PER_LOG_GAIN_RATIO = 1_000_000;

const AXES = Object.freeze(['roll', 'pitch', 'yaw']);
const TERMS = Object.freeze(['P', 'I']);
const TERM_INDEX = Object.freeze({P: 0, I: 1, D: 2});
const TRUSTED_GUIDANCE_SOURCES = Object.freeze(new Set(['manual', 'rotorlens-local']));
const MAXIMUM_HEADSPEED_DELTA_RATIO = 0.05;
const MINIMUM_HOLDS_PER_FLIGHT = 2;
const RESPONSE_FIELD = 'meanAbsoluteSteadyStateErrorDps';
const ANONYMOUS_COHORT_PATTERN = /^shadow-cohort-[0-9]{6}$/;
const FIXTURE_COHORT_KEY_PATTERN =
  /^prevalidated-fixture-cohort-v1:[A-Za-z0-9._|:-]{1,512}$/;
const FIXTURE_ENTRY_KEYS = Object.freeze(['contribution', 'cohortKey']);
const FIXTURE_EXPECTED_VIOLATION_CODES = Object.freeze(new Set([
  'CONSENT_VERSION_NOT_ADOPTED',
  'LICENCE_VERSION_NOT_ADOPTED'
]));
const FIXTURE_ALLOWED_VIOLATION_CODES = Object.freeze(new Set([
  ...FIXTURE_EXPECTED_VIOLATION_CODES,
  'COMMUNITY_GUIDANCE_MODEL_VERSION_UNSUPPORTED'
]));
const FIXTURE_ALLOWED_AUDIT_CODES = Object.freeze(new Set([
  ...FIXTURE_ALLOWED_VIOLATION_CODES,
  'CONFIG_FINGERPRINT_SCHEMA_INCOMPLETE'
]));
const MAXIMUM_PUBLISHED_COHORTS = 999_999;

const SUMMARY_KEYS = Object.freeze([
  'inputContributionCount',
  'contractValidContributionCount',
  'modelEligibleContributionCount',
  'deduplicatedContributionCount',
  'publishedCohortCount',
  'publishedAircraftCount',
  'adjacentPairCount',
  'cohortMatchedPairCount'
]);

const EXCLUSION_KEYS = Object.freeze([
  'invalidContributionCount',
  'nonCohortContributionCount',
  'nonClearAirframeContributionCount',
  'duplicateContributionIdCount',
  'conflictingContributionIdCount',
  'duplicateOrdinalContributionCount',
  'nonIncreasingOrdinalPairCount',
  'ordinalGapPairCount',
  'cohortMismatchPairCount',
  'firmwareMismatchPairCount',
  'ratesMismatchPairCount',
  'unreadableGainPairCount',
  'dTermPairCount',
  'multiGainPairCount',
  'unsupportedTermPairCount',
  'uncontrolledTransitionCount',
  'trialMismatchTransitionCount',
  'unknownGuidanceTransitionCount',
  'unknownGuidanceAncestryTransitionCount',
  'communityInfluencedTransitionCount',
  'communityGuidedTransitionCount',
  'invalidGainRatioPairCount',
  'effectMagnitudePairAxisCount',
  'headspeedPairAxisCount',
  'holdCapturePairAxisCount',
  'holdCountPairAxisCount',
  'holdKindPairAxisCount',
  'responseMetricPairAxisCount',
  'privacyWithheldMetricCount',
  'privacyWithheldCohortCount'
]);

const ROOT_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'mode',
  'trustBoundary',
  'contract',
  'summary',
  'exclusions',
  'cohorts'
]);
const CONTRACT_KEYS = Object.freeze([
  'contributionKind',
  'contributionSchemaVersion',
  'cohortVersion',
  'extractorVersion',
  'minimumAircraftSupport',
  'controlledTrialKind',
  'effectSupportKind',
  'minimumAbsLogGainRatio',
  'maximumAbsEffectDpsPerLogGainRatio'
]);
const COHORT_KEYS = Object.freeze([
  'cohortKey',
  'aircraftCount',
  'flightCount',
  'adjacentPairCount',
  'axes'
]);
const AXIS_KEYS = Object.freeze(['noise', 'effects']);
const NOISE_KEYS = Object.freeze([
  'state',
  'aircraftCount',
  'pairCount',
  'medianAbsoluteDeltaDps'
]);
const EFFECT_KEYS = Object.freeze([
  'state',
  'aircraftCount',
  'transitionCount',
  'medianEffectDpsPerLogGainRatio',
  'signAgreement'
]);
const AGREEMENT_KEYS = Object.freeze([
  'agreeingAircraftCount',
  'evaluatedAircraftCount',
  'ratio'
]);

function emptyCounts(keys) {
  return Object.fromEntries(keys.map(key => [key, 0]));
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort(compareText).map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rounded(value, places = 9) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function sharingIdOf(contribution) {
  return contribution?.shareableRecord?.sharingId ?? null;
}

function recordOf(contribution) {
  return contribution?.shareableRecord ?? null;
}

function ordinalOf(contribution) {
  return recordOf(contribution)?.ordinal;
}

function firmwareOf(contribution) {
  return recordOf(contribution)?.firmwareRevision;
}

function ratesOf(contribution) {
  return recordOf(contribution)?.ratesFingerprint;
}

function holdKind(hold) {
  const zero = hold?.zeroHoldCount;
  const sustained = hold?.sustainedHoldCount;
  if (!Number.isFinite(zero) || !Number.isFinite(sustained)) {
    return null;
  }
  if (zero > 0 && sustained === 0) {
    return 'zero';
  }
  if (sustained > 0 && zero === 0) {
    return 'sustained';
  }
  return null;
}

function headspeedsComparable(before, after, axis) {
  const left = recordOf(before)?.axes?.[axis]?.headspeedMedianRpm;
  const right = recordOf(after)?.axes?.[axis]?.headspeedMedianRpm;
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return false;
  }
  const largest = Math.max(Math.abs(left), Math.abs(right));
  return largest > 0
    && Math.abs(right - left) / largest <= MAXIMUM_HEADSPEED_DELTA_RATIO;
}

function comparableResponse(before, after, axis, exclusions) {
  if (!headspeedsComparable(before, after, axis)) {
    exclusions.headspeedPairAxisCount += 1;
    return null;
  }

  const left = recordOf(before)?.axes?.[axis]?.hold;
  const right = recordOf(after)?.axes?.[axis]?.hold;
  if (left?.status !== 'captured' || right?.status !== 'captured') {
    exclusions.holdCapturePairAxisCount += 1;
    return null;
  }
  if (!(left.holdCount >= MINIMUM_HOLDS_PER_FLIGHT)
      || !(right.holdCount >= MINIMUM_HOLDS_PER_FLIGHT)) {
    exclusions.holdCountPairAxisCount += 1;
    return null;
  }
  const leftKind = holdKind(left);
  const rightKind = holdKind(right);
  if (leftKind === null || leftKind !== rightKind) {
    exclusions.holdKindPairAxisCount += 1;
    return null;
  }
  const leftMetric = left[RESPONSE_FIELD];
  const rightMetric = right[RESPONSE_FIELD];
  if (!Number.isFinite(leftMetric) || leftMetric < 0
      || !Number.isFinite(rightMetric) || rightMetric < 0) {
    exclusions.responseMetricPairAxisCount += 1;
    return null;
  }
  return {leftMetric, rightMetric};
}

function gainChanges(before, after) {
  const changes = [];
  for (const axis of AXES) {
    const left = recordOf(before)?.gains?.[axis];
    const right = recordOf(after)?.gains?.[axis];
    if (!Array.isArray(left) || !Array.isArray(right)
        || left.length < 3 || left.length !== right.length
        || !left.every(Number.isFinite) || !right.every(Number.isFinite)) {
      return null;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) {
        changes.push({axis, index, from: left[index], to: right[index]});
      }
    }
  }
  return changes;
}

function newAircraftAggregate() {
  const noise = {};
  const effects = {};
  for (const axis of AXES) {
    noise[axis] = [];
    effects[axis] = {P: [], I: []};
  }
  return {noise, effects};
}

function withheldNoise() {
  return {
    state: 'withheld',
    aircraftCount: null,
    pairCount: null,
    medianAbsoluteDeltaDps: null
  };
}

function withheldEffect() {
  return {
    state: 'withheld',
    aircraftCount: null,
    transitionCount: null,
    medianEffectDpsPerLogGainRatio: null,
    signAgreement: {
      agreeingAircraftCount: null,
      evaluatedAircraftCount: null,
      ratio: null
    }
  };
}

function aggregateNoise(aircraft, axis, exclusions) {
  const supported = [];
  let pairCount = 0;
  for (const value of aircraft.values()) {
    const observations = value.noise[axis];
    if (observations.length > 0) {
      supported.push(median(observations));
      pairCount += observations.length;
    }
  }
  if (supported.length < COMMUNITY_MINIMUM_AIRCRAFT_SUPPORT) {
    if (supported.length > 0) {
      exclusions.privacyWithheldMetricCount += 1;
    }
    return withheldNoise();
  }
  return {
    state: 'available',
    aircraftCount: supported.length,
    pairCount,
    medianAbsoluteDeltaDps: rounded(median(supported))
  };
}

function signOf(value) {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

function intervalContains(minimum, maximum, point) {
  return minimum <= point && point <= maximum;
}

function eventBucket(events, point) {
  let bucket = events.get(point);
  if (bucket === undefined) {
    bucket = {starts: [], ends: []};
    events.set(point, bucket);
  }
  return bucket;
}

function bestRpmSupport(activeRectangles, aircraftCount, diagnostics) {
  const events = new Map();
  for (const rectangle of activeRectangles) {
    eventBucket(events, rectangle.transition.rpmLow).starts.push(rectangle.aircraftIndex);
    eventBucket(events, rectangle.transition.rpmHigh).ends.push(rectangle.aircraftIndex);
    diagnostics.effectSupportEventOperationCount += 1;
  }

  const activeByAircraft = new Uint32Array(aircraftCount);
  let support = 0;
  let bestSupport = 0;
  let bestRpm = null;
  const orderedRpms = [...events.keys()].sort((left, right) => left - right);
  for (const rpm of orderedRpms) {
    const bucket = events.get(rpm);
    // Starts precede evaluation and ends follow it because every transition
    // rectangle is closed at both RPM endpoints.
    for (const aircraftIndex of bucket.starts) {
      if (activeByAircraft[aircraftIndex] === 0) {
        support += 1;
      }
      activeByAircraft[aircraftIndex] += 1;
      diagnostics.effectSupportEventOperationCount += 1;
    }
    if (support > bestSupport) {
      bestSupport = support;
      bestRpm = rpm;
    }
    for (const aircraftIndex of bucket.ends) {
      activeByAircraft[aircraftIndex] -= 1;
      if (activeByAircraft[aircraftIndex] === 0) {
        support -= 1;
      }
      diagnostics.effectSupportEventOperationCount += 1;
    }
  }
  return {aircraftCount: bestSupport, rpm: bestRpm};
}

function commonOperatingSupport(aircraft, axis, term, diagnostics) {
  const rectangles = [];
  const gainEvents = new Map();
  let aircraftIndex = 0;
  for (const value of aircraft.values()) {
    for (const transition of value.effects[axis][term]) {
      const rectangle = {aircraftIndex, transition};
      rectangles.push(rectangle);
      eventBucket(gainEvents, transition.gainLow).starts.push(rectangle);
      eventBucket(gainEvents, transition.gainHigh).ends.push(rectangle);
    }
    aircraftIndex += 1;
  }
  diagnostics.effectTransitionRectangleCount += rectangles.length;

  const activeRectangles = new Set();
  let best = {aircraftCount: 0, gain: null, rpm: null};
  const orderedGains = [...gainEvents.keys()].sort((left, right) => left - right);
  for (const gain of orderedGains) {
    const bucket = gainEvents.get(gain);
    // As with RPM, starts precede evaluation and ends follow it so rectangles
    // remain active at both closed gain endpoints.
    for (const rectangle of bucket.starts) {
      activeRectangles.add(rectangle);
      diagnostics.effectSupportEventOperationCount += 1;
    }
    const rpmSupport = bestRpmSupport(activeRectangles, aircraft.size, diagnostics);
    if (rpmSupport.aircraftCount > best.aircraftCount) {
      best = {aircraftCount: rpmSupport.aircraftCount, gain, rpm: rpmSupport.rpm};
    }
    for (const rectangle of bucket.ends) {
      activeRectangles.delete(rectangle);
      diagnostics.effectSupportEventOperationCount += 1;
    }
  }

  const matches = [];
  if (best.gain !== null && best.rpm !== null) {
    for (const value of aircraft.values()) {
      const transitions = value.effects[axis][term].filter(transition =>
        intervalContains(transition.gainLow, transition.gainHigh, best.gain)
          && intervalContains(transition.rpmLow, transition.rpmHigh, best.rpm));
      diagnostics.effectSupportEventOperationCount += value.effects[axis][term].length;
      if (transitions.length > 0) {
        matches.push(transitions);
      }
    }
  }
  return {aircraftCount: best.aircraftCount, matches};
}

function aggregateEffect(aircraft, axis, term, exclusions, diagnostics) {
  const support = commonOperatingSupport(aircraft, axis, term, diagnostics);

  if (support.aircraftCount < COMMUNITY_MINIMUM_AIRCRAFT_SUPPORT) {
    if (support.aircraftCount > 0) {
      exclusions.privacyWithheldMetricCount += 1;
    }
    return withheldEffect();
  }

  const aircraftEffects = support.matches.map(transitions =>
    median(transitions.map(transition => transition.effect)));
  const transitionCount = support.matches.reduce((sum, transitions) =>
    sum + transitions.length, 0);

  const cohortMedian = median(aircraftEffects);
  const cohortSign = signOf(cohortMedian);
  // Zero effects remain in the denominator as disagreement. Dropping them
  // would turn four agreeing aircraft plus one neutral aircraft into 100%.
  const evaluated = aircraftEffects;
  const agreeing = cohortSign === 0
    ? 0
    : evaluated.filter(value => signOf(value) === cohortSign).length;

  return {
    state: 'available',
    aircraftCount: aircraftEffects.length,
    transitionCount,
    medianEffectDpsPerLogGainRatio: rounded(cohortMedian),
    signAgreement: {
      agreeingAircraftCount: agreeing,
      evaluatedAircraftCount: evaluated.length,
      ratio: evaluated.length === 0 ? null : rounded(agreeing / evaluated.length)
    }
  };
}

function publishCohort(group, anonymousCohortKey, exclusions, diagnostics) {
  const axes = {};
  let availableMetricCount = 0;
  for (const axis of AXES) {
    const noise = aggregateNoise(group.aircraft, axis, exclusions);
    const effects = {};
    if (noise.state === 'available') {
      availableMetricCount += 1;
    }
    for (const term of TERMS) {
      effects[term] = aggregateEffect(group.aircraft, axis, term, exclusions, diagnostics);
      if (effects[term].state === 'available') {
        availableMetricCount += 1;
      }
    }
    axes[axis] = {noise, effects};
  }

  if (availableMetricCount === 0) {
    exclusions.privacyWithheldCohortCount += 1;
    return null;
  }
  return {
    cohortKey: anonymousCohortKey,
    aircraftCount: group.aircraft.size,
    flightCount: group.flightCount,
    adjacentPairCount: group.adjacentPairCount,
    axes
  };
}

function guidanceAcceptedForEffect(before, after, exclusions) {
  const guidance = [before?.guidance, after?.guidance];
  const sources = guidance.map(value => value?.source);
  if (sources.includes('rotorlens-community')) {
    exclusions.communityGuidedTransitionCount += 1;
    return false;
  }
  if (!sources.every(source => TRUSTED_GUIDANCE_SOURCES.has(source))) {
    exclusions.unknownGuidanceTransitionCount += 1;
    return false;
  }
  const ancestry = guidance.map(value => value?.communityInfluenced);
  if (ancestry.includes(true)) {
    exclusions.communityInfluencedTransitionCount += 1;
    return false;
  }
  if (!ancestry.every(value => value === false)) {
    exclusions.unknownGuidanceAncestryTransitionCount += 1;
    return false;
  }
  return true;
}

function trialMatchesChange(before, after, change, term, exclusions) {
  const trial = after?.trial;
  if (trial?.kind !== COMMUNITY_CONTROLLED_TRIAL_KIND) {
    exclusions.uncontrolledTransitionCount += 1;
    return false;
  }
  const direction = change.to > change.from ? 'increase' : 'decrease';
  if (trial.baselineContributionId !== before?.contributionId
      || trial.intendedAxis !== change.axis
      || trial.intendedTerm !== term
      || trial.intendedDirection !== direction) {
    exclusions.trialMismatchTransitionCount += 1;
    return false;
  }
  return true;
}

function addPair(group, sharingId, before, after, exclusions) {
  group.adjacentPairCount += 1;

  if (!(ordinalOf(after) > ordinalOf(before))) {
    exclusions.nonIncreasingOrdinalPairCount += 1;
    return;
  }
  if (firmwareOf(before) !== firmwareOf(after)) {
    exclusions.firmwareMismatchPairCount += 1;
    return;
  }
  if (ratesOf(before) !== ratesOf(after)) {
    exclusions.ratesMismatchPairCount += 1;
    return;
  }

  const changes = gainChanges(before, after);
  if (changes === null) {
    exclusions.unreadableGainPairCount += 1;
    return;
  }

  const aircraft = group.aircraft.get(sharingId);
  if (changes.length === 0) {
    for (const axis of AXES) {
      const response = comparableResponse(before, after, axis, exclusions);
      if (response !== null) {
        aircraft.noise[axis].push(Math.abs(response.rightMetric - response.leftMetric));
      }
    }
    return;
  }
  if (changes.length > 1) {
    exclusions.multiGainPairCount += 1;
    return;
  }

  const change = changes[0];
  if (change.index === TERM_INDEX.D) {
    exclusions.dTermPairCount += 1;
    return;
  }
  const term = TERMS.find(candidate => TERM_INDEX[candidate] === change.index);
  if (term === undefined) {
    exclusions.unsupportedTermPairCount += 1;
    return;
  }
  if (!trialMatchesChange(before, after, change, term, exclusions)) {
    return;
  }
  if (!guidanceAcceptedForEffect(before, after, exclusions)) {
    return;
  }
  if (!(change.from > 0) || !(change.to > 0)) {
    exclusions.invalidGainRatioPairCount += 1;
    return;
  }
  const logGainRatio = Math.log(change.to / change.from);
  if (!Number.isFinite(logGainRatio)
      || Math.abs(logGainRatio) < COMMUNITY_MINIMUM_ABS_LOG_GAIN_RATIO) {
    exclusions.invalidGainRatioPairCount += 1;
    return;
  }
  const response = comparableResponse(before, after, change.axis, exclusions);
  if (response === null) {
    return;
  }
  const effect = (response.rightMetric - response.leftMetric) / logGainRatio;
  if (!Number.isFinite(effect)
      || Math.abs(effect) > COMMUNITY_MAXIMUM_ABS_EFFECT_DPS_PER_LOG_GAIN_RATIO) {
    exclusions.effectMagnitudePairAxisCount += 1;
    return;
  }
  const beforeRpm = recordOf(before).axes[change.axis].headspeedMedianRpm;
  const afterRpm = recordOf(after).axes[change.axis].headspeedMedianRpm;
  aircraft.effects[change.axis][term].push({
    effect,
    gainLow: Math.min(change.from, change.to),
    gainHigh: Math.max(change.from, change.to),
    rpmLow: Math.min(beforeRpm, afterRpm),
    rpmHigh: Math.max(beforeRpm, afterRpm)
  });
}

function eligibleContributions(contributions, summary, exclusions) {
  const candidates = [];
  for (const contribution of contributions) {
    let audit = null;
    let cohortKey = null;
    try {
      audit = auditCommunityContribution(contribution);
      cohortKey = buildCommunityCohortKey(contribution);
    } catch {
      audit = null;
    }
    if (audit?.ok !== true) {
      exclusions.invalidContributionCount += 1;
      continue;
    }
    summary.contractValidContributionCount += 1;
    if (audit.adviceEligible !== true || typeof cohortKey !== 'string' || cohortKey === '') {
      exclusions.nonCohortContributionCount += 1;
      if ((audit.codes ?? []).some(code => typeof code === 'string'
          && code.startsWith('AIRFRAME_SAFETY_'))) {
        exclusions.nonClearAirframeContributionCount += 1;
      }
      continue;
    }
    summary.modelEligibleContributionCount += 1;
    candidates.push({
      contribution,
      contributionId: contribution.contributionId,
      cohortKey,
      canonical: canonicalJson(contribution)
    });
  }

  return deduplicateCandidates(candidates, summary, exclusions);
}

function fixtureEligibleContributions(entries, summary, exclusions) {
  const candidates = [];
  for (const entry of entries) {
    let audit = null;
    try {
      audit = auditCommunityContribution(entry?.contribution);
    } catch {
      audit = null;
    }
    const entryKeys = isPlainObject(entry) ? Object.keys(entry) : [];
    const fixedEntry = entryKeys.length === FIXTURE_ENTRY_KEYS.length
      && FIXTURE_ENTRY_KEYS.every(key => Object.hasOwn(entry, key));
    const violationCodes = new Set((audit?.violations ?? []).map(value => value?.code));
    const auditCodes = audit?.codes ?? [];
    const expectedDraftOnly = audit !== null
      && [...FIXTURE_EXPECTED_VIOLATION_CODES].every(code => violationCodes.has(code))
      && (audit.violations ?? []).every(value =>
        FIXTURE_ALLOWED_VIOLATION_CODES.has(value?.code))
      && auditCodes.every(code => FIXTURE_ALLOWED_AUDIT_CODES.has(code))
      && auditCodes.includes('CONFIG_FINGERPRINT_SCHEMA_INCOMPLETE');
    const cohortKey = entry?.cohortKey;
    if (!fixedEntry || !expectedDraftOnly
        || typeof cohortKey !== 'string' || !FIXTURE_COHORT_KEY_PATTERN.test(cohortKey)) {
      exclusions.invalidContributionCount += 1;
      continue;
    }

    const contribution = entry.contribution;
    summary.contractValidContributionCount += 1;
    summary.modelEligibleContributionCount += 1;
    candidates.push({
      contribution,
      contributionId: contribution.contributionId,
      cohortKey,
      canonical: canonicalJson(contribution)
    });
  }
  return deduplicateCandidates(candidates, summary, exclusions);
}

function deduplicateCandidates(candidates, summary, exclusions) {

  candidates.sort((left, right) =>
    compareText(left.contributionId, right.contributionId)
      || compareText(left.canonical, right.canonical));

  const deduplicated = [];
  for (let index = 0; index < candidates.length;) {
    const first = candidates[index];
    let end = index + 1;
    while (end < candidates.length
        && candidates[end].contributionId === first.contributionId) {
      end += 1;
    }
    const sameId = candidates.slice(index, end);
    exclusions.duplicateContributionIdCount += sameId.length - 1;
    const payloads = new Set(sameId.map(entry => entry.canonical));
    if (payloads.size === 1) {
      deduplicated.push(first);
    } else {
      exclusions.conflictingContributionIdCount += 1;
    }
    index = end;
  }
  summary.deduplicatedContributionCount = deduplicated.length;
  return deduplicated;
}

/**
 * Builds an offline shadow artifact from contract-valid contributions.
 *
 * Each aircraft first collapses its own transitions to a median; only those
 * aircraft medians reach a cohort median. A machine with a thousand flights
 * therefore has the same cohort weight as a machine with one usable pair. The
 * result is explicitly limited to a licensed, manually curated corpus.
 */
function buildCommunityShadowModelInternal(contributions, diagnostics, {fixture = false} = {}) {
  if (!Array.isArray(contributions)) {
    throw new TypeError('community contributions must be an array');
  }
  const input = contributions;
  const summary = emptyCounts(SUMMARY_KEYS);
  const exclusions = emptyCounts(EXCLUSION_KEYS);
  summary.inputContributionCount = input.length;

  const deduplicated = fixture
    ? fixtureEligibleContributions(input, summary, exclusions)
    : eligibleContributions(input, summary, exclusions);
  const groups = new Map();
  const aircraftFlights = new Map();
  for (const entry of deduplicated) {
    const sharingId = sharingIdOf(entry.contribution);
    let group = groups.get(entry.cohortKey);
    if (!group) {
      group = {
        cohortKey: entry.cohortKey,
        flightCount: 0,
        adjacentPairCount: 0,
        aircraft: new Map()
      };
      groups.set(entry.cohortKey, group);
    }
    if (!group.aircraft.has(sharingId)) {
      group.aircraft.set(sharingId, newAircraftAggregate());
    }
    group.flightCount += 1;
    if (!aircraftFlights.has(sharingId)) {
      aircraftFlights.set(sharingId, []);
    }
    aircraftFlights.get(sharingId).push(entry);
  }

  for (const [sharingId, entries] of aircraftFlights) {
    entries.sort((left, right) =>
      (ordinalOf(left.contribution) - ordinalOf(right.contribution))
        || compareText(left.contributionId, right.contributionId)
        || compareText(left.canonical, right.canonical));

    // Two different accepted envelopes claiming the same aircraft ordinal make
    // that point ambiguous. Quarantine every claimant instead of choosing the
    // lexicographically convenient payload and letting an id decide the data.
    const ordinalCounts = new Map();
    for (const entry of entries) {
      const ordinal = ordinalOf(entry.contribution);
      ordinalCounts.set(ordinal, (ordinalCounts.get(ordinal) ?? 0) + 1);
    }
    const unambiguous = entries.filter(entry => {
      const unique = ordinalCounts.get(ordinalOf(entry.contribution)) === 1;
      if (!unique) {
        exclusions.duplicateOrdinalContributionCount += 1;
      }
      return unique;
    });

    for (let index = 1; index < unambiguous.length; index += 1) {
      summary.adjacentPairCount += 1;
      const before = unambiguous[index - 1];
      const after = unambiguous[index];
      const beforeOrdinal = ordinalOf(before.contribution);
      const afterOrdinal = ordinalOf(after.contribution);
      if (!(afterOrdinal > beforeOrdinal)) {
        exclusions.nonIncreasingOrdinalPairCount += 1;
        continue;
      }
      if (afterOrdinal !== beforeOrdinal + 1) {
        exclusions.ordinalGapPairCount += 1;
        continue;
      }
      if (before.cohortKey !== after.cohortKey) {
        exclusions.cohortMismatchPairCount += 1;
        continue;
      }
      const group = groups.get(before.cohortKey);
      summary.cohortMatchedPairCount += 1;
      addPair(group, sharingId, before.contribution, after.contribution, exclusions);
    }
  }

  const cohorts = [];
  const orderedGroups = [...groups.values()]
    .sort((left, right) => compareText(left.cohortKey, right.cohortKey));
  for (const group of orderedGroups) {
    const ordinal = cohorts.length + 1;
    if (ordinal > MAXIMUM_PUBLISHED_COHORTS) {
      throw new RangeError('too many privacy-cleared shadow cohorts');
    }
    const anonymousCohortKey = `shadow-cohort-${String(ordinal).padStart(6, '0')}`;
    const published = publishCohort(group, anonymousCohortKey, exclusions, diagnostics);
    if (published !== null) {
      cohorts.push(published);
      summary.publishedAircraftCount += published.aircraftCount;
    }
  }
  summary.publishedCohortCount = cohorts.length;

  return deepFreeze({
    schemaVersion: COMMUNITY_SHADOW_MODEL_SCHEMA_VERSION,
    kind: fixture ? COMMUNITY_FIXTURE_MODEL_KIND : COMMUNITY_SHADOW_MODEL_KIND,
    mode: fixture ? COMMUNITY_FIXTURE_MODEL_MODE : COMMUNITY_SHADOW_MODEL_MODE,
    trustBoundary: fixture
      ? COMMUNITY_FIXTURE_TRUST_BOUNDARY
      : COMMUNITY_SHADOW_MODEL_TRUST_BOUNDARY,
    contract: {
      contributionKind: COMMUNITY_CONTRIBUTION_KIND,
      contributionSchemaVersion: COMMUNITY_CONTRIBUTION_SCHEMA_VERSION,
      cohortVersion: COMMUNITY_COHORT_VERSION,
      extractorVersion: COMMUNITY_EXTRACTOR_VERSION,
      minimumAircraftSupport: COMMUNITY_MINIMUM_AIRCRAFT_SUPPORT,
      controlledTrialKind: COMMUNITY_CONTROLLED_TRIAL_KIND,
      effectSupportKind: COMMUNITY_EFFECT_SUPPORT_KIND,
      minimumAbsLogGainRatio: rounded(COMMUNITY_MINIMUM_ABS_LOG_GAIN_RATIO, 12),
      maximumAbsEffectDpsPerLogGainRatio:
        COMMUNITY_MAXIMUM_ABS_EFFECT_DPS_PER_LOG_GAIN_RATIO
    },
    summary,
    exclusions,
    cohorts
  });
}

/** Builds the production shadow artifact without exposing internal search data. */
export function buildCommunityShadowModel(contributions = []) {
  return buildCommunityShadowModelInternal(contributions, {
    effectSupportEventOperationCount: 0,
    effectTransitionRectangleCount: 0
  });
}

/**
 * Offline profiler for deterministic complexity regression tests. Diagnostics
 * are returned beside, never embedded in, the privacy-reviewed artifact.
 */
export function profileCommunityShadowModel(contributions = []) {
  const diagnostics = {
    effectSupportEventOperationCount: 0,
    effectTransitionRectangleCount: 0
  };
  const model = buildCommunityShadowModelInternal(contributions, diagnostics);
  return deepFreeze({model, diagnostics: {...diagnostics}});
}

/**
 * Test-only seam for otherwise valid draft contributions whose cohort key was
 * independently prevalidated. Its distinct kind, mode and trust boundary are
 * rejected by the production artifact audit and are never used by the CLI.
 */
export function buildCommunityShadowModelForPrevalidatedFixtures(entries = []) {
  return buildCommunityShadowModelInternal(entries, {
    effectSupportEventOperationCount: 0,
    effectTransitionRectangleCount: 0
  }, {fixture: true});
}

/** Complexity profiler paired only with the rejected test-fixture artifact. */
export function profileCommunityShadowModelForPrevalidatedFixtures(entries = []) {
  const diagnostics = {
    effectSupportEventOperationCount: 0,
    effectTransitionRectangleCount: 0
  };
  const model = buildCommunityShadowModelInternal(entries, diagnostics, {fixture: true});
  return deepFreeze({model, diagnostics: {...diagnostics}});
}

function addViolation(violations, path, reason) {
  violations.push({path, reason});
}

function exactKeys(value, keys, path, violations) {
  if (!isPlainObject(value)) {
    addViolation(violations, path, 'must be an object');
    return false;
  }
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      addViolation(violations, path ? `${path}.${key}` : key, 'unknown field');
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      addViolation(violations, path ? `${path}.${key}` : key, 'missing field');
    }
  }
  return true;
}

function countField(value, path, violations, {nullable = false, minimum = 0} = {}) {
  if (nullable && value === null) {
    return;
  }
  if (!Number.isSafeInteger(value) || value < minimum) {
    addViolation(violations, path, nullable
      ? `must be null or an integer of at least ${minimum}`
      : `must be an integer of at least ${minimum}`);
  }
}

function numberField(value, path, violations, {nullable = true} = {}) {
  if (nullable && value === null) {
    return;
  }
  if (!Number.isFinite(value)) {
    addViolation(violations, path, nullable ? 'must be null or finite' : 'must be finite');
  }
}

function auditNoise(value, path, cohort, violations) {
  if (!exactKeys(value, NOISE_KEYS, path, violations)) {
    return;
  }
  if (value.state !== 'available' && value.state !== 'withheld') {
    addViolation(violations, `${path}.state`, 'must be available or withheld');
  }
  countField(value.aircraftCount, `${path}.aircraftCount`, violations, {nullable: true});
  countField(value.pairCount, `${path}.pairCount`, violations, {nullable: true});
  numberField(value.medianAbsoluteDeltaDps, `${path}.medianAbsoluteDeltaDps`, violations);
  if (value.state === 'available'
      && !(value.aircraftCount >= COMMUNITY_MINIMUM_AIRCRAFT_SUPPORT)) {
    addViolation(violations, `${path}.aircraftCount`, 'does not clear the privacy floor');
  }
  if (value.state === 'available') {
    if (!Number.isSafeInteger(value.pairCount) || value.pairCount < value.aircraftCount) {
      addViolation(violations, `${path}.pairCount`,
        'an available metric needs at least one pair per aircraft');
    }
    if (!Number.isFinite(value.medianAbsoluteDeltaDps)
        || value.medianAbsoluteDeltaDps < 0) {
      addViolation(violations, `${path}.medianAbsoluteDeltaDps`,
        'an available noise median must be finite and non-negative');
    }
    if (Number.isSafeInteger(value.aircraftCount)
        && Number.isSafeInteger(cohort?.aircraftCount)
        && value.aircraftCount > cohort.aircraftCount) {
      addViolation(violations, `${path}.aircraftCount`,
        'metric support cannot exceed cohort aircraft support');
    }
    if (Number.isSafeInteger(value.pairCount)
        && Number.isSafeInteger(cohort?.adjacentPairCount)
        && value.pairCount > cohort.adjacentPairCount) {
      addViolation(violations, `${path}.pairCount`,
        'metric pairs cannot exceed cohort adjacent pairs');
    }
  }
  if (value.state === 'withheld'
      && (value.aircraftCount !== null || value.pairCount !== null
        || value.medianAbsoluteDeltaDps !== null)) {
    addViolation(violations, path, 'a withheld metric must not reveal support or values');
  }
}

function auditEffect(value, path, cohort, violations) {
  if (!exactKeys(value, EFFECT_KEYS, path, violations)) {
    return;
  }
  if (value.state !== 'available' && value.state !== 'withheld') {
    addViolation(violations, `${path}.state`, 'must be available or withheld');
  }
  countField(value.aircraftCount, `${path}.aircraftCount`, violations, {nullable: true});
  countField(value.transitionCount, `${path}.transitionCount`, violations, {nullable: true});
  numberField(value.medianEffectDpsPerLogGainRatio,
    `${path}.medianEffectDpsPerLogGainRatio`, violations);

  if (exactKeys(value.signAgreement, AGREEMENT_KEYS, `${path}.signAgreement`, violations)) {
    countField(value.signAgreement.agreeingAircraftCount,
      `${path}.signAgreement.agreeingAircraftCount`, violations, {nullable: true});
    countField(value.signAgreement.evaluatedAircraftCount,
      `${path}.signAgreement.evaluatedAircraftCount`, violations, {nullable: true});
    numberField(value.signAgreement.ratio, `${path}.signAgreement.ratio`, violations);
    if (Number.isFinite(value.signAgreement.ratio)
        && (value.signAgreement.ratio < 0 || value.signAgreement.ratio > 1)) {
      addViolation(violations, `${path}.signAgreement.ratio`, 'must be between zero and one');
    }
  }
  if (value.state === 'available'
      && !(value.aircraftCount >= COMMUNITY_MINIMUM_AIRCRAFT_SUPPORT)) {
    addViolation(violations, `${path}.aircraftCount`, 'does not clear the privacy floor');
  }
  if (value.state === 'available') {
    if (!Number.isSafeInteger(value.transitionCount)
        || value.transitionCount < value.aircraftCount) {
      addViolation(violations, `${path}.transitionCount`,
        'an available metric needs at least one transition per aircraft');
    }
    if (!Number.isFinite(value.medianEffectDpsPerLogGainRatio)) {
      addViolation(violations, `${path}.medianEffectDpsPerLogGainRatio`,
        'an available effect median must be finite');
    }
    if (Number.isFinite(value.medianEffectDpsPerLogGainRatio)
        && Math.abs(value.medianEffectDpsPerLogGainRatio)
          > COMMUNITY_MAXIMUM_ABS_EFFECT_DPS_PER_LOG_GAIN_RATIO) {
      addViolation(violations, `${path}.medianEffectDpsPerLogGainRatio`,
        'exceeds the bounded effect magnitude');
    }
    if (Number.isSafeInteger(value.aircraftCount)
        && Number.isSafeInteger(cohort?.aircraftCount)
        && value.aircraftCount > cohort.aircraftCount) {
      addViolation(violations, `${path}.aircraftCount`,
        'metric support cannot exceed cohort aircraft support');
    }
    if (Number.isSafeInteger(value.transitionCount)
        && Number.isSafeInteger(cohort?.adjacentPairCount)
        && value.transitionCount > cohort.adjacentPairCount) {
      addViolation(violations, `${path}.transitionCount`,
        'metric transitions cannot exceed cohort adjacent pairs');
    }

    const agreement = value.signAgreement;
    const countsConsistent = Number.isSafeInteger(agreement?.agreeingAircraftCount)
      && Number.isSafeInteger(agreement?.evaluatedAircraftCount)
      && agreement.agreeingAircraftCount >= 0
      && agreement.evaluatedAircraftCount === value.aircraftCount
      && agreement.agreeingAircraftCount <= agreement.evaluatedAircraftCount;
    if (!countsConsistent) {
      addViolation(violations, `${path}.signAgreement`,
        'agreement counts must be ordered and evaluate every supporting aircraft');
    } else {
      const expectedRatio = rounded(
        agreement.agreeingAircraftCount / agreement.evaluatedAircraftCount
      );
      if (!Number.isFinite(agreement.ratio)
          || Math.abs(agreement.ratio - expectedRatio) > 1e-9) {
        addViolation(violations, `${path}.signAgreement.ratio`,
          'must equal agreeing aircraft divided by every supporting aircraft');
      }
    }
  }
  if (value.state === 'withheld') {
    const revealed = value.aircraftCount !== null
      || value.transitionCount !== null
      || value.medianEffectDpsPerLogGainRatio !== null
      || value.signAgreement?.agreeingAircraftCount !== null
      || value.signAgreement?.evaluatedAircraftCount !== null
      || value.signAgreement?.ratio !== null;
    if (revealed) {
      addViolation(violations, path, 'a withheld metric must not reveal support or values');
    }
  }
}

function auditCohort(value, index, violations) {
  const path = `cohorts[${index}]`;
  if (!exactKeys(value, COHORT_KEYS, path, violations)) {
    return;
  }
  const key = value.cohortKey;
  const expectedKey = `shadow-cohort-${String(index + 1).padStart(6, '0')}`;
  if (typeof key !== 'string' || !ANONYMOUS_COHORT_PATTERN.test(key)) {
    addViolation(violations, `${path}.cohortKey`,
      'must be an anonymous fixed-width shadow cohort key');
  } else if (key !== expectedKey) {
    addViolation(violations, `${path}.cohortKey`,
      'must match its deterministic one-based artifact position');
  }
  countField(value.aircraftCount, `${path}.aircraftCount`, violations,
    {minimum: COMMUNITY_MINIMUM_AIRCRAFT_SUPPORT});
  countField(value.flightCount, `${path}.flightCount`, violations);
  countField(value.adjacentPairCount, `${path}.adjacentPairCount`, violations);
  if (Number.isSafeInteger(value.flightCount) && Number.isSafeInteger(value.aircraftCount)
      && value.flightCount < value.aircraftCount) {
    addViolation(violations, `${path}.flightCount`,
      'a published aircraft must contribute at least one flight');
  }
  if (Number.isSafeInteger(value.adjacentPairCount) && Number.isSafeInteger(value.flightCount)
      && Number.isSafeInteger(value.aircraftCount)
      && value.adjacentPairCount > value.flightCount - value.aircraftCount) {
    addViolation(violations, `${path}.adjacentPairCount`,
      'adjacent pair count cannot exceed flights minus aircraft');
  }
  if (!exactKeys(value.axes, AXES, `${path}.axes`, violations)) {
    return;
  }
  let available = 0;
  for (const axis of AXES) {
    const axisPath = `${path}.axes.${axis}`;
    const measured = value.axes[axis];
    if (!exactKeys(measured, AXIS_KEYS, axisPath, violations)) {
      continue;
    }
    auditNoise(measured.noise, `${axisPath}.noise`, value, violations);
    if (measured.noise?.state === 'available') {
      available += 1;
    }
    if (!exactKeys(measured.effects, TERMS, `${axisPath}.effects`, violations)) {
      continue;
    }
    for (const term of TERMS) {
      auditEffect(measured.effects[term], `${axisPath}.effects.${term}`, value, violations);
      if (measured.effects[term]?.state === 'available') {
        available += 1;
      }
    }
  }
  if (available === 0) {
    addViolation(violations, path, 'a cohort with no privacy-cleared metric must be omitted');
  }
}

function auditCommunityShadowModelInternal(model, {fixture = false} = {}) {
  const violations = [];
  if (!exactKeys(model, ROOT_KEYS, '', violations)) {
    return deepFreeze({ok: false, violations});
  }
  if (model.schemaVersion !== COMMUNITY_SHADOW_MODEL_SCHEMA_VERSION) {
    addViolation(violations, 'schemaVersion', 'shadow model schema mismatch');
  }
  const expectedKind = fixture ? COMMUNITY_FIXTURE_MODEL_KIND : COMMUNITY_SHADOW_MODEL_KIND;
  const expectedMode = fixture ? COMMUNITY_FIXTURE_MODEL_MODE : COMMUNITY_SHADOW_MODEL_MODE;
  const expectedTrustBoundary = fixture
    ? COMMUNITY_FIXTURE_TRUST_BOUNDARY
    : COMMUNITY_SHADOW_MODEL_TRUST_BOUNDARY;
  if (model.kind !== expectedKind) {
    addViolation(violations, 'kind', 'shadow model kind mismatch');
  }
  if (model.mode !== expectedMode) {
    addViolation(violations, 'mode', fixture
      ? 'only test-fixture mode is permitted by the fixture audit'
      : 'only shadow mode is permitted');
  }
  if (model.trustBoundary !== expectedTrustBoundary) {
    addViolation(violations, 'trustBoundary',
      fixture
        ? 'only the prevalidated-fixture trust boundary is permitted by the fixture audit'
        : 'only the licensed manual corpus trust boundary is permitted');
  }

  if (exactKeys(model.contract, CONTRACT_KEYS, 'contract', violations)) {
    if (model.contract.contributionKind !== COMMUNITY_CONTRIBUTION_KIND) {
      addViolation(violations, 'contract.contributionKind', 'contribution kind mismatch');
    }
    if (model.contract.contributionSchemaVersion !== COMMUNITY_CONTRIBUTION_SCHEMA_VERSION) {
      addViolation(violations, 'contract.contributionSchemaVersion',
        'contribution schema mismatch');
    }
    if (model.contract.cohortVersion !== COMMUNITY_COHORT_VERSION) {
      addViolation(violations, 'contract.cohortVersion', 'cohort contract mismatch');
    }
    if (model.contract.extractorVersion !== COMMUNITY_EXTRACTOR_VERSION) {
      addViolation(violations, 'contract.extractorVersion', 'extractor version mismatch');
    }
    if (model.contract.minimumAircraftSupport !== COMMUNITY_MINIMUM_AIRCRAFT_SUPPORT) {
      addViolation(violations, 'contract.minimumAircraftSupport', 'privacy floor mismatch');
    }
    if (model.contract.controlledTrialKind !== COMMUNITY_CONTROLLED_TRIAL_KIND) {
      addViolation(violations, 'contract.controlledTrialKind',
        'controlled trial kind mismatch');
    }
    if (model.contract.effectSupportKind !== COMMUNITY_EFFECT_SUPPORT_KIND) {
      addViolation(violations, 'contract.effectSupportKind',
        'effect support protocol mismatch');
    }
    if (model.contract.minimumAbsLogGainRatio
        !== rounded(COMMUNITY_MINIMUM_ABS_LOG_GAIN_RATIO, 12)) {
      addViolation(violations, 'contract.minimumAbsLogGainRatio',
        'minimum gain-ratio evidence threshold mismatch');
    }
    if (model.contract.maximumAbsEffectDpsPerLogGainRatio
        !== COMMUNITY_MAXIMUM_ABS_EFFECT_DPS_PER_LOG_GAIN_RATIO) {
      addViolation(violations, 'contract.maximumAbsEffectDpsPerLogGainRatio',
        'maximum effect magnitude mismatch');
    }
  }

  if (exactKeys(model.summary, SUMMARY_KEYS, 'summary', violations)) {
    for (const key of SUMMARY_KEYS) {
      countField(model.summary[key], `summary.${key}`, violations);
    }
    if (Array.isArray(model.cohorts)
        && model.summary.publishedCohortCount !== model.cohorts.length) {
      addViolation(violations, 'summary.publishedCohortCount',
        'must equal the number of cohorts');
    }
  }
  if (exactKeys(model.exclusions, EXCLUSION_KEYS, 'exclusions', violations)) {
    for (const key of EXCLUSION_KEYS) {
      countField(model.exclusions[key], `exclusions.${key}`, violations);
    }
  }

  const summary = model.summary;
  const exclusions = model.exclusions;
  if (SUMMARY_KEYS.every(key => Number.isSafeInteger(summary?.[key]))
      && EXCLUSION_KEYS.every(key => Number.isSafeInteger(exclusions?.[key]))) {
    if (summary.inputContributionCount
        !== summary.contractValidContributionCount + exclusions.invalidContributionCount) {
      addViolation(violations, 'summary.contractValidContributionCount',
        'input must equal contract-valid plus invalid contributions');
    }
    if (summary.contractValidContributionCount
        !== summary.modelEligibleContributionCount + exclusions.nonCohortContributionCount) {
      addViolation(violations, 'summary.modelEligibleContributionCount',
        'contract-valid must equal model-eligible plus non-cohort contributions');
    }
    if (summary.modelEligibleContributionCount
        !== summary.deduplicatedContributionCount
          + exclusions.duplicateContributionIdCount
          + exclusions.conflictingContributionIdCount) {
      addViolation(violations, 'summary.deduplicatedContributionCount',
        'model-eligible must equal deduplicated plus duplicate and conflicting ids');
    }
    if (summary.adjacentPairCount
        !== summary.cohortMatchedPairCount
          + exclusions.nonIncreasingOrdinalPairCount
          + exclusions.ordinalGapPairCount
          + exclusions.cohortMismatchPairCount) {
      addViolation(violations, 'summary.cohortMatchedPairCount',
        'adjacent pairs must resolve exactly to matched or excluded pairing outcomes');
    }
    if (exclusions.nonClearAirframeContributionCount
        > exclusions.nonCohortContributionCount) {
      addViolation(violations, 'exclusions.nonClearAirframeContributionCount',
        'non-clear airframes must be a subset of non-cohort contributions');
    }
    if (exclusions.conflictingContributionIdCount
        > exclusions.duplicateContributionIdCount) {
      addViolation(violations, 'exclusions.conflictingContributionIdCount',
        'every conflicting id requires at least one duplicate claimant');
    }
    if (exclusions.duplicateOrdinalContributionCount
        > summary.deduplicatedContributionCount) {
      addViolation(violations, 'exclusions.duplicateOrdinalContributionCount',
        'duplicate ordinal claimants cannot exceed deduplicated contributions');
    }
    if (summary.adjacentPairCount > summary.deduplicatedContributionCount) {
      addViolation(violations, 'summary.adjacentPairCount',
        'adjacent pairs cannot exceed deduplicated contributions');
    }
  }

  if (!Array.isArray(model.cohorts)) {
    addViolation(violations, 'cohorts', 'must be an array');
  } else {
    let previous = null;
    const seen = new Set();
    for (let index = 0; index < model.cohorts.length; index += 1) {
      const cohort = model.cohorts[index];
      auditCohort(cohort, index, violations);
      if (typeof cohort?.cohortKey === 'string') {
        if (seen.has(cohort.cohortKey)) {
          addViolation(violations, `cohorts[${index}].cohortKey`, 'duplicate cohort key');
        }
        if (previous !== null && compareText(previous, cohort.cohortKey) >= 0) {
          addViolation(violations, `cohorts[${index}].cohortKey`,
            'cohorts must be in deterministic key order');
        }
        seen.add(cohort.cohortKey);
        previous = cohort.cohortKey;
      }
    }
    const publishedAircraftCount = model.cohorts.reduce((sum, cohort) =>
      sum + (Number.isSafeInteger(cohort?.aircraftCount) ? cohort.aircraftCount : 0), 0);
    if (model.summary?.publishedAircraftCount !== publishedAircraftCount) {
      addViolation(violations, 'summary.publishedAircraftCount',
        'must equal the aircraft counts in published cohorts');
    }
    const publishedFlightCount = model.cohorts.reduce((sum, cohort) =>
      sum + (Number.isSafeInteger(cohort?.flightCount) ? cohort.flightCount : 0), 0);
    if (Number.isSafeInteger(model.summary?.deduplicatedContributionCount)
        && publishedAircraftCount > model.summary.deduplicatedContributionCount) {
      addViolation(violations, 'summary.deduplicatedContributionCount',
        'published cohort aircraft cannot exceed deduplicated contributions');
    }
    if (Number.isSafeInteger(model.summary?.deduplicatedContributionCount)
        && publishedFlightCount > model.summary.deduplicatedContributionCount) {
      addViolation(violations, 'summary.deduplicatedContributionCount',
        'published cohort flights cannot exceed deduplicated contributions');
    }
    const cohortPairCount = model.cohorts.reduce((sum, cohort) =>
      sum + (Number.isSafeInteger(cohort?.adjacentPairCount) ? cohort.adjacentPairCount : 0), 0);
    if (Number.isSafeInteger(model.summary?.cohortMatchedPairCount)
        && model.summary.cohortMatchedPairCount < cohortPairCount) {
      addViolation(violations, 'summary.cohortMatchedPairCount',
        'cannot be smaller than the pair counts in published cohorts');
    }
  }

  return deepFreeze({ok: violations.length === 0, violations});
}

/** Strict production audit; fixture artifacts are rejected by identity. */
export function auditCommunityShadowModel(model) {
  return auditCommunityShadowModelInternal(model);
}

/** Test-only audit that rejects production identity and accepts only fixture identity. */
export function auditCommunityShadowModelForPrevalidatedFixtures(model) {
  return auditCommunityShadowModelInternal(model, {fixture: true});
}
