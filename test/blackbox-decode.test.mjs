import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {ENGINE, blackboxAdapter, decodeLog} from '../src/blackbox/decode.mjs';
import {sessionIntegrity} from '../src/blackbox/log-integrity.mjs';
import {decodeWithAdapter, summarizeParserReport} from '../src/parser-contract.mjs';
import {buildFixtures} from '../tools/generate-fixtures.mjs';
import {ByteWriter, writeSession} from '../tools/blackbox-writer.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(projectRoot, 'fixtures', 'synthetic');

async function loadFixture(file) {
  return new Uint8Array(await readFile(path.join(fixtureDir, file)));
}

/** Minimal valid Rotorflight data-version-2 session for protocol edge cases. */
function protocolLog({
  product = 'Blackbox flight data recorder by Nicholas Sherlock',
  dataVersion = '2',
  firmwareType = 'Rotorflight',
  firmwareRevision = 'Rotorflight 4.6.0 (protocol fixture) STM32H743',
  body
} = {}) {
  const writer = new ByteWriter();
  writer.ascii([
    `H Product:${product}`,
    `H Data version:${dataVersion}`,
    'H Field I name:time',
    'H Field I signed:0',
    'H Field I predictor:0',
    'H Field I encoding:1',
    'H Field P predictor:1',
    'H Field P encoding:0',
    `H Firmware type:${firmwareType}`,
    `H Firmware revision:${firmwareRevision}`,
    ''
  ].join('\n'));
  body?.(writer);
  return new Uint8Array(writer.toBuffer());
}

/** Firmware's exact clean terminator: event 255 plus `End of log\0`. */
function writeLogEnd(writer) {
  writer.ascii('E').u8(255).ascii('End of log').u8(0);
  return writer;
}

// ---------------------------------------------------------------------------
// A log with GPS in it
//
// Not one committed fixture contains a single `G` frame. Measured rather than
// assumed: decoding all 15 of them gives `frameCounts.G === 0` and
// `gps.length === 0` every time. So the whole GPS half of this decoder — the
// `gps[]` array, `#publishGpsFix`, predictor 7 (HOME_COORD) and predictor 10
// (LAST_MAIN_FRAME_TIME) — was reachable only from one uncommitted reference
// log, and a defect in any of it was invisible to `npm test` on a clean
// checkout. Two of this decoder's four historical defects lived in that region.
//
// Built in memory. Nothing is written to disk.
// ---------------------------------------------------------------------------

const GPS_MAIN_NAMES = ['loopIteration', 'time', 'axisP[0]'];
const GPS_INTRA_FIELDS = [
  {name: 'loopIteration', predictor: 0, encoding: 1},
  {name: 'time', predictor: 0, encoding: 1},
  {name: 'axisP[0]', predictor: 0, encoding: 0}
];
const GPS_INTER_FIELDS = [
  {name: 'loopIteration', predictor: 1, encoding: 0},
  {name: 'time', predictor: 2, encoding: 0},
  {name: 'axisP[0]', predictor: 1, encoding: 0}
];

// Predictor 10 is LAST_MAIN_FRAME_TIME, 7 is HOME_COORD, 0 is NONE.
const GPS_FRAME_NAMES =
  ['time', 'GPS_numSat', 'GPS_coord[0]', 'GPS_coord[1]', 'GPS_altitude', 'GPS_speed'];
const GPS_FIELDS = [
  {name: 'time', predictor: 10, encoding: 1},
  {name: 'GPS_numSat', predictor: 0, encoding: 1},
  {name: 'GPS_coord[0]', predictor: 7, encoding: 0},
  {name: 'GPS_coord[1]', predictor: 7, encoding: 0},
  {name: 'GPS_altitude', predictor: 0, encoding: 0},
  {name: 'GPS_speed', predictor: 0, encoding: 1}
];
const HOME_FRAME_NAMES = ['GPS_home[0]', 'GPS_home[1]'];
const HOME_FIELDS = [
  {name: 'GPS_home[0]', predictor: 0, encoding: 0},
  {name: 'GPS_home[1]', predictor: 0, encoding: 0}
];

// Far apart and of opposite sign on purpose, so latitude predicted against home
// LONGITUDE — the HOME_COORD pairing defect this decoder already had once —
// cannot decode back to the value that was encoded.
const GPS_HOME = [534_000_000, -1_200_000];

/** One session carrying main frames, an `H` frame and three `G` frames. */
function buildGpsLog() {
  const frames = [];
  for (let step = 0; step < 48; step += 1) {
    frames.push([step, step * 500, 100 + step]);
  }

  return new Uint8Array(writeSession({
    headerLines: [
      'H Product:Blackbox flight data recorder by Nicholas Sherlock',
      'H Data version:2',
      `H Field I name:${GPS_MAIN_NAMES.join(',')}`,
      'H Field I signed:0,0,1',
      `H Field I predictor:${GPS_INTRA_FIELDS.map(field => field.predictor).join(',')}`,
      `H Field I encoding:${GPS_INTRA_FIELDS.map(field => field.encoding).join(',')}`,
      `H Field P predictor:${GPS_INTER_FIELDS.map(field => field.predictor).join(',')}`,
      `H Field P encoding:${GPS_INTER_FIELDS.map(field => field.encoding).join(',')}`,
      `H Field G name:${GPS_FRAME_NAMES.join(',')}`,
      'H Field G signed:0,0,1,1,1,0',
      `H Field G predictor:${GPS_FIELDS.map(field => field.predictor).join(',')}`,
      `H Field G encoding:${GPS_FIELDS.map(field => field.encoding).join(',')}`,
      `H Field H name:${HOME_FRAME_NAMES.join(',')}`,
      'H Field H signed:1,1',
      `H Field H predictor:${HOME_FIELDS.map(field => field.predictor).join(',')}`,
      `H Field H encoding:${HOME_FIELDS.map(field => field.encoding).join(',')}`,
      'H Firmware type:Rotorflight',
      'H Firmware revision:Rotorflight 4.6.0 (gps fixture) STM32H743',
      'H I interval:8',
      'H P interval:1',
      'H P ratio:8'
    ],
    intraFields: GPS_INTRA_FIELDS,
    interFields: GPS_INTER_FIELDS,
    gpsFields: GPS_FIELDS,
    homeFields: HOME_FIELDS,
    frames,
    intraInterval: 8,
    constants: {},
    homeFrames: [{afterFrame: -1, values: GPS_HOME}],
    gpsFrames: [
      // BEFORE the first main frame, and that placement is the whole point.
      // `time` here predicts against the SEED value of `lastMainFrameTime`, so
      // this row reads 0 on a clean decode and reads the previous decode's
      // final timestamp if that constant survives from one decode to the next.
      {afterFrame: -1, values: [0, 4, GPS_HOME[0] + 10, GPS_HOME[1] - 25, 12_000, 3]},
      {afterFrame: 5, values: [2500, 7, GPS_HOME[0] + 900, GPS_HOME[1] - 640, 12_400, 41]},
      {afterFrame: 20, values: [10_000, 11, GPS_HOME[0] - 2_100, GPS_HOME[1] + 3_300, 13_050, 118]}
    ]
  }));
}

/** What `buildGpsLog` must decode back to, written out rather than derived. */
const GPS_EXPECTED_ROWS = [
  {sampleIndex: 0, timeUs: 0, numSat: 4, speed: 3, altitude: 12_000},
  {sampleIndex: 6, timeUs: 2500, numSat: 7, speed: 41, altitude: 12_400},
  {sampleIndex: 21, timeUs: 10_000, numSat: 11, speed: 118, altitude: 13_050}
];

test('every generated frame decodes back to the exact value that was encoded', () => {
  for (const fixture of buildFixtures()) {
    if (!fixture.expected) {
      continue;
    }

    const result = decodeLog(new Uint8Array(fixture.bytes));
    assert.equal(result.sessions.length, fixture.expected.length, `${fixture.file} session count`);

    fixture.expected.forEach((expectedFrames, sessionIndex) => {
      const session = result.sessions[sessionIndex];
      assert.deepEqual(
        session.errors, [],
        `${fixture.file} session ${sessionIndex} decoded with errors`
      );
      assert.equal(
        session.samples.length, expectedFrames.length,
        `${fixture.file} session ${sessionIndex} frame count`
      );

      expectedFrames.forEach((expectedValues, frameIndex) => {
        assert.deepEqual(
          session.samples[frameIndex], expectedValues,
          `${fixture.file} session ${sessionIndex} frame ${frameIndex} mismatch`
        );
      });
    });
  }
});

test('the frame stream is read to a clean log-end marker', async () => {
  const result = decodeLog(await loadFixture('rf43-single-session.TXT'));
  const [session] = result.sessions;

  assert.equal(session.reachedLogEnd, true);
  assert.equal(session.truncated, false);
  assert.equal(session.frameCounts.resyncBytes, 0);
  // I frames anchor prediction; the rest are deltas against them.
  assert.equal(session.frameCounts.I, 10);
  assert.equal(session.frameCounts.P, 310);
});

test('concatenated sessions decode independently', async () => {
  const result = decodeLog(await loadFixture('rf46-two-sessions.TXT'));

  assert.equal(result.sessions.length, 2);
  assert.equal(result.sessions[0].samples.length, 160);
  assert.equal(result.sessions[1].samples.length, 192);
  assert.ok(result.sessions[1].byteOffset > result.sessions[0].byteOffset);
  // Distinct data, not the first session decoded twice.
  assert.notDeepEqual(result.sessions[0].samples[0], result.sessions[1].samples[0]);
});

test('a frame body cannot consume bytes from the next concatenated session', () => {
  const cut = protocolLog({body(writer) {
    writer.ascii('I').u8(0x80); // unterminated variable-byte field
  }});
  const next = protocolLog({body(writer) {
    writer.ascii('I').unsignedVB(2000);
    writeLogEnd(writer);
  }});
  const bytes = new Uint8Array(Buffer.concat([cut, next]));
  const result = decodeLog(bytes);

  assert.equal(result.sessions.length, 2);
  assert.deepEqual(result.sessions[0].samples, [],
    'the next header must not finish the previous frame');
  assert.ok(result.sessions[0].errors.some(error => error.code === 'truncated'));
  assert.deepEqual(result.sessions[1].errors, []);
  assert.deepEqual(result.sessions[1].samples, [[2000]]);
});

test('a damaged span costs frames but never the rest of the log', async () => {
  const damaged = decodeLog(await loadFixture('rf46-corrupt-frames.TXT'));
  const [session] = damaged.sessions;

  assert.ok(session.errors.length > 0, 'damage must be reported, not hidden');
  assert.ok(session.frameCounts.resyncBytes > 0, 'decoder must resync past the damage');
  // A P frame between the damage and the next I frame carries a delta whose
  // base was lost in the gap; committing it would publish values offset by the
  // missing delta as if they were decoded truth. Those frames are consumed and
  // dropped, so up to one keyframe period is lost on top of the damaged span
  // itself — the cost of never presenting a stale-base sample.
  assert.ok(session.frameCounts.droppedInterFrames > 0,
    'un-anchored delta frames after the gap must be dropped, not committed');
  assert.ok(
    session.samples.length > 280,
    `expected most frames to survive, got ${session.samples.length}`
  );
  for (const error of session.errors) {
    assert.ok(error.code, 'every error must carry a typed code');
    assert.equal(typeof error.offset, 'number', 'every error must locate itself');
  }
});

test('a truncated header degrades to a reported error, not an exception', async () => {
  const result = decodeLog(await loadFixture('rf46-truncated-header.TXT'));
  const [session] = result.sessions;

  assert.equal(session.samples.length, 0);
  assert.ok(session.errors.length > 0);
  assert.equal(session.craftName, null, 'the cut header line must not be reported as parsed');
});

test('input that is not a log is rejected as data, not as a crash', () => {
  const result = decodeLog(new Uint8Array([1, 2, 3, 4, 5]));

  assert.deepEqual(result.sessions, []);
  assert.equal(result.errors[0].code, 'unsupported-firmware');
});

test('truncation mid-frame stops cleanly and reports it', async () => {
  const full = await loadFixture('rf43-single-session.TXT');
  const cut = full.subarray(0, Math.trunc(full.length * 0.6));
  const [session] = decodeLog(cut).sessions;

  assert.ok(session.samples.length > 0, 'frames before the cut must survive');
  assert.equal(session.reachedLogEnd, false);
  assert.equal(session.truncated, true);
});

test('decoded output satisfies the app-owned parser contract', async () => {
  const bytes = await loadFixture('rf43-single-session.TXT');
  const report = await decodeWithAdapter(blackboxAdapter, bytes);
  const summary = summarizeParserReport(report);

  assert.equal(report.engine.name, ENGINE.name);
  assert.equal(report.engine.license, 'MPL-2.0');
  assert.equal(summary.sessionCount, 1);
  assert.equal(summary.sessions[0].firmware.type, 'Rotorflight');
  assert.equal(summary.sessions[0].firmware.version, '4.3.0');
  assert.ok(summary.sessions[0].fieldNames.includes('headspeed'));
  assert.ok(summary.sessions[0].fieldNames.includes('gyroADC[0]'));
});

test('a lazy session reads its headers and nothing else', async () => {
  const bytes = await loadFixture('rf43-single-session.TXT');
  const result = decodeLog(bytes, {lazy: true});
  const [session] = result.sessions;

  // What the session picker gets for free.
  assert.equal(session.firmware.type, 'Rotorflight');
  assert.equal(session.firmware.version, '4.3.0');
  assert.equal(typeof session.firmware.board, 'string');
  assert.equal(typeof session.craftName, 'string');
  assert.equal(session.locationFieldsDeclared, false);
  assert.ok(session.fields.length > 0, 'field inventory is still available');
  assert.equal(typeof session.byteOffset, 'number');

  // What it does not get, and must not be able to mistake for an answer. `[]`
  // and `0` would each read as a decoded, empty session.
  assert.equal(session.framesDecoded, false);
  assert.equal(session.samples, null);
  assert.equal(session.events, null);
  assert.equal(session.gps, null);
  assert.equal(session.intraSampleIndices, null);
  assert.equal(session.frameCounts, null);
  assert.equal(session.truncated, null);
  assert.equal(session.reachedLogEnd, null);
  assert.equal(session.errors, null);
  assert.equal(session.fields[0].sampleCount, null, 'a sample count nobody has counted is not 0');
});

test('headersOnly is the older spelling of lazy', async () => {
  const bytes = await loadFixture('rf43-single-session.TXT');
  const lazy = decodeLog(bytes, {lazy: true}).sessions[0];
  const legacy = decodeLog(bytes, {headersOnly: true}).sessions[0];

  assert.deepEqual(legacy, lazy);
  assert.equal(typeof legacy.decodeFrames, 'function');
});

test('a lazily decoded session is indistinguishable from an eagerly decoded one', async () => {
  // The whole change rests on this. If the two paths can be told apart by any
  // caller — a deep compare, a JSON round trip, an object spread, a key list —
  // then the app has two decoders and only one of them is tested.
  //
  // The corpus deliberately includes a GPS-bearing log. The three .TXT fixtures
  // below decode ZERO `G` frames between them, so on their own this test cannot
  // reach `gps[]`, `#publishGpsFix`, HOME_COORD or LAST_MAIN_FRAME_TIME at all —
  // a test that cannot fail the way its own name claims. `buildGpsLog()` is what
  // makes the name true.
  const corpus = [
    ...await Promise.all(
      ['rf43-single-session.TXT', 'rf46-two-sessions.TXT', 'rf46-corrupt-frames.TXT']
        .map(async file => ({file, bytes: await loadFixture(file)}))
    ),
    {file: 'in-memory GPS log', bytes: buildGpsLog()}
  ];

  let sessionsCompared = 0;
  let gpsRowsCompared = 0;

  for (const {file, bytes} of corpus) {
    const eager = decodeLog(bytes);
    const lazy = decodeLog(bytes, {lazy: true});

    assert.equal(lazy.sessions.length, eager.sessions.length, file);

    lazy.sessions.forEach((session, index) => {
      const decoded = session.decodeFrames();
      const reference = eager.sessions[index];

      assert.deepEqual(Object.keys(decoded), Object.keys(reference), `${file} #${index} keys`);
      assert.deepEqual(decoded, reference, `${file} #${index} report`);
      assert.equal(JSON.stringify(decoded), JSON.stringify(reference), `${file} #${index} serialized`);
      assert.ok(decoded.samples.length > 0, `${file} #${index} decoded nothing`);

      // And AGAIN after a release. This is the round trip the viewer actually
      // performs — it drops a session under memory pressure and reads it back
      // when the pilot returns to that flight — and it decodes the same bytes a
      // SECOND time, which a fresh `decodeLog` never does. A decoder holding
      // mutable state on the session definition passes the compare above and
      // fails this one.
      const before = JSON.stringify(decoded);
      session.releaseFrames();
      assert.equal(session.samples, null, `${file} #${index} release`);
      const again = session.decodeFrames();

      assert.equal(JSON.stringify(again), before, `${file} #${index} re-decoded differently`);
      assert.deepEqual(again, reference, `${file} #${index} re-decoded report`);

      sessionsCompared += 1;
      gpsRowsCompared += again.gps.length;
    });
  }

  // Anti-vacuity. Without these, deleting the GPS log from the corpus — or the
  // whole `gps` array from the decoder — leaves this test green while its name
  // still promises the two paths are indistinguishable.
  assert.equal(sessionsCompared, 5, 'the corpus lost a session');
  assert.equal(gpsRowsCompared, 3, 'the GPS path was not reached');
});

test('a log with GPS in it decodes to the values that were written', () => {
  // The corpus this repository ships has no `G` frame anywhere in it, so
  // everything downstream of a GPS fix was asserted only against a log that is
  // not in the repository. This is the floor under that.
  const [session] = decodeLog(buildGpsLog()).sessions;

  assert.deepEqual(session.errors, [], 'the GPS log must decode without errors');
  assert.equal(session.frameCounts.G, 3, 'three G frames were written');
  assert.equal(session.frameCounts.H, 1, 'one H frame was written');
  assert.equal(session.locationFieldsDeclared, true, 'the log declares coordinates');
  assert.deepEqual(session.gps, GPS_EXPECTED_ROWS);

  // The privacy promise, checked at the only boundary that can keep it: two
  // coordinates went in, and no coordinate may come out — not under its own
  // name, not under any name, not anywhere in the serialized session.
  const serialized = JSON.stringify(session);
  for (const coordinate of [GPS_HOME[0], GPS_HOME[1], GPS_HOME[0] + 10, GPS_HOME[1] - 25]) {
    assert.equal(serialized.includes(String(coordinate)), false,
      `a GPS coordinate (${coordinate}) reached a caller`);
  }
  assert.equal(session.fields.some(field => field.name.startsWith('GPS_coord')), false);
});

test('decoding a session, releasing it and decoding it again gives the same numbers', () => {
  // `releaseFrames()` made a session decodable twice, which nothing in this
  // decoder had ever been. Anything the frame loop writes back onto the session
  // definition survives into the second decode, and the second decode then
  // reads a value the first one left behind — no error, frame sync held, just
  // different numbers. `lastMainFrameTime` did exactly that.
  //
  // The first `G` frame in this log sits before ANY main frame, which is the
  // only position where that constant is read while still holding its seed.
  const [session] = decodeLog(buildGpsLog(), {lazy: true}).sessions;

  const first = JSON.stringify(session.decodeFrames());
  session.releaseFrames();
  const second = JSON.stringify(session.decodeFrames());

  assert.equal(second, first, 'the same bytes decoded to different values the second time');
  assert.equal(session.gps[0].timeUs, 0,
    'the first GPS fix predicts against the seeded lastMainFrameTime, not a leftover');
});

test('decoding a session twice does not decode it twice', async () => {
  const bytes = await loadFixture('rf43-single-session.TXT');
  const [session] = decodeLog(bytes, {lazy: true}).sessions;

  const first = session.decodeFrames();
  assert.equal(session.framesDecoded, true);

  // Timing would only suggest the second call was free. Marking the memo and
  // watching the mark survive proves nothing was decoded over it.
  const samples = first.samples;
  samples[0][0] = -424_242;

  const second = session.decodeFrames();
  assert.equal(second, first, 'a second call must hand back the same session');
  assert.equal(second.samples, samples, 'a second call must hand back the same array');
  assert.equal(second.samples[0][0], -424_242, 'the session was decoded a second time');
});

test('releasing a session frees its frames and decodes back to the same values', async () => {
  // Switching sessions on a phone has to give the memory back, and the session
  // that comes back has to be the same session.
  const bytes = await loadFixture('rf43-single-session.TXT');
  const [session] = decodeLog(bytes, {lazy: true}).sessions;
  const before = JSON.stringify(session.decodeFrames());

  session.releaseFrames();
  assert.equal(session.framesDecoded, false);
  assert.equal(session.samples, null, 'released frames must not be reachable');
  assert.equal(session.fields[0].sampleCount, null);

  assert.equal(JSON.stringify(session.decodeFrames()), before);
});

test('a session that cannot be read reports it lazily exactly as it does eagerly', async () => {
  // Failure has to arrive at the same point with the same shape whichever path
  // asked for it, or a lazy caller learns about a broken log later than an
  // eager one — or not at all.
  const bytes = await loadFixture('rf46-truncated-header.TXT');
  const eager = decodeLog(bytes).sessions[0];
  const [lazy] = decodeLog(bytes, {lazy: true}).sessions;

  assert.equal(lazy.errors, null, 'before decoding, no error has been found yet');
  assert.deepEqual(lazy.decodeFrames(), eager);
  assert.ok(eager.errors.length > 0);
});

test('a header too broken to parse still answers decodeFrames', async () => {
  // `H Product:` line, then a field table whose predictor and encoding counts
  // disagree — a DecodeError out of parseSession, which never reaches a frame.
  const writer = new ByteWriter();
  writer.ascii([
    'H Product:Blackbox flight data recorder by Nicholas Sherlock',
    'H Data version:2',
    'H Field I name:time,gyroADC[0]',
    'H Field I signed:0,1',
    'H Field I predictor:0',
    'H Field I encoding:1,0',
    ''
  ].join('\n'));
  const bytes = new Uint8Array(writer.toBuffer());

  const eager = decodeLog(bytes).sessions[0];
  const [lazy] = decodeLog(bytes, {lazy: true}).sessions;

  assert.equal(eager.errors[0].code, 'corrupt-header');
  assert.equal(lazy.framesDecoded, false);
  assert.deepEqual(lazy.decodeFrames(), eager, 'both paths must report the same failure');
  assert.equal(lazy.framesDecoded, true, 'a session with nothing to decode is still answered');

  // And it must have the SAME KEYS as a session that read cleanly. A caller
  // that has correctly learned to tell `null` ("not read yet") from `[]`
  // ("read, and empty") must not meet a third answer it was never told about:
  // `samples` was simply ABSENT here, so `session.samples.length` threw rather
  // than reading 0, and in the viewer that put a corrupt flight in the picker
  // looking exactly like an unopened one.
  const healthy = decodeLog(await loadFixture('rf43-single-session.TXT')).sessions[0];
  assert.deepEqual(Object.keys(eager).sort(), Object.keys(healthy).sort(),
    'an unreadable session has a different shape from a readable one');
  for (const key of ['samples', 'intraSampleIndices', 'events', 'gps']) {
    assert.ok(Array.isArray(eager[key]), `${key} must be an array, not ${typeof eager[key]}`);
    assert.equal(eager[key].length, 0, `${key} must be empty`);
  }
  assert.equal(eager.fields.length, 0, 'a header that could not be parsed declares no fields');

  // `errors` non-empty WITH `fields` empty is the only combination that means
  // "the header itself could not be read", and ui/app.mjs routes on exactly
  // that pair — a damaged FRAME stream has errors and a full field table, and a
  // flight that logged nothing has a field table and no errors.
  assert.ok(eager.errors.length > 0);
  assert.ok(healthy.fields.length > 0, 'the control session must have fields, or the pair '
    + 'above does not distinguish anything');
  assert.equal(healthy.errors.length, 0, 'the control session must have decoded cleanly');
});

test('lazy decoding reads only the session asked for', async () => {
  // The point of the change: opening session 1 must not cost session 0. Proved
  // by byte offsets, since a session that was decoded knows its sample count
  // and one that was not knows nothing.
  const bytes = await loadFixture('rf46-two-sessions.TXT');
  const {sessions} = decodeLog(bytes, {lazy: true});

  sessions[1].decodeFrames();

  assert.equal(sessions[0].framesDecoded, false, 'the untouched session must stay untouched');
  assert.equal(sessions[0].samples, null);
  assert.equal(sessions[1].samples.length, 192);
  assert.deepEqual(sessions[1].samples[0], decodeLog(bytes).sessions[1].samples[0]);
});

test('event records are skipped by their measured payload length', async () => {
  // Every one of these was a resync until a real Rotorflight 4.6 log showed how
  // long its payload is. Getting a length wrong desynchronizes the frame stream
  // from that point on, so the corpus pins them.
  const result = decodeLog(await loadFixture('rf43-single-session.TXT'));
  const [session] = result.sessions;

  assert.deepEqual(session.errors, [], 'an event of unknown length shows up as an error');
  assert.equal(session.frameCounts.resyncBytes, 0, 'a wrong payload length costs a resync');

  const kinds = session.events.map(event => event.event);
  assert.equal(kinds.filter(kind => kind === 'inflight-adjustment').length, 2);
  assert.equal(kinds.filter(kind => kind === 'state').length, 3);
  assert.ok(kinds.includes('log-end'));

  const adjustment = session.events.find(event => event.event === 'inflight-adjustment');
  assert.equal(adjustment.function, 0x01);
  assert.equal(adjustment.value, 2, '0x04 is signed-variable-byte encoding for +2');

  const airborne = session.events.find(event => event.eventType === 52);
  assert.equal(airborne.state, 1);
});

test('Rotorflight 4.6 events follow firmware variable-byte and float payloads', () => {
  const bytes = protocolLog({body(writer) {
    writer.ascii('I').unsignedVB(1000);
    writer.ascii('E').u8(13).u8(1).signedVB(-2);
    // Function high bit means four-byte IEEE-754 little-endian float. 1.5f is
    // 00 00 c0 3f, written out so this vector is independent of our writer.
    writer.ascii('E').u8(13).u8(0x80 | 2).u8(0x00).u8(0x00).u8(0xc0).u8(0x3f);
    writer.ascii('E').u8(15).unsignedVB(300);
    writer.ascii('E').u8(50).unsignedVB(511);
    writer.ascii('E').u8(51).unsignedVB(7);
    writer.ascii('E').u8(52).unsignedVB(1);
    writer.ascii('E').u8(100).u8(3).u8(0x49).u8(0x45).u8(0xff);
    writer.ascii('E').u8(101).u8(3).ascii('abc');
    writeLogEnd(writer);
  }});

  const [session] = decodeLog(bytes).sessions;
  assert.deepEqual(session.errors, []);
  assert.equal(session.reachedLogEnd, true);
  assert.deepEqual(
    session.events.filter(event => event.event === 'inflight-adjustment')
      .map(({function: adjustmentFunction, value, valueType}) =>
        ({function: adjustmentFunction, value, valueType})),
    [
      {function: 1, value: -2, valueType: 'integer'},
      {function: 2, value: 1.5, valueType: 'float'}
    ]
  );
  assert.deepEqual(
    session.events.filter(event => event.event === 'state')
      .map(({eventType, state}) => ({eventType, state})),
    [
      {eventType: 15, state: 300},
      {eventType: 50, state: 511},
      {eventType: 51, state: 7},
      {eventType: 52, state: 1}
    ]
  );
  assert.deepEqual(
    session.events.filter(event => event.event.startsWith('custom'))
      .map(({event, length}) => ({event, length})),
    [{event: 'custom-data', length: 3}, {event: 'custom-string', length: 3}]
  );
});

test('the synthetic writer emits typed events in firmware format', () => {
  const field = {name: 'time', predictor: 0, encoding: 1};
  const bytes = new Uint8Array(writeSession({
    headerLines: [
      'H Product:Blackbox flight data recorder by Nicholas Sherlock',
      'H Data version:2',
      'H Field I name:time',
      'H Field I signed:0',
      'H Field I predictor:0',
      'H Field I encoding:1',
      'H Field P predictor:1',
      'H Field P encoding:0',
      'H Firmware type:Rotorflight',
      'H Firmware revision:Rotorflight 4.6.0 (writer protocol) STM32H743'
    ],
    intraFields: [field],
    interFields: [{...field, predictor: 1, encoding: 0}],
    frames: [[1000]],
    intraInterval: 1,
    constants: {},
    events: [
      {afterFrame: 0, type: 13, function: 4, value: -257, valueType: 'integer'},
      {afterFrame: 0, type: 13, function: 5, value: -12.5, valueType: 'float'},
      {afterFrame: 0, type: 51, state: 300}
    ]
  }));

  const [session] = decodeLog(bytes).sessions;
  assert.deepEqual(session.errors, []);
  assert.deepEqual(
    session.events.slice(0, 3).map(event =>
      event.event === 'state'
        ? {eventType: event.eventType, state: event.state}
        : {function: event.function, value: event.value, valueType: event.valueType}),
    [
      {function: 4, value: -257, valueType: 'integer'},
      {function: 5, value: -12.5, valueType: 'float'},
      {eventType: 51, state: 300}
    ]
  );
  assert.equal(session.events.at(-1).event, 'log-end');
});

test('a log-end event is clean only with the exact firmware payload', () => {
  const bare = protocolLog({body(writer) {
    writer.ascii('I').unsignedVB(1000).ascii('E').u8(255);
  }});
  const wrong = protocolLog({body(writer) {
    writer.ascii('I').unsignedVB(1000).ascii('E').u8(255).ascii('Not the end').u8(0);
  }});

  for (const bytes of [bare, wrong]) {
    const [session] = decodeLog(bytes).sessions;
    assert.equal(session.reachedLogEnd, false);
    assert.ok(session.errors.length > 0, 'a malformed terminator must be reported');
    if (session.errors.some(error => error.formatMismatch)) {
      assert.equal(sessionIntegrity(session, bytes.length).state, 'damaged');
    }
  }
});

test('unsigned timestamps stay positive across the signed 32-bit boundary', () => {
  const bytes = protocolLog({body(writer) {
    writer.ascii('I').unsignedVB(0x7fffffff);
    writer.ascii('P').signedVB(1);
    writeLogEnd(writer);
  }});
  const [session] = decodeLog(bytes).sessions;

  assert.deepEqual(session.errors, []);
  assert.deepEqual(session.samples, [[0x7fffffff], [0x80000000]]);
});

test('an unsigned varint wider than uint32 is rejected instead of wrapping', () => {
  const bytes = protocolLog({body(writer) {
    // Fifth payload byte 0x10 sets bit 32. A JavaScript shift by 32 would fold
    // it onto bit zero unless the encoded width is checked before shifting.
    writer.ascii('I').u8(0x80).u8(0x80).u8(0x80).u8(0x80).u8(0x10);
    writeLogEnd(writer);
  }});
  const [session] = decodeLog(bytes).sessions;

  assert.deepEqual(session.samples, []);
  assert.ok(session.errors.some(error =>
    error.code === 'corrupt-frame' && /exceeded 32 bits/.test(error.message)));
});

test('hitting maxFrames is an explicit integrity failure, never a clean partial log', async () => {
  const bytes = await loadFixture('rf43-single-session.TXT');
  const [session] = decodeLog(bytes, {limits: {maxFrames: 1}}).sessions;

  assert.equal(session.samples.length, 1);
  assert.equal(session.limitExceeded, true);
  assert.equal(session.reachedLogEnd, false);
  assert.ok(session.errors.some(error => error.code === 'limit-exceeded'));
  assert.equal(sessionIntegrity(session, bytes.length).state, 'damaged');
});

test('event-only streams are bounded independently of main-frame limits', () => {
  const bytes = protocolLog({body(writer) {
    writer.ascii('I').unsignedVB(1000);
    for (let index = 0; index < 5; index += 1) {
      writer.ascii('E').u8(52).unsignedVB(index & 1);
    }
    writeLogEnd(writer);
  }});
  const [session] = decodeLog(bytes, {limits: {maxFrames: 10, maxEvents: 2}}).sessions;

  assert.equal(session.events.length, 2);
  assert.equal(session.limitExceeded, true);
  assert.ok(session.errors.some(error => error.code === 'limit-exceeded'));
});

test('the total-record cap also stops streams that evade per-kind limits', () => {
  const bytes = protocolLog({body(writer) {
    writer.ascii('I').unsignedVB(1000);
    writer.ascii('E').u8(52).unsignedVB(1);
    writeLogEnd(writer);
  }});
  const [session] = decodeLog(bytes, {limits: {maxRecords: 1}}).sessions;

  assert.deepEqual(session.samples, [[1000]]);
  assert.deepEqual(session.events, []);
  assert.equal(session.limitExceeded, true);
  assert.ok(session.errors.some(error =>
    error.code === 'limit-exceeded' && error.resource === 'record'));
});

test('session floods stop before any clean-looking partial session is returned', () => {
  const one = protocolLog({body(writer) {
    writer.ascii('I').unsignedVB(1000);
    writeLogEnd(writer);
  }});
  const bytes = new Uint8Array(Buffer.concat([one, one, one]));
  const result = decodeLog(bytes, {limits: {maxSessions: 2}});

  assert.deepEqual(result.sessions, []);
  assert.equal(result.errors[0].code, 'limit-exceeded');
  assert.equal(result.errors[0].resource, 'session');
  assert.equal(result.errors[0].limit, 2);
});

test('product, data version and firmware type are compatibility gates', () => {
  const variants = [
    {product: 'not a Blackbox recorder'},
    {product: 'Blackbox flight data recorder by somebody else'},
    {dataVersion: '999'},
    {firmwareType: 'NotRotorflight'},
    {firmwareRevision: 'NotRotorflight 4.6.0'},
    {firmwareRevision: 'Rotorflight 999.0.0 (future fixture) STM32H743'}
  ];

  for (const variant of variants) {
    const [session] = decodeLog(protocolLog({
      ...variant,
      body(writer) {
        writer.ascii('I').unsignedVB(1000);
        writeLogEnd(writer);
      }
    })).sessions;
    assert.equal(session.samples.length, 0);
    assert.equal(session.errors[0].code, 'unsupported-firmware');
    assert.equal(typeof session.errors[0].offset, 'number');
  }
});

test('firmware compatibility is bounded to Rotorflight 4.3 through 4.6', () => {
  for (const version of ['4.3.0', '4.4.7', '4.5.1-RC2', '4.6.99']) {
    const [session] = decodeLog(protocolLog({
      firmwareRevision: `Rotorflight ${version} (range fixture) STM32H743`,
      body(writer) {
        writer.ascii('I').unsignedVB(1000);
        writeLogEnd(writer);
      }
    })).sessions;
    assert.deepEqual(session.errors, [], version);
  }

  for (const version of ['4.2.99', '4.7.0', '999.0.0']) {
    const [session] = decodeLog(protocolLog({
      firmwareRevision: `Rotorflight ${version} (range fixture) STM32H743`,
      body(writer) {
        writer.ascii('I').unsignedVB(1000);
        writeLogEnd(writer);
      }
    })).sessions;
    assert.equal(session.errors[0].code, 'unsupported-firmware', version);
    assert.deepEqual(session.samples, [], version);
  }
});

test('Product text repeated inside one header does not manufacture sessions', () => {
  const writer = new ByteWriter();
  writer.ascii('H Product:Blackbox flight data recorder by Nicholas Sherlock\n');
  writer.ascii('H Data version:2\n');
  for (let index = 0; index < 1000; index += 1) {
    writer.ascii('H Product:Blackbox flight data recorder by Nicholas Sherlock\n');
  }
  writer.ascii([
    'H Field I name:time',
    'H Field I signed:0',
    'H Field I predictor:0',
    'H Field I encoding:1',
    'H Field P predictor:1',
    'H Field P encoding:0',
    'H Firmware type:Rotorflight',
    'H Firmware revision:Rotorflight 4.6.0 (repeated header) STM32H743',
    ''
  ].join('\n'));
  writer.ascii('I').unsignedVB(1000);
  writeLogEnd(writer);

  const result = decodeLog(new Uint8Array(writer.toBuffer()));
  assert.equal(result.sessions.length, 1);
  assert.deepEqual(result.sessions[0].errors, []);
});

test('a header-only session does not absorb an adjacent session preamble', () => {
  // A power loss can leave a session with headers but no binary frame between
  // its last header line and the next boot's Product line. A lone repeated
  // Product key is metadata; Product immediately followed by Data version is
  // the firmware's unambiguous two-line session preamble.
  const empty = protocolLog();
  const complete = protocolLog({body(writer) {
    writer.ascii('I').unsignedVB(2000);
    writeLogEnd(writer);
  }});
  const bytes = new Uint8Array(Buffer.concat([empty, complete]));

  const result = decodeLog(bytes);
  assert.equal(result.sessions.length, 2);
  assert.deepEqual(result.sessions[0].samples, []);
  assert.equal(result.sessions[0].truncated, true);
  assert.deepEqual(result.sessions[1].samples, [[2000]]);
  assert.deepEqual(result.sessions[1].errors, []);
});

test('unsupported schema IDs are rejected once from the header, before frame resync', () => {
  const fieldCount = 1000;
  const names = Array.from({length: fieldCount}, (_, index) => `field${index}`);
  const predictors = new Array(fieldCount).fill('0');
  predictors[fieldCount - 1] = '99';
  const writer = new ByteWriter();
  writer.ascii([
    'H Product:Blackbox flight data recorder by Nicholas Sherlock',
    'H Data version:2',
    `H Field I name:${names.join(',')}`,
    `H Field I signed:${new Array(fieldCount).fill('1').join(',')}`,
    `H Field I predictor:${predictors.join(',')}`,
    `H Field I encoding:${new Array(fieldCount).fill('9').join(',')}`,
    `H Field P predictor:${new Array(fieldCount).fill('1').join(',')}`,
    `H Field P encoding:${new Array(fieldCount).fill('9').join(',')}`,
    'H Firmware type:Rotorflight',
    'H Firmware revision:Rotorflight 4.6.0 (schema fixture) STM32H743',
    ''
  ].join('\n'));
  // Thousands of apparent frame markers used to make the late invalid ID run
  // through the whole 1000-field table repeatedly during resync.
  writer.ascii('I'.repeat(5000));

  const [session] = decodeLog(new Uint8Array(writer.toBuffer())).sessions;
  assert.equal(session.samples.length, 0);
  assert.equal(session.errors.length, 1);
  assert.equal(session.errors[0].code, 'unsupported-predictor');
  assert.equal(session.errors[0].fieldIndex, fieldCount - 1);
  assert.equal(session.frameCounts.I, 0);
});

test('absurd field tables stop at a documented header resource limit', () => {
  const fieldCount = 1025;
  const writer = new ByteWriter();
  writer.ascii([
    'H Product:Blackbox flight data recorder by Nicholas Sherlock',
    'H Data version:2',
    `H Field I name:${Array.from({length: fieldCount}, (_, index) => `f${index}`).join(',')}`,
    `H Field I signed:${new Array(fieldCount).fill('1').join(',')}`,
    `H Field I predictor:${new Array(fieldCount).fill('0').join(',')}`,
    `H Field I encoding:${new Array(fieldCount).fill('9').join(',')}`,
    'H Firmware type:Rotorflight',
    'H Firmware revision:Rotorflight 4.6.0 (field-limit fixture) STM32H743',
    ''
  ].join('\n'));

  const [session] = decodeLog(new Uint8Array(writer.toBuffer())).sessions;
  assert.equal(session.samples.length, 0);
  assert.equal(session.limitExceeded, true);
  assert.equal(session.errors[0].code, 'limit-exceeded');
  assert.equal(session.errors[0].limit, 1024);
});

test('unbounded header-line floods fail as one limited session', () => {
  const writer = new ByteWriter();
  writer.ascii('H Product:Blackbox flight data recorder by Nicholas Sherlock\n');
  writer.ascii('H Data version:2\n');
  for (let index = 0; index < 4100; index += 1) {
    writer.ascii(`H Note ${index}:x\n`);
  }

  const result = decodeLog(new Uint8Array(writer.toBuffer()));
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].limitExceeded, true);
  assert.equal(result.sessions[0].errors[0].code, 'limit-exceeded');
  assert.equal(result.sessions[0].errors[0].limit, 4096);
});

test('every event is placed between two samples, not just at a byte offset', async () => {
  // `offset` is a byte position in the file and samples carry none, so an event
  // record consisting of `{event, offset}` cannot be put on the time axis by
  // any caller without re-decoding the stream. That is why the log's own
  // airborne flag — real firmware ground truth about when the machine left the
  // ground — was unreachable, and why `src/analysis/flight-window.mjs` had to
  // be built on a heuristic instead of reading it. The placement is exact to
  // within one sample interval, which is all the stream can support.
  const result = decodeLog(await loadFixture('rf43-single-session.TXT'));
  const [session] = result.sessions;
  const timeIndex = session.fields.find(field => field.name === 'time').index;

  assert.ok(session.events.length > 3, 'fixture must contain events to place');

  let previousIndex = -1;
  for (const event of session.events) {
    assert.equal(
      typeof event.sampleIndex, 'number',
      `${event.event} carries no sample position`
    );
    assert.ok(
      event.sampleIndex >= 0 && event.sampleIndex <= session.samples.length,
      `${event.event} placed at ${event.sampleIndex} of ${session.samples.length}`
    );
    // Events come out of a single forward pass, so their placements must be
    // non-decreasing. Out of order would mean the counter and the sample array
    // had come apart.
    assert.ok(event.sampleIndex >= previousIndex, 'event placements went backwards');
    previousIndex = event.sampleIndex;

    if (event.sampleIndex === 0) {
      assert.equal(event.afterTimeUs, null, 'nothing precedes an event before the first sample');
      continue;
    }

    // The bracket has to be real: the preceding timestamp must be the one on
    // the sample before the placement, and the following sample must be later.
    const before = session.samples[event.sampleIndex - 1][timeIndex];
    assert.equal(event.afterTimeUs, before, `${event.event} preceding time is not the previous sample`);

    if (event.sampleIndex < session.samples.length) {
      const after = session.samples[event.sampleIndex][timeIndex];
      assert.ok(after > before, 'the bracket around an event must span forward in time');
    }
  }

  // A state event that is placed nowhere is the failure this replaces; check
  // one specific record rather than only the aggregate.
  const airborne = session.events.find(event => event.eventType === 52);
  assert.ok(airborne.sampleIndex > 0, 'the airborne flag must sit somewhere in the flight');
  assert.equal(typeof airborne.afterTimeUs, 'number');
});

/**
 * Hand-built log carrying `G` frames with coordinates in them.
 *
 * No fixture in the corpus contains a decoded GPS frame — `rf46-gps-declared`
 * declares the fields and emits none — so the rule that coordinates are read
 * and then dropped is not observable through any committed file. This makes it
 * observable, with coordinates chosen to be unmistakable if one ever leaked.
 */
function gpsLog() {
  const writer = new ByteWriter();
  writer.ascii([
    'H Product:Blackbox flight data recorder by Nicholas Sherlock',
    'H Data version:2',
    'H Field I name:time,gyroADC[0]',
    'H Field I signed:0,1',
    'H Field I predictor:0,0',
    'H Field I encoding:1,0',
    'H Field P predictor:1,1',
    'H Field P encoding:1,0',
    'H Field G name:time,GPS_numSat,GPS_coord[0],GPS_coord[1],GPS_altitude,GPS_speed',
    'H Field G signed:0,0,1,1,0,0',
    'H Field G predictor:0,0,0,0,0,0',
    'H Field G encoding:1,1,0,0,1,1',
    'H Firmware type:Rotorflight',
    'H Firmware revision:Rotorflight 4.6.0 (gps fixture) STM32H743',
    ''
  ].join('\n'));

  writer.ascii('I').unsignedVB(1000).signedVB(7);
  writer.ascii('G').unsignedVB(1000).unsignedVB(14)
    .signedVB(374_930_158).signedVB(-801_133_668)
    .unsignedVB(4321).unsignedVB(93);
  writer.ascii('P').unsignedVB(500).signedVB(1);
  writer.ascii('G').unsignedVB(1500).unsignedVB(15)
    .signedVB(374_930_200).signedVB(-801_133_700)
    .unsignedVB(4400).unsignedVB(120);
  writeLogEnd(writer);

  return new Uint8Array(writer.toBuffer());
}

test('GPS frames reach the caller as flight data, and never as a location', () => {
  const [session] = decodeLog(gpsLog()).sessions;

  assert.deepEqual(session.errors, []);
  assert.equal(session.frameCounts.G, 2);

  // The part that is about the flight survives, and is placed on the sample
  // axis the same way an event is.
  assert.deepEqual(session.gps, [
    {sampleIndex: 1, timeUs: 1000, numSat: 14, speed: 93, altitude: 4321},
    {sampleIndex: 2, timeUs: 1500, numSat: 15, speed: 120, altitude: 4400}
  ]);

  // The part that is about the pilot does not. Searched for by VALUE across the
  // whole serialized session, not by key name: a coordinate that reappeared
  // under a different key, inside a sample row, or nested in a frame count
  // would pass a key-name check and still be a leak.
  const serialized = JSON.stringify(session);
  for (const coordinate of ['374930158', '-801133668', '374930200', '-801133700']) {
    assert.ok(
      !serialized.includes(coordinate),
      `coordinate ${coordinate} escaped the decoder`
    );
  }
  assert.ok(serialized.includes('4321'), 'the control: a published G value is present');
});

test('a log whose G frames carry only coordinates publishes nothing', () => {
  const writer = new ByteWriter();
  writer.ascii([
    'H Product:Blackbox flight data recorder by Nicholas Sherlock',
    'H Data version:2',
    'H Field I name:time,gyroADC[0]',
    'H Field I signed:0,1',
    'H Field I predictor:0,0',
    'H Field I encoding:1,0',
    'H Field P predictor:0,1',
    'H Field P encoding:1,0',
    'H Field G name:GPS_coord[0],GPS_coord[1]',
    'H Field G signed:1,1',
    'H Field G predictor:0,0',
    'H Field G encoding:0,0',
    'H Firmware type:Rotorflight',
    'H Firmware revision:Rotorflight 4.6.0 (coords only) STM32H743',
    ''
  ].join('\n'));
  writer.ascii('I').unsignedVB(1000).signedVB(7);
  writer.ascii('G').signedVB(374_930_158).signedVB(-801_133_668);
  writeLogEnd(writer);

  const [session] = decodeLog(new Uint8Array(writer.toBuffer())).sessions;
  assert.deepEqual(session.errors, []);
  assert.equal(session.frameCounts.G, 1, 'the frame is still consumed, so the stream stays in sync');
  assert.deepEqual(session.gps, [], 'a row of nulls is not evidence and must not be emitted');
});

test('an event type we have never observed resyncs rather than guessing', async () => {
  const bytes = await loadFixture('rf43-single-session.TXT');
  const copy = new Uint8Array(bytes);

  // Rewrite a known event's type to one whose payload length is unknown. It must
  // be reported, not silently skipped by a guessed length.
  let index = -1;
  for (let at = 4000; at < copy.length - 2; at += 1) {
    if (copy[at] === 0x45 && copy[at + 1] === 52) {
      index = at;
      break;
    }
  }
  assert.ok(index > 0, 'fixture must contain a state event to mutate');
  copy[index + 1] = 53; // not assigned by Rotorflight 4.6

  const [session] = decodeLog(copy).sessions;
  assert.ok(
    session.errors.some(error => /Unknown event type 53/.test(error.message)),
    'an unobserved event type must be reported loudly'
  );
});

test('a log declaring GPS fields is flagged before any decoding happens', async () => {
  const result = decodeLog(await loadFixture('rf46-gps-declared.TXT'), {lazy: true});
  assert.equal(result.sessions[0].locationFieldsDeclared, true);
  assert.equal(result.sessions[0].framesDecoded, false, 'the flag must not need a decode');
});

test('keyframe positions are reported so absolute frames can be told from deltas', async () => {
  const result = decodeLog(await loadFixture('rf43-single-session.TXT'));
  const [session] = result.sessions;

  assert.equal(session.intraSampleIndices.length, session.frameCounts.I);
  assert.equal(session.intraSampleIndices[0], 0, 'a session opens on a keyframe');
  for (const index of session.intraSampleIndices) {
    assert.ok(index >= 0 && index < session.samples.length, `${index} is not a sample position`);
  }
  // Strictly increasing: the frame loop appends, so out-of-order would mean the
  // index and the sample array had come apart.
  for (let at = 1; at < session.intraSampleIndices.length; at += 1) {
    assert.ok(session.intraSampleIndices[at] > session.intraSampleIndices[at - 1]);
  }
});

/**
 * Hand-built log putting the GPS home predictor on main-frame fields.
 *
 * Real firmware only uses HOME_COORD inside `G` frames, whose values the decoder
 * deliberately does not surface — so the rule it encodes ("the Nth HOME_COORD
 * field predicts against the Nth home coordinate") is not observable through any
 * real log. Declaring the predictor on `I` fields makes it observable without
 * changing the rule under test.
 */
function homeCoordLog({home, residuals}) {
  const writer = new ByteWriter();
  writer.ascii([
    'H Product:Blackbox flight data recorder by Nicholas Sherlock',
    'H Data version:2',
    'H Field I name:time,coordA,coordB',
    'H Field I signed:0,1,1',
    'H Field I predictor:0,7,7',
    'H Field I encoding:1,0,0',
    'H Field P predictor:0,1,1',
    'H Field P encoding:1,0,0',
    'H Field H name:GPS_home[0],GPS_home[1]',
    'H Field H signed:1,1',
    'H Field H predictor:0,0',
    'H Field H encoding:0,0',
    'H Firmware type:Rotorflight',
    'H Firmware revision:Rotorflight 4.6.0 (home-coord fixture) STM32H743',
    ''
  ].join('\n'));

  writer.ascii('H').signedVB(home[0]).signedVB(home[1]);
  writer.ascii('I').unsignedVB(1000).signedVB(residuals[0]).signedVB(residuals[1]);
  writeLogEnd(writer);

  return new Uint8Array(writer.toBuffer());
}

test('each GPS coordinate predicts against its own home coordinate, not the first one', () => {
  // Latitude against home latitude, longitude against home longitude. This was
  // indexed by position within the decoded group instead of by field, and both
  // coordinates are their own group, so longitude silently predicted against home
  // LATITUDE — an error of (home_lat − home_lon), which for the one real log we
  // hold is zero because every home frame in it decodes to [0, 0].
  const [session] = decodeLog(homeCoordLog({
    home: [374_930_158, -801_133_668],
    residuals: [112, 4104]
  })).sessions;

  assert.deepEqual(session.errors, []);
  assert.deepEqual(session.samples, [[1000, 374_930_270, -801_129_564]]);

  // A zero home cannot distinguish the two indexings — which is exactly why the
  // real log looked correct. Pin that the corpus does not repeat that mistake.
  const [zeroed] = decodeLog(homeCoordLog({home: [0, 0], residuals: [112, 4104]})).sessions;
  assert.deepEqual(zeroed.samples, [[1000, 112, 4104]]);
});

test('a dump ending in erased-flash padding is a truncated capture, not a damaged log', () => {
  // A dataflash capture cut by power-off does not stop at a frame boundary: it
  // stops wherever the last write reached, followed by erased 0xff cells. That
  // surfaces as a corrupt-frame error (0xff is no frame marker), never as a
  // `truncated` one — so classifying the tail by error code alone reported
  // every such ordinary capture as damaged, the exact false alarm
  // log-integrity.mjs exists to prevent.
  const writer = new ByteWriter();
  writer.ascii([
    'H Product:Blackbox flight data recorder by Nicholas Sherlock',
    'H Data version:2',
    'H Field I name:time',
    'H Field I signed:0',
    'H Field I predictor:0',
    'H Field I encoding:1',
    'H Field P predictor:1',
    'H Field P encoding:0',
    'H Firmware type:Rotorflight',
    'H Firmware revision:Rotorflight 4.6.0 (protocol fixture) STM32H743',
    ''
  ].join('\n'));
  writer.ascii('I').unsignedVB(1000);
  writer.ascii('P').signedVB(10);
  for (let index = 0; index < 8192; index += 1) {
    writer.u8(0xff); // erased flash, deliberately wider than TAIL_TOLERANCE_BYTES
  }
  const bytes = new Uint8Array(writer.toBuffer());

  const [session] = decodeLog(bytes).sessions;
  assert.deepEqual(session.samples, [[1000], [1010]], 'the flown frames must survive');
  assert.equal(session.truncated, true);
  assert.ok(session.errors.length > 0, 'the cut must be reported, not hidden');

  const integrity = sessionIntegrity(session, bytes.length);
  assert.equal(integrity.state, 'truncated',
    'a power-cut capture must never be reported as a misread log');
  assert.deepEqual(integrity.bodyErrors, []);
});

test('a capture cut inside a float payload is truncated, not damaged', () => {
  // floatLE throws `truncated` with 1-3 bytes remaining, so the reader stops
  // BEFORE the session end; the flag on the error, not the final offset, is
  // what records that the capture stopped mid-frame.
  const cut = protocolLog({body(writer) {
    writer.ascii('I').unsignedVB(1000);
    writer.ascii('E').u8(13).u8(0x85); // inflight adjustment, float flag set
    writer.u8(0x00).u8(0x00); // two of the four float bytes, then the cut
  }});

  const [session] = decodeLog(cut).sessions;
  assert.equal(session.truncated, true);
  assert.ok(session.errors.some(error => error.code === 'truncated'));
  assert.equal(sessionIntegrity(session, cut.length).state, 'truncated');
});

test('a rejected frame\'s own payload is not rescanned for frame markers', () => {
  // A P frame that decodes cleanly but fails the monotonicity check has a known
  // end offset. Resyncing from inside its payload would treat payload bytes
  // that happen to match 'I'/'P'/'E'... as frame starts and cascade errors.
  const bytes = protocolLog({body(writer) {
    writer.ascii('I').unsignedVB(100_000);
    // Backwards time step: residual encodes -50_000, and the varint bytes of
    // zigzag(-50_000) = 0x9f 0x8d 0x06 contain no frame marker; pad the frame
    // with a following P frame whose bytes DO contain marker-valued bytes.
    writer.ascii('P').signedVB(-50_000);
    writer.ascii('P').signedVB(10);
    writeLogEnd(writer);
  }});

  const [session] = decodeLog(bytes).sessions;
  const monotonicity = session.errors.filter(error =>
    /monotonicity/.test(error.message ?? ''));
  assert.equal(monotonicity.length, 1, 'exactly one frame is rejected');
  assert.equal(session.frameCounts.rejected, 1);
  // The following P frame is dropped (its delta base is gone), and the stream
  // then ends cleanly: no cascade of secondary errors from payload rescanning.
  assert.equal(session.errors.length, 1);
  assert.equal(session.frameCounts.droppedInterFrames, 1);
  assert.equal(session.reachedLogEnd, true);
});
