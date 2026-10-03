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
//
// ANSWERED 2 October 2026, by the owner: it routes. The threshold itself is
// unchanged, and so is this module — a rotor-order peak above it still reads
// `attention` and `tuningEvidenceGate` still says `blocked`, because that is
// what was measured. The routing lives one layer up, in
// `rotorOrderToneAssessment` in `recommendation-gates.mjs`: when EVERY
// attention-level peak is main-rotor order 1 or 2, on unfiltered gyro, with the
// rotor compared and no other reason code, the airframe gate reports it as an
// observation ("check tracking and balance") instead of withholding the gains.
// Anything else above the threshold still blocks, and so does a rotor-order tone
// more than three times it (`GAIN_GATE_THRESHOLDS.rotorOrderToneCeilingMultiple`,
// a safety backstop). The rule reads every attention-level peak, which is why
// `detectPeaks` never caps them.
var ATTENTION_BAND_RMS_THRESHOLD_DPS = 8;
var ATTENTION_THRESHOLD_BASIS = "experimental-synthetic-calibration";
// Caps the peaks BELOW the attention level only, at five of their own however
// many attention-eligible peaks are listed beside them. Every attention-eligible
// peak is listed however many there are, and so is every peak that reached the
// level in some window without being attention-eligible; see `detectPeaks`.
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

/**
 * A tone's size WHILE PRESENT, from its band power in each analysis window.
 *
 * Stage 2d, review of 3 October 2026. The RMS over every window that reached
 * the level read low: a window straddling the tone switching on or off holds it
 * for part of its length, passes the level all the same, and was averaged in at
 * that partial power — 0.87-0.94 of the tone's size at on-times of one to three
 * seconds, so a once-per-rev just past three times the level was reported under
 * the ceiling. So the EDGE windows — the first and last of each run of
 * consecutive windows above the level, the ones next to a window below it or to
 * the end of the range — are left out, and the size is the RMS over the rest.
 * Where that leaves none, the tone never stayed on past one window's edges, and
 * the RMS over every window above the level is published as a LOWER BOUND
 * (`lowerBound`), never as a size.
 *
 * Measured on synthetic tones switching on for 0.6-8 s and off for 0.6-5 s, at
 * 500-2000 Hz over 20-120 s ranges, at 3-10 times the level: with the edges out
 * the size is the tone's steady size to within 0.5% wherever the tone is on and
 * off for more than about two windows — the Hann window weights the part of a
 * window nearest a switch least, so the window next to an edge window is all
 * but whole. A stricter rule, keeping only windows with a whole window above the
 * level on either side, moved no size by more than that 0.5% and was dropped.
 * Edge windows can only pull the size down, so the result is never less than the
 * RMS over every window above the level: never under the level, nor under the
 * flight average.
 */
function sizeWhileAboveLevel(bandPowers, aboveLevel) {
    var innerSum = 0;
    var innerCount = 0;
    var everySum = 0;
    var everyCount = 0;
    for (var index = 0; index < bandPowers.length; index++) {
        if (!aboveLevel[index]) {
            continue;
        }
        everySum += bandPowers[index];
        everyCount++;
        // An edge window: the first or last of its run.
        if (index > 0 && aboveLevel[index - 1]
                && index + 1 < bandPowers.length && aboveLevel[index + 1]) {
            innerSum += bandPowers[index];
            innerCount++;
        }
    }
    if (everyCount === 0) {
        return { rmsDps: null, lowerBound: false };
    }
    var everyWindow = Math.sqrt(Math.max(0, everySum / everyCount));
    if (innerCount === 0) {
        return { rmsDps: everyWindow, lowerBound: true };
    }
    return {
        rmsDps: Math.max(everyWindow, Math.sqrt(Math.max(0, innerSum / innerCount))),
        lowerBound: false
    };
}

/**
 * A peak's frequency between the bins: the vertex of the parabola through the
 * log power of the peak bin and its two neighbours.
 *
 * Stage 2d. The bin a tone lands in can be half a bin — about 1 Hz at the 2 Hz
 * target resolution — from the tone, which is all a rotor-order match could ever
 * be judged to. Measured on synthetic tones swept across a bin at 500, 1000 and
 * 2000 Hz: within 0.031 Hz of the tone, where the bin alone is up to 0.96 Hz
 * off. Falls back to the bin's own frequency wherever the three powers do not
 * describe a peak.
 */
function interpolatedPeakHz(psd, bin, resolutionHz) {
    var left = psd[bin - 1];
    var centre = psd[bin];
    var right = psd[bin + 1];
    if (!(left > 0 && centre > 0 && right > 0)) {
        return bin * resolutionHz;
    }
    var a = Math.log(left);
    var b = Math.log(centre);
    var c = Math.log(right);
    var curvature = a - 2 * b + c;
    if (!(curvature < 0)) {
        return bin * resolutionHz;
    }
    var offset = Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / curvature));
    return (bin + offset) * resolutionHz;
}

/**
 * Whether a listed peak was present in enough analysis windows to be a
 * persistent tone: `MIN_PERSISTENCE_RATIO` of them, and never fewer than
 * `MIN_WELCH_WINDOWS`. Judged from the two counts every peak publishes, so it
 * reads the same on a peak inside `detectPeaks` and on one in a result.
 *
 * Since the Stage 2d follow-up a peak short of it is listed when it reached the
 * attention level in some window — a burst — and such a peak is not persistent:
 * it raises no "persistent" reason code or finding of its own.
 */
function meetsPresenceRequirement(peak) {
    var evaluated = peak && Number.isFinite(peak.evaluatedWindowCount)
        ? peak.evaluatedWindowCount : 0;
    return Boolean(peak) && Number.isFinite(peak.supportingWindowCount)
        && peak.supportingWindowCount >= Math.max(
            MIN_WELCH_WINDOWS,
            Math.ceil(evaluated * MIN_PERSISTENCE_RATIO)
        );
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
        // Whether the peak was present in enough windows to be a persistent tone.
        // Stage 2d follow-up, item 1 (pre-existing on main): a peak short of this
        // used to be dropped HERE, before its size in each window was measured, so
        // a burst of a few seconds at three to seven times the attention level was
        // never listed and the airframe rung read "clear" over it. It is now
        // measured window by window first, and dropped only if it never reached
        // the level in any window; see the presence check after that loop.
        var presenceRequirementMet = supportingWindowCount >= requiredWindows;
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
        // Each window's band power, and whether it reached the level, for the
        // tone's size WHILE PRESENT (see `sizeWhileAboveLevel`).
        var windowBandPowers = [];
        var windowAboveLevel = [];
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
            var reachedLevel = Math.sqrt(Math.max(0, attentionBandPower))
                >= ATTENTION_BAND_RMS_THRESHOLD_DPS;
            windowBandPowers.push(attentionBandPower);
            windowAboveLevel.push(reachedLevel);
            if (reachedLevel) {
                attentionSupportingWindowCount++;
                if (firstAttentionWindow === null) {
                    firstAttentionWindow = attentionWindowIndex;
                }
                lastAttentionWindow = attentionWindowIndex;
                attentionWindowStarts.push(windowStarts[attentionWindowIndex]);
            }
        }
        // Too few windows to be a persistent tone, and never above the level in
        // any of them: a passing bump, dropped as it always was. One that reached
        // the level is kept, never attention-eligible (below), and listed with the
        // other tones above the level for part of the range.
        if (!presenceRequirementMet && attentionSupportingWindowCount === 0) {
            continue;
        }
        var sizeWhilePresent = sizeWhileAboveLevel(windowBandPowers, windowAboveLevel);
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
        // The four attention criteria, each judged once, and the ones this peak
        // did not meet published by name (copy review of 3 October 2026, finding
        // 6): "too few windows" and "enough windows, bunched into one part of the
        // range" are different facts about a tone, and only this function knows
        // which applied. `attentionEligible` below is exactly "none unmet".
        var attentionCriteriaUnmet = [];
        if (!(attentionSupportingWindowCount >= requiredWindows)) {
            attentionCriteriaUnmet.push("window-count");
        }
        if (!(attentionTemporalSpanRatio >= 0.5)) {
            attentionCriteriaUnmet.push("span");
        }
        if (!(attentionOccupiedBucketCount >= MIN_ATTENTION_OCCUPIED_BUCKETS)) {
            attentionCriteriaUnmet.push("quarters");
        }
        if (!(attentionMaximumGapRatio <= MAX_ATTENTION_UNSUPPORTED_GAP_RATIO)) {
            attentionCriteriaUnmet.push("gap");
        }
        candidates.push({
            bin: bin,
            frequencyHz: bin * frequencyResolutionHz,
            // Between the bins; see `interpolatedPeakHz`. `frequencyHz` stays the
            // bin's, which is what every tolerance written before this was built on.
            interpolatedFrequencyHz: interpolatedPeakHz(psd, bin, frequencyResolutionHz),
            psdDps2PerHz: psd[bin],
            localNoisePsdDps2PerHz: noiseFloor,
            relativePowerDb: relativePowerDb,
            prominenceDb: prominenceDb,
            bandwidthHz: bandwidth.bandwidthHz,
            bandPowerDps2: bandPower,
            bandRmsDps: Math.sqrt(Math.max(0, bandPower)),
            // The tone's size WHILE PRESENT: its band RMS over the windows in
            // which it reached the attention level, null when it reached it in
            // none. `bandRmsDps` above is the Welch average over EVERY window, so
            // for a tone present a third of the flight it is pulled far below the
            // size the tone has when it is there — review of 2 October 2026: a
            // once-per-rev at four times the level, present 30% of the flight,
            // averaged under three times it. Judged window by window, the same way
            // attention eligibility is. It is at least the level (every window in
            // it is) and at least `bandRmsDps` (those windows are the loudest), and
            // equals `bandRmsDps` for a tone above the level throughout.
            //
            // Since Stage 2d it leaves out the windows that straddle the tone
            // switching on or off — see `sizeWhileAboveLevel` — which held it for
            // part of their length and pulled the size 7-13% under the truth at
            // on-times of a second or three. Where nothing is left once they are
            // out, the tone never stayed on for a whole window, and
            // `attentionWindowSizeIsLowerBound` says the size is a lower bound.
            // Its resolution is still one analysis window: a tone that goes quiet
            // for less than about two windows is seen as one long stretch, and its
            // size there is the windowed average.
            attentionWindowBandRmsDps: sizeWhilePresent.rmsDps,
            attentionWindowSizeIsLowerBound: sizeWhilePresent.lowerBound,
            supportingWindowCount: supportingWindowCount,
            evaluatedWindowCount: windowPsd.length,
            persistenceRatio: persistenceRatio,
            attentionSupportingWindowCount: attentionSupportingWindowCount,
            attentionPersistenceRatio: attentionPersistenceRatio,
            attentionTemporalSpanRatio: attentionTemporalSpanRatio,
            attentionOccupiedBucketCount: attentionOccupiedBucketCount,
            attentionMaximumGapRatio: attentionMaximumGapRatio,
            // Judged on the attention criteria alone, as it always was for a listed
            // peak. A peak short of the presence above but above the level in a
            // quarter of the windows, across half the range, in three of its four
            // quarters, with no long gap, is not "one bump", and fails safe as
            // attention rather than as a tone above the level "in part". No input
            // tried reaches that corner — a short burst cannot meet the span rule
            // and a wandering tone stays present — so it is a backstop, not a path.
            attentionEligible: attentionCriteriaUnmet.length === 0,
            // "window-count", "span", "quarters", "gap": the criteria above it did
            // not meet, empty exactly when it is attention-eligible.
            attentionCriteriaUnmet: attentionCriteriaUnmet,
            harmonicMatch: null
        });
    }
    var byRank = function(left, right) {
        if (right.persistenceRatio !== left.persistenceRatio) {
            return right.persistenceRatio - left.persistenceRatio;
        }
        return right.prominenceDb - left.prominenceDb;
    };
    candidates.sort(byRank);
    var tooCloseToSelected = function(selected, candidate) {
        return selected.some(function(existing) {
            var separation = Math.max(
                frequencyResolutionHz * 2,
                Math.min(candidate.frequencyHz, existing.frequencyHz) * 0.025
            );
            return Math.abs(candidate.frequencyHz - existing.frequencyHz) < separation;
        });
    };
    // ATTENTION-LEVEL PEAKS ARE NEVER CAPPED. Review of 2 October 2026: the cap
    // used to be applied to the ranked list BEFORE attention was looked at, so an
    // attention-level peak ranked sixth on persistence and prominence was thrown
    // away. Five small, steady rotor harmonics were enough to push an unmatched
    // 20 deg/s tone off the list — and the rotor-order rule upstream then passed a
    // flight carrying unexplained vibration — or to push the 1/rev itself off it,
    // so the flight read "clear". So every attention-eligible candidate is listed
    // first, uncapped.
    //
    // THE SUB-THRESHOLD PEAKS KEEP A CAP OF THEIR OWN, five as they always had.
    // Round-2 review: they were first given only "whatever room is left", so each
    // attention-level peak listed cost a small tone the old list held — and a
    // small tone is the only input the tone-coincidence rule and the ambiguity
    // note have. A sub-threshold main 2/rev pushed off by an attention-level
    // 1/rev let D be diagnosed on a ring sitting exactly on that 2/rev. A small
    // peak is dropped now only by the cap on small peaks, or by sitting closer to
    // a listed peak than the analysis resolves — then that peak stands for it.
    //
    // The frequency merge still applies between attention-level peaks: two that
    // are closer than the analysis can resolve are one entry. How many were merged
    // is COUNTED and published (`attentionEligibleUnlistedCount`), so a caller
    // reasoning about "every attention-level peak" can tell a complete list from
    // one that is not, instead of assuming. Over the 43 real flight windows in the
    // private corpus it is zero on every axis, and the listed peaks are identical
    // to what the old order produced on every one of them.
    var selected = [];
    var unlistedEligible = 0;
    var eligibleCount = 0;
    candidates.forEach(function(candidate) {
        if (candidate.attentionEligible !== true) {
            return;
        }
        eligibleCount++;
        if (tooCloseToSelected(selected, candidate)) {
            unlistedEligible++;
        } else {
            selected.push(candidate);
        }
    });
    // A PEAK ABOVE THE LEVEL FOR PART OF THE RANGE IS NEVER CAPPED, AND NEVER
    // MERGED. Stage 2d, review of 3 October 2026: a tone that reached the level
    // in some windows but is not attention-eligible — too few of them, too short
    // a span, too few quarters, too long a gap — was ranked among the small
    // peaks on persistence it does not have, so five small steady harmonics
    // pushed it off the list, and the airframe rung read "clear" over a tone
    // measured at three to six times the level while it was there. Each one is a
    // measurement the airframe rung must see, so each is listed as itself, even
    // beside a listed neighbour closer than the analysis resolves. Since the
    // Stage 2d follow-up that includes a burst present in too few windows to be a
    // persistent tone at all (see the presence check in the loop above).
    candidates.forEach(function(candidate) {
        if (candidate.attentionEligible !== true
                && candidate.attentionWindowBandRmsDps !== null) {
            selected.push(candidate);
        }
    });
    // Counted on its own: never `selected.length`, which includes the
    // attention-level peaks above.
    var subThresholdListed = 0;
    candidates.forEach(function(candidate) {
        if (candidate.attentionEligible !== true
                && candidate.attentionWindowBandRmsDps === null
                && subThresholdListed < MAX_PEAKS_PER_AXIS
                && !tooCloseToSelected(selected, candidate)) {
            selected.push(candidate);
            subThresholdListed++;
        }
    });
    // Published in the same rank order as always, so a list nothing was dropped
    // from reads exactly as it did, ties included.
    var rankOf = new Map();
    candidates.forEach(function(candidate, index) {
        rankOf.set(candidate, index);
    });
    selected.sort(function(left, right) {
        return rankOf.get(left) - rankOf.get(right);
    });
    return {
        peaks: selected,
        globalNoiseFloor: globalFloor,
        maximumHz: maximumHz,
        attentionEligibleCandidateCount: eligibleCount,
        attentionEligibleUnlistedCount: unlistedEligible
    };
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
        attentionEligibleCandidateCount: detected.attentionEligibleCandidateCount,
        attentionEligibleUnlistedCount: detected.attentionEligibleUnlistedCount,
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
    var bestEvidence = rpmSources[best.rotor === "main" ? "headspeed" : "tailspeed"];
    return {
        rotor: best.rotor,
        order: best.order,
        predictedHz: best.predictedHz,
        deltaHz: best.deltaHz,
        toleranceHz: best.toleranceHz,
        // What a narrower tolerance is built from, published as measured rather
        // than folded into the one above (Stage 2d): half the rotor speed's
        // p5-p95 spread, at this order, and the analysis resolution. The match
        // itself is the wide one, max(1.5 bins, 2.5%, spread) — about 2.9 Hz at a
        // 2 Hz resolution — which NAMES a peak by its nearest order; whether the
        // peak IS that order is a question for whoever reads the match.
        spreadHz: bestEvidence.relativeSpread * best.predictedHz / 2,
        frequencyResolutionHz: frequencyResolutionHz
    };
}

function compactPeak(peak) {
    return {
        frequencyHz: round(peak.frequencyHz, 2),
        // Between the bins; see `interpolatedPeakHz`.
        interpolatedFrequencyHz: round(peak.interpolatedFrequencyHz, 3),
        psdDps2PerHz: round(peak.psdDps2PerHz, 6),
        localNoisePsdDps2PerHz: round(peak.localNoisePsdDps2PerHz, 6),
        relativePowerDb: round(peak.relativePowerDb, 2),
        prominenceDb: round(peak.prominenceDb, 2),
        bandwidthHz: round(peak.bandwidthHz, 2),
        bandPowerDps2: round(peak.bandPowerDps2, 4),
        bandRmsDps: round(peak.bandRmsDps, 3),
        // Its size while present; see `detectPeaks`. Null when it never reached
        // the attention level in any window.
        attentionWindowBandRmsDps: round(peak.attentionWindowBandRmsDps, 3),
        // True when no window held the tone for the whole of its length, so the
        // size above is a lower bound on it; see `sizeWhileAboveLevel`.
        attentionWindowSizeIsLowerBound: peak.attentionWindowSizeIsLowerBound === true,
        supportingWindowCount: peak.supportingWindowCount,
        evaluatedWindowCount: peak.evaluatedWindowCount,
        persistenceRatio: round(peak.persistenceRatio, 3),
        attentionSupportingWindowCount: peak.attentionSupportingWindowCount,
        attentionPersistenceRatio: round(peak.attentionPersistenceRatio, 3),
        attentionTemporalSpanRatio: round(peak.attentionTemporalSpanRatio, 3),
        attentionOccupiedBucketCount: peak.attentionOccupiedBucketCount,
        attentionMaximumGapRatio: round(peak.attentionMaximumGapRatio, 3),
        attentionEligible: peak.attentionEligible === true,
        // Which attention criteria it did not meet; see `detectPeaks`.
        attentionCriteriaUnmet: Array.isArray(peak.attentionCriteriaUnmet)
            ? peak.attentionCriteriaUnmet.slice() : [],
        harmonicMatch: peak.harmonicMatch ? {
            rotor: peak.harmonicMatch.rotor,
            order: peak.harmonicMatch.order,
            predictedHz: round(peak.harmonicMatch.predictedHz, 2),
            deltaHz: round(peak.harmonicMatch.deltaHz, 2),
            toleranceHz: round(peak.harmonicMatch.toleranceHz, 2),
            spreadHz: round(peak.harmonicMatch.spreadHz, 3),
            frequencyResolutionHz: round(peak.harmonicMatch.frequencyResolutionHz, 4)
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
    // Persistent peaks only: a burst listed for having reached the attention
    // level is not one. An attention-eligible peak is always reported.
    var prominent = [];
    result.axes.forEach(function(axis) {
        axis.peaks.forEach(function(peak) {
            if (peak.attentionEligible === true || meetsPresenceRequirement(peak)) {
                prominent.push({ axis: axis, peak: peak });
            }
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
    // A burst listed for having reached the attention level is not a persistent
    // peak (Stage 2d follow-up); see `meetsPresenceRequirement`.
    var hasPersistentPeak = availableAxes.some(function(axis) {
        return axis.peaks.some(meetsPresenceRequirement);
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
            // Every attention-eligible peak is in `peaks` except those merged into
            // a listed one closer than the analysis resolves; this many were. A
            // claim about EVERY attention-level peak holds only where it is 0.
            attentionEligibleCandidateCount: axis.attentionEligibleCandidateCount,
            attentionEligibleUnlistedCount: axis.attentionEligibleUnlistedCount,
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

/* ------------------------------------------------------------ the whole window */

/*
 * A flight window longer than one analysis accepts, measured whole.
 *
 * One analysis is capped at MAX_INPUT_SAMPLES (262,144, inclusive) and at
 * MAX_SELECTION_DURATION_US (262.144 s). Audit of 2 October 2026: the app clamped
 * the window by DURATION alone, so at Rotorflight's own 993 us interval (1007 Hz)
 * a 262 s window still held 263,834 samples and came back
 * SELECTION_SAMPLE_LIMIT_EXCEEDED — "not measured" — and at 2 kHz anything over
 * about 131 s did. An ordinary five-minute pack was never measured, and with it
 * every gain finding was blocked. Where the clamp did hold, a stop after 262 s
 * fell outside the measured range and blocked everything anyway.
 *
 * So a long window is split into the fewest roughly equal stretches that each
 * fit both caps, analysed one after another, and combined CONSERVATIVELY: the
 * worst stretch speaks for the flight. Nothing is averaged across stretches,
 * because averaging is how a fault confined to the last two minutes disappears.
 *
 *   status         attention > insufficient > clear
 *   gate           permitted only if every stretch was permitted
 *   correlation    evaluated only if every stretch was evaluated
 *   reason codes   the union
 *   peaks          every stretch's, each carrying the stretch it was measured in
 *   amplitudes     the largest; coverage ratios the smallest
 *   head speed     each stretch's own median, and their range; no single median
 *                  or fundamental, since none was measured across the window; a
 *                  spread bounded from above across the whole window
 *   peak lists     complete only if every stretch's was
 *
 * A window one analysis already accepts is never split: its result IS that
 * analysis's result, field for field, so nothing that fits today reads
 * differently tomorrow.
 *
 * Measurements only, like everything else in this file.
 */

/**
 * Share of each cap a stretch is planned to fill once a split is needed. A
 * boundary sample is shared by the two stretches either side of it, and the
 * resampled count of a stretch depends on that stretch's own median interval,
 * so planning to exactly the cap would leave a stretch to meet it on rounding.
 */
var CHUNK_CAP_MARGIN = 0.95;

/** How many times a plan is re-split after a stretch still met a cap. */
var MAX_CHUNK_PLAN_ESCALATIONS = 8;

/** How many larger stretch counts the planner tries before settling. */
var MAX_CHUNK_PLAN_SEARCH = 64;

/** The codes that mean "this stretch was too big", not "this flight is bad". */
var CHUNK_CAP_REASONS = Object.freeze([
    "SELECTION_SAMPLE_LIMIT_EXCEEDED",
    "SELECTION_DURATION_LIMIT_EXCEEDED",
    "RESAMPLED_SAMPLE_LIMIT_EXCEEDED"
]);

function hitsChunkCap(result) {
    return (result.reasonCodes || []).some(function(code) {
        return CHUNK_CAP_REASONS.indexOf(code) !== -1;
    });
}

/**
 * Splits `range` into `count` stretches of roughly equal sample count.
 *
 * Interior boundaries sit ON a sample, which both neighbouring stretches then
 * include, so the stretches tile the window with nothing between them. Returns
 * null when a boundary cannot be placed on a finite, strictly later timestamp;
 * the caller then analyses the window whole, exactly as before.
 */
function splitIntoStretches(times, range, firstIndex, sampleCount, count) {
    var stretches = [];
    var previousIndex = firstIndex;
    var previousTimeUs = range.startTimeUs;
    for (var stretch = 1; stretch <= count; stretch++) {
        var index = stretch === count
            ? firstIndex + sampleCount - 1
            : firstIndex + Math.round(stretch * (sampleCount - 1) / count);
        var endTimeUs = stretch === count ? range.endTimeUs : times[index];
        if (!Number.isFinite(endTimeUs) || !(endTimeUs > previousTimeUs)) {
            return null;
        }
        stretches.push({
            startTimeUs: previousTimeUs,
            endTimeUs: endTimeUs,
            plannedSampleCount: index - previousIndex + 1
        });
        previousIndex = index;
        previousTimeUs = endTimeUs;
    }
    return stretches;
}

function stretchFits(stretch) {
    return stretch.plannedSampleCount <= MAX_INPUT_SAMPLES
        && stretch.endTimeUs - stretch.startTimeUs <= MAX_SELECTION_DURATION_US;
}

/**
 * The fewest roughly equal stretches that each fit both caps.
 *
 * One stretch — the window itself — whenever the window fits as it is, which is
 * what keeps every window that fits today byte-identical. `minimumCount` is how
 * a plan is re-split when a stretch still met a cap the plan could not see in
 * advance (the resampled count, which depends on that stretch's own median
 * interval).
 */
function planMechanicalStretches(times, range, minimumCount) {
    var firstIndex = lowerBound(times, range.startTimeUs);
    var sampleCount = upperBound(times, range.endTimeUs) - firstIndex;
    var durationUs = range.endTimeUs - range.startTimeUs;
    var fitsWhole = sampleCount <= MAX_INPUT_SAMPLES && durationUs <= MAX_SELECTION_DURATION_US;
    if ((fitsWhole && !(minimumCount > 1)) || sampleCount < 2) {
        return [range];
    }
    var count = Math.max(
        2,
        minimumCount || 1,
        Math.ceil(sampleCount / Math.floor(MAX_INPUT_SAMPLES * CHUNK_CAP_MARGIN)),
        Math.ceil(durationUs / (MAX_SELECTION_DURATION_US * CHUNK_CAP_MARGIN))
    );
    var lastPlan = null;
    for (var attempt = 0; attempt < MAX_CHUNK_PLAN_SEARCH && count < sampleCount; attempt++) {
        var plan = splitIntoStretches(times, range, firstIndex, sampleCount, count);
        if (plan === null) {
            return lastPlan || [range];
        }
        lastPlan = plan;
        if (plan.every(stretchFits)) {
            return plan;
        }
        count++;
    }
    // A single interval longer than the duration cap cannot be split away. The
    // stretch holding it comes back over the cap, and so the flight comes back
    // insufficient: a missing measurement, said as one.
    return lastPlan || [range];
}

function finiteValues(values) {
    return values.filter(Number.isFinite);
}

function sumOf(values) {
    return values.reduce(function(total, value) { return total + value; }, 0);
}

/** The extreme of a field, but only when every stretch measured it. */
function everyStretch(values, pick) {
    var finite = finiteValues(values);
    return finite.length === values.length && finite.length > 0
        ? pick.apply(null, finite) : null;
}

function combineRpmEvidence(evidences, field, range) {
    var present = evidences.map(function(evidence) {
        return evidence || unavailableRpmEvidence(field, "NOT_EVALUATED");
    });
    var trustworthy = present.every(function(evidence) {
        return evidence.trustworthy === true;
    });
    var untrusted = present.filter(function(evidence) {
        return evidence.trustworthy !== true;
    });
    // A measured reason is a fact about the log and outranks "not read".
    var worst = untrusted.filter(function(evidence) {
        return evidence.state === "unavailable";
    })[0] || untrusted[0] || null;
    // NO HEAD SPEED IS INVENTED FOR THE WINDOW. Review of 2 October 2026: this
    // took the median of the stretch medians and the largest within-stretch
    // spread, so a stretch at 1500 rpm and one at 1800 came back as a
    // "trustworthy" 1650 rpm — a speed the rotor never turned at — with a spread
    // of 0.0024, while the window itself ran 1498 to 1802. Every peak is matched
    // against the head speed of its OWN stretch, so no decision rested on those
    // two numbers; the published measurement did, and it was false.
    //
    // So the window publishes what was measured: each stretch's median, their
    // range, and no single median or fundamental, because none was measured
    // across the window.
    var stretchMedians = present.map(function(evidence) {
        return Number.isFinite(evidence.medianRpm) ? evidence.medianRpm : null;
    });
    var medians = finiteValues(stretchMedians);
    var spreads = finiteValues(present.map(function(evidence) {
        return evidence.relativeSpread;
    }));
    var p05s = finiteValues(present.map(function(evidence) { return evidence.p05Rpm; }));
    var p95s = finiteValues(present.map(function(evidence) { return evidence.p95Rpm; }));
    var lowestP05 = p05s.length > 0 ? Math.min.apply(null, p05s) : null;
    var highestP95 = p95s.length > 0 ? Math.max.apply(null, p95s) : null;
    var lowestMedian = medians.length > 0 ? Math.min.apply(null, medians) : null;
    // The spread across the window, bounded from above rather than estimated.
    // The window's own 95th percentile is no higher than the highest stretch's,
    // its 5th no lower than the lowest stretch's, and its median no lower than
    // the lowest stretch median — so this is never steadier than the window was,
    // and never steadier than any one stretch.
    var acrossSpread = lowestP05 !== null && highestP95 !== null && lowestMedian > 0
        ? (highestP95 - lowestP05) / lowestMedian : null;
    var relativeSpread = acrossSpread !== null
        ? Math.max.apply(null, [acrossSpread].concat(spreads))
        : (spreads.length > 0 ? Math.max.apply(null, spreads) : null);
    var coverages = finiteValues(present.map(function(evidence) {
        return evidence.coverageRatio;
    }));
    return {
        field: field,
        available: present.every(function(evidence) { return evidence.available === true; }),
        trustworthy: trustworthy,
        state: trustworthy ? "trustworthy" : worst.state,
        reasonCode: trustworthy ? null : worst.reasonCode,
        sampleCount: sumOf(finiteValues(present.map(function(evidence) {
            return evidence.sampleCount;
        }))),
        coverageRatio: coverages.length > 0 ? Math.min.apply(null, coverages) : 0,
        medianRpm: null,
        // One entry per stretch, in time order; null where a stretch read none.
        stretchMedianRpm: stretchMedians,
        medianRpmRange: medians.length > 0
            ? [lowestMedian, Math.max.apply(null, medians)] : null,
        p05Rpm: lowestP05,
        p95Rpm: highestP95,
        fundamentalHz: null,
        relativeSpread: relativeSpread,
        timeRangeUs: [range.startTimeUs, range.endTimeUs]
    };
}

function combineHarmonicCorrelation(correlations) {
    var present = correlations.map(function(correlation) {
        return correlation || harmonicCorrelationAvailability(null);
    });
    var rotors = ["headspeed", "tailspeed"];
    var evaluatedRotors = rotors.filter(function(rotor) {
        return present.every(function(correlation) {
            return (correlation.evaluatedRotors || []).indexOf(rotor) !== -1;
        });
    });
    var everyEvaluated = evaluatedRotors.length > 0 && present.every(function(correlation) {
        return correlation.evaluated === true;
    });
    var state = everyEvaluated
        ? "evaluated"
        : (present.some(function(correlation) { return correlation.state === "unavailable"; })
            || present.every(function(correlation) { return correlation.evaluated === true; })
            ? "unavailable"
            : "not-evaluated");
    var unavailableRotors = [];
    rotors.forEach(function(rotor) {
        if (everyEvaluated && evaluatedRotors.indexOf(rotor) !== -1) {
            return;
        }
        var reasons = [];
        present.forEach(function(correlation) {
            (correlation.unavailableRotors || []).forEach(function(entry) {
                if (entry.field === rotor && entry.reasonCode) {
                    reasons.push(entry.reasonCode);
                }
            });
        });
        var measured = reasons.filter(function(code) { return code !== "NOT_EVALUATED"; });
        unavailableRotors.push(Object.freeze({
            field: rotor,
            reasonCode: measured[0] || reasons[0] || "NOT_EVALUATED"
        }));
    });
    return Object.freeze({
        state: state,
        evaluated: everyEvaluated,
        evaluatedRotors: Object.freeze(everyEvaluated ? evaluatedRotors : []),
        unavailableRotors: Object.freeze(unavailableRotors)
    });
}

var AXIS_COUNT_FIELDS = Object.freeze([
    "windowCount", "candidateWindowCount", "totalPossibleWindowCount", "validWindowCount"
]);
var AXIS_COVERAGE_FIELDS = Object.freeze([
    "windowCoverageRatio", "validWindowCoverageRatio",
    "finiteSampleCoverageRatio", "finiteTimeSpanCoverageRatio"
]);
var AXIS_AMPLITUDE_FIELDS = Object.freeze([
    "rmsDps", "broadbandPowerDps2", "broadbandRmsDps", "medianNoisePsdDps2PerHz"
]);
var ATTENTION_COUNT_FIELDS = Object.freeze([
    "attentionEligibleCandidateCount", "attentionEligibleUnlistedCount"
]);

function combineAxes(results) {
    var combined = [];
    AXIS_NAMES.forEach(function(name) {
        var entries = results.map(function(result) {
            return (result.axes || []).filter(function(axis) { return axis.axis === name; })[0]
                || null;
        });
        var present = entries.filter(Boolean);
        if (present.length === 0) {
            return;
        }
        var available = entries.every(function(entry) {
            return entry !== null && entry.available === true;
        });
        var axis = { axis: name, source: present[0].source };
        var kinds = present.map(function(entry) { return entry.amplitudeKind; })
            .filter(function(kind) { return kind !== undefined; });
        if (kinds.length > 0) {
            axis.amplitudeKind = kinds[0];
        }
        axis.available = available;
        if (!available) {
            // The first stretch that could not measure this axis says why. A
            // stretch that returned no axes at all failed before any axis was
            // looked at, so its own first reason is the reason.
            for (var index = 0; index < entries.length; index++) {
                var entry = entries[index];
                if (entry === null) {
                    axis.reasonCode = (results[index].reasonCodes || [])[0]
                        || "GYRO_COVERAGE_INSUFFICIENT";
                    break;
                }
                if (entry.available !== true) {
                    axis.reasonCode = entry.reasonCode || "GYRO_COVERAGE_INSUFFICIENT";
                    break;
                }
            }
        } else {
            axis.sampleCount = sumOf(finiteValues(present.map(function(entry) {
                return entry.sampleCount;
            })));
            // The loudest stretch, never an average: a floor raised for the last
            // two minutes is a raised floor.
            AXIS_AMPLITUDE_FIELDS.forEach(function(field) {
                axis[field] = everyStretch(
                    present.map(function(entry) { return entry[field]; }), Math.max
                );
            });
        }
        AXIS_COUNT_FIELDS.forEach(function(field) {
            axis[field] = sumOf(finiteValues(present.map(function(entry) { return entry[field]; })));
        });
        // Whether the peak list holds every attention-level peak is known for the
        // window only when every stretch measured this axis and said so; a
        // stretch that did not leaves it unknown, never zero.
        ATTENTION_COUNT_FIELDS.forEach(function(field) {
            axis[field] = everyStretch(entries.map(function(entry) {
                return entry && entry.available === true ? entry[field] : null;
            }), function() {
                return sumOf(Array.prototype.slice.call(arguments));
            });
        });
        AXIS_COVERAGE_FIELDS.forEach(function(field) {
            var values = finiteValues(present.map(function(entry) { return entry[field]; }));
            axis[field] = values.length > 0 ? Math.min.apply(null, values) : 0;
        });
        axis.firstFiniteSampleTimeUs = present[0].firstFiniteSampleTimeUs === undefined
            ? null : present[0].firstFiniteSampleTimeUs;
        axis.lastFiniteSampleTimeUs = present[present.length - 1].lastFiniteSampleTimeUs
            === undefined ? null : present[present.length - 1].lastFiniteSampleTimeUs;
        axis.leadingFiniteGapUs = entries[0] && entries[0].leadingFiniteGapUs !== undefined
            ? entries[0].leadingFiniteGapUs : null;
        axis.trailingFiniteGapUs = entries[entries.length - 1]
            && entries[entries.length - 1].trailingFiniteGapUs !== undefined
            ? entries[entries.length - 1].trailingFiniteGapUs : null;
        axis.peaks = [];
        entries.forEach(function(entry, index) {
            if (!entry) {
                return;
            }
            var result = results[index];
            (entry.peaks || []).forEach(function(peak) {
                var copy = Object.assign({}, peak);
                // Where it was measured, and what the rotor comparison was THERE:
                // a peak in a stretch whose head speed was steady was genuinely
                // compared, whatever happened in the stretch beside it.
                copy.chunkRangeUs = [result.range.startTimeUs, result.range.endTimeUs];
                copy.chunkHarmonicCorrelation = result.harmonicCorrelation
                    || harmonicCorrelationAvailability(null);
                axis.peaks.push(copy);
            });
        });
        combined.push(axis);
    });
    return combined;
}

function combineQuality(results, sampleCount) {
    var qualities = results.map(function(result) { return result.quality || {}; });
    var field = function(name) {
        return qualities.map(function(quality) { return quality[name]; });
    };
    return {
        status: qualities.every(function(quality) { return quality.status === "accepted"; })
            ? "accepted" : "insufficient",
        chunkCount: results.length,
        sourceSampleCount: sampleCount,
        measuredSampleRateHz: everyStretch(field("measuredSampleRateHz"), Math.min),
        medianIntervalUs: everyStretch(field("medianIntervalUs"), Math.max),
        p95IntervalUs: everyStretch(field("p95IntervalUs"), Math.max),
        selectedTimestampSpanCoverageRatio:
            everyStretch(field("selectedTimestampSpanCoverageRatio"), Math.min),
        validWindowCoverageRatio: everyStretch(field("validWindowCoverageRatio"), Math.min),
        finiteSampleCoverageRatio: everyStretch(field("finiteSampleCoverageRatio"), Math.min),
        finiteTimeSpanCoverageRatio: everyStretch(field("finiteTimeSpanCoverageRatio"), Math.min),
        frequencyResolutionHz: everyStretch(field("frequencyResolutionHz"), Math.max),
        maximumAnalyzedFrequencyHz: everyStretch(field("maximumAnalyzedFrequencyHz"), Math.min),
        minimumCoverageRatio: MIN_VALID_WINDOW_COVERAGE_RATIO,
        maximumInputSamples: MAX_INPUT_SAMPLES,
        maximumSelectionDurationUs: MAX_SELECTION_DURATION_US,
        maximumWelchWindowsPerAxis: MAX_WELCH_WINDOWS,
        attentionBandRmsThresholdDps: ATTENTION_BAND_RMS_THRESHOLD_DPS,
        attentionThresholdBasis: ATTENTION_THRESHOLD_BASIS
    };
}

/**
 * Combines consecutive stretch results into one result for the whole window.
 *
 * `results` are raw results from `analyzeMechanicalTimeSeries`, in time order,
 * over stretches that tile `timeRangeUs`. One result comes back unchanged. More
 * than one come back as a single result of the same shape whose `range` spans
 * the window, combined so that the worst stretch speaks for the flight — see the
 * table at the head of this section — plus `chunks`, one line per stretch.
 *
 * Exported so the combination can be checked on its own. A caller measuring a
 * window should use `analyzeMechanicalWindow`, which plans the stretches.
 */
function combineMechanicalResults(results, timeRangeUs) {
    if (!Array.isArray(results) || results.length === 0) {
        throw codedError(
            TypeError,
            "MECHANICAL_RESULTS_REQUIRED",
            "At least one analysed stretch is required"
        );
    }
    if (results.length === 1) {
        return results[0];
    }
    var first = results[0];
    var last = results[results.length - 1];
    var range = {
        startTimeUs: timeRangeUs && Number.isFinite(timeRangeUs.startTimeUs)
            ? timeRangeUs.startTimeUs : first.range.startTimeUs,
        endTimeUs: timeRangeUs && Number.isFinite(timeRangeUs.endTimeUs)
            ? timeRangeUs.endTimeUs : last.range.endTimeUs
    };
    var statuses = results.map(function(result) { return result.status; });
    var status = statuses.indexOf("attention") !== -1
        ? "attention"
        : (statuses.every(function(value) { return value === "clear"; }) ? "clear" : "insufficient");
    var reasons = [];
    results.forEach(function(result) {
        (result.reasonCodes || []).forEach(function(code) { addReason(reasons, code); });
    });
    var counts = results.map(function(result) { return result.range && result.range.sampleCount; });
    // Interior boundaries sit on a sample both neighbours include; count it once.
    var sampleCount = counts.every(Number.isFinite)
        ? sumOf(counts) - (results.length - 1) : null;

    var combined = baseResult(range, status, reasons, sampleCount);
    var permitted = results.every(function(result) {
        return result.tuningEvidenceGate && result.tuningEvidenceGate.status === "permitted";
    });
    combined.tuningEvidenceGate = permitted
        ? { status: "permitted", reasonCodes: [] }
        : { status: "blocked", reasonCodes: reasons.slice() };

    var bands = results.map(function(result) { return result.analyzedBandHz; });
    combined.analyzedBandHz = bands.every(function(band) {
        return Array.isArray(band) && band.length === 2
            && Number.isFinite(band[0]) && Number.isFinite(band[1]);
    })
        ? [
            Math.max.apply(null, bands.map(function(band) { return band[0]; })),
            Math.min.apply(null, bands.map(function(band) { return band[1]; }))
        ]
        : null;
    var folds = results.map(function(result) { return result.aliasingFoldFrequencyHz; });
    if (folds.every(Number.isFinite)) {
        combined.aliasingFoldFrequencyHz = Math.min.apply(null, folds);
    }
    combined.quality = combineQuality(results, sampleCount);
    combined.rpmEvidence = {
        headspeed: combineRpmEvidence(results.map(function(result) {
            return result.rpmEvidence && result.rpmEvidence.headspeed;
        }), "headspeed", range),
        tailspeed: combineRpmEvidence(results.map(function(result) {
            return result.rpmEvidence && result.rpmEvidence.tailspeed;
        }), "tailspeed", range)
    };
    combined.harmonicCorrelation = combineHarmonicCorrelation(results.map(function(result) {
        return result.harmonicCorrelation;
    }));
    combined.axes = combineAxes(results);
    // Each stretch's findings already carry the time range they describe.
    combined.findings = [];
    results.forEach(function(result) {
        (result.findings || []).forEach(function(finding) { combined.findings.push(finding); });
    });
    combined.chunks = results.map(function(result) {
        return {
            startTimeUs: result.range.startTimeUs,
            endTimeUs: result.range.endTimeUs,
            durationUs: result.range.durationUs,
            sampleCount: result.range.sampleCount,
            status: result.status,
            reasonCodes: (result.reasonCodes || []).slice(),
            tuningEvidenceGate: result.tuningEvidenceGate ? result.tuningEvidenceGate.status : null,
            harmonicCorrelationState: result.harmonicCorrelation
                ? result.harmonicCorrelation.state : null
        };
    });
    return combined;
}

/**
 * Measures a whole window, however long, as one result.
 *
 * Takes what `analyzeMechanicalTimeSeries` and `analyzeMechanicalSpectrum` take
 * — a series from `buildMechanicalSeries` or a decoded session — and the same
 * options, and refuses the same caller errors with the same codes. A window one
 * analysis accepts is handed to that analysis unchanged. A longer one is
 * measured in consecutive stretches, AWAITED ONE AT A TIME so that only one
 * stretch's samples are ever collected at once, and combined by
 * `combineMechanicalResults`.
 *
 * This is the entry point for anything that measures the flight window: the
 * recommendation path and the vibration panel both come through here, so the
 * two cannot measure different seconds of the same flight.
 *
 * @param {object} sessionOrSeries a session from `decodeLog`, or the result of
 *   `buildMechanicalSeries`
 * @param {object} options as `analyzeMechanicalTimeSeries`
 */
async function analyzeMechanicalWindow(sessionOrSeries, options) {
    var settings = options || {};
    checkCancelled(settings);
    var series = sessionOrSeries;
    if (!(sessionOrSeries && sessionOrSeries.gyroSources)) {
        series = buildMechanicalSeries(sessionOrSeries);
        if (!series.usable) {
            return analyzeMechanicalSpectrum(sessionOrSeries, settings);
        }
    }
    var times = series && series.timeUs;
    if (!times || typeof times.length !== "number" || times.length === 0) {
        return analyzeMechanicalTimeSeries(series, settings);
    }
    requireGyroSources(series);
    var range = normalizeRange(settings.timeRangeUs, times[0], times[times.length - 1]);

    var minimumCount = 1;
    for (var escalation = 0; ; escalation++) {
        var plan = planMechanicalStretches(times, range, minimumCount);
        var finalAttempt = escalation >= MAX_CHUNK_PLAN_ESCALATIONS;
        if (plan.length === 1) {
            // Exactly the call a single analysis makes, so its result is exactly
            // the result a single analysis returns.
            var whole = await analyzeMechanicalTimeSeries(series, settings);
            if (!hitsChunkCap(whole) || finalAttempt) {
                return whole;
            }
            minimumCount = 2;
            continue;
        }
        var results = [];
        for (var index = 0; index < plan.length; index++) {
            checkCancelled(settings);
            results.push(await analyzeMechanicalTimeSeries(series, Object.assign({}, settings, {
                timeRangeUs: { startTimeUs: plan[index].startTimeUs, endTimeUs: plan[index].endTimeUs }
            })));
        }
        if (!results.some(hitsChunkCap) || finalAttempt) {
            return combineMechanicalResults(results, range);
        }
        minimumCount = plan.length + 1;
    }
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
 *
 * A FOURTH, "near-order" (copy review of 3 October 2026, finding 3): the
 * harmonic match NAMES a peak by its nearest order within the wider of a bin and
 * a half, 2.5% and the speed's spread, and leaves whether the peak IS that order
 * to whoever reads it (see `bestHarmonicMatch`). This is that reader for a
 * screen, and it asks what the airframe gate asks (`rotorOrderMatchEstablished`
 * in recommendation-gates.mjs): is the peak's interpolated frequency within half
 * the logged speed's own p5-p95 spread at that order, plus half an analysis bin?
 * "explained" only where it is; "near-order" where it is named the order and
 * sits further out, which the panel drew as a green "main 1/rev" over a tone the
 * airframe card called not the rotor's own. Both numbers travel with it.
 */
function peakRotorAttribution(peak, correlation) {
    var noOffset = {offsetFromOrderHz: null, offsetAllowedHz: null};
    if (peak.harmonicMatch) {
        var identity = rotorOrderIdentity(peak);
        return {
            state: identity !== null && identity.offsetHz <= identity.allowedHz
                ? "explained" : "near-order",
            rotor: peak.harmonicMatch.rotor,
            order: peak.harmonicMatch.order,
            predictedHz: peak.harmonicMatch.predictedHz,
            deltaHz: peak.harmonicMatch.deltaHz,
            toleranceHz: peak.harmonicMatch.toleranceHz,
            // How far the peak sits from the order it is named, and how far the
            // logged speed of that rotor lets it; null where not published.
            offsetFromOrderHz: identity !== null ? round(identity.offsetHz, 3) : null,
            offsetAllowedHz: identity !== null ? round(identity.allowedHz, 3) : null,
            unavailableRotors: []
        };
    }
    if (correlation && correlation.evaluated === true) {
        return Object.assign({
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
        }, noOffset);
    }
    return Object.assign({
        // Not a measurement about the aircraft. Nothing was compared.
        state: "not-checked",
        rotor: null,
        order: null,
        predictedHz: null,
        deltaHz: null,
        toleranceHz: null,
        unavailableRotors: correlation ? correlation.unavailableRotors.slice() : []
    }, noOffset);
}

/**
 * How far a matched peak sits from the order it is named, read at its
 * interpolated frequency (the bin's own where none was published), and how far
 * the logged speed allows: half its p5-p95 spread at that order plus half an
 * analysis bin. Null where the match does not carry what that needs. The same
 * measurement as `rotorOrderMatchDistance` in recommendation-gates.mjs, which a
 * test holds this to peak by peak; restated here rather than imported so the
 * viewer's start-up graph does not take in the advice gates for one comparison.
 */
function rotorOrderIdentity(peak) {
    var match = peak.harmonicMatch;
    var frequencyHz = Number.isFinite(peak.interpolatedFrequencyHz)
        ? peak.interpolatedFrequencyHz : peak.frequencyHz;
    if (!match || !Number.isFinite(frequencyHz) || !Number.isFinite(match.predictedHz)
            || !Number.isFinite(match.spreadHz)
            || !Number.isFinite(match.frequencyResolutionHz)) {
        return null;
    }
    return {
        offsetHz: Math.abs(frequencyHz - match.predictedHz),
        allowedHz: match.spreadHz + match.frequencyResolutionHz / 2
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
    // The whole window, however long. A window one analysis accepts is analysed
    // exactly as it always was; a longer one is measured in stretches and
    // combined, the same way the recommendation path measures it, so the panel
    // and the airframe finding cannot be about different seconds.
    return summarizeMechanicalResult(await analyzeMechanicalWindow(sessionOrSeries, options));
}

/**
 * The summary shape for an already-computed raw result.
 *
 * Pure. A result combined from several stretches adds `chunks` to the summary,
 * and each peak from one adds `chunkRangeUs`; a single-stretch result adds
 * neither, so its summary is the one it always was.
 */
function summarizeMechanicalResult(result) {
    var correlation = result.harmonicCorrelation;
    var headspeed = result.rpmEvidence.headspeed;
    var tailspeed = result.rpmEvidence.tailspeed;

    var view = {
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
                    var summary = {
                        frequencyHz: peak.frequencyHz,
                        amplitudeDps: peak.bandRmsDps,
                        bandwidthHz: peak.bandwidthHz,
                        prominenceDb: peak.prominenceDb,
                        persistenceRatio: peak.persistenceRatio,
                        // Above the experimental threshold published above, not
                        // above any limit Rotorflight or anyone else has set.
                        aboveAttentionThreshold: peak.attentionEligible === true,
                        // Stage 2d. Its size while it was above that threshold,
                        // the share of the analysed windows it was above it in,
                        // and whether that size is only "at least" (no window held
                        // the tone whole). `amplitudeDps` is its average over every
                        // window, which for a tone that comes and goes reads under
                        // the very threshold it was above. Null and 0 for a peak
                        // that never reached the threshold in any window.
                        amplitudeWhileAboveThresholdDps: Number.isFinite(
                            peak.attentionWindowBandRmsDps
                        ) ? peak.attentionWindowBandRmsDps : null,
                        amplitudeWhileAboveThresholdAtLeast:
                            peak.attentionWindowSizeIsLowerBound === true,
                        aboveThresholdShare: Number.isFinite(peak.attentionPersistenceRatio)
                            ? peak.attentionPersistenceRatio : 0,
                        // Copy review of 3 October 2026, finding 8: whether it
                        // is a persistent tone, by the same presence rule the
                        // findings above apply, or a burst listed only for
                        // having reached the threshold in some window — which a
                        // count of "persistent tones" must not include.
                        persistent: peak.attentionEligible === true
                            || meetsPresenceRequirement(peak),
                        // Judged against the rotor comparison of the stretch the
                        // peak was measured in, when it came from one.
                        rotorHarmonic: peakRotorAttribution(
                            peak, peak.chunkHarmonicCorrelation || correlation
                        )
                    };
                    if (Array.isArray(peak.chunkRangeUs)) {
                        summary.chunkRangeUs = peak.chunkRangeUs.slice();
                    }
                    return summary;
                })
            };
        }),
        sources: result.sources
    };
    // A window measured in stretches has no one head speed; each stretch's is
    // published instead, beside their range. Absent on a single analysis, whose
    // summary is unchanged.
    ["headspeed", "tailspeed"].forEach(function(rotor) {
        var evidence = result.rpmEvidence[rotor];
        if (Array.isArray(evidence.stretchMedianRpm)) {
            view.rotorCorrelation[rotor].stretchMedianRpm = evidence.stretchMedianRpm.slice();
            view.rotorCorrelation[rotor].medianRpmRange = Array.isArray(evidence.medianRpmRange)
                ? evidence.medianRpmRange.slice() : null;
        }
    });
    if (Array.isArray(result.chunks)) {
        view.chunks = result.chunks.map(function(chunk) {
            return {
                startTimeUs: chunk.startTimeUs,
                endTimeUs: chunk.endTimeUs,
                status: chunk.status,
                reasonCodes: chunk.reasonCodes.slice()
            };
        });
    }
    return view;
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
    attentionThresholdBasis: ATTENTION_THRESHOLD_BASIS,
    // Share of each cap a stretch is planned to, once a window must be split.
    chunkCapMargin: CHUNK_CAP_MARGIN
});

export {
  analyzeMechanicalSpectrum,
  analyzeMechanicalTimeSeries,
  // A whole flight window, however long: the entry point for anything that
  // measures the window, so every caller measures the same seconds.
  analyzeMechanicalWindow,
  combineMechanicalResults,
  // The documented entry point for a screen. Everything above it is the full
  // measurement record; this is the shape a UI can render without reading any
  // of it.
  summarizeMechanicalVibration,
  summarizeMechanicalResult,
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
