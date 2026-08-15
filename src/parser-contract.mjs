export const PARSER_CONTRACT_VERSION = '0.1.0';

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}
function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

/**
 * Validates RotorLens' app-owned normalized parser result. A future adapter
 * translates whichever decoder engine is adopted into this shape. The shape is an
 * original RotorLens abstraction and reproduces no third-party API.
 */
export function validateParserReport(report) {
  requireObject(report, 'report');
  if (report.contractVersion !== PARSER_CONTRACT_VERSION) {
    throw new TypeError(`Unsupported parser contract: ${report.contractVersion ?? 'missing'}`);
  }

  requireObject(report.engine, 'report.engine');
  requireNonEmptyString(report.engine.name, 'report.engine.name');
  requireNonEmptyString(report.engine.version, 'report.engine.version');
  requireNonEmptyString(report.engine.license, 'report.engine.license');

  if (!Array.isArray(report.sessions)) {
    throw new TypeError('report.sessions must be an array');
  }

  report.sessions.forEach((session, sessionIndex) => {
    requireObject(session, `report.sessions[${sessionIndex}]`);
    if (!Number.isInteger(session.index) || session.index < 0) {
      throw new TypeError(`report.sessions[${sessionIndex}].index must be a non-negative integer`);
    }
    requireObject(session.firmware, `report.sessions[${sessionIndex}].firmware`);
    requireNonEmptyString(
      session.firmware.type,
      `report.sessions[${sessionIndex}].firmware.type`
    );
    if (!Array.isArray(session.fields)) {
      throw new TypeError(`report.sessions[${sessionIndex}].fields must be an array`);
    }
    session.fields.forEach((field, fieldIndex) => {
      requireObject(field, `report.sessions[${sessionIndex}].fields[${fieldIndex}]`);
      requireNonEmptyString(
        field.name,
        `report.sessions[${sessionIndex}].fields[${fieldIndex}].name`
      );
    });
  });

  return report;
}

export async function decodeWithAdapter(adapter, bytes, options = {}) {
  if (!adapter || typeof adapter.decode !== 'function') {
    throw new TypeError('Parser adapter must provide an async decode(bytes, options) function');
  }
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('Parser input must be a Uint8Array');
  }

  const report = await adapter.decode(bytes, options);
  return validateParserReport(report);
}

export function summarizeParserReport(report) {
  validateParserReport(report);

  return {
    engine: report.engine,
    sessionCount: report.sessions.length,
    sessions: report.sessions.map(session => ({
      index: session.index,
      firmware: session.firmware,
      craftName: session.craftName ?? null,
      fieldCount: session.fields.length,
      fieldNames: session.fields.map(field => field.name)
    }))
  };
}
