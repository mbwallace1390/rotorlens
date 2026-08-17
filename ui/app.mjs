/**
 * RotorLens viewer shell.
 *
 * Loads the real engine modules directly as ES modules — no bundler, no build
 * step, no dependencies. The same `src/` code that Node tests runs here, which
 * is the point: there is no second implementation to drift.
 *
 * Everything happens on the device. The log is read with FileReader and decoded
 * in this page; nothing is uploaded, and there is no network call anywhere in
 * this file.
 *
 * ## 12 August 2026 — a deliberate, documented reversal
 *
 * Until this date this file said, in this comment and in six sentences on
 * screen, that RotorLens reports MEASUREMENTS and NEVER INSTRUCTIONS.
 *
 * The owner has decided the opposite, in his words: "i would like the app to
 * analize the flight log the end user selects and recommend what to adjust,
 * thats always been my plan for the app because a lot of people have no clue
 * what they are looking at when they see all the info and graphs."
 *
 * That is the product's purpose. What did NOT change is the engineering that
 * makes a recommendation worth reading, and every one of these is enforced by
 * the engine rather than by this file:
 *
 *   - A recommendation is EARNED BY EVIDENCE. Where the evidence does not
 *     separate two causes, `buildRecommendations` emits a `next-flight` finding
 *     naming both and the manoeuvre that settles it. This file renders that as a
 *     first-class answer, not as an error.
 *   - MECHANICAL FAULTS OUTRANK GAINS. `RUNGS` puts airframe and head speed
 *     above every gain, and a `blocker` on a higher rung suppresses the
 *     adjustments below it. A shaking helicopter cannot be tuned.
 *   - ONE CHANGE AT A TIME. At most one finding in a result carries `actNow`,
 *     and that is the only one this file gives the loud treatment to.
 *   - EVERY CLAIM SHOWS ITS NUMBERS. `finding.basis` is rendered under each
 *     card so a sceptical reader can check it against the trace below, which is
 *     the whole reason the measurement panels stay on the page.
 *   - ROTORLENS NEVER WRITES TO A FLIGHT CONTROLLER. Unchanged. It reads logs.
 *
 * The sentences that used to say "RotorLens does not tell you what to change"
 * have been replaced rather than deleted: each measurement panel now says what
 * IT is — a measurement you can check the recommendation against — and points
 * at the panel that does the advising. Deleting them outright would have left
 * the reader with no statement of the app's stance at all.
 *
 * ## The screen, in order
 *
 * Recommendations first, because that is what the log was opened for. Then the
 * flight window, because every number above and below it is measured over that
 * window and a pilot who disagrees with it must be able to move it. Then the
 * measurements themselves, which do not go away and do not become advice.
 */

import {
  forgetHistoryFile,
  forgetSharingFile,
  fromFile,
  hasHistoryStore,
  hasNativeHost,
  hasSharingStore,
  onHostFile,
  onHostFileFailed,
  onHostImportProgress,
  onHostImportStarted,
  readHistoryText,
  readSharingText,
  requestFile,
  writeHistoryText,
  writeSharingText
} from './host.mjs';
import {decodeLog} from '../src/blackbox/decode.mjs';
import {findSessionStarts, parseSession} from '../src/blackbox/headers.mjs';
import {sessionEndOffset, sessionIntegrity} from '../src/blackbox/log-integrity.mjs';
import {buildAnalysisRecords, detectStopEvents} from '../src/analysis/records.mjs';
import {
  buildDirectionalStopEvidence,
  buildHoldEvidence,
  EVIDENCE_LIMITS
} from '../src/analysis/pid-evidence.mjs';
import {
  decimate,
  describeHoldCapture,
  describeStopCapture,
  directionalObservations,
  indexAtOrAfter,
  niceStep,
  resolveAxisSignals,
  summarizeAxis,
  TERM_VIEWS
} from '../src/analysis/axis-report.mjs';
import {
  analyzeMechanicalTimeSeries,
  buildMechanicalSeries,
  MECHANICAL_CONSTANTS,
  sessionTimeBounds,
  summarizeMechanicalVibration
} from '../src/analysis/advisor/mechanical-spectrum.mjs';
import {
  checkFlightWindow,
  FlightWindowBasis,
  resolveFlightWindow
} from '../src/analysis/flight-window.mjs';
// `../src/analysis/recommendations.mjs` is NOT imported here. It is fetched in
// `collectRecommendationMaterial`, the one place that uses it; see the note
// there.
import {
  addFlightRecord,
  auditFlightRecord,
  auditShareableRecord,
  buildFlightRecord,
  checkFlightAdmissible,
  compareFlightRecords,
  createHistory,
  deriveAircraftIdentity,
  exportHistory,
  findRecords,
  forgetAircraft,
  forgetEverything,
  forgetFlight,
  HISTORY_LIMITS,
  importHistory,
  isSharingId,
  listAircraft,
  newSharingId,
  selectBaseline,
  shareableRecord
} from '../src/analysis/flight-history.mjs';
/**
 * The same module again, by namespace, for one export that may not be there.
 *
 * A fitted gain model is optional and arrives separately: if
 * `src/analysis/flight-history.mjs` exports `buildGainModel`, the learning panel
 * asks it what it believes; if it does not, the panel counts evidence and
 * believes nothing, which is what ships today.
 *
 * It has to be a NAMESPACE import. A named import of an export a module does not
 * have is a link-time error in a browser, and the whole page would go dead —
 * not "no learning panel", but no viewer at all. `namespace.missingExport` is
 * simply `undefined`.
 */
import * as flightHistoryModule from '../src/analysis/flight-history.mjs';

const state = {
  fileName: null,
  // `decodeLog(bytes, {lazy: true})`. Every session's HEADER block is read; no
  // session's FRAMES are, until `openSession` asks for them. See the note above
  // `openSession` for why that is the difference between an app that opens a
  // dataflash dump and one that is killed trying.
  result: null,
  // Where the file ends. Needed to tell an error in the truncated tail from one
  // in the body of the log; see src/blackbox/log-integrity.mjs.
  byteLength: null,
  sessionIndex: 0,
  // Indices whose frames are decoded right now, most recently opened first.
  // Bounded by `DECODED_SESSION_CACHE_BYTES` — see `evictDecodedSessions`.
  decodedSessions: [],
  // How long the session on screen took to read, in ms. A fact about ONE
  // session now, not about the file.
  sessionDecodeMs: null,
  // How many times any session's frames have actually been read since the page
  // loaded. "Switching back must not decode again" is a claim about a count, and
  // only a count can prove it: a needless re-decode produces identical numbers
  // and is invisible to every other assertion. Read by test/ui-browser.test.mjs.
  frameDecodeCount: 0,
  // Bumped on every `openSession` so a decode the pilot has since switched away
  // from retires itself instead of painting its flight over the current one.
  sessionOpenRun: 0,
  // The same, one level up, for `openFile`. `openFile` is `async`, is called
  // fire-and-forget from three places (the file input, a drop, and an Android
  // share intent), and suspends twice before it has a log. Without this a
  // second open entering during the first one's `await` clears the log out from
  // under it, and the first then decodes a session nobody asked for and throws
  // painting it. `openSession` has had this guard since it was written; the
  // call ABOVE it did not, which is where the crash came from.
  fileOpenRun: 0,
  // Session indices an analysis is still reading, as `index -> count`. Exposed
  // so the browser test can assert the invariant that matters — a session under
  // analysis is never released — which is otherwise invisible from the screen.
  // See `analysesInFlight`.
  analysesInFlight: null,
  // The bare record array for `recordsAxis`, over the flight window, and the
  // fields `buildAnalysisRecords` could not resolve while building it.
  records: null,
  recordsAxis: null,
  recordsMissing: [],
  // Resolved column indexes for the selected axis. Deliberately not the record
  // contract: the plot and the axis summary need four columns, and building
  // records for them would cost 45 MiB on a mid-size log for nothing.
  axisSignals: null,
  axisSummary: null,
  // Visible slice of the flight, in log time. Owned here so zoom, pan, the
  // scrubber and a redraw after an axis change all agree on one view.
  view: {startUs: 0, spanUs: 0, firstUs: 0, lastUs: 0},
  // Stop candidates from the last analysis, drawn on the trace so a pilot can
  // see where the detector looked and what it did there.
  marks: [],
  marksAxis: null,

  // ---- the flight window ------------------------------------------------
  // The resolved `resolveFlightWindow` result. EVERY analysis on the page is
  // taken over `[window.startUs, window.endUs]`: the axis summary, the stop
  // detector, the holds, the recommendations and the vibration measurement.
  // Two panels quoting numbers from two different stretches of flight is worse
  // than either panel not existing, so there is one window and it lives here.
  window: null,
  // What the pilot dragged, or null. Handed to `resolveFlightWindow` as
  // `options.override`, which uses it verbatim when it survives
  // `checkFlightWindow` and falls back to detection when it does not.
  windowOverride: null,
  // Where the ends are while a finger is still down. Drawn, but not measured
  // over: the commit happens on release.
  windowPreview: null,
  // Decimated collective and head speed for the window strip, cached because
  // it is redrawn on every drag frame and the log can be 130k samples.
  windowTrace: null,

  // ---- recommendations --------------------------------------------------
  recommendations: null,
  // Axes that were analysed, and any that were not, so the panel can say so.
  recommendationCoverage: null,
  // Bumped on every run so a slow run whose window has since moved can retire
  // itself instead of painting stale advice.
  recommendationRun: 0,

  // ---- flight history ---------------------------------------------------
  // The store, as `src/analysis/flight-history.mjs` plain data. Read once from
  // the host on start and replaced — never mutated — on every change.
  history: null,
  // What `importHistory` made of the file it was handed. Rendered, because a
  // history that silently failed to load looks exactly like one that is empty.
  historyCodes: [],
  // Whether the host can keep anything at all. False in a browser, and saying so
  // is better than a Save button that quietly does nothing.
  historyStorePresent: false,
  historyWritable: false,
  historyReadBlocked: false,
// Whether this log's advice has already pulled the page to its answer. One
// scroll per opened log; see the reset in the file-open path.
answerScrolled: false,
  historyWriteFailed: false,
  // Separate from the write failure: "we could not keep this" and "we could not
  // throw this away" need opposite sentences, and the second is the one where
  // saying nothing would be a lie about a privacy control.
  historyForgetFailed: false,
  // The header block of each decoded session, index-aligned with
  // `result.sessions`. `decodeLog` drops the raw headers, and the PID lines are
  // exactly what a before/after comparison is about — see `readSessionHeaders`.
  sessionHeaders: [],
  // The record for the log on screen. Built, shown, and NOT stored: the policy
  // says a flight is written "when you choose to save" it, so this waits for the
  // button. Null when the log was not admissible.
  candidate: null,
  candidateAdmission: null,
  // Its id once the pilot has chosen to keep it, so the panel can offer Forget
  // instead of Save and cannot store the same flight twice.
  candidateStoredId: null,
  // `compareFlightRecords(previous, candidate)` and the record it was against.
  comparison: null,
  comparisonBefore: null,

  // ---- what has been learned --------------------------------------------
  // `learningFromHistory(...)` for the helicopter whose log is open, so the
  // recommendation cards can say whether an amount rests on this pilot's own
  // flights or on nothing at all. Derived, never stored, and recomputed from
  // scratch every time the history changes — which is what makes forgetting a
  // flight un-learn what it taught.
  learning: null,

  // ---- sharing: a preference and an identity, and NOTHING THAT SENDS -------
  // The sharing file's contents, as plain data. Read from the host on start and
  // replaced — never mutated — on every change, exactly like the history.
  //
  // NOTHING IN THIS APP SENDS ANYTHING ANYWHERE. There is no transport in this
  // build. Android also omits INTERNET and sensitive platform permissions; iOS
  // has no equivalent permission switch. This records a choice and
  // an opaque identity so that the consent, the identity and the deletion path
  // exist and are provable BEFORE anything can be sent, rather than being
  // retrofitted onto phones that already have the app. See the section headed
  // "Shared measurements" below, and docs/SHARED_CORPUS_DESIGN.md.
  sharing: null,
  sharingCodes: [],
  // Whether the host can keep the preference. False in a browser — and a consent
  // question whose answer cannot be written down is one that should not be asked.
  sharingStorePresent: false,
  sharingWritable: false,
  sharingReadBlocked: false,
  sharingWriteFailed: false,
  // Its own flag, like historyForgetFailed: "we could not record this" and "we
  // could not erase this" are opposite sentences, and only the second is a lie
  // about a privacy control when it goes unsaid.
  sharingForgetFailed: false,
  // Whether the consent dialog is open, so one analysis cannot stack two of them
  // and a re-run cannot reopen one the pilot has already answered this session.
  consentOpen: false,
  // Which aircraft's example payload is expanded, or null. One at a time: these
  // are 4 kB of JSON each and the panel is read on a 384px phone.
  sharingShown: null
};

const $ = id => document.getElementById(id);
const show = (id, visible = true) => $(id).classList.toggle('hidden', !visible);

// Android's bridge returns storage results synchronously; iOS's reply-capable
// WebKit bridge returns Promises. One queue gives both the same ordering. The
// revision checks in the writers below reject a second tap that was computed
// from state an earlier queued operation has since replaced, so an old delete
// can never land after a newer one and resurrect a flight or sharing identity.
let storageOperationTail = Promise.resolve();
let historyRevision = 0;
let sharingRevision = 0;

function enqueueStorageOperation(operation) {
  const result = storageOperationTail.then(operation, operation);
  storageOperationTail = result.then(() => undefined, () => undefined);
  return result;
}

/** The one browser/native read allowed to materialize bytes at a time. */
let openReadController = null;

const PANELS = [
  'recommend-panel', 'window-panel', 'session-panel',
  'axis-panel', 'tune-panel', 'plot-panel', 'fields-panel'
];

/**
 * Which way each axis' two command directions point, for a pilot rather than a sign.
 *
 * These words name the side of the aircraft a measurement belongs to, so a wrong
 * one is worse than no word at all: it hands a pilot a real number attached to
 * the wrong half of his machine. Each entry below is therefore measured from the
 * log rather than assumed, and `test/ui-direction-words.test.mjs` re-derives it.
 *
 * **The measurement**, on the reference log (Rotorflight 4.6.0, 134k samples):
 *
 * 1. `attitude[2]` is a true compass heading — 0..3599 decidegrees, increasing
 *    as the nose swings RIGHT. Anchored against GPS, which needs no firmware
 *    convention: rotating the earth-frame acceleration (differenced from
 *    `GPS_speed`/`GPS_ground_course`) into the body frame by `attitude[2] + 8°`
 *    regresses onto the tilt attitudes as a clean diagonal — pitch→forward
 *    +0.157, roll→right +0.169 m/s² per degree, against g·tan(1°) = 0.171 —
 *    with cross terms at corr ≤ 0.07. Rotating by the MIRRORED heading fits
 *    8.9× worse in residual sum of squares (R² 0.05/0.19 against 0.72/0.95).
 *    A reflection is not a rotation, so no free scale sign can absorb it.
 *
 * 2. On that same heading, `d(heading)/dt = -1.0023 × gyroADC[2]`, corr -0.9997
 *    over n=2685. Whole-turn check: a POSITIVE `setpoint[2]` excursion integrates
 *    to +345.7° of gyro while the unwrapped heading moves -346.6°; the negative
 *    one mirrors it (-344.1° against +343.9°).
 *
 * 3. `setpoint[2]` and `gyroADC[2]` track positively, corr +0.993 slope +1.010.
 *
 * So a POSITIVE yaw command decreases the heading, and a decreasing compass
 * heading is the nose going LEFT. This read `positive: 'nose right'` until
 * 12 August 2026, which put the ringing measured after a nose-left stop under
 * the nose-right label on the D panel — the only substantive directional finding
 * this log produces.
 *
 * The roll entry is the control, and it survives the same derivation: positive
 * `attitude[0]` is rolled right (it is the +0.169 term above), and
 * `gyroADC[0]` correlates +0.89 with `d(attitude[0])/dt` at slope +0.921, so a
 * positive roll command rolls right.
 *
 * 4. **Pitch, settled 12 August 2026 on the same GPS anchor.** This read
 *    `positive: 'back'` and it was backwards.
 *
 *    A rotation fit alone cannot settle a sign. With free slopes its residual
 *    sum of squares is identical for a heading offset `o` and for `o + 180°` —
 *    both slopes simply negate — so the branch has to come from somewhere else.
 *    It comes from the GPS TRACK frame, which carries no attitude convention at
 *    all: a compass ground course increases clockwise by definition, so
 *    `speed × d(course)/dt` is an acceleration to the RIGHT OF THE TRACK by
 *    construction. Against it `attitude[0]` regresses at +0.11…+0.13 m/s² per
 *    degree, corr 0.93. Positive `attitude[0]` really is rolled right, so the
 *    `roll → right > 0` branch of the offset sweep is the physical one.
 *
 *    Inside that branch the diagonal model — `aForward = kP·attitude[1]` and
 *    `aRight = kR·attitude[0]`, whose residual, unlike the full 2×2 model's,
 *    is not rotation-invariant — minimises at a heading offset of +4°
 *    (range −2…+9) across 30 independent choices of speed gate, differencing
 *    lag and heading-steadiness gate, and there measures
 *
 *      kR (roll → right)    +0.171  median, corr 0.97  — against g·tan(1°) = 0.171
 *      kP (pitch → forward) +0.138  median, corr 0.83  (+0.157 on the best
 *                                   conditioned variant, n=51, offset +7°)
 *
 *    Both positive in 30 of 30 variants. 20 000 bootstrap resamples put kP in
 *    [+0.127, +0.182] and kR in [+0.157, +0.184] with zero sign flips either
 *    way. MIRRORING the heading — a reflection, which no free scale sign can
 *    absorb — costs 3.5× to 10.6× in residual sum of squares. The offset would
 *    have to be wrong by 85° before kP changes sign.
 *
 *    So a positive `attitude[1]` accelerates the aircraft ALONG ITS OWN NOSE,
 *    which for a helicopter is the disc tilted forward, which is nose-DOWN. The
 *    command chain closes it: `setpoint[1] → gyroADC[1]` slope +0.666 corr 0.63,
 *    `gyroADC[1] → d(attitude[1])/dt` slope +0.853 corr 0.84, and across the 47
 *    sustained pitch excursions in the log the integrated gyro agrees with the
 *    command sign 47 times out of 47 and the attitude change 45 times out of 47.
 *
 *    A positive pitch command therefore puts the nose DOWN and the aircraft
 *    FORWARD. Both words are swapped from what shipped.
 */
const DIRECTION_WORDS = {
  roll: {positive: 'right', negative: 'left'},
  pitch: {positive: 'forward', negative: 'back'},
  yaw: {positive: 'nose left', negative: 'nose right'}
};

function directionWord(axis, direction) {
  return DIRECTION_WORDS[axis]?.[direction] ?? direction;
}

/**
 * HTML-escapes one interpolated value.
 *
 * A craft name, firmware string, field name and filename are all free text that
 * a log or a sharing app chose. `H Craft name:` is everything after the first
 * colon to end of line, so it can contain anything at all.
 *
 * Escape the leaves, never an assembled fragment: the strings built by pill(),
 * codeList() and the issues/parts arrays are deliberate HTML, and escaping those
 * would print tags at the user.
 */
function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function text(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }
  return typeof value === 'number' && !Number.isInteger(value)
    ? value.toFixed(digits)
    : String(value);
}

function pill(kind, label) {
  return `<span class="pill ${kind}">${esc(label)}</span>`;
}

function stat(key, value, hint) {
  return `<div class="stat"><div class="k">${esc(key)}</div><div class="v">${value}</div>` +
    (hint ? `<div class="k" style="text-transform:none;letter-spacing:0;margin-top:4px">${esc(hint)}</div>` : '') +
    '</div>';
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Invalidates every asynchronous owner of the previous file and retires its UI.
 * Called as soon as Android says a new copy has begun, not minutes later when
 * the copy completes, so stale tuning advice cannot sit under the new filename.
 */
function retireCurrentFile(name) {
  // An import replaces the context the consent question referred to. Dismiss it
  // without recording an answer; otherwise a singleTask ACTION_VIEW can leave
  // the old flight's modal inerting the new import (or its error screen).
  const dismissedConsent = dismissConsent({restoreFocus: false});
  openReadController?.abort();
  openReadController = null;
  const token = state.fileOpenRun += 1;
  state.fileName = name;
  state.recommendationRun += 1;
  state.recommendations = null;
  state.recommendationCoverage = null;
  state.learning = null;
  $('recommend').innerHTML = '';
  $('recommend-status').textContent = '';
  $('recommend-answer').innerHTML = '';
  state.answerScrolled = false;
  forgetCandidateFlight();
  closeCurrentLog();
  if (dismissedConsent) {
    $('drop').focus({preventScroll: true});
  }
  return token;
}

/**
 * Opens a log from any host: a browser file input, a drop, an Android share
 * intent, or the system picker. `source` is `{name, bytes()}` — see host.mjs.
 */
async function openFile(source) {
  // This call's claim on the screen — see `state.fileOpenRun`. It also aborts a
  // superseded FileReader/fetch before another full ArrayBuffer can materialize.
  const token = retireCurrentFile(source.name);
  const readController = new AbortController();
  openReadController = readController;
  const file = {name: source.name};
  // The copy, if there was one, is over: the bytes are on this device now.
  hideImportProgress();
  $('status').innerHTML = `<span class="muted">Reading ${esc(file.name)}…</span>`;
  show('status-panel');

  let bytes;
  try {
    bytes = await source.bytes(readController.signal);
  } catch (error) {
    if (token !== state.fileOpenRun) {
      return;
    }
    if (openReadController === readController) {
      openReadController = null;
    }
    $('status').innerHTML =
      `<span class="error">Could not read the file: ${esc(error.message)}</span>` +
      `<p class="muted" style="font-size:13px">Nothing is open. Pick a log to try again.</p>`;
    return;
  }

  // Overtaken while those bytes were being read. The pilot has picked another
  // file and that call owns the screen; this one must not decode, paint, or
  // clear anything it has already put up.
  if (token !== state.fileOpenRun) {
    return;
  }
  if (openReadController === readController) {
    openReadController = null;
  }

  // `decodeLog` is synchronous and holds this thread for 8.1 s on a 128 MB log,
  // so no event can be dispatched from inside it and no message written during
  // it will ever be seen. The only place a name can be painted is here, before
  // the call — and painting it needs more than an assignment: an `await`
  // resumes in a microtask, which runs BEFORE the frame is drawn. `yieldToRender`
  // is what makes this line appear rather than merely exist.
  $('status').innerHTML = `<span class="muted">Decoding ${esc(file.name)}…</span>`;
  await yieldToRender();

  // Overtaken while that paint was waiting on a frame.
  if (token !== state.fileOpenRun) {
    return;
  }

  state.byteLength = bytes.length;
  state.sessionIndex = 0;
  state.sessionDecodeMs = null;
  state.records = null;
  state.marks = [];
  state.decodedSessions = [];

  // Every blocking step from here to a session on screen is announced BEFORE it
  // runs, so a log big enough to take a noticeable time says how far it has got
  // instead of freezing. See `beginDecodeProgress`.
  beginDecodeProgress(file.name, bytes.length, DECODE_STEPS_TO_FIRST_SESSION);

  let result;
  try {
    // `{lazy: true}` reads every session's HEADER BLOCK and not one frame.
    // Measured on the owner's own 125 MiB, 73-session dataflash dump: 40 ms and
    // 2.3 MiB held, against 6.2 s and 73 flights' worth of samples eagerly.
    decodeStep(`Finding the sessions in ${file.name}`);
    await yieldToRender();
    if (token !== state.fileOpenRun) {
      return;
    }
    result = decodeLog(bytes, {lazy: true});
    decodeStepDone();

    // The SECOND full pass over the file, and it is not free: 50 ms of the
    // 124 ms open on the owner's 73-session dump, against the 74 ms lazy decode
    // above. It walks the whole file again to find the session starts and parses
    // every header block a second time, because the PID lines and the rate curve
    // that a before/after comparison needs never reach `decodeLog`. It is
    // announced like any other blocking step rather than hidden inside the one
    // before it — see `DECODE_STEPS_TO_FIRST_SESSION`.
    decodeStep(`Reading the settings in ${file.name}`);
    await yieldToRender();
    if (token !== state.fileOpenRun) {
      return;
    }
    state.sessionHeaders = readSessionHeaders(bytes);
    decodeStepDone();
  } catch (error) {
    // decodeLog reports bad logs as data; reaching here means a genuine defect.
    endDecodeProgress();
    $('status').innerHTML = `<span class="error">Decoder fault: ${esc(error.message)}</span>`;
    return;
  }

  state.result = result;

  if (result.sessions.length === 0) {
    endDecodeProgress();
    // The bytes are no use to anyone: drop them rather than hold a whole
    // dataflash dump alive behind an error message.
    closeCurrentLog();
    $('status').innerHTML =
      `<span class="error">No Blackbox session found in ${esc(file.name)}.</span>` +
      `<p class="muted" style="font-size:13px">This does not look like a flight log. ` +
      `Blackbox logs usually end in .bbl or .bfl.</p>`;
    return;
  }

  renderSessionPicker();
  renderLogStatus();

  // ONE session — the one about to be shown. The other 72 in a dataflash dump
  // are listed, described from their headers, and left alone.
  await openSession(0);

  // Overtaken during that read. The newer open owns the screen from here.
  if (token !== state.fileOpenRun) {
    return;
  }
  endDecodeProgress();
  renderLogStatus();
}

/**
 * Closes whatever log is open: the decoded state AND the screen showing it.
 *
 * These two must move together. Clearing the log while leaving the panels up is
 * what made a failed open worse than useless — the previous flight's stats,
 * picker, plot and field table stayed on screen looking live, `state.result`
 * was null underneath them, and the two controls a pilot reaches for next threw
 * where nothing could report it. From the seat, Analyse and the field picker
 * simply stopped working with no message at all.
 *
 * NOTE this is a behaviour change from before lazy decoding: a failed open used
 * to leave the previous log intact. It cannot any more, because the previous
 * log has to be released BEFORE the next one's bytes are read — the decoder now
 * reads its input on demand, so an open log holds the whole file, and keeping
 * one while reading another means two dataflash dumps resident at the peak. On
 * a phone that is the crash this whole change exists to avoid. Losing the log
 * and being told so is worse than keeping it and better than being killed.
 */
function closeCurrentLog() {
  state.result = null;
  state.decodedSessions = [];
  state.sessionHeaders = [];
  state.byteLength = null;
  windowedSessionCache = null;
  state.records = null;
  state.recordsAxis = null;
  state.axisSignals = null;
  state.marks = [];
  state.marksAxis = null;
  PANELS.forEach(id => show(id, false));

  // Empty them as well as hide them. A hidden panel still holding the previous
  // flight's markup is the same stale data one CSS change away from being back
  // on screen, and it also makes "is a flight rendered?" unanswerable from the
  // DOM — `#session-stats` having children meant a flight was up, and with the
  // markup left behind it meant only that a flight had once been up.
  $('session-stats').innerHTML = '';
  $('session-issues').innerHTML = '';
  $('fields').innerHTML = '';
  $('field').innerHTML = '';
  $('session').innerHTML = '';
  $('tune').innerHTML = '';
}

/**
 * The line above the session picker: what was opened, how big it is, how many
 * flights are in it, and how long the session on screen took to read.
 *
 * Re-rendered after every session change, because "read in N ms" is now a fact
 * about ONE session rather than about the whole file.
 */
function renderLogStatus() {
  const sessions = state.result?.sessions ?? [];
  const kib = Math.round((state.byteLength ?? 0) / 1024);
  const timing = state.sessionDecodeMs === null || state.sessionDecodeMs === undefined
    ? ''
    : `, session ${state.sessionIndex + 1} read in ${state.sessionDecodeMs} ms`;

  $('status').innerHTML =
    `<strong>${esc(state.fileName ?? '')}</strong> <span class="muted">— ${kib} KiB, ` +
    `${sessions.length} session${sessions.length === 1 ? '' : 's'}${timing}</span>` +
    (sessions.length > 1
      ? `<p class="muted" style="font-size:12.5px;margin:6px 0 0">Only the session you pick is ` +
        `read. The rest are listed from their headers and cost nothing until you open them.</p>`
      : '');
}

/**
 * How big a session is on the card, from its header alone.
 *
 * The next session's header block starts exactly where this one's frame stream
 * ends, so the span is known without decoding anything. It is the only size the
 * picker can honestly quote before a session is opened — a sample count needs
 * the frames.
 */
function sessionSpanBytes(index) {
  const sessions = state.result?.sessions ?? [];
  const start = sessions[index]?.byteOffset ?? 0;
  const end = sessions[index + 1]?.byteOffset ?? state.byteLength ?? start;
  return Math.max(0, end - start);
}

/**
 * One option in the session picker, from whatever is actually known.
 *
 * A session that has not been opened has NO sample count, and this says so
 * rather than printing `0 samples` — which is what a session whose frames are
 * unreadable looks like, and a pilot must be able to tell those two apart. The
 * craft name, the firmware and the byte span all come from the header block, so
 * every flight in a 73-session dump is described without reading one frame.
 */
function sessionOptionLabel(session, index) {
  const name = session.craftName || session.firmware?.type || 'session';
  const size = formatBytes(sessionSpanBytes(index));

  // Three states, not two, and the third is the one that bit. A session whose
  // HEADER BLOCK is corrupt can never be decoded — the decoder hands it back
  // with its errors already attached and nothing to read — so offering it as
  // "not opened yet" invites a tap that can only fail. It says so up front.
  //
  // `samples` is null until the frames are read and an array afterwards; the
  // decoder is deliberate about that distinction, and this is the one place in
  // the app that depends on it.
  const measured = sessionIsUnreadable(session)
    ? 'cannot be read'
    : session.samples
      ? `${session.samples.length.toLocaleString()} samples`
      : 'not opened yet';

  return `${index + 1}. ${name} — ${size}, ${measured}`;
}

/**
 * A session the decoder could not parse the header of.
 *
 * NO FIELDS plus AN ERROR. Both halves are needed and neither alone will do: a
 * flight whose frames decoded badly also carries errors but has its full field
 * table, and a flight that logged nothing has fields but no error. Only a
 * header the parser rejected produces both — the field table is built from the
 * header block, so failing to read that block leaves nothing to build it from.
 *
 * Deliberately independent of `framesDecoded` and of `samples`. `decodeFrames()`
 * on such a session is a no-op that still marks it decoded, and its `samples`
 * is `[]` rather than `null` — which is truthy, and was exactly the trap: a
 * check for falsy samples reads an unreadable session as a healthy one.
 */
function sessionIsUnreadable(session) {
  return Boolean(session) && Array.isArray(session.errors) && session.errors.length > 0 &&
    (session.fields?.length ?? 0) === 0;
}

/**
 * Rebuilds the picker, keeping the selection.
 *
 * Called again after every decode, so the session just opened stops saying "not
 * opened yet" and starts quoting the count it now knows.
 */
function renderSessionPicker() {
  const picker = $('session');
  const sessions = state.result?.sessions ?? [];

  picker.innerHTML = sessions
    .map((session, index) =>
      `<option value="${index}">${esc(sessionOptionLabel(session, index))}</option>`)
    .join('');
  picker.value = String(state.sessionIndex);
}

// ---------------------------------------------------------------------------
// One session at a time
//
// A dataflash dump is a concatenation of independent flights — 73 of them in the
// owner's own 125 MiB chip image — and he looks at ONE. Decoding all of them
// cost 8.1 s of frozen UI and 241 MB of RSS on his handset, against an Android
// per-process cap commonly 192-256 MB, and the other 72 were decoded for nothing.
//
// So: read every header, and read a session's frames only when something asks
// for them.
//
// MEASURED on that dump, Node 24 with --expose-gc:
//   lazy open, all 73 headers ......... 40 ms, 2.3 MiB held
//   largest session's frames (#26) ... 424 ms, 115.3 MiB held, 190,130 samples
//   releaseFrames() on it ............ back to 2.4 MiB
//   one decoded sample cell .......... 8.83 B and 8.90 B on two sessions of very
//     different size, which is where BYTES_PER_SAMPLE_CELL comes from.
//
// The file's own bytes now stay resident for as long as the log is open, because
// the decoder reads them on demand. That is a real and NEW cost — 125 MiB for
// that dump — and it is still far below what the samples cost. Peak is now
// (file + one session) where it was (file + every session).
// ---------------------------------------------------------------------------

/**
 * What one decoded sample costs, per field.
 *
 * Measured rather than reasoned about: session #26 of the 125 MiB dump holds
 * 190,130 samples of 72 fields in 115.3 MiB (8.83 B/cell) and session #5 holds
 * 18,802 of the same width in 11.4 MiB (8.90 B/cell). Rounded UP, because this
 * number decides what to throw away and an underestimate keeps too much.
 */
const BYTES_PER_SAMPLE_CELL = 9;

/**
 * How much decoded flight may be kept for sessions the pilot is NOT looking at.
 *
 * Switching back to a session should not decode it again, so an opened session
 * is kept. But two of the big ones from that dump are 220 MiB together — over
 * the cap this whole change exists to stay under — so "kept" has to be bounded.
 * Anything above this is released the moment another session is opened, and
 * re-read if the pilot returns to it. Slow beats killed.
 *
 * 32 MiB is about 50,000 samples of a 72-field log. The median session in that
 * dump is 38,000 samples, so the ordinary case is covered and exactly the
 * handful that would sink it is not.
 */
const DECODED_SESSION_CACHE_BYTES = 32 * 1024 * 1024;

/** What a decoded session is holding, or 0 if its frames have not been read. */
function decodedSessionBytes(session) {
  if (!session?.samples) {
    return 0;
  }
  return session.samples.length * (session.fields?.length ?? 0) * BYTES_PER_SAMPLE_CELL;
}

/**
 * Releases decoded sessions until the ones being kept fit in the budget.
 *
 * `keepIndex` is never released: it is the session on screen, or the one about
 * to be. Everything else goes oldest-first — `state.decodedSessions` is held
 * most-recently-opened first, so walking it forwards keeps the recent ones.
 */
function evictDecodedSessions(keepIndex) {
  const sessions = state.result?.sessions ?? [];
  const kept = [];
  let held = 0;

  for (const index of state.decodedSessions) {
    const session = sessions[index];
    // The session on screen, and any session an analysis is still reading. The
    // second is not a nicety — see `analysesInFlight`.
    if (index === keepIndex || analysesInFlight.has(index)) {
      kept.push(index);
      continue;
    }

    const cost = decodedSessionBytes(session);
    if (held + cost <= DECODED_SESSION_CACHE_BYTES) {
      held += cost;
      kept.push(index);
      continue;
    }

    // `releaseFrames` puts the session back to exactly what a lazy open
    // produced — `samples` null, not empty — so the picker can tell "not opened
    // yet" from "opened, and there was nothing in it" again.
    session?.releaseFrames?.();
  }

  state.decodedSessions = kept;
}

/**
 * Shows a session, reading its frames first if they have not been read.
 *
 * The decode is one synchronous call that cannot be interrupted, so the step is
 * announced and PAINTED before it starts — the same reason `openFile` paints
 * "Decoding NAME…" before touching the decoder at all.
 */
async function openSession(index) {
  const session = state.result?.sessions?.[index];
  if (!session) {
    return;
  }

  // The LOG this call belongs to, kept by identity rather than by name. A run
  // token counts session changes; it cannot see a whole new file arriving,
  // which clears `state.result` and would leave this call painting session 3 of
  // a log that is no longer open over the first session of one that is.
  const log = state.result;

  // This call's claim on the screen. Reading a session yields before it decodes,
  // so a pilot who taps the picker again during a two-second decode has two of
  // these running at once — and the older one would go on to paint its flight
  // over the newer one's, having already been evicted out from under itself.
  // Same shape as `recommendationRun` below, for the same reason.
  const token = state.sessionOpenRun += 1;

  // Retire any analysis still running BEFORE anything else moves. It belongs to
  // the flight leaving the screen, its answer would land under a different
  // helicopter's name, and — since `state.sessionIndex` is about to change — it
  // would otherwise resume and measure whichever session this one turns out to
  // be, which for the moment between here and `decodeFrames()` has no samples at
  // all. That was a real blank screen, not a hypothetical one.
  state.recommendationRun += 1;

  state.sessionIndex = index;
  windowedSessionCache = null;
  state.records = null;
  state.recordsAxis = null;
  state.marks = [];
  state.marksAxis = null;

  // `framesDecoded` is the DECODER's own answer, not a flag this file keeps in
  // parallel. A second source of truth about whether a session is decoded is
  // exactly how "switching back decodes it again" would come back unnoticed.
  if (session.framesDecoded) {
    // Nothing was read, so there is no read time. Leaving the previous session's
    // figure standing would put a number on screen and attach it to the wrong
    // flight, which is worse than the line not being there.
    state.sessionDecodeMs = null;
    state.decodedSessions = [index, ...state.decodedSessions.filter(item => item !== index)];
    evictDecodedSessions(index);
    renderSession();
    return;
  }

  // Free what can be freed BEFORE allocating the new session, never after:
  // holding the old one and the new one at once is the peak this change exists
  // to avoid. Same reason as the axis picker's `state.records = null`.
  evictDecodedSessions(index);

  const count = state.result.sessions.length;
  const name = session.craftName || session.firmware?.type || 'session';
  const span = formatBytes(sessionSpanBytes(index));
  decodeStep(count === 1
    ? `Reading the flight — ${name}, ${span}`
    : `Reading session ${index + 1} of ${count} — ${name}, ${span}`);
  await yieldToRender();

  // Overtaken while waiting for that paint. Do not read this flight at all: the
  // pilot has asked for another one, and the call that owns the screen is about
  // to read it. `state.result !== log` is the same thing one level up — a whole
  // new FILE arrived, and this flight belongs to a log nobody is looking at.
  if (token !== state.sessionOpenRun || state.result !== log) {
    return;
  }

  const started = performance.now();
  try {
    session.decodeFrames();
  } catch (error) {
    endDecodeProgress();
    $('status').innerHTML = `<span class="error">Decoder fault: ${esc(error.message)}</span>`;
    return;
  }
  state.sessionDecodeMs = Math.round(performance.now() - started);
  state.frameDecodeCount += 1;
  decodeStepDone();

  // Registered whatever happens next: the frames ARE read, and a session missing
  // from this list can never be released, which is a leak rather than a
  // cosmetic slip.
  state.decodedSessions = [index, ...state.decodedSessions.filter(item => item !== index)];

  // Overtaken during the decode. The flight is read and kept; painting it would
  // put it over the one the pilot has since asked for.
  //
  // UNREACHABLE TODAY, and deliberately kept. `decodeFrames()` above is ONE
  // SYNCHRONOUS CALL, so no tap can be dispatched while it runs and nothing can
  // move `sessionOpenRun` between the guard before it and this one. Mutating
  // this line away leaves every test green and the browser test says so rather
  // than pretending otherwise. It stops being unreachable the moment a session
  // can be read in chunks — the obvious next step — and at that point this is
  // the only thing between an obsolete read and the screen.
  if (token !== state.sessionOpenRun || state.result !== log) {
    return;
  }

  // This session's label changes from "not opened yet" to its real sample count,
  // and only now can it.
  renderSessionPicker();
  renderSession();
}

/**
 * The raw header block of every session, index-aligned with `result.sessions`.
 *
 * `decodeLog` deliberately reports a session rather than its headers, so the
 * PID lines, the rate curve and the board string never reach it. Those three
 * are precisely what a before/after comparison is about — without them
 * `readPilotGains` sees nothing and every comparison refuses as
 * GAINS_NOT_COMPARABLE — so the header blocks are parsed a second time here.
 *
 * Cheap: `parseSession` reads the header block and stops. It does not decode a
 * single frame, and what it returns is a few hundred short strings per session.
 *
 * Per session rather than via `parseSessions`, because one malformed header
 * block throws and `parseSessions` maps over all of them — losing the history
 * for every other flight in the same dump.
 */
function readSessionHeaders(bytes) {
  let starts;
  try {
    starts = findSessionStarts(bytes);
  } catch {
    return [];
  }

  return starts.map((start, index) => {
    try {
      const parsed = parseSession(bytes, start, index);
      return {headers: parsed.headers, board: parsed.board, craftName: parsed.craftName};
    } catch {
      return null;
    }
  });
}

// ---------------------------------------------------------------------------
// Import progress
//
// The native shell copies the picked file into its own storage before the page
// ever sees it, and over USB mass storage that runs at about 850 KiB/s — over
// two minutes for a full dataflash dump. The app used to show nothing at all for
// the whole of it; the person who knows this app best read that blank screen as
// "it's broken", twice.
// ---------------------------------------------------------------------------

/**
 * How long a copy must run before anything is drawn.
 *
 * A log already on local storage lands in well under this, and a bar that
 * appears and vanishes inside one blink reads as a rendering glitch rather than
 * as progress. Long enough to skip the fast case, short enough that the slow
 * case is never left blank.
 */
const IMPORT_PROGRESS_DELAY_MS = 300;

const importProgress = {
  name: null, total: -1, copied: 0, generation: null, timer: null, showing: false
};

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) {
    return '—';
  }
  if (value < 1024) {
    return `${Math.round(value)} B`;
  }
  const kib = value / 1024;
  return kib < 1024 ? `${Math.round(kib)} KiB` : `${(kib / 1024).toFixed(1)} MiB`;
}

function drawImportProgress() {
  if (!importProgress.showing) {
    return;
  }

  const {copied, total, name} = importProgress;
  const bar = $('import-bar');
  const known = total > 0;

  // NEVER a fabricated percentage. `total` is -1 whenever the provider would not
  // say how big the file is, which is a documented, ordinary outcome — see
  // `sizeOf` in MainActivity — and inventing a denominator there would draw a
  // bar that reaches the end while the copy carries on.
  if (known) {
    const fraction = Math.max(0, Math.min(1, copied / total));
    bar.classList.remove('sweeping');
    bar.style.width = `${(fraction * 100).toFixed(1)}%`;
    $('import-progress-label').textContent =
      `Copying ${name} — ${Math.round(fraction * 100)}% of ${formatBytes(total)}`;
  } else {
    bar.classList.add('sweeping');
    bar.style.width = '';
    $('import-progress-label').textContent = `Copying ${name} — ${formatBytes(copied)} so far`;
  }
}

function hideImportProgress() {
  clearTimeout(importProgress.timer);
  importProgress.timer = null;
  importProgress.showing = false;
  show('import-progress', false);
}

function importStarted({name, total, generation}) {
  const newSelection = generation < 0 || generation !== importProgress.generation;
  if (newSelection) {
    importProgress.generation = generation;
    retireCurrentFile(name);
    show('status-panel');
    $('status').innerHTML = `<span class="muted">Preparing ${esc(name)}…</span>`;
  }
  clearTimeout(importProgress.timer);
  importProgress.name = name;
  importProgress.total = total;
  importProgress.copied = 0;
  importProgress.showing = false;
  show('import-progress', false);

  importProgress.timer = setTimeout(() => {
    importProgress.showing = true;
    show('import-progress');
    drawImportProgress();
  }, IMPORT_PROGRESS_DELAY_MS);
}

function importAdvanced({copied, total, generation}) {
  if (generation >= 0 && importProgress.generation >= 0
      && generation !== importProgress.generation) {
    return;
  }
  importProgress.copied = copied;
  // The started event carries the size, but a shell that only ever sent progress
  // would otherwise be stuck at "unknown" forever.
  if (total > 0) {
    importProgress.total = total;
  }
  drawImportProgress();
}

// ---------------------------------------------------------------------------
// Decode progress
//
// The copy above finishes and the decode begins, and until now THAT was the
// silent part: `decodeLog` held the thread for 8.1 s on the owner's 128 MB dump
// with "Decoding NAME…" frozen on screen. Reading one session at a time breaks
// it into steps, and a step can be announced.
//
// This deliberately follows the import bar's shape rather than inventing a
// second one — same element structure, same "nothing for the first 300 ms", same
// refusal to draw a percentage of a denominator it does not have — with ONE
// difference, forced by the thing being reported:
//
//   THE IMPORT BAR IS DRIVEN BY A TIMER. THIS ONE CANNOT BE.
//
// A copy runs in the native shell and the page is idle between its events, so
// `setTimeout` fires and a delayed bar appears. A decode runs ON THIS THREAD.
// While `decodeFrames()` is executing, no timer fires, no frame is serviced and
// no pixel changes — so a bar scheduled for 300 ms into a 2-second decode would
// appear only after the decode it was announcing had finished. Every paint here
// therefore happens BEFORE the blocking call, and whether to show anything at
// all is decided from the log's own size, which is known in advance, rather than
// from a clock that will not tick.
// ---------------------------------------------------------------------------

/**
 * Steps between picking a file and the first session on screen.
 *
 * Three, and each one is a real blocking pass over the file: find the sessions
 * (`decodeLog` with `{lazy: true}`), read the settings (`readSessionHeaders`,
 * which walks the whole file AGAIN), then read the chosen session's frames. The
 * middle one was there before this bar was and cost 50 ms of a 124 ms open on
 * the owner's 73-session dump — a co-equal share of it — while being the only
 * blocking step in the open path that said nothing.
 */
const DECODE_STEPS_TO_FIRST_SESSION = 3;

/**
 * Below this, a log is opened without a word about it.
 *
 * The size is a PREDICTION — the only thing available, since the cost of a
 * decode is not known until it has run and the thread cannot report on itself
 * while it is blocked. It is calibrated from measurement: 8.8 MiB of session
 * decoded in 424 ms in Node on a desktop, so roughly 48 ms per MiB there, and a
 * handset is several times slower. At 2 MiB that is a fifth of a second on a
 * desktop and something a pilot can see on a phone.
 *
 * Below it every committed fixture, and any single ordinary flight, opens with
 * no bar at all — which is the point. A bar that appears and vanishes inside one
 * blink reads as a rendering glitch, exactly as it does for the copy above.
 */
const DECODE_PROGRESS_MIN_BYTES = 2 * 1024 * 1024;

/**
 * The same 300 ms the copy uses, applied to elapsed time rather than to a timer.
 *
 * A log under `DECODE_PROGRESS_MIN_BYTES` still gets a bar once the work has
 * visibly overrun — a slow handset, a pathological field set — because by then
 * the reader is already waiting and nothing is being flashed at him.
 */
const DECODE_PROGRESS_DELAY_MS = 300;

/**
 * The floor between repeat draws, from `PROGRESS_INTERVAL_MS` in MainActivity.
 *
 * A CHANGE OF STEP ALWAYS PAINTS. The floor only suppresses redrawing the same
 * label, which is what keeps a future finer-grained version from putting
 * thousands of writes in front of the renderer — and which must never suppress
 * the one line that says what is about to block.
 */
const DECODE_PROGRESS_INTERVAL_MS = 200;

const decodeProgress = {
  label: '', done: 0, total: 0, showing: false, worthShowing: false,
  startedAt: 0, drawnAt: 0, drawnLabel: null
};

/**
 * Starts a run of announced steps.
 *
 * @param {string} name the file, for the label
 * @param {number} byteLength how big it is, which decides whether to show anything
 * @param {number} total how many steps this run has
 */
function beginDecodeProgress(name, byteLength, total) {
  decodeProgress.label = '';
  decodeProgress.done = 0;
  decodeProgress.total = total;
  decodeProgress.startedAt = performance.now();
  decodeProgress.drawnAt = 0;
  decodeProgress.drawnLabel = null;
  // Decided here, from a number that is already known, because the thread will
  // not be free to decide it later.
  decodeProgress.worthShowing = Number.isFinite(byteLength)
    && byteLength >= DECODE_PROGRESS_MIN_BYTES;
  // NOTHING IS SHOWN UNTIL A STEP IS NAMED. A run can finish without naming one
  // — going back to a flight still held reads nothing — and an empty bar
  // appearing and vanishing for that is the flash this exists to avoid, not an
  // instance of reporting progress.
  decodeProgress.showing = false;
  show('decode-progress', false);
}

/**
 * Names the step ABOUT to run.
 *
 * `done` is not advanced here: it counts steps FINISHED. A bar that reaches the
 * end while the work carries on is the one thing the import bar refuses to do,
 * and this refuses it for the same reason.
 */
function decodeStep(label) {
  decodeProgress.label = label;

  if (!decodeProgress.showing
      && (decodeProgress.worthShowing
        || performance.now() - decodeProgress.startedAt >= DECODE_PROGRESS_DELAY_MS)) {
    decodeProgress.showing = true;
    show('decode-progress');
  }
  drawDecodeProgress();
}

/** One step finished. */
function decodeStepDone() {
  decodeProgress.done = Math.min(decodeProgress.total, decodeProgress.done + 1);
  drawDecodeProgress();
}

function drawDecodeProgress() {
  if (!decodeProgress.showing) {
    return;
  }

  const {label, done, total, drawnLabel, drawnAt} = decodeProgress;
  const now = performance.now();
  if (label === drawnLabel && now - drawnAt < DECODE_PROGRESS_INTERVAL_MS) {
    return;
  }
  decodeProgress.drawnLabel = label;
  decodeProgress.drawnAt = now;

  // `total` is this run's own step count, so the denominator is exact and the
  // fraction is a real one. It is steps COMPLETED, so it is behind the label
  // rather than ahead of it.
  const fraction = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  const bar = $('decode-bar');
  bar.classList.remove('sweeping');
  bar.style.width = `${(fraction * 100).toFixed(1)}%`;
  $('decode-progress-label').textContent =
    `${label} — step ${Math.min(total, done + 1)} of ${total}`;
}

function endDecodeProgress() {
  decodeProgress.showing = false;
  decodeProgress.drawnLabel = null;
  show('decode-progress', false);
}

// ---------------------------------------------------------------------------
// Session summary
// ---------------------------------------------------------------------------

/**
 * The session on screen, or `null` when no log is open.
 *
 * `null` rather than a throw, deliberately. `state.result` is cleared the
 * moment a new file is picked and stays cleared if reading it fails, and this
 * used to dereference it unconditionally — so anything that reached it in that
 * window died with `Cannot read properties of null (reading 'sessions')`,
 * inside an event handler, where nothing catches it and the pilot sees a
 * control that quietly does nothing.
 *
 * `closeCurrentLog` takes the panels down so those controls should be
 * unreachable; this is the floor under that, not a substitute for it. Callers
 * that can run without a log check for null and stop.
 */
function currentSession() {
  return state.result?.sessions?.[state.sessionIndex] ?? null;
}

function timeIndexOf(session) {
  return session.fields.findIndex(field => field.name === 'time');
}

function sessionTiming(session) {
  const timeIndex = timeIndexOf(session);
  if (timeIndex === -1 || session.samples.length < 2) {
    return {durationSeconds: null, rateHz: null};
  }

  const first = session.samples[0][timeIndex];
  const last = session.samples[session.samples.length - 1][timeIndex];
  const durationSeconds = (last - first) / 1_000_000;

  return {
    durationSeconds,
    rateHz: durationSeconds > 0 ? session.samples.length / durationSeconds : null
  };
}

function renderSession() {
  const session = currentSession();
  // Nothing to render. This ran unconditionally and died on `samples.length`
  // for a session whose header block could not be parsed — leaving the PREVIOUS
  // flight's firmware, craft, duration and sample count on screen underneath a
  // picker that named the broken one. Wrong numbers under the right heading is
  // the worst thing this panel can do.
  if (!session?.samples || sessionIsUnreadable(session)) {
    renderUnreadableSession(session);
    return;
  }

  const {durationSeconds, rateHz} = sessionTiming(session);
  const counts = session.frameCounts ?? {};

  $('session-stats').innerHTML = [
    ['Firmware', session.firmware.revision ?? session.firmware.type ?? '—'],
    ['Craft', session.craftName ?? '—'],
    ['Duration', durationSeconds === null ? '—' : `${durationSeconds.toFixed(1)} s`],
    ['Sample rate', rateHz === null ? '—' : `${Math.round(rateHz)} Hz`],
    ['Samples', session.samples.length.toLocaleString()],
    ['Keyframes', text(counts.I)],
    ['Board', session.firmware.board ?? '—'],
    ['Events', (session.events ?? []).length]
  ].map(([key, value]) => `<div class="stat"><div class="k">${key}</div><div class="v">${esc(value)}</div></div>`)
    .join('');

  // A capture that stops mid-frame is not a damaged log. Most real logs end that
  // way — power-off, a full card, a pulled battery — and warning about every one
  // of them teaches the owner to ignore the warning that means something.
  const integrity = sessionIntegrity(
    session,
    sessionEndOffset(state.result, state.sessionIndex, state.byteLength ?? Infinity)
  );

  const issues = [];
  if (integrity.state === 'damaged') {
    const count = integrity.bodyErrors.length;
    issues.push(
      `${pill('bad', `${count} decode issue${count === 1 ? '' : 's'}`)}` +
      `<ul class="codes">${integrity.bodyErrors.slice(0, 5).map(
        error => `<li><code>${esc(error.code)}</code> at byte ${error.offset}</li>`
      ).join('')}</ul>` +
      `<p class="muted" style="font-size:12.5px">Damaged spans are skipped; the rest of the ` +
      `log still decoded. Treat measurements from this session with care.</p>`
    );
  } else {
    issues.push(pill('good', 'decoded cleanly'));
  }

  if (integrity.endedMidFrame) {
    issues.push(
      ` ${pill('warn', 'ends mid-frame')}` +
      `<p class="muted" style="font-size:12.5px">The capture stops part-way through a ` +
      `frame, which is what a log cut by power-off or a full card looks like. Everything ` +
      `before it decoded normally.</p>`
    );
  }
  if (session.locationFieldsDeclared) {
    issues.push(` ${pill('warn', 'contains GPS fields')}`);
  }

  $('session-issues').innerHTML = `<h3>Integrity</h3>${issues.join('')}`;

  const fieldPicker = $('field');
  fieldPicker.innerHTML = session.fields
    .map(field => `<option value="${field.index}">${esc(field.name)}</option>`)
    .join('');
  const preferred = session.fields.find(field => field.name === 'gyroADC[0]');
  fieldPicker.value = String(preferred ? preferred.index : 0);

  $('fields').innerHTML =
    '<tr><th>#</th><th>Field</th><th class="num">Samples</th></tr>' +
    session.fields.map(field =>
      `<tr><td class="muted">${field.index}</td><td>${esc(field.name)}</td>` +
      `<td class="num">${field.sampleCount.toLocaleString()}</td></tr>`
    ).join('');

  PANELS.forEach(id => show(id));
  state.marks = [];
  state.marksAxis = null;
  $('tune').innerHTML = '<p class="muted">Pick a term and analyse. The Axis panel above ' +
    'already measures this axis on whatever you flew.</p>';

  // The window has to be settled before anything measures anything, because
  // everything below measures over it.
  applyFlightWindow({detect: true});
}

/**
 * What the session panel shows for a flight that cannot be read.
 *
 * The header block is corrupt, so there are no frames, no fields and no
 * measurements — and everything below the session panel measures something.
 * Those panels come DOWN rather than being left up with the previous flight's
 * numbers in them, which is what happened before: the picker named session 3
 * while the stats, the plot and the field table still described session 1, and
 * nothing on screen said so.
 *
 * The rest of the dump is unaffected. Sessions are independent, so one broken
 * header costs exactly one flight and the picker still lists the others.
 */
function renderUnreadableSession(session) {
  const codes = (session?.errors ?? []).slice(0, 5);

  $('session-stats').innerHTML = [
    ['Firmware', session?.firmware?.revision ?? session?.firmware?.type ?? '—'],
    ['Craft', session?.craftName ?? '—'],
    ['Samples', '—']
  ].map(([key, value]) => `<div class="stat"><div class="k">${key}</div><div class="v">${esc(value)}</div></div>`)
    .join('');

  $('session-issues').innerHTML =
    `<h3>Integrity</h3>${pill('bad', 'cannot be read')}` +
    (codes.length > 0
      ? `<ul class="codes">${codes.map(
        error => `<li><code>${esc(error.code)}</code>${
          Number.isFinite(error.offset) ? ` at byte ${error.offset}` : ''}</li>`
      ).join('')}</ul>`
      : '') +
    `<p class="muted" style="font-size:12.5px">This flight's header block is damaged, so ` +
    `nothing in it can be decoded. The other flights in this file are unaffected — pick ` +
    `another from the list above.</p>`;

  // Everything below the session panel measures samples there are none of.
  ['recommend-panel', 'window-panel', 'axis-panel', 'tune-panel', 'plot-panel', 'fields-panel']
    .forEach(id => show(id, false));
  show('session-panel');
}

// ---------------------------------------------------------------------------
// The flight window
//
// The owner: "i dont see where they can set the I/O on their .bbl because you
// only need the log to show from the time it takes off to the time it lands".
//
// So: detect it, draw it on the trace, let either end be dragged, and make every
// number on the page come from inside it. The detection is
// `src/analysis/flight-window.mjs` and nothing here re-implements any part of
// it — `resolveFlightWindow` is the single entry point, so the "an override
// wins, detection is the fallback" precedence exists in exactly one place.
// ---------------------------------------------------------------------------

/** Column index of a field by name, or -1. */
function fieldIndexByName(session, name) {
  const field = session.fields.find(entry => entry.name === name);
  return field ? field.index : -1;
}

/**
 * A session object carrying only the samples inside the flight window.
 *
 * Cached, because `summarizeAxis`, `buildAnalysisRecords` and
 * `buildMechanicalSeries` all want one and slicing 130k pointers three times per
 * redraw is not free. The slice shares the sample rows themselves — it is an
 * array of the same references, so the cost is one pointer per sample and not a
 * second copy of the log.
 */
let windowedSessionCache = null;

function windowedSession() {
  const session = currentSession();
  // No log open, or a session whose frames could not be read. Everything below
  // slices `session.samples`, and every caller of this — the analyser, the
  // vibration sweep, the record builder — is reached from a control the pilot
  // can press. `null` travels; a throw in a handler does not.
  if (!session?.samples) {
    return null;
  }

  const window_ = state.window;
  if (!window_ || !Number.isFinite(window_.startUs) || !Number.isFinite(window_.endUs)) {
    return session;
  }

  const key = `${state.sessionIndex}:${window_.startUs}:${window_.endUs}`;
  if (windowedSessionCache?.key === key) {
    return windowedSessionCache.session;
  }

  const timeIndex = timeIndexOf(session);
  if (timeIndex === -1) {
    return session;
  }

  const from = indexAtOrAfter(session.samples, timeIndex, window_.startUs);
  // `indexAtOrAfter` returns the first sample at or after the time, so the
  // sample AT endUs is included by searching one microsecond past it.
  const to = indexAtOrAfter(session.samples, timeIndex, window_.endUs + 1);
  const sliced = from === 0 && to >= session.samples.length
    ? session
    : {...session, samples: session.samples.slice(from, to)};

  windowedSessionCache = {key, session: sliced};
  return sliced;
}

/**
 * Re-resolves the window and re-runs everything that depends on it.
 *
 * @param {object} options
 * @param {boolean} [options.detect] drop the pilot's override and detect again
 */
function applyFlightWindow(options = {}) {
  const session = currentSession();
  if (options.detect) {
    state.windowOverride = null;
  }

  state.window = resolveFlightWindow(
    session,
    state.windowOverride ? {override: state.windowOverride} : {}
  );
  windowedSessionCache = null;
  // Records are built from the windowed session, so a moved window retires
  // them. Dropping the reference BEFORE anything rebuilds keeps one copy alive
  // at a time — see the note on the axis picker.
  state.records = null;
  state.recordsAxis = null;
  state.marks = [];
  state.marksAxis = null;
  state.windowTrace = null;

  renderWindowPanel();
  renderAxisPanel();
  renderPlot();
  runRecommendations();
}

/** Slider position (0..1000) to log time, and back. */
function usFromPermille(value) {
  const window_ = state.window;
  const span = (window_.logEndUs ?? 0) - (window_.logStartUs ?? 0);
  return (window_.logStartUs ?? 0) + (value / 1000) * span;
}

function permilleFromUs(timeUs) {
  const window_ = state.window;
  const span = (window_.logEndUs ?? 0) - (window_.logStartUs ?? 0);
  if (!(span > 0)) {
    return 0;
  }
  return Math.max(0, Math.min(1000,
    Math.round(((timeUs - window_.logStartUs) / span) * 1000)));
}

/**
 * Why the window is what it is, in a sentence, plus what to do about it.
 *
 * Keyed off `FlightWindowBasis` rather than off string literals so a renamed
 * basis is a missing key at build time rather than a silently unexplained
 * screen. Anything unmapped still reaches the reader as its raw basis code.
 */
const WINDOW_BASIS = {
  [FlightWindowBasis.DETECTED]: ['good', 'takeoff and landing found',
    'The rotor came up to speed, the collective rose and stayed up, and later it came ' +
    'back down and stayed down. Everything on this page is measured between those two ' +
    'moments — the spool-up and the shutdown are left out, because a tune measured ' +
    'across them is measured against a helicopter that was not flying.'],
  [FlightWindowBasis.ENDED_IN_FLIGHT]: ['warn', 'still flying when the log stopped',
    'A takeoff was found and the recording stops while the helicopter is still up — a ' +
    'full card, a pulled battery, or the log simply cut. The window runs from the ' +
    'liftoff to the last sample.'],
  [FlightWindowBasis.CALLER_SUPPLIED]: ['good', 'you set this window',
    'These are the two ends you dragged. Nothing was detected on your behalf, and every ' +
    'measurement on this page is taken between them.'],
  [FlightWindowBasis.NO_COLLECTIVE]: ['none', 'no collective in this log',
    'Without a collective column there is no way to tell the ground from the air, so the ' +
    'whole recording is being used. Drag the two ends onto the part you actually flew.'],
  [FlightWindowBasis.NO_HEADSPEED]: ['none', 'no head speed in this log',
    'Without a head speed column the rotor cannot be shown to have been up before the ' +
    'collective rose, so a liftoff cannot be told from a collective check on the ground. ' +
    'The whole recording is being used. Drag the two ends onto the part you flew.'],
  [FlightWindowBasis.NO_ROTOR_START]: ['warn', 'the rotor is already turning at sample one',
    'This recording begins with the rotor already up, so there is no spool-up to find a ' +
    'takeoff after. The whole log is being used. If it starts on the ground, drag the ' +
    'left-hand end to where you lifted off.'],
  [FlightWindowBasis.NO_ROTOR_AT_SPEED]: ['warn', 'the rotor never reached flight speed',
    'The head never held a flight speed for long enough, so nothing here can be called a ' +
    'takeoff. The whole log is being used.'],
  [FlightWindowBasis.NO_LIFTOFF]: ['warn', 'no liftoff found',
    'The rotor came up but the collective never rose far enough for long enough to call ' +
    'it a liftoff. The whole log is being used — drag the ends if you did fly.'],
  [FlightWindowBasis.NO_SAMPLES]: ['bad', 'nothing to measure', 'This session has no samples.'],
  [FlightWindowBasis.NO_TIME]: ['bad', 'no timestamps',
    'This session carries no time column, so nothing can be placed in it at all.']
};

/**
 * Why the window is where it is, as HTML.
 *
 * Pure and exported for the same reason `vibrationHtml` is: most of these bases
 * need a log this repository does not have — a detected takeoff needs a spool-up
 * followed by a liftoff, and no fixture carries one — so the only way to prove
 * every branch renders, and that every basis the engine can return has words
 * here at all, is to hand it each one directly.
 */
export function windowBasisHtml(window_) {
  const [kind, label, why] = WINDOW_BASIS[window_.basis]
    ?? ['warn', window_.basis, 'This window\'s basis has no explanation in the viewer yet.'];

  const parts = [`<p style="margin:0 0 8px">${pill(kind, label)}</p>`,
    `<p class="muted" style="font-size:13px;margin:0">${esc(why)}</p>`];

  // Firmware ground truth, shown BESIDE our markers and never used to place
  // them. Two independent answers that agree is worth more than either alone,
  // and where they disagree the pilot is the one who should know.
  const airborne = window_.corroboration?.airborneEvent;
  const agreementUs = window_.corroboration?.airborneEventAgreementUs;
  if (airborne?.state === 'latched' && Number.isFinite(agreementUs)) {
    const gap = agreementUs / 1e6;
    parts.push(`<p class="muted" style="font-size:12.5px;margin:8px 0 0">The flight ` +
      `controller's own airborne flag went up ${text(Math.abs(gap), 1)} s ` +
      `${gap >= 0 ? 'after' : 'before'} the liftoff found here. It is shown for comparison ` +
      `and was not used to place the marker.</p>`);
  } else if (airborne?.state === 'latched') {
    // Latched, but no signed agreement — that is the caller-supplied path,
    // where there is no detected liftoff to compare it against.
    parts.push(`<p class="muted" style="font-size:12.5px;margin:8px 0 0">The flight ` +
      `controller's own airborne flag is in this log and is marked on the strip below, ` +
      `for comparison with where you put the ends.</p>`);
  } else if (airborne?.state === 'absent') {
    parts.push(`<p class="muted" style="font-size:12.5px;margin:8px 0 0">This log carries ` +
      `no airborne flag from the flight controller, so there is nothing to check the ` +
      `liftoff against.</p>`);
  }

  return parts.join('');
}

function renderWindowPanel() {
  $('window-basis').innerHTML = windowBasisHtml(state.window);
  syncWindowTimes();
  syncWindowSliders();
  drawWindowPlot();
}

/** The two ends and the duration, in seconds from the start of the recording. */
function syncWindowTimes(preview = null) {
  const window_ = state.window;
  const startUs = preview ? preview.startUs : window_.startUs;
  const endUs = preview ? preview.endUs : window_.endUs;
  const origin = window_.logStartUs ?? 0;

  const at = timeUs => (Number.isFinite(timeUs)
    ? `${((timeUs - origin) / 1e6).toFixed(1)} s`
    : '—');

  $('window-times').innerHTML =
    `<span>Takeoff <b>${at(startUs)}</b></span>` +
    `<span>Landing <b>${at(endUs)}</b></span>` +
    `<span>Flight <b>${Number.isFinite(endUs - startUs)
      ? `${((endUs - startUs) / 1e6).toFixed(1)} s` : '—'}</b></span>` +
    `<span class="muted">of ${((window_.logDurationUs ?? 0) / 1e6).toFixed(1)} s recorded</span>`;
}

function syncWindowSliders() {
  const window_ = state.window;
  const usable = Number.isFinite(window_.logDurationUs) && window_.logDurationUs > 0;
  $('window-start').disabled = !usable;
  $('window-end').disabled = !usable;
  if (!usable) {
    return;
  }
  $('window-start').value = String(permilleFromUs(window_.startUs));
  $('window-end').value = String(permilleFromUs(window_.endUs));
}

/**
 * The window strip: the whole recording, with what is in and what is out of the
 * window visible as picture rather than as two numbers.
 *
 * Collective is the signal the detector uses, so it is the one drawn: a pilot
 * who disagrees with the markers can see the stick position they were placed
 * from. Head speed is drawn behind it, scaled to its own range, because
 * "the rotor was up before the collective rose" is the other half of the rule.
 */
function drawWindowPlot() {
  const session = currentSession();
  const canvas = $('window-plot');
  const {context, cssWidth, cssHeight, ratio} = prepareCanvas(canvas);
  const window_ = state.window;
  const samples = session.samples;
  const timeIndex = timeIndexOf(session);

  if (samples.length === 0 || timeIndex === -1 || !(window_.logDurationUs > 0)) {
    context.fillStyle = '#8b98a5';
    context.font = '13px system-ui, sans-serif';
    context.textAlign = 'center';
    context.fillText('Nothing to place a window in.', cssWidth / 2, cssHeight / 2);
    return;
  }

  const columns = Math.max(1, Math.round(cssWidth * ratio));
  if (!state.windowTrace || state.windowTrace.columns !== columns) {
    const collectiveIndex = fieldIndexByName(session, window_.resolved?.collective ?? '');
    const headspeedIndex = fieldIndexByName(session, window_.resolved?.headspeed ?? '');
    state.windowTrace = {
      columns,
      collective: collectiveIndex === -1
        ? null
        : decimate(samples, collectiveIndex, 0, samples.length - 1, columns),
      headspeed: headspeedIndex === -1
        ? null
        : decimate(samples, headspeedIndex, 0, samples.length - 1, columns)
    };
  }

  const toX = timeUs => ((timeUs - window_.logStartUs) / window_.logDurationUs) * cssWidth;

  const paint = (trace, colour, width) => {
    if (!trace || trace.empty) {
      return;
    }
    let low = trace.low;
    let high = trace.high;
    if (!(high > low)) {
      low -= 1;
      high += 1;
    }
    const toY = value => cssHeight - 6 - ((value - low) / (high - low)) * (cssHeight - 12);
    context.strokeStyle = colour;
    context.lineWidth = width;
    context.beginPath();
    for (let column = 0; column < trace.columns; column += 1) {
      if (!Number.isFinite(trace.min[column])) {
        continue;
      }
      const x = (column / Math.max(1, trace.columns - 1)) * cssWidth;
      context.moveTo(x, toY(trace.min[column]));
      context.lineTo(x, toY(trace.max[column]));
    }
    context.stroke();
    return toY;
  };

  paint(state.windowTrace.headspeed, '#f0a33c', 1);
  const collectiveToY = paint(state.windowTrace.collective, '#4aa8ff', 1.2);

  // The rule the markers were placed by, drawn where they were placed from.
  if (collectiveToY && window_.thresholds) {
    for (const [level, colour] of [
      [window_.thresholds.liftLevel, '#3fb950'],
      [window_.thresholds.settleLevel, '#d29922']
    ]) {
      if (!Number.isFinite(level)) {
        continue;
      }
      context.strokeStyle = colour;
      context.globalAlpha = 0.5;
      context.setLineDash([3, 3]);
      context.beginPath();
      context.moveTo(0, collectiveToY(level));
      context.lineTo(cssWidth, collectiveToY(level));
      context.stroke();
      context.setLineDash([]);
      context.globalAlpha = 1;
    }
  }

  // Everything outside the window, dimmed. This is the half of the requirement
  // that two timestamps cannot meet: a pilot has to SEE what was thrown away.
  const startX = Math.max(0, Math.min(cssWidth, toX(state.windowPreview?.startUs ?? window_.startUs)));
  const endX = Math.max(0, Math.min(cssWidth, toX(state.windowPreview?.endUs ?? window_.endUs)));
  context.fillStyle = 'rgba(14,17,22,0.72)';
  context.fillRect(0, 0, startX, cssHeight);
  context.fillRect(endX, 0, cssWidth - endX, cssHeight);

  context.strokeStyle = '#e6edf3';
  context.lineWidth = 1.5;
  for (const x of [startX, endX]) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, cssHeight);
    context.stroke();
  }

  // Where the rotor started and where it reached flight speed: the other half
  // of the liftoff rule, and the thing a pilot checks a wrong marker against.
  if (window_.marks) {
    context.fillStyle = '#8b98a5';
    for (const timeUs of [window_.marks.rotorSpinUs, window_.marks.rotorAtSpeedUs]) {
      if (!Number.isFinite(timeUs)) {
        continue;
      }
      context.fillRect(toX(timeUs) - 0.5, cssHeight - 5, 1, 5);
    }
  }

  const marker = (timeUs, colour) => {
    if (!Number.isFinite(timeUs)) {
      return;
    }
    const x = toX(timeUs);
    context.fillStyle = colour;
    context.beginPath();
    context.moveTo(x, 8);
    context.lineTo(x - 5, 0);
    context.lineTo(x + 5, 0);
    context.closePath();
    context.fill();
  };
  marker(window_.takeoff?.timeUs, '#3fb950');
  marker(window_.landing?.timeUs, '#d29922');

  const airborne = window_.corroboration?.airborneEvent;
  if (airborne?.state === 'latched' && Number.isFinite(airborne.timeUs)) {
    // A ring rather than a triangle: it is the firmware's opinion, not ours, and
    // it must be distinguishable from our own markers at arm's length in sun.
    context.strokeStyle = '#a371f7';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(toX(airborne.timeUs), 6, 4.5, 0, Math.PI * 2);
    context.stroke();
  }

  // While a finger is down the note belongs to the live check below, not to the
  // legend — repainting the legend under a validation message makes it flicker.
  if (state.windowPreview) {
    return;
  }

  $('window-note').innerHTML =
    `<span style="color:#4aa8ff">&#9473;</span> collective &middot; ` +
    `<span style="color:#f0a33c">&#9473;</span> head speed, scaled to its own range &middot; ` +
    `<span style="color:#3fb950">&#9650;</span> takeoff &middot; ` +
    `<span style="color:#d29922">&#9650;</span> landing` +
    (state.window.corroboration?.airborneEvent?.state === 'latched'
      ? ` &middot; <span style="color:#a371f7">&#9711;</span> the controller's own airborne flag`
      : '') +
    `. The dimmed ends are outside the window and are in no number on this page. ` +
    `Drag either slider to move an end; everything re-measures when you let go.`;
}

/**
 * Live validation while an end is being dragged.
 *
 * Coalesced through one frame callback because `checkFlightWindow` walks the
 * whole time column — measured at 6–7 ms on the 134k-sample reference log in
 * Node, so at most one per frame and only while a finger is down. The commit
 * happens on `change` (the release), not on `input`: re-running the stop
 * detector, the holds and the recommendations at 60 Hz would freeze the phone.
 */
let windowDragFrame = 0;

function previewWindowFromSliders() {
  const startValue = Number($('window-start').value);
  const endValue = Number($('window-end').value);
  const startUs = usFromPermille(Math.min(startValue, endValue));
  const endUs = usFromPermille(Math.max(startValue, endValue));

  state.windowPreview = {startUs, endUs};
  syncWindowTimes(state.windowPreview);
  drawWindowPlot();

  if (windowDragFrame) {
    return;
  }
  const previewed = state.windowPreview;
  windowDragFrame = requestAnimationFrame(() => {
    windowDragFrame = 0;
    // The finger came off between scheduling this and running it, so the commit
    // has already re-measured the page and written its own note. Checking a
    // window nobody is dragging any more would replace a real message with
    // WINDOW_NOT_FINITE.
    if (state.windowPreview !== previewed) {
      return;
    }
    const check = checkFlightWindow(currentSession(), previewed);
    $('window-note').innerHTML = check.valid
      ? `<span class="muted">${((check.durationUs) / 1e6).toFixed(1)} s, ` +
        `${check.sampleCount.toLocaleString()} samples` +
        `${check.clamped ? ', pulled back to the ends of the recording' : ''}. ` +
        `Let go to measure everything over it.</span>`
      : `<span class="error">${esc(WINDOW_CHECK_WORDS[check.code] ?? check.code)}</span>`;
  });
}

/** `checkFlightWindow` codes as sentences. Anything unmapped shows its code. */
const WINDOW_CHECK_WORDS = {
  WINDOW_TOO_FEW_SAMPLES: 'Fewer than two samples fall inside this window, so nothing can ' +
    'be measured over it. Widen it.',
  WINDOW_INVERTED: 'The landing end is before the takeoff end.',
  WINDOW_OUTSIDE_LOG: 'This window falls outside the recording.',
  WINDOW_NOT_FINITE: 'That is not a window this log can be measured over.'
};

function commitWindowFromSliders() {
  const preview = state.windowPreview;
  state.windowPreview = null;
  if (!preview) {
    return;
  }
  // Handed to the engine as an override rather than used directly: a window
  // that cannot be measured over falls back to detection there, with
  // `overrideCheck` saying why, instead of being pushed on broken from here.
  state.windowOverride = {startUs: preview.startUs, endUs: preview.endUs};
  applyFlightWindow();

  const rejected = state.window.overrideCheck && !state.window.overrideCheck.valid;
  if (rejected) {
    $('window-note').innerHTML =
      `<span class="error">${esc(WINDOW_CHECK_WORDS[state.window.overrideCheck.code]
        ?? state.window.overrideCheck.code)}</span> ` +
      `<span class="muted">The detected window is being used instead.</span>`;
  }
}

// ---------------------------------------------------------------------------
// Recommendations
//
// The panel the owner has been describing since the start: the one that tells
// someone with no idea what he is looking at what to do about it.
//
// Nothing here decides anything. `buildRecommendations` returns an ORDERED list
// with at most one `actNow`, and the only judgement this file makes is how to
// put each finding on a 384px screen. Where the engine says "I cannot separate
// these two causes" this renders both and the manoeuvre that settles it, as an
// answer and not as a failure — that is the common case and it must not read
// like an error.
// ---------------------------------------------------------------------------

/**
 * How many analysis records may be alive at once.
 *
 * MEASURED, not guessed. `buildAnalysisRecords` on the flight window of the
 * reference log (sample-bell-222ut.bbl, 134,429 samples, 111,509 inside the
 * window) costs ~50 MB of V8 heap per axis — 0.45 KB per record — on top of the
 * ~112 MB the decoded session itself occupies. `buildRecommendations` wants all
 * three axes at once, because the ordering across rungs and the "at most one
 * actNow" rule are decided across the whole flight rather than per axis.
 *
 * Three axes of the reference flight is 334,527 records and measured a 293 MB
 * peak in Node. That is more than a WebView process is guaranteed, so the budget
 * is real: axes are analysed in order, SELECTED AXIS FIRST, until it runs out,
 * and the panel says on screen which axes were left out and why rather than
 * quietly advising on two of three. The limit below admits the reference flight
 * and stops a log roughly a third larger again.
 *
 * The records for every axis but the selected one are dropped the moment the
 * engine returns, so the steady state after a run is one axis — the same as it
 * was before this panel existed.
 */
const MAX_ANALYSIS_RECORDS = 360_000;

const RUNG_LABEL = {
  log: 'the log itself',
  airframe: 'the airframe',
  headspeed: 'head speed',
  'axis-mechanical': 'mechanical',
  'gain-P': 'the P gain',
  'gain-D': 'the D gain',
  'gain-I': 'the I gain',
  evidence: 'what this flight could not answer'
};

const KIND_PILL = {
  // "before any gain" rather than "sort this out first": several findings can
  // be blockers at once, and an imperative on each of three cards reads as
  // three things to do. Which ONE to do is `actNow`, and that card carries its
  // own marker below.
  blocker: ['warn', 'before any gain'],
  adjustment: ['good', 'a change to make'],
  observation: ['none', 'measured'],
  'next-flight': ['none', 'fly this to settle it']
};

const CONFIDENCE_PILL = {
  high: ['good', 'high confidence'],
  medium: ['warn', 'medium confidence'],
  low: ['none', 'low confidence'],
  none: ['none', 'not a verdict']
};

/** The word for an axis in the language a pilot uses about his helicopter. */
const AXIS_THING = {roll: 'roll', pitch: 'pitch', yaw: 'tail'};
/** ...and what stopping that axis is called. */
const AXIS_STOP = {
  roll: 'stop a roll',
  pitch: 'stop a pitch input',
  yaw: 'stop a pirouette'
};

/**
 * What each finding means, said the way a pilot would say it.
 *
 * The engine's own `headline` is already a sentence and is always rendered
 * underneath — this layer exists because "your tail overshoots when you stop a
 * pirouette" reaches someone who does not know what a D term is, and "Lower yaw
 * D" does not. It is COPY, never a decision: nothing here changes which finding
 * appears, in what order, or which way a gain moves, and an id with no entry
 * falls through to the engine's own wording rather than being guessed at.
 */
const PLAIN_ENGLISH = {
  AIRFRAME_CLEAR: () =>
    'Your helicopter is running smoothly enough for the rest of this to mean something.',
  AIRFRAME_VIBRATION_PRESENT: () =>
    'Your helicopter is shaking. Nothing about the tune can be judged until that stops — '
    + 'vibration looks exactly like a badly set D term, and chasing it with gains makes it '
    + 'worse.',
  AIRFRAME_BROADBAND_ELEVATED: () =>
    'The gyro is noisy across the whole range, not at one frequency. That is the airframe '
    + 'or the mounting, and it swamps the measurements a tune is judged on.',
  AIRFRAME_ROTOR_NOT_COMPARED: () =>
    'Your rotor speed moved too much across this flight for the shaking to be compared '
    + 'against it, so the head is neither blamed nor ruled out.',
  AIRFRAME_UNFILTERED_GYRO_MISSING: () =>
    'This log only has the filtered gyro in it. The filters take the vibration out before '
    + 'it can be measured, so nothing here can tell you whether your helicopter is smooth.',
  AIRFRAME_BROADBAND_NOT_MEASURED: () =>
    'The vibration level could not be read on this flight at all.',
  AIRFRAME_NOT_CHECKED: () =>
    'The vibration check has not been run over this window yet.',
  AIRFRAME_RANGE_EXCLUDES_EVENTS: () =>
    'The vibration was measured over a different part of the flight from the stops. Move '
    + 'the flight window so it covers both.',
  HEADSPEED_STEADY_ENOUGH: () =>
    'Your head speed held steady enough for the gains to be judged against it.',
  HEADSPEED_MOVED_DURING_STEADY_FLIGHT: () =>
    'Your head speed wandered while you were flying steadily. Every cyclic and tail gain '
    + 'behaves differently at a different head speed, so a tune taken on a drooping '
    + 'machine is wrong everywhere else.',
  HEADSPEED_NOT_MEASURED: () =>
    'There is no usable head speed in this flight to judge the gains against.',
  DIRECTIONAL_ASYMMETRY_MECHANICAL: finding => (finding.axis === 'yaw'
    ? 'Your tail behaves differently stopping one way from the other, by more than a gain '
      + 'would explain. That is the linkage, the travel or the tail running out of '
      + 'authority — not a number in the tune.'
    : `Your ${finding.axis} behaves differently one way from the other, by more than a gain `
      + 'would explain. That points at the linkage or the head, not at the tune.'),
  SUSPECTED_MECHANICAL_BIND: finding =>
    `Something is stopping your ${AXIS_THING[finding.axis] ?? finding.axis} from moving as `
    + 'far as it is being asked to. Check it before you touch anything in the tune.',
  P_TOO_LOW: finding =>
    `Your ${AXIS_THING[finding.axis] ?? finding.axis} lags behind the stick and does not `
    + 'arrive where you put it.',
  P_TOO_HIGH: finding =>
    `Your ${AXIS_THING[finding.axis] ?? finding.axis} twitches while you are holding it `
    + `steady, and swings past centre when you ${AXIS_STOP[finding.axis] ?? 'stop'}.`,
  AXIS_DOES_NOT_ARREST: finding =>
    `Your ${AXIS_THING[finding.axis] ?? finding.axis} keeps going after you centre the `
    + 'stick instead of stopping where you put it.',
  D_TOO_HIGH: finding =>
    `Your ${AXIS_THING[finding.axis] ?? finding.axis} shakes for a moment every time you `
    + `${AXIS_STOP[finding.axis] ?? 'stop'} — and it is quiet while you hold, which is what `
    + 'makes it the D term rather than the P term.',
  RINGING_BELOW_NOISE_FLOOR: finding =>
    `Anything ringing after a ${finding.axis} stop is smaller than the noise already in the `
    + 'gyro, so there is nothing here to chase.',
  RINGING_SOURCE_UNKNOWN: finding =>
    `Your ${AXIS_THING[finding.axis] ?? finding.axis} rings after you `
    + `${AXIS_STOP[finding.axis] ?? 'stop'}, and this flight cannot say whether it was `
    + 'already ringing while you held the stick still. That is what separates too much P '
    + 'from too much D.',
  SLOW_OSCILLATION_AFTER_RELEASE: finding =>
    `Your ${AXIS_THING[finding.axis] ?? finding.axis} wallows after you `
    + `${AXIS_STOP[finding.axis] ?? 'stop'} — slowly, too slowly for the D term to be doing `
    + 'it.',
  OVERSHOOT_CANDIDATES_UNSEPARATED: finding =>
    `Your ${AXIS_THING[finding.axis] ?? finding.axis} swings past centre before it settles. `
    + 'Three different things do that and one flight of this shape cannot tell them apart.',
  STOPS_SETTLE_CLEANLY: finding =>
    `Your ${AXIS_THING[finding.axis] ?? finding.axis} stops cleanly. That is a measurement, `
    + 'not silence — it was looked at and there was nothing to fix.',
  I_TERM_WITHIN_TOLERANCE: finding =>
    `Nothing in the way you held ${finding.axis} calls for an I change.`,
  I_TERM_VERDICT_UNSTABLE: finding =>
    `The I-term answer for ${finding.axis} changed depending on how it was measured, so `
    + 'there is no answer to give you.',
  NO_HOLD_EVIDENCE: finding =>
    `You never held ${finding.axis} steady for long enough in this flight for the I term to `
    + 'show itself.',
  HOLD_EVIDENCE_PROVISIONAL: finding =>
    `Not quite enough steady ${finding.axis} yet to call the I term.`,
  STOP_EVIDENCE_INCOMPLETE: finding =>
    `Not enough ${finding.axis} stops in this flight to compare the two directions.`,
  STOP_SHAPE_PROVISIONAL: finding =>
    `What the ${finding.axis} stops in this flight did, with too few of them to conclude `
    + 'from.'
};

/** Nothing here is a decision either: it names the gain in ordinary words. */
const GAIN_GLOSS = {
  P: 'P is how hard the controller pushes back when the helicopter is not doing what you '
    + 'asked.',
  I: 'I is how it deals with an error that just sits there and will not go away.',
  D: 'D damps the fast stuff — it acts on how quickly the error is changing, which is why '
    + 'it shows up on a stop and not during a steady hold.'
};

function plainEnglish(finding) {
  const write = PLAIN_ENGLISH[finding.id];
  return typeof write === 'function' ? write(finding) : finding.headline;
}

/** Values arrive from the engine already rounded, so they are printed as-is. */
function basisValue(entry) {
  if (entry.value === null || entry.value === undefined) {
    return '—';
  }
  return `${entry.value}${entry.unit ? ` ${entry.unit}` : ''}`;
}

function basisTable(basis) {
  if (!basis || basis.length === 0) {
    return '';
  }
  return `<details class="help"><summary>The measurements behind this ` +
    `(${basis.length})</summary><div><div class="scroll"><table class="basis">` +
    basis.map(entry =>
      `<tr><td>${esc(entry.label)}<span class="src">${esc(entry.source ?? '')}</span></td>` +
      `<td class="v">${esc(basisValue(entry))}</td></tr>`
    ).join('') +
    `</table></div><p class="muted" style="font-size:12px;margin-top:10px">Every one of ` +
    `these is on the trace below. If a number here does not match what you can see, this ` +
    `app is wrong and the trace is right.</p></div></details>`;
}

const GAIN_ADJUST = /^(roll|pitch|yaw) ([PID])$/;

/**
 * Where this card's advice comes from: a convention, or this pilot's flights.
 *
 * The distinction is the whole reason the learning work exists. "Lower yaw D"
 * has always been a direction taken from how these controllers behave in
 * general — the app has never said how far, and `magnitudes` is empty by
 * contract. If an amount ever appears it will have been fitted to THIS
 * helicopter's before/after flights, and a pilot who cannot tell the two apart
 * cannot weigh either of them against what he felt in the air.
 *
 * A magnitude is drawn only when it names a finding that is on screen and
 * points the same way that finding does. An entry that names nothing, or
 * disagrees about the direction, renders nowhere: nothing here may create
 * advice, only narrow advice the engine already permitted.
 */
function provenanceHtml(finding, magnitude, learning) {
  if (finding.kind !== 'adjustment' || !finding.direction) {
    return '';
  }

  const gain = GAIN_ADJUST.exec(finding.adjust ?? '');
  const entry = gain ? learningTerm(learning, gain[1], gain[2]) : null;

  if (magnitude !== null) {
    const behind = Number.isInteger(magnitude.experiments)
      ? magnitude.experiments
      : entry?.pointCount ?? null;
    return `<p class="provenance measured">${pill('good', 'measured on your helicopter')}`
      + `<span>${esc(magnitude.sentence)}</span><span class="muted">`
      + (behind === null
        ? 'From the flights you have saved for this helicopter.'
        : `From ${behind} of your own flight${behind === 1 ? '' : 's'} of this helicopter.`)
      + ' Forget one of them and this number changes or disappears.</span></p>';
  }

  return `<p class="provenance convention">${pill('none', 'general convention')}`
    + '<span>Which way, not how far &mdash; and which way comes from how these '
    + 'controllers behave in general, not from anything measured on your machine.</span>'
    + learningAsideHtml(entry)
    + '</p>';
}

/**
 * The one line a card may say about what this pilot's own flights have taught.
 *
 * IT IS BUILT FROM `learningCell`, THE SAME FUNCTION THE NINE-CELL GRID USES,
 * and that is the whole point of it existing rather than being written inline.
 * An earlier version composed its own "N of your own flights, out of the 6 a
 * fitted amount would need at the very least" from the raw point count, and it
 * was wrong in both directions at once: on a D card it promised that six flights
 * would buy an amount for a gain the grid four lines below reported as
 * PERMANENTLY unmeasurable, and once a term passed six points it read "8 ... out
 * of the 6 ... at the very least" beside a grid cell saying those eight flights
 * disagreed with each other. Both are the card and the grid contradicting each
 * other about the same gain on the same screen. Sharing the function is what
 * makes that unsayable rather than merely unlikely.
 */
function learningAsideHtml(entry) {
  if (entry === null || entry.state === null) {
    return '';
  }
  const cell = learningCell(entry);
  if (cell.unit === 'no model') {
    return '';
  }
  if (cell.unit === 'not measurable') {
    // Never, not "not yet". No flight count belongs in this sentence, because
    // quoting one implies a number of flights that would be enough.
    return `<span class="muted">No number of flights can put an amount on `
      + `${esc(entry.gain)}. RotorLens reads the standing error during a hold, and D acts `
      + 'on how fast that error is changing, which during a hold is nothing.</span>';
  }
  return `<span class="muted">Your own flights so far for ${esc(entry.gain)}: `
    + `${esc(String(cell.count))} ${esc(cell.unit)}. The flight history panel says what `
    + 'that means and what the next flight would add.</span>';
}

/**
 * The magnitude attached to one finding, or null.
 *
 * Tolerant about which key names the finding and strict about everything else:
 * an entry with no readable sentence publishes nothing, because the alternative
 * is this file writing prose around numbers whose units it is guessing at.
 */
function magnitudeFor(magnitudes, finding) {
  if (!Array.isArray(magnitudes)) {
    return null;
  }
  // The finding's own id must be a real one before anything may be keyed to it.
  // Without this, an entry naming NO finding collapses to null through the
  // nullish chain below and then matches any finding whose id is also null —
  // an amount drawn onto a card it claims no relationship to.
  if (typeof finding?.id !== 'string' || finding.id === '') {
    return null;
  }
  const found = magnitudes.find(entry =>
    (entry?.findingId ?? entry?.finding ?? null) === finding.id
    && (entry?.direction === undefined || entry.direction === finding.direction));
  return typeof found?.sentence === 'string' && found.sentence.trim() !== '' ? found : null;
}

/**
 * One finding, as a card.
 *
 * Exported so the browser test can drive every kind through the SHIPPED
 * renderer, including the ones no fixture in this repository produces.
 *
 * @param {object} finding one entry from `result.findings`
 * @param {object} context `{magnitude, learning}` — both optional, both null in
 *   the state that ships today
 */
export function findingHtml(finding, context = {}) {
  const [kindClass, kindLabel] = KIND_PILL[finding.kind] ?? ['none', finding.kind];
  const [confidenceClass, confidenceLabel] =
    CONFIDENCE_PILL[finding.confidence] ?? ['none', finding.confidence];

  const parts = [];

  // The one change to make, said in words as well as drawn in a border. A
  // coloured edge is not a label, and this is the sentence the whole panel
  // exists to put in front of someone who does not know where to start.
  if (finding.actNow) {
    parts.push('<p class="start-here">Start here &mdash; one change at a time</p>');
  }

  parts.push(
    `<div class="step"><span>${esc(RUNG_LABEL[finding.rung] ?? finding.rung)}</span>` +
    (finding.axis ? `<span>&middot; ${esc(finding.axis)}</span>` : '') +
    pill(kindClass, kindLabel) + pill(confidenceClass, confidenceLabel) + '</div>',
    `<p class="plain">${esc(plainEnglish(finding))}</p>`
  );

  // `direction` is non-null ONLY on an adjustment — the engine's contract — and
  // this is the only place a direction is ever drawn.
  if (finding.kind === 'adjustment' && finding.direction) {
    const gain = GAIN_ADJUST.exec(finding.adjust ?? '');
    parts.push(`<div class="change">` +
      `<span class="verb">${finding.direction === 'increase' ? '&#9650; Increase' : '&#9660; Lower'}</span>` +
      `<span class="what">${esc(finding.adjust ?? '')}</span>` +
      `<span class="gloss">One step, and nothing else at the same time.` +
      `${gain ? ` ${esc(GAIN_GLOSS[gain[2]])}` : ''}</span></div>`);
    // Immediately under the direction, because that is where a pilot decides how
    // much to trust it.
    parts.push(provenanceHtml(finding, context.magnitude ?? null, context.learning ?? null));
  } else if (finding.kind === 'blocker' && finding.adjust) {
    parts.push(`<p class="label">Look at</p><p>${esc(finding.adjust)} — before any gain.</p>`);
  }

  // The engine's own sentence, always, underneath the plain one. A pilot who
  // learns the vocabulary should be able to see the two line up, and a reader
  // checking this app against the engine should not have to open the console.
  if (finding.headline && finding.headline !== plainEnglish(finding)) {
    parts.push(`<p class="engine">${esc(finding.headline)}</p>`);
  }

  parts.push(`<p class="label">Why</p><p>${esc(finding.reasoning)}</p>`);

  if (finding.candidates.length > 0) {
    parts.push(`<p class="label">The evidence does not separate these</p>` +
      `<ul class="cands">${finding.candidates.map(
        candidate => `<li>${esc(candidate)}</li>`).join('')}</ul>`);
  }

  if (finding.confirm) {
    parts.push(`<p class="label">${finding.kind === 'adjustment'
      ? 'Then fly this to confirm it'
      : finding.kind === 'blocker' ? 'What would unblock this' : 'Fly this next'
      }</p><p>${esc(finding.confirm)}</p>`);
  }

  parts.push(basisTable(finding.basis));
  parts.push(codeList(finding.codes, 'Machine codes for this finding'));

  return `<div class="finding kind-${esc(finding.kind)}${finding.actNow ? ' act-now' : ''}">` +
    parts.join('') + '</div>';
}

/**
 * The whole panel, from one `buildRecommendations` result.
 *
 * Pure and exported: every branch below is reachable from a hand-built result in
 * a test, including the states no fixture in this repository reaches.
 *
 * @param {object} result   a `buildRecommendations` result
 * @param {object} coverage which axes were analysed, and which were not
 * @param {object|null} learning `learningFromHistory(...)` for the helicopter
 *   this log came from, so each adjustment can say whether an amount rests on
 *   this pilot's own flights and how many. Null when the log names no
 *   helicopter, or when nothing has been saved for it.
 */
export function recommendationsHtml(result, coverage = {}, learning = null) {
  const parts = [];

  const gate = (label, block) => {
    const status = block?.status ?? 'not-run';
    const kind = status === 'permitted' ? 'good' : status === 'not-run' ? 'none' : 'warn';
    return pill(kind, `${label}: ${status === 'permitted' ? 'clear' : status}`);
  };
  parts.push('<div class="gate-row">' +
    gate('airframe', result.gates?.airframe) +
    gate('head speed', result.gates?.headspeed) + '</div>');

  const acted = result.findings.filter(finding => finding.actNow);
  if (acted.length === 0) {
    parts.push(`<p style="font-size:13.5px">There is no single change this flight earns. ` +
      `What it can tell you is below, in the order it has to be dealt with.</p>`);
  }

  if (result.findings.length === 0) {
    parts.push(`<p style="font-size:13.5px">This flight produced nothing to say at all — ` +
      `not even a negative. That usually means the log is missing the fields the analysis ` +
      `reads; the Fields panel at the foot of the page lists what it does carry.</p>`);
  }

  // In order. The order IS the advice: a rung is measured under conditions the
  // rungs above it invalidate, so working down the list is the point.
  //
  // A magnitude is looked up per finding rather than iterated over, which is
  // what makes the airframe interlock apply to it for free: `orderFindings`
  // suppresses every adjustment below a blocked rung, and a magnitude naming a
  // finding that is not in this list is never asked for and never drawn.
  for (const finding of result.findings) {
    parts.push(findingHtml(finding, {
      magnitude: magnitudeFor(result.magnitudes, finding),
      learning
    }));
  }

  if (result.withheld.length > 0) {
    parts.push(`<h3>Seen, and deliberately not turned into advice</h3>` +
      `<ul class="reasons">${result.withheld.map(entry =>
        `<li>${esc(entry.sentence)}</li>`).join('')}</ul>`);
  }

  // `magnitudes` is empty by contract, and stays empty until a helicopter's own
  // flights have earned an amount. Saying so is not a caveat, it is the answer
  // to the question a pilot asks next.
  if (result.magnitudes.length === 0) {
    parts.push(`<p class="boundary">How far to move it is not something this app will ` +
      `guess. Nothing in a Blackbox log recovers the controller's own scaling, so a number ` +
      `here would be a guess with a decimal point on it. One step, then fly it again — the ` +
      `next log is what says whether it went the right way. ` +
      `The only thing that could ever put a number here is your own before/after flights, ` +
      `and the Flight history panel counts how many of them there are.` +
      `${result.magnitudeBasis ? ` ${esc(result.magnitudeBasis)}` : ''}</p>`);
  }

  parts.push(`<p class="boundary">${esc(result.boundary)}</p>`);

  parts.push(`<details class="help"><summary>What the confidence words mean</summary><div>` +
    `<ul class="reasons" style="font-size:13px">` +
    `<li><b>High</b> — the evidence separates this from the alternatives on its own.</li>` +
    `<li><b>Medium</b> — it is the best reading of what was measured, and it rests on ` +
    `thresholds this project chose. Check the numbers against the trace.</li>` +
    `<li><b>Low</b> — a direction of travel, not a verdict.</li>` +
    `<li><b>Not a verdict</b> — this is a measurement or a gap, and nothing is being ` +
    `claimed from it.</li></ul></div></details>`);

  if (coverage.skipped?.length > 0) {
    parts.push(`<h3>Axes not analysed</h3><ul class="reasons">` +
      coverage.skipped.map(entry => `<li>${esc(entry.axis)} — ${esc(entry.why)}</li>`).join('') +
      `</ul>`);
  }

  return parts.join('');
}

/**
 * Waits until the pixels are actually on screen, not merely queued.
 *
 * A frame callback runs BEFORE paint, and resuming from `await` is a microtask —
 * which also runs before paint. So `await` on a bare `requestAnimationFrame`
 * hands control back while the frame is still being assembled, and a long
 * synchronous call made there blocks the very paint it was waiting for. Only a
 * TASK posted from inside the frame callback is guaranteed to run after the
 * previous frame has been presented.
 *
 * The outer timeout is the escape hatch for a host that is not drawing frames at
 * all — a backgrounded WebView, or a headless browser. Waiting forever for a
 * paint that will never come would strand an import.
 */
function yieldToRender() {
  return new Promise(resolve => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    requestAnimationFrame(() => setTimeout(done, 0));
    setTimeout(done, 120);
  });
}

/** One frame, or 50 ms, whichever the host still services. See `runVibration`. */
function yieldToPaint() {
  return new Promise(resolve => {
    let settled = false;
    const go = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    requestAnimationFrame(go);
    setTimeout(go, 50);
  });
}

/**
 * The range handed to the mechanical analysis.
 *
 * Snapped to the windowed session's own first and last SAMPLE, not to the
 * window's microsecond ends. `analyzeMechanicalTimeSeries` throws
 * ANALYSIS_RANGE_INVALID for a range that starts before the first sample it was
 * given, and a window dragged with a finger lands between samples essentially
 * always — so asking for `[startUs, endUs]` verbatim killed the whole panel the
 * first time either marker was moved. Then clamped to the longest selection the
 * spectrum analysis accepts, which is what the vibration panel does too.
 */
function mechanicalRange(scoped) {
  const bounds = sessionTimeBounds(scoped);
  const cap = MECHANICAL_CONSTANTS.maximumSelectionDurationUs;
  const startTimeUs = bounds.startTimeUs ?? state.window.startUs ?? 0;
  const requested = Math.max(0, (bounds.endTimeUs ?? startTimeUs) - startTimeUs);
  return {
    startTimeUs,
    endTimeUs: startTimeUs + Math.min(requested, cap),
    clamped: requested > cap
  };
}

/**
 * Builds everything `buildRecommendations` needs, over the flight window.
 *
 * Axes are taken selected-first so that when the record budget runs out it is
 * the axis the pilot is not looking at that goes without.
 */
const AXIS_ORDER = ['roll', 'pitch', 'yaw'];

async function collectRecommendationMaterial(scoped, session, superseded = () => false) {
  // Fetched here rather than imported at the top of this file.
  //
  // `recommendations.mjs` and the gates it pulls in are 210 KB, and they are of
  // no use until a log has been opened — which is the one place this function is
  // reached from. The module map memoises, so the second analysis of the second
  // log costs nothing, and the first one is hidden behind reading a session's
  // frames.
  //
  // Be honest about the size of this: it is 210 KB and five fewer round trips at
  // start-up, not a speed-up anyone will feel. Measured in headless Chromium,
  // removing it from the start-up graph moved neither DOMContentLoaded nor
  // `Performance.ScriptDuration` outside the run-to-run noise. It survives
  // because it is one line and reads as what it is, not because it is fast.
  //
  // A literal, relative specifier: no bundler rewrites it, so this exact path is
  // what AssetServer is asked for inside the APK, what tools/serve-ui.mjs serves
  // in a browser, and what Node resolves on disk. If it ever fails to arrive,
  // the caller's catch writes "The analysis could not be run: …" into the panel
  // — a message, not a button that does nothing.
  const {analyseAxisEvidence, buildRecommendations} =
    await import('../src/analysis/recommendations.mjs');

  const axes = {};
  const axisSummaries = {};
  const skipped = [];
  let anyRecords = [];
  let budget = MAX_ANALYSIS_RECORDS;

  const selected = $('axis').value;
  const order = [selected, ...AXIS_ORDER.filter(axis => axis !== selected)];

  const range = mechanicalRange(scoped);
  const mechanical = await analyzeMechanicalTimeSeries(
    buildMechanicalSeries(scoped), {timeRangeUs: range}
  );

  for (const axis of order) {
    const signals = resolveAxisSignals(session, axis);
    if (signals.usable) {
      axisSummaries[axis] = summarizeAxis(scoped, signals);
    }

    const built = buildAnalysisRecords(scoped, {axis});
    if (!built.usable) {
      skipped.push({axis, why: `this log does not carry ${built.missing.join(', ')}`});
      continue;
    }
    if (built.records.length > budget) {
      skipped.push({
        axis,
        why: 'this log is too large to hold three axes of it in memory at once. Pick this '
          + 'axis at the top of the Axis panel and it will be analysed instead.'
      });
      continue;
    }
    budget -= built.records.length;
    anyRecords = built.records;
    axes[axis] = {...analyseAxisEvidence(built.records, axis), records: built.records};
  }

  const result = buildRecommendations({axes, records: anyRecords, mechanical, axisSummaries});

  // Everything the flight history needs, taken from work that has already been
  // done. The hold evidence is the object `buildRecommendations` built for its
  // own gates, and the stop evidence is `analyseAxisEvidence`'s — deriving
  // either a second time would double the most expensive part of this run for
  // numbers that are already in hand.
  const historyAxes = {};
  for (const axis of AXIS_ORDER) {
    const summary = axisSummaries[axis] ?? null;
    historyAxes[axis] = {
      headspeedMedianRpm: summary?.headspeedMedianRpm ?? null,
      holdEvidence: result.gates?.holds?.[axis]?.evidence ?? null,
      stopEvidence: axes[axis]?.evidence ?? null,
      noise: {
        // The FILTERED figure is what the controller saw; the unfiltered one is
        // where a bearing or a blade shows up first. The record keeps both.
        filteredHighFrequencyRmsDps: summary?.gyroHighFrequencyRmsDps ?? null,
        unfilteredHighFrequencyRmsDps: summary?.unfilteredHighFrequencyRmsDps ?? null
      }
    };
  }

  // Keep exactly one axis's records alive — the one the measurement panels are
  // about to use. The other two are ~50 MB each on a mid-size log and nothing
  // reads them again.
  //
  // ONLY when this run is still the current one. This write sits after every
  // await above, and the token check in `measureRecommendations` guards the
  // paint, not this cache: a superseded run landing here late — the pilot
  // dragged the window twice, or opened a second log while the first's ~4 s
  // analysis was in flight — used to overwrite `state.records` with records
  // built over a window, or a HELICOPTER, the page no longer shows, and
  // `ensureRecords` would then serve them as current.
  if (!superseded()) {
    state.records = axes[selected]?.records ?? null;
    state.recordsAxis = state.records ? selected : null;
    state.recordsMissing = [];
  }

  return {
    result,
    historyAxes,
    coverage: {
      analysed: Object.keys(axes),
      skipped,
      range,
      windowBasis: state.window.basis
    }
  };
}

/**
 * How many analyses are in flight over each session index.
 *
 * `evictDecodedSessions` will not release a session listed here, and that is not
 * a nicety. An analysis holds references to the session object it started on,
 * and `releaseFrames` empties that object IN PLACE — so freeing a flight the
 * pilot has switched away from, while its analysis is still running, makes that
 * analysis read `null.length`. On a phone that is a blank screen, and it was
 * found by the eviction test rather than by anything on this page looking wrong.
 *
 * A count rather than a flag, because dragging the flight window can start a
 * second run over the same session before the first has retired.
 */
const analysesInFlight = new Map();
state.analysesInFlight = analysesInFlight;

function analysisStarted(index) {
  analysesInFlight.set(index, (analysesInFlight.get(index) ?? 0) + 1);
}

function analysisFinished(index) {
  const left = (analysesInFlight.get(index) ?? 1) - 1;
  if (left > 0) {
    analysesInFlight.set(index, left);
  } else {
    analysesInFlight.delete(index);
  }
}

/**
 * Runs the analysis, and gives back what it was protecting when it is done.
 *
 * The eviction pass runs again here rather than only on a session change: a
 * flight held only because it was being analysed should be let go the moment
 * that finishes, not at the next thing the pilot happens to tap.
 */
async function runRecommendations() {
  const index = state.sessionIndex;
  analysisStarted(index);
  try {
    return await measureRecommendations();
  } finally {
    analysisFinished(index);
    evictDecodedSessions(state.sessionIndex);
  }
}

async function measureRecommendations() {
  const token = state.recommendationRun += 1;
  const box = $('recommend');
  const line = $('recommend-status');

  state.recommendations = null;
  state.recommendationCoverage = null;
  line.textContent = '';
  // Clear the answer too, not just the provenance. A re-run that errors, or one
  // the pilot supersedes mid-flight-window drag, must not leave last window's
  // "Start here" sitting over a panel that is being rebuilt.
  $('recommend-answer').innerHTML = '';
  box.innerHTML = '<p class="muted">Working out what this flight can and cannot tell you. ' +
    'On a long log this takes a few seconds.</p>';
  // The before/after is measured over the same window as the advice above it, so
  // a re-run retires the old one rather than leaving it under new numbers.
  forgetCandidateFlight();

  // Let that line paint before the main thread goes away. Measured at 4.2 s on
  // the reference flight in Node and slower in a WebView, almost all of it in
  // the hold sweeps — which are what stop a verdict that flips across
  // measurement windows from being published as a verdict. Worth the wait.
  await yieldToPaint();
  if (token !== state.recommendationRun) {
    return;
  }

  const session = currentSession();
  const scoped = windowedSession();
  const started = performance.now();

  let produced;
  try {
    produced = await collectRecommendationMaterial(scoped, session,
      () => token !== state.recommendationRun);
  } catch (error) {
    if (token !== state.recommendationRun) {
      return;
    }
    // The engine reports every fact about a log as data, so reaching here is a
    // defect in this app. Say that, rather than hiding a broken screen behind a
    // sentence that sounds like a measurement.
    box.innerHTML = `<p class="error">The analysis could not be run: ${esc(error.message)}</p>` +
      `<p class="muted" style="font-size:13px">The measurements further down the page do ` +
      `not depend on it and are still good.</p>`;
    return;
  }

  if (token !== state.recommendationRun) {
    return;
  }

  state.recommendations = produced.result;
  state.recommendationCoverage = produced.coverage;
  // What this helicopter's saved flights have taught, so each adjustment can say
  // whether an amount rests on them or on nothing at all. The key comes from the
  // header directly rather than from the candidate record, because the candidate
  // is built AFTER this paints and an inadmissible flight never produces one —
  // the previous flights of a helicopter are worth quoting even when today's
  // was a bench run.
  state.learning = learningForOpenLog();
  box.innerHTML = recommendationsHtml(produced.result, produced.coverage, state.learning);

  // The before/after rides on this run rather than on its own, because it needs
  // exactly the evidence this run just built. A flight window the pilot drags
  // re-runs both, which is right: the record describes the window it was
  // measured over.
  considerFlight(produced.historyAxes);

  // The answer, before the provenance. `actNow` is at most one finding by the
  // engine's contract, so this says exactly one thing or says plainly that
  // there is no one thing — never a list, which is the state the pilot cannot
  // act on and the reason the rule exists.
  const answer = $('recommend-answer');
  const actNow = produced.result.findings.find(finding => finding.actNow);
  if (actNow) {
    answer.innerHTML = '<span class="lead">Start here</span>' + esc(plainEnglish(actNow));
  } else if (produced.result.findings.length > 0) {
    answer.innerHTML = '<span class="lead">Nothing to change yet</span>' +
      'This flight does not earn a single change. Work down the list below in order.';
  } else {
    answer.innerHTML = '<span class="lead">Nothing measurable</span>' +
      'This flight produced nothing to say — check the Fields panel for what the log carries.';
  }

  // Once per opened log, put that sentence on screen without the pilot hunting
  // for it.
  //
  // NOT `scrollIntoView`. The header is `position: sticky`, and on the S24
  // Ultra it is 112 px tall, so aligning the panel to viewport top 0 put the
  // "What to change" heading completely underneath it and buried the first
  // 59 px of the answer. Measured on the device, not assumed: the panel landed
  // at top 0 with the answer spanning 53–160 px behind a header ending at 112.
  //
  // The header height is read rather than hard-coded, because it grows with the
  // system font scale and a fixed offset would re-bury the answer for anyone
  // running large text — the pilots most likely to need this sentence.
  if (!state.answerScrolled) {
    state.answerScrolled = true;
    const panel = $('recommend-panel');
    const header = document.querySelector('header');
    const clearance = (header ? header.getBoundingClientRect().height : 0) + 12;
    const target = panel.getBoundingClientRect().top + window.scrollY - clearance;
    window.scrollTo({top: Math.max(0, target), behavior: 'smooth'});
  }

  const seconds = ((state.window.endUs - state.window.startUs) / 1e6).toFixed(1);
  line.innerHTML =
    `Measured over the ${esc(seconds)} s flight window below, on ` +
    `${esc(produced.coverage.analysed.join(', ') || 'no axis')}. ` +
    `Took ${Math.round(performance.now() - started)} ms on this device.` +
    (produced.coverage.range.clamped
      ? ' The vibration part covered only the first stretch of it — the window is longer ' +
        'than the spectrum analysis accepts.'
      : '');

  // AFTER the first analysis that produced something, never at first run — see
  // `maybeAskToShare` and design section 4. It goes last in this function on
  // purpose: the advice is on screen behind the dialog, so the question is asked
  // over an answer rather than over an empty page.
  maybeAskToShare();
}

// ---------------------------------------------------------------------------
// Flight history, and the before/after
//
// The owner's ask: an app that learns HIS helicopter rather than judging one
// flight. Open a log from a machine RotorLens has seen before and it should say
// what changed since last time and whether it helped.
//
// Three rules run through everything below, and none of them is this file's
// opinion — each is enforced by `src/analysis/flight-history.mjs`:
//
//   1. NOTHING IS KEPT WITHOUT BEING ASKED. A flight is written when the pilot
//      taps Save. `docs/PRIVACY_POLICY.md` says so, and a store that filled
//      itself would make "you can delete all of it" a smaller promise than it
//      sounds.
//   2. NO IMPROVEMENT IS CLAIMED THAT THE ENGINE CANNOT SEPARATE FROM NOISE.
//      The floor is measured — 0.39 °/s between two flights with nothing
//      changed — and its sentence is printed beside every number.
//   3. "NOTHING MOVED" AND "WE COULD NOT TELL" ARE OPPOSITE ANSWERS, and are
//      never rendered in the same words. Conflating them is the defect this
//      whole design exists to avoid.
//
// Expect silence to be normal. Exactly one pair in 107 real consecutive flight
// pairs would have produced a verdict.
// ---------------------------------------------------------------------------

/**
 * Reads the history back from the host.
 *
 * Exported because a host may attach its bridge after this module has run —
 * MainActivity installs it before the page loads, so in the app this is a
 * start-up call, but nothing about the contract requires that ordering.
 */
export async function loadHistory() {
  const history = await enqueueStorageOperation(async () => {
    const storePresent = hasHistoryStore();
    const text = await readHistoryText();
    const storageReadFailed = storePresent && text === null;
    const imported = importHistory(text ?? '');
    const loaded = imported.history;
    const codes = [...imported.codes];
    if (storageReadFailed) {
      codes.unshift('HISTORY_STORAGE_READ_FAILED');
    }
    const unsafeToReplace = storageReadFailed || codes.some(code =>
      code === 'HISTORY_UNREADABLE'
        || code === 'HISTORY_KIND_MISMATCH'
        || code === 'HISTORY_SCHEMA_VERSION_MISMATCH'
        || code === 'HISTORY_RECORDS_DISCARDED');
    state.history = loaded;
    historyRevision += 1;
    state.historyCodes = codes;
    state.historyStorePresent = storePresent;
    state.historyReadBlocked = unsafeToReplace;
    state.historyWritable = storePresent && !unsafeToReplace;
    state.historyWriteFailed = false;
    // The sharing preference is read in the same queued operation, because the
    // panel that shows it is keyed off this history and a preference arriving
    // one paint later would put "sharing is off" on screen in front of a pilot
    // who turned it on.
    await loadSharing();
    return loaded;
  });
  await reconcileSharingIds();
  renderHistoryPanel();
  renderSharingPanel();
  return history;
}

/**
 * Writes a new history through the host, and adopts it only if that worked.
 *
 * `exportHistory` is the only serialiser, deliberately: it rebuilds every record
 * from the documented field list rather than stringifying what it was handed, so
 * a field pushed into a record in memory has no path to the file. Never
 * `JSON.stringify(history)` here — that bypasses the one structural guarantee
 * the privacy policy rests on.
 */
function persistHistory(history, {forget = false} = {}) {
  const expectedRevision = historyRevision;
  return enqueueStorageOperation(async () => {
    // This change was calculated from an older in-memory history. Dropping it is
    // safer than writing it after a newer operation and bringing deleted data
    // back. The initiating handler will repaint from the state that won.
    if (expectedRevision !== historyRevision) {
      return false;
    }
    if (!state.historyWritable) {
      if (state.historyStorePresent) {
        if (forget) {
          state.historyForgetFailed = true;
        } else {
          state.historyWriteFailed = true;
        }
      }
      return false;
    }
    const written = await writeHistoryText(exportHistory(history));
    if (forget) {
      state.historyForgetFailed = !written;
    } else {
      state.historyWriteFailed = !written;
    }
    if (written) {
      state.history = history;
      historyRevision += 1;
      state.historyForgetFailed = false;
      state.historyWriteFailed = false;
    }
    return written;
  });
}

/**
 * The session as the history engine wants it: header strings, not samples.
 *
 * `decodeLog` reports a session; `readSessionHeaders` kept the header block that
 * produced it. Both are needed — the craft name is on the decoded session, the
 * PID lines are only in the headers.
 */
function historySessionInput() {
  const session = currentSession();
  const parsed = state.sessionHeaders?.[state.sessionIndex] ?? null;

  return {
    sourceSession: session,
    craftName: session.craftName ?? parsed?.craftName ?? null,
    board: parsed?.board ?? session.firmware?.board ?? null,
    headers: parsed?.headers ?? {},
    firmware: {revision: session.firmware?.revision ?? null}
  };
}

/**
 * What the saved flights of the helicopter in THIS log have taught, or null.
 *
 * Keyed off the header rather than off the candidate record: the candidate is
 * built after the advice paints, and an inadmissible flight — a bench run, or a
 * window the pilot dragged — never produces one at all. The previous flights of
 * that helicopter are worth quoting either way.
 */
export function learningForOpenLog() {
  // A partial history is useful for inspection only. Fitting a model from the
  // records that happened to survive import would give the missing records a
  // silent vote, and can make an unsafe amount look better supported than it
  // is. Keep every derived tuning path closed until the complete file is read.
  if (state.result === null || state.historyReadBlocked) {
    return null;
  }
  const identity = deriveAircraftIdentity(historySessionInput());
  if (!identity.keyable) {
    return null;
  }
  return learningFromHistory(
    state.history, identity.key, gainModelFor(state.history, identity.key)
  );
}

/**
 * Re-derives what has been learned, and repaints the advice that quotes it.
 *
 * Called after every deletion. Forgetting a flight has to un-learn what that
 * flight taught, visibly and in the same tap — a card still reading "2 of the 4
 * flights it needs" over a history now holding one of them is the app claiming
 * evidence the pilot has just destroyed.
 *
 * Nothing is unlearned here, because nothing was ever stored: the counts are
 * recomputed from the records that are left, so a deletion cannot leave a
 * fitted number behind in a corner this function forgot about.
 */
function relearnFromHistory() {
  state.learning = learningForOpenLog();
  if (state.recommendations !== null) {
    $('recommend').innerHTML = recommendationsHtml(
      state.recommendations, state.recommendationCoverage ?? {}, state.learning
    );
  }
}

/** Drops everything about the log on screen. Called before another one opens. */
function forgetCandidateFlight() {
  state.candidate = null;
  state.candidateAdmission = null;
  state.candidateStoredId = null;
  state.comparison = null;
  state.comparisonBefore = null;
  $('since').innerHTML = '';
  show('since-panel', false);
}

/**
 * Derives this flight's record and compares it with the last one kept.
 *
 * The record is built and NOT stored. That ordering is what lets the pilot see
 * the answer before deciding whether to keep the flight that produced it, and it
 * is what the privacy policy describes.
 *
 * @param {object} axes per-axis evidence, exactly as `buildFlightRecord` wants it
 */
export function considerFlight(axes) {
  forgetCandidateFlight();

  const session = historySessionInput();
  const window_ = state.window;
  const admission = checkFlightAdmissible({session, window: window_});
  state.candidateAdmission = admission;

  if (admission.admissible) {
    const record = buildFlightRecord({session, window: window_, axes});

    // Belt and braces over a guarantee that already exists. `auditFlightRecord`
    // re-checks the built record against the never-store rules by inspection —
    // no undocumented field, no wall clock, no path, no raw trace — and a record
    // that fails is not offered for saving at all. It has never fired; the point
    // is that if a future change makes it fire, the failure is a refusal to
    // store rather than a timestamp on somebody's disk.
    const audit = auditFlightRecord(record);
    if (audit.ok) {
      state.candidate = record;

      // NOT simply the most recent stored flight. After a save, re-deriving the
      // candidate — which any window change does — would otherwise pick the
      // just-saved copy of THIS flight as its own baseline, render a table whose
      // two columns are identical by construction, and offer Save again.
      // Reproduced on a handset; see `isSameFlight`.
      if (!state.historyReadBlocked) {
        const {baseline, storedAs} = selectBaseline(state.history, record);
        const before = baseline;
        state.candidateStoredId = storedAs;
        state.comparisonBefore = before;
        // The candidate's ordinal is null until it is saved, and
        // `compareFlightRecords` reads a null ordinal as "not yet placed" rather
        // than as out of order — so an unsaved flight compares as the later one.
        state.comparison = before === null ? null : compareFlightRecords(before, record);
      }
    }
  }

  renderSincePanel();
}

/** Keeps the flight on screen. The only thing in this app that writes anything. */
async function rememberCandidateFlight() {
  if (state.historyReadBlocked
      || state.candidate === null || state.candidateStoredId !== null) {
    return;
  }

  const next = addFlightRecord(state.history, state.candidate);
  if (!await persistHistory(next)) {
    renderSincePanel();
    return;
  }

  const kept = findRecords(next, state.candidate.aircraftKey);
  state.candidateStoredId = kept.length > 0 ? kept[kept.length - 1].recordId : null;
  renderSincePanel();
  renderHistoryPanel();
  // The first flight of a helicopter is what gives it an identity and a count on
  // the sharing screen. Repainting there in the same tap is what stops that
  // screen describing a history one save behind the one on the page.
  await reconcileSharingIds();
  renderSharingPanel();
  // A saved flight can complete a before/after pair, which is the only way a
  // count on this screen ever goes up.
  relearnFromHistory();
}

// ---- rendering the before/after -------------------------------------------

const ADMISSION_WORDS = {
  AIRCRAFT_NOT_KEYABLE:
    'this log does not name the helicopter, so RotorLens cannot tell it from any '
    + 'other one. Set a craft name on the flight controller and the next log will '
    + 'be keepable.',
  FLIGHT_NEVER_LEFT_THE_GROUND:
    'nothing here looks like a flight — the rotor never came up to speed, or the '
    + 'machine never lifted off. Nearly three quarters of the sessions in a real '
    + 'dump are bench runs, and a bench run is not something to compare against.',
  FLIGHT_DURATION_UNKNOWN:
    'this log carries no usable time, so there is no flight length to compare.'
};

/**
 * A window the pilot moved is not evidence that the machine flew.
 *
 * `checkFlightAdmissible` accepts only a window RotorLens detected for itself,
 * so dragging either end — or tapping *Whole log* — makes the same flight
 * inadmissible with the same code as a bench run. Handing the pilot the
 * bench-run sentence there is a real number attached to the wrong explanation:
 * they can see the aircraft flew, so the app looks broken rather than careful.
 */
function admissionSentence(code) {
  if (code === 'FLIGHT_NEVER_LEFT_THE_GROUND'
      && state.window?.basis === FlightWindowBasis.CALLER_SUPPLIED) {
    return 'the flight window was set by hand. RotorLens only keeps a flight whose '
      + 'takeoff and landing it found for itself — a window somebody chose is not '
      + 'evidence the machine flew, and a comparison rests on the two windows meaning '
      + 'the same thing. Tap "Use the detected flight" to put it back.';
  }
  return ADMISSION_WORDS[code] ?? code;
}

/**
 * Why a pair could not be compared, in words.
 *
 * Every refusal gets a sentence. A code the pilot cannot read is a blank screen
 * with extra steps, and refusing is the common outcome by design.
 */
const REFUSAL_WORDS = {
  RECORD_KIND_MISMATCH: 'one of these is not a flight record.',
  RECORD_SCHEMA_VERSION_MISMATCH:
    'the two flights were recorded by different versions of RotorLens, which may '
    + 'not have meant the same thing by the same numbers.',
  AIRCRAFT_NOT_KEYABLE: 'one of the flights does not name its helicopter.',
  AIRCRAFT_MISMATCH: 'these are two different helicopters.',
  RECORDS_OUT_OF_ORDER: 'these flights are not in the order they were flown.',
  FIRMWARE_CHANGED:
    'the firmware changed between the two flights. New firmware can move the '
    + 'controller under identical numbers, so anything measured across it would be '
    + 'credited to the wrong cause.',
  RATES_CHANGED:
    'the rate curves changed between the two flights, so the aircraft was not '
    + 'asked to do the same thing twice.',
  GAINS_NOT_COMPARABLE: 'the PID lines in the two logs cannot be lined up with each other.',
  PROFILE_SWITCH_SUSPECTED:
    'a whole set of gains moved at once, which is a PID profile being switched '
    + 'rather than a tune being adjusted.',
  MULTIPLE_GAINS_CHANGED:
    'more than one gain changed, so a movement in the numbers cannot be pinned on '
    + 'either of them. One change at a time is the only way this question has an '
    + 'answer.',
  NO_GAIN_CHANGE: 'nothing in the header changed between the two flights.',
  HOLD_EVIDENCE_INCONCLUSIVE: 'one of the flights carried no usable hold to measure.',
  INSUFFICIENT_HOLD_SEGMENTS_FOR_COMPARISON:
    'too few holds to rest a claim on — one against one cannot support anything.',
  HOLD_KIND_MISMATCH:
    'one flight was holding a heading and the other a constant rate. Those are '
    + 'different tests.',
  HEADSPEED_MISMATCH:
    'the head speed differed between the flights. The same gains at a different '
    + 'head speed are a different controller.',
  HOLD_METRIC_MISSING: 'the metric this comparison is decided on is missing from one flight.',
  CHANGE_BELOW_MEASURED_NOISE_FLOOR: 'the movement is smaller than the flight-to-flight noise floor.',
  NO_GAIN_CHANGE_TO_ATTRIBUTE_IT_TO: 'nothing was adjusted on this axis.',
  STOP_FLOOR_NOT_MEASURED:
    'no flight-to-flight floor has ever been measured for the stop metrics, so '
    + 'their movement is shown and not judged.',
  GAINS_UNREADABLE: 'the PID lines could not be read from one of the logs.',
  GAIN_LINE_SHAPE_CHANGED: 'the PID lines are different lengths in the two logs.'
};

/**
 * The headline for each outcome.
 *
 * `no-detectable-change` and `not-enough-evidence` are deliberately opposite
 * sentences: one means the evidence was good and the movement was too small to
 * be real, the other means there was no measurement to speak of. Rendering them
 * alike would be the exact defect `COMPARISON_OUTCOME` was written to prevent.
 */
const OUTCOME_WORDS = {
  improved: {
    pill: 'good',
    headline: 'That helped.',
    detail: 'The steady-state error fell by more than two flights of this aircraft '
      + 'differ by on their own.'
  },
  worsened: {
    pill: 'bad',
    headline: 'That made it worse.',
    detail: 'The steady-state error rose by more than two flights of this aircraft '
      + 'differ by on their own.'
  },
  'no-detectable-change': {
    pill: 'warn',
    headline: 'The change made no difference RotorLens can see.',
    detail: 'There WAS enough evidence to judge this one, and the measurement moved '
      + 'less than the flight-to-flight noise floor. The change is real on the '
      + 'controller; its effect is too small to pick out of two flights.'
  },
  'not-attributable': {
    pill: 'none',
    headline: 'Something moved, but nothing was changed to move it.',
    detail: 'The measurement shifted while every gain RotorLens stores stayed the '
      + 'same, so it cannot be credited to an adjustment. It is the aircraft, the '
      + 'air, or the pilot.'
  },
  'not-enough-evidence': {
    pill: 'none',
    headline: 'Not enough to compare these two flights.',
    detail: 'RotorLens could not measure the same thing well enough on both flights. '
      + 'This is not a finding of "no change" — it is no measurement at all.'
  }
};

function gainChangeSentence(changes) {
  return changes
    .map(change => `${AXIS_ORDER.includes(change.axis) ? change.axis : 'axis'} `
      + `${change.term} went ${text(change.from)} to ${text(change.to)}`)
    .join(', ');
}

/** One row of the "what moved" table, with the floor verdict attached. */
function movedRow(label, before, after, verdict) {
  return `<tr><td>${esc(label)}</td><td class="num">${text(before)}</td>`
    + `<td class="num">${text(after)}</td><td>${verdict}</td></tr>`;
}

/**
 * The hold measurement for one axis, if there is one.
 *
 * `measured` is null whenever the axis was refused, and a refused axis prints its
 * reason rather than an empty row — "no numbers" and "numbers of zero" must not
 * look alike.
 */
function holdMovementHtml(axis, hold) {
  if (hold.measured === null) {
    return `<p class="muted" style="font-size:12.5px">${esc(axis)}: `
      + `${esc(hold.codes.map(code => REFUSAL_WORDS[code] ?? code).join(' '))}</p>`;
  }

  const {before, after, differenceDps, clearsAbsoluteFloor, clearsRelativeFloor} = hold.measured;
  const clears = clearsAbsoluteFloor && clearsRelativeFloor;
  const verdict = clears
    ? pill('good', 'above the floor')
    : pill('none', 'inside the noise');

  return '<div class="scroll"><table class="moved">'
    + `<tr><th>${esc(axis)}</th><th class="num">before</th><th class="num">after</th><th></th></tr>`
    + movedRow('steady-state error °/s', before, after, verdict)
    + `<tr><td class="muted" colspan="4" style="font-size:12px">moved `
    + `${esc(text(differenceDps))} °/s over ${hold.measured.holdCounts.before} holds then `
    + `${hold.measured.holdCounts.after}</td></tr>`
    + '</table></div>';
}

/**
 * Post-release ringing, from the two records themselves.
 *
 * Shown because it is what a pilot feels after a stop, and reported WITHOUT a
 * verdict because no flight-to-flight floor has ever been measured for it: roll
 * and pitch produced zero stop events across 110 real flights and yaw never
 * reached the minimum per direction. A direction read off an unmeasured floor is
 * the mistake the hold comparison was already caught making once.
 */
function ringingHtml(axis, before, after) {
  const rows = [];
  for (const direction of ['positive', 'negative']) {
    const from = before?.axes?.[axis]?.stop?.[direction]?.fastRingingRmsDps;
    const to = after?.axes?.[axis]?.stop?.[direction]?.fastRingingRmsDps;
    if (from === null || from === undefined || to === null || to === undefined) {
      continue;
    }
    rows.push(movedRow(
      `ringing after a ${directionWord(axis, direction)} stop °/s`,
      from, to, pill('none', 'no floor measured')
    ));
  }

  if (rows.length === 0) {
    return '';
  }

  return '<div class="scroll"><table class="moved">'
    + `<tr><th>${esc(axis)} stops</th><th class="num">before</th><th class="num">after</th><th></th></tr>`
    + rows.join('')
    + '</table></div>'
    + `<p class="muted" style="font-size:12px">${esc(REFUSAL_WORDS.STOP_FLOOR_NOT_MEASURED)}</p>`;
}

/**
 * The whole before/after, as HTML.
 *
 * Exported so the renderer can be driven directly against comparisons the engine
 * produced, including the ones a synthetic fixture cannot reach.
 */
export function comparisonHtml(comparison, before, after) {
  const parts = [];
  const words = OUTCOME_WORDS[comparison.outcome] ?? OUTCOME_WORDS['not-enough-evidence'];

  parts.push(`<div class="gate-row">${pill(words.pill, words.headline)}</div>`);

  if (comparison.gainChanges.length > 0) {
    parts.push(`<p class="headline">Since your last flight, `
      + `${esc(gainChangeSentence(comparison.gainChanges))}.</p>`);
  } else if (comparison.comparable) {
    parts.push('<p class="headline">Nothing in the header changed between these two flights.</p>');
  }

  parts.push(`<p>${esc(words.detail)}</p>`);

  if (!comparison.comparable) {
    parts.push('<p class="label">Why not</p><ul class="reasons">'
      + comparison.codes.map(code => `<li>${esc(REFUSAL_WORDS[code] ?? code)}</li>`).join('')
      + '</ul>');
  } else {
    for (const axis of AXIS_ORDER) {
      const entry = comparison.axes[axis];
      if (!entry) {
        continue;
      }
      // The axis the gain moved on is the one the headline is about; the others
      // are shown because "nothing was changed here and it moved anyway" is the
      // pilot's own noise floor, measured on their own aircraft.
      if (axis === comparison.changedAxis || entry.hold.measured !== null) {
        parts.push(holdMovementHtml(axis, entry.hold));
      }
      parts.push(ringingHtml(axis, before, after));
    }
  }

  // ALWAYS. The pilot has to be able to see that a 0.03 °/s move is weather, and
  // the sentence carries the same number as the gate that used it.
  parts.push(`<p class="floor">${esc(comparison.noiseFloor.sentence)}</p>`);

  return parts.join('');
}

function saveControlHtml() {
  if (!state.historyWritable) {
    if (state.historyStorePresent) {
      return '<p class="error" style="font-size:12.5px">The existing history could not be '
        + 'read safely, so Save is disabled to protect it. Restart the app and try again, or '
        + 'use Forget everything to erase it explicitly.</p>';
    }
    return '<p class="muted" style="font-size:12.5px">This viewer has nowhere to keep a '
      + 'flight history. The RotorLens app keeps one in its own private storage; a browser '
      + 'tab does not, so nothing here is stored.</p>';
  }
  if (state.historyWriteFailed) {
    return '<p class="error">RotorLens could not write to its history file, so this flight '
      + 'was not kept.</p>';
  }
  if (state.candidateStoredId !== null) {
    return '<div class="controls">'
      + `<button type="button" data-forget-flight="${esc(state.candidateStoredId)}">`
      + 'Forget this flight</button>'
      + '<span class="muted" style="font-size:12.5px">Kept on this device.</span></div>';
  }
  // 4.4 kB, not the 2.5 kB this said. Measured on the handset by reading the
  // stored file before and after a save: 4,574 bytes for the first flight and
  // 8,987 for the second, so 4,413 each. 2,539 is the record COMPACT; the
  // export writes indented text, which is what actually lands on disk — the cap
  // arithmetic in flight-history.mjs already implied it (861 KiB / 200 = 4,406)
  // while the sentence beside it quoted the compact figure.
  return '<div class="controls"><button id="since-save" type="button">Save this flight</button>'
    + '<span class="muted" style="font-size:12.5px">About 4.4 kB of numbers. No log, no '
    + 'location, no date.</span></div>';
}

function renderSincePanel() {
  const admission = state.candidateAdmission;
  if (admission === null) {
    show('since-panel', false);
    return;
  }

  const parts = [];

  if (!admission.admissible) {
    parts.push(`<div class="gate-row">${pill('none', 'not kept')}</div>`);
    parts.push('<p>This flight is not one RotorLens can remember, because '
      + esc(admission.codes.map(admissionSentence).join(' Also, '))
      + '</p>');
    parts.push('<p class="muted" style="font-size:12.5px">Nothing was stored, and nothing '
      + 'was lost — the measurements on this page are unaffected.</p>');
  } else if (state.candidate === null) {
    // The audit refused it. Say so plainly rather than showing an empty panel.
    parts.push('<p class="error">RotorLens built a summary of this flight that failed its own '
      + 'privacy check, so it was discarded rather than stored.</p>');
  } else if (state.historyReadBlocked) {
    parts.push(`<div class="gate-row">${pill('none', 'history unavailable')}</div>`);
    parts.push('<p>RotorLens can show the readable saved records, but it cannot safely use '
      + 'a partial history for learned tuning or a before/after comparison.</p>');
    parts.push(saveControlHtml());
  } else if (state.comparison === null) {
    parts.push(`<p class="headline">This is the first flight RotorLens has seen from `
      + `${esc(state.candidate.craftName ?? 'this helicopter')}.</p>`);
    parts.push('<p>Save it, change one thing, fly again, and open the next log here. '
      + 'RotorLens will say what moved and whether the movement is bigger than the '
      + 'difference between two flights where nothing changed at all.</p>');
    parts.push(saveControlHtml());
  } else {
    parts.push(comparisonHtml(state.comparison, state.comparisonBefore, state.candidate));
    parts.push(saveControlHtml());
  }

  $('since').innerHTML = parts.join('');
  show('since-panel');
}

// ---------------------------------------------------------------------------
// What RotorLens has learned about one helicopter
//
// The ask was for an app that learns, so that it gets more accurate over time.
// The learning itself lives in `buildSensitivityModel` in flight-history.mjs;
// everything here is the screen it is read off, and the screen has one job that
// the model cannot do for itself — let a pilot DISAGREE with it. On a machine
// with blades that is a safety feature, so the rules below are about legibility
// rather than arithmetic.
//
//  1. THE MODEL IS DERIVED, AND SO IS THIS. Nothing is stored: the model is
//     rebuilt from the records listed in the same panel, every time the panel
//     is drawn. That is what makes "forget this flight" un-learn what it
//     taught, with no second deletion path to get wrong, and it is why the
//     never-store list and the 4.4 kB-a-flight arithmetic in
//     flight-history.mjs stay true with this on screen.
//
//  2. THIS FILE DECIDES NOTHING. Every count, every state, every "what it would
//     take next" sentence and every amount is the model's own. A viewer that
//     re-derived any of them would put two numbers for one fact on one screen,
//     and the pilot would have no way to tell which was the app's opinion.
//
//  3. "NOT YET" AND "NEVER" ARE DIFFERENT CELLS. The model distinguishes
//     `collecting` — more flying would help — from `underpowered`, where the
//     experiment as flown cannot resolve an effect however long it is repeated,
//     and from `contradictory`, where the flights disagree by more than the
//     pilot's own unchanged flights ever do. Rendering those alike is how
//     patience comes to look like progress, so each gets its own word.
//
// WITH NO MODEL EXPORTED THIS PANEL DOES NOT EXIST, and the app is byte for
// byte what it was: an adjustment says which way and refuses to say how far.
// That is the correct degradation, and it is what most pilots will see forever.
// ---------------------------------------------------------------------------

const LEARNING_TERMS = Object.freeze(['P', 'I', 'D']);

/**
 * The model's own vocabulary, read through the namespace rather than imported.
 *
 * Same reason as the namespace import itself: a named import of an export that
 * is not there kills the whole page, and this panel is not worth the viewer.
 */
const SENSITIVITY = flightHistoryModule.SENSITIVITY_STATE ?? {};

/** Flights before a line through them may be attempted at all. */
const POINTS_FOR_A_FIT = Number.isInteger(
  flightHistoryModule.SENSITIVITY_LIMITS?.minimumPointsForFit
) ? flightHistoryModule.SENSITIVITY_LIMITS.minimumPointsForFit : 6;

/**
 * The per-aircraft model, or null — and never at the cost of the panel around it.
 *
 * A model that throws must not take the Forget buttons down with it. Deletion is
 * the reason keeping anything at all is defensible, so it outranks every other
 * thing on this panel, including the feature this function exists for.
 */
function gainModelFor(history, aircraftKey) {
  const build = flightHistoryModule.buildSensitivityModel;
  if (typeof build !== 'function' || aircraftKey === null) {
    return null;
  }
  try {
    return build(history, aircraftKey) ?? null;
  } catch {
    return null;
  }
}

/**
 * What one cell says, and why.
 *
 * The count is always the model's admitted flights for that gain. The word
 * beside it is the state, in one or two words, because the difference between
 * "keep flying" and "flying more will not help" is the single most useful thing
 * this grid can carry and a bare number cannot carry it.
 */
function learningCell(entry) {
  if (entry === null) {
    return {kind: 'none', count: '—', unit: 'no model'};
  }
  const count = entry.pointCount;

  if (entry.magnitude !== null) {
    return {kind: 'believed', count, unit: 'measured'};
  }
  switch (entry.state) {
    case SENSITIVITY.USABLE:
      return {kind: 'believed', count, unit: 'a direction'};
    case SENSITIVITY.CONTRADICTORY:
      return {kind: 'warn', count, unit: 'disagree'};
    case SENSITIVITY.UNDERPOWERED:
      // "Never", not "not yet" — and the two must not look alike.
      return {
        kind: 'warn',
        count: entry.codes.includes('RESPONSE_METRIC_NOT_SENSITIVE_TO_TERM') ? '—' : count,
        unit: entry.codes.includes('RESPONSE_METRIC_NOT_SENSITIVE_TO_TERM')
          ? 'not measurable' : 'too close'
      };
    case SENSITIVITY.STALE:
      return {kind: 'warn', count, unit: 'old setup'};
    default:
      return count >= POINTS_FOR_A_FIT
        ? {kind: 'some', count, unit: 'flights'}
        : {kind: count > 0 ? 'some' : 'none', count, unit: `of ${POINTS_FOR_A_FIT}`};
  }
}

/**
 * Why a flight is not in a fit, in the fit's own terms.
 *
 * Checked BEFORE `REFUSAL_WORDS`, because three of these codes are shared with
 * the paired comparison and mean something slightly different here: a point
 * needs two holds where a pair needs five, so the paired sentence about "one
 * against one" would be a real reason attached to the wrong gate.
 */
const EXCLUSION_WORDS = Object.freeze({
  INSUFFICIENT_HOLD_SEGMENTS_FOR_COMPARISON:
    'too few deliberate holds in that flight for it to count as one point.',
  HOLD_EVIDENCE_INCONCLUSIVE: 'no usable hold measurement on that axis in that flight.',
  RESPONSE_METRIC_NOT_POSITIVE:
    'the hold measurement from that flight is not a number a line can be fitted through.',
  MECHANICAL_NOISE_CHANGED:
    'the airframe was shaking harder on that flight than on the others, so a gain result '
    + 'from it would be a vibration result wearing a gain\'s name.',
  HEADSPEED_MISMATCH:
    'flown at a different head speed. The same gains at a different head speed are a '
    + 'different controller, so those flights are kept in their own group rather than pooled.'
});

/**
 * The model, flattened into what the panel draws.
 *
 * Pure, and exported so the browser test can drive states no stored history in
 * this repository reaches. `model` is whatever `buildSensitivityModel` returned,
 * or null.
 */
export function learningFromHistory(history, aircraftKey, model = null) {
  const records = aircraftKey === null ? [] : findRecords(history, aircraftKey);
  const modelTerms = Array.isArray(model?.terms) ? model.terms : [];

  const terms = [];
  for (const axis of AXIS_ORDER) {
    for (const term of LEARNING_TERMS) {
      const found = modelTerms.find(
        entry => entry?.axis === axis && entry?.term === term
      ) ?? null;
      const entry = found === null ? null : Object.freeze({
        axis,
        term,
        gain: `${axis} ${term}`,
        state: found.state ?? null,
        pointCount: Number.isInteger(found.pointCount) ? found.pointCount : 0,
        distinctGainLevels: Number.isInteger(found.distinctGainLevels)
          ? found.distinctGainLevels : 0,
        // A magnitude is the model's own, sentence and all. This file never
        // composes one: prose written around numbers whose units are being
        // guessed at is exactly the failure the whole design is avoiding.
        magnitude: typeof found.magnitude?.sentence === 'string' ? found.magnitude : null,
        needs: typeof found.needs?.sentence === 'string' ? found.needs.sentence : null,
        points: Array.isArray(found.points) ? found.points : [],
        exclusions: found.exclusions ?? {},
        codes: Array.isArray(found.codes) ? found.codes : []
      });
      terms.push(entry === null
        ? Object.freeze({
          axis, term, gain: `${axis} ${term}`, state: null, pointCount: 0,
          distinctGainLevels: 0, magnitude: null, needs: null, points: [],
          exclusions: {}, codes: []
        })
        : entry);
    }
  }

  const believed = terms.filter(entry => entry.magnitude !== null);

  // The gain worth flying for next: the one closest to a line that could be
  // believed. A term the model has ruled out entirely is never the answer,
  // because asking for a flight that provably cannot help is worse than asking
  // for nothing.
  const collecting = terms.filter(entry => entry.state === SENSITIVITY.COLLECTING
    || entry.state === SENSITIVITY.NO_EVIDENCE);
  const nextUp = (collecting.length > 0 ? collecting : terms).reduce(
    (best, entry) => (entry.pointCount > best.pointCount ? entry : best),
    (collecting.length > 0 ? collecting : terms)[0]
  );

  return Object.freeze({
    aircraftKey,
    hasModel: model !== null && modelTerms.length > 0,
    flights: records.length,
    terms: Object.freeze(terms),
    believed: Object.freeze(believed),
    floors: model?.floors ?? null,
    nextUp
  });
}

/** One gain's entry, or null. Used by the recommendation cards. */
function learningTerm(learning, axis, term) {
  return learning?.terms?.find(entry => entry.axis === axis && entry.term === term) ?? null;
}

/**
 * What this helicopter's own unchanged flights say about its own noise.
 *
 * The first thing the app can honestly learn, and the cheapest: it needs flights
 * where NOTHING was changed, which is most of them, rather than deliberate
 * experiments, which are almost none. It is also the number every other result
 * has to beat, so it belongs on screen whether or not anything else is known.
 */
function learningFloorHtml(floors) {
  if (floors === null) {
    return '';
  }
  const own = AXIS_ORDER
    .map(axis => floors[axis])
    .filter(floor => floor?.source === 'own-aircraft');
  if (own.length === 0) {
    return '<p class="learn-key">RotorLens is still using a flight-to-flight noise figure '
      + 'measured on other people\'s helicopters. Flights where you changed nothing are what '
      + 'replace it with yours — those are not wasted flights, they are the ones that set the '
      + 'bar every result has to clear.</p>';
  }
  return '<p class="learn-key">Measured on your own flights where nothing was changed: '
    + own.map(floor => `${esc(floor.axis)} wanders by up to ${text(floor.appliedDps)}°/s `
      + `between two such flights (${floor.nullPairCount} pair`
      + `${floor.nullPairCount === 1 ? '' : 's'})`).join('; ')
    + '. That is the bar a real result has to clear.</p>';
}

function learningHeadline(learning) {
  if (learning.flights === 1) {
    return 'One flight saved, and nothing to compare it against. Learning starts at the '
      + 'second one.';
  }
  const measured = learning.believed.length;
  const carrying = learning.terms.filter(entry => entry.pointCount > 0).length;
  return `${learning.flights} flights saved. `
    + (carrying === 0
      ? 'None of them yet sits in a group RotorLens can learn a gain from — that needs one '
        + 'gain moved on its own, the same head speed, and deliberate holds either side.'
      : `${carrying} of the nine gains have flights behind them. `)
    + (measured === 0
      ? 'Nothing has earned a number, and nothing will be given one until it does.'
      : `${measured} ${measured === 1 ? 'has' : 'have'} earned a measured amount, below.`);
}

/**
 * The panel. Compact on purpose.
 *
 * The advice above it already runs to several thousand pixels on a phone, so
 * what is visible without a tap is four short things: a sentence, a nine-cell
 * grid, the one flight that would help most, and anything actually believed.
 * Every individual measurement is one disclosure down.
 */
export function learningHtml(learning) {
  if (learning === null || learning.flights === 0 || !learning.hasModel) {
    return '';
  }

  const parts = ['<div class="learn">'];
  parts.push('<p class="learn-head">What RotorLens has learned about this helicopter</p>');
  parts.push(`<p class="learn-sum">${esc(learningHeadline(learning))}</p>`);

  parts.push('<table class="learn-grid"><tbody><tr><th scope="col"></th>'
    + LEARNING_TERMS.map(term => `<th scope="col">${esc(term)}</th>`).join('')
    + '</tr>'
    + AXIS_ORDER.map(axis => `<tr><th scope="row">${esc(axis)}</th>`
      + LEARNING_TERMS.map(term => {
        const entry = learningTerm(learning, axis, term);
        const cell = learningCell(entry);
        // The space between the two spans is load-bearing: it is what makes the
        // cell read "2 of 6" to a screen reader and to anything else that takes
        // the text rather than the layout.
        return `<td class="${cell.kind}" data-gain="${esc(entry.gain)}">`
          + `<span class="have">${esc(cell.count)}</span> `
          + `<span class="want">${esc(cell.unit)}</span></td>`;
      }).join('') + '</tr>').join('')
    + '</tbody></table>');

  parts.push('<p class="learn-key">Each cell counts the flights RotorLens can actually use '
    + `for that gain, out of the ${POINTS_FOR_A_FIT} a line through them needs before it is `
    + 'worth attempting. It is not a progress bar: nine cells at zero is the normal state for '
    + 'a long time, and <b>not measurable</b> means more flying cannot help.</p>');

  for (const entry of learning.believed) {
    parts.push(`<p class="learn-belief">${pill('good', 'measured on your helicopter')}`
      + `<span>${esc(entry.magnitude.sentence)}</span>`
      + `<span class="muted">${esc(entry.gain)}, from ${entry.pointCount} of your own `
      + 'flights. Forget one of them and this changes.</span></p>');
  }

  if (learning.nextUp?.needs) {
    parts.push('<p class="learn-next"><span class="label">What would teach it next</span>'
      + `${esc(learning.nextUp.needs)}</p>`);
  }

  parts.push(learningFloorHtml(learning.floors));

  // Two decimals, always, even on a whole number. A column reading
  // "6.60, 6, 5.40, 1" invites the eye to read the bare integers as counts;
  // "6.60, 6.00, 5.40, 1.00" is the same list and reads as one measurement.
  const dps = value => (Number.isFinite(value) ? value.toFixed(2) : '—');

  const detail = [];
  for (const entry of learning.terms) {
    const used = entry.points.filter(point => point.admitted);
    if (used.length === 0) {
      continue;
    }
    detail.push(`<p class="label">${esc(entry.gain)}</p><ul class="reasons">`
      + used.map(point =>
        `<li>flight ${(point.ordinal ?? 0) + 1}: ${esc(point.gain)} &rarr; `
        + `${dps(point.metricDps)}°/s over ${esc(point.holdCount)} holds`
        + '</li>').join('')
      + '</ul>'
      // The ask is printed above the disclosure for whichever gain is furthest
      // along, so repeating it word for word would be the same sentence twice.
      + (entry === learning.nextUp || entry.needs === null
        ? ''
        : `<p class="muted" style="font-size:12.5px">${esc(entry.needs)}</p>`));

    const dropped = Object.entries(entry.exclusions)
      .filter(([code, count]) => code !== 'admitted' && count > 0);
    if (dropped.length > 0) {
      detail.push('<ul class="reasons">' + dropped.map(([code, count]) =>
        `<li>${count} flight${count === 1 ? '' : 's'} not used &mdash; `
        + `${esc(EXCLUSION_WORDS[code] ?? REFUSAL_WORDS[code] ?? code)}</li>`
      ).join('') + '</ul>');
    }
  }

  if (detail.length > 0) {
    parts.push('<details class="help"><summary>Every flight behind this, and every flight '
      + 'left out</summary><div>' + detail.join('') + '</div></details>');
  }

  parts.push('</div>');
  return parts.join('');
}


// ---- rendering the history itself -----------------------------------------

function gainSummary(record) {
  return AXIS_ORDER
    .map(axis => {
      const line = record.gains?.[axis];
      return Array.isArray(line) ? `${axis} ${line.slice(0, 3).join('/')}` : `${axis} —`;
    })
    .join(' · ');
}

/**
 * Every stored flight, in full.
 *
 * In full is the point: the policy promises "the history screen shows every
 * stored flight", and a history the pilot cannot see all of is one they cannot
 * check. The per-aircraft cap of 200 is what keeps that renderable.
 */
export function historyHtml(history, forgetFailed = false, readBlocked = false) {
  // A failed erase is reported before anything else, and the in-memory history
  // is NOT emptied when it happens — so this renders the flights that are still
  // there, under a warning, rather than an empty list that would be a lie.
  const warning = forgetFailed
    ? '<p class="error">RotorLens could not erase its history file, so these flights are '
      + 'still on this device. Try again; if it keeps failing, deleting RotorLens or clearing '
      + 'its app storage where the operating system offers that control will remove them.</p>'
    : '';

  const aircraft = listAircraft(history);
  if (aircraft.length === 0) {
    if (readBlocked) {
      return warning
        + '<p class="muted">Stored flights cannot be listed because the history could not be '
        + 'read safely.</p>';
    }
    return warning
      + '<p class="muted">No flights are stored. Save one to start a flight history.</p>';
  }

  return warning + historyListHtml(aircraft, history, readBlocked);
}

function historyListHtml(aircraft, history, readBlocked = false) {
  const disabled = readBlocked
    ? ' disabled aria-disabled="true" title="Unavailable until the stored history can be read"'
    : '';

  return aircraft.map(entry => {
    const flights = [...findRecords(history, entry.aircraftKey)].reverse();
    const rows = flights.map(record => {
      const duration = record.durationSeconds === null
        ? '—'
        : `${record.durationSeconds.toFixed(0)} s`;
      return '<div class="flight">'
        + `<span class="ord">#${record.ordinal + 1}</span>`
        + `<span>${esc(duration)}</span>`
        + `<span class="meta">${esc(record.firmwareRevision ?? 'firmware unknown')} · `
        + `${esc(gainSummary(record))}</span>`
        + `<button type="button" data-forget-flight="${esc(record.recordId)}" `
        + `aria-label="Forget flight ${record.ordinal + 1} for `
        + `${esc(entry.craftName ?? 'unnamed helicopter')}"${disabled}>Forget</button>`
        + '</div>';
    }).join('');

    // What this helicopter's flights add up to, above the flights themselves.
    // Here rather than in a panel of its own for two reasons: it is per
    // aircraft, which nothing else on the page is, and it sits directly above
    // the Forget buttons — so deleting a flight and watching the counts fall is
    // one glance rather than two panels apart.
    const learned = readBlocked
      ? '<p class="muted" style="font-size:12.5px">Learning and before/after comparison '
        + 'are unavailable until the complete stored history can be read.</p>'
      : learningHtml(learningFromHistory(
        history, entry.aircraftKey, gainModelFor(history, entry.aircraftKey)
      ));

    return '<div class="aircraft"><div class="aircraft-head">'
      + `<span class="name">${esc(entry.craftName ?? 'unnamed')}</span>`
      + `<span class="where">${esc(entry.board ?? 'board unknown')} · `
      + `${entry.flightCount} flight${entry.flightCount === 1 ? '' : 's'}</span>`
      + `<button type="button" data-forget-aircraft="${esc(entry.aircraftKey)}" `
      + `aria-label="Forget every flight for `
      + `${esc(entry.craftName ?? 'unnamed helicopter')}"${disabled}>`
      + 'Forget this helicopter</button>'
      + `</div>${learned}${rows}</div>`;
  }).join('');
}

const HISTORY_LOAD_WORDS = {
  HISTORY_RATE_FINGERPRINTS_INVALIDATED: 'Older saved flights were kept, but their rate-curve '
    + 'fingerprints did not include expo. They will not be used for before/after comparisons.',
  HISTORY_STORAGE_READ_FAILED: 'The history file exists but RotorLens could not read it. Saving '
    + 'is disabled so the existing file cannot be overwritten. Use Forget everything to erase '
    + 'it explicitly, or restart the app and try again.',
  HISTORY_UNREADABLE: 'The stored history could not be read and was ignored. Nothing was '
    + 'overwritten; saving is disabled until you explicitly forget it.',
  HISTORY_KIND_MISMATCH: 'The stored file is not a RotorLens flight history. Saving is disabled '
    + 'until you explicitly forget it.',
  HISTORY_SCHEMA_VERSION_MISMATCH: 'The stored history was written by a different version of '
    + 'RotorLens and was not read or overwritten.',
  HISTORY_RECORDS_DISCARDED: 'Some stored flights were unreadable and were not loaded. Saving '
    + 'is disabled so the original file is not replaced by the partial view.'
};

function renderHistoryPanel() {
  const history = state.history ?? createHistory();

  // Hidden in a browser with nothing in it: an empty panel that can never fill
  // is noise. It appears the moment there is either a store to write to or
  // something already stored — which on the phone is always.
  if (!state.historyStorePresent && history.records.length === 0
      && state.historyCodes.length === 0) {
    show('history-panel', false);
    return;
  }

  const notes = state.historyCodes
    .filter(code => code in HISTORY_LOAD_WORDS)
    .map(code => HISTORY_LOAD_WORDS[code]);

  const countSummary = state.historyReadBlocked
    ? (history.records.length > 0
      ? `${history.records.length} readable flight${history.records.length === 1 ? '' : 's'} `
        + 'shown; the total stored count is unavailable. '
      : 'Stored flight count unavailable. ')
    : `${history.records.length} flight${history.records.length === 1 ? '' : 's'} stored, `
      + `at most ${HISTORY_LIMITS.maximumRecordsPerAircraft} per helicopter. `;

  $('history-summary').innerHTML = countSummary
    + 'Kept in this app\'s own private storage on this device. No log, no location, no date '
    + 'and no file name is in it.'
    + notes.map(note => `<p class="error" style="font-size:12.5px">${esc(note)}</p>`).join('');

  $('history').innerHTML = historyHtml(
    history, state.historyForgetFailed, state.historyReadBlocked
  );
  const exported = $('history-export-text');
  const exportButton = $('history-export');
  exportButton.disabled = state.historyReadBlocked;
  exportButton.setAttribute('aria-disabled', String(state.historyReadBlocked));
  if (state.historyReadBlocked) {
    exported.textContent = '';
    show('history-export-text', false);
    exportButton.textContent = 'Export unavailable';
  } else if (!exported.classList.contains('hidden')) {
    exported.textContent = exportHistory(history);
    exportButton.textContent = 'Hide export';
  } else {
    exportButton.textContent = 'Export';
  }
  show('history-panel');
}

/**
 * Empties the store completely, file included — and says so only if it worked.
 *
 * This discarded the result of `forgetHistoryFile()` and rendered an empty
 * history unconditionally, so a failed unlink left the panel reading "No flights
 * are stored" over a file that still held every one of them. That is the worst
 * shape a privacy control can take: it does not merely fail, it reports success,
 * and the person who most wanted the data gone is the one told it is gone.
 *
 * `persistHistory` already refuses to adopt a history it could not write. This
 * is the same rule on the way out.
 */
async function forgetEverythingNow() {
  await enqueueStorageOperation(async () => {
    const forgotten = await forgetHistoryFile();
    // Its own flag, not historyWriteFailed: that one says "this flight was not
    // kept", which is the opposite of what went wrong here.
    state.historyForgetFailed = !forgotten;
    if (forgotten) {
      state.history = forgetEverything();
      historyRevision += 1;
      state.historyCodes = [];
      state.historyReadBlocked = false;
      state.historyWritable = state.historyStorePresent;
      state.candidateStoredId = null;
    }

    // "Forget everything" means both stores. Each awaited native reply reports
    // only its own file so one failed unlink cannot obscure a successful one;
    // asking for sharing separately also keeps the fallback contract truthful.
    const sharingForgotten = await forgetSharingFile();
    state.sharingForgetFailed = state.sharingStorePresent && !sharingForgotten;
    if (sharingForgotten || !state.sharingStorePresent) {
      state.sharing = createSharing();
      sharingRevision += 1;
      state.sharingCodes = [];
      state.sharingShown = null;
      if (sharingForgotten) {
        state.sharingReadBlocked = false;
        state.sharingWritable = state.sharingStorePresent;
      }
    }
  });

  renderHistoryPanel();
  renderSincePanel();
  renderSharingPanel();
  relearnFromHistory();
}

// ---------------------------------------------------------------------------
// Shared measurements: a choice, an identity, and NOTHING THAT SENDS
//
// ## Read this before changing anything below
//
// NOTHING IN THIS APP SENDS ANYTHING ANYWHERE, and nothing below is a step
// towards doing so quietly. There is no fetch, no request, no endpoint and no
// URL in this section. Android also omits the INTERNET permission;
// `docs/STORE_LISTING.md` and the legal screen distinguish that OS gate from
// the cross-platform no-upload implementation; and test/provenance.test.mjs,
// test/privacy-claims.test.mjs and test/legal-disclaimer.test.mjs pin the
// Android statement to the manifest.
//
// What is here is the SHAPE of a decision: what the pilot is asked, what an
// opaque identity looks like, what one shared record would contain, and how it
// is all erased. `docs/SHARED_CORPUS_DESIGN.md` is the agreement and section 9
// lists what would still have to be built — item 4 is the transport, and it is
// deliberately not this.
//
// ## Why build the consent before the transport
//
// The owner's reasoning, and it is right: retrofitting network access onto an
// installed base is worse than shipping with it. A pilot who installed an app
// that could not reach the internet did not agree to one that can, however good
// the dialog is when it finally appears. So the choice, the identity and the
// deletion path ship first and are proved by hand; adding the transport is a
// separate, deliberate commit that also rewrites the store listing, the privacy
// policy and the three tests above, all together — see design section 7.
//
// ## The one thing this screen must not do
//
// It must not imply that anything is going anywhere. A toggle that says "Share
// measurements" and does nothing is a toggle that lies, and this app's whole
// claim rests on its statements about itself being checkable. Every state of
// this panel therefore says, in the plainest words available, that nothing has
// been sent and that this version cannot send.
// ---------------------------------------------------------------------------

const SHARING_KIND = 'rotorlens-sharing-preference';
const SHARING_SCHEMA_VERSION = 1;

/**
 * The version of the terms a pilot agreed to, recorded with their choice.
 *
 * Design section 4a: "the version of the terms a contributor agreed to should be
 * recorded with their records so it is answerable later". Consent for one thing
 * is not consent for another, and the only way to know afterwards which wording
 * somebody saw is to have written it down at the time.
 *
 * A date rather than a timestamp, and a date belonging to the TERMS rather than
 * to the pilot: it says which text was on screen, not when anyone read it. That
 * distinction is the whole reason it is safe to keep — see the note on dates in
 * NEVER_STORED.
 */
const SHARING_TERMS_VERSION = '2026-08-14';

/** Nothing shared, nothing asked, no identity. The state a fresh install is in. */
function createSharing() {
  return {
    schemaVersion: SHARING_SCHEMA_VERSION,
    kind: SHARING_KIND,
    // Whether the pilot has been asked at all. Separate from `sharing` because
    // "no" and "not yet asked" are different states and only one of them may
    // ever put a dialog on screen.
    asked: false,
    // OFF BY DEFAULT. Opt-in, never opt-out — design section 3.
    sharing: false,
    // Null until somebody agrees to something.
    termsVersion: null,
    // aircraftKey → sharingId.
    //
    // The KEY of this map never leaves the device and is not part of any shared
    // shape: `shareableRecord` takes the id and never sees the map. It is keyed
    // that way because the local history is, and joining the two is the whole
    // job — but it does mean this file, like the history beside it, carries the
    // craft name in derived form, which is why it lives in the same private
    // directory and is erased by the same controls.
    ids: {}
  };
}

/**
 * The sharing file's text, rebuilt from a documented shape.
 *
 * Never `JSON.stringify(state.sharing)`. The same rule `exportHistory` follows
 * and for the same reason: a field pushed into the object in memory must have no
 * path to the disk. Five fields, written out one at a time.
 */
function exportSharing(sharing) {
  const ids = {};
  for (const [key, id] of Object.entries(sharing?.ids ?? {})) {
    // Shape-checked on the way out as well as on the way in. An id that is not
    // an id cannot group anything and cannot be deleted by anyone, so writing
    // one down would be keeping a value with no use — which is the definition of
    // a trail.
    if (typeof key === 'string' && key !== '' && isSharingId(id)) {
      ids[key] = id;
    }
  }

  return JSON.stringify({
    schemaVersion: SHARING_SCHEMA_VERSION,
    kind: SHARING_KIND,
    asked: sharing?.asked === true,
    sharing: sharing?.sharing === true,
    termsVersion: typeof sharing?.termsVersion === 'string' ? sharing.termsVersion : null,
    ids
  }, null, 2);
}

/**
 * Reads the sharing file back.
 *
 * Fails to the OFF state on anything it does not understand, which is the safe
 * direction: an unreadable preference must never be read as consent.
 */
function importSharing(text) {
  const codes = [];
  if (typeof text !== 'string' || text.trim() === '') {
    return {sharing: createSharing(), codes};
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {sharing: createSharing(), codes: ['SHARING_UNREADABLE']};
  }

  if (parsed?.kind !== SHARING_KIND) {
    return {sharing: createSharing(), codes: ['SHARING_KIND_MISMATCH']};
  }
  if (parsed?.schemaVersion !== SHARING_SCHEMA_VERSION) {
    // Not guessed at, exactly as the history does it. A preference written by a
    // different version of these terms is not this version's consent.
    return {sharing: createSharing(), codes: ['SHARING_SCHEMA_VERSION_MISMATCH']};
  }

  const ids = {};
  for (const [key, id] of Object.entries(parsed.ids ?? {})) {
    if (typeof key === 'string' && key !== '' && isSharingId(id)) {
      ids[key] = id;
    }
  }

  // `sharing:true` is meaningful only beside a recorded affirmative answer.
  // A malformed or hand-edited file must fail closed while retaining IDs so
  // their records can still be erased.
  const asked = parsed.asked === true;
  const enabled = asked && parsed.sharing === true;

  return {
    sharing: {
      schemaVersion: SHARING_SCHEMA_VERSION,
      kind: SHARING_KIND,
      asked,
      sharing: enabled,
      termsVersion: enabled && typeof parsed.termsVersion === 'string'
        ? parsed.termsVersion
        : null,
      ids
    },
    codes
  };
}

/** Reads the preference back from the host. Called inside `loadHistory`'s queue. */
async function loadSharing() {
  const storePresent = hasSharingStore();
  const text = await readSharingText();
  const storageReadFailed = storePresent && text === null;
  const imported = importSharing(text ?? '');
  let sharing = imported.sharing;
  const codes = [...imported.codes];
  if (storageReadFailed) {
    codes.unshift('SHARING_STORAGE_READ_FAILED');
  }
  // Consent is bound to the words that were shown. An enabled preference from
  // an older disclosure fails closed: keep its local identities (the handles a
  // pilot may need to erase), but turn sharing off and make the current question
  // eligible to appear after the next admissible analysis.
  if (sharing.sharing === true && sharing.termsVersion !== SHARING_TERMS_VERSION) {
    sharing = {...sharing, asked: false, sharing: false, termsVersion: null};
    codes.unshift('SHARING_TERMS_OUTDATED');
  }
  const unsafeToReplace = storageReadFailed || codes.some(code =>
    code === 'SHARING_UNREADABLE'
      || code === 'SHARING_KIND_MISMATCH'
      || code === 'SHARING_SCHEMA_VERSION_MISMATCH');
  state.sharing = sharing;
  sharingRevision += 1;
  state.sharingCodes = codes;
  state.sharingStorePresent = storePresent;
  state.sharingReadBlocked = unsafeToReplace;
  state.sharingWritable = storePresent && !unsafeToReplace;
  state.sharingWriteFailed = false;
  state.sharingForgetFailed = false;
  return sharing;
}

/**
 * Writes a new preference through the host, and adopts it only if that worked.
 *
 * The same rule as `persistHistory` on the way in, and it matters more here: a
 * screen showing "Sharing is on" over a file that still says off is a screen
 * lying about a consent decision.
 *
 * In a browser there is no store. The preference is then adopted in memory only
 * and the panel says so — better than a control that silently does nothing.
 */
function persistSharing(next) {
  const expectedRevision = sharingRevision;
  return enqueueStorageOperation(async () => {
    if (expectedRevision !== sharingRevision) {
      return false;
    }
    if (!state.sharingWritable) {
      if (!state.sharingStorePresent) {
        state.sharing = next;
        sharingRevision += 1;
      } else {
        state.sharingWriteFailed = true;
      }
      return false;
    }
    const written = await writeSharingText(exportSharing(next));
    state.sharingWriteFailed = !written;
    if (written) {
      state.sharing = next;
      sharingRevision += 1;
    }
    return written;
  });
}

/**
 * Gives every remembered helicopter an identity, and takes it back from any that
 * is no longer remembered.
 *
 * ONE RECONCILIATION RATHER THAN TWO HOOKS. Creating ids where a flight was
 * saved and dropping them where one was forgotten, in separate places, is how
 * the second half ends up missing — and the half that would be missing is the
 * half that deletes.
 *
 * ## Three decisions worth stating
 *
 * WHY NOTHING IS CREATED WHILE SHARING IS OFF. Off by default has to mean off:
 * a pilot who has never answered the question, or who answered "not now", must
 * cost this app nothing on disk. So an identity comes into existence at the
 * moment sharing is switched on and not a moment before, and a fresh install
 * that is never asked writes no sharing file at all.
 *
 * WHY THAT DOES NOT COST THE PREVIEW. Reading what would leave before agreeing
 * to let it leave is the whole point of this screen, and it does not need a
 * stored identity to do it — `exampleSharingId` makes one that is never written
 * down, and the preview says plainly which of the two it is showing.
 *
 * WHY FORGETTING A HELICOPTER TAKES ITS ID. "Store what is needed, not a trail":
 * an identity for a machine with no flights left is a value with nothing to do.
 * Note the tension for whoever adds the transport — once records have actually
 * been sent, this line silently costs the pilot the handle they would delete
 * them by, and the answer is the one the design already gives: the identity is
 * on screen to be written down. Revisit this the day sending becomes possible.
 *
 * @returns {Promise<boolean>} whether the set of identities changed and was written back.
 *   A render that changes nothing costs no write, which matters because this
 *   runs on every repaint of the panel — and because an erase followed by a
 *   repaint that rewrote the file would be a control that undoes itself.
 */
async function reconcileSharingIds() {
  // An unreadable or partially imported history is not an empty history. Its
  // absent keys prove nothing about which aircraft were deleted, so pruning the
  // sharing map here would destroy the only deletion handles a pilot has. Only
  // an explicit erase control may change identities until history is readable.
  if (state.historyReadBlocked || state.sharingReadBlocked || state.sharingForgetFailed) {
    return false;
  }
  const history = state.history ?? createHistory();
  const current = state.sharing ?? createSharing();
  const keys = new Set(listAircraft(history).map(entry => entry.aircraftKey));

  const ids = {};

  // KEPT: every identity whose helicopter is still remembered, whether sharing
  // is on or off right now. Switching sharing off must NOT destroy an identity —
  // it is the only handle a pilot would have on records already sent, and a
  // pause that quietly cost them the right to delete would be the opposite of
  // what the switch appears to do. "Erase the sharing identity" is the control
  // for destroying it, and it says what that costs.
  for (const key of keys) {
    const existing = current.ids?.[key];
    if (isSharingId(existing)) {
      ids[key] = existing;
    }
  }

  // CREATED: only while sharing is on. Off by default has to mean off, so a
  // pilot who has never answered, or who answered "not now", costs this app
  // nothing on disk.
  if (current.sharing === true) {
    for (const key of keys) {
      if (isSharingId(ids[key])) {
        continue;
      }
      const created = newSharingId();
      // `newSharingId` returns null on a platform with no cryptographic random
      // source rather than falling back to Math.random, because a weak id would
      // collide between devices and pool two pilots' aircraft into one. Nothing
      // is stored then, and the panel says the identity could not be created.
      if (created !== null) {
        ids[key] = created;
      }
    }
  }

  // DROPPED: anything left over, which is an identity for a helicopter whose
  // flights are all gone. Compared as a whole rather than counted, so a rename
  // cannot look like no change.
  const before = Object.entries(current.ids ?? {}).filter(([, id]) => isSharingId(id));
  const changed = before.length !== Object.keys(ids).length
    || before.some(([key, id]) => ids[key] !== id);

  if (!changed) {
    return false;
  }

  return await persistSharing({...current, ids});
}

/** This helicopter's identity, or null when it has none yet. */
function sharingIdFor(aircraftKey) {
  const id = state.sharing?.ids?.[aircraftKey];
  return isSharingId(id) ? id : null;
}

/**
 * An identity for the preview only, which is never written anywhere.
 *
 * So that "show me exactly what would be sent" works before anyone has agreed
 * to anything. Held in memory for the life of the page so the example does not
 * change under a reader who is comparing two of them, and deliberately NOT
 * persisted: an app that wrote a random identity to disk because somebody looked
 * at a sample would have made "off by default" mean something weaker than it
 * says.
 */
let exampleId = null;

function exampleSharingId() {
  if (exampleId === null) {
    exampleId = newSharingId();
  }
  return exampleId;
}

// ---- the consent dialog ---------------------------------------------------

let consentReturnFocus = null;

function setPageInert(inert) {
  document.querySelector('header').inert = inert;
  document.querySelector('main').inert = inert;
}

/**
 * Closes the consent modal without inventing an answer.
 *
 * @return {boolean} whether a modal was open
 */
function dismissConsent({restoreFocus = true} = {}) {
  if (!state.consentOpen) {
    return false;
  }
  const target = consentReturnFocus?.isConnected ? consentReturnFocus : $('drop');
  state.consentOpen = false;
  show('consent', false);
  setPageInert(false);
  consentReturnFocus = null;
  if (restoreFocus && target?.isConnected) {
    target.focus({preventScroll: true});
  }
  return true;
}

/** Opens the complete versioned terms from either the automatic prompt or panel. */
function openConsent(returnFocus = null) {
  const legalPageOpen = typeof globalThis.RotorLensIsLegalPageOpen === 'function'
    && globalThis.RotorLensIsLegalPageOpen() === true;
  if (state.consentOpen || legalPageOpen
      || !state.sharingWritable || state.historyReadBlocked) {
    return false;
  }
  consentReturnFocus = returnFocus instanceof HTMLElement
    ? returnFocus
    : (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  state.consentOpen = true;
  setPageInert(true);
  show('consent');
  // Focus lands on the declining option deliberately. A dialog whose default
  // action is the one that benefits the app is a dark pattern with good manners.
  $('consent-not-now').focus();
  return true;
}

/**
 * Asks, once, after the first analysis that produced something to point at.
 *
 * NOT AT FIRST RUN, which is design section 4 and the reason this function takes
 * so much care about when it fires: asking before the app has done anything
 * useful is how consent becomes a reflex tap on the way to the thing the person
 * actually opened. It fires after a flight has been measured AND found
 * admissible, so "the measurements from this flight" names something that
 * exists — after a bench run there is nothing to point at and nothing is asked.
 *
 * Once per disclosure. `asked` is written the moment either button is pressed,
 * including "Not now". An enabled answer only suppresses the question while its
 * termsVersion is the wording in this build; older enabled consent fails closed
 * during load and becomes eligible to be asked again.
 */
export function maybeAskToShare() {
  if (state.consentOpen
      || state.candidate === null
      || state.historyReadBlocked
      || (state.sharing?.asked === true
        && (state.sharing?.sharing !== true
          || state.sharing?.termsVersion === SHARING_TERMS_VERSION))
      // No store, no question. An answer that cannot be written down would be
      // asked again on the next log, and a dialog that reappears after being
      // dismissed teaches people to dismiss dialogs.
      || !state.sharingWritable) {
    return;
  }

  openConsent();
}

/**
 * Records the answer and closes the dialog.
 *
 * @param {boolean} agreed what the pilot pressed
 */
async function answerConsent(agreed) {
  const current = state.sharing ?? createSharing();
  const returnToSharingToggle = consentReturnFocus?.id === 'sharing-toggle';
  const written = await persistSharing({
    ...current,
    asked: true,
    sharing: agreed,
    // The wording that was on screen, kept only when something was agreed to.
    // "Not now" agreed to nothing, so there is nothing to record a version of.
    termsVersion: agreed ? SHARING_TERMS_VERSION : null
  });
  if (written || !state.sharingStorePresent) {
    state.sharingCodes = [];
    await reconcileSharingIds();
  }

  dismissConsent({restoreFocus: !returnToSharingToggle});
  renderSharingPanel();
  if (returnToSharingToggle) {
    $('sharing-toggle')?.focus({preventScroll: true});
  }
}

// ---- the shared measurements panel ----------------------------------------

/**
 * The sentence that has to be true, in every state of this panel.
 *
 * Kept as one constant used in three places rather than typed three times: a
 * claim this load-bearing must not be able to drift between the dialog, the
 * panel and the erase confirmation, and the only way to guarantee that is for
 * there to be one of it.
 */
const NOTHING_IS_SENT =
  '<p><b>Nothing is sent, and this version cannot send.</b> There is no upload transport '
  + 'or code in this app that contacts anything. On Android, the missing INTERNET '
  + 'permission is an additional operating-system barrier. '
  + 'The switch below records '
  + 'a choice for a future version; if one is ever built it will arrive as an app update you '
  + 'choose to install, and it will start from what you set here.</p>';

/** The honest limit of a device-held identity, on screen rather than in a document. */
const IDENTITY_LIMIT =
  '<p><b>Write the identity down if you want to be able to delete later.</b> It exists only on '
  + 'this phone. Clear RotorLens&rsquo;s storage, uninstall it, or lose the handset and the '
  + 'identity is gone &mdash; anything that had already been sent would stay in the collection, '
  + 'permanently anonymous and no longer deletable by you, because nothing at the other end '
  + 'could connect it to anyone. That is the price of RotorLens having no account and no login, '
  + 'and it is a deliberate trade rather than an oversight. On paper, the identity outlives the '
  + 'phone.</p>'
  + '<p class="muted">Forgetting a helicopter&rsquo;s flights erases its sharing identity too, '
  + 'and so does <b>Forget everything</b>.</p>';

const SHARING_LOAD_WORDS = {
  SHARING_STORAGE_READ_FAILED: 'The sharing file exists but RotorLens could not read it. Changes '
    + 'are disabled so the existing choice and identity cannot be overwritten. Erase the '
    + 'sharing identity explicitly, or restart the app and try again.',
  SHARING_UNREADABLE: 'The stored sharing preference could not be read, so sharing is off. '
    + 'Nothing was overwritten and changes are disabled until it is explicitly erased.',
  SHARING_KIND_MISMATCH: 'The stored file is not a RotorLens sharing preference, so it was '
    + 'ignored and sharing is off.',
  SHARING_SCHEMA_VERSION_MISMATCH: 'The stored preference was written against a different '
    + 'version of these terms. It was not carried over, because agreeing to one wording is not '
    + 'agreeing to another.',
  SHARING_TERMS_OUTDATED: 'Sharing was enabled under an older disclosure, so it is off now. '
    + 'RotorLens will ask again after it analyses a flight; existing local identities remain '
    + 'available to erase.'
};

/**
 * `4.2 kB`, so the dialog's "about 4 kB of numbers" can be checked on screen.
 *
 * Measured on the COMPACT form even though the pretty-printed one is what is
 * displayed. The indentation is this screen's doing, not the record's, and
 * quoting its cost would put a number beside a payload that disagrees with the
 * number in the dialog — over a difference the pilot never pays.
 */
function sizeOf(shared) {
  return `${(JSON.stringify(shared).length / 1024).toFixed(1)} kB`;
}

/**
 * One shared record, exactly as `shareableRecord` builds it, with its audit.
 *
 * The projection is NOT rebuilt here and no field is renamed on the way to the
 * screen: what is printed is the object the sharing code produces, so a pilot
 * reading this is reading the real shape rather than a rendering of it. That is
 * the only version of this control worth having.
 *
 * `auditShareableRecord` runs on it in front of the reader, as
 * `auditFlightRecord` already does before a flight is stored. It has the source
 * record to compare against, which turns on the by-value scan — the one that
 * catches a craft name hiding inside a field whose own name looks innocent.
 */
function payloadHtml(record, id, real) {
  const shared = shareableRecord(record, id);
  const audit = auditShareableRecord(shared, record);
  const text = JSON.stringify(shared, null, 2);

  const verdict = audit.ok
    ? '<p class="muted" style="font-size:12.5px">Checked in front of you by '
      + '<code>auditShareableRecord</code>: no helicopter name, no aircraft key, no record id, '
      + 'no date, no file name, no coordinate, and no field that is not on the shared list. '
      + 'The same check would refuse to let a record be sent.</p>'
    : '<p class="error">This projection failed its own audit and would not be shared:</p>'
      + `<ul class="codes">${audit.violations
        .map(violation => `<li><code>${esc(violation.path)}</code> &mdash; `
          + `${esc(violation.reason)}</li>`).join('')}</ul>`;

  // Which of the two identities is in the JSON below, said before the JSON
  // rather than after it. A reader who wrote down an example id believing it was
  // theirs would have written down nothing.
  const whose = real
    ? '<p class="muted" style="font-size:12.5px">The <code>sharingId</code> below is this '
      + 'helicopter&rsquo;s real one, the same one shown above.</p>'
    // Worded without naming the switch, because "no stored identity" also
    // happens for a moment when sharing is on and the write failed, and a
    // sentence saying "sharing is off" over a panel reading "sharing is on"
    // would be the screen contradicting itself.
    : '<p class="muted" style="font-size:12.5px">This helicopter has no identity yet, so the '
      + '<code>sharingId</code> below is an example. It is not written down anywhere; a real '
      + 'one is created on this device when sharing is switched on.</p>';

  return whose
    + '<p class="muted" style="font-size:12.5px">One record, '
    + `${esc(sizeOf(shared))} of numbers. This is the whole of it, indented here to be read.</p>`
    + `<pre class="export">${esc(text)}</pre>${verdict}`;
}

/** One helicopter: its identity, what it would amount to, and the payload. */
function sharingAircraftHtml(entry, history, on) {
  const flights = findRecords(history, entry.aircraftKey);
  const stored = sharingIdFor(entry.aircraftKey);
  const open = state.sharingShown === entry.aircraftKey;
  const example = stored === null ? exampleSharingId() : null;

  let identity;
  if (stored !== null) {
    identity = '<div class="share-id"><span class="label">Sharing identity</span>'
      + `<code>${esc(stored)}</code></div>`;
  } else if (example === null) {
    identity = '<p class="error">No sharing identity can be created on this device, because it '
      + 'offers no cryptographic random source. Nothing could be shared from this helicopter, '
      + 'which is the correct way for that to fail.</p>';
  } else if (on) {
    // Sharing is on and the id still did not appear, so the write failed. Say
    // that rather than showing a blank where an identity should be.
    identity = '<p class="error">RotorLens could not create a sharing identity for this '
      + 'helicopter. Nothing could be shared from it.</p>';
  } else {
    identity = '<p class="muted">No sharing identity has been created for this helicopter. One '
      + 'is created on this device when you switch sharing on, and nothing is written down '
      + 'until then.</p>';
  }

  // What the count MEANS, beside the count. "8" on its own invites the reader to
  // supply their own meaning, and the meaning here is not the obvious one: the
  // design sends on open rather than on save, so today's honest number is the
  // flights this app can actually show you.
  const count = `<p>${flights.length} record${flights.length === 1 ? '' : 's'} would be sent from `
    + `this helicopter &mdash; one for each flight it has kept. A future version would prepare a `
    + `record each time you open a flight, whether or not you keep it, so this number is what `
    + `RotorLens can show you today rather than a queue waiting to go.</p>`;

  const shown = stored ?? example;
  const payload = flights.length === 0 || shown === null
    ? ''
    : `<button type="button" data-share-show="${esc(entry.aircraftKey)}">`
      + `${open ? 'Hide' : 'Show'} what would be sent</button>`
      + (open ? payloadHtml(flights[flights.length - 1], shown, stored !== null) : '');

  return '<div class="aircraft"><div class="aircraft-head">'
    + `<span class="name">${esc(entry.craftName ?? 'unnamed')}</span>`
    + `<span class="where">${esc(entry.board ?? 'board unknown')} &middot; `
    + `${entry.flightCount} flight${entry.flightCount === 1 ? '' : 's'} kept</span>`
    + `</div>${identity}${count}${payload}</div>`;
}

/** The whole panel body, so it can be asserted on without a browser. */
export function sharingHtml(history, sharing, {writable = true, blocked = false,
  historyBlocked = false, forgetFailed = false, writeFailed = false, codes = []} = {}) {
  const on = sharing?.sharing === true;

  const warnings = [
    forgetFailed
      ? '<p class="error">RotorLens could not erase the sharing identity file, so its saved '
        + 'preference and any identity it contains may still be on this device. Try again; if '
        + 'it keeps failing, deleting RotorLens or clearing its app storage where the operating '
        + 'system offers that control will remove it.</p>'
      : '',
    writeFailed
      ? '<p class="error">RotorLens could not record that choice, so it will not survive closing '
        + 'the app. Nothing has been shared either way.</p>'
      : '',
    historyBlocked
      ? '<p class="error">RotorLens could not safely read the flight history, so it will not '
        + 'create or remove sharing identities. Any identities already stored are being '
        + 'preserved unchanged. Restart the app and try again, or use Forget everything to '
        + 'erase both files explicitly.</p>'
      : '',
    writable || blocked
      ? ''
      : '<p class="error">This build has nowhere to keep the choice, so sharing cannot be '
        + 'enabled here. The current phone app keeps the choice in its own private storage.</p>',
    ...codes
      .filter(code => code in SHARING_LOAD_WORDS)
      .map(code => `<p class="error">${esc(SHARING_LOAD_WORDS[code])}</p>`)
  ].join('');

  const hasStoredIdentity = Object.values(sharing?.ids ?? {}).some(id => isSharingId(id));
  const canSayNothingStored = sharing?.asked !== true
    && !hasStoredIdentity
    && !blocked
    && !historyBlocked
    && codes.length === 0
    && !forgetFailed
    && !writeFailed;

  const stateLine = on
    ? '<p class="headline">Sharing is <b>on</b> &mdash; and nothing has been sent, because there '
      + 'is nowhere to send it.</p>'
      + '<p class="muted">RotorLens will start from this the day a way to send exists. Until '
      + 'then the only thing that has happened is that this phone wrote down your answer.</p>'
    : '<p class="headline">Sharing is <b>off</b>.</p>'
      + '<p class="muted">RotorLens still measures every flight you open &mdash; that is what the '
      + 'app is &mdash; and none of those measurements is marked to be shared.</p>'
      // Covers a fresh install and the state just after an erase alike, because
      // they are the same state and describing them differently would be
      // inventing a distinction the file does not make.
      + (canSayNothingStored
        ? '<p class="muted">Nothing about sharing is stored on this device. RotorLens will ask '
          + 'you once, after it has analysed a flight.</p>'
        : '');

  // The erase control appears only when there is something to erase. A button
  // that cannot do anything teaches people that the buttons here do nothing.
  const erasable = blocked || sharing?.asked === true || hasStoredIdentity;

  // Turning an existing preference off is always allowed. Turning it on needs
  // the complete history so every kept helicopter can receive the deletion
  // identity promised by the consent screen.
  const toggleDisabled = blocked || !writable || (historyBlocked && !on);
  const toggle = '<div class="controls">'
    + `<button type="button" id="sharing-toggle"${on ? '' : ' class="primary"'}`
    + `${toggleDisabled ? ' disabled aria-disabled="true"' : ''}>`
    + `${on ? 'Turn sharing off' : 'Share measurements'}</button>`
    + (erasable
      ? '<button type="button" id="sharing-forget">Erase the sharing identity</button>'
      : '')
    + '</div>';

  const aircraft = listAircraft(history);
  const machines = historyBlocked
    ? '<p class="muted">Helicopters cannot be listed until the flight history can be read. '
      + 'Stored sharing identities have not been changed.</p>'
    : aircraft.length === 0
    ? '<p class="muted">RotorLens has not kept any flights yet, so there is nothing to share and '
      + 'no identity has been created. Save a flight and this fills in.</p>'
    : aircraft.map(entry => sharingAircraftHtml(entry, history, on)).join('');

  const agreed = on && typeof sharing?.termsVersion === 'string'
    ? `<p class="muted" style="font-size:12.5px">Terms version ${esc(sharing.termsVersion)}, `
      + 'recorded with your choice so it is answerable later which wording you saw.</p>'
    : '';

  return warnings + NOTHING_IS_SENT + stateLine + toggle + agreed
    + `<h3>Your helicopters</h3>${machines}`
    + `<h3>The one thing this cannot do</h3>${IDENTITY_LIMIT}`;
}

function renderSharingPanel() {
  const history = state.history ?? createHistory();
  const sharing = state.sharing ?? createSharing();

  // Hidden where it can do nothing: a browser with no store, no preference and
  // no flights. The same rule the history panel follows, and for the same reason
  // — a panel that can never fill is noise on a 384px screen.
  if (!state.sharingStorePresent && !sharing.sharing && history.records.length === 0
      && state.sharingCodes.length === 0) {
    show('sharing-panel', false);
    return;
  }

  $('sharing').innerHTML = sharingHtml(history, state.sharing ?? sharing, {
    writable: state.sharingWritable,
    blocked: state.sharingReadBlocked,
    historyBlocked: state.historyReadBlocked,
    forgetFailed: state.sharingForgetFailed,
    writeFailed: state.sharingWriteFailed,
    codes: state.sharingCodes
  });
  show('sharing-panel');
}

/**
 * Erases the identity and the preference, and says so only if it worked.
 *
 * Sharing goes back off with it. Leaving it on over an erased identity would
 * have the panel regenerate one on its next render, which is a control that
 * undoes itself — the worst kind, because it looks like it worked.
 *
 * The file is unlinked rather than rewritten empty, exactly as "forget
 * everything" does with the history: a file saying "asked, declined" is still a
 * file about somebody's choices. The cost is that the question comes back once
 * after the next analysis, and the panel says so rather than letting it be a
 * surprise.
 */
async function eraseSharingIdentity() {
  await enqueueStorageOperation(async () => {
    const forgotten = await forgetSharingFile();
    state.sharingForgetFailed = state.sharingStorePresent && !forgotten;
    if (forgotten || !state.sharingStorePresent) {
      state.sharing = createSharing();
      sharingRevision += 1;
      state.sharingCodes = [];
      state.sharingShown = null;
      state.sharingWriteFailed = false;
      if (forgotten) {
        state.sharingReadBlocked = false;
        state.sharingWritable = state.sharingStorePresent;
      }
    }
  });
  renderSharingPanel();
}

// ---------------------------------------------------------------------------
// Axis panel: measurements available on any log, and the trace behind them
// ---------------------------------------------------------------------------

function renderAxisPanel() {
  const session = currentSession();
  const axis = $('axis').value;

  $('tune-heading').textContent = `Tune evidence — ${axis}`;

  const signals = resolveAxisSignals(session, axis);
  state.axisSignals = signals;

  if (!signals.usable) {
    state.axisSummary = null;
    $('axis-stats').innerHTML = '';
    $('axis-note').innerHTML =
      `<span class="error">This log does not carry the signals needed to look at ` +
      `${esc(axis)}.</span> Missing: ${esc(signals.missing.join(', '))}.`;
    $('axis-plot-caption').textContent = '';
    clearAxisPlot();
    resetVibration();
    return;
  }

  // Over the flight window, like everything else on the page. The signals are
  // column indexes and do not care which session object they are read from.
  const summary = summarizeAxis(windowedSession(), signals);
  state.axisSummary = summary;

  // `summarizeAxis` returns null for a session with the right columns and no
  // samples — a header that parsed cleanly over an empty frame stream, e.g. an
  // armed-and-instantly-disarmed capture. `signals.usable` is true there (the
  // columns exist), so without this branch the dereferences below threw, the
  // exception escaped `openSession`'s decode-scoped try, and the progress bar
  // stayed stranded over a half-rendered page.
  if (summary === null) {
    $('axis-stats').innerHTML = '';
    $('axis-note').innerHTML =
      'This session carries the right signals but no samples — the recording ' +
      'stopped before any frame was written — so there is nothing to measure.';
    $('axis-plot-caption').textContent = '';
    clearAxisPlot();
    resetVibration();
    return;
  }

  const noise = summary.unfilteredHighFrequencyRmsDps === null
    ? `${text(summary.gyroHighFrequencyRmsDps)}°/s`
    : `${text(summary.gyroHighFrequencyRmsDps)} / ${text(summary.unfilteredHighFrequencyRmsDps)}°/s`;

  $('axis-stats').innerHTML = [
    stat('Peak commanded', `${text(summary.peakCommandDps, 0)}&deg;/s`),
    stat('Peak measured', `${text(summary.peakMeasuredDps, 0)}&deg;/s`),
    stat('Tracking error', `${text(summary.trackingRmsWhileMovingDps)}&deg;/s`,
      `RMS while commanded above ${summary.movingCommandThresholdDps}°/s`),
    stat('Tracking error, whole flight', `${text(summary.trackingRmsDps)}&deg;/s`),
    stat('Gyro above 50 Hz', noise,
      summary.unfilteredFieldName
        ? `filtered / unfiltered (${summary.unfilteredFieldName})`
        : 'filtered only — no unfiltered gyro in this log'),
    stat('Headspeed', summary.headspeedMedianRpm === null
      ? '—'
      : `${text(Math.round(summary.headspeedMedianRpm))} rpm`, 'median while turning'),
    stat('Commands over threshold',
      `${summary.commandExcursionCount}`,
      `above ${text(summary.commandThresholdDps, 0)}°/s, ` +
      `${text(summary.secondsAboveCommandThreshold, 1)} s total`)
  ].join('');

  $('axis-note').innerHTML =
    `Commanded rate is <code>${esc(signals.names.setpoint)}</code>, measured rate is ` +
    `<code>${esc(signals.names.gyro)}</code>` +
    (signals.names.unfiltered
      ? `, unfiltered is <code>${esc(signals.names.unfiltered)}</code>.`
      : '. This log does not carry an unfiltered gyro, so the number above is what ' +
        'survived the filters, not what the airframe produced.') +
    ' These are measurements of the flight window, taken straight off the log. They are ' +
    'what the recommendations at the top of the page are built from, so if one of them ' +
    'looks wrong to you, the recommendation above it is wrong too.';

  fitAxisView();
  drawAxisPlot();
  // The measurement belongs to the window that was on screen when it was taken,
  // so a new axis or a new session drops it rather than leaving numbers from a
  // different signal under a fresh heading.
  resetVibration();
}

/**
 * Resets the visible window to the FLIGHT WINDOW.
 *
 * `firstUs`/`lastUs` stay the ends of the whole recording, deliberately: zooming
 * out past the window has to be possible, because what is outside it is drawn
 * dimmed and seeing that is how a pilot judges whether the ends are in the right
 * place. What changes is where the view opens, which is on the flight.
 */
function fitAxisView() {
  const session = currentSession();
  const signals = state.axisSignals;
  const samples = session.samples;
  if (!signals?.usable || samples.length === 0) {
    state.view = {startUs: 0, spanUs: 0, firstUs: 0, lastUs: 0};
    return;
  }

  const firstUs = samples[0][signals.timeIndex];
  const lastUs = samples[samples.length - 1][signals.timeIndex];
  const window_ = state.window;
  const startUs = Number.isFinite(window_?.startUs) ? window_.startUs : firstUs;
  const endUs = Number.isFinite(window_?.endUs) ? window_.endUs : lastUs;

  state.view = {
    firstUs,
    lastUs,
    startUs,
    spanUs: Math.max(1, endUs - startUs)
  };
  syncScrub();
}

/**
 * Keeps the visible window inside the flight.
 *
 * The floor on the span is a real constraint, not tidiness: zoomed past a few
 * samples the plot draws a straight line between two points and reads as a clean
 * trace, which is a picture of nothing at all.
 */
function clampAxisView() {
  const {firstUs, lastUs} = state.view;
  const total = Math.max(1, lastUs - firstUs);
  const minimumSpanUs = Math.min(total, 20_000);

  state.view.spanUs = Math.min(total, Math.max(minimumSpanUs, state.view.spanUs));
  state.view.startUs = Math.min(
    lastUs - state.view.spanUs,
    Math.max(firstUs, state.view.startUs)
  );
  syncScrub();
}

function syncScrub() {
  const {firstUs, lastUs, startUs, spanUs} = state.view;
  const travel = Math.max(0, (lastUs - firstUs) - spanUs);
  const scrub = $('axis-scrub');
  scrub.value = String(travel === 0 ? 0 : Math.round((startUs - firstUs) / travel * 1000));
  scrub.disabled = travel === 0;
}

function zoomAxis(factor) {
  const centreUs = state.view.startUs + state.view.spanUs / 2;
  state.view.spanUs *= factor;
  clampAxisView();
  state.view.startUs = centreUs - state.view.spanUs / 2;
  clampAxisView();
  drawAxisPlot();
}

function panAxis(fraction) {
  state.view.startUs += state.view.spanUs * fraction;
  clampAxisView();
  drawAxisPlot();
}

/**
 * Sizes the backing store to the element as it is actually laid out.
 *
 * The canvas used to be fixed at 1600 backing-store columns whatever it was
 * displayed at. On a 384px phone that is 4.17 backing pixels per CSS pixel, so a
 * one-second step response — the whole point of the picture — occupied under
 * three pixels of screen and could not be resolved at any zoom.
 */
function prepareCanvas(canvas) {
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 3);
  const cssWidth = Math.max(1, Math.round(canvas.clientWidth || canvas.offsetWidth || 320));
  const cssHeight = Math.max(1, Math.round(canvas.clientHeight || 220));
  const width = Math.round(cssWidth * ratio);
  const height = Math.round(cssHeight * ratio);

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);
  return {context, cssWidth, cssHeight, ratio};
}

function clearAxisPlot() {
  const canvas = $('axis-plot');
  const {context, cssWidth, cssHeight} = prepareCanvas(canvas);
  context.fillStyle = '#8b98a5';
  context.font = '13px system-ui, sans-serif';
  context.textAlign = 'center';
  context.fillText('No trace for this axis.', cssWidth / 2, cssHeight / 2);
}

const PLOT_PAD = {left: 42, right: 8, top: 10, bottom: 20};

function drawAxisPlot() {
  const signals = state.axisSignals;
  const canvas = $('axis-plot');
  if (!signals?.usable) {
    clearAxisPlot();
    return;
  }

  const samples = currentSession().samples;
  const {context, cssWidth, cssHeight, ratio} = prepareCanvas(canvas);
  const plotWidth = Math.max(10, cssWidth - PLOT_PAD.left - PLOT_PAD.right);
  const plotHeight = Math.max(10, cssHeight - PLOT_PAD.top - PLOT_PAD.bottom);

  const {startUs, spanUs, firstUs} = state.view;
  const endUs = startUs + spanUs;
  const from = indexAtOrAfter(samples, signals.timeIndex, startUs);
  const to = Math.max(from, indexAtOrAfter(samples, signals.timeIndex, endUs) - 1);

  // One decimation column per backing-store pixel: any finer is invisible, any
  // coarser throws away a spike the reader could otherwise have seen.
  const columns = Math.max(1, Math.round(plotWidth * ratio));
  const command = decimate(samples, signals.setpointIndex, from, to, columns);
  const measured = decimate(samples, signals.gyroIndex, from, to, columns);

  if (command.empty && measured.empty) {
    context.fillStyle = '#8b98a5';
    context.font = '13px system-ui, sans-serif';
    context.textAlign = 'center';
    context.fillText('No finite samples in this window.', cssWidth / 2, cssHeight / 2);
    $('axis-plot-caption').textContent = '';
    return;
  }

  let low = Math.min(command.empty ? Infinity : command.low, measured.empty ? Infinity : measured.low);
  let high = Math.max(command.empty ? -Infinity : command.high, measured.empty ? -Infinity : measured.high);
  if (!(high > low)) {
    low -= 1;
    high += 1;
  }
  const pad = (high - low) * 0.08;
  low -= pad;
  high += pad;

  const toY = value => PLOT_PAD.top + plotHeight - ((value - low) / (high - low)) * plotHeight;
  const toX = fraction => PLOT_PAD.left + fraction * plotWidth;

  // ----- grid -------------------------------------------------------------
  context.font = '10px system-ui, sans-serif';
  context.lineWidth = 1;

  const yStep = niceStep(high - low, 4);
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  for (let value = Math.ceil(low / yStep) * yStep; value <= high; value += yStep) {
    const y = toY(value);
    context.strokeStyle = Math.abs(value) < yStep / 100 ? '#3a4553' : '#232b35';
    context.beginPath();
    context.moveTo(PLOT_PAD.left, y);
    context.lineTo(PLOT_PAD.left + plotWidth, y);
    context.stroke();
    context.fillStyle = '#8b98a5';
    context.fillText(String(Math.round(value)), PLOT_PAD.left - 5, y);
  }

  const spanSeconds = spanUs / 1e6;
  const xStep = niceStep(spanSeconds, 4);
  const originSeconds = (startUs - firstUs) / 1e6;
  context.textAlign = 'center';
  context.textBaseline = 'top';
  for (let t = Math.ceil(originSeconds / xStep) * xStep; t <= originSeconds + spanSeconds; t += xStep) {
    const x = toX((t - originSeconds) / spanSeconds);
    context.strokeStyle = '#232b35';
    context.beginPath();
    context.moveTo(x, PLOT_PAD.top);
    context.lineTo(x, PLOT_PAD.top + plotHeight);
    context.stroke();
    context.fillStyle = '#8b98a5';
    context.fillText(`${xStep < 1 ? t.toFixed(2) : t.toFixed(1)} s`, x, PLOT_PAD.top + plotHeight + 4);
  }

  // ----- traces -----------------------------------------------------------
  // A min/max zigzag rather than a line through means: it stays continuous when
  // one column covers many samples and collapses to the sample itself when it
  // covers one, so the same code is correct at both ends of the zoom.
  const strokeTrace = (trace, colour, width) => {
    if (trace.empty) {
      return;
    }
    context.strokeStyle = colour;
    context.lineWidth = width;
    context.lineJoin = 'round';
    context.beginPath();
    let started = false;
    for (let c = 0; c < trace.columns; c += 1) {
      if (!Number.isFinite(trace.min[c])) {
        continue;
      }
      const x = toX(trace.columns === 1 ? 0 : c / (trace.columns - 1));
      if (!started) {
        context.moveTo(x, toY(trace.min[c]));
        started = true;
      } else {
        context.lineTo(x, toY(trace.min[c]));
      }
      context.lineTo(x, toY(trace.max[c]));
    }
    context.stroke();
  };

  strokeTrace(measured, '#f0a33c', 1.4);
  strokeTrace(command, '#4aa8ff', 1.6);

  // ----- outside the flight window ----------------------------------------
  // Drawn OVER the traces, because the point is that this stretch is in no
  // number anywhere on the page. Two timestamps in a panel cannot say that; a
  // dimmed end of the trace can.
  const window_ = state.window;
  let outsideVisible = false;
  if (Number.isFinite(window_?.startUs) && Number.isFinite(window_?.endUs)) {
    const clampX = timeUs => Math.max(PLOT_PAD.left,
      Math.min(PLOT_PAD.left + plotWidth, toX((timeUs - startUs) / spanUs)));
    const before = clampX(window_.startUs);
    const after = clampX(window_.endUs);
    context.fillStyle = 'rgba(14,17,22,0.74)';
    if (before > PLOT_PAD.left) {
      context.fillRect(PLOT_PAD.left, PLOT_PAD.top, before - PLOT_PAD.left, plotHeight);
      outsideVisible = true;
    }
    if (after < PLOT_PAD.left + plotWidth) {
      context.fillRect(after, PLOT_PAD.top, PLOT_PAD.left + plotWidth - after, plotHeight);
      outsideVisible = true;
    }
    if (outsideVisible) {
      context.strokeStyle = '#e6edf3';
      context.lineWidth = 1;
      for (const x of [before, after]) {
        context.beginPath();
        context.moveTo(x, PLOT_PAD.top);
        context.lineTo(x, PLOT_PAD.top + plotHeight);
        context.stroke();
      }
    }
  }

  // ----- detected stops ---------------------------------------------------
  const visibleMarks = state.marksAxis === signals.axis
    ? state.marks.filter(mark => mark.timeUs >= startUs && mark.timeUs <= endUs)
    : [];
  for (const mark of visibleMarks) {
    const x = toX((mark.timeUs - startUs) / spanUs);
    context.fillStyle = mark.accepted ? '#3fb950' : '#d29922';
    context.beginPath();
    context.moveTo(x, PLOT_PAD.top);
    context.lineTo(x - 4, PLOT_PAD.top - 8);
    context.lineTo(x + 4, PLOT_PAD.top - 8);
    context.closePath();
    context.fill();
    context.globalAlpha = 0.35;
    context.strokeStyle = mark.accepted ? '#3fb950' : '#d29922';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, PLOT_PAD.top);
    context.lineTo(x, PLOT_PAD.top + plotHeight);
    context.stroke();
    context.globalAlpha = 1;
  }
  show('axis-mark-key', visibleMarks.length > 0);

  const shownSamples = Math.max(0, to - from + 1);
  $('axis-plot-caption').textContent =
    `${originSeconds.toFixed(originSeconds < 10 ? 2 : 1)}–` +
    `${(originSeconds + spanSeconds).toFixed(spanSeconds < 10 ? 2 : 1)} s of ` +
    `${((state.view.lastUs - firstUs) / 1e6).toFixed(1)} s · ` +
    `${shownSamples.toLocaleString()} samples · ` +
    `${command.samplesPerColumn <= 1 ? 'every sample drawn' :
      `${Math.round(command.samplesPerColumn)} samples per column, drawn as min-to-max`}` +
    ` · drag to pan` +
    (outsideVisible ? ' · the dimmed part is outside the flight window and is in no ' +
      'measurement on this page' : '');

  // The vibration panel measures whatever this plot is showing, so its label —
  // and any result already on screen — follows the window from here.
  syncVibrationRange();
}

// ---------------------------------------------------------------------------
// Vibration
// ---------------------------------------------------------------------------

/**
 * The mechanical-spectrum panel.
 *
 * A helicopter that vibrates cannot be tuned at all, and unlike stop evidence
 * this reads on any log: it needs a gyro column and nothing else. The engine
 * side is `summarizeMechanicalVibration`, which is the ONLY thing imported from
 * `src/analysis/advisor/` — everything below turns its states into words.
 *
 * **Measurements only.** Frequencies, amplitudes in degrees per second, how
 * persistent each tone was, and whether a rotor harmonic accounts for it. No
 * sentence here ranks an aircraft, and none names a setting.
 *
 * ## The distinction this panel exists to keep
 *
 * `peak.rotorHarmonic.state` has three values and only one is a measurement
 * about the rotor:
 *
 *   explained     a trustworthy rotor speed lines up on that order
 *   not-explained a rotor WAS compared, and does not account for the tone
 *   not-checked   nothing was compared
 *
 * Drawing `not-checked` like `not-explained` tells a pilot his main rotor is
 * ruled out on a window where its speed was never read, and sends him hunting
 * the tail, the frame or the servos. On the reference log that is the COMMON
 * case, not the corner one: the headspeed moves across the recording (relative
 * spread 0.93 against a 0.12 gate), so every peak on a whole-flight window comes
 * back `not-checked`. It gets its own grey pill, its own words, and a footnote
 * saying which rotors could not be read and why.
 */
const VIBRATION_STATUS = {
  clear: ['good', 'no persistent vibration above the attention threshold'],
  attention: ['warn', 'persistent vibration above the attention threshold'],
  insufficient: ['bad', 'not measured']
};

/**
 * Reason codes as sentences.
 *
 * Anything not listed still reaches the reader, as its raw code inside the
 * disclosure at the foot of the panel — a code a pilot can search for beats a
 * blank space, and beats this file guessing at wording for a state it has not
 * seen.
 */
const VIBRATION_REASONS = {
  INSUFFICIENT_TIMESTAMPED_SAMPLES:
    'this window holds too few timestamped samples to transform',
  INSUFFICIENT_CONTIGUOUS_GYRO_DATA:
    'the gyro data in this window is not contiguous enough to transform',
  FILTERED_GYRO_SOURCE_USED:
    'the only gyro in this log is the filtered one',
  UNFILTERED_GYRO_REQUIRED_FOR_CLEAR_GATE:
    'a filtered gyro cannot show that an aircraft is quiet, only that the filters worked',
  GYRO_FIELDS_MISSING: 'this log carries no gyro column for that axis',
  NON_MONOTONIC_TIMESTAMPS: 'the timestamps in this window go backwards',
  TIMING_GAPS_EXCESSIVE: 'the sampling in this window has gaps too large to transform across',
  SELECTION_DURATION_LIMIT_EXCEEDED: 'the selected window is longer than the analysis accepts',
  SELECTION_SAMPLE_LIMIT_EXCEEDED: 'the selected window holds more samples than the analysis accepts',
  SAMPLE_RATE_UNAVAILABLE: 'the sample rate of this window could not be established',
  PERSISTENT_NARROWBAND_ENERGY: 'a narrow tone was present for much of the window',
  PERSISTENT_NARROWBAND_ENERGY_BELOW_ATTENTION_THRESHOLD:
    'the narrow tones present were below the attention threshold',
  ROTOR_HARMONIC_CORRELATION_UNAVAILABLE: 'no rotor speed could be compared against',
  RPM_UNSTABLE_IN_SELECTION: 'the rotor speed moves too much across this window to compare against',
  RPM_OUT_OF_RANGE: 'the rotor speed readings are outside the range the analysis accepts',
  NO_VALID_RPM_IN_RANGE: 'the rotor was not turning usably in this window',
  // Deliberately about THIS LOG, not about the firmware. Rotorflight 4.6.0
  // carries no tailspeed column, but "this firmware never logs it" is an
  // inference drawn from one log — and the absence of the column is absence of
  // evidence about that rotor, not evidence the rotor is sound.
  FIELD_MISSING: 'this log carries no column for it',
  NOT_EVALUATED: 'it was not read on this window',
  GYRO_COVERAGE_INSUFFICIENT: 'too little of this window carries usable gyro data',
  VALID_WINDOW_COVERAGE_INSUFFICIENT: 'too few of the averaging windows were usable'
};

const reasonWords = code => VIBRATION_REASONS[code] ?? null;

/** `1478 rpm — the rotor speed moves too much…`, or just the reason. */
function rotorLine(name, rotor) {
  const parts = [];
  if (Number.isFinite(rotor.medianRpm)) {
    parts.push(`${Math.round(rotor.medianRpm).toLocaleString()} rpm median`);
  }
  if (Number.isFinite(rotor.fundamentalHz)) {
    parts.push(`${text(rotor.fundamentalHz, 1)} Hz fundamental`);
  }
  if (Number.isFinite(rotor.relativeSpread)) {
    parts.push(`spread ${text(rotor.relativeSpread, 3)}`);
  }
  const why = reasonWords(rotor.reasonCode);
  const tail = rotor.state === 'trustworthy'
    ? 'compared against every peak'
    : why ?? (rotor.reasonCode ? `not compared (${rotor.reasonCode})` : 'not compared');
  return `<li><b>${esc(name)}</b>: ${esc(tail)}${parts.length ? ` — ${esc(parts.join(', '))}` : ''}</li>`;
}

/** One peak's rotor verdict, as a pill plus the words that go with it. */
function peakRotorCell(harmonic) {
  if (harmonic.state === 'explained') {
    const delta = Number.isFinite(harmonic.deltaHz)
      ? `, ${text(Math.abs(harmonic.deltaHz), 1)} Hz off a predicted ${text(harmonic.predictedHz, 1)} Hz`
      : '';
    return {
      pill: pill('good', `${harmonic.rotor} ${harmonic.order}/rev`),
      detail: `A rotor speed was read on this window and its order ${harmonic.order} ` +
        `lands on this frequency${delta}.`
    };
  }
  if (harmonic.state === 'not-explained') {
    const missing = harmonic.unavailableRotors ?? [];
    return {
      pill: pill('warn', 'no rotor harmonic'),
      detail: 'Every rotor speed that could be read was compared, at every order ' +
        'up to eight, and none lands on this frequency.' +
        (missing.length
          ? ` Not compared: ${missing.map(rotor =>
              `${rotor.field} (${reasonWords(rotor.reasonCode) ?? rotor.reasonCode})`).join('; ')}.`
          : '')
    };
  }

  const missing = harmonic.unavailableRotors ?? [];
  return {
    pill: pill('none', 'rotor not checked'),
    detail: 'Nothing was compared against this frequency, so the rotors are neither ' +
      'blamed nor ruled out.' +
      (missing.length
        ? ` Not compared: ${missing.map(rotor =>
            `${rotor.field} (${reasonWords(rotor.reasonCode) ?? rotor.reasonCode})`).join('; ')}.`
        : '')
  };
}

function vibrationAxisBlock(axis) {
  const parts = [`<h3>${esc(axis.axis)} &mdash; <code>${esc(axis.gyroSource)}</code></h3>`];

  // 4. A filtered gyro publishes no peaks at all. An empty list under a heading
  //    reads as a quiet aircraft, which is the opposite of what it means.
  if (axis.amplitudeKind === 'filtered-gyro-output' || axis.gyroSource === 'gyroADC-filtered') {
    parts.push(`<p class="muted" style="font-size:12.5px">These samples came out of the ` +
      `flight controller's filter chain, so whatever the airframe produced was removed ` +
      `before it could be measured. No peaks are published from a filtered gyro and this ` +
      `axis cannot read as clear — an empty list here is a missing measurement, not a ` +
      `quiet aircraft.</p>`);
  }

  if (!axis.available) {
    const why = reasonWords(axis.reasonCode);
    parts.push(`<p style="font-size:13.5px">${pill('bad', 'not measured')} ` +
      `Nothing was measured on this axis${why ? ` — ${esc(why)}` : ''}.</p>`);
    return parts.join('');
  }

  parts.push('<div class="grid" style="margin-top:10px">' + [
    stat('Broadband', `${text(axis.broadbandRmsDps)}&deg;/s`,
      'RMS across the analysed band'),
    stat('Persistent tones', String(axis.peaks.length),
      axis.peaks.length === 0 ? 'none stood out of the noise floor' : 'listed below')
  ].join('') + '</div>');

  if (axis.peaks.length === 0) {
    return parts.join('');
  }

  parts.push('<ul class="peaks">' + axis.peaks.map(peak => {
    const rotor = peakRotorCell(peak.rotorHarmonic);
    return `<li>
      <span class="hz">${text(peak.frequencyHz, 1)} Hz</span>
      <span class="amp">${text(peak.amplitudeDps)}&deg;/s</span>
      <span class="amp">present ${Math.round((peak.persistenceRatio ?? 0) * 100)}% of the window</span>
      ${rotor.pill}
      ${peak.aboveAttentionThreshold ? pill('warn', 'above the attention threshold') : ''}
      <span class="detail">${esc(rotor.detail)}</span>
    </li>`;
  }).join('') + '</ul>');

  return parts.join('');
}

/**
 * Turns one `summarizeMechanicalVibration` result into the panel's HTML.
 *
 * Pure, and exported for that reason: every state below is reachable from a
 * hand-built view object in a test, including the ones no fixture in this repo
 * produces.
 */
export function vibrationHtml(view) {
  const [kind, label] = VIBRATION_STATUS[view.status] ?? ['warn', view.status];
  const seconds = (view.range.durationUs ?? 0) / 1e6;

  const parts = [
    `<p style="font-size:13.5px">${pill(kind, label)}</p>`
  ];

  // 2. "insufficient" means nothing was measured. It must never read like
  //    "clear", which means vibration WAS measured and there was none.
  if (view.status === 'insufficient') {
    parts.push(`<p style="font-size:13.5px">Nothing was measured on this window. That is ` +
      `not the same as a quiet aircraft — it is the absence of a measurement, and it says ` +
      `nothing either way about how this helicopter runs.</p>`);
  }

  parts.push(`<p class="muted" style="font-size:12.5px">` +
    `${text(seconds, 1)} s of flight, ` +
    `${(view.range.sampleCount ?? 0).toLocaleString()} samples.` +
    (Array.isArray(view.analyzedBandHz)
      ? ` Analysed from ${text(view.analyzedBandHz[0], 0)} to ` +
        `${text(view.analyzedBandHz[1], 0)} Hz.`
      : '') +
    // 5. Content above the fold frequency did not vanish, it folded down INTO
    //    the band. A reader who thinks it was excluded will read a mirrored
    //    tone as a real one at a frequency nothing on the aircraft turns at.
    (Number.isFinite(view.aliasingFoldFrequencyHz)
      ? ` Anything faster than ${text(view.aliasingFoldFrequencyHz, 0)} Hz was not excluded ` +
        `from that band — it folded down into it, and appears at a frequency it does not ` +
        `really have.`
      : '') +
    `</p>`);

  // 3. The threshold is one experimental scalar, calibrated on synthetic
  //    fixtures. It is not a pass mark and nobody official set it, so it never
  //    appears without saying so.
  parts.push(`<p class="muted" style="font-size:12.5px">Attention threshold: ` +
    `<b>${text(view.attentionThreshold.bandRmsDps)}&deg;/s</b> band RMS ` +
    `(${esc(view.attentionThreshold.basis)}). ` +
    `${view.attentionThreshold.officialLimit
      ? 'This is a published limit.'
      : 'This is not a published limit and not a pass mark. It is an experimental ' +
        'number this app calibrated on synthetic signals, shown so the word ' +
        '"threshold" cannot be read as a rule from Rotorflight or anyone else.'}</p>`);

  const coverage = view.axes.map(axis => axis.windowCoverageRatio).find(Number.isFinite);
  if (Number.isFinite(coverage) && coverage < 1) {
    parts.push(`<p class="muted" style="font-size:12.5px">The averaging covered ` +
      `${Math.round(coverage * 100)}% of this window: past roughly 33 s of selection the ` +
      `average samples the window instead of covering it, so a tone confined to a stretch ` +
      `it skipped is not in these numbers. A shorter window covers everything in it.</p>`);
  }

  parts.push('<h3>Rotor speeds available to compare against</h3>');
  parts.push('<ul class="reasons" style="font-size:13px">' +
    rotorLine('Main rotor', view.rotorCorrelation.headspeed) +
    rotorLine('Tail rotor', view.rotorCorrelation.tailspeed) +
    '</ul>');

  for (const axis of view.axes) {
    parts.push(vibrationAxisBlock(axis));
  }

  const anyUnchecked = view.axes.some(axis =>
    axis.peaks.some(peak => peak.rotorHarmonic.state === 'not-checked'));
  if (anyUnchecked) {
    parts.push(`<p class="boundary">"Rotor not checked" is not "rotor ruled out". It means ` +
      `no rotor speed was compared against these frequencies — either the log carries no ` +
      `column for one, or it moved too much across this window to compare against. Nothing ` +
      `here points away from the head, or towards the tail, the frame or the servos. If the ` +
      `log does carry a headspeed, zooming the plot into a stretch where it holds steady ` +
      `and measuring again turns this into an answer.</p>`);
  }

  // Reworded 12 August 2026 with the reversal at the head of this file. This
  // PANEL is still measurements only — it names frequencies and amplitudes and
  // ranks nothing — and saying so is what lets a reader check the airframe
  // finding at the top of the page against it. What it no longer claims is that
  // the app as a whole withholds advice, which is now false.
  parts.push(`<p class="boundary">These are measurements of the window on screen: ` +
    `frequencies, how big each one is, and whether a rotor accounts for it. Nothing in ` +
    `this panel ranks your helicopter or names a setting. The airframe finding at the top ` +
    `of the page is built from numbers like these, and this is where you check it.</p>`);

  if (view.reasonCodes.length > 0) {
    parts.push(`<details class="help"><summary>Why the analysis said what it said ` +
      `(${view.reasonCodes.length} code${view.reasonCodes.length === 1 ? '' : 's'})</summary>` +
      '<div><ul class="codes">' +
      view.reasonCodes.map(code => {
        const why = reasonWords(code);
        return `<li><code>${esc(code)}</code>${why ? ` — ${esc(why)}` : ''}</li>`;
      }).join('') +
      '</ul></div></details>');
  }

  return parts.join('');
}

/**
 * Runs the analysis on the window the plot is showing.
 *
 * ## Why on demand, and why one yield
 *
 * Timed on the reference log (Rotorflight 4.6.0, 133.5 s, 134 429 samples), and
 * measured rather than estimated — see `test/ui-browser.test.mjs`, which fails
 * if it regresses by an order of magnitude. It is tens of milliseconds for a
 * 30 s window on a desktop and several times that in a phone WebView, which is
 * fine under a deliberate tap and would be a visible hitch on every axis change
 * or pan. So: a button.
 *
 * The one `requestAnimationFrame` before the call exists so the "Measuring…"
 * state actually paints before the main thread is taken. It is deliberately NOT
 * `cooperativeYield: true`, which awaits `setTimeout` between chunks: RN and
 * WebView timers do not fire while an Android Activity is backgrounded, so a
 * chunked run would stall forever behind a spinner. One frame in the foreground,
 * then a single blocking pass, is the honest trade — if the app is backgrounded
 * before that frame, the measurement simply has not started yet.
 *
 * If this ever needs to be quicker than a tap it belongs in a Worker: the result
 * is plain JSON by construction and survives `postMessage` unchanged.
 */
let vibrationRun = 0;
/** The window a displayed result was measured on, so a pan can retire it. */
let vibrationShownFor = null;

function vibrationWindow() {
  const {startUs, spanUs} = state.view;
  const cap = MECHANICAL_CONSTANTS.maximumSelectionDurationUs;
  const requested = Math.max(0, spanUs);
  return {
    startTimeUs: startUs,
    endTimeUs: startUs + Math.min(requested, cap),
    clamped: requested > cap,
    requestedUs: requested
  };
}

function resetVibration() {
  vibrationRun += 1;
  vibrationShownFor = null;
  $('vibration').innerHTML = '';
  syncVibrationRange();
}

/**
 * Keeps the label honest, and retires a result whose window has moved.
 *
 * The heading says "in the visible window", so leaving numbers on screen after a
 * pan would attach a real measurement to a stretch of flight it was not taken
 * on. Called from `drawAxisPlot`, which is the one place the window changes.
 */
function syncVibrationRange() {
  const range = $('vibration-range');
  const button = $('vibration-run');

  if (!state.axisSignals?.usable || !(state.view.spanUs > 0)) {
    range.textContent = '';
    button.disabled = true;
    return;
  }

  button.disabled = false;
  const window_ = vibrationWindow();

  if (vibrationShownFor
      && (vibrationShownFor.startTimeUs !== window_.startTimeUs
        || vibrationShownFor.endTimeUs !== window_.endTimeUs)) {
    vibrationRun += 1;
    vibrationShownFor = null;
    $('vibration').innerHTML =
      '<p class="muted">The window moved. Measure again for what is on screen now.</p>';
  }

  // Whether the plot has been panned away from the flight window matters here:
  // the airframe finding at the top of the page was measured over the window,
  // and a vibration result taken somewhere else is a different measurement.
  const flight = state.window;
  const offWindow = Number.isFinite(flight?.startUs)
    && (Math.abs(window_.startTimeUs - flight.startUs) > 1000
      || Math.abs(window_.endTimeUs - flight.endUs) > 1000);

  range.textContent =
    `${((window_.endTimeUs - window_.startTimeUs) / 1e6).toFixed(1)} s of flight` +
    (window_.clamped
      ? `, clipped from ${(window_.requestedUs / 1e6).toFixed(1)} s — longer than the ` +
        'analysis accepts, so only the first part would be measured'
      : '') +
    (offWindow
      ? ' — not the flight window, so this will not be the same measurement the airframe '
        + 'finding at the top of the page was made from'
      : '');
}

/**
 * Measures vibration, holding the session it started on for the whole run.
 *
 * This wrapper is not ceremony. `releaseFrames()` empties a session IN PLACE,
 * so anything holding one across an `await` can have it gutted underneath —
 * which is exactly how the recommendation path produced "Cannot read properties
 * of null (reading 'length')" and a blank screen on a phone.
 *
 * This path already had a cancellation token, and that is NOT sufficient on its
 * own: cancellation is cooperative and checked at yield points, so a session
 * evicted between two checks is read after it has been emptied. Marking the
 * analysis in flight is what actually stops the eviction pass letting it go.
 *
 * Found by auditing every `await` that holds a session, after the same defect
 * was fixed one screen over. See `releaseFrames` in src/blackbox/decode.mjs.
 */
async function runVibration() {
  const index = state.sessionIndex;
  analysisStarted(index);
  try {
    return await measureVibration();
  } finally {
    analysisFinished(index);
    evictDecodedSessions(state.sessionIndex);
  }
}

async function measureVibration() {
  const session = currentSession();
  const box = $('vibration');
  const token = vibrationRun += 1;
  const window_ = vibrationWindow();

  if (!(window_.endTimeUs > window_.startTimeUs)) {
    box.innerHTML = '<p class="muted">There is no window to measure.</p>';
    return;
  }

  box.innerHTML = '<p class="muted">Measuring…</p>';
  $('vibration-run').disabled = true;

  // Let the line above paint before the main thread goes away. See the note on
  // this function for why this is one yield and not a chunked one.
  //
  // Raced, not chosen: a frame callback does not fire in a throttled or
  // offscreen page, and a timer does not fire on a backgrounded Android
  // Activity. Whichever one the host still services wins. When the app is
  // backgrounded neither does, which leaves the measurement not yet started
  // rather than half-done behind a spinner that will never move.
  await new Promise(resolve => {
    let settled = false;
    const go = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    requestAnimationFrame(go);
    setTimeout(go, 50);
  });

  const started = performance.now();
  let view;
  try {
    view = await summarizeMechanicalVibration(session, {
      timeRangeUs: {startTimeUs: window_.startTimeUs, endTimeUs: window_.endTimeUs},
      isCancelled: () => token !== vibrationRun,
      cooperativeYield: false
    });
  } catch (error) {
    if (token !== vibrationRun) {
      return; // superseded by a newer run; its result is the one that matters
    }
    // Every fact about the log comes back as data. Reaching here is a caller
    // bug, and saying "insufficient" for one would hide a broken screen behind
    // a safety-shaped word.
    box.innerHTML = `<p class="error">The vibration analysis could not be run: ` +
      `${esc(error.message)}</p>`;
    $('vibration-run').disabled = false;
    return;
  }

  if (token !== vibrationRun) {
    return;
  }

  const elapsed = Math.round(performance.now() - started);
  vibrationShownFor = {startTimeUs: window_.startTimeUs, endTimeUs: window_.endTimeUs};
  box.innerHTML = vibrationHtml(view) +
    `<p class="muted" style="font-size:12px;margin-top:10px">Measured on this device in ` +
    `${elapsed} ms.</p>`;
  $('vibration-run').disabled = false;
}

// ---------------------------------------------------------------------------
// Any-signal plot
// ---------------------------------------------------------------------------

/**
 * Draws one field against time.
 *
 * Logs run to hundreds of thousands of samples, so each pixel column is reduced
 * to the min and max of the samples behind it. Plotting every point would be
 * slower and would still hide spikes — the extremes are the interesting part.
 */
function renderPlot() {
  const session = currentSession();
  // Reached straight from the field picker's `change` handler, so it must
  // survive being asked to draw with no log open.
  if (!session?.samples) {
    $('plot-caption').textContent = 'No samples to draw.';
    return;
  }

  const canvas = $('plot');
  const fieldIndex = Number($('field').value);
  const samples = session.samples;
  const {context, cssWidth, cssHeight, ratio} = prepareCanvas(canvas);

  if (samples.length === 0 || Number.isNaN(fieldIndex)) {
    $('plot-caption').textContent = 'No samples to draw.';
    return;
  }

  const trace = decimate(samples, fieldIndex, 0, samples.length - 1,
    Math.max(1, Math.round(cssWidth * ratio)));

  if (trace.empty) {
    $('plot-caption').textContent = 'This field has no finite samples.';
    return;
  }

  let low = trace.low;
  let high = trace.high;
  if (low === high) {
    low -= 1;
    high += 1;
  }
  const pad = (high - low) * 0.08;
  low -= pad;
  high += pad;
  const toY = value => cssHeight - ((value - low) / (high - low)) * cssHeight;

  // Zero line first, so it reads as a reference rather than data.
  if (low < 0 && high > 0) {
    context.strokeStyle = '#2a323d';
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(0, toY(0));
    context.lineTo(cssWidth, toY(0));
    context.stroke();
  }

  context.strokeStyle = '#4aa8ff';
  context.lineWidth = 1;
  context.beginPath();
  for (let column = 0; column < trace.columns; column += 1) {
    if (!Number.isFinite(trace.min[column])) {
      continue;
    }
    const x = (column / trace.columns) * cssWidth;
    context.moveTo(x, toY(trace.min[column]));
    context.lineTo(x, toY(trace.max[column]));
  }
  context.stroke();

  // This panel deliberately draws the WHOLE recording — it is the raw browser,
  // and the spool-up is often the thing being looked at. What it must not do is
  // let a reader take a number off a stretch of flight that no measurement on
  // the page includes, so the ends outside the window are dimmed here too.
  const timeIndex = timeIndexOf(session);
  const window_ = state.window;
  let dimmed = false;
  if (timeIndex !== -1 && Number.isFinite(window_?.logDurationUs) && window_.logDurationUs > 0) {
    const toX = timeUs => ((timeUs - window_.logStartUs) / window_.logDurationUs) * cssWidth;
    const startX = Math.max(0, Math.min(cssWidth, toX(window_.startUs)));
    const endX = Math.max(0, Math.min(cssWidth, toX(window_.endUs)));
    context.fillStyle = 'rgba(14,17,22,0.74)';
    if (startX > 0) {
      context.fillRect(0, 0, startX, cssHeight);
      dimmed = true;
    }
    if (endX < cssWidth) {
      context.fillRect(endX, 0, cssWidth - endX, cssHeight);
      dimmed = true;
    }
  }

  const name = session.fields[fieldIndex]?.name ?? `field ${fieldIndex}`;
  $('plot-caption').textContent =
    `${name} — range ${low.toFixed(1)} to ${high.toFixed(1)} over ` +
    `${samples.length.toLocaleString()} samples, the whole recording` +
    (dimmed ? '. The dimmed ends are outside the flight window' : '');
}

// ---------------------------------------------------------------------------
// Tune evidence
// ---------------------------------------------------------------------------

/**
 * Records for one axis, over the flight window.
 *
 * Two shapes come back from here historically — `buildAnalysisRecords` returns
 * `{records, usable, missing}` while `collectRecommendationMaterial` caches the
 * bare array — so this normalises both rather than letting the caller guess.
 */
function ensureRecords(axis) {
  if (Array.isArray(state.records) && state.recordsAxis === axis) {
    return {records: state.records, usable: true, missing: state.recordsMissing ?? []};
  }

  // No log open, or one whose frames could not be read. Every caller already
  // handles `usable: false`; reaching `buildAnalysisRecords` with nothing would
  // throw inside a click handler instead, where nobody sees it.
  const scoped = windowedSession();
  if (!scoped) {
    state.records = null;
    state.recordsAxis = null;
    state.recordsMissing = [];
    return {records: [], usable: false, missing: []};
  }

  const built = buildAnalysisRecords(scoped, {axis});
  state.records = built.usable ? built.records : null;
  state.recordsAxis = built.usable ? axis : null;
  state.recordsMissing = built.missing;
  return built;
}

function codeList(codes, label = 'Machine codes') {
  if (!codes || codes.length === 0) {
    return '';
  }
  return `<details class="help"><summary>${esc(label)}</summary><div>` +
    `<ul class="codes">${codes.map(code => `<li><code>${esc(code)}</code></li>`).join('')}</ul>` +
    `</div></details>`;
}

/**
 * What this panel is, and what it is not.
 *
 * NOT `brief.boundary`, and that is a deliberate change made on 12 August 2026.
 * `describeStopCapture` and `describeHoldCapture` in
 * `src/analysis/axis-report.mjs` still end their boundary sentence with
 * "RotorLens does not tell you what to change", which stopped being true of this
 * product on that date. Printing it twelve lines below a panel that says "Lower
 * yaw D" would make one of the two a lie, and the engine's file is not this
 * one's to edit — see the handoff note. The true half of that sentence, which is
 * what a measurement panel is FOR, is kept here.
 */
const MEASUREMENT_BOUNDARY =
  'Everything above is a measurement of the flight window, and the manoeuvre below is how '
  + 'to record a flight that can be measured further. Neither is the recommendation: that '
  + 'is at the top of the page, and these are the numbers it was built from so you can '
  + 'disagree with it. RotorLens never writes to a flight controller.';

function manoeuvreBlock(brief, open) {
  // A null brief means the log is what is missing, not the flight. Offering a
  // manoeuvre there would send someone up to record the same gap again.
  if (!brief) {
    return `<p class="boundary">${esc(MEASUREMENT_BOUNDARY)}</p>`;
  }
  return `<p class="boundary">${esc(MEASUREMENT_BOUNDARY)}</p>
    <details class="help"${open ? ' open' : ''}><summary>${esc(brief.title)}</summary><div>
      <ol class="brief">${brief.steps.map(step => `<li>${esc(step)}</li>`).join('')}</ol>
      <p class="muted" style="font-size:12.5px;margin-top:10px">${esc(brief.note)}</p>
    </div></details>`;
}

function reasonList(refusals) {
  if (refusals.length === 0) {
    return '';
  }
  return `<h3>Where they were refused</h3><ul class="reasons">${
    refusals.map(refusal =>
      `<li>${esc(refusal.count)}&times; — ${esc(refusal.text)} <span class="muted">` +
      `(<code>${esc(refusal.code)}</code>)</span></li>`
    ).join('')
  }</ul>`;
}

const STOP_STATE_PILL = {
  captured: ['good', 'captured'],
  partial: ['warn', 'not enough yet'],
  rejected: ['warn', 'no clean release'],
  absent: ['warn', 'not flown in this log'],
  unavailable: ['bad', 'not in this log']
};

function directionalTable(evidence, axis, highlight) {
  const rows = ['positive', 'negative'].map(direction => {
    const summary = evidence.directions[direction] ?? {};
    const cell = (metric, digits = 2) =>
      `<td class="num"${metric === highlight ? ' style="color:var(--text);font-weight:600"' : ''}>` +
      `${text(summary[metric], digits)}</td>`;
    return `<tr>
      <td>${esc(directionWord(axis, direction))}</td>
      <td class="num">${summary.directionEventCount ?? 0}</td>
      ${cell('trackingRmsDps')}
      ${cell('fastRingingRmsDps')}
      ${cell('slowOscillationRmsDps')}
    </tr>`;
  }).join('');

  return `<div class="scroll"><table>
      <tr><th>Direction</th><th class="num">Stops</th><th class="num">Tracking RMS &deg;/s</th>
          <th class="num">Fast ringing &deg;/s</th><th class="num">Slow oscillation &deg;/s</th></tr>
      ${rows}
    </table></div>
    <p class="muted" style="font-size:12.5px;margin-top:10px">Directions are never pooled.
      A single-rotor tail works with main-rotor torque one way and against it the other,
      so one number would describe neither.</p>`;
}

/**
 * Whether the gap between the two directions is large enough to say out loud.
 *
 * **The threshold is the engine's, not this file's.** Until 12 August 2026 the
 * view carried its own `ratio >= 1.2`, invented here, on a different scale from
 * the engine's. Mutating that literal to `1e9` or to `1.0` left all 225 tests
 * green, and on the reference log it printed "Measured 1.4× higher …" for yaw P
 * from a gap that `buildDirectionalStopEvidence` had simultaneously classified
 * as NOT asymmetric — `directionalAsymmetryWarnRatio` is 0.30 on the
 * `|p − n| / max(|p|, |n|)` scale, which is 1.43× on the max/min scale the
 * sentence quotes. A caveat kept it from being dangerous; it was still a tuned
 * constant sitting between a measurement and a pilot, decided by the view.
 *
 * So the decision is read straight off the evidence object. `evidence.asymmetry`
 * is computed by the engine for every directional metric, on the engine's scale,
 * and compared against the engine's own gate. The numbers themselves are never
 * suppressed — the two per-direction stats and the full table render either way.
 * What is gated is the CLAIM that the two directions differ.
 *
 * @param {object} evidence a `buildDirectionalStopEvidence` result
 * @param {string} metric one of the engine's directional metrics
 */
export function asymmetryIsReportable(evidence, metric) {
  const gap = evidence?.asymmetry?.[metric];
  return Number.isFinite(gap) && gap > EVIDENCE_LIMITS.directionalAsymmetryWarnRatio;
}

/**
 * The asymmetry sentence, or an empty string when the engine will not claim one.
 *
 * Exported so the browser test can walk the gap across the gate and watch the
 * sentence appear exactly where the engine says it should, rather than asserting
 * that a number in this file equals a number in this file.
 */
export function asymmetryNote(axis, metric, evidence, observation, needed) {
  if (!observation || !Number.isFinite(observation.ratio)) {
    return '';
  }
  if (!asymmetryIsReportable(evidence, metric)) {
    return '';
  }

  const provenance = observation.provisional
    ? `, from ${observation.positiveCount === observation.negativeCount
        ? `${observation.positiveCount} stop${observation.positiveCount === 1 ? '' : 's'} each way`
        : `${observation.positiveCount} and ${observation.negativeCount} stops`}. ` +
      `Fly ${needed} each way to see whether it holds.`
    : '.';

  return `<p style="font-size:13.5px;margin-top:12px">Measured ` +
    `<b>${text(observation.ratio, 1)}&times;</b> higher ` +
    `${esc(directionWord(axis, observation.higher))} than the other way${provenance}</p>`;
}

/**
 * The P and D view.
 *
 * P and D used to render byte-identical output, which teaches a pilot the
 * controls do nothing on the one screen that has to earn his trust. They differ
 * here by which measured quantity is put in front: tracking error while the
 * command is held for P, fast ringing after the release for D. Neither says
 * whether a number is high or low — where a term is visible is a property of the
 * loop, not a suggestion about a gain.
 */
export function renderStopEvidence(axis, term, diagnostics, evidence, summary) {
  const view = TERM_VIEWS[term] ?? TERM_VIEWS.P;
  const brief = describeStopCapture(diagnostics, {axis, summary});
  const [kind, label] = STOP_STATE_PILL[brief.state] ?? ['warn', brief.state];

  const parts = [
    `<h3>${esc(view.metricLabel)} ${pill(kind, label)}</h3>`,
    `<p class="muted" style="font-size:13px">${esc(view.description)}</p>`
  ];

  // Progress against a target is meaningless when the axis is not in the log.
  if (brief.state !== 'unavailable') {
    parts.push(`<p class="progress">Captured: <b>${brief.captured.positive} of ${brief.needed}</b> ` +
      `${esc(directionWord(axis, 'positive'))}, <b>${brief.captured.negative} of ${brief.needed}</b> ` +
      `${esc(directionWord(axis, 'negative'))}.</p>`);
  }
  parts.push(`<p style="font-size:13.5px">${esc(brief.headline)}</p>`);

  if (brief.state === 'captured' || brief.state === 'partial') {
    const observations = directionalObservations(evidence, [view.metric, ...view.supporting]);
    const headline = observations.find(observation => observation.metric === view.metric);

    parts.push('<div class="grid" style="margin-top:12px">' +
      ['positive', 'negative'].map(direction => {
        const summaryFor = evidence.directions[direction] ?? {};
        return stat(directionWord(axis, direction),
          `${text(summaryFor[view.metric])}&deg;/s`,
          `${summaryFor.directionEventCount ?? 0} stop${summaryFor.directionEventCount === 1 ? '' : 's'}`);
      }).join('') + '</div>');

    parts.push(asymmetryNote(axis, view.metric, evidence, headline, brief.needed));

    parts.push(directionalTable(evidence, axis, view.metric));
  }

  parts.push(reasonList(brief.refusals));
  parts.push(manoeuvreBlock(brief.manoeuvre, brief.state !== 'captured'));
  parts.push(codeList(evidence.codes));

  return parts.join('');
}

/**
 * The I view.
 *
 * Deliberately reports the measured quantities and not a direction. The engine's
 * `interpretHoldEvidence` returns `increase`/`decrease`, and this panel used to
 * render those as "suggests more I" and "suggests less I" twelve lines above a
 * sentence reading "This is a measurement, not an instruction". Both could not be
 * true, and on the reference flight the badge was wrong: an aircraft with 1.47
 * deg/s of steady error was told at medium confidence to reduce its I term, on
 * the strength of least-squares slopes fitted over half-second holds. Numbers a
 * pilot can check beat a badge he cannot.
 */
function renderHoldEvidence(axis, evidence) {
  const brief = describeHoldCapture(evidence, {axis});
  const badge = evidence.status === 'captured'
    ? pill('good', 'captured')
    : pill('warn', brief.state === 'absent' ? 'not flown in this log' : 'not enough yet');

  const parts = [
    `<h3>Steady-state error during a hold ${badge}</h3>`,
    `<p class="muted" style="font-size:13px">${esc(TERM_VIEWS.I.description)}</p>`,
    `<p style="font-size:13.5px">${esc(brief.headline)}</p>`
  ];

  if (evidence.summary) {
    const summary = evidence.summary;
    parts.push('<div class="grid" style="margin-top:12px">' + [
      stat('Holds measured', String(summary.holdCount),
        `${text(summary.totalMeasuredDurationUs / 1e6, 1)} s of steady state in total`),
      stat('Steady error', `${text(summary.meanAbsoluteSteadyStateErrorDps)}&deg;/s`,
        'how far the rate sat from the commanded one'),
      stat('Worst hold', `${text(summary.worstAbsoluteSteadyStateErrorDps)}&deg;/s`),
      stat('Error drift', `${text(summary.meanErrorDriftDpsPerSecond)}&deg;/s²`,
        'whether that error was still moving'),
      stat('Slow ripple', `${text(summary.meanErrorRippleRmsDps)}&deg;/s`,
        `crossing its own mean ${text(summary.meanErrorCrossingRateHz)} times a second`),
      stat('Fast content', `${text(summary.meanErrorNoiseRmsDps)}&deg;/s`,
        'noise and vibration, reported apart from the slow ripple')
    ].join('') + '</div>');
  }

  // Unconditional, and deliberately so. REWORDED 12 August 2026 with the
  // reversal at the head of this file. The app now does name a direction for
  // the I term — at the top of the page, once, and only when the engine's
  // sweeps agree across every measurement window they are re-derived over.
  //
  // This panel still carries no badge of its own, and that has not changed for
  // the original reason: a badge here would be a SECOND opinion on the same
  // evidence reached by a different route, and the one that used to sit here was
  // wrong on the reference flight — 1.47 deg/s of steady error called "reduce
  // I" at medium confidence, from least-squares slopes fitted over half-second
  // holds. Two answers from one flight is worse than one.
  parts.push(`<p class="muted" style="font-size:12.5px;margin-top:12px">
    These are the raw hold measurements, with no verdict of their own. Any I-term
    recommendation is made once, at the top of the page, from these numbers — and only
    when it survives being re-derived across every measurement window the engine tries.
    RotorLens never writes to a flight controller.</p>`);

  if (brief.refusals.length > 0) {
    parts.push('<h3>Holds that were set aside</h3><ul class="reasons">' +
      brief.refusals.map(refusal =>
        `<li>${esc(refusal.count)}&times; — ${esc(refusal.text)} <span class="muted">` +
        `(<code>${esc(refusal.code)}</code>)</span></li>`
      ).join('') + '</ul>');
  }

  parts.push(manoeuvreBlock(brief.manoeuvre, evidence.status !== 'captured'));
  parts.push(codeList(evidence.codes));

  return parts.join('');
}

function analyse() {
  const axis = $('axis').value;
  const term = $('term').value;
  const {records, usable, missing} = ensureRecords(axis);

  if (!usable) {
    $('tune').innerHTML =
      `<p class="error">This log does not contain the signals needed to analyse ${esc(axis)}.</p>` +
      `<p class="muted" style="font-size:13px">Missing: ${esc(missing.join(', '))}.</p>` +
      `<p class="muted" style="font-size:12.5px">Enable the matching Blackbox debug ` +
      `fields on the flight controller and record another flight.</p>`;
    return;
  }

  const parts = [];
  if (missing.length > 0) {
    parts.push(`<p class="muted" style="font-size:12.5px">Not logged: ${esc(missing.join(', '))}. ` +
      `Some gates cannot be checked.</p>`);
  }

  const diagnostics = detectStopEvents(records, {axis, diagnostics: true});
  const events = diagnostics.events ?? [];

  // Draw where the detector looked, so "no evidence" is visible on the trace
  // rather than only asserted in prose.
  state.marks = [
    ...events.map(event => ({timeUs: event.stopTimeUs, accepted: true})),
    ...(diagnostics.candidates ?? [])
      .filter(candidate => candidate && !candidate.accepted)
      .map(candidate => ({timeUs: candidate.stopTimeUs, accepted: false, reason: candidate.reason}))
  ];
  state.marksAxis = axis;

  if (term === 'I') {
    parts.push(renderHoldEvidence(axis, buildHoldEvidence(records, {axis, term: 'I'})));
  } else {
    parts.push(renderStopEvidence(
      axis, term, diagnostics,
      buildDirectionalStopEvidence(events, {axis}),
      state.axisSummary
    ));
  }

  $('tune').innerHTML = parts.join('');
  drawAxisPlot();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const drop = $('drop');
const openPicker = () => requestFile(globalThis, () => $('file').click());

drop.addEventListener('click', openPicker);
drop.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openPicker();
  }
});

// Files pushed in by a native shell: a share, or an opened .bbl.
onHostFile(source => openFile(source));

// ...and the copy that has to finish before that event can be sent. Reading a
// full dataflash takes over two minutes; these are the only thing on screen for
// the whole of it.
onHostImportStarted(importStarted);
onHostImportProgress(importAdvanced);

// ...and imports the shell could not complete. Without this the user picks a
// file, the picker closes, and the screen does not change — which is
// indistinguishable from the app having frozen.
onHostFileFailed(({name, reason}) => {
  // A copy failure never reaches openFile(), so retire the previous flight here.
  // Otherwise its actionable cards remain live underneath an error naming a
  // different file.
  retireCurrentFile(name);
  hideImportProgress();
  const why = reason === 'no-file'
    ? 'That share contained text, not a file. Share the .bbl itself, or use the ' +
      'button above to pick it from storage.'
    : reason === 'too-large'
      ? 'This log is larger than the 128 MiB safe limit. Split or erase the ' +
        'dataflash in Rotorflight, then open one smaller recording.'
    : 'The file may be too large, or the app that shared it withdrew permission ' +
      'before the copy finished. Try copying the log to this device first.';

  show('status-panel');
  $('status').innerHTML =
    `<span class="error">RotorLens could not open ${esc(name)}.</span>` +
    `<p class="muted" style="font-size:13px">${why}</p>`;
});

if (hasNativeHost()) {
  // Drag and drop is meaningless on a phone, and the steps for getting a log off
  // the controller differ once the app can receive a share.
  drop.querySelector('span').textContent = 'or share a .bbl into RotorLens';
}

['dragenter', 'dragover'].forEach(name => {
  drop.addEventListener(name, event => {
    event.preventDefault();
    drop.classList.add('over');
  });
});
['dragleave', 'drop'].forEach(name => {
  drop.addEventListener(name, event => {
    event.preventDefault();
    drop.classList.remove('over');
  });
});
drop.addEventListener('drop', event => {
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    openFile(fromFile(file));
  }
});

$('file').addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (file) {
    openFile(fromFile(file));
  }
});

/**
 * Switching flights inside one dump.
 *
 * The new session's frames are read here and only here. A session opened before
 * and still held is shown without decoding anything again — see `openSession`,
 * and `state.frameDecodeCount`, which is what proves it.
 *
 * `beginDecodeProgress` is given the size of the SESSION rather than of the
 * file: the file is already open, and it is this flight's own bulk that decides
 * whether the wait is worth a word.
 */
$('session').addEventListener('change', async event => {
  const index = Number(event.target.value);
  beginDecodeProgress(state.fileName ?? '', sessionSpanBytes(index), 1);
  await openSession(index);
  endDecodeProgress();
  renderLogStatus();
});
$('field').addEventListener('change', renderPlot);
$('analyse').addEventListener('click', analyse);

$('axis').addEventListener('change', () => {
  // Dropping the old axis' records BEFORE building the new ones is load-bearing,
  // not tidiness: they are ~50 MiB on a mid-size log, and holding both at once
  // doubles that inside a WebView whose whole process may be capped at 192 MiB.
  // Do not "simplify" this away.
  state.records = null;
  state.recordsAxis = null;
  state.marks = [];
  state.marksAxis = null;
  if (!state.result) {
    return;
  }
  $('tune').innerHTML = '<p class="muted">Pick a term and analyse. The Axis panel above ' +
    'already measures this axis on whatever you flew.</p>';
  renderAxisPanel();

  // Recommendations are NOT recomputed on an axis change — they are one ordered
  // answer about the whole flight, not a per-axis view, and re-running seconds
  // of hold sweeps every time the picker moves would make the picker unusable.
  // The one exception is an axis the record budget left out: selecting it is
  // exactly the request to spend the budget on it instead.
  const skipped = state.recommendationCoverage?.skipped ?? [];
  if (skipped.some(entry => entry.axis === $('axis').value)) {
    runRecommendations();
  }
});

// ---- the flight window ----------------------------------------------------
// `input` fires continuously under a finger and only previews; `change` fires on
// release and is what re-measures the page. See `previewWindowFromSliders`.
for (const id of ['window-start', 'window-end']) {
  $(id).addEventListener('input', previewWindowFromSliders);
  $(id).addEventListener('change', () => {
    previewWindowFromSliders();
    commitWindowFromSliders();
  });
}

$('window-detect').addEventListener('click', () => {
  applyFlightWindow({detect: true});
});
$('window-whole').addEventListener('click', () => {
  const window_ = state.window;
  state.windowOverride = {startUs: window_.logStartUs, endUs: window_.logEndUs};
  applyFlightWindow();
});

$('axis-fit').addEventListener('click', () => {
  fitAxisView();
  drawAxisPlot();
});
$('vibration-run').addEventListener('click', () => {
  runVibration();
});
$('axis-in').addEventListener('click', () => zoomAxis(0.5));
$('axis-out').addEventListener('click', () => zoomAxis(2));
$('axis-prev').addEventListener('click', () => panAxis(-0.4));
$('axis-next').addEventListener('click', () => panAxis(0.4));

$('axis-scrub').addEventListener('input', event => {
  const {firstUs, lastUs, spanUs} = state.view;
  const travel = Math.max(0, (lastUs - firstUs) - spanUs);
  state.view.startUs = firstUs + travel * (Number(event.target.value) / 1000);
  clampAxisView();
  drawAxisPlot();
});

// Drag to pan. A phone has no scroll wheel and no keyboard, and a plot that can
// only be moved by buttons is a plot nobody navigates.
let drag = null;
const axisCanvas = $('axis-plot');
axisCanvas.addEventListener('pointerdown', event => {
  if (!state.axisSignals?.usable) {
    return;
  }
  drag = {x: event.clientX, startUs: state.view.startUs};
  axisCanvas.classList.add('dragging');
  axisCanvas.setPointerCapture(event.pointerId);
});
axisCanvas.addEventListener('pointermove', event => {
  if (!drag) {
    return;
  }
  const width = Math.max(1, axisCanvas.clientWidth - PLOT_PAD.left - PLOT_PAD.right);
  state.view.startUs = drag.startUs - (event.clientX - drag.x) / width * state.view.spanUs;
  clampAxisView();
  drawAxisPlot();
});
['pointerup', 'pointercancel'].forEach(name => {
  axisCanvas.addEventListener(name, () => {
    drag = null;
    axisCanvas.classList.remove('dragging');
  });
});

// ---- the flight history ---------------------------------------------------

// Delegated, because both panels re-render their buttons from scratch on every
// change and a listener attached to a button that has since been replaced is a
// Forget that silently stops working.
$('since').addEventListener('click', async event => {
  if (event.target.id === 'since-save') {
    await rememberCandidateFlight();
    return;
  }
  const recordId = event.target.dataset?.forgetFlight;
  if (recordId) {
    if (state.historyReadBlocked) {
      return;
    }
    const forgotten = await persistHistory(
      forgetFlight(state.history, recordId), {forget: true}
    );
    if (forgotten && state.candidateStoredId === recordId) {
      state.candidateStoredId = null;
    }
    if (forgotten) {
      await reconcileSharingIds();
    }
    renderSincePanel();
    renderHistoryPanel();
    renderSharingPanel();
    relearnFromHistory();
  }
});

$('history').addEventListener('click', async event => {
  if (state.historyReadBlocked) {
    return;
  }
  const flight = event.target.dataset?.forgetFlight;
  const aircraft = event.target.dataset?.forgetAircraft;
  if (!flight && !aircraft) {
    return;
  }

  const forgotten = await persistHistory(flight
    ? forgetFlight(state.history, flight)
    : forgetAircraft(state.history, aircraft), {forget: true});

  // A flight the pilot just saved and then deleted must offer Save again rather
  // than a Forget pointing at a record that no longer exists.
  if (forgotten && state.candidateStoredId !== null
      && findRecords(state.history, state.candidate?.aircraftKey)
        .every(record => record.recordId !== state.candidateStoredId)) {
    state.candidateStoredId = null;
  }

  if (forgotten) {
    await reconcileSharingIds();
  }
  renderHistoryPanel();
  renderSincePanel();
  // Forgetting the last flight of a helicopter takes its sharing identity with
  // it — see `reconcileSharingIds`. That happens here, in the same tap, or the
  // identity outlives the flights it was for.
  renderSharingPanel();
  relearnFromHistory();
});

/**
 * Forget everything, behind a second tap.
 *
 * Not a `confirm()`: this WebView has no WebChromeClient, so `window.confirm`
 * returns false without ever showing a dialog — the button would simply never
 * work on the one device this app ships to. A button that renames itself is
 * visible, reversible by walking away, and needs nothing from the host.
 */
let forgetAllArmed = null;

$('history-forget-all').addEventListener('click', async () => {
  const button = $('history-forget-all');
  if (forgetAllArmed === null) {
    button.textContent = 'Tap again to forget everything';
    forgetAllArmed = setTimeout(() => {
      forgetAllArmed = null;
      button.textContent = 'Forget everything';
    }, 5000);
    return;
  }

  clearTimeout(forgetAllArmed);
  forgetAllArmed = null;
  button.textContent = 'Forget everything';
  await forgetEverythingNow();
});

// Export: the whole file, as the plain text it is stored as, on screen where it
// can be read and copied. There is no network and no permission behind this —
// the point of an export the pilot can read is that they do not have to trust
// this description of what is stored.
$('history-export').addEventListener('click', () => {
  if (state.historyReadBlocked) {
    return;
  }
  const box = $('history-export-text');
  const hidden = box.classList.contains('hidden');
  box.textContent = hidden ? exportHistory(state.history ?? createHistory()) : '';
  show('history-export-text', hidden);
  $('history-export').textContent = hidden ? 'Hide export' : 'Export';
});

// ---- shared measurements --------------------------------------------------
//
// NOTHING BELOW SENDS ANYTHING. Every handler here writes a preference or a
// random identity to a file in this app's own private storage, or erases one.
// There is no request anywhere in this file.

$('consent-not-now').addEventListener('click', async () => answerConsent(false));
$('consent-share').addEventListener('click', async () => answerConsent(true));

// Escape is "not now", not "ask me again". A dialog that reappears because it
// was dismissed rather than answered is one people learn to tap through.
document.addEventListener('keydown', async event => {
  if (!state.consentOpen) {
    return;
  }
  if (event.key === 'Escape') {
    await answerConsent(false);
    return;
  }
  if (event.key === 'Tab') {
    const dialog = $('consent');
    const focusable = [...dialog.querySelectorAll(
      'button:not([disabled]), summary, a[href], input:not([disabled]), select:not([disabled])'
    )].filter(element => !element.closest('[hidden]'));
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey
        && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  }
});

// Android Back cannot synchronously inspect DOM state. MainActivity evaluates
// this hook and only navigates/finishes when it returns false.
globalThis.RotorLensHandleBack = () => {
  if (!state.consentOpen) {
    return false;
  }
  void answerConsent(false);
  return true;
};

// Delegated, like the history panel above it and for the same reason: this panel
// rebuilds its buttons on every change, and a listener bound to a button that
// has since been replaced is a control that silently stops working.
$('sharing').addEventListener('click', async event => {
  const target = event.target;

  if (target.id === 'sharing-toggle') {
    const current = state.sharing ?? createSharing();
    if (!current.sharing) {
      // The panel summarizes state; it does not contain the ownership/licence
      // grant. Enabling must show the complete versioned terms and wait for the
      // explicit Share answer rather than treating this tap as unseen consent.
      openConsent(target);
      return;
    }
    const written = await persistSharing({
      ...current,
      asked: true,
      sharing: false,
      termsVersion: null
    });
    if (written || !state.sharingStorePresent) {
      state.sharingCodes = [];
      await reconcileSharingIds();
    }
    renderSharingPanel();
    return;
  }

  const showKey = target.dataset?.shareShow;
  if (showKey) {
    state.sharingShown = state.sharingShown === showKey ? null : showKey;
    renderSharingPanel();
  }
});

/**
 * Erasing the identity, behind a second tap.
 *
 * Same mechanism as "Forget everything" and for the same reason: `confirm()`
 * returns false without ever showing a dialog in this WebView, so a button that
 * renames itself is the only confirmation available that actually appears.
 */
$('sharing').addEventListener('click', async event => {
  if (event.target.id !== 'sharing-forget') {
    return;
  }
  const button = event.target;
  if (button.dataset.armed !== 'true') {
    button.dataset.armed = 'true';
    button.textContent = 'Tap again to erase it';
    setTimeout(() => {
      // Only the exact button that was armed can be reset. A panel repaint
      // creates a fresh, unarmed control; a module-global timer previously left
      // that new button one tap away from deletion.
      if (button.isConnected && button.dataset.armed === 'true') {
        delete button.dataset.armed;
        button.textContent = 'Erase the sharing identity';
      }
    }, 5000);
    return;
  }

  delete button.dataset.armed;
  await eraseSharingIdentity();
});

// A rotation or a split-screen resize changes the element's width, and the
// backing store is sized from that width — without this the trace stays at the
// old resolution and stretches.
globalThis.addEventListener('resize', () => {
  if (state.result && state.axisSignals) {
    drawAxisPlot();
    renderPlot();
  }
  if (state.result && state.window) {
    // The strip's decimation is cached against the backing-store width, and a
    // resize changes it. Dropping it here is what stops the window markers
    // landing at the wrong times after a rotation.
    state.windowTrace = null;
    drawWindowPlot();
  }
});

// The one thing this page reads at start-up. In the app the bridge is installed
// before the document loads, so the history is on screen with the first paint.
void loadHistory();

export {openFile, state};
