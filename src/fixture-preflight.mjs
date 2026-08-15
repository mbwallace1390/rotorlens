/**
 * Fast header-only inventory of a log.
 *
 * Header parsing lives in `src/blackbox/headers.mjs` and is shared with the
 * decoder — one parser, so an inventory can never disagree with a decode. This
 * module is the summary view: what firmware, what craft, what fields, and
 * whether the log declares location data, without touching the frame stream.
 */

import {sha256Hex} from './integrity.mjs';
import {parseSessions} from './blackbox/headers.mjs';

function asUint8Array(bytes) {
  if (bytes instanceof Uint8Array) {
    return bytes;
  }
  throw new TypeError('Fixture bytes must be a Buffer or Uint8Array');
}

export function inspectFixtureHeaders(bytes, sourceName = 'unknown') {
  const input = asUint8Array(bytes);
  const sessions = parseSessions(input);

  return {
    inspector: 'rotorlens-fixture-header-preflight',
    inspectorVersion: 2,
    sourceName,
    byteLength: input.length,
    sha256: sha256Hex(input),
    sessionCount: sessions.length,
    sessions: sessions.map(session => ({
      index: session.index,
      byteOffset: session.byteOffset,
      dataOffset: session.dataOffset,
      headerCount: session.headerCount,
      product: session.product,
      dataVersion: session.dataVersion,
      firmware: session.firmware,
      board: session.board,
      craftName: session.craftName,
      fieldGroups: Object.entries(session.frames)
        .filter(([, table]) => table !== null)
        .map(([frameType, table]) => ({
          frameType,
          count: table.fields.length,
          fields: table.fields.map(field => field.name)
        })),
      locationFieldsDeclared: session.locationFieldsDeclared,
      locationFields: session.locationFields
    })),
    limitations: ['Header inventory only; use decodeLog() to read frame data.']
  };
}
