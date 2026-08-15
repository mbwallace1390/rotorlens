/**
 * The location check, tested against logs that actually carry a position.
 *
 * THE DEFECT THIS FILE IS WRITTEN AGAINST. A check whose refusal path is never
 * reached is indistinguishable from a check that works: it prints a green line
 * beside every file it is shown, and nobody looks again. So the refusal is
 * exercised on a log with a real recorded position frame in the DEFAULT suite,
 * not only when an environment variable happens to point at one.
 *
 * The GPS-bearing log is built here rather than committed, from
 * `fixtures/synthetic/rf46-gps-declared.TXT` plus one `G` frame whose
 * coordinates are all zero. Zero is deliberate: the check must refuse on the
 * PRESENCE of a position frame and not on its value, because deciding "these
 * coordinates are harmless" would mean surfacing coordinates in order to clear a
 * log of carrying them.
 */

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

import {parseSession, findSessionStarts} from '../src/blackbox/headers.mjs';
import {sha256Hex} from '../src/integrity.mjs';
import {
  checkDonation, scanForLocationData, renderDonationCheck, DONATION_METADATA_FIELDS
} from '../tools/corpus/donation-check.mjs';
import {collectFiles, readMetadata} from '../tools/check-donation.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const syntheticDir = path.join(projectRoot, 'fixtures', 'synthetic');
const realDir = path.join(projectRoot, 'fixtures', 'real');

async function bytesOf(file) {
  return new Uint8Array(await readFile(file));
}

test('every committed real-log fixture clears the publication gate', async () => {
  const files = await collectFiles(realDir);

  for (const file of files) {
    const bytes = await bytesOf(file);
    const {metadata, error} = await readMetadata(file);
    assert.equal(error, null, `${path.basename(file)} has an unreadable donation sidecar`);

    const result = checkDonation({
      bytes,
      sourceFile: path.basename(file),
      metadata,
      sha256: sha256Hex(bytes)
    });
    assert.equal(
      result.publishable,
      true,
      `${path.basename(file)} is tracked but refused: ${codesOf(result).join(', ')}`
    );
  }
});

test('a missing donation target is not treated as an allowed empty directory', async () => {
  await assert.rejects(
    collectFiles(path.join(projectRoot, 'fixtures', 'real-does-not-exist')),
    error => error?.code === 'ENOENT'
  );
});

/** Unsigned variable-byte integer, the same shape `ByteReader.unsignedVB` reads. */
function unsignedVB(value, out) {
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (remaining !== 0);
}

function signedVB(value, out) {
  unsignedVB(((value << 1) ^ (value >> 31)) >>> 0, out);
}

/**
 * The GPS-declaring fixture with `count` position frames spliced in.
 *
 * They go in at `dataOffset`, before the first main frame: a `G` frame carries
 * its own absolute values and depends on nothing before it, so the rest of the
 * stream decodes byte for byte as it did — which is what makes this a clean
 * one-variable change rather than a different log.
 */
function withPositionFrames(base, count) {
  const definition = parseSession(base, findSessionStarts(base)[0], 0);
  const frames = [];
  for (let index = 0; index < count; index += 1) {
    // time, GPS_numSat, GPS_coord[0], GPS_coord[1], GPS_altitude —
    // encodings 1,1,0,0,0 as the fixture's header declares them.
    frames.push(0x47);
    unsignedVB(index, frames);
    unsignedVB(0, frames);
    signedVB(0, frames);
    signedVB(0, frames);
    signedVB(0, frames);
  }

  const at = definition.dataOffset;
  const out = new Uint8Array(base.length + frames.length);
  out.set(base.subarray(0, at), 0);
  out.set(frames, at);
  out.set(base.subarray(at), at + frames.length);
  return out;
}

/** A metadata sidecar with every required field filled in. */
function completeMetadata(bytes, overrides = {}) {
  const metadata = {};
  for (const field of Object.keys(DONATION_METADATA_FIELDS)) {
    metadata[field] = 'stated';
  }
  metadata.byteLength = bytes.length;
  metadata.sha256 = sha256Hex(bytes);
  metadata.identifyingFieldsPresent = 'none';
  metadata.redaction = 'none';
  return {...metadata, ...overrides};
}

function codesOf(result, severity) {
  return result.findings
    .filter(finding => severity === undefined || finding.severity === severity)
    .map(finding => finding.code);
}

// ---------------------------------------------------------------------------
// The refusal that matters
// ---------------------------------------------------------------------------

test('a log carrying a recorded position frame is refused', async () => {
  const base = await bytesOf(path.join(syntheticDir, 'rf46-gps-declared.TXT'));
  const bytes = withPositionFrames(base, 3);

  const scan = scanForLocationData(bytes);
  assert.equal(scan.sessions.length, 1, 'the spliced log must still decode as one session');
  assert.equal(scan.sessions[0].gpsFrameCount, 3,
    'the splice must produce exactly the position frames it claims to');
  assert.equal(scan.scanComplete, true,
    'the rest of the stream must decode unchanged, or this is not a one-variable test');

  const result = checkDonation({
    bytes,
    sourceFile: 'donated.bbl',
    metadata: completeMetadata(bytes),
    sha256: sha256Hex(bytes)
  });

  assert.equal(result.publishable, false);
  assert.ok(codesOf(result, 'refuse').includes('LOCATION_FRAMES_RECORDED'),
    `expected LOCATION_FRAMES_RECORDED, got ${codesOf(result).join(', ')}`);
  assert.equal(result.scan.positionFrameCount, 3);
});

test('the refusal turns on the frame being there, not on the coordinate value', async () => {
  // Every coordinate in the spliced frames is exactly zero. If the check ever
  // starts reading values to decide, this test goes green while the tool stops
  // refusing real logs whose coordinates round to something innocuous.
  const base = await bytesOf(path.join(syntheticDir, 'rf46-gps-declared.TXT'));
  const bytes = withPositionFrames(base, 1);
  const result = checkDonation({bytes, sourceFile: 'zeroes.bbl',
    metadata: completeMetadata(bytes), sha256: sha256Hex(bytes)});

  assert.equal(result.publishable, false);
  assert.ok(codesOf(result, 'refuse').includes('LOCATION_FRAMES_RECORDED'));
});

test('one position frame is enough; the threshold is not a quantity', async () => {
  const base = await bytesOf(path.join(syntheticDir, 'rf46-gps-declared.TXT'));

  for (const count of [1, 2, 5, 40]) {
    const bytes = withPositionFrames(base, count);
    // The sidecar DECLARES the GPS, so METADATA_CONTRADICTS_LOG cannot fire and
    // the only thing left that can refuse is the location rule itself. Written
    // this way after the first draft — with `identifyingFieldsPresent: 'none'`
    // — stayed green under a mutation that downgraded the location refusal to a
    // warning, because the contradiction rule was quietly carrying the test.
    const result = checkDonation({
      bytes,
      sourceFile: `n${count}.bbl`,
      metadata: completeMetadata(bytes, {identifyingFieldsPresent: 'GPS present'}),
      sha256: sha256Hex(bytes)
    });

    assert.deepEqual(codesOf(result, 'refuse'), ['LOCATION_FRAMES_RECORDED'],
      `${count} position frames must refuse, and refuse for exactly this reason`);
    assert.equal(result.publishable, false);
    assert.equal(result.scan.positionFrameCount, count);
  }
});

// ---------------------------------------------------------------------------
// The pass, and the boundary between pass and refuse
// ---------------------------------------------------------------------------

test('declaring location fields without recording any is a warning, not a refusal', async () => {
  const bytes = await bytesOf(path.join(syntheticDir, 'rf46-gps-declared.TXT'));
  const result = checkDonation({bytes, sourceFile: 'declared.bbl',
    metadata: completeMetadata(bytes), sha256: sha256Hex(bytes)});

  assert.equal(result.publishable, true,
    'a log that declares a GPS field group and emits nothing carries no position');
  assert.ok(codesOf(result, 'warn').includes('LOCATION_FIELDS_DECLARED_BUT_EMPTY'));
  assert.equal(result.scan.positionFrameCount, 0);
});

test('a clean log with complete metadata may be published', async () => {
  const bytes = await bytesOf(path.join(syntheticDir, 'rf46-stop-manoeuvres.TXT'));
  const result = checkDonation({bytes, sourceFile: 'rf46-stop-manoeuvres.TXT',
    metadata: completeMetadata(bytes), sha256: sha256Hex(bytes)});

  assert.equal(result.publishable, true, codesOf(result, 'refuse').join(', '));
  assert.equal(result.scan.positionFrameCount, 0);
  // A craft name is identifying but is not location, so it warns rather than
  // refusing — the policy asks for it to be DECLARED, not removed.
  assert.ok(codesOf(result, 'warn').includes('CRAFT_NAME_PRESENT'));
});

// ---------------------------------------------------------------------------
// Failing closed
// ---------------------------------------------------------------------------

test('a log that cannot be scanned end to end is refused, not assumed clean', async () => {
  // A two-session donation: the first declares location fields and is fine, the
  // second has a header the parser cannot read. Nothing can be said about what
  // the second session's bytes contain, so nothing is.
  const gps = await bytesOf(path.join(syntheticDir, 'rf46-gps-declared.TXT'));
  const text = new TextDecoder('latin1').decode(gps);
  const brokenText = text.replace(
    /^H Field I encoding:(.*)$/m,
    (whole, list) => `H Field I encoding:${list.split(',').slice(0, -1).join(',')}`
  );
  assert.notEqual(brokenText, text, 'the corruption must actually change the header');
  const broken = Uint8Array.from(brokenText, character => character.charCodeAt(0) & 0xff);

  const bytes = new Uint8Array(gps.length + broken.length);
  bytes.set(gps, 0);
  bytes.set(broken, gps.length);

  const result = checkDonation({bytes, sourceFile: 'two-sessions.bbl',
    metadata: completeMetadata(bytes), sha256: sha256Hex(bytes)});

  assert.equal(result.scan.scanComplete, false);
  assert.equal(result.publishable, false);
  assert.ok(codesOf(result, 'refuse').includes('LOCATION_STATUS_UNPROVEN'),
    `expected LOCATION_STATUS_UNPROVEN, got ${codesOf(result).join(', ')}`);
});

test('a file that is not a log at all is refused rather than passed', () => {
  const bytes = new TextEncoder().encode('a README, not a flight log\n');
  const result = checkDonation({bytes, sourceFile: 'README.txt'});

  assert.equal(result.publishable, false);
  assert.ok(codesOf(result, 'refuse').includes('NOT_A_BLACKBOX_LOG'));
});

test('an empty file is refused rather than passed', () => {
  const result = checkDonation({bytes: new Uint8Array(0), sourceFile: 'empty.bbl'});
  assert.equal(result.publishable, false);
  assert.ok(codesOf(result, 'refuse').includes('NOT_A_BLACKBOX_LOG'));
});

test('random bytes never throw and never publish', () => {
  // Adversarial rather than tidy: a donation is whatever somebody attached to a
  // message, and the tool has to survive all of it. Seeded so a failure repeats.
  let state = 0x9e37_79b9;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state >>> 24;
  };

  for (let trial = 0; trial < 200; trial += 1) {
    const bytes = new Uint8Array(1 + (next() % 4096));
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = next();
    }
    const result = checkDonation({bytes, sourceFile: `fuzz-${trial}.bbl`});
    assert.equal(result.publishable, false, `trial ${trial} published random bytes`);
    assert.equal(typeof renderDonationCheck(result), 'string');
  }
});

// ---------------------------------------------------------------------------
// Permission, which is the other half of the policy
// ---------------------------------------------------------------------------

test('a log with no metadata sidecar is refused however clean the bytes are', async () => {
  const bytes = await bytesOf(path.join(syntheticDir, 'rf46-stop-manoeuvres.TXT'));
  const result = checkDonation({bytes, sourceFile: 'rf46-stop-manoeuvres.TXT'});

  assert.equal(result.publishable, false);
  assert.ok(codesOf(result, 'refuse').includes('METADATA_MISSING'));
});

test('every field docs/FIXTURE_POLICY.md requires is individually required', async () => {
  const bytes = await bytesOf(path.join(syntheticDir, 'rf46-stop-manoeuvres.TXT'));

  for (const field of Object.keys(DONATION_METADATA_FIELDS)) {
    const metadata = completeMetadata(bytes);
    delete metadata[field];
    const result = checkDonation({bytes, sourceFile: 'x.bbl', metadata,
      sha256: sha256Hex(bytes)});

    assert.equal(result.publishable, false, `${field} missing must refuse`);
    const incomplete = result.findings.filter(
      finding => finding.code === 'METADATA_INCOMPLETE' && finding.detail.startsWith(field)
    );
    assert.equal(incomplete.length, 1, `${field} must be named in the refusal`);
  }
});

test('a metadata block describing different bytes is refused', async () => {
  const bytes = await bytesOf(path.join(syntheticDir, 'rf46-stop-manoeuvres.TXT'));
  const other = await bytesOf(path.join(syntheticDir, 'rf46-gps-declared.TXT'));

  const result = checkDonation({
    bytes,
    sourceFile: 'x.bbl',
    metadata: completeMetadata(bytes, {sha256: sha256Hex(other)}),
    sha256: sha256Hex(bytes)
  });

  assert.equal(result.publishable, false);
  assert.ok(codesOf(result, 'refuse').includes('METADATA_SHA256_MISMATCH'));
});

test('a sidecar that denies GPS over a log that carries it is refused twice', async () => {
  const base = await bytesOf(path.join(syntheticDir, 'rf46-gps-declared.TXT'));
  const bytes = withPositionFrames(base, 12);

  const result = checkDonation({
    bytes,
    sourceFile: 'denied.bbl',
    metadata: completeMetadata(bytes, {identifyingFieldsPresent: 'none'}),
    sha256: sha256Hex(bytes)
  });

  const refusals = codesOf(result, 'refuse');
  assert.ok(refusals.includes('LOCATION_FRAMES_RECORDED'));
  assert.ok(refusals.includes('METADATA_CONTRADICTS_LOG'),
    'a donor declaration that contradicts the bytes is the failure a human reviewer misses');
});

test('a sidecar that declares GPS still does not make a GPS log publishable', async () => {
  const base = await bytesOf(path.join(syntheticDir, 'rf46-gps-declared.TXT'));
  const bytes = withPositionFrames(base, 12);

  const result = checkDonation({
    bytes,
    sourceFile: 'declared-gps.bbl',
    metadata: completeMetadata(bytes, {identifyingFieldsPresent: 'GPS coordinates present'}),
    sha256: sha256Hex(bytes)
  });

  assert.equal(result.publishable, false,
    'declaring a coordinate is not permission to publish one');
  assert.ok(!codesOf(result, 'refuse').includes('METADATA_CONTRADICTS_LOG'));
  assert.ok(codesOf(result, 'refuse').includes('LOCATION_FRAMES_RECORDED'));
});

// ---------------------------------------------------------------------------
// The real reference flight, when it is available
// ---------------------------------------------------------------------------

const REAL_GPS_LOG = process.env.ROTORLENS_GPS_LOG;

test('the reference Bell log is refused: it carries a real position',
  {skip: !REAL_GPS_LOG && 'set ROTORLENS_GPS_LOG to a GPS-bearing .bbl to run this'},
  async () => {
    const bytes = await bytesOf(REAL_GPS_LOG);
    const result = checkDonation({bytes, sourceFile: path.basename(REAL_GPS_LOG),
      metadata: completeMetadata(bytes), sha256: sha256Hex(bytes)});

    assert.equal(result.publishable, false);
    assert.ok(codesOf(result, 'refuse').includes('LOCATION_FRAMES_RECORDED'));
    assert.ok(result.scan.positionFrameCount > 100,
      'the reference log records hundreds of position frames');

    // The verdict is reached without a coordinate ever appearing in it.
    const rendered = renderDonationCheck(result);
    assert.ok(!/-?\d+\.\d{4,}/.test(rendered),
      'nothing in the output may look like a coordinate');
  });

test('nothing in a rendered verdict resembles a coordinate', async () => {
  const base = await bytesOf(path.join(syntheticDir, 'rf46-gps-declared.TXT'));
  const bytes = withPositionFrames(base, 9);
  const rendered = renderDonationCheck(checkDonation({bytes, sourceFile: 'x.bbl'}));

  assert.ok(!/GPS_coord/.test(rendered));
  assert.ok(!/-?\d+\.\d{4,}/.test(rendered));
});
