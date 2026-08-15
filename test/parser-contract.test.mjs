import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeWithAdapter,
  PARSER_CONTRACT_VERSION,
  summarizeParserReport,
  validateParserReport
} from '../src/parser-contract.mjs';

function validReport() {
  return {
    contractVersion: PARSER_CONTRACT_VERSION,
    engine: {
      name: 'test-adapter',
      version: '0.0.0',
      license: 'MPL-2.0'
    },
    sessions: [
      {
        index: 0,
        firmware: {type: 'Rotorflight', version: '4.3.0'},
        craftName: 'fixture',
        fields: [{name: 'gyroADC[0]'}, {name: 'headspeed'}]
      }
    ]
  };
}

test('adapter boundary accepts and summarizes a normalized parser report', async () => {
  const adapter = {decode: async () => validReport()};
  const report = await decodeWithAdapter(adapter, new Uint8Array([1, 2, 3]));
  const summary = summarizeParserReport(report);

  assert.equal(summary.sessionCount, 1);
  assert.equal(summary.sessions[0].fieldCount, 2);
  assert.deepEqual(summary.sessions[0].fieldNames, ['gyroADC[0]', 'headspeed']);
});
test('adapter boundary fails closed on incompatible results', async () => {
  await assert.rejects(
    decodeWithAdapter({decode: async () => ({sessions: []})}, new Uint8Array()),
    /Unsupported parser contract/
  );

  const invalid = validReport();
  invalid.sessions[0].fields = [{name: ''}];
  assert.throws(() => validateParserReport(invalid), /must be a non-empty string/);
});
