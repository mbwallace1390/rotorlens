/**
 * Decoder conformance against owner-supplied firmware logs.
 *
 * Real logs are deliberately not committed: they require explicit publication
 * permission and metadata sidecars. Set ROTORLENS_REAL_LOG and/or the
 * semicolon-separated ROTORLENS_CORPUS_LOGS to run this gate locally or in a
 * private CI job. Synthetic round-trip tests cannot replace this check because
 * a writer and reader can share the same wrong bit layout.
 */

import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import path from 'node:path';

import {decodeLog} from '../src/blackbox/decode.mjs';
import {measureIntraFrameContinuity} from '../src/blackbox/continuity.mjs';
import {sessionEndOffset, sessionIntegrity} from '../src/blackbox/log-integrity.mjs';

const LOG_PATHS = [...new Set([
  process.env.ROTORLENS_REAL_LOG,
  ...(process.env.ROTORLENS_CORPUS_LOGS ?? '').split(';')
].filter(Boolean).map(file => path.resolve(file)))];

const realLogSkip = LOG_PATHS.length === 0 &&
  'set ROTORLENS_REAL_LOG or ROTORLENS_CORPUS_LOGS to owner-approved .bbl paths';
const continuitySkip = !process.env.ROTORLENS_REAL_LOG &&
  'set ROTORLENS_REAL_LOG to a continuity-capable owner-approved .bbl path';

let decodedCorpus;
function corpus() {
  decodedCorpus ??= LOG_PATHS.map(file => {
    const bytes = new Uint8Array(readFileSync(file));
    return {file, bytes, result: decodeLog(bytes)};
  });
  return decodedCorpus;
}

test('owner-supplied firmware logs decode without body damage or lost alignment',
  {skip: realLogSkip}, () => {
    let decodedSessions = 0;

    for (const {file, bytes, result} of corpus()) {
      assert.ok(result.sessions.length > 0, `${path.basename(file)} contains no supported sessions`);

      for (const session of result.sessions) {
        decodedSessions += 1;
        assert.equal(session.firmware.type?.toLowerCase(), 'rotorflight');
        const integrity = sessionIntegrity(
          session,
          sessionEndOffset(result, session.index, bytes.length)
        );
        assert.deepEqual(
          integrity.bodyErrors,
          [],
          `${path.basename(file)} session ${session.index} has body errors: ` +
            JSON.stringify(integrity.bodyErrors)
        );
        assert.equal(session.limitExceeded, false);
        assert.equal(session.frameCounts.rejected, 0);
        if (integrity.state !== 'truncated') {
          assert.equal(session.frameCounts.resyncBytes, 0,
            `${path.basename(file)} session ${session.index} lost frame alignment`);
        }
      }
    }

    assert.ok(decodedSessions > 0);
  });

test('owner-supplied firmware values are continuous across I-frame boundaries',
  {skip: continuitySkip}, () => {
    let measuredSessions = 0;

    const target = path.resolve(process.env.ROTORLENS_REAL_LOG);
    for (const {file, result} of corpus().filter(entry => entry.file === target)) {
      for (const session of result.sessions) {
        const continuity = measureIntraFrameContinuity({
          samples: session.samples,
          intraSampleIndices: session.intraSampleIndices,
          fields: session.fields
        });
        if (!continuity.measured) continue;

        measuredSessions += 1;
        assert.deepEqual(
          continuity.flagged,
          [],
          `${path.basename(file)} session ${session.index} has keyframe discontinuity: ` +
            continuity.flagged.map(field => `${field.name}=${field.ratio}x`).join(', ')
        );
      }
    }

    assert.ok(measuredSessions > 0, 'configured corpus has no session large enough for continuity');
  });
