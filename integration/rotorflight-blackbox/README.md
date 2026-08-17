# Blackbox viewer integration

How the GPL-3.0 Rotorflight Blackbox viewer fork consumes RotorLens' PID evidence
analysis, so both projects run **the same code** instead of two implementations
that quietly disagree about whether a tune change helped.

Target repository: `mbwallace1390/rotorflight-blackbox`.

The integration patch is pinned to immutable base commit
`492bee5b5835a2a88ec725489e5e6d4ee52c678f` (tree
`ae1bca03d11a713c19e13d156a27d6591316cf03`). The branch name
`codex/cross-platform-foundation` is historical context only and must never be
used as the reproducibility boundary.

## What this closes

The viewer's Tune Center had complete Governor F guidance, and roll/pitch cyclic
PID as a preview. Yaw and the I term were not half-finished — they were switched
off on purpose:

```js
if (selection.term === "I")  { addCode(codes, "I_TERM_HOLD_EVIDENCE_UNSUPPORTED"); }
if (selection.axis === "yaw") { addCode(codes, "YAW_DIRECTIONAL_EVIDENCE_UNSUPPORTED"); }
```

(The two lines above are quoted from the fork's Tune Center. As fork code they
are GPL-3.0-covered context, like the patch beside this file, and are not
RotorLens source; the root MPL licence does not cover this quotation.)

Every yaw capture, and every I-term capture on any axis, was stamped
inconclusive. Both gates were honest — the evidence really was missing — and both
are now replaced by evidence rather than deleted:

- **Yaw** needed per-direction evidence. A helicopter's tail works with main-rotor
  torque one way and against it the other, so pooling left and right stops
  averages a real asymmetry into a number describing neither. Directions are now
  kept separate end to end.
- **The I term** needed hold evidence. Stop events measure what happens after a
  command is released, which is where P and D live; the I term acts on sustained
  error and is invisible there. Steady holds are measured instead.

## Licensing

The analysis lives in RotorLens under **MPL-2.0**
(`src/analysis/pid-evidence.mjs`) and is built to
`dist/rotorlens-pid-evidence.js`. MPL-2.0 section 3.3 permits that covered file
to be additionally distributed under GPL-3.0 when it is part of the viewer's
Larger Work. The original RotorLens source remains available under MPL-2.0. The
generated file carries the MPL notice, creator copyright, and secondary-license
basis in its header so the provenance travels with it.

`0001-consume-rotorlens-pid-evidence.patch` is different: it contains context
and modifications against the GPL-3.0-only viewer, so the patch itself is GPL-covered
and is not relicensed by RotorLens' root MPL-2.0 license. Only the independently
generated RotorLens bundle described above is MPL-covered at this boundary.

[`LICENSE`](LICENSE) is the complete GPL version 3 text from that pinned viewer
commit, normalized only by adding one final LF (SHA-256
`e57f1c320b8cf8798a7d2ff83a6f9e06a33a03585f6e065fea97f1d86db84052`).
The 15,161-byte patch has SHA-256
`bb49324ec62e71efc2f877dab3ad4dbd3fc22ddc99fcc26a5de25b47a61aab83`.

This is the point of doing it this way: the work lands somewhere publishable
instead of only inside the GPL project.

## Applying

```bash
cd /path/to/rotorflight-blackbox
git checkout --detach 492bee5b5835a2a88ec725489e5e6d4ee52c678f

cp /path/to/rotorlens/dist/rotorlens-pid-evidence.js js/advisor/pid_evidence.js
git apply /path/to/rotorlens/integration/rotorflight-blackbox/0001-consume-rotorlens-pid-evidence.patch

npm test
```

The patch was applied and the viewer's full suite run green before it was
committed here. Regenerate the bundle with `npm run build:advisor-bundle` in
RotorLens after any change to the analysis, and copy it across again — never edit
`js/advisor/pid_evidence.js` in place.

## What the patch changes

| File | Change |
| --- | --- |
| `js/advisor/pid_evidence.js` | New: the generated MPL-2.0 build, additionally distributable under GPL-3.0 in this Larger Work (copied, not patched) |
| `0001-consume-rotorlens-pid-evidence.patch` | GPL-covered viewer integration patch; not covered by the RotorLens root license |
| `js/advisor/cyclic_pid_analysis.js` | Resolves the module; replaces both gates with real evidence; carries `directionalEvidence` / `holdEvidence` on captures; compares within each direction and scores the I term from holds |
| `js/advisor/advisor_ui.js` | Adds the new codes to the UI capture/comparison schemas and writes plain-language explanations for each |
| `index.html` | Loads `pid_evidence.js` before `cyclic_pid_analysis.js` |
| `test/advisor_cyclic_pid.js` | The two assertions that pinned the old "withheld" behavior now pin what replaced it |
| `test/mobile_compatibility_smoke.js` | Hand-built capture/comparison fixtures gain the two new keys |

## Two things the viewer's own tests caught

Worth keeping, because both were real:

1. **The advice-key rail.** `assertNoAdviceKeys` forbids `delta`, `direction`,
   `recommendation`, `write` and similar from any evidence object, so nothing
   downstream can mistake a measurement for an instruction to a flight
   controller. The module used `delta` and `direction`; they were renamed to
   `difference` and `indication` in RotorLens rather than weakening the rail.
2. **The settle window.** The viewer's synthetic log leaves ~850 ms between
   stops, and those gaps were being admitted as holds — while the aircraft is
   still ringing down from the stop, which is exactly the P/D behavior that must
   not be read as an I-term fault. The settle window is now a full second,
   matching how long the post-stop response is treated as lasting elsewhere in
   the analysis, and the minimum hold is 1.4 s.

## Still open in the viewer

The patch makes yaw and I-term evidence real and comparable. It does **not**
promote cyclic PID from "preview" to the first-class next-test guidance Governor
F has — that is a Tune Center flow change, not an evidence change, and it was
deliberately left out of this patch.
