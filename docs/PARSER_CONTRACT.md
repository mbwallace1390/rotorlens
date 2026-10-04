# Parser adapter contract

Contract version: `0.1.0`

The RotorLens application owns a small normalized result shape. Engine-facing
code is isolated behind one asynchronous operation:

```text
decode(Uint8Array bytes, DecodeOptions options) -> Promise<ParserReport>
```

Minimum `ParserReport` shape:

```json
{
  "contractVersion": "0.1.0",
  "engine": {
    "name": "decoder-engine-identifier",
    "version": "pinned-revision-or-release",
    "license": "MPL-2.0"
  },
  "sessions": [
    {
      "index": 0,
      "firmware": {
        "type": "Rotorflight",
        "version": "4.3.0"
      },
      "craftName": "optional",
      "fields": [
        {"name": "gyroADC[0]", "unit": "optional", "sampleCount": 0}
      ]
    }
  ]
}
```

The runtime validator (`validateParserReport` in `src/parser-contract.mjs`)
requires only the contract version, the engine's name, version and license, a
sessions array, each session's non-negative integer `index`, a `firmware` object
with a `type`, and a `fields` array whose entries have a `name`. Everything else
is optional.

The shipped adapter, `blackboxAdapter` in `src/blackbox/decode.mjs`, also
returns each session's `firmware.version` where the revision contains one,
`craftName`, each field's `index`, `signed` and `sampleCount`, and the session's
decode `errors`. Duration, units, events, time series, spectra, and other
diagnostics are optional future extensions.

## Rules

- Inputs are immutable bytes; an adapter must not receive filesystem authority.
- Decode errors are data, not crashes. The adapter should return typed error
  codes for unsupported firmware, corrupt headers, truncated frames, and memory
  limits. The shipped adapter uses the codes in `src/blackbox/errors.mjs`:
  `unsupported-firmware`, `corrupt-header`, `corrupt-frame`, `truncated`,
  `unsupported-encoding`, `unsupported-predictor` and `limit-exceeded`. A
  `limit-exceeded` error names its `resource`, including `cell` for the
  decoded-value budget; a `truncated` error whose capture ran into erased flash
  carries `erasedBytes`.
- Raw personal metadata must not leave the device without explicit user action.
- UI code must not depend directly on Rust/WASM object layouts.
- Contract changes require fixtures and a version bump.
- If the engine is third-party, its attribution, exact commit identity, and
  license must be reachable from the shipped application's legal/about view.
  See docs/LICENSING_AND_STORE_READINESS.md.

This contract is intentionally an original RotorLens abstraction and does not
reproduce any third-party public API. Keeping it that way is what lets the
decoder engine be swapped, or replaced with our own, without touching the app.
