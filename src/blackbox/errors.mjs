/**
 * Typed decode failures.
 *
 * The parser contract requires that decode errors are data, not crashes. Every
 * failure mode below is something a real log can legitimately contain — logs get
 * truncated by brownouts, corrupted by bad SD cards, and written by firmware we
 * have never seen. None of it may take down the app.
 */

export const DecodeErrorCode = Object.freeze({
  TRUNCATED: 'truncated',
  CORRUPT_FRAME: 'corrupt-frame',
  CORRUPT_HEADER: 'corrupt-header',
  UNSUPPORTED_ENCODING: 'unsupported-encoding',
  UNSUPPORTED_PREDICTOR: 'unsupported-predictor',
  UNSUPPORTED_FIRMWARE: 'unsupported-firmware',
  LIMIT_EXCEEDED: 'limit-exceeded'
});

export class DecodeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DecodeError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {code: this.code, message: this.message, ...this.details};
  }
}

export function truncated(message, details) {
  return new DecodeError(DecodeErrorCode.TRUNCATED, message, details);
}

export function corruptFrame(message, details) {
  return new DecodeError(DecodeErrorCode.CORRUPT_FRAME, message, details);
}
