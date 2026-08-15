/**
 * Deterministic flight metrics.
 *
 * Ported from `js/advisor/deterministic_metrics.js` on the
 * `codex/cross-platform-foundation` branch of mbwallace1390/rotorflight-blackbox,
 * where it was written between 10 and 11 August 2026. Michael Wallace is its sole
 * author — no co-authors, no sign-offs — so the copyright is his to license, and
 * it is MPL-2.0 here as the rest of RotorLens-authored source is. The GPL of the
 * repository it sat in binds recipients of that project, not the author of this
 * file.
 *
 * See `docs/ARCHITECTURE_AND_PROVENANCE.md` for the record of that transfer. It
 * is the single documented exception to "nothing flows from the fork into here",
 * and it exists because the author owns both sides.
 *
 * Converted from the UMD wrapper to an ES module mechanically rather than by
 * hand: a transcription slip in this material would be a measurement bug, and
 * measurement bugs on a helicopter are the failure this project is organised
 * around avoiding. The analysis itself is unchanged.
 *
 * This module reports measurements only. It contains no recommendation, and
 * nothing here may grow one — see `src/analysis/pid-evidence.mjs` for why that
 * boundary is drawn where it is.
 */

var AXIS_NAMES = ["roll", "pitch", "yaw"];

function finiteValues(values) {
    return (values || []).filter(Number.isFinite);
}

function mean(values) {
    var source = finiteValues(values);
    if (source.length === 0) {
        return null;
    }

    return source.reduce(function(total, value) {
        return total + value;
    }, 0) / source.length;
}

function quantile(values, percentile) {
    var source = finiteValues(values).sort(function(a, b) {
        return a - b;
    });

    if (source.length === 0) {
        return null;
    }

    var p = Math.min(1, Math.max(0, percentile));
    var index = (source.length - 1) * p;
    var lower = Math.floor(index);
    var upper = Math.ceil(index);
    var fraction = index - lower;

    if (upper === lower) {
        return source[lower];
    }

    return source[lower] + (source[upper] - source[lower]) * fraction;
}

function rms(values) {
    var source = finiteValues(values);
    if (source.length === 0) {
        return null;
    }

    return Math.sqrt(source.reduce(function(total, value) {
        return total + value * value;
    }, 0) / source.length);
}

function summaryFromAccumulator(accumulator) {
    if (!accumulator || accumulator.count === 0) {
        return null;
    }

    return {
        sampleCount: accumulator.count,
        meanAbsErrorDps: accumulator.sumAbs / accumulator.count,
        rmsErrorDps: Math.sqrt(accumulator.sumSquares / accumulator.count),
        p95AbsErrorDps: quantile(accumulator.absErrorSamples, 0.95),
        maxAbsErrorDps: accumulator.maxAbs,
        p95AbsSetpointDps: quantile(accumulator.absSetpointSamples, 0.95)
    };
}

function summarizeTracking(axisAccumulators) {
    return (axisAccumulators || []).map(function(axisAccumulator, index) {
        var all = summaryFromAccumulator(axisAccumulator.all);
        var commanded = summaryFromAccumulator(axisAccumulator.commanded);
        var normalizedRmse = null;

        if (commanded && commanded.p95AbsSetpointDps > 0) {
            normalizedRmse = commanded.rmsErrorDps / commanded.p95AbsSetpointDps;
        }

        return {
            axis: AXIS_NAMES[index] || String(index),
            // A powered log with real commanded motion is required. Bench
            // stick movement and steady idle are not tuning evidence.
            available: Boolean(all && commanded && commanded.sampleCount >= 10),
            all: all,
            commanded: commanded,
            normalizedCommandedRmse: normalizedRmse
        };
    });
}

function buildActiveRanges(events, maxTimeUs) {
    var sorted = (events || []).filter(function(event) {
        return Number.isFinite(event.timeUs) && Number.isFinite(event.state);
    }).slice().sort(function(a, b) {
        return a.timeUs - b.timeUs;
    });
    var ranges = [];
    var activeStart = null;

    sorted.forEach(function(event) {
        if (event.state === 4 && activeStart === null) {
            activeStart = event.timeUs;
        } else if (event.state !== 4 && activeStart !== null) {
            if (event.timeUs > activeStart) {
                ranges.push([activeStart, event.timeUs]);
            }
            activeStart = null;
        }
    });

    if (activeStart !== null && Number.isFinite(maxTimeUs) && maxTimeUs > activeStart) {
        ranges.push([activeStart, maxTimeUs]);
    }

    return ranges;
}

function timeInRanges(timeUs, ranges, settleUs) {
    var settle = settleUs || 0;
    for (var i = 0; i < ranges.length; i++) {
        if (timeUs >= ranges[i][0] + settle && timeUs < ranges[i][1]) {
            return true;
        }
    }
    return false;
}

function recordError(record) {
    return record.actualRpm - record.targetRpm;
}

function lowerBoundTime(records, timeUs) {
    var low = 0;
    var high = records.length;
    while (low < high) {
        var middle = (low + high) >>> 1;
        if (records[middle].timeUs < timeUs) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

function upperBoundTime(records, timeUs) {
    var low = 0;
    var high = records.length;
    while (low < high) {
        var middle = (low + high) >>> 1;
        if (records[middle].timeUs <= timeUs) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

function valuesInTimeRange(records, startUs, endUs) {
    return records.slice(
        lowerBoundTime(records, startUs),
        upperBoundTime(records, endUs)
    );
}

function sustainedRun(records, predicate, maximumGapUs) {
    var longestDurationUs = 0;
    var longestSampleCount = 0;
    var runStartUs = null;
    var previousTimeUs = null;
    var runSampleCount = 0;

    (records || []).forEach(function(record) {
        var continues = predicate(record)
            && (previousTimeUs === null
                || record.timeUs - previousTimeUs <= maximumGapUs);
        if (!continues) {
            runStartUs = predicate(record) ? record.timeUs : null;
            runSampleCount = predicate(record) ? 1 : 0;
        } else if (runStartUs === null) {
            runStartUs = record.timeUs;
            runSampleCount = 1;
        } else {
            runSampleCount++;
        }
        previousTimeUs = predicate(record) ? record.timeUs : null;

        if (runStartUs !== null) {
            var durationUs = record.timeUs - runStartUs;
            if (durationUs > longestDurationUs
                    || (durationUs === longestDurationUs
                        && runSampleCount > longestSampleCount)) {
                longestDurationUs = durationUs;
                longestSampleCount = runSampleCount;
            }
        }
    });

    return {
        durationUs: longestDurationUs,
        sampleCount: longestSampleCount
    };
}

function maximumTimeGap(records) {
    var maximumGapUs = 0;
    for (var i = 1; i < (records || []).length; i++) {
        maximumGapUs = Math.max(
            maximumGapUs,
            records[i].timeUs - records[i - 1].timeUs
        );
    }
    return maximumGapUs;
}

function detectPitchPumps(records, options) {
    var settings = Object.assign({
        minimumEvents: 3,
        consistencyRatio: 0.75,
        collectiveStepPercent: 30,
        minimumCollectivePercent: 70,
        baselineWindowUs: 250000,
        responseWindowUs: 800000,
        independentWindowSpacingUs: null,
        minimumEffectPercent: 2,
        responseLowQuantile: 0.1,
        responseHighQuantile: 0.9,
        minimumSustainedResponseUs: 50000,
        minimumSustainedResponseSamples: 20,
        maximumConsecutiveGapUs: 5000,
        motorCeilingPercent: null,
        minimumMotorHeadroomPercent: 5,
        maximumYawCommandDps: 50,
        minimumTailSamples: 10,
        maximumTargetVariationRatio: 0.03,
        maximumRequestVariationRatio: 0.03,
        maximumRequestTargetErrorRatio: 0.03,
        maximumWindowEvaluations: 256,
        selectedStartTimeUs: null,
        selectedEndTimeUs: null
    }, options);
    var source = (records || []).filter(function(record) {
        return Number.isFinite(record.timeUs)
            && Number.isFinite(record.collectivePercent)
            && Number.isFinite(record.targetRpm)
            && Number.isFinite(record.actualRpm)
            && record.targetRpm > 500
            && record.active !== false;
    }).slice().sort(function(a, b) {
        return a.timeUs - b.timeUs;
    });
    var events = [];
    var previousWindowStartTimeUs = -Infinity;
    var truncatedWindowCount = 0;
    var overlappingWindowCount = 0;
    var unstableTargetWindowCount = 0;
    var missingRequestWindowCount = 0;
    var unstableRequestWindowCount = 0;
    var missingArmWindowCount = 0;
    var unarmedWindowCount = 0;
    var windowEvaluationCount = 0;
    var windowEvaluationLimitReached = false;
    var selectedStartTimeUs = Number.isFinite(settings.selectedStartTimeUs)
        ? settings.selectedStartTimeUs
        : (source.length > 0 ? source[0].timeUs : null);
    var selectedEndTimeUs = Number.isFinite(settings.selectedEndTimeUs)
        ? settings.selectedEndTimeUs
        : (source.length > 0 ? source[source.length - 1].timeUs : null);
    var independentWindowSpacingUs = Number.isFinite(settings.independentWindowSpacingUs)
        ? settings.independentWindowSpacingUs
        : settings.baselineWindowUs + settings.responseWindowUs;

    for (var i = 0; i < source.length; i++) {
        var current = source[i];
        // Only evaluate a bounded window on the rising crossing into a
        // high-collective pump. This keeps a 24k-record selection linear
        // instead of filtering the full array for every sample.
        var currentDemandPercent = Math.abs(current.collectivePercent);
        var previousDemandPercent = i > 0
            ? Math.abs(source[i - 1].collectivePercent)
            : null;
        if (currentDemandPercent < settings.minimumCollectivePercent
                || (previousDemandPercent !== null
                    && previousDemandPercent >= settings.minimumCollectivePercent)) {
            continue;
        }
        if (windowEvaluationCount >= settings.maximumWindowEvaluations) {
            windowEvaluationLimitReached = true;
            break;
        }
        windowEvaluationCount++;

        // Starting a selection already above the pump threshold means its
        // baseline lies outside I/O. It is incomplete evidence, not an
        // ignorable non-candidate.
        if (previousDemandPercent === null) {
            truncatedWindowCount++;
            previousWindowStartTimeUs = current.timeUs;
            continue;
        }
        if (current.timeUs - previousWindowStartTimeUs
                < independentWindowSpacingUs) {
            overlappingWindowCount++;
            previousWindowStartTimeUs = current.timeUs;
            continue;
        }
        previousWindowStartTimeUs = current.timeUs;

        var baselineStartUs = current.timeUs - settings.baselineWindowUs;
        var responseEndUs = current.timeUs + settings.responseWindowUs;
        // A response close to In or Out is not a complete test. Never fill
        // the missing side with records from outside the selected graph range.
        if (selectedStartTimeUs === null
                || selectedEndTimeUs === null
                || baselineStartUs < selectedStartTimeUs
                || responseEndUs > selectedEndTimeUs) {
            truncatedWindowCount++;
            continue;
        }

        var baseline = valuesInTimeRange(source, baselineStartUs, current.timeUs - 1);
        var response = valuesInTimeRange(source, current.timeUs, responseEndUs);
        if (baseline.length < 2 || response.length < 3
                || baseline[0].timeUs > baselineStartUs
                    + settings.maximumConsecutiveGapUs
                || response[response.length - 1].timeUs < responseEndUs
                    - settings.maximumConsecutiveGapUs
                || maximumTimeGap(baseline) > settings.maximumConsecutiveGapUs
                || maximumTimeGap(response) > settings.maximumConsecutiveGapUs) {
            truncatedWindowCount++;
            continue;
        }

        var baselineCollectivePercent = quantile(baseline.map(function(record) {
            return Math.abs(record.collectivePercent);
        }), 0.5);
        var loadStepPercent = Math.abs(current.collectivePercent) - baselineCollectivePercent;
        if (loadStepPercent < settings.collectiveStepPercent) {
            continue;
        }

        var targetValues = baseline.concat(response).map(function(record) {
            return record.targetRpm;
        });
        var targetRpm = quantile(targetValues, 0.5);
        var targetRange = Math.max.apply(Math, targetValues) - Math.min.apply(Math, targetValues);
        if (!targetRpm || targetRange / targetRpm > settings.maximumTargetVariationRatio) {
            unstableTargetWindowCount++;
            continue;
        }
        var requestValues = baseline.concat(response).map(function(record) {
            return record.requestRpm;
        });
        if (!requestValues.every(Number.isFinite)) {
            missingRequestWindowCount++;
            continue;
        }
        var requestRpm = quantile(requestValues, 0.5);
        var requestRange = Math.max.apply(Math, requestValues)
            - Math.min.apply(Math, requestValues);
        if (!requestRpm
                || requestRange / requestRpm > settings.maximumRequestVariationRatio
                || Math.abs(requestRpm - targetRpm) / targetRpm
                    > settings.maximumRequestTargetErrorRatio) {
            unstableRequestWindowCount++;
            continue;
        }

        var armValues = baseline.concat(response).map(function(record) {
            return record.armed;
        });
        if (!armValues.every(function(value) { return typeof value === "boolean"; })) {
            missingArmWindowCount++;
            continue;
        }
        if (!armValues.every(function(value) { return value === true; })) {
            unarmedWindowCount++;
            continue;
        }

        var baselineError = quantile(baseline.map(recordError), 0.5);
        var responseErrors = response.map(recordError);
        var minimumError = quantile(responseErrors, settings.responseLowQuantile);
        var maximumError = quantile(responseErrors, settings.responseHighQuantile);
        var droopRpm = Math.max(0, baselineError - minimumError);
        var overshootRpm = Math.max(0, maximumError - baselineError);
        var droopPercent = droopRpm / targetRpm * 100;
        var overshootPercent = overshootRpm / targetRpm * 100;
        var minimumEffectRpm = targetRpm * settings.minimumEffectPercent / 100;
        var sustainedDroop = sustainedRun(response, function(record) {
            return recordError(record) <= baselineError - minimumEffectRpm;
        }, settings.maximumConsecutiveGapUs);
        var sustainedOvershoot = sustainedRun(response, function(record) {
            return recordError(record) >= baselineError + minimumEffectRpm;
        }, settings.maximumConsecutiveGapUs);
        var droopSustained = sustainedDroop.durationUs
                >= settings.minimumSustainedResponseUs
            && sustainedDroop.sampleCount >= settings.minimumSustainedResponseSamples;
        var overshootSustained = sustainedOvershoot.durationUs
                >= settings.minimumSustainedResponseUs
            && sustainedOvershoot.sampleCount >= settings.minimumSustainedResponseSamples;
        var motorP95Pct = quantile(response.map(function(record) {
            return record.motorPct;
        }), 0.95);
        var motorHeadroomPct = Number.isFinite(settings.motorCeilingPercent)
                && motorP95Pct !== null
            ? settings.motorCeilingPercent - motorP95Pct
            : null;
        var headroomOk = motorHeadroomPct !== null
            && motorHeadroomPct >= settings.minimumMotorHeadroomPercent;
        var baselineYaw = baseline.filter(function(record) {
            return Number.isFinite(record.yawErrorDps)
                && Number.isFinite(record.yawSetpointDps);
        });
        var responseYaw = response.filter(function(record) {
            return Number.isFinite(record.yawErrorDps)
                && Number.isFinite(record.yawSetpointDps);
        });
        var tailEvidenceAvailable = baselineYaw.length >= settings.minimumTailSamples
            && responseYaw.length >= settings.minimumTailSamples
            && baselineYaw.length / baseline.length >= 0.8
            && responseYaw.length / response.length >= 0.8;
        var baselineYawRmsDps = tailEvidenceAvailable
            ? rms(baselineYaw.map(function(record) { return record.yawErrorDps; }))
            : null;
        var responseYawRmsDps = tailEvidenceAvailable
            ? rms(responseYaw.map(function(record) { return record.yawErrorDps; }))
            : null;
        var yawCommandP95Dps = tailEvidenceAvailable
            ? quantile(baselineYaw.concat(responseYaw).map(function(record) {
                return Math.abs(record.yawSetpointDps);
            }), 0.95)
            : null;
        // Conservative RotorLens product threshold, not an official
        // Rotorflight limit. A low absolute floor still rejects a sharp
        // increase from a quiet baseline.
        var tailDegradationThresholdDps = baselineYawRmsDps === null
            ? null
            : Math.max(15, baselineYawRmsDps * 2 + 5);
        var tailDegradationDetected = responseYawRmsDps !== null
            && responseYawRmsDps > tailDegradationThresholdDps;
        var tailStable = tailEvidenceAvailable
            && yawCommandP95Dps <= settings.maximumYawCommandDps
            && !tailDegradationDetected;
        var classification = "balanced";

        if (droopPercent >= settings.minimumEffectPercent
                && droopSustained
                && droopRpm > overshootRpm * 1.25) {
            classification = "droop";
        } else if (overshootPercent >= settings.minimumEffectPercent
                && overshootSustained
                && overshootRpm > droopRpm * 1.25) {
            classification = "overshoot";
        }

        events.push({
            startTimeUs: current.timeUs,
            endTimeUs: responseEndUs,
            baselineStartTimeUs: baselineStartUs,
            loadStepPercent: loadStepPercent,
            peakCollectivePercent: Math.abs(current.collectivePercent),
            targetRpm: targetRpm,
            requestRpm: requestRpm,
            droopRpm: droopRpm,
            droopPercent: droopPercent,
            overshootRpm: overshootRpm,
            overshootPercent: overshootPercent,
            sustainedDroopUs: sustainedDroop.durationUs,
            sustainedOvershootUs: sustainedOvershoot.durationUs,
            motorP95Pct: motorP95Pct,
            motorHeadroomPct: motorHeadroomPct,
            headroomOk: headroomOk,
            tailEvidenceAvailable: tailEvidenceAvailable,
            baselineYawRmsDps: baselineYawRmsDps,
            responseYawRmsDps: responseYawRmsDps,
            yawCommandP95Dps: yawCommandP95Dps,
            tailDegradationDetected: tailDegradationDetected,
            tailStable: tailStable,
            classification: classification
        });
    }

    var eligible = events.filter(function(event) {
        return event.headroomOk && event.tailStable;
    });
    var droopCount = eligible.filter(function(event) {
        return event.classification === "droop";
    }).length;
    var overshootCount = eligible.filter(function(event) {
        return event.classification === "overshoot";
    }).length;
    var dominant = droopCount >= overshootCount ? "droop" : "overshoot";
    var dominantCount = Math.max(droopCount, overshootCount);
    var crossPumpTargetMedian = quantile(events.map(function(event) {
        return event.targetRpm;
    }), 0.5);
    var crossPumpRequestMedian = quantile(events.map(function(event) {
        return event.requestRpm;
    }), 0.5);
    var crossPumpTargetRange = events.length > 0
        ? Math.max.apply(Math, events.map(function(event) { return event.targetRpm; }))
            - Math.min.apply(Math, events.map(function(event) { return event.targetRpm; }))
        : null;
    var crossPumpRequestRange = events.length > 0
        ? Math.max.apply(Math, events.map(function(event) { return event.requestRpm; }))
            - Math.min.apply(Math, events.map(function(event) { return event.requestRpm; }))
        : null;
    var crossPumpHeadSpeedStable = events.length < 2
        || (crossPumpTargetMedian > 0
            && crossPumpRequestMedian > 0
            && crossPumpTargetRange / crossPumpTargetMedian
                <= settings.maximumTargetVariationRatio
            && crossPumpRequestRange / crossPumpRequestMedian
                <= settings.maximumRequestVariationRatio
            && Math.abs(crossPumpRequestMedian - crossPumpTargetMedian)
                / crossPumpTargetMedian <= settings.maximumRequestTargetErrorRatio);
    var sufficient = eligible.length >= settings.minimumEvents
        && dominantCount >= settings.minimumEvents
        && dominantCount / eligible.length >= settings.consistencyRatio
        && crossPumpHeadSpeedStable;
    var headroomSufficient = events.length >= settings.minimumEvents
        && events.every(function(event) { return event.headroomOk; });
    var tailEvidenceAvailable = events.length >= settings.minimumEvents
        && events.every(function(event) { return event.tailEvidenceAvailable; });
    var tailDegradationDetected = events.some(function(event) {
        return event.tailDegradationDetected;
    });
    var tailStable = tailEvidenceAvailable
        && !tailDegradationDetected
        && events.every(function(event) { return event.tailStable; });

    return {
        candidateCount: events.length,
        eligibleCount: eligible.length,
        truncatedWindowCount: truncatedWindowCount,
        overlappingWindowCount: overlappingWindowCount,
        unstableTargetWindowCount: unstableTargetWindowCount,
        targetStable: unstableTargetWindowCount === 0,
        missingRequestWindowCount: missingRequestWindowCount,
        unstableRequestWindowCount: unstableRequestWindowCount,
        requestEvidenceAvailable: missingRequestWindowCount === 0,
        requestStable: unstableRequestWindowCount === 0,
        missingArmWindowCount: missingArmWindowCount,
        unarmedWindowCount: unarmedWindowCount,
        armEvidenceComplete: missingArmWindowCount === 0,
        allPumpWindowsArmed: unarmedWindowCount === 0,
        crossPumpHeadSpeedStable: crossPumpHeadSpeedStable,
        recordsScanned: source.length,
        windowEvaluationCount: windowEvaluationCount,
        windowEvaluationLimitReached: windowEvaluationLimitReached,
        droopCount: droopCount,
        overshootCount: overshootCount,
        sufficient: sufficient,
        direction: sufficient ? (dominant === "droop" ? "increase" : "decrease") : null,
        reason: sufficient ? dominant : "insufficient-consistency",
        headroomSufficient: headroomSufficient,
        tailEvidenceAvailable: tailEvidenceAvailable,
        tailDegradationDetected: tailDegradationDetected,
        tailStable: tailStable,
        minimumEvents: settings.minimumEvents,
        consistencyRatio: settings.consistencyRatio,
        collectiveStepPercent: settings.collectiveStepPercent,
        minimumCollectivePercent: settings.minimumCollectivePercent,
        minimumMotorHeadroomPercent: settings.minimumMotorHeadroomPercent,
        medianDroopRpm: quantile(eligible.map(function(event) {
            return event.droopRpm;
        }), 0.5),
        medianOvershootRpm: quantile(eligible.map(function(event) {
            return event.overshootRpm;
        }), 0.5),
        windows: events.slice(0, 8).map(function(event) {
            return {
                baselineStartTimeUs: event.baselineStartTimeUs,
                startTimeUs: event.startTimeUs,
                endTimeUs: event.endTimeUs,
                classification: event.classification,
                motorHeadroomPct: event.motorHeadroomPct,
                baselineYawRmsDps: event.baselineYawRmsDps,
                responseYawRmsDps: event.responseYawRmsDps
            };
        })
    };
}

function summarizeGovernor(snapshot) {
    if (!snapshot.governorSource) {
        return {
            available: false,
            source: null,
            explicitActiveEventWithinRange: false,
            stateSequenceSafe: false,
            eventsComplete: snapshot.governorEventsCapped !== true,
            guidanceReason: "missing-governor-fields"
        };
    }

    var governorEvents = (snapshot.governorEvents || []).filter(function(event) {
        return Number.isFinite(event.timeUs) && Number.isFinite(event.state);
    });
    var ranges = buildActiveRanges(governorEvents, snapshot.maxTimeUs);
    var explicitActiveEventWithinRange = governorEvents.some(function(event) {
        return event.state === 4;
    });
    var activeSeen = false;
    var stateSequenceSafe = governorEvents.every(function(event) {
        if (event.state === 4) {
            activeSeen = true;
            return true;
        }
        return !activeSeen && (event.state === 0 || event.state === 1 || event.state === 2);
    });
    var records = (snapshot.governorRecords || []).map(function(record) {
        // The user-selected range must itself contain explicit ACTIVE
        // governor state evidence; activity is never inferred from RPM.
        var active = timeInRanges(record.timeUs, ranges, 500000);
        return Object.assign({}, record, { active: active });
    }).filter(function(record) {
        return record.active && record.targetRpm > 500 && record.actualRpm > 0;
    });

    if (records.length < 10) {
        return {
            available: false,
            source: snapshot.governorSource,
            explicitActiveEventWithinRange: explicitActiveEventWithinRange,
            stateSequenceSafe: stateSequenceSafe,
            eventsComplete: snapshot.governorEventsCapped !== true,
            guidanceReason: "insufficient-active-governor-data"
        };
    }

    var errors = records.map(recordError);
    var motorValues = records.map(function(record) {
        return record.motorPct;
    });
    var motorP95Pct = quantile(motorValues, 0.95);
    var governorConfiguration = snapshot.governorConfiguration || {};
    var motorCeilingPercent = Number.isFinite(governorConfiguration.maxThrottlePercent)
        ? governorConfiguration.maxThrottlePercent
        : null;
    var motorHeadroomPercent = motorCeilingPercent !== null && motorP95Pct !== null
        ? motorCeilingPercent - motorP95Pct
        : null;
    var pumps = detectPitchPumps(records, {
        motorCeilingPercent: motorCeilingPercent,
        selectedStartTimeUs: snapshot.minTimeUs,
        selectedEndTimeUs: snapshot.maxTimeUs
    });

    return {
        available: true,
        source: snapshot.governorSource,
        explicitActiveEventWithinRange: explicitActiveEventWithinRange,
        stateSequenceSafe: stateSequenceSafe,
        eventsComplete: snapshot.governorEventsCapped !== true,
        fullRateRecords: snapshot.governorRecordsFullRate === true,
        activeSampleCount: records.length,
        activeDurationUs: ranges.reduce(function(total, range) {
            return total + Math.max(0, range[1] - range[0] - 500000);
        }, 0),
        targetRpm: quantile(records.map(function(record) {
            return record.targetRpm;
        }), 0.5),
        actualRpm: quantile(records.map(function(record) {
            return record.actualRpm;
        }), 0.5),
        meanErrorRpm: mean(errors),
        rmseRpm: rms(errors),
        p95AbsErrorRpm: quantile(errors.map(Math.abs), 0.95),
        maxDroopRpm: Math.max(0, -Math.min.apply(Math, errors)),
        maxOvershootRpm: Math.max(0, Math.max.apply(Math, errors)),
        motorP95Pct: motorP95Pct,
        motorCeilingPercent: motorCeilingPercent,
        motorHeadroomPercent: motorHeadroomPercent,
        headroomSufficient: pumps.headroomSufficient,
        pitchPumps: pumps
    };
}

function summarizeBattery(snapshot) {
    var accumulator = snapshot.battery;
    if (!accumulator || accumulator.count === 0) {
        return { available: false };
    }

    var minimumVolts = accumulator.minRaw / 100;
    var maximumVolts = accumulator.maxRaw / 100;
    var cellCount = snapshot.cellCount;
    var maximumCellVolts = Number.isFinite(snapshot.maximumCellVoltageRaw)
        ? snapshot.maximumCellVoltageRaw / 100
        : 4.35;

    // The legacy viewer's estimate is not reliable for every Rotorflight
    // header. Never turn a physically impossible estimate into a low-cell
    // blocker; retain the pack-voltage evidence and mark cell data unknown.
    if (cellCount > 0 && maximumVolts / cellCount > maximumCellVolts + 0.15) {
        cellCount = null;
    }
    var warningCellVolts = Number.isFinite(snapshot.warningCellVoltageRaw)
        ? snapshot.warningCellVoltageRaw / 100
        : null;
    var minimumCellVolts = cellCount > 0 ? minimumVolts / cellCount : null;

    return {
        available: true,
        sampleCount: accumulator.count,
        cellCount: cellCount || null,
        minimumVolts: minimumVolts,
        maximumVolts: maximumVolts,
        minimumCellVolts: minimumCellVolts,
        warningCellVolts: warningCellVolts,
        belowConfiguredWarning: minimumCellVolts !== null && warningCellVolts !== null
            ? minimumCellVolts < warningCellVolts
            : null
    };
}

function summarizeSnapshot(snapshot) {
    var medianDtUs = quantile(snapshot.dtSamples, 0.5);
    var p99DtUs = quantile(snapshot.dtSamples, 0.99);
    var sampleRateHz = medianDtUs && medianDtUs > 0 ? 1000000 / medianDtUs : null;
    var effectiveSampleRateHz = snapshot.durationUs > 0 && snapshot.sampleCount > 1
        ? (snapshot.sampleCount - 1) * 1000000 / snapshot.durationUs
        : null;
    var timingCoverageRatio = snapshot.durationUs > 0
            && Number.isFinite(snapshot.firstSampleTimeUs)
            && Number.isFinite(snapshot.lastSampleTimeUs)
        ? Math.max(0, snapshot.lastSampleTimeUs - snapshot.firstSampleTimeUs)
            / snapshot.durationUs
        : null;
    var frameIntervalJitterRatio = medianDtUs && p99DtUs
        ? p99DtUs / medianDtUs
        : null;

    return {
        quality: {
            sampleRateHz: sampleRateHz,
            effectiveSampleRateHz: effectiveSampleRateHz,
            medianFrameIntervalUs: medianDtUs,
            p99FrameIntervalUs: p99DtUs,
            maximumFrameIntervalUs: Number.isFinite(snapshot.maximumFrameIntervalUs)
                ? snapshot.maximumFrameIntervalUs
                : null,
            frameIntervalJitterRatio: frameIntervalJitterRatio,
            timingCoverageRatio: timingCoverageRatio,
            sampleCount: snapshot.sampleCount,
            invalidTimeCount: snapshot.invalidTimeCount,
            invalidRequiredValueCount: snapshot.invalidRequiredValueCount,
            corruptFrames: snapshot.corruptFrames,
            discontinuities: snapshot.discontinuities,
            hasEndMarker: snapshot.hasEndMarker
        },
        tracking: summarizeTracking(snapshot.axisAccumulators),
        battery: summarizeBattery(snapshot),
        governor: summarizeGovernor(snapshot)
    };
}

export {
  buildActiveRanges,
  detectPitchPumps,
  mean,
  quantile,
  rms,
  summarizeBattery,
  summarizeGovernor,
  summarizeSnapshot,
  summarizeTracking
};
