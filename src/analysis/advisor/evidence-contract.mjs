/**
 * The evidence package shape.
 *
 * Ported from `js/advisor/evidence_contract.js` on the
 * `codex/cross-platform-foundation` branch of mbwallace1390/rotorflight-blackbox,
 * written 10 August 2026 by Michael Wallace, its sole author. Relicensed
 * MPL-2.0 by that author; see `docs/ARCHITECTURE_AND_PROVENANCE.md` for the
 * record.
 *
 * Defines how a piece of evidence is built, capped, rounded, and packaged, so
 * that whatever presents it cannot quietly invent a number. Converted from UMD
 * to an ES module mechanically; the logic is unchanged.
 */

var SCHEMA_VERSION = 3;
var ENGINE_VERSION = "0.3.0";
var MAX_EVIDENCE_ITEMS = 96;
var MAX_FINDINGS = 32;

var SOURCES = Object.freeze([
    Object.freeze({
        id: "rotorflight-blackbox",
        title: "Rotorflight Blackbox",
        url: "https://rotorflight.org/docs/2.0.0/Wiki/Configurator/Blackbox"
    }),
    Object.freeze({
        id: "rotorflight-filter-tuning",
        title: "Rotorflight First Flight & Filter Tuning",
        url: "https://rotorflight.org/docs/Tuning/First-Flight-Filter-Tuning"
    }),
    Object.freeze({
        id: "rotorflight-governor-tuning",
        title: "Rotorflight Tune the Governor",
        url: "https://rotorflight.org/docs/2.2.0/Tuning/Tune-Governor"
    })
]);

function roundNumber(value, digits) {
    if (!Number.isFinite(value)) {
        return null;
    }

    var places = digits === undefined ? 3 : digits;
    var scale = Math.pow(10, places);
    return Math.round(value * scale) / scale;
}

function compact(value) {
    if (value === undefined || typeof value === "function") {
        return undefined;
    }

    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }

    if (value === null || typeof value !== "object") {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map(compact).filter(function(item) {
            return item !== undefined;
        });
    }

    var result = {};
    Object.keys(value).forEach(function(key) {
        var item = compact(value[key]);
        if (item !== undefined) {
            result[key] = item;
        }
    });
    return result;
}

function EvidenceBuilder() {
    this.items = [];
    this.ids = Object.create(null);
}

EvidenceBuilder.prototype.add = function(item) {
    if (!item || typeof item.id !== "string" || item.id.length === 0) {
        throw new TypeError("Evidence requires a stable non-empty id");
    }

    if (this.ids[item.id]) {
        throw new Error("Duplicate evidence id: " + item.id);
    }

    if (this.items.length >= MAX_EVIDENCE_ITEMS) {
        throw new RangeError("Evidence package exceeded its compact item limit");
    }

    var compactItem = compact(item);
    this.ids[item.id] = true;
    this.items.push(compactItem);
    return item.id;
};

function makePackage(sections) {
    var result = compact({
        schemaVersion: SCHEMA_VERSION,
        engineVersion: ENGINE_VERSION,
        analysisMode: "deterministic-local",
        capabilities: {
            cloudRequired: false,
            directSettingWrites: false,
            settingDirectionAdvice: true,
            selectedRangeRequired: true,
            rawLogIncluded: false
        },
        recommendationPolicy: {
            settingAllowlist: ["gov_f_gain"],
            outputKind: "next-controlled-test",
            directSettingWrites: false,
            finalTuneClaims: false
        },
        log: sections.log,
        range: sections.range,
        grade: sections.grade,
        quality: sections.quality,
        coverage: sections.coverage,
        tracking: sections.tracking,
        battery: sections.battery,
        governor: sections.governor,
        evidence: sections.evidence || [],
        findings: sections.findings || [],
        sources: SOURCES
    });

    if (result.evidence.length > MAX_EVIDENCE_ITEMS) {
        throw new RangeError("Evidence package is too large");
    }

    if (result.findings.length > MAX_FINDINGS) {
        throw new RangeError("Finding package is too large");
    }

    return result;
}

export {
  SCHEMA_VERSION,
  ENGINE_VERSION,
  SOURCES,
  EvidenceBuilder,
  compact,
  makePackage,
  roundNumber
};
