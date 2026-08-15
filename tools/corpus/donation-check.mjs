/**
 * The gate a donated log has to pass before it may be published.
 *
 * WHY THIS IS A SEPARATE CHECK FROM EVERYTHING ELSE. The decoder never emits a
 * coordinate — `GPS_coord[0..1]` and `GPS_home[0..1]` are decoded because the
 * frame is one packed group and skipping a field would desynchronize the rest,
 * and are then dropped on the floor. That is a promise about what RotorLens
 * READS. It says nothing about what a donated FILE contains, and a `.bbl`
 * committed to this repository is the file, not the reading of it. Somebody's
 * home coordinate would sit in it, in the open, in a public git history, forever.
 *
 * `docs/FIXTURE_POLICY.md` already sets the standard: written permission, never
 * with GPS intact. This module is that standard as something a command can
 * answer, because a rule that is remembered is a rule that is eventually
 * forgotten by somebody in a hurry.
 *
 * IT FAILS CLOSED, AND THAT IS THE WHOLE DESIGN. The check refuses whenever it
 * cannot PROVE the absence of a position frame — an unreadable header, a frame
 * stream that stopped early, a session it could not scan to the end. A location
 * check that passes because it could not look is worse than no check, because it
 * produces a green line beside a file nobody then examines.
 *
 * IT NEVER READS A COORDINATE TO DECIDE. The verdict turns on whether a position
 * FRAME was recorded, counted by frame type. That is deliberate: deciding "the
 * coordinates in this log happen to be zero, so it is fine" would mean surfacing
 * coordinates in order to clear a log of carrying them, and the first tool to do
 * that is the tool that leaks one.
 */

import {FrameType, parseSession, findSessionStarts} from '../../src/blackbox/headers.mjs';
import {FrameDecoder} from '../../src/blackbox/frames.mjs';
import {TAIL_TOLERANCE_BYTES} from '../../src/blackbox/log-integrity.mjs';

export const DONATION_CHECK_KIND = 'rotorlens-donation-check';
export const DONATION_CHECK_SCHEMA_VERSION = 1;

/** The sidecar a donation must carry, one field per `docs/FIXTURE_POLICY.md`. */
export const DONATION_METADATA_FIELDS = Object.freeze({
  originalFilename:
    'the name the donor sent, so a question about this file can be asked in the donor\'s own terms',
  sha256:
    'the immutable identity of the bytes. Checked against the file, so a metadata block cannot drift onto a different log',
  byteLength:
    'the second half of that identity, and the cheap check that catches a truncated copy',
  source:
    'who supplied it. A fixture with no owner cannot be withdrawn when the owner asks',
  acquired:
    'the exact source revision or the acquisition date, so a third-party fixture is pinned rather than floating',
  permission:
    'the licence or the written permission that allows use AND redistribution. This is the field the whole policy exists for',
  firmware:
    'the declared firmware family and version, so a compatibility claim can name what it was tested against',
  identifyingFieldsPresent:
    'whether GPS or other identifying fields are present, declared by the donor rather than discovered later. Checked against what the log actually contains',
  redaction:
    'any transformation performed, or "none". A redacted fixture whose redaction is undocumented is a fixture nobody can verify'
});

/**
 * Header field names that are a place rather than a flight.
 *
 * The same pattern `src/blackbox/headers.mjs` uses to set
 * `locationFieldsDeclared`; restated as an explicit list here so that this check
 * names the fields it found rather than reporting a bare boolean.
 */
const LOCATION_FIELD_PATTERN = /^(gps|home)/i;

function refusal(code, detail) {
  return {severity: 'refuse', code, detail};
}

function warning(code, detail) {
  return {severity: 'warn', code, detail};
}

/**
 * Scans one log for recorded position data.
 *
 * @param {Uint8Array} bytes
 * @returns {{sessions: object[], scanComplete: boolean, failures: object[]}}
 */
export function scanForLocationData(bytes) {
  const sessions = [];
  const failures = [];

  let starts = [];
  try {
    starts = findSessionStarts(bytes);
  } catch (error) {
    failures.push({code: 'FILE_UNSCANNABLE', detail: String(error?.message ?? error)});
    return {sessions, scanComplete: false, failures};
  }

  if (starts.length === 0) {
    failures.push({
      code: 'NOT_A_BLACKBOX_LOG',
      detail: `no "H Product:" session header in ${bytes.length} bytes`
    });
    return {sessions, scanComplete: false, failures};
  }

  let scanComplete = true;

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1] ?? bytes.length;

    let definition = null;
    try {
      definition = parseSession(bytes, start, index);
    } catch (error) {
      failures.push({
        code: 'HEADER_UNREADABLE',
        detail: `session ${index}: ${String(error?.message ?? error)}`
      });
      scanComplete = false;
      continue;
    }

    const declaredLocationFields = Object.values(definition.frames)
      .filter(Boolean)
      .flatMap(table => table.fields.map(field => field.name))
      .filter(name => LOCATION_FIELD_PATTERN.test(name));

    let decoded = null;
    try {
      decoded = new FrameDecoder(definition, bytes, {}).decode(end);
    } catch (error) {
      failures.push({
        code: 'FRAME_STREAM_UNREADABLE',
        detail: `session ${index}: ${String(error?.message ?? error)}`
      });
      scanComplete = false;
      continue;
    }

    // Errors within a few bytes of the end are a capture cut by a power-off, not
    // a stream this tool failed to follow. Anything earlier means bytes were
    // skipped, and skipped bytes are bytes whose contents are unknown.
    const bodyErrors = (decoded.errors ?? [])
      .filter(error => end - error.offset > TAIL_TOLERANCE_BYTES);

    const positionFrames = (decoded.counts?.G ?? 0) + (decoded.counts?.H ?? 0);
    if (bodyErrors.length > 0) {
      scanComplete = false;
    }

    sessions.push({
      index,
      craftNamePresent: Boolean(definition.craftName),
      firmwareRevision: definition.firmware?.revision ?? null,
      declaredLocationFields,
      positionFrameCount: positionFrames,
      gpsFrameCount: decoded.counts?.G ?? 0,
      homeFrameCount: decoded.counts?.H ?? 0,
      bodyErrorCount: bodyErrors.length,
      endedMidFrame: Boolean(decoded.truncated),
      reachedLogEnd: Boolean(decoded.reachedLogEnd),
      sampleCount: decoded.samples.length
    });
  }

  return {sessions, scanComplete, failures};
}

function checkMetadata(metadata, bytes, sha256) {
  const findings = [];

  if (metadata === null || metadata === undefined) {
    findings.push(refusal(
      'METADATA_MISSING',
      'docs/FIXTURE_POLICY.md requires adjacent machine-readable metadata and the '
      + 'permission that allows redistribution. No sidecar was supplied'
    ));
    return findings;
  }

  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    findings.push(refusal('METADATA_MALFORMED', 'metadata is not an object'));
    return findings;
  }

  for (const field of Object.keys(DONATION_METADATA_FIELDS)) {
    const value = metadata[field];
    const empty = value === undefined || value === null
      || (typeof value === 'string' && value.trim() === '');
    if (empty) {
      findings.push(refusal(
        'METADATA_INCOMPLETE',
        `${field} is missing — ${DONATION_METADATA_FIELDS[field]}`
      ));
    }
  }

  if (typeof metadata.byteLength === 'number' && metadata.byteLength !== bytes.length) {
    findings.push(refusal(
      'METADATA_BYTE_LENGTH_MISMATCH',
      `metadata says ${metadata.byteLength} bytes, the file is ${bytes.length}`
    ));
  }

  if (typeof metadata.sha256 === 'string' && sha256 !== null
      && metadata.sha256.trim().toLowerCase() !== sha256.toLowerCase()) {
    findings.push(refusal(
      'METADATA_SHA256_MISMATCH',
      'the metadata block describes different bytes from the file beside it'
    ));
  }

  return findings;
}

/**
 * Decides whether a donated log may be published.
 *
 * @param {object} input
 * @param {Uint8Array} input.bytes the donated file
 * @param {string} input.sourceFile bare filename, for the report
 * @param {object|null} [input.metadata] the parsed sidecar, or null if absent
 * @param {string|null} [input.sha256] the file's hash, if the caller computed one
 * @returns {{publishable: boolean, findings: object[], scan: object}}
 */
export function checkDonation({bytes, sourceFile, metadata = null, sha256 = null}) {
  const findings = [];
  const scan = scanForLocationData(bytes);

  for (const failure of scan.failures) {
    findings.push(refusal(
      failure.code,
      `${failure.detail} — a log this tool cannot read end to end is a log it `
      + 'cannot clear of carrying a position'
    ));
  }

  const positionFrames = scan.sessions
    .reduce((total, session) => total + session.positionFrameCount, 0);
  const declaringSessions = scan.sessions
    .filter(session => session.declaredLocationFields.length > 0);

  if (positionFrames > 0) {
    const gps = scan.sessions.reduce((total, s) => total + s.gpsFrameCount, 0);
    const home = scan.sessions.reduce((total, s) => total + s.homeFrameCount, 0);
    findings.push(refusal(
      'LOCATION_FRAMES_RECORDED',
      `${positionFrames} position frames (${gps} GPS, ${home} home). A home `
      + 'position is usually where the pilot was standing and may be where they '
      + 'live. This file may not be published as it stands'
    ));
  }

  if (declaringSessions.length > 0 && !scan.scanComplete) {
    findings.push(refusal(
      'LOCATION_STATUS_UNPROVEN',
      'the log declares location fields and could not be scanned end to end, so '
      + 'the absence of a recorded position is unproven. Refused rather than assumed'
    ));
  }

  if (declaringSessions.length > 0 && positionFrames === 0 && scan.scanComplete) {
    findings.push(warning(
      'LOCATION_FIELDS_DECLARED_BUT_EMPTY',
      `${declaringSessions.length} session(s) declare `
      + `${declaringSessions[0].declaredLocationFields.join(', ')} but recorded no `
      + 'position frame. Publishable, and worth saying so in the metadata'
    ));
  }

  const namedSessions = scan.sessions.filter(session => session.craftNamePresent);
  if (namedSessions.length > 0) {
    findings.push(warning(
      'CRAFT_NAME_PRESENT',
      `${namedSessions.length} session(s) carry a craft name, which is whatever `
      + 'the donor typed into the configurator. Not a refusal — but it is an '
      + 'identifying field, so it belongs in identifyingFieldsPresent'
    ));
  }

  const damaged = scan.sessions.filter(session => session.bodyErrorCount > 0);
  if (damaged.length > 0) {
    findings.push(warning(
      'DECODE_ERRORS_IN_BODY',
      `${damaged.length} session(s) have decode errors away from the end of the `
      + 'file. Useful as a damaged-frame fixture; misleading as a measurement one'
    ));
  }

  findings.push(...checkMetadata(metadata, bytes, sha256));

  // The donor's own declaration, checked against the bytes. A sidecar that says
  // "no GPS" over a log with 675 GPS frames is the exact failure this whole
  // module exists to catch, and it is the one a human reviewer would not catch.
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      && 'identifyingFieldsPresent' in metadata) {
    const declared = metadata.identifyingFieldsPresent;
    const declaresLocation = typeof declared === 'string'
      ? /gps|location|coordinate|home/i.test(declared)
      : Boolean(declared);
    if (positionFrames > 0 && !declaresLocation) {
      findings.push(refusal(
        'METADATA_CONTRADICTS_LOG',
        'the metadata does not declare location data, and the log contains '
        + `${positionFrames} position frames`
      ));
    }
  }

  const publishable = !findings.some(finding => finding.severity === 'refuse');

  return {
    kind: DONATION_CHECK_KIND,
    schemaVersion: DONATION_CHECK_SCHEMA_VERSION,
    sourceFile,
    publishable,
    findings,
    scan: {
      sessionCount: scan.sessions.length,
      scanComplete: scan.scanComplete,
      positionFrameCount: positionFrames,
      declaringSessionCount: declaringSessions.length,
      sessions: scan.sessions
    }
  };
}

/** Renders one verdict as the lines a human reads. */
export function renderDonationCheck(result) {
  const lines = [];
  const say = text => lines.push(text);

  say('');
  say(`  ${result.publishable ? 'MAY BE PUBLISHED' : 'REFUSED'}  ${result.sourceFile}`);
  say(`    ${result.scan.sessionCount} session(s), `
    + `${result.scan.positionFrameCount} position frame(s), `
    + `scanned end to end: ${result.scan.scanComplete ? 'yes' : 'NO'}`);
  for (const finding of result.findings) {
    const label = finding.severity === 'refuse' ? 'REFUSE' : 'warn  ';
    say(`    ${label} ${finding.code}`);
    say(`           ${finding.detail}`);
  }
  return lines.join('\n');
}
