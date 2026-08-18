# Open-source licensing and store readiness

This is the engineering record for RotorLens licensing, provenance, attribution,
and mobile-store distribution. It is not legal advice. Have an IP attorney review
the shipped Android and iOS builds, store agreements, contribution process, data
terms, and trademark policy before public release.

## 1. Current decision

Verified 2026-08-15:

- RotorLens was originally created by **Michael Wallace**.
- RotorLens-authored source, tests, tooling, product documentation, decoder,
  analysis engine, UI, and generated fixture corpus are licensed under
  **MPL-2.0**. The root [`LICENSE`](../LICENSE) is Mozilla's official license
  text with only an incidental trailing space normalized for repository
  whitespace checks.
- Copyright remains with Michael Wallace and later contributors for their
  respective work. The open-source license grants permissions; it does not erase
  authorship.
- The official repository is
  <https://github.com/mbwallace1390/rotorlens>.
- Version `0.1.0` is a development version. No source tag is claimed to exist.
  Every public binary must identify and link a signed, exact-source release tag
  in **About & Legal** before it is submitted to a store.
- Third-party Android runtime components remain under Apache-2.0 and retain their
  own notices. Replacing RotorLens' license does not replace theirs.
- `integration/rotorflight-firmware/binding-v1/` remains a separate,
  non-shipping GPL-covered firmware review artifact. The root MPL-2.0 license
  does not relicense that subtree.

The public repository, package manifest, generated fixture manifest, decoder
identity, generated bundle, and About & Legal data all declare the same
`MPL-2.0` identifier. `test/provenance.test.mjs` fails if they drift.

## 2. What MPL-2.0 means for RotorLens

MPL-2.0 is file-level copyleft:

- Modified MPL-covered source files distributed in Source Code Form remain under
  MPL-2.0.
- A distributor of an executable containing MPL-covered code must make the
  corresponding MPL-covered source available and tell recipients how to obtain
  it.
- Separate files in a Larger Work may use other compatible terms. This is what
  keeps independently written native Android and iOS shell code possible without
  weakening the copyleft on RotorLens' shared source.
- MPL-2.0 does not grant rights to a contributor's trademarks, service marks, or
  logos except as needed for the license's notice requirements.
- Open source does not prohibit charging for a binary, support, or services. It
  also does not make the current development build a paid product.

Do not add the Exhibit B “Incompatible With Secondary Licenses” notice. The
generated `dist/rotorlens-pid-evidence.js` is consumed by a separate GPL-3.0
viewer fork; MPL-2.0 section 3.3 is the documented secondary-license path for
that generated file.

Historical grants remain valid. Copies people already received under the
project's former MIT license remain usable under that license; changing the
license now cannot revoke those recipients' existing rights. MPL-2.0 governs
this version and later covered versions, without rewriting the license of an
earlier copy.

## 3. Android and iOS distribution

The MPL choice does not prevent an Android or iOS version. Store readiness still
depends on the exact binary and the current store agreements, so attorney and
store-policy review remain release gates.

For each platform:

1. Build from a signed tag in the official repository.
2. Display the creator, copyright, MPL-2.0 identifier, official repository, and
   exact source tag in About & Legal.
3. Make the corresponding MPL-covered source available at that link for as long
   as the binary is distributed.
4. Include every third-party notice and license required by the resolved binary,
   not merely the dependencies declared in a build file.
5. Keep the store agreement or binary terms from restricting recipients' rights
   to the MPL-covered Source Code Form.

The shared parser, analysis, and UI must remain platform-neutral. The
experimental iOS shell scaffold in `ios/` hosts the same tested web core rather
than forking the tuning logic. It is not yet a parity or shipping claim:
macOS/Xcode compilation, simulator and device validation, persistence/backup
verification, the 128 MiB memory proof, and store readiness remain pending. The
source now includes private history and sharing files behind an asynchronous
host contract; that source-level slice is not evidence that the Swift target has
built or preserved those files correctly on a device.

Android's missing `INTERNET` permission is a strong platform-specific privacy
property. iOS has no equivalent permission. Cross-platform wording must instead
state the behavior that all current builds implement: there is no upload
transport and no flight data is sent. Keep the Android manifest assertion as the
stronger Android-specific statement.

## 4. Independent implementation and the GPL boundaries

RotorLens being open source does not make provenance optional. The Rotorflight
and Betaflight Blackbox viewers are separate GPL implementations. Their code,
markup, styles, wording, assets, icons, translations, screenshots, layouts, and
architecture documentation are not inputs to RotorLens.

The permitted distinction remains:

- File-format facts needed for interoperability—header keys, field names,
  encoding identifiers, predictor identifiers, and frame markers—may be
  implemented independently.
- Copyrightable expression may not be copied, ported, mechanically translated,
  or rewritten line by line.

People involved with RotorLens have previously seen GPL viewer code, so do not
describe this as a formal legal clean-room implementation. The supportable claim
is the one in [`ARCHITECTURE_AND_PROVENANCE.md`](ARCHITECTURE_AND_PROVENANCE.md):
the repository was created without copying those materials, with each authorised
same-author transfer recorded and reviewed.

The separate firmware boundary is also precise:

- `integration/rotorflight-firmware/binding-v1/` retains GPL notices and its own
  GPL license copy.
- It is an integration-review artifact, not an Android or iOS component.
- Current mobile packaging imports only the app-owned runtime trees and no
  firmware patch file.
- Any future runtime firmware integration needs a fresh license, source,
  packaging, and store review; public repository visibility is not permission to
  blur the boundary.

The viewer integration boundary is similarly explicit:

- `integration/rotorflight-blackbox/0001-consume-rotorlens-pid-evidence.patch`
  contains GPL viewer context and modifications, so the patch is GPL-covered
  and is not relicensed by the root MPL-2.0 license.
- `dist/rotorlens-pid-evidence.js` is independently generated from RotorLens
  source and remains MPL-covered; MPL-2.0 section 3.3 permits additional
  GPL-3.0 distribution when that file is part of the viewer's Larger Work.

## 5. The parser decision and what is actually validated

RotorLens uses its own decoder in `src/blackbox/`. `propwash-core` and
`blackbox-log` were evaluated and rejected; their original MIT or
MIT/Apache-2.0 licenses remain recorded in
`config/parser-engine-decision.json` and are not changed by this migration.

| Option | License | Status | If adopted |
| --- | --- | --- | --- |
| **RotorLens decoder** | MPL-2.0 | adopted | covered source remains available under MPL-2.0 |
| `propwash-core` | MIT | rejected | retain its MIT notice |
| `blackbox-log` | MIT OR Apache-2.0 | rejected | retain the selected license and notice |
| Rotorflight/Betaflight viewers | GPL-3.0 | excluded | preserve the independent boundary above |

The old parser decision incorrectly said real-firmware validation had not
happened. The corrected record is narrower and checkable:

- Private Rotorflight 4.6 firmware logs have been decoded locally.
- The published quantified reference claim is Rotorflight 4.6.0, one board, one
  flight, 134,429 samples, with zero decode errors through the body of the log.
- Round-trip coverage against RotorLens' own writer proves internal consistency,
  not agreement with firmware output.
- Accepted compatibility and verified coverage are not the same claim.

[`BLACKBOX_FORMAT_NOTES.md`](BLACKBOX_FORMAT_NOTES.md) is authoritative for the
remaining encoding, predictor, event, and version limits. Do not widen store or
README compatibility claims without the corresponding log and conformance run.

## 6. Third-party code and notices

`android/shipping-dependencies.json` records the resolved Android release runtime,
including transitive AndroidX, Kotlin/JetBrains, and Guava artifacts. The
generated About & Legal screen and [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)
must enumerate that resolved set and reproduce the required Apache-2.0 text and
copyright notices.

Before adopting any dependency, parser, font, icon, translation, fixture, build
binary, or asset:

- identify its owner, source URL, exact pinned version or commit, and license;
- inspect its transitive dependencies;
- record the notice and full license text where required;
- regenerate the shipped legal data;
- verify both Android and iOS resolved distributions independently.

Third-party MIT, BSD, Apache, and GPL notices must never be blanket-replaced with
MPL-2.0. The root license applies only where the project has the right to apply it.

## 7. Flight data and community learning are separate

An open-source code license grants no permission to collect or use a pilot's
flight data.

- Generated fixtures remain MPL-2.0 project artifacts and contain no real flight
  data.
- A real log needs clear ownership, written redistribution permission, and the
  privacy sidecar required by `FIXTURE_POLICY.md` before it can be committed.
- Location-bearing logs must not be published without deliberate redaction and
  permission.
- Community contribution consent and data-license versions remain separate from
  the code license. They may permit derived results in free releases and releases
  distributed for a fee without claiming that the current app is paid.
- Public source does not create an upload service, consent, authentication,
  poisoning resistance, held-out evaluation, deletion system, or hosting.

## 8. Attribution and project identity

Every official release surface should say:

> RotorLens was originally created by Michael Wallace.

Keep the copyright notice, `AUTHORS.md`, `NOTICE`, `CITATION.cff`, About & Legal
screen, and official repository URL aligned. Release tags and Android/iOS
binaries should be signed so users can distinguish official releases from forks.

Copyright attribution and trademark serve different purposes. Copyright notices
identify authorship. A separate trademark policy controls use of the RotorLens
name and logo so modified builds can give accurate credit without presenting
themselves as official releases.

Compatibility wording may name Rotorflight and Betaflight only to describe the
log format, and only accurately: what makes a nominative compatibility claim
safe is that it is TRUE, and the shipped decoder accepts Rotorflight 4.3–4.6
and refuses everything else (`src/blackbox/decode.mjs`). So the wording states
the accepted firmware range — "reads the Blackbox log format; this release
opens logs from Rotorflight 4.3–4.6 only" — rather than "reads Rotorflight or
Betaflight logs", which promises Betaflight pilots an app that would refuse
every log they own (`test/legal-disclaimer.test.mjs` pins this). It must not
imply endorsement or affiliation, and the non-affiliation statement must
remain in the store listing and About & Legal screen.

## 9. Release checklist

Licensing and source:

- [ ] Release built from a signed, immutable tag in the official repository.
- [ ] About & Legal links that exact tag; no development branch is described as
      exact release source.
- [ ] Root license hash and all RotorLens license declarations pass the
      provenance tests.
- [ ] Corresponding MPL-covered source remains available to binary recipients.
- [ ] Contributor sign-offs and inbound license terms are complete.

Attribution and provenance:

- [ ] Michael Wallace is shown as original creator in About & Legal.
- [ ] `AUTHORS.md`, `NOTICE`, `CITATION.cff`, README, and copyright lines agree.
- [ ] Resolved Android and iOS dependency inventories match their shipped legal
      notices.
- [ ] No excluded viewer expression or non-shipping GPL firmware artifact is in
      either application package.
- [ ] Every fixture and asset traces to a generator, the owner's recording, or
      written permission.

Store and privacy:

- [ ] Android and iOS privacy declarations match their actual binaries.
- [ ] Current-build copy says there is no upload transport; Android-specific copy
      separately states that Android requests no `INTERNET` permission.
- [ ] Privacy policy and contribution terms are live at stable public URLs.
- [ ] Store screenshots and descriptions match the shipped recommendation and
      data-sharing behavior.

Product safety:

- [ ] Advice is informational, cites its measurements and confidence, refuses
      incomplete evidence, and offers at most one next change.
- [ ] Mechanical faults are ruled out before gain advice, or the app says they
      could not be ruled out.
- [ ] RotorLens contains no path that writes settings to a flight controller.

## 10. Advice does not change the license boundary

RotorLens locally recommends what to adjust when the evidence passes its safety
gates. That product decision does not authorize copied GPL viewer rules, weaken
the independent parser boundary, create a network path, or change the data terms.
`src/analysis/recommendations.mjs` remains the only advice publisher; the rest of
the engine remains measurement-oriented, and RotorLens never writes a flight
controller.
