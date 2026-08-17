import assert from 'node:assert/strict';
import test from 'node:test';
import {parseSession} from '../src/blackbox/headers.mjs';

const textEncoder = new TextEncoder();

function headerBytes(lines, suffix = 'I') {
  return textEncoder.encode(`${lines.join('\n')}\n${suffix}`);
}

const MINIMAL_HEADER = [
  'H Product:Blackbox flight data recorder by Nicholas Sherlock',
  'H Data version:2',
  'H Firmware type:Rotorflight',
  'H Firmware revision:Rotorflight 4.6.0 (header fixture) STM32F7X2'
];

test('parseSession does not retain ordered header entries by default', () => {
  const session = parseSession(headerBytes(MINIMAL_HEADER), 0, 0);

  assert.equal(Object.hasOwn(session, 'headerEntries'), false);
  assert.equal(session.headerTerminationClean, true);
  assert.equal(session.headerKeysUnique, true);
  assert.equal(session.headerCount, MINIMAL_HEADER.length);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(session, 'headerTerminationClean'),
    {
      value: true,
      enumerable: true,
      writable: false,
      configurable: false
    }
  );
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(session, 'headerKeysUnique'),
    {
      value: true,
      enumerable: true,
      writable: false,
      configurable: false
    }
  );
  assert.equal(Object.isFrozen(session), false);
  assert.throws(() => {
    session.headerTerminationClean = false;
  }, TypeError);
});

test('parseSession retains an immutable ordered header snapshot only when requested', () => {
  const lines = [...MINIMAL_HEADER, 'H gyro_lpf1_static_hz:100', 'H gyro_lpf1_static_hz:200'];
  const session = parseSession(headerBytes(lines), 0, 0, {retainHeaderEntries: true});

  assert.equal(session.headerKeysUnique, false);
  assert.equal(Object.isFrozen(session.headerEntries), true);
  assert.equal(session.headerEntries.every(Object.isFrozen), true);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(session, 'headerEntries'),
    {
      value: session.headerEntries,
      enumerable: true,
      writable: false,
      configurable: false
    }
  );
  assert.equal(Object.isFrozen(session), false);
  assert.deepEqual(
    session.headerEntries.slice(-2),
    [
      {key: 'gyro_lpf1_static_hz', value: '100'},
      {key: 'gyro_lpf1_static_hz', value: '200'}
    ]
  );
  assert.throws(() => session.headerEntries.push({key: 'extra', value: '1'}), TypeError);
  assert.throws(() => {
    session.headerEntries[0].value = 'changed';
  }, TypeError);
  assert.throws(() => {
    session.headerEntries = Object.freeze([]);
  }, TypeError);
  assert.throws(() => {
    delete session.headerEntries;
  }, TypeError);
});

test('parseSession reports unterminated and malformed trailing header lines as unclean', () => {
  const unterminated = parseSession(
    headerBytes(MINIMAL_HEADER, 'H gyro_lpf1_static_hz:100'),
    0,
    0,
    {retainHeaderEntries: true}
  );
  const malformed = parseSession(
    headerBytes(MINIMAL_HEADER, 'H malformed setting\n'),
    0,
    0,
    {retainHeaderEntries: true}
  );
  const emptyKey = parseSession(
    headerBytes(MINIMAL_HEADER, 'H :value\n'),
    0,
    0,
    {retainHeaderEntries: true}
  );

  assert.equal(unterminated.headerTerminationClean, false);
  assert.equal(malformed.headerTerminationClean, false);
  assert.equal(emptyKey.headerTerminationClean, false);
  assert.equal(
    unterminated.headerEntries.some(entry => entry.key === 'gyro_lpf1_static_hz'),
    false,
    'an unterminated setting must not enter retained evidence'
  );
  assert.equal(
    malformed.headerEntries.some(entry => entry.key === 'malformed setting'),
    false,
    'a malformed setting must not enter retained evidence'
  );
});

test('a ratio-spelled `P interval` yields the step from its denominator', () => {
  // `P interval:1/2` means one logged frame per two loop iterations — a step of
  // 2, from the DENOMINATOR. Taking the leading integer read it as 1, which is
  // the exact loopIteration-sawtooth defect the `I interval`/`P ratio`
  // derivation was added to fix, alive on the alternate header spelling.
  const step = lines => parseSession(headerBytes([...MINIMAL_HEADER, ...lines]), 0, 0)
    .constants.incrementStep;

  assert.equal(step(['H P interval:1/2']), 2);
  assert.equal(step(['H P interval:1/1']), 1);
  assert.equal(step(['H P interval:2/4']), 2);
  assert.equal(step(['H P interval:2']), 2, 'the bare-step spelling keeps working');
  // The quotient derivation still wins when both headers are present.
  assert.equal(step(['H I interval:64', 'H P ratio:32', 'H P interval:1/4']), 2);
  // Malformed ratios fall back rather than crash.
  assert.equal(step(['H P interval:3/2']), 3, 'a non-integral ratio falls back to the leading integer');
  assert.equal(step(['H P interval:0/0']), 1);
});
