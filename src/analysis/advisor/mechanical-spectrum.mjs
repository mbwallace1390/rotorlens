/**
 * Selected-range mechanical spectrum analysis.
 *
 * Ported from `js/advisor/mechanical_analysis.js` on the
 * `codex/cross-platform-foundation` branch of mbwallace1390/rotorflight-blackbox,
 * commit d07dd89d6276583615db0cfb43140c7cf8f70a9e, "feat(advisor): add
 * selected-range vibration analysis", 10 August 2026. Michael Wallace is its sole
 * author — no co-author and no sign-off trailers — and the file was new on that
 * branch rather than a modified upstream file, so the copyright is his to
 * relicense and it is MPL-2.0 here as the rest of RotorLens-authored source is.
 * The GPL of the repository it sat in binds recipients of that project, not the
 * author.
 *
 * See `docs/ARCHITECTURE_AND_PROVENANCE.md` for the record of that transfer.
 *
 * The original file carried the following voluntary design credit, which is
 * preserved for transparent provenance. No Propwash source expression was
 * copied, so this is not a third-party code or MIT notice obligation:
 *
 *   The timestamp-alignment and overlapping Hann/Welch architecture was informed
 *   by Iteratrix Propwash (MIT), revision
 *   804d3d5dd447c2e6067b02b7e1723aae8a19d5ff:
 *   https://github.com/Iteratrix/propwash
 *
 *   This implementation uses independently written PSD calibration, robust
 *   peak/persistence gates, Rotorflight rotor-speed correlation, and
 *   mechanics-first findings. It never recommends PID, governor, or filter
 *   setting changes.
 *
 * Converted from the UMD wrapper to an ES module mechanically by script rather
 * than by hand — a transcription slip in a spectral estimator is a measurement
 * bug, and a wrong FFT would mis-attribute vibration silently. The DSP chain
 * (`sampledIntervals` through `spectrumForAxis`), the peak and persistence
 * gates, the RPM correlation, and `analyzeCollected` are unchanged from the
 * source commit.
 *
 * Everything FlightLog-shaped was deleted rather than adapted, per CLAUDE.md:
 * `fieldIndex`, `finiteFrameValue`, `findGyroAxis`, `sameFinite`,
 * `sameCollectedFrame`, `collectFlightLogSelection`, `analyzeFlightLog`, and
 * `COLLECTION_WINDOW_US`. Their replacement is `mechanical-session.mjs`, written
 * against RotorLens' own decoded-session shape.
 *
 * Deliberate departures from the source, each one a safety property:
 *
 *  - `gyroSources` is required and validated. The source defaulted it to
 *    "gyroRAW", so a caller that omitted it had filtered data labelled
 *    unfiltered — and on the validation log that flipped the same 20 s of
 *    gyroADC samples from `insufficient` to `clear`. Identical samples,
 *    opposite safety verdict. It now throws.
 *  - Findings carry measurements only. Every `action` string is gone, and no
 *    title or summary is assembled by concatenating rounded numbers into prose,
 *    so this layer cannot grow a sentence that outruns its evidence.
 *  - `analyzedBandHz` and `attentionThreshold` are published on the result. The
 *    analysed band stops at 0.45·fs — 453 Hz on a 1 kHz log — and content above
 *    Nyquist folds into it. The band is a measurement, not a footnote.
 *  - `tuningEvidenceGate` is published and fails safe: it is only `permitted`
 *    on a `clear` status from verified unfiltered gyro. Attention evidence and
 *    insufficient evidence both block, because "no vibration was measured" and
 *    "vibration could not be measured" must not read the same to a guidance
 *    layer. Mechanical faults imitate tuning faults.
 *  - Cooperative yielding is opt-in and otherwise microtask-based. The source
 *    awaited `setTimeout` unconditionally; JS timers do not fire on a
 *    backgrounded Android WebView, and this engine runs in one.
 *  - `fftInPlace` asserts its power-of-two length. It silently produced garbage
 *    otherwise, and its only caller lives 300 lines away.
 *  - `bestHarmonicMatch` builds a fresh object instead of `delete`-ing a key
 *    off an object it also returns.
 *  - Rotor correlation reports three outcomes where the source reported two.
 *    A null match meant "uncorrelated" whether or not any rotor speed had been
 *    trustworthy enough to compare against, and on the validation log the
 *    untrustworthy case is the usual one — the rotor spools up inside the
 *    recording. `harmonicCorrelation` is now published on every result and the
 *    finding's `conclusion` is null where nothing was compared. See
 *    `harmonicCorrelationAvailability`, which carries a `state` of `evaluated`,
 *    `unavailable`, or `not-evaluated`. The third state is not decoration: this
 *    file previously reported `FIELD_MISSING` for it, which is a specific claim
 *    that the log has no `headspeed` column, on a log that has one throughout.
 *  - `summarizeMechanicalVibration` is the documented entry point for a screen.
 *    Nothing under `ui/` may need to know the shape of a Welch quality block to
 *    draw a peak list.
 *  - The two range errors no longer throw the viewer's UI wording. They named a
 *    control on another application's screen, and one of them was an
 *    instruction. See `normalizeRange`.
 *
 * Platform-neutral: Float64Array, Math, Number, Object, Promise. No Buffer, no
 * `node:*`, no DOM, no dependency of any kind.
 *
 * This module reports measurements. It contains no recommendation and nothing
 * here may grow one — see `src/analysis/pid-evidence.mjs` for why.
 */

import {buildMechanicalSeries, sessionTimeBounds} from './mechanical-session.mjs';

var AXIS_NAMES = ["roll", "pitch", "yaw"];

// 262.144 s. This was 120 s, inherited from the source with no derivation, and
// the derivation written here to justify keeping it did not reproduce. That
// comment claimed 120 s was where stationarity ends on the reference log — "the
// longest range that stays inside the 12% headspeed gate is 120 s, 13 s in to
// 133 s, spread 0.1055". Re-measured against the log's own headspeed column at
// 0.01 s resolution instead of the 1 s grid that produced it:
//
//   whole log (133.521805 s)          relative spread 0.62107  — fails the gate
//   12.74 s in, to the end of the log  spread 0.11914  — passes, 120.781805 s
//   12.73 s in, to the end of the log  spread 0.12025  — fails
//   13 s in, 120 s long                spread 0.10550  — passes, but is 0.78 s
//                                       short of the longest window there is
//
// So the longest stationary range on that log is 120.781805 s and the old cap
// rejected it by 0.78 s. Worse, its far edge is THE END OF THE RECORDING, not
// the stationarity gate: extending the end only ever adds plateau samples, which
// pushes the 5th percentile up and the spread down, so the search terminates at
// the last sample rather than at any property of the aircraft. Confirmed by
// sweeping every (start, end) pair on a 0.1 s grid — 81,792 evaluations, and the
// global maximum is that same window, ending at the last sample. The 120 s
// figure was a search-grid artefact of a 1 s start grid and a search that never
// looked past 120 s because 120 s was already the cap.
//
// Nothing derives a duration, so this no longer pretends to. What actually
// bounds the analysis is the sample count: `MAX_INPUT_SAMPLES` and
// `MAX_RESAMPLED_SAMPLES`, both 262144, and through them the wall clock. Measured
// on the reference log at 1006.7 Hz the analysis costs about 0.60 ms per second
// of selection on desktop Node (10 s: 7.5 ms, 60 s: 39.5 ms, 119 s: 71.3 ms), so
// the sample cap is reached at about 260 s and about 157 ms.
//
// This cap exists only so that the same ceiling applies at low log rates, where
// 262144 samples would be 73 minutes at 60 Hz, and it is set to the duration at
// which the sample cap binds at Rotorflight's nominal 1 kHz logging rate:
// 262144 / 1000 Hz = 262.144 s. Above 1 kHz the sample cap binds first; below it,
// this one does. That is the whole of its basis, and it is published as
// `maximumSelectionDurationBasis` so a caller is not left to infer a stronger one.
//
// It is NOT a stationarity gate and must not be read as one. Stationarity is a
// property of a particular range, it is measured per range, and it is reported
// per range as `rpmEvidence.headspeed.relativeSpread` against the 0.12 gate, with
// `harmonicCorrelation` saying whether the comparison happened at all. A range
// this cap admits may still be far too non-stationary to correlate against — the
// reference log's own first 120 s is, spread 0.64929 — and the result says so.
//
// One more consequence of a long range, published rather than implied:
// `chooseWindowStarts` averages at most `MAX_WELCH_WINDOWS` (128) windows, so
// past roughly 64*windowSize/sampleRate — about 33 s at any rate, since
// `chooseWindowSize` scales the window with the rate — the Welch average stops
// covering the range and starts sampling it. `windowCoverageRatio` on each axis
// is that fraction: 1.0 at 20 s on the reference log, 0.275 at 119 s.
var MAX_SELECTION_DURATION_US = 262144000;
var MAX_SELECTION_DURATION_BASIS =
    "input-sample-cap-at-nominal-1khz-log-rate";
var MAX_INPUT_SAMPLES = 262144;
var MAX_RESAMPLED_SAMPLES = 262144;
var MAX_SAMPLE_RATE_HZ = 8000;
var MAX_WELCH_WINDOWS = 128;
var MIN_WELCH_WINDOWS = 3;
var MIN_FREQUENCY_HZ = 5;
var MAX_FREQUENCY_HZ = 1000;
// Peak admission — the four constants that decide whether a bump in the spectrum
// is a peak at all, and therefore whether the amplitude threshold below ever
// gets to look at it. All four are inherited from the source commit with no
// derivation, and all four are UNCONSTRAINED BY REAL DATA.
//
// They are live on every flight: over the 33-flight corpus the pipeline admits
// 462 persistent peaks, of which 59 are attention-eligible. Swept one at a time
// over those same 33 flights, with the count of flights reading `clear` as the
// outcome (33 = nothing flagged, 1 = the shipped result):
//
//   PEAK_PROMINENCE_DB        4: 1 clear, 493 peaks   6: 1, 480   [8: 1, 462]
//                            12: 1 clear, 413 peaks  16: 4, 277
//   PEAK_RELATIVE_POWER_DB    4: 1 clear, 482 peaks   [8: 1, 462]  12: 1, 423
//   MIN_PERSISTENCE_RATIO   0.1: 1 clear            [0.25: 1]   0.5: 3   0.75: 12
//   MIN_ATTENTION_OCCUPIED_BUCKETS  1: 1 clear   2: 1   [3: 1]   4: 2
//
// Two things follow, and they were not knowable before. First, the verdict is
// NOT especially sensitive to what counts as a peak: halving or trebling the
// prominence requirement changes the peak count by a quarter and the verdict on
// no flight but one. Second, MIN_PERSISTENCE_RATIO is the exception — at 0.75 it
// moves 12 of 33 flights to clear, as much as raising the amplitude threshold
// from 8 to 12 dps does — so persistence and amplitude are comparably
// load-bearing and arguing about the amplitude alone is arguing about half the
// gate.
//
// SETTLED BY: the same two flights named on ATTENTION_BAND_RMS_THRESHOLD_DPS
// below, a tracked-and-balanced aircraft and the same aircraft with a deliberate
// track error. A tone that is genuinely there for the whole flight and a
// transient that is not are what these four exist to separate, and the corpus
// contains no case where anyone knows which of the two it was holding.
var PEAK_PROMINENCE_DB = 8;
var PEAK_RELATIVE_POWER_DB = 8;
var WINDOW_PRESENCE_DB = 6;
var MIN_PERSISTENCE_RATIO = 0.25;
var MIN_VALID_WINDOW_COVERAGE_RATIO = 0.75;
var MIN_FINITE_SAMPLE_COVERAGE_RATIO = 0.75;
var MIN_FINITE_TIME_SPAN_COVERAGE_RATIO = 0.75;
var ATTENTION_TIME_BUCKET_COUNT = 4;
var MIN_ATTENTION_OCCUPIED_BUCKETS = 3;
var MAX_ATTENTION_UNSUPPORTED_GAP_RATIO = 0.35;
// RotorLens experimental product gate, calibrated conservatively against
// the bundled synthetic clean/problem fixtures. This is not an official
// Rotorflight limit and does not diagnose a failed component.
//
// It is one synthetic-calibrated scalar deciding clear from attention, and
// attention is what suppresses tuning guidance, so it is published on every
// result alongside the measurement it gates rather than applied invisibly.
// Nothing in this project has established where it sits on an aircraft that is
// genuinely out of track: the only real log held sits 1.3x under it. Present it
// as a threshold with its basis attached, never as a pass or a fail.
//
// WHAT IT DOES ON REAL FLIGHTS, measured 13 August 2026 over 33 flights — 27 on
// an M4Max / RDMS NEXUS_XR, 5 on an OMP4MAX / FRSK VANTAC_RF007, and the Bell
// reference — each analysed over its own resolved flight window:
//
//   - It reads ATTENTION on 32 of the 33. The single clear flight is the
//     reference log, whose worst band RMS is 6.03 dps; 8 / 6.03 = 1.33, which is
//     the "1.3x under it" above, and it is the only flight in the corpus that
//     clears.
//   - What trips it is the main rotor's own tones. Of 462 persistent peaks, 59
//     are attention-eligible, and 53 of those are matched to a main-rotor
//     order — 21 at order 1 and 32 at order 2 — leaving 6 unattributed. Their
//     frequencies run 29.3 to 60.6 Hz against head fundamentals of 29.45 to
//     30.50 Hz. The module already names them (finding id
//     "mechanical-persistent-main-rotor-harmonic") and blocks tuning anyway, so
//     on real data this behaves as a rotor-track gate sitting below the
//     operating band of both aircraft in the corpus.
//   - Worst band RMS per flight: 6.03 / 10.03 / 11.51 / 13.26 / 17.33 dps
//     (min / p25 / median / p75 / max). Flights that would read clear at a
//     candidate threshold: 0 at 4 dps, 1 at 6, 1 at 8, 4 at 10, 12 at 12, 23 at
//     14, 28 at 16, 29 at 18.
//
// IT STAYS AT 8 AND STAYS UNCONSTRAINED BY REAL DATA. That last row is exactly
// the shape of number that must never be promoted to a limit: neither aircraft
// has been assessed by anyone for track, balance or bearing wear, and the corpus
// contains no known-bad case, so the distribution says what is COMMON on two
// unassessed helicopters and nothing about what is CORRECT. Raising it to 18
// because 29 of 33 flights then read clear would be calibrating a fault detector
// to the faults it exists to find. A 1/rev at 11 dps may well mean the blades
// need tracking.
//
// SETTLED BY: two flights on one aircraft a competent builder has just tracked
// and balanced — one as built, one with a deliberate 1-2 mm blade-track error.
// The threshold belongs between those two numbers and nowhere else. Until they
// exist, the separate question worth asking is whether a peak MATCHED to a rotor
// order at order 1 or 2 should suppress tuning at all, or should route to "get
// your blades tracked": this module already carries the evidence to tell those
// two cases apart, and on 29 of 33 flights that is the case it is deciding.
var ATTENTION_BAND_RMS_THRESHOLD_DPS = 8;
var ATTENTION_THRESHOLD_BASIS = "experimental-synthetic-calibration";
var MAX_PEAKS_PER_AXIS = 5;
var TARGET_FREQUENCY_RESOLUTION_HZ = 2;

// The labels a caller may attach to a gyro series. "gyroADC-filtered" is the
// only one that means the samples passed through the flight controller's filter
// chain, and it is the distinction the clear gate turns on, so an unrecognised
// label is rejected rather than coerced.
var MECHANICAL_GYRO_SOURCE_LABELS = Object.freeze([
    "gyroRAW",
    "gyroUnfilt",
    "gyroADC-filtered",
    "missing"
]);

var SOURCES = Object.freeze([
    Object.freeze({
        id: "rotorflight-filter-tuning",
        title: "Rotorflight First Flight & Filter Tuning",
        url: "https://rotorflight.org/docs/Tuning/First-Flight-Filter-Tuning"
    }),
    Object.freeze({
        id: "rotorflight-rpm-filters",
        title: "Rotorflight RPM Filters",
        url: "https://rotorflight.org/docs/2.2.0/setup/rpm-filters"
    })
]);

function codedError(ErrorType, code, message) {
    var error = new ErrorType(message);
    error.code = code;
    return error;
}

function checkCancelled(options) {
    if (options && typeof options.isCancelled === "function" && options.isCancelled()) {
        throw codedError(Error, "ANALYSIS_CANCELLED", "Mechanical analysis was cancelled");
    }
}

function reportProgress(options, phase, completed, total) {
    if (!options || typeof options.onProgress !== "function") {
        return;
    }
    try {
        options.onProgress({ phase: phase, completed: completed, total: total });
    } catch (error) {
        // Rendering progress must never invalidate a completed measurement.
    }
}

/**
 * Hands control back between phases.
 *
 * The source awaited a `setTimeout` in four loops. JS timers do not fire while
 * an Android Activity is paused, and this engine runs inside a WebView there, so
 * an unconditional timer await is a hang rather than a courtesy. Yielding to the
 * macrotask queue is now opt-in via `options.cooperativeYield`; otherwise this
 * resolves on the microtask queue, which is not timer-driven and always runs.
 */
function maybeYield(options) {
    if (options && options.cooperativeYield === true) {
        return new Promise(function(resolve) { setTimeout(resolve, 0); });
    }
    return null;
}

function round(value, digits) {
    if (!Number.isFinite(value)) {
        return null;
    }
    var scale = Math.pow(10, digits === undefined ? 3 : digits);
    return Math.round(value * scale) / scale;
}

function quantile(values, percentile) {
    if (!values || values.length === 0) {
        return null;
    }
    var sorted = Array.prototype.slice.call(values).filter(Number.isFinite)
        .sort(function(left, right) { return left - right; });
    if (sorted.length === 0) {
        return null;
    }
    var position = (sorted.length - 1) * Math.max(0, Math.min(1, percentile));
    var lower = Math.floor(position);
    var upper = Math.ceil(position);
    var fraction = position - lower;
    return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

function median(values) {
    return quantile(values, 0.5);
}

function addReason(reasons, code) {
    if (reasons.indexOf(code) === -1) {
        reasons.push(code);
    }
}

/**
 * Both messages here were the GPL viewer's own UI vocabulary and are not any
 * more.
 *
 * The source threw "Set finite graph In and Out markers before mechanical
 * analysis" and "The selected graph In/Out range is invalid for this log".
 * Nothing in RotorLens has an In or Out marker — those name a control on a
 * different application's screen — and the first is an imperative instruction,
 * which this layer does not issue about anything. Both are now statements of
 * fact in this repository's vocabulary. The codes are unchanged, because a
 * caller branches on the code and not on the prose.
 */
function normalizeRange(timeRangeUs, minimumTimeUs, maximumTimeUs) {
    if (!timeRangeUs
            || !Number.isFinite(timeRangeUs.startTimeUs)
            || !Number.isFinite(timeRangeUs.endTimeUs)) {
        throw codedError(
            RangeError,
            "ANALYSIS_RANGE_REQUIRED",
            "No finite time range was supplied for this analysis"
        );
    }
    if (timeRangeUs.startTimeUs >= timeRangeUs.endTimeUs
            || !Number.isFinite(minimumTimeUs)
            || !Number.isFinite(maximumTimeUs)
            || timeRangeUs.startTimeUs < minimumTimeUs
            || timeRangeUs.endTimeUs > maximumTimeUs) {
        throw codedError(
            RangeError,
            "ANALYSIS_RANGE_INVALID",
            "The requested time range lies outside this session"
        );
    }
    return Object.freeze({
        startTimeUs: timeRangeUs.startTimeUs,
        endTimeUs: timeRangeUs.endTimeUs
    });
}

function capabilities() {
    return Object.freeze({
        offline: true,
        selectedRangeRequired: true,
        selectedRangeOnly: true,
        rawLogIncluded: false,
        componentDiagnosis: false,
        tuningRecommendations: false,
        settingDirectionAdvice: false,
        directSettingWrites: false,
        // Carried forward from the source's own posture, which was already the
        // right one, plus what this port added: no finding carries an action
        // string and no title or summary is composed from measured numbers.
        physicalInspectionInstructions: false,
        composedProse: false
    });
}

/**
 * Whether a guidance layer may act on gain evidence for this range.
 *
 * Mechanical faults imitate tuning faults: a rotor harmonic and an over-gained
 * axis both show as oscillation in the gyro, and raising or lowering a gain in
 * response to the first one leaves the aircraft exactly as unairworthy while
 * looking like progress. So this is the interlock, and it fails safe.
 *
 * `permitted` requires a positive measurement of absence — a clear status,
 * which in turn requires unfiltered gyro verified on all three axes. Both
 * `attention` (vibration measured) and `insufficient` (vibration could not be
 * measured) block, because those two must never read the same downstream.
 *
 * This gates RotorLens' own output. It is not advice, and it writes nothing.
 */
function tuningEvidenceGate(status, reasonCodes) {
    if (status === "clear") {
        return {
            status: "permitted",
            reasonCodes: []
        };
    }
    return {
        status: "blocked",
        reasonCodes: (reasonCodes || []).slice()
    };
}

function baseResult(range, status, reasonCodes, sampleCount) {
    return {
        schemaVersion: 1,
        engineVersion: "0.1.0",
        analysisMode: "deterministic-local",
        capabilities: capabilities(),
        range: {
            startTimeUs: range.startTimeUs,
            endTimeUs: range.endTimeUs,
            durationUs: range.endTimeUs - range.startTimeUs,
            sampleCount: Number.isFinite(sampleCount) ? sampleCount : null
        },
        status: status,
        attention: status === "attention",
        available: status !== "insufficient",
        reasonCodes: reasonCodes.slice(),
        tuningEvidenceGate: tuningEvidenceGate(status, reasonCodes),
        attentionThreshold: {
            bandRmsDps: ATTENTION_BAND_RMS_THRESHOLD_DPS,
            basis: ATTENTION_THRESHOLD_BASIS,
            officialLimit: false
        },
        analyzedBandHz: null,
        quality: null,
        // NOT_EVALUATED, not FIELD_MISSING. This is the default on a result that
        // has not reached the rotor-speed step, and every result starts here —
        // including the ones that never get further. FIELD_MISSING is a claim
        // that the log does not carry the column, and stamping it before the
        // column has been read is a specific false negative standing in for
        // "nothing was checked". The reference log carries `headspeed`.
        rpmEvidence: {
            headspeed: unavailableRpmEvidence("headspeed", "NOT_EVALUATED"),
            tailspeed: unavailableRpmEvidence("tailspeed", "NOT_EVALUATED")
        },
        // Published on every result, including the ones that never got as far as
        // a spectrum, so a caller reading `harmonicMatch: null` always has the
        // fact that separates "not a rotor harmonic" from "the rotor was never
        // checked" sitting beside it. Defaults to not-evaluated: no range has
        // been correlated until one has.
        harmonicCorrelation: harmonicCorrelationAvailability(null),
        axes: [],
        findings: [],
        sources: SOURCES
    };
}

/**
 * Rotor-speed evidence for a rotor that produced none.
 *
 * `state` is the thing a caller must branch on and `reasonCode` is the detail.
 * They are separate because "not-evaluated" is not a fact about the log — it is
 * the absence of a reading — and every reasonCode this module has is a fact
 * about the log.
 */
function unavailableRpmEvidence(field, reason) {
    return {
        field: field,
        available: false,
        trustworthy: false,
        state: reason === "NOT_EVALUATED" ? "not-evaluated" : "unavailable",
        reasonCode: reason,
        sampleCount: 0,
        coverageRatio: 0,
        medianRpm: null,
        fundamentalHz: null,
        relativeSpread: null
    };
}

function insufficientResult(range, reasonCodes, sampleCount, detail) {
    var result = baseResult(range, "insufficient", reasonCodes, sampleCount);
    result.quality = {
        status: "insufficient",
        totalPossibleWindowCount: null,
        validWindowCount: null,
        validWindowCoverageRatio: null,
        finiteSampleCoverageRatio: null,
        finiteTimeSpanCoverageRatio: null,
        minimumCoverageRatio: MIN_VALID_WINDOW_COVERAGE_RATIO,
        attentionBandRmsThresholdDps: ATTENTION_BAND_RMS_THRESHOLD_DPS
    };
    Object.keys(detail || {}).forEach(function(key) {
        result.quality[key] = detail[key];
    });
    result.findings.push({
        id: "mechanical-analysis-insufficient",
        severity: "caution",
        // No `action`, and no summary assembled from rounded numbers. The
        // reason codes and the quality block below carry everything a caller
        // needs; prose composed here could only restate them less precisely.
        axis: null,
        timeRangeUs: [range.startTimeUs, range.endTimeUs],
        measurement: {
            reasonCodes: reasonCodes.slice(),
            conclusion: null
        },
        sourceIds: ["rotorflight-filter-tuning"]
    });
    return result;
}


function lowerBound(values, target) {
    var low = 0;
    var high = values.length;
    while (low < high) {
        var middle = (low + high) >>> 1;
        if (values[middle] < target) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

function upperBound(values, target) {
    var low = 0;
    var high = values.length;
    while (low < high) {
        var middle = (low + high) >>> 1;
        if (values[middle] <= target) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

/**
 * Requires an honest gyro-source label on every axis.
 *
 * The source defaulted a missing label to "gyroRAW". Measured on the validation
 * log over one 20 s range of gyroADC samples: labelled honestly the analysis
 * returns `insufficient` with FILTERED_GYRO_SOURCE_USED and
 * UNFILTERED_GYRO_REQUIRED_FOR_CLEAR_GATE and publishes no peaks; with the label
 * omitted the same samples return `clear` and report themselves as gyroRAW on
 * all three axes. Identical data, opposite safety verdict, and the wrong one is
 * the one that unblocks tuning guidance. There is no safe default, so there is
 * no default.
 */
function requireGyroSources(series) {
    var sources = series && series.gyroSources;
    if (!sources || typeof sources !== "object") {
        throw codedError(
            TypeError,
            "MECHANICAL_GYRO_SOURCES_REQUIRED",
            "series.gyroSources is required: an unlabelled gyro series cannot be "
                + "distinguished from an unfiltered one"
        );
    }
    var resolved = {};
    for (var index = 0; index < AXIS_NAMES.length; index++) {
        var axis = AXIS_NAMES[index];
        var label = sources[axis];
        if (MECHANICAL_GYRO_SOURCE_LABELS.indexOf(label) === -1) {
            throw codedError(
                TypeError,
                "MECHANICAL_GYRO_SOURCE_INVALID",
                "series.gyroSources." + axis + " must be one of "
                    + MECHANICAL_GYRO_SOURCE_LABELS.join(", ") + ", received "
                    + JSON.stringify(label)
            );
        }
        resolved[axis] = label;
    }
    return resolved;
}

async function collectTimeSeriesSelection(series, range, options) {
    var times = series && series.timeUs;
    if (!times || typeof times.length !== "number" || times.length === 0) {
        return {
            timeUs: [], gyro: [], headspeedRpm: [], tailspeedRpm: [],
            nonMonotonicTimestampCount: 0, duplicateTimestampCount: 0,
            limitExceeded: false
        };
    }
    var start = lowerBound(times, range.startTimeUs);
    var end = upperBound(times, range.endTimeUs);
    var axisInputs = series.gyro || {};
    var sources = requireGyroSources(series);
    var collected = {
        timeUs: [],
        gyro: AXIS_NAMES.map(function(axis) {
            return {
                axis: axis,
                source: sources[axis],
                values: []
            };
        }),
        headspeedRpm: [],
        tailspeedRpm: [],
        nonMonotonicTimestampCount: 0,
        duplicateTimestampCount: 0,
        limitExceeded: false
    };
    reportProgress(options, "collect", 0, Math.max(1, end - start));
    for (var index = start; index < end; index++) {
        var timeUs = times[index];
        if (!Number.isFinite(timeUs)) {
            continue;
        }
        var lastTimeUs = collected.timeUs.length
            ? collected.timeUs[collected.timeUs.length - 1]
            : null;
        if (lastTimeUs !== null && timeUs <= lastTimeUs) {
            if (timeUs === lastTimeUs) {
                collected.duplicateTimestampCount++;
            } else {
                collected.nonMonotonicTimestampCount++;
            }
            continue;
        }
        if (collected.timeUs.length >= MAX_INPUT_SAMPLES) {
            collected.limitExceeded = true;
            return collected;
        }
        collected.timeUs.push(timeUs);
        AXIS_NAMES.forEach(function(axis, axisIndex) {
            var values = axisInputs[axis] || axisInputs[axisIndex] || [];
            collected.gyro[axisIndex].values.push(
                Number.isFinite(values[index]) ? values[index] : NaN
            );
        });
        collected.headspeedRpm.push(
            series.headspeedRpm && Number.isFinite(series.headspeedRpm[index])
                ? series.headspeedRpm[index] : NaN
        );
        collected.tailspeedRpm.push(
            series.tailspeedRpm && Number.isFinite(series.tailspeedRpm[index])
                ? series.tailspeedRpm[index] : NaN
        );
        if (((index - start) & 2047) === 0) {
            checkCancelled(options);
        }
    }
    reportProgress(options, "collect", Math.max(1, end - start), Math.max(1, end - start));
    await maybeYield(options);
    return collected;
}

function sampledIntervals(timeUs) {
    var intervals = [];
    var stride = Math.max(1, Math.ceil((timeUs.length - 1) / 8192));
    for (var index = stride; index < timeUs.length; index += stride) {
        var deltaUs = (timeUs[index] - timeUs[index - stride]) / stride;
        if (Number.isFinite(deltaUs) && deltaUs > 0) {
            intervals.push(deltaUs);
        }
    }
    return intervals;
}

function chooseWindowSize(sampleRateHz, sampleCount) {
    var target = Math.ceil(sampleRateHz / TARGET_FREQUENCY_RESOLUTION_HZ);
    var size = 1;
    while (size < target) {
        size *= 2;
    }
    size = Math.max(256, Math.min(4096, size));
    while (size > 256 && sampleCount < size + (size / 2) * (MIN_WELCH_WINDOWS - 1)) {
        size /= 2;
    }
    return size;
}

function resampleLinear(timeUs, values, firstTimeUs, sampleIntervalUs, count, maxGapUs) {
    var output = new Float64Array(count);
    var cursor = 0;
    for (var outputIndex = 0; outputIndex < count; outputIndex++) {
        var targetTimeUs = firstTimeUs + outputIndex * sampleIntervalUs;
        if (targetTimeUs < timeUs[0] || targetTimeUs > timeUs[timeUs.length - 1]) {
            output[outputIndex] = NaN;
            continue;
        }
        while (cursor + 1 < timeUs.length && timeUs[cursor + 1] < targetTimeUs) {
            cursor++;
        }
        if (cursor >= timeUs.length || !Number.isFinite(values[cursor])) {
            output[outputIndex] = NaN;
        } else if (timeUs[cursor] === targetTimeUs || cursor + 1 >= timeUs.length) {
            output[outputIndex] = values[cursor];
        } else {
            var next = cursor + 1;
            var spanUs = timeUs[next] - timeUs[cursor];
            if (spanUs <= 0 || spanUs > maxGapUs || !Number.isFinite(values[next])) {
                output[outputIndex] = NaN;
            } else {
                var fraction = (targetTimeUs - timeUs[cursor]) / spanUs;
                output[outputIndex] = values[cursor]
                    + (values[next] - values[cursor]) * fraction;
            }
        }
    }
    return output;
}

function hannWindow(size) {
    var result = new Float64Array(size);
    var sumSquares = 0;
    for (var index = 0; index < size; index++) {
        var value = 0.5 * (1 - Math.cos(2 * Math.PI * index / (size - 1)));
        result[index] = value;
        sumSquares += value * value;
    }
    return { values: result, sumSquares: sumSquares };
}

function fftInPlace(real, imaginary) {
    var size = real.length;
    // Radix-2 Cooley-Tukey. A non-power-of-two length does not fail here, it
    // returns confident garbage: the bit-reversal permutation and the butterfly
    // strides both assume it. `chooseWindowSize` guarantees it today, but that
    // guarantee lives 300 lines away and nothing enforced it in between.
    if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
        throw codedError(
            RangeError,
            "FFT_LENGTH_NOT_POWER_OF_TWO",
            "FFT length must be a power of two, received " + size
        );
    }
    if (imaginary.length !== size) {
        throw codedError(
            RangeError,
            "FFT_LENGTH_MISMATCH",
            "FFT real and imaginary buffers must be the same length"
        );
    }
    var j = 0;
    for (var i = 1; i < size; i++) {
        var bit = size >> 1;
        while (j & bit) {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if (i < j) {
            var realSwap = real[i];
            real[i] = real[j];
            real[j] = realSwap;
            var imagSwap = imaginary[i];
            imaginary[i] = imaginary[j];
            imaginary[j] = imagSwap;
        }
    }
    for (var length = 2; length <= size; length <<= 1) {
        var angle = -2 * Math.PI / length;
        var baseReal = Math.cos(angle);
        var baseImaginary = Math.sin(angle);
        for (var start = 0; start < size; start += length) {
            var twiddleReal = 1;
            var twiddleImaginary = 0;
            for (var offset = 0; offset < length / 2; offset++) {
                var even = start + offset;
                var odd = even + length / 2;
                var oddReal = real[odd] * twiddleReal
                    - imaginary[odd] * twiddleImaginary;
                var oddImaginary = real[odd] * twiddleImaginary
                    + imaginary[odd] * twiddleReal;
                real[odd] = real[even] - oddReal;
                imaginary[odd] = imaginary[even] - oddImaginary;
                real[even] += oddReal;
                imaginary[even] += oddImaginary;
                var nextTwiddleReal = twiddleReal * baseReal
                    - twiddleImaginary * baseImaginary;
                twiddleImaginary = twiddleReal * baseImaginary
                    + twiddleImaginary * baseReal;
                twiddleReal = nextTwiddleReal;
            }
        }
    }
}

function chooseWindowStarts(samples, windowSize) {
    var step = windowSize / 2;
    var candidates = [];
    var totalPossible = 0;
    for (var start = 0; start + windowSize <= samples.length; start += step) {
        totalPossible++;
        var valid = true;
        for (var index = start; index < start + windowSize; index++) {
            if (!Number.isFinite(samples[index])) {
                valid = false;
                break;
            }
        }
        if (valid) {
            candidates.push(start);
        }
    }
    if (candidates.length <= MAX_WELCH_WINDOWS) {
        return {
            totalPossible: totalPossible,
            candidates: candidates.length,
            starts: candidates
        };
    }
    var selected = [];
    for (var selectedIndex = 0; selectedIndex < MAX_WELCH_WINDOWS; selectedIndex++) {
        var candidateIndex = Math.round(
            selectedIndex * (candidates.length - 1) / (MAX_WELCH_WINDOWS - 1)
        );
        selected.push(candidates[candidateIndex]);
    }
    return {
        totalPossible: totalPossible,
        candidates: candidates.length,
        starts: selected
    };
}

function localMedian(psd, bin, radius, exclusion) {
    var values = [];
    var start = Math.max(1, bin - radius);
    var end = Math.min(psd.length - 1, bin + radius);
    for (var index = start; index <= end; index++) {
        if (Math.abs(index - bin) > exclusion && Number.isFinite(psd[index])) {
            values.push(psd[index]);
        }
    }
    return median(values);
}

function dbRatio(numerator, denominator) {
    var floor = 1e-30;
    return 10 * Math.log10(Math.max(floor, numerator) / Math.max(floor, denominator));
}

function peakBandwidth(psd, peakBin, frequencyResolutionHz) {
    var threshold = psd[peakBin] / 2;
    var left = peakBin;
    var right = peakBin;
    while (left > 1 && psd[left - 1] >= threshold) {
        left--;
    }
    while (right + 1 < psd.length && psd[right + 1] >= threshold) {
        right++;
    }
    return {
        leftBin: left,
        rightBin: right,
        bandwidthHz: Math.max(frequencyResolutionHz, (right - left + 1) * frequencyResolutionHz)
    };
}

function detectPeaks(psd, windowPsd, windowStarts, sampleCount, sampleRateHz, windowSize) {
    var frequencyResolutionHz = sampleRateHz / windowSize;
    var minimumBin = Math.max(1, Math.ceil(MIN_FREQUENCY_HZ / frequencyResolutionHz));
    var maximumHz = Math.min(MAX_FREQUENCY_HZ, sampleRateHz * 0.45);
    var maximumBin = Math.min(psd.length - 2, Math.floor(maximumHz / frequencyResolutionHz));
    var bandValues = [];
    for (var bandBin = minimumBin; bandBin <= maximumBin; bandBin++) {
        bandValues.push(psd[bandBin]);
    }
    var globalFloor = median(bandValues);
    var candidates = [];
    var radius = Math.max(6, Math.round(12 / frequencyResolutionHz));
    var exclusion = Math.max(1, Math.round(2 / frequencyResolutionHz));
    for (var bin = minimumBin; bin <= maximumBin; bin++) {
        if (!(psd[bin] > psd[bin - 1] && psd[bin] >= psd[bin + 1])) {
            continue;
        }
        var noiseFloor = localMedian(psd, bin, radius, exclusion);
        var prominenceDb = dbRatio(psd[bin], noiseFloor);
        var relativePowerDb = dbRatio(psd[bin], globalFloor);
        if (prominenceDb < PEAK_PROMINENCE_DB
                || relativePowerDb < PEAK_RELATIVE_POWER_DB) {
            continue;
        }
        var supportingWindowCount = 0;
        for (var windowIndex = 0; windowIndex < windowPsd.length; windowIndex++) {
            var row = windowPsd[windowIndex];
            var rowPeak = Math.max(
                row[Math.max(1, bin - 1)],
                row[bin],
                row[Math.min(row.length - 1, bin + 1)]
            );
            var rowFloor = localMedian(row, bin, radius, exclusion);
            if (dbRatio(rowPeak, rowFloor) >= WINDOW_PRESENCE_DB) {
                supportingWindowCount++;
            }
        }
        var persistenceRatio = windowPsd.length > 0
            ? supportingWindowCount / windowPsd.length : 0;
        var requiredWindows = Math.max(
            MIN_WELCH_WINDOWS,
            Math.ceil(windowPsd.length * MIN_PERSISTENCE_RATIO)
        );
        if (supportingWindowCount < requiredWindows) {
            continue;
        }
        var bandwidth = peakBandwidth(psd, bin, frequencyResolutionHz);
        var bandPower = 0;
        for (var powerBin = bandwidth.leftBin;
                powerBin <= bandwidth.rightBin; powerBin++) {
            bandPower += psd[powerBin] * frequencyResolutionHz;
        }
        // The averaged Welch spectrum can be raised by one short event.
        // Require the absolute 8 deg/s band-RMS gate to pass in the same
        // minimum number of individual windows before it can block tuning.
        var attentionSupportingWindowCount = 0;
        var firstAttentionWindow = null;
        var lastAttentionWindow = null;
        var attentionWindowStarts = [];
        for (var attentionWindowIndex = 0;
                attentionWindowIndex < windowPsd.length; attentionWindowIndex++) {
            var attentionRow = windowPsd[attentionWindowIndex];
            var attentionBandPower = 0;
            for (var attentionBin = bandwidth.leftBin;
                    attentionBin <= bandwidth.rightBin; attentionBin++) {
                attentionBandPower += attentionRow[attentionBin]
                    * frequencyResolutionHz;
            }
            if (Math.sqrt(Math.max(0, attentionBandPower))
                    >= ATTENTION_BAND_RMS_THRESHOLD_DPS) {
                attentionSupportingWindowCount++;
                if (firstAttentionWindow === null) {
                    firstAttentionWindow = attentionWindowIndex;
                }
                lastAttentionWindow = attentionWindowIndex;
                attentionWindowStarts.push(windowStarts[attentionWindowIndex]);
            }
        }
        var attentionPersistenceRatio = windowPsd.length > 0
            ? attentionSupportingWindowCount / windowPsd.length : 0;
        var attentionTemporalSpanRatio = firstAttentionWindow === null
            ? 0
            : (lastAttentionWindow - firstAttentionWindow + 1) / windowPsd.length;
        attentionTemporalSpanRatio = round(attentionTemporalSpanRatio, 3);
        var occupiedBuckets = Object.create(null);
        var maximumWindowStart = Math.max(1, sampleCount - windowSize);
        attentionWindowStarts.forEach(function(attentionStart) {
            var bucket = Math.min(
                ATTENTION_TIME_BUCKET_COUNT - 1,
                Math.floor(attentionStart * ATTENTION_TIME_BUCKET_COUNT
                    / (maximumWindowStart + 1))
            );
            occupiedBuckets[bucket] = true;
        });
        var attentionOccupiedBucketCount = Object.keys(occupiedBuckets).length;
        var evaluatedStepSizes = [];
        for (var evaluatedIndex = 1; evaluatedIndex < windowStarts.length;
                evaluatedIndex++) {
            evaluatedStepSizes.push(
                windowStarts[evaluatedIndex] - windowStarts[evaluatedIndex - 1]
            );
        }
        var nominalEvaluatedStep = median(evaluatedStepSizes) || windowSize / 2;
        var maximumUnsupportedGapSamples = 0;
        for (var supportIndex = 1; supportIndex < attentionWindowStarts.length;
                supportIndex++) {
            maximumUnsupportedGapSamples = Math.max(
                maximumUnsupportedGapSamples,
                Math.max(0, attentionWindowStarts[supportIndex]
                    - attentionWindowStarts[supportIndex - 1]
                    - nominalEvaluatedStep)
            );
        }
        var attentionMaximumGapRatio = round(
            maximumUnsupportedGapSamples / maximumWindowStart,
            3
        );
        candidates.push({
            bin: bin,
            frequencyHz: bin * frequencyResolutionHz,
            psdDps2PerHz: psd[bin],
            localNoisePsdDps2PerHz: noiseFloor,
            relativePowerDb: relativePowerDb,
            prominenceDb: prominenceDb,
            bandwidthHz: bandwidth.bandwidthHz,
            bandPowerDps2: bandPower,
            bandRmsDps: Math.sqrt(Math.max(0, bandPower)),
            supportingWindowCount: supportingWindowCount,
            evaluatedWindowCount: windowPsd.length,
            persistenceRatio: persistenceRatio,
            attentionSupportingWindowCount: attentionSupportingWindowCount,
            attentionPersistenceRatio: attentionPersistenceRatio,
            attentionTemporalSpanRatio: attentionTemporalSpanRatio,
            attentionOccupiedBucketCount: attentionOccupiedBucketCount,
            attentionMaximumGapRatio: attentionMaximumGapRatio,
            attentionEligible: attentionSupportingWindowCount >= requiredWindows
                && attentionTemporalSpanRatio >= 0.5
                && attentionOccupiedBucketCount >= MIN_ATTENTION_OCCUPIED_BUCKETS
                && attentionMaximumGapRatio <= MAX_ATTENTION_UNSUPPORTED_GAP_RATIO,
            harmonicMatch: null
        });
    }
    candidates.sort(function(left, right) {
        if (right.persistenceRatio !== left.persistenceRatio) {
            return right.persistenceRatio - left.persistenceRatio;
        }
        return right.prominenceDb - left.prominenceDb;
    });
    var selected = [];
    candidates.forEach(function(candidate) {
        var tooClose = selected.some(function(existing) {
            var separation = Math.max(
                frequencyResolutionHz * 2,
                Math.min(candidate.frequencyHz, existing.frequencyHz) * 0.025
            );
            return Math.abs(candidate.frequencyHz - existing.frequencyHz) < separation;
        });
        if (!tooClose && selected.length < MAX_PEAKS_PER_AXIS) {
            selected.push(candidate);
        }
    });
    return { peaks: selected, globalNoiseFloor: globalFloor, maximumHz: maximumHz };
}

async function spectrumForAxis(
    axisInfo,
    samples,
    sampleRateHz,
    windowSize,
    resampledStartTimeUs,
    sampleIntervalUs,
    selectedRange,
    options
) {
    var selection = chooseWindowStarts(samples, windowSize);
    var windowStarts = selection.starts;
    var sum = 0;
    var sumSquares = 0;
    var finiteCount = 0;
    var firstFiniteIndex = null;
    var lastFiniteIndex = null;
    for (var sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
        if (Number.isFinite(samples[sampleIndex])) {
            sum += samples[sampleIndex];
            sumSquares += samples[sampleIndex] * samples[sampleIndex];
            finiteCount++;
            if (firstFiniteIndex === null) {
                firstFiniteIndex = sampleIndex;
            }
            lastFiniteIndex = sampleIndex;
        }
    }
    var finiteSampleCoverageRatio = samples.length > 0
        ? finiteCount / samples.length : 0;
    var firstFiniteSampleTimeUs = firstFiniteIndex === null
        ? null : resampledStartTimeUs + firstFiniteIndex * sampleIntervalUs;
    var lastFiniteSampleTimeUs = lastFiniteIndex === null
        ? null : resampledStartTimeUs + lastFiniteIndex * sampleIntervalUs;
    var selectedDurationUs = selectedRange.endTimeUs - selectedRange.startTimeUs;
    var finiteTimeSpanCoverageRatio = firstFiniteSampleTimeUs === null
            || lastFiniteSampleTimeUs === null || selectedDurationUs <= 0
        ? 0
        : Math.min(
            1,
            Math.max(0, lastFiniteSampleTimeUs - firstFiniteSampleTimeUs)
                / selectedDurationUs
        );
    var leadingFiniteGapUs = firstFiniteSampleTimeUs === null
        ? selectedDurationUs
        : Math.max(0, firstFiniteSampleTimeUs - selectedRange.startTimeUs);
    var trailingFiniteGapUs = lastFiniteSampleTimeUs === null
        ? selectedDurationUs
        : Math.max(0, selectedRange.endTimeUs - lastFiniteSampleTimeUs);
    var validWindowCoverageRatio = selection.totalPossible > 0
        ? selection.candidates / selection.totalPossible : 0;
    if (windowStarts.length < MIN_WELCH_WINDOWS) {
        return {
            axis: axisInfo.axis,
            source: axisInfo.source,
            available: false,
            reasonCode: "INSUFFICIENT_CONTIGUOUS_GYRO_DATA",
            windowCount: windowStarts.length,
            candidateWindowCount: selection.candidates,
            totalPossibleWindowCount: selection.totalPossible,
            validWindowCount: selection.candidates,
            validWindowCoverageRatio: validWindowCoverageRatio,
            finiteSampleCoverageRatio: finiteSampleCoverageRatio,
            finiteTimeSpanCoverageRatio: finiteTimeSpanCoverageRatio,
            firstFiniteSampleTimeUs: firstFiniteSampleTimeUs,
            lastFiniteSampleTimeUs: lastFiniteSampleTimeUs,
            leadingFiniteGapUs: leadingFiniteGapUs,
            trailingFiniteGapUs: trailingFiniteGapUs,
            peaks: []
        };
    }
    var hann = hannWindow(windowSize);
    var binCount = windowSize / 2 + 1;
    var averagedPsd = new Float64Array(binCount);
    var windowPsd = [];
    var mean = finiteCount ? sum / finiteCount : 0;
    var acVariance = finiteCount
        ? Math.max(0, sumSquares / finiteCount - mean * mean) : 0;
    for (var windowIndex = 0; windowIndex < windowStarts.length; windowIndex++) {
        checkCancelled(options);
        var start = windowStarts[windowIndex];
        var windowMean = 0;
        for (var meanIndex = 0; meanIndex < windowSize; meanIndex++) {
            windowMean += samples[start + meanIndex];
        }
        windowMean /= windowSize;
        var real = new Float64Array(windowSize);
        var imaginary = new Float64Array(windowSize);
        for (var fftIndex = 0; fftIndex < windowSize; fftIndex++) {
            real[fftIndex] = (samples[start + fftIndex] - windowMean)
                * hann.values[fftIndex];
        }
        fftInPlace(real, imaginary);
        var row = new Float64Array(binCount);
        for (var bin = 0; bin < binCount; bin++) {
            var power = (real[bin] * real[bin] + imaginary[bin] * imaginary[bin])
                / (sampleRateHz * hann.sumSquares);
            if (bin > 0 && bin < windowSize / 2) {
                power *= 2;
            }
            row[bin] = power;
            averagedPsd[bin] += power;
        }
        windowPsd.push(row);
        if ((windowIndex & 7) === 7) {
            await maybeYield(options);
        }
    }
    for (var averageBin = 0; averageBin < binCount; averageBin++) {
        averagedPsd[averageBin] /= windowStarts.length;
    }
    var detected = detectPeaks(
        averagedPsd,
        windowPsd,
        windowStarts,
        samples.length,
        sampleRateHz,
        windowSize
    );
    var resolutionHz = sampleRateHz / windowSize;
    var broadbandPower = 0;
    var maximumPowerBin = Math.min(
        averagedPsd.length - 1,
        Math.floor(detected.maximumHz / resolutionHz)
    );
    for (var integrationBin = 1; integrationBin <= maximumPowerBin; integrationBin++) {
        broadbandPower += averagedPsd[integrationBin] * resolutionHz;
    }
    return {
        axis: axisInfo.axis,
        source: axisInfo.source,
        amplitudeKind: axisInfo.source === "gyroADC-filtered"
            ? "filtered-gyro-output" : "unfiltered-gyro-output",
        available: true,
        reasonCode: null,
        sampleCount: finiteCount,
        rmsDps: Math.sqrt(acVariance),
        broadbandPowerDps2: broadbandPower,
        broadbandRmsDps: Math.sqrt(Math.max(0, broadbandPower)),
        medianNoisePsdDps2PerHz: detected.globalNoiseFloor,
        windowCount: windowStarts.length,
        candidateWindowCount: selection.candidates,
        totalPossibleWindowCount: selection.totalPossible,
        validWindowCount: selection.candidates,
        validWindowCoverageRatio: validWindowCoverageRatio,
        finiteSampleCoverageRatio: finiteSampleCoverageRatio,
        finiteTimeSpanCoverageRatio: finiteTimeSpanCoverageRatio,
        firstFiniteSampleTimeUs: firstFiniteSampleTimeUs,
        lastFiniteSampleTimeUs: lastFiniteSampleTimeUs,
        leadingFiniteGapUs: leadingFiniteGapUs,
        trailingFiniteGapUs: trailingFiniteGapUs,
        windowCoverageRatio: selection.candidates > 0
            ? windowStarts.length / selection.candidates : 0,
        peaks: detected.peaks
    };
}

function rpmEvidence(values, field, range, totalSamples) {
    var finite = [];
    var firstIndex = null;
    var lastIndex = null;
    // Counted separately from the admitted values. A cell that is finite but
    // outside (0, 50000] — a stopped rotor logs 0 — proves the column is there.
    var presentCount = 0;
    for (var index = 0; index < values.length; index++) {
        if (Number.isFinite(values[index])) {
            presentCount++;
        }
        if (Number.isFinite(values[index]) && values[index] > 0 && values[index] <= 50000) {
            finite.push(values[index]);
            if (firstIndex === null) {
                firstIndex = index;
            }
            lastIndex = index;
        }
    }
    if (finite.length === 0) {
        // Same distinction, one level down. FIELD_MISSING is a fact about the
        // log; "the rotor was not turning across this range" is a fact about the
        // range. `buildMechanicalSeries` fills an absent column with NaN, so no
        // finite cell at all is the only shape that means the column is absent.
        // On the reference log the first 4 s carry 4,028 finite headspeed cells
        // and not one admissible rotor speed, and calling that FIELD_MISSING
        // describes a column the log demonstrably has.
        return unavailableRpmEvidence(
            field,
            presentCount > 0 ? "NO_VALID_RPM_IN_RANGE" : "FIELD_MISSING"
        );
    }
    var medianRpm = median(finite);
    var p05 = quantile(finite, 0.05);
    var p95 = quantile(finite, 0.95);
    var relativeSpread = medianRpm > 0 ? (p95 - p05) / medianRpm : Infinity;
    var coverageRatio = totalSamples > 0 ? finite.length / totalSamples : 0;
    var minimumRequired = Math.max(20, Math.ceil(totalSamples * 0.8));
    var reason = null;
    if (finite.length < minimumRequired || coverageRatio < 0.8) {
        reason = "INSUFFICIENT_COVERAGE";
    } else if (medianRpm < 100 || medianRpm > 50000) {
        reason = "RPM_OUT_OF_RANGE";
    } else if (relativeSpread > 0.12) {
        reason = "RPM_UNSTABLE_IN_SELECTION";
    }
    return {
        field: field,
        available: true,
        trustworthy: reason === null,
        state: reason === null ? "trustworthy" : "unavailable",
        reasonCode: reason,
        sampleCount: finite.length,
        coverageRatio: coverageRatio,
        medianRpm: medianRpm,
        p05Rpm: p05,
        p95Rpm: p95,
        fundamentalHz: reason === null ? medianRpm / 60 : null,
        relativeSpread: relativeSpread,
        timeRangeUs: [range.startTimeUs, range.endTimeUs]
    };
}

/**
 * Whether rotor-harmonic correlation was possible for this range at all.
 *
 * `bestHarmonicMatch` returns null for two different reasons and the difference
 * is the whole value of this module. Either the rotor speed was trustworthy and
 * no order lined up — the peak is genuinely not a rotor harmonic — or no rotor
 * speed was trustworthy, in which case nothing was compared and no statement
 * about the rotor is available. Collapsing those two into one null tells a pilot
 * "this vibration is not your main rotor" on a range where the rotor was never
 * checked, which sends them to the tail, the frame, or the servos.
 *
 * This is not hypothetical on the only real log this project owns. The rotor
 * spools up and down inside it, so `rpmEvidence` reports
 * RPM_UNSTABLE_IN_SELECTION over most ranges: headspeed relative spread is
 * 0.6211 across the whole 133.5 s against a 0.12 gate, and 0.9466 over the first
 * 10 s. Only a range that excludes the spool-up is stationary enough to correlate
 * against — measured, the longest one is 120 s starting 13 s in, spread 0.1055,
 * and on that range the strongest peak (pitch, 57.02 Hz, 5.812 dps) does
 * correlate, to main-rotor order 2, which is what a two-bladed head predicts.
 *
 * So this is reported as its own fact rather than inferred from a null.
 *
 * There are three states, not two, and the third is the one this function used
 * to get wrong. Called with no rotor evidence at all — which is every result
 * that never reached the rotor-speed step — it stamped `FIELD_MISSING` on both
 * rotors. That is not "nothing was checked", it is the specific claim that the
 * log does not carry a `headspeed` column, and the reference log carries one on
 * all 134,429 samples. Substituting a named negative for an absent reading is
 * exactly the error the rest of this function exists to prevent, one level up.
 *
 *   state "evaluated"     at least one rotor speed was trustworthy and compared
 *   state "unavailable"   rotor speeds were read and none was trustworthy;
 *                         `unavailableRotors` carries the measured reason
 *   state "not-evaluated" no rotor speed was read at all, so there is no reason
 *                         to give beyond NOT_EVALUATED
 *
 * `evaluated` stays a boolean and stays true only in the first state, so callers
 * written against the old shape keep the meaning they had.
 */
function harmonicCorrelationAvailability(rpmSources) {
    if (!rpmSources) {
        return Object.freeze({
            state: "not-evaluated",
            evaluated: false,
            evaluatedRotors: Object.freeze([]),
            unavailableRotors: Object.freeze([
                { field: "headspeed", reasonCode: "NOT_EVALUATED" },
                { field: "tailspeed", reasonCode: "NOT_EVALUATED" }
            ])
        });
    }
    var evaluatedRotors = [];
    var unavailableRotors = [];
    ["headspeed", "tailspeed"].forEach(function(rotor) {
        var evidence = rpmSources[rotor];
        if (evidence && evidence.trustworthy) {
            evaluatedRotors.push(rotor);
        } else {
            unavailableRotors.push({
                field: rotor,
                // An entry with no evidence object at all is not a missing
                // field either; it is a rotor this call was not given.
                reasonCode: (evidence && evidence.reasonCode) || "NOT_EVALUATED"
            });
        }
    });
    return Object.freeze({
        state: evaluatedRotors.length > 0 ? "evaluated" : "unavailable",
        evaluated: evaluatedRotors.length > 0,
        evaluatedRotors: Object.freeze(evaluatedRotors),
        unavailableRotors: Object.freeze(unavailableRotors)
    });
}

function bestHarmonicMatch(peak, rpmSources, frequencyResolutionHz) {
    var matches = [];
    ["headspeed", "tailspeed"].forEach(function(rotor) {
        var evidence = rpmSources[rotor];
        if (!evidence || !evidence.trustworthy) {
            return;
        }
        var maximumOrder = rotor === "headspeed" ? 8 : 6;
        for (var order = 1; order <= maximumOrder; order++) {
            var predictedHz = evidence.fundamentalHz * order;
            var spreadHz = evidence.relativeSpread * predictedHz / 2;
            var toleranceHz = Math.max(
                frequencyResolutionHz * 1.5,
                predictedHz * 0.025,
                spreadHz
            );
            var deltaHz = Math.abs(peak.frequencyHz - predictedHz);
            if (deltaHz <= toleranceHz) {
                matches.push({
                    rotor: rotor === "headspeed" ? "main" : "tail",
                    order: order,
                    predictedHz: predictedHz,
                    deltaHz: deltaHz,
                    toleranceHz: toleranceHz,
                    normalizedError: deltaHz / toleranceHz
                });
            }
        }
    });
    matches.sort(function(left, right) {
        return left.normalizedError - right.normalizedError;
    });
    if (matches.length === 0) {
        return null;
    }
    // Build a fresh object rather than `delete`-ing the ranking key off one that
    // is also returned; a hot path should not hand back a mutated sort record.
    var best = matches[0];
    return {
        rotor: best.rotor,
        order: best.order,
        predictedHz: best.predictedHz,
        deltaHz: best.deltaHz,
        toleranceHz: best.toleranceHz
    };
}

function compactPeak(peak) {
    return {
        frequencyHz: round(peak.frequencyHz, 2),
        psdDps2PerHz: round(peak.psdDps2PerHz, 6),
        localNoisePsdDps2PerHz: round(peak.localNoisePsdDps2PerHz, 6),
        relativePowerDb: round(peak.relativePowerDb, 2),
        prominenceDb: round(peak.prominenceDb, 2),
        bandwidthHz: round(peak.bandwidthHz, 2),
        bandPowerDps2: round(peak.bandPowerDps2, 4),
        bandRmsDps: round(peak.bandRmsDps, 3),
        supportingWindowCount: peak.supportingWindowCount,
        evaluatedWindowCount: peak.evaluatedWindowCount,
        persistenceRatio: round(peak.persistenceRatio, 3),
        attentionSupportingWindowCount: peak.attentionSupportingWindowCount,
        attentionPersistenceRatio: round(peak.attentionPersistenceRatio, 3),
        attentionTemporalSpanRatio: round(peak.attentionTemporalSpanRatio, 3),
        attentionOccupiedBucketCount: peak.attentionOccupiedBucketCount,
        attentionMaximumGapRatio: round(peak.attentionMaximumGapRatio, 3),
        attentionEligible: peak.attentionEligible === true,
        harmonicMatch: peak.harmonicMatch ? {
            rotor: peak.harmonicMatch.rotor,
            order: peak.harmonicMatch.order,
            predictedHz: round(peak.harmonicMatch.predictedHz, 2),
            deltaHz: round(peak.harmonicMatch.deltaHz, 2),
            toleranceHz: round(peak.harmonicMatch.toleranceHz, 2)
        } : null
    };
}

/**
 * Emits findings as measurements.
 *
 * Every `action` string the source carried is gone, and no `title` or `summary`
 * is assembled by concatenating rounded numbers into a sentence. Three reasons,
 * in the order they matter:
 *
 *  - A sentence built here cannot be checked against the evidence that produced
 *    it, and the source's strongest sentences fired off a single peak.
 *  - "Before changing control settings, inspect main blades and tracking, the
 *    main shaft, head bearings, gears..." claims more than a 1 kHz log can
 *    support: bearing and gear-mesh signatures live above the 0.45·fs analysed
 *    band, where they are invisible or aliased down onto an innocent bin.
 *  - `docs/ARCHITECTURE_AND_PROVENANCE.md` records that a rules layer was
 *    rejected for exactly this vocabulary.
 *
 * What replaces them is a stable `id` and a `measurement` block. Composition is
 * the UI's job, and the UI cannot compose a number this layer did not measure.
 */
function buildFindings(result) {
    var rangeArray = [result.range.startTimeUs, result.range.endTimeUs];
    var analyzedBandHz = result.quality
        ? [MIN_FREQUENCY_HZ, result.quality.maximumAnalyzedFrequencyHz]
        : null;
    if (result.reasonCodes.indexOf("UNFILTERED_GYRO_REQUIRED_FOR_CLEAR_GATE") >= 0) {
        result.findings.push({
            id: "mechanical-unfiltered-gyro-required-for-clear-gate",
            severity: "caution",
            axis: null,
            timeRangeUs: rangeArray,
            measurement: {
                // Filtering removes the evidence before it is measured, so a
                // quiet spectrum from a filtered source is not evidence of a
                // quiet aircraft. No conclusion is available either way.
                conclusion: null,
                observedGyroSources: (result.axes || []).map(function(axis) {
                    return { axis: axis.axis, source: axis.source };
                }),
                unfilteredSources: ["gyroRAW", "gyroUnfilt"],
                reasonCode: "UNFILTERED_GYRO_REQUIRED_FOR_CLEAR_GATE"
            },
            sourceIds: ["rotorflight-filter-tuning"]
        });
        return;
    }
    var prominent = [];
    result.axes.forEach(function(axis) {
        axis.peaks.forEach(function(peak) {
            prominent.push({ axis: axis, peak: peak });
        });
    });
    prominent.sort(function(left, right) {
        if (right.peak.persistenceRatio !== left.peak.persistenceRatio) {
            return right.peak.persistenceRatio - left.peak.persistenceRatio;
        }
        return right.peak.prominenceDb - left.peak.prominenceDb;
    });
    if (prominent.length === 0) {
        result.findings.push({
            id: "mechanical-no-persistent-narrowband-peak",
            severity: "info",
            axis: null,
            timeRangeUs: rangeArray,
            measurement: {
                conclusion: "no-persistent-narrowband-peak-in-analyzed-band",
                analyzedAxisCount: result.axes.length,
                // Stated so a caller cannot read this as "no vibration". It is
                // "none between 5 Hz and the top of the analysed band", and
                // anything above 0.5·fs in the aircraft folded into that band
                // rather than being excluded from it.
                analyzedBandHz: analyzedBandHz,
                prominenceGateDb: PEAK_PROMINENCE_DB,
                relativePowerGateDb: PEAK_RELATIVE_POWER_DB,
                minimumPersistenceRatio: MIN_PERSISTENCE_RATIO
            },
            sourceIds: ["rotorflight-filter-tuning"]
        });
        return;
    }
    var attentionPeaks = prominent.filter(function(item) {
        return item.peak.attentionEligible === true;
    });
    if (attentionPeaks.length === 0) {
        var informational = prominent[0];
        result.findings.push({
            id: "mechanical-persistent-peak-below-attention-threshold",
            severity: "info",
            axis: informational.axis.axis,
            timeRangeUs: rangeArray,
            measurement: {
                conclusion: "persistent-narrowband-energy-below-attention-threshold",
                gyroSource: informational.axis.source,
                amplitudeKind: informational.axis.amplitudeKind || null,
                frequencyHz: round(informational.peak.frequencyHz, 2),
                bandRmsDps: round(informational.peak.bandRmsDps, 3),
                bandwidthHz: round(informational.peak.bandwidthHz, 2),
                persistenceRatio: round(informational.peak.persistenceRatio, 3),
                attentionPersistenceRatio: round(
                    informational.peak.attentionPersistenceRatio,
                    3
                ),
                harmonicMatch: informational.peak.harmonicMatch,
                // Travels with the null so it cannot be read as "not a rotor
                // harmonic" on a range where no rotor speed was correlatable.
                harmonicCorrelation: result.harmonicCorrelation,
                analyzedBandHz: analyzedBandHz,
                // The threshold and its basis travel with the number it gates.
                // A reader must be able to see that "below the gate" is below a
                // scalar calibrated on synthetic fixtures, not below a limit
                // anyone has established on an out-of-track aircraft.
                attentionThreshold: {
                    bandRmsDps: ATTENTION_BAND_RMS_THRESHOLD_DPS,
                    basis: ATTENTION_THRESHOLD_BASIS,
                    officialLimit: false
                }
            },
            sourceIds: ["rotorflight-filter-tuning"]
        });
        return;
    }
    attentionPeaks.sort(function(left, right) {
        return right.peak.bandRmsDps - left.peak.bandRmsDps;
    });
    var strongest = attentionPeaks[0];
    var match = strongest.peak.harmonicMatch;
    var correlation = result.harmonicCorrelation;
    // Three outcomes, not two. The source had two, and its "uncorrelated" was
    // the answer whenever no rotor speed was trustworthy as well as whenever one
    // was and nothing matched — see `harmonicCorrelationAvailability`. On the one
    // real log this project owns the untrustworthy case is the common one, so the
    // two-outcome version would have told a pilot his rotor was ruled out on
    // almost every range he could pick. Where nothing was compared, the
    // conclusion is null.
    var correlationEvaluated = correlation && correlation.evaluated === true;
    result.findings.push({
        id: match
            ? "mechanical-persistent-" + match.rotor + "-rotor-harmonic"
            : (correlationEvaluated
                ? "mechanical-persistent-unmatched-narrowband-peak"
                : "mechanical-persistent-narrowband-peak-rotor-correlation-unavailable"),
        severity: "caution",
        axis: strongest.axis.axis,
        timeRangeUs: rangeArray,
        measurement: {
            // Correlation with a logged rotor harmonic. It is not a component
            // diagnosis and the source did not claim one either; what changed
            // is that the inspection list which read like one is gone.
            conclusion: match
                ? "persistent-narrowband-energy-correlated-with-rotor-harmonic"
                : (correlationEvaluated
                    ? "persistent-narrowband-energy-uncorrelated"
                    : null),
            harmonicCorrelation: correlation,
            correlatedRotor: match ? match.rotor : null,
            harmonicOrder: match ? match.order : null,
            componentDiagnosis: null,
            gyroSource: strongest.axis.source,
            amplitudeKind: strongest.axis.amplitudeKind || null,
            measuredAfterFilterChain: strongest.axis.source === "gyroADC-filtered",
            frequencyHz: round(strongest.peak.frequencyHz, 2),
            bandRmsDps: round(strongest.peak.bandRmsDps, 3),
            bandwidthHz: round(strongest.peak.bandwidthHz, 2),
            prominenceDb: round(strongest.peak.prominenceDb, 2),
            persistenceRatio: round(strongest.peak.persistenceRatio, 3),
            attentionPersistenceRatio: round(
                strongest.peak.attentionPersistenceRatio,
                3
            ),
            attentionOccupiedBucketCount: strongest.peak.attentionOccupiedBucketCount,
            evaluatedWindowCount: strongest.peak.evaluatedWindowCount,
            harmonicMatch: match,
            analyzedBandHz: analyzedBandHz,
            attentionThreshold: {
                bandRmsDps: ATTENTION_BAND_RMS_THRESHOLD_DPS,
                basis: ATTENTION_THRESHOLD_BASIS,
                officialLimit: false
            }
        },
        sourceIds: match
            ? ["rotorflight-filter-tuning", "rotorflight-rpm-filters"]
            : ["rotorflight-filter-tuning"]
    });
}

async function analyzeCollected(collected, range, options) {
    checkCancelled(options);
    if (range.endTimeUs - range.startTimeUs > MAX_SELECTION_DURATION_US) {
        return insufficientResult(range, ["SELECTION_DURATION_LIMIT_EXCEEDED"], null, {
            maximumSelectionDurationUs: MAX_SELECTION_DURATION_US,
            maximumSelectionDurationBasis: MAX_SELECTION_DURATION_BASIS
        });
    }
    if (collected.limitExceeded) {
        return insufficientResult(range, ["SELECTION_SAMPLE_LIMIT_EXCEEDED"], null, {
            maximumInputSamples: MAX_INPUT_SAMPLES
        });
    }
    if (collected.timeUs.length < 256) {
        return insufficientResult(
            range,
            ["INSUFFICIENT_TIMESTAMPED_SAMPLES"],
            collected.timeUs.length,
            { minimumTimestampedSamples: 256 }
        );
    }
    if (collected.nonMonotonicTimestampCount > 0) {
        return insufficientResult(
            range,
            ["NON_MONOTONIC_TIMESTAMPS"],
            collected.timeUs.length,
            { nonMonotonicTimestampCount: collected.nonMonotonicTimestampCount }
        );
    }
    var intervals = sampledIntervals(collected.timeUs);
    var medianIntervalUs = median(intervals);
    var p95IntervalUs = quantile(intervals, 0.95);
    var measuredRateHz = medianIntervalUs > 0 ? 1000000 / medianIntervalUs : null;
    if (!Number.isFinite(measuredRateHz) || measuredRateHz < 50) {
        return insufficientResult(
            range,
            ["SAMPLE_RATE_UNAVAILABLE"],
            collected.timeUs.length,
            { medianIntervalUs: medianIntervalUs }
        );
    }
    if (measuredRateHz > MAX_SAMPLE_RATE_HZ) {
        return insufficientResult(
            range,
            ["SAMPLE_RATE_LIMIT_EXCEEDED"],
            collected.timeUs.length,
            { measuredSampleRateHz: measuredRateHz, maximumSampleRateHz: MAX_SAMPLE_RATE_HZ }
        );
    }
    if (p95IntervalUs > medianIntervalUs * 4) {
        return insufficientResult(
            range,
            ["TIMING_GAPS_EXCESSIVE"],
            collected.timeUs.length,
            { medianIntervalUs: medianIntervalUs, p95IntervalUs: p95IntervalUs }
        );
    }
    var sampleIntervalUs = medianIntervalUs;
    var firstSelectedSampleTimeUs = collected.timeUs[0];
    var lastSelectedSampleTimeUs = collected.timeUs[collected.timeUs.length - 1];
    var selectedDurationUs = range.endTimeUs - range.startTimeUs;
    var leadingSelectedGapUs = Math.max(
        0,
        firstSelectedSampleTimeUs - range.startTimeUs
    );
    var trailingSelectedGapUs = Math.max(
        0,
        range.endTimeUs - lastSelectedSampleTimeUs
    );
    var selectedTimestampSpanCoverageRatio = Math.min(
        1,
        Math.max(0, lastSelectedSampleTimeUs - firstSelectedSampleTimeUs)
            / selectedDurationUs
    );
    var resampledStartTimeUs = range.startTimeUs;
    var resampledCount = Math.floor(selectedDurationUs / sampleIntervalUs) + 1;
    var resampledEndTimeUs = resampledStartTimeUs
        + (resampledCount - 1) * sampleIntervalUs;
    var resampledTimeSpanUs = resampledEndTimeUs - resampledStartTimeUs;
    var resampledRangeCoverageRatio = Math.min(
        1,
        Math.max(0, resampledTimeSpanUs) / selectedDurationUs
    );
    if (resampledCount > MAX_RESAMPLED_SAMPLES) {
        return insufficientResult(
            range,
            ["RESAMPLED_SAMPLE_LIMIT_EXCEEDED"],
            collected.timeUs.length,
            { maximumResampledSamples: MAX_RESAMPLED_SAMPLES }
        );
    }
    var resampledRateHz = 1000000 / sampleIntervalUs;
    var windowSize = chooseWindowSize(resampledRateHz, resampledCount);
    var maxGapUs = medianIntervalUs * 4;
    var resampledAxes = [];
    reportProgress(options, "resample", 0, 3);
    for (var axisIndex = 0; axisIndex < 3; axisIndex++) {
        checkCancelled(options);
        var axisInfo = collected.gyro[axisIndex];
        if (axisInfo && axisInfo.source !== "missing") {
            resampledAxes.push({
                info: axisInfo,
                values: resampleLinear(
                    collected.timeUs,
                    axisInfo.values,
                    resampledStartTimeUs,
                    sampleIntervalUs,
                    resampledCount,
                    maxGapUs
                )
            });
        }
        reportProgress(options, "resample", axisIndex + 1, 3);
        await maybeYield(options);
    }
    if (resampledAxes.length !== 3) {
        return insufficientResult(
            range,
            ["GYRO_FIELDS_MISSING"],
            collected.timeUs.length,
            {
                requiredGyroAxisCount: 3,
                availableGyroAxisCount: resampledAxes.length,
                gyroSources: collected.gyro.map(function(axis) { return axis.source; })
            }
        );
    }
    var axes = [];
    reportProgress(options, "spectrum", 0, resampledAxes.length);
    for (var spectrumIndex = 0; spectrumIndex < resampledAxes.length; spectrumIndex++) {
        checkCancelled(options);
        axes.push(await spectrumForAxis(
            resampledAxes[spectrumIndex].info,
            resampledAxes[spectrumIndex].values,
            resampledRateHz,
            windowSize,
            resampledStartTimeUs,
            sampleIntervalUs,
            range,
            options
        ));
        reportProgress(options, "spectrum", spectrumIndex + 1, resampledAxes.length);
        await maybeYield(options);
    }
    var availableAxes = axes.filter(function(axis) { return axis.available; });
    var coverageReasons = [];
    if (selectedTimestampSpanCoverageRatio < MIN_FINITE_TIME_SPAN_COVERAGE_RATIO) {
        addReason(coverageReasons, "SELECTED_TIMESTAMP_SPAN_COVERAGE_INSUFFICIENT");
    }
    if (availableAxes.length !== 3) {
        addReason(coverageReasons, "INSUFFICIENT_CONTIGUOUS_GYRO_DATA");
    }
    axes.forEach(function(axis) {
        if (axis.validWindowCoverageRatio < MIN_VALID_WINDOW_COVERAGE_RATIO) {
            addReason(coverageReasons, "VALID_WINDOW_COVERAGE_INSUFFICIENT");
        }
        if (axis.finiteSampleCoverageRatio < MIN_FINITE_SAMPLE_COVERAGE_RATIO) {
            addReason(coverageReasons, "FINITE_GYRO_SAMPLE_COVERAGE_INSUFFICIENT");
        }
        if (axis.finiteTimeSpanCoverageRatio < MIN_FINITE_TIME_SPAN_COVERAGE_RATIO) {
            addReason(coverageReasons, "FINITE_GYRO_TIME_SPAN_COVERAGE_INSUFFICIENT");
        }
    });
    if (coverageReasons.length > 0) {
        var coverageResult = insufficientResult(
            range,
            coverageReasons,
            collected.timeUs.length,
            {
                measuredSampleRateHz: round(measuredRateHz, 3),
                resampledRateHz: round(resampledRateHz, 3),
                resampledSampleCount: resampledCount,
                firstSelectedSampleTimeUs: firstSelectedSampleTimeUs,
                lastSelectedSampleTimeUs: lastSelectedSampleTimeUs,
                leadingSelectedGapUs: round(leadingSelectedGapUs, 3),
                trailingSelectedGapUs: round(trailingSelectedGapUs, 3),
                selectedTimestampSpanCoverageRatio: round(
                    selectedTimestampSpanCoverageRatio,
                    3
                ),
                resampledStartTimeUs: resampledStartTimeUs,
                resampledEndTimeUs: round(resampledEndTimeUs, 3),
                resampledTimeSpanUs: round(resampledTimeSpanUs, 3),
                resampledRangeCoverageRatio: round(
                    resampledRangeCoverageRatio,
                    3
                ),
                windowSize: windowSize,
                overlapSamples: windowSize / 2,
                windowCount: axes.length ? Math.min.apply(null, axes.map(function(axis) {
                    return axis.windowCount;
                })) : 0,
                totalPossibleWindowCount: axes.length
                    ? Math.min.apply(null, axes.map(function(axis) {
                        return axis.totalPossibleWindowCount;
                    })) : 0,
                validWindowCount: axes.length
                    ? Math.min.apply(null, axes.map(function(axis) {
                        return axis.validWindowCount;
                    })) : 0,
                validWindowCoverageRatio: axes.length
                    ? round(Math.min.apply(null, axes.map(function(axis) {
                        return axis.validWindowCoverageRatio;
                    })), 3) : 0,
                finiteSampleCoverageRatio: axes.length
                    ? round(Math.min.apply(null, axes.map(function(axis) {
                        return axis.finiteSampleCoverageRatio;
                    })), 3) : 0,
                finiteTimeSpanCoverageRatio: axes.length
                    ? round(Math.min.apply(null, axes.map(function(axis) {
                        return axis.finiteTimeSpanCoverageRatio;
                    })), 3) : 0,
                minimumWindowCount: MIN_WELCH_WINDOWS,
                minimumCoverageRatio: MIN_VALID_WINDOW_COVERAGE_RATIO,
                frequencyResolutionHz: round(resampledRateHz / windowSize, 4),
                attentionBandRmsThresholdDps: ATTENTION_BAND_RMS_THRESHOLD_DPS,
                axisCoverage: axes.map(function(axis) {
                    return {
                        axis: axis.axis,
                        source: axis.source,
                        totalPossibleWindowCount: axis.totalPossibleWindowCount,
                        validWindowCount: axis.validWindowCount,
                        validWindowCoverageRatio: round(
                            axis.validWindowCoverageRatio,
                            3
                        ),
                        finiteSampleCoverageRatio: round(
                            axis.finiteSampleCoverageRatio,
                            3
                        ),
                        finiteTimeSpanCoverageRatio: round(
                            axis.finiteTimeSpanCoverageRatio,
                            3
                        ),
                        firstFiniteSampleTimeUs: round(
                            axis.firstFiniteSampleTimeUs,
                            3
                        ),
                        lastFiniteSampleTimeUs: round(
                            axis.lastFiniteSampleTimeUs,
                            3
                        ),
                        leadingFiniteGapUs: round(axis.leadingFiniteGapUs, 3),
                        trailingFiniteGapUs: round(axis.trailingFiniteGapUs, 3)
                    };
                })
            }
        );
        coverageResult.axes = axes.map(function(axis) {
            return {
                axis: axis.axis,
                source: axis.source,
                available: false,
                reasonCode: axis.reasonCode || "GYRO_COVERAGE_INSUFFICIENT",
                totalPossibleWindowCount: axis.totalPossibleWindowCount,
                validWindowCount: axis.validWindowCount,
                validWindowCoverageRatio: round(axis.validWindowCoverageRatio, 3),
                finiteSampleCoverageRatio: round(axis.finiteSampleCoverageRatio, 3),
                finiteTimeSpanCoverageRatio: round(
                    axis.finiteTimeSpanCoverageRatio,
                    3
                ),
                firstFiniteSampleTimeUs: round(axis.firstFiniteSampleTimeUs, 3),
                lastFiniteSampleTimeUs: round(axis.lastFiniteSampleTimeUs, 3),
                leadingFiniteGapUs: round(axis.leadingFiniteGapUs, 3),
                trailingFiniteGapUs: round(axis.trailingFiniteGapUs, 3),
                windowCount: axis.windowCount,
                candidateWindowCount: axis.candidateWindowCount,
                windowCoverageRatio: axis.candidateWindowCount > 0
                    ? round(axis.windowCount / axis.candidateWindowCount, 3) : 0,
                peaks: []
            };
        });
        return coverageResult;
    }
    var rpmSources = {
        headspeed: rpmEvidence(
            collected.headspeedRpm,
            "headspeed",
            range,
            collected.timeUs.length
        ),
        tailspeed: rpmEvidence(
            collected.tailspeedRpm,
            "tailspeed",
            range,
            collected.timeUs.length
        )
    };
    var resolutionHz = resampledRateHz / windowSize;
    var harmonicCorrelation = harmonicCorrelationAvailability(rpmSources);
    availableAxes.forEach(function(axis) {
        axis.peaks.forEach(function(peak) {
            peak.harmonicMatch = bestHarmonicMatch(peak, rpmSources, resolutionHz);
        });
    });
    var hasPersistentPeak = availableAxes.some(function(axis) {
        return axis.peaks.length > 0;
    });
    var hasAttentionPeak = availableAxes.some(function(axis) {
        return axis.peaks.some(function(peak) {
            return peak.attentionEligible === true;
        });
    });
    var reasons = [];
    if (hasAttentionPeak) {
        addReason(reasons, "PERSISTENT_NARROWBAND_ENERGY");
        if (availableAxes.some(function(axis) {
            return axis.peaks.some(function(peak) {
                return peak.attentionEligible === true
                    && peak.harmonicMatch && peak.harmonicMatch.rotor === "main";
            });
        })) {
            addReason(reasons, "MAIN_ROTOR_HARMONIC_CORRELATION");
        }
        if (availableAxes.some(function(axis) {
            return axis.peaks.some(function(peak) {
                return peak.attentionEligible === true
                    && peak.harmonicMatch && peak.harmonicMatch.rotor === "tail";
            });
        })) {
            addReason(reasons, "TAIL_ROTOR_HARMONIC_CORRELATION");
        }
        // Vibration was measured and no rotor speed was trustworthy enough to
        // compare it against. The absence of a correlation code above would
        // otherwise be read as evidence the rotors are not the source.
        if (!harmonicCorrelation.evaluated) {
            addReason(reasons, "ROTOR_HARMONIC_CORRELATION_UNAVAILABLE");
        }
    } else if (hasPersistentPeak) {
        addReason(reasons, "PERSISTENT_NARROWBAND_ENERGY_BELOW_ATTENTION_THRESHOLD");
    }
    var filteredSourceUsed = availableAxes.some(function(axis) {
        return axis.source === "gyroADC-filtered";
    });
    var allAxesUnfiltered = availableAxes.length === 3
        && availableAxes.every(function(axis) {
            return axis.source === "gyroRAW" || axis.source === "gyroUnfilt";
        });
    if (filteredSourceUsed) {
        addReason(reasons, "FILTERED_GYRO_SOURCE_USED");
    }
    var unfilteredClearBlocked = !hasAttentionPeak && !allAxesUnfiltered;
    if (unfilteredClearBlocked) {
        addReason(reasons, "UNFILTERED_GYRO_REQUIRED_FOR_CLEAR_GATE");
    }
    var result = baseResult(
        range,
        hasAttentionPeak ? "attention" : (unfilteredClearBlocked ? "insufficient" : "clear"),
        reasons,
        collected.timeUs.length
    );
    result.rpmEvidence = rpmSources;
    result.harmonicCorrelation = harmonicCorrelation;
    result.quality = {
        status: unfilteredClearBlocked ? "insufficient" : "accepted",
        sourceSampleCount: collected.timeUs.length,
        duplicateTimestampCount: collected.duplicateTimestampCount,
        measuredSampleRateHz: round(measuredRateHz, 3),
        resampledRateHz: round(resampledRateHz, 3),
        resampledSampleCount: resampledCount,
        firstSelectedSampleTimeUs: firstSelectedSampleTimeUs,
        lastSelectedSampleTimeUs: lastSelectedSampleTimeUs,
        leadingSelectedGapUs: round(leadingSelectedGapUs, 3),
        trailingSelectedGapUs: round(trailingSelectedGapUs, 3),
        selectedTimestampSpanCoverageRatio: round(
            selectedTimestampSpanCoverageRatio,
            3
        ),
        resampledStartTimeUs: resampledStartTimeUs,
        resampledEndTimeUs: round(resampledEndTimeUs, 3),
        resampledTimeSpanUs: round(resampledTimeSpanUs, 3),
        resampledRangeCoverageRatio: round(resampledRangeCoverageRatio, 3),
        medianIntervalUs: round(medianIntervalUs, 3),
        p95IntervalUs: round(p95IntervalUs, 3),
        interpolationGapLimitUs: round(maxGapUs, 3),
        windowSize: windowSize,
        overlapSamples: windowSize / 2,
        windowCount: Math.min.apply(null, availableAxes.map(function(axis) {
            return axis.windowCount;
        })),
        totalPossibleWindowCount: Math.min.apply(null, availableAxes.map(function(axis) {
            return axis.totalPossibleWindowCount;
        })),
        validWindowCount: Math.min.apply(null, availableAxes.map(function(axis) {
            return axis.validWindowCount;
        })),
        validWindowCoverageRatio: round(Math.min.apply(null, availableAxes.map(
            function(axis) { return axis.validWindowCoverageRatio; }
        )), 3),
        finiteSampleCoverageRatio: round(Math.min.apply(null, availableAxes.map(
            function(axis) { return axis.finiteSampleCoverageRatio; }
        )), 3),
        finiteTimeSpanCoverageRatio: round(Math.min.apply(null, availableAxes.map(
            function(axis) { return axis.finiteTimeSpanCoverageRatio; }
        )), 3),
        minimumCoverageRatio: MIN_VALID_WINDOW_COVERAGE_RATIO,
        frequencyResolutionHz: round(resolutionHz, 4),
        maximumAnalyzedFrequencyHz: round(
            Math.min(MAX_FREQUENCY_HZ, resampledRateHz * 0.45),
            2
        ),
        maximumWelchWindowsPerAxis: MAX_WELCH_WINDOWS,
        attentionBandRmsThresholdDps: ATTENTION_BAND_RMS_THRESHOLD_DPS,
        attentionThresholdBasis: ATTENTION_THRESHOLD_BASIS
    };
    // The analysed band is a measurement, published on the result rather than
    // implied by its absence. It stops at 0.45·fs — 453 Hz on a 1 kHz log — and
    // anything the aircraft produced above 0.5·fs did not vanish, it folded down
    // into this band and can land on a bin that a rotor harmonic also occupies.
    // A caller that does not know the band cannot know what a clear result
    // excluded, which for bearing and gear-mesh frequencies is most of it.
    result.analyzedBandHz = [
        MIN_FREQUENCY_HZ,
        result.quality.maximumAnalyzedFrequencyHz
    ];
    result.aliasingFoldFrequencyHz = round(resampledRateHz / 2, 2);
    result.axes = availableAxes.map(function(axis) {
        if (unfilteredClearBlocked) {
            return {
                axis: axis.axis,
                source: axis.source,
                available: false,
                reasonCode: "UNFILTERED_GYRO_REQUIRED_FOR_CLEAR_GATE",
                totalPossibleWindowCount: axis.totalPossibleWindowCount,
                validWindowCount: axis.validWindowCount,
                validWindowCoverageRatio: round(axis.validWindowCoverageRatio, 3),
                finiteSampleCoverageRatio: round(axis.finiteSampleCoverageRatio, 3),
                finiteTimeSpanCoverageRatio: round(
                    axis.finiteTimeSpanCoverageRatio,
                    3
                ),
                firstFiniteSampleTimeUs: round(axis.firstFiniteSampleTimeUs, 3),
                lastFiniteSampleTimeUs: round(axis.lastFiniteSampleTimeUs, 3),
                leadingFiniteGapUs: round(axis.leadingFiniteGapUs, 3),
                trailingFiniteGapUs: round(axis.trailingFiniteGapUs, 3),
                windowCount: axis.windowCount,
                candidateWindowCount: axis.candidateWindowCount,
                windowCoverageRatio: round(axis.windowCoverageRatio, 3),
                peaks: []
            };
        }
        return {
            axis: axis.axis,
            source: axis.source,
            amplitudeKind: axis.amplitudeKind,
            available: true,
            sampleCount: axis.sampleCount,
            rmsDps: round(axis.rmsDps, 3),
            broadbandPowerDps2: round(axis.broadbandPowerDps2, 4),
            broadbandRmsDps: round(axis.broadbandRmsDps, 3),
            medianNoisePsdDps2PerHz: round(axis.medianNoisePsdDps2PerHz, 6),
            windowCount: axis.windowCount,
            candidateWindowCount: axis.candidateWindowCount,
            windowCoverageRatio: round(axis.windowCoverageRatio, 3),
            totalPossibleWindowCount: axis.totalPossibleWindowCount,
            validWindowCount: axis.validWindowCount,
            validWindowCoverageRatio: round(axis.validWindowCoverageRatio, 3),
            finiteSampleCoverageRatio: round(axis.finiteSampleCoverageRatio, 3),
            finiteTimeSpanCoverageRatio: round(axis.finiteTimeSpanCoverageRatio, 3),
            firstFiniteSampleTimeUs: round(axis.firstFiniteSampleTimeUs, 3),
            lastFiniteSampleTimeUs: round(axis.lastFiniteSampleTimeUs, 3),
            leadingFiniteGapUs: round(axis.leadingFiniteGapUs, 3),
            trailingFiniteGapUs: round(axis.trailingFiniteGapUs, 3),
            peaks: axis.peaks.map(compactPeak)
        };
    });
    reportProgress(options, "findings", 0, 1);
    buildFindings(result);
    reportProgress(options, "findings", 1, 1);
    return result;
}


/**
 * Analyses a plain timestamped gyro series.
 *
 * The source's `analyzeTimeSeries`, unchanged except that `gyroSources` is now
 * validated up front rather than defaulted — see `requireGyroSources`.
 *
 * @param {{timeUs: ArrayLike<number>,
 *          gyro: object|Array,
 *          gyroSources: {roll: string, pitch: string, yaw: string},
 *          headspeedRpm?: ArrayLike<number>,
 *          tailspeedRpm?: ArrayLike<number>}} series
 * @param {{timeRangeUs: {startTimeUs: number, endTimeUs: number},
 *          cooperativeYield?: boolean,
 *          isCancelled?: function,
 *          onProgress?: function}} options
 */
async function analyzeMechanicalTimeSeries(series, options) {
    var settings = options || {};
    checkCancelled(settings);
    var times = series && series.timeUs;
    if (!times || typeof times.length !== "number" || times.length === 0) {
        throw codedError(
            TypeError,
            "MECHANICAL_SERIES_REQUIRED",
            "A timestamped gyro series is required"
        );
    }
    // Validate the labels before anything else can consume the samples, so a
    // caller cannot reach an early return with an unlabelled series.
    requireGyroSources(series);
    var minimumTimeUs = times[0];
    var maximumTimeUs = times[times.length - 1];
    var range = normalizeRange(settings.timeRangeUs, minimumTimeUs, maximumTimeUs);
    if (range.endTimeUs - range.startTimeUs > MAX_SELECTION_DURATION_US) {
        return insufficientResult(range, ["SELECTION_DURATION_LIMIT_EXCEEDED"], null, {
            maximumSelectionDurationUs: MAX_SELECTION_DURATION_US,
            maximumSelectionDurationBasis: MAX_SELECTION_DURATION_BASIS
        });
    }
    var collected = await collectTimeSeriesSelection(series, range, settings);
    return analyzeCollected(collected, range, settings);
}

/**
 * Analyses one decoded RotorLens session.
 *
 * Replaces the source's `analyzeFlightLog`, which duck-typed a viewer FlightLog
 * for `getMinTime`/`getMaxTime`/`getChunksInTimeRange`/`getMainFieldIndexByName`
 * and paged 1 s windows of chunks. None of that exists here and none of it was
 * adapted: `buildMechanicalSeries` resolves the fields against `session.fields`
 * and the flat `session.samples` array goes straight into the same collector the
 * time-series path already used.
 *
 * `options.timeRangeUs` is required and there is deliberately no whole-log
 * default. A whole-log range is a legal thing to ask for and this will answer it
 * — the cap admits 262.144 s — but a range spanning a spool-up cannot be
 * correlated against a rotor speed, and defaulting to one would hand back the
 * weakest available answer as though it were the obvious one. On the reference
 * log a whole-log range spreads headspeed 0.62107 against a 0.12 gate. Choosing
 * the range is the caller's decision, made visibly. `sessionTimeBounds` in
 * `mechanical-session.mjs` gives a caller the bounds to compose one from.
 *
 * @param {object} session a session from `decodeLog`
 * @param {object} options as `analyzeMechanicalTimeSeries`
 */
async function analyzeMechanicalSpectrum(session, options) {
    var settings = options || {};
    checkCancelled(settings);
    var built = buildMechanicalSeries(session);
    if (!built.usable) {
        var bounds = sessionTimeBounds(session);
        var fallbackRange = settings.timeRangeUs
            && Number.isFinite(settings.timeRangeUs.startTimeUs)
            && Number.isFinite(settings.timeRangeUs.endTimeUs)
            ? Object.freeze({
                startTimeUs: settings.timeRangeUs.startTimeUs,
                endTimeUs: settings.timeRangeUs.endTimeUs
            })
            : Object.freeze({
                startTimeUs: Number.isFinite(bounds.startTimeUs) ? bounds.startTimeUs : 0,
                endTimeUs: Number.isFinite(bounds.endTimeUs) ? bounds.endTimeUs : 0
            });
        // The fields are not there. That is a measurable fact about the log, not
        // a programmer error, so it comes back as insufficient evidence with the
        // missing field names attached rather than as a thrown exception.
        return insufficientResult(
            fallbackRange,
            ["GYRO_FIELDS_MISSING"],
            built.timeUs.length,
            {
                missingFields: built.missing.slice(),
                resolvedFields: built.resolved,
                gyroSources: [
                    built.gyroSources.roll,
                    built.gyroSources.pitch,
                    built.gyroSources.yaw
                ]
            }
        );
    }
    return analyzeMechanicalTimeSeries(built, settings);
}

/* ------------------------------------------------------------ the UI boundary */

var VIBRATION_SUMMARY_SCHEMA_VERSION = 1;

/**
 * Peak-level rotor attribution, with "not checked" as a first-class answer.
 *
 * A UI asking "does the rotor explain this peak?" has three possible answers and
 * only one of them is a yes. Returning null for the other two is what put a
 * FIELD_MISSING on a column the log has, one layer down, so the two nos are
 * separate values here and the reason travels with the one that has one.
 */
function peakRotorAttribution(peak, correlation) {
    if (peak.harmonicMatch) {
        return {
            state: "explained",
            rotor: peak.harmonicMatch.rotor,
            order: peak.harmonicMatch.order,
            predictedHz: peak.harmonicMatch.predictedHz,
            deltaHz: peak.harmonicMatch.deltaHz,
            toleranceHz: peak.harmonicMatch.toleranceHz,
            unavailableRotors: []
        };
    }
    if (correlation && correlation.evaluated === true) {
        return {
            // Measured: a trustworthy rotor speed was compared against this
            // frequency at every order up to 8 and none of them lines up.
            state: "not-explained",
            rotor: null,
            order: null,
            predictedHz: null,
            deltaHz: null,
            toleranceHz: null,
            // Any rotor that could NOT be compared is still listed, so
            // "not explained by the main rotor" is never read as
            // "not explained by any rotor" on a log with no tail speed.
            unavailableRotors: correlation.unavailableRotors.slice()
        };
    }
    return {
        // Not a measurement about the aircraft. Nothing was compared.
        state: "not-checked",
        rotor: null,
        order: null,
        predictedHz: null,
        deltaHz: null,
        toleranceHz: null,
        unavailableRotors: correlation ? correlation.unavailableRotors.slice() : []
    };
}

/**
 * The one call a viewer makes.
 *
 * Takes a decoded session (or an already-built series from
 * `buildMechanicalSeries`) plus a required time range, and returns a plain,
 * JSON-safe object: per-axis vibration peaks with frequency and amplitude,
 * whether a rotor harmonic explains each one, and an explicit state wherever it
 * could not be checked. Nothing is composed into prose, nothing is ranked into
 * a verdict, and no field says what to change — see `capabilities()` and
 * constraint 4 in CLAUDE.md.
 *
 *     import {summarizeMechanicalVibration, sessionTimeBounds}
 *       from 'src/analysis/advisor/mechanical-spectrum.mjs';
 *
 *     const bounds = sessionTimeBounds(session);
 *     const view = await summarizeMechanicalVibration(session, {
 *       timeRangeUs: {startTimeUs: bounds.startTimeUs, endTimeUs: bounds.startTimeUs + 30e6}
 *     });
 *
 * It never throws for a reason that is a fact about the log — a missing gyro
 * column comes back as `available: false` with a reason code. It DOES throw for
 * a caller error: no range (`ANALYSIS_RANGE_REQUIRED`), a range outside the
 * session (`ANALYSIS_RANGE_INVALID`), or an unlabelled gyro series
 * (`MECHANICAL_GYRO_SOURCES_REQUIRED`). Those are bugs in the caller, not
 * findings about an aircraft, and silently returning "insufficient" for them
 * would hide a broken screen behind a safety-shaped word.
 *
 * Every amplitude is in degrees per second. `amplitudeKind` says whether the
 * samples were measured before or after the flight controller's filter chain;
 * a filtered source cannot produce `status: "clear"` and publishes no peaks at
 * all, because filtering removes the evidence before it can be measured.
 *
 * @param {object} sessionOrSeries a session from `decodeLog`, or the result of
 *   `buildMechanicalSeries`
 * @param {{timeRangeUs: {startTimeUs: number, endTimeUs: number},
 *          cooperativeYield?: boolean,
 *          isCancelled?: function,
 *          onProgress?: function}} options
 * @returns {Promise<object>} see `VIBRATION_SUMMARY_SCHEMA_VERSION`
 */
async function summarizeMechanicalVibration(sessionOrSeries, options) {
    var isSeries = Boolean(sessionOrSeries && sessionOrSeries.gyroSources);
    var result = isSeries
        ? await analyzeMechanicalTimeSeries(sessionOrSeries, options)
        : await analyzeMechanicalSpectrum(sessionOrSeries, options);

    var correlation = result.harmonicCorrelation;
    var headspeed = result.rpmEvidence.headspeed;
    var tailspeed = result.rpmEvidence.tailspeed;

    return {
        schemaVersion: VIBRATION_SUMMARY_SCHEMA_VERSION,
        engineVersion: result.engineVersion,
        // True of every field below, and asserted by the test suite rather than
        // promised here: this object contains measurements and states, and no
        // instruction to change anything on the aircraft.
        measurementsOnly: true,
        range: {
            startTimeUs: result.range.startTimeUs,
            endTimeUs: result.range.endTimeUs,
            durationUs: result.range.durationUs,
            sampleCount: result.range.sampleCount
        },
        // "clear" | "attention" | "insufficient". `available` is false exactly
        // when the status is insufficient, which means nothing was measured —
        // never that nothing is wrong.
        status: result.status,
        available: result.available,
        reasonCodes: result.reasonCodes.slice(),
        analyzedBandHz: result.analyzedBandHz,
        aliasingFoldFrequencyHz: result.aliasingFoldFrequencyHz === undefined
            ? null : result.aliasingFoldFrequencyHz,
        attentionThreshold: {
            bandRmsDps: result.attentionThreshold.bandRmsDps,
            basis: result.attentionThreshold.basis,
            officialLimit: result.attentionThreshold.officialLimit
        },
        // Three states, and only "evaluated" is a statement about the aircraft.
        // "unavailable" means rotor speeds were read and none was steady enough
        // to compare against; "not-evaluated" means none was read at all.
        rotorCorrelation: {
            state: correlation.state,
            evaluatedRotors: correlation.evaluatedRotors.slice(),
            unavailableRotors: correlation.unavailableRotors.slice(),
            headspeed: {
                state: headspeed.state,
                reasonCode: headspeed.reasonCode,
                medianRpm: headspeed.medianRpm,
                fundamentalHz: headspeed.fundamentalHz,
                relativeSpread: headspeed.relativeSpread
            },
            tailspeed: {
                state: tailspeed.state,
                reasonCode: tailspeed.reasonCode,
                medianRpm: tailspeed.medianRpm,
                fundamentalHz: tailspeed.fundamentalHz,
                relativeSpread: tailspeed.relativeSpread
            }
        },
        axes: result.axes.map(function(axis) {
            return {
                axis: axis.axis,
                gyroSource: axis.source,
                amplitudeKind: axis.amplitudeKind === undefined
                    ? null : axis.amplitudeKind,
                available: axis.available === true,
                reasonCode: axis.reasonCode === undefined ? null : axis.reasonCode,
                broadbandRmsDps: axis.broadbandRmsDps === undefined
                    ? null : axis.broadbandRmsDps,
                // How much of the range the Welch average actually covered, so a
                // long selection cannot look like a dense one. 1 means every
                // window in the range was averaged; below 1 they were sampled,
                // which starts at about 33 s of selection at any log rate.
                windowCoverageRatio: axis.windowCoverageRatio,
                peaks: axis.peaks.map(function(peak) {
                    return {
                        frequencyHz: peak.frequencyHz,
                        amplitudeDps: peak.bandRmsDps,
                        bandwidthHz: peak.bandwidthHz,
                        prominenceDb: peak.prominenceDb,
                        persistenceRatio: peak.persistenceRatio,
                        // Above the experimental threshold published above, not
                        // above any limit Rotorflight or anyone else has set.
                        aboveAttentionThreshold: peak.attentionEligible === true,
                        rotorHarmonic: peakRotorAttribution(peak, correlation)
                    };
                })
            };
        }),
        sources: result.sources
    };
}

var MECHANICAL_SOURCES = SOURCES;

var MECHANICAL_CONSTANTS = Object.freeze({
    // `collectionWindowUs` is gone with the chunk loop it paged.
    maximumSelectionDurationUs: MAX_SELECTION_DURATION_US,
    // Published beside the number because the number on its own invited a
    // stronger reading than it can carry. It is a span ceiling, not a
    // stationarity gate; see the constant's own comment.
    maximumSelectionDurationBasis: MAX_SELECTION_DURATION_BASIS,
    maximumInputSamples: MAX_INPUT_SAMPLES,
    maximumResampledSamples: MAX_RESAMPLED_SAMPLES,
    maximumSampleRateHz: MAX_SAMPLE_RATE_HZ,
    maximumWelchWindows: MAX_WELCH_WINDOWS,
    minimumWelchWindows: MIN_WELCH_WINDOWS,
    minimumFrequencyHz: MIN_FREQUENCY_HZ,
    maximumFrequencyHz: MAX_FREQUENCY_HZ,
    targetFrequencyResolutionHz: TARGET_FREQUENCY_RESOLUTION_HZ,
    minimumPersistenceRatio: MIN_PERSISTENCE_RATIO,
    minimumValidWindowCoverageRatio: MIN_VALID_WINDOW_COVERAGE_RATIO,
    minimumFiniteSampleCoverageRatio: MIN_FINITE_SAMPLE_COVERAGE_RATIO,
    minimumFiniteTimeSpanCoverageRatio: MIN_FINITE_TIME_SPAN_COVERAGE_RATIO,
    attentionTimeBucketCount: ATTENTION_TIME_BUCKET_COUNT,
    minimumAttentionOccupiedBuckets: MIN_ATTENTION_OCCUPIED_BUCKETS,
    maximumAttentionUnsupportedGapRatio: MAX_ATTENTION_UNSUPPORTED_GAP_RATIO,
    attentionBandRmsThresholdDps: ATTENTION_BAND_RMS_THRESHOLD_DPS,
    attentionThresholdBasis: ATTENTION_THRESHOLD_BASIS
});

export {
  analyzeMechanicalSpectrum,
  analyzeMechanicalTimeSeries,
  // The documented entry point for a screen. Everything above it is the full
  // measurement record; this is the shape a UI can render without reading any
  // of it.
  summarizeMechanicalVibration,
  VIBRATION_SUMMARY_SCHEMA_VERSION,
  MECHANICAL_SOURCES,
  MECHANICAL_CONSTANTS,
  MECHANICAL_GYRO_SOURCE_LABELS,
  normalizeRange,
  // Exported so the spectral estimator can be checked directly against a
  // hand-computed DFT rather than only through the analysis that consumes it. A
  // wrong FFT mis-attributes vibration silently, and a test that can only reach
  // it through five gates is a test that can be satisfied by the gates.
  fftInPlace,
  hannWindow,
  chooseWindowSize,
  resampleLinear
};

// Re-exported so a caller needs one import to go from a decoded session to a
// range it is allowed to ask about.
export {buildMechanicalSeries, sessionTimeBounds};
