# Third-party notices

**No third-party code ships inside the RotorLens application except the Android
libraries listed below, which are fetched at build time.** Everything authored
for the RotorLens app — the decoder, the analysis, the viewer, the tooling, the
tests, and the fixtures — is covered by MPL-2.0 in [`LICENSE`](LICENSE), unless a
file or reserved subtree states a different license. RotorLens was originally
created by Michael Wallace; copyright remains with Michael Wallace and later
contributors for their respective work.
The two reserved non-shipping Rotorflight integration-review artifacts below —
the viewer integration patch and the firmware evidence — are separately
GPL-covered and are not part of the app.

Apart from those reserved GPL artifacts, the committed materials not authored
for RotorLens are the build tooling, governance documents, and license text
recorded under [Committed build tooling, governance documents, and license
text](#committed-build-tooling-governance-documents-and-license-text) below,
because a provenance record that is *almost* accurate is worth very little.

The test corpus is ours: `fixtures/synthetic/` is produced by
`tools/generate-fixtures.mjs` and reproduces byte-for-byte on demand, so its
provenance is demonstrable rather than asserted. `npm test` fails if any file
appears under `fixtures/` that the generator did not write.

## When this file must change

Adding any third-party component — an npm or Cargo dependency, a parser engine,
an icon, a font, a log file from someone else — means adding an entry here **and**
surfacing it in the shipped application's legal/about view.

Each entry must record: component name, source URL, exact pinned revision,
license identifier, copyright line, and the full license text where the license
requires it (MIT, BSD, and Apache-2.0 all do).

`test/provenance.test.mjs` fails the build if a component is adopted in
`config/parser-engine-decision.json` or `package.json` without an entry here, and
if anything in `android/shipping-dependencies.json` is missing below.

## Bundled in the Android app

`android/shipping-dependencies.json` is the authority for this section. It is the
resolved `releaseRuntimeClasspath` — what the APK actually carries — written by
`gradlew :app:recordShippingDependencies` and committed. Regenerate and commit it
after any dependency or version change.

**The declared dependency list is not the shipped one.** `androidx.activity` is
the only line in `android/app/build.gradle.kts`, and it brings twenty-seven other
artifacts with it from three further copyright holders. Apache-2.0 §4 attaches
attribution to what is distributed, not to what was written down, so what follows
is the resolved set and not the declaration.

All of it is Apache-2.0. That is compatible with RotorLens distribution; the
obligation is to reproduce the license text and the copyright notices in the
shipped app's About & Legal screen. **The full Apache-2.0 text and every
copyright line below must appear in the app before release** — see
[docs/LICENSING_AND_STORE_READINESS.md](docs/LICENSING_AND_STORE_READINESS.md).

### The Android Open Source Project

<https://developer.android.com/jetpack/androidx/releases> — Apache-2.0 —
Copyright (c) The Android Open Source Project

Only `androidx.activity` is asked for by name, for the modern back-press and
activity-result APIs. The rest arrive as its transitive closure.

```text
androidx.activity:activity:1.9.3
androidx.annotation:annotation-experimental:1.4.0
androidx.annotation:annotation-jvm:1.6.0
androidx.arch.core:core-common:2.2.0
androidx.arch.core:core-runtime:2.2.0
androidx.collection:collection:1.0.0
androidx.concurrent:concurrent-futures:1.1.0
androidx.core:core-ktx:1.13.0
androidx.core:core:1.13.0
androidx.interpolator:interpolator:1.0.0
androidx.lifecycle:lifecycle-common:2.6.2
androidx.lifecycle:lifecycle-livedata-core:2.6.2
androidx.lifecycle:lifecycle-runtime:2.6.2
androidx.lifecycle:lifecycle-viewmodel-savedstate:2.6.2
androidx.lifecycle:lifecycle-viewmodel:2.6.2
androidx.profileinstaller:profileinstaller:1.3.1
androidx.savedstate:savedstate:1.2.1
androidx.startup:startup-runtime:1.1.1
androidx.tracing:tracing:1.0.0
androidx.versionedparcelable:versionedparcelable:1.1.1
```

### JetBrains — Kotlin standard library and coroutines

<https://github.com/JetBrains/kotlin> and
<https://github.com/Kotlin/kotlinx.coroutines> — Apache-2.0 — Copyright
2010-2023 JetBrains s.r.o. and Kotlin Programming Language contributors

androidx is written in Kotlin, so its runtime ships whether or not RotorLens
writes a line of Kotlin — it does not. A different copyright holder from AOSP,
which is why these need their own notice rather than being folded into the block
above.

```text
org.jetbrains.kotlin:kotlin-stdlib:1.8.22
org.jetbrains.kotlin:kotlin-stdlib-common:1.8.22
org.jetbrains.kotlin:kotlin-stdlib-jdk7:1.8.22
org.jetbrains.kotlin:kotlin-stdlib-jdk8:1.8.22
org.jetbrains.kotlinx:kotlinx-coroutines-android:1.6.4
org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm:1.6.4
```

`kotlin-stdlib-jdk7` and `kotlin-stdlib-jdk8` are pinned to 1.8.22 by a
constraint in `android/app/build.gradle.kts`. Coroutines 1.6.4 asks for 1.6.21 of
each, and since Kotlin 1.8 folded those classes into `kotlin-stdlib` itself, the
old and new jars both defined them and D8 refused to build. At 1.8.22 the two are
empty shims. The constraint pins a version; it adds nothing.

### JetBrains — annotations

<https://github.com/JetBrains/java-annotations> — Apache-2.0 — Copyright
2000-2016 JetBrains s.r.o.

```text
org.jetbrains:annotations:13.0
```

### Google — Guava ListenableFuture

<https://github.com/google/guava> — Apache-2.0 — Copyright (c) The Guava Authors

```text
com.google.guava:listenablefuture:1.0
```

This is the empty placeholder artifact Guava publishes so that a project pulling
in `ListenableFuture` transitively does not also pull in all of Guava. It carries
no classes of its own, and it is listed because it is on the resolved classpath
and honesty about the list is the point of the list.

## Committed build tooling, governance documents, and license text

The build tools and governance documents in this section are in the repository
but not in the Android APK or iOS application. The Apache license text is
intentionally shipped to satisfy the Android components' redistribution terms.
Each entry states which boundary applies.

- **Developer Certificate of Origin 1.1** —
  <https://developercertificate.org/> — DCO-1.1 copying terms — Copyright (C)
  2004, 2006 The Linux Foundation and its contributors

  [`DCO`](DCO) is a verbatim copy of version 1.1, SHA-256
  `f7ac75b443f4ca16b503241344b41aeff9503b0c30bedc2b119551d83cb0fa90`.
  Its embedded terms permit copying and distributing verbatim copies but do not
  permit changes. The DCO is a contributor certification, not a copyright
  assignment, and the committed text is not covered by the repository's root
  MPL-2.0 license.

- **Contributor Covenant Code of Conduct 2.1** —
  <https://www.contributor-covenant.org/version/2/1/code_of_conduct.html> —
  [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) — Copyright (c)
  2014 Coraline Ada Ehmke and Contributor Covenant contributors

  [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) is adapted from the exact 2.1
  version. RotorLens replaces the reporting placeholder with its private
  reporting route and adds a warning not to send sensitive flight data. Its
  Attribution section preserves the upstream source/version credit and the
  acknowledgment of Mozilla's enforcement ladder; this notice supplies the
  CC-BY-4.0 license link and identifies the project-specific changes. The file
  is repository governance material under CC-BY-4.0, not MPL-covered RotorLens
  application source.

- **XcodeGen 2.46.0** —
  <https://github.com/yonaskolb/XcodeGen/tree/2.46.0> — MIT — Copyright (c)
  2018 Yonas Kolb

  `ios/project.yml` is the checked-in iOS project source and
  `ios/.xcodegen-version` pins the generator version. XcodeGen runs only on a
  developer or CI Mac to create the ignored `ios/RotorLens.xcodeproj`; neither
  its executable nor source is linked, copied, or shipped in RotorLens. The
  authoritative license is the
  [tagged 2.46.0 license](https://github.com/yonaskolb/XcodeGen/blob/2.46.0/LICENSE).

- **Gradle Wrapper** — <https://gradle.org> — Apache-2.0 — Copyright the original
  authors

  `android/gradle/wrapper/gradle-wrapper.jar`, `android/gradlew`, and
  `android/gradlew.bat`. The jar is compiled Java from Gradle Inc.; the two
  scripts carry their own Apache-2.0 headers. Committing the wrapper is the
  standard and recommended practice — it is what lets the app build from a clean
  checkout with nothing installed but a JDK — but it does mean this repository is
  no longer exclusively our own code, and this file says so rather than pretending
  otherwise.

  The wrapper downloads the Gradle distribution named in
  `android/gradle/wrapper/gradle-wrapper.properties`. It executes on every build,
  which makes it worth more scrutiny than a fixture, so both halves are pinned
  and checked:

  | | |
  | --- | --- |
  | `gradle-wrapper.jar` SHA-256 | `7d3a4ac4de1c32b59bc6a4eb8ecb8e612ccd0cf1ae1e99f66902da64df296172` |
  | `gradle-8.14.5-bin.zip` SHA-256 | `6f74b601422d6d6fc4e1f9a1ab6522f642c2fdcbc15ae33ebd30ba3d7198e854` |

  Both verified 2026-08-11 against <https://gradle.org/release-checksums/>, and
  the distribution hash independently against the `.sha256` served beside the
  archive itself. `npm test` re-checks the committed jar against the first value
  on every run, and the second is pinned as `distributionSha256Sum` so Gradle
  refuses a distribution that does not match.

- **foojay-resolver-convention** — <https://github.com/gradle/foojay-toolchains> —
  Apache-2.0 — Copyright the Gradle authors

  Declared in `android/settings.gradle.kts`. With
  `android/gradle/gradle-daemon-jvm.properties` asking for a JetBrains JDK 21, a
  clean checkout queries the foojay disco API and downloads a JDK to build with.

  Worth stating plainly, because it is the one piece of the chain that is *not*
  pinned: **the compiler that produces a released binary is resolved from a
  third-party index at build time**, and the file expressing that request is
  marked `#This file is generated by updateDaemonJvm`, so regenerating it would
  move the toolchain without anyone deciding to. The plugin itself is a build
  dependency and nothing it fetches is linked into the APK, so this creates no
  attribution obligation — it is a supply-chain note, not a licence one. Before a
  release build, confirm which JDK Gradle actually selected
  (`gradlew -q javaToolchains`) rather than assuming.

- **Apache License 2.0 text** — <https://www.apache.org/licenses/LICENSE-2.0.txt>

  `config/licenses/apache-2.0.txt`, SHA-256
  `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`, retrieved
  from the Apache Software Foundation on 2026-08-11. This one *is* shipped, but
  as an obligation rather than as a component: `tools/generate-legal.mjs` embeds
  it in the app's legal screen, which is how the Apache-2.0 section 4 duty to
  hand every recipient the license text is discharged.

## Non-shipping Firebase emulator and Functions tooling

`backend/firebase/` is a separate local/CI dependency boundary. None of these
packages is imported by `src/`, `ui/`, Android, or iOS, and none is packaged in
the application. The two committed lockfiles are the authority for their full
transitive build/test graphs.

- **Firebase CLI** `firebase-tools` 15.27.0 —
  <https://github.com/firebase/firebase-tools/tree/v15.27.0> — MIT —
  Copyright (c) 2015 Firebase.
- **Firebase JavaScript SDK** `firebase` 12.17.1 and
  `@firebase/rules-unit-testing` 5.0.1 —
  <https://github.com/firebase/firebase-js-sdk> — Apache-2.0.
- **Firebase Admin Node.js SDK** `firebase-admin` 14.2.0 —
  <https://github.com/firebase/firebase-admin-node/releases/tag/v14.2.0> —
  Apache-2.0.
- **Cloud Functions for Firebase SDK** `firebase-functions` 7.3.2 —
  <https://github.com/firebase/firebase-functions/releases/tag/v7.3.2> — MIT —
  Copyright (c) 2017 Firebase.

The complete Apache-2.0 text is committed at
`config/licenses/apache-2.0.txt`. The two MIT packages carry the standard MIT
permission, notice-retention, no-warranty, and liability-disclaimer terms with
the copyright lines above. These tools are fetched only to run a local demo
project and CI; there is no Firebase project selection, login, deployment, or
mobile runtime dependency in this phase.

## The decoder is ours

`src/blackbox/` is RotorLens' own Blackbox decoder, written from the log format.
No third-party decoder was adopted, so the app has no attribution obligation for
the one component that would most obviously have carried one.

These were evaluated as decoder dependencies and rejected; neither is fetched,
linked, or bundled:

- `propwash-core` — <https://github.com/Iteratrix/propwash> — MIT. Its
  timestamp-alignment and overlapping Hann/Welch architecture at revision
  `804d3d5dd447c2e6067b02b7e1723aae8a19d5ff` informed an independently written
  RotorLens mechanical-spectrum implementation. No source expression was copied,
  so this is not a shipped dependency or an MIT notice obligation. The source
  header preserves a voluntary design credit rather than claiming otherwise.
- `blackbox-log` — <https://github.com/blackbox-log/blackbox-log> — MIT OR Apache-2.0

## Explicitly excluded

The Rotorflight and Betaflight Blackbox log viewers are GPL-3.0. Their code,
markup, styles, assets, translations, and wording must not be copied, ported,
mechanically translated, or linked into RotorLens-authored app source. See
[docs/LICENSING_AND_STORE_READINESS.md](docs/LICENSING_AND_STORE_READINESS.md).

`integration/rotorflight-blackbox/0001-consume-rotorlens-pid-evidence.patch`
is a non-shipping integration artifact containing GPL viewer context and
modifications. The patch is GPL-covered and is not relicensed by the root
MPL-2.0 license. The separately generated
`dist/rotorlens-pid-evidence.js` bundle remains independently authored
MPL-2.0 code; MPL-2.0 section 3.3 permits its additional GPL-3.0 distribution
as part of the viewer's Larger Work. The boundary and application instructions
are recorded in [`integration/rotorflight-blackbox/README.md`](integration/rotorflight-blackbox/README.md).
The exact viewer base is commit
`492bee5b5835a2a88ec725489e5e6d4ee52c678f` (tree
`ae1bca03d11a713c19e13d156a27d6591316cf03`), not a mutable branch. The adjacent
[`integration/rotorflight-blackbox/LICENSE`](integration/rotorflight-blackbox/LICENSE)
is the complete GPL version 3 text from that commit, normalized only by adding
one final LF (SHA-256
`e57f1c320b8cf8798a7d2ff83a6f9e06a33a03585f6e065fea97f1d86db84052`).
The 15,161-byte patch has SHA-256
`bb49324ec62e71efc2f877dab3ad4dbd3fc22ddc99fcc26a5de25b47a61aab83`.

## Reserved non-shipping Rotorflight firmware boundary

`integration/rotorflight-firmware/binding-v1/` contains one non-shipping,
partial Rotorflight firmware source patch for review. It is pinned to upstream
repository <https://github.com/rotorflight/rotorflight-firmware>, commit
`118e9120260bb33f46df4f92052fb0e9fd4e9ebc`. The 89,537-byte patch has SHA-256
`0bcb2f89bc9b6af3b2953952a3e015954511c71a8c718fd0b022cde47594cb6f` and
retains source-file notices granting GPL version 3 or later.

The adjacent `LICENSES/GPL-3.0.txt` is byte-identical to the pinned upstream
`LICENSE` (SHA-256
`3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`).
The patch and license are not covered by the repository's root MPL-2.0 license and
nothing in this subtree is packaged in either the Android or iOS application.

This artifact provides host-only SHA-256 plus content-only semantic validation
of a caller-provided immutable 103-byte value buffer across every registered
scalar domain and the source-reviewed cross-field rules, followed by 90-row TLV
encoding. Invalid content is rejected before a writer call. It also includes an
isolated task-context mutation-epoch primitive with an even/odd unsigned 32-bit
generation and permanent pre-wrap fault state. It has zero production callers,
scoped writer hooks, or capture consumers. Generation zero is not stable-capture
evidence. Its host test models PRIMASK/IPSR, publication points, and sticky
fault survival across NMI/HardFault stale-write races; it does not prove the
target Cortex-M path, real concurrency, or simulator synchronization.

The artifact does not read or capture live firmware state, create or
synchronize a snapshot, or prove the buffer's origin or stability. It has no
clean implementation commit, accepted firmware target, compiled binary,
resource or terminal-atomicity evidence, real wire capture, or positive runtime
entry. `runtimeAcceptance` is fixed false.

## Prior state of this repository

An earlier commit vendored a single Rotorflight log copied from the MIT-licensed
`Iteratrix/propwash` test corpus, with its notice retained. That was permitted by
its license but created an attribution obligation for a mere test file, so the
current tree uses generated fixtures instead. Old private-development commits
also retain workstation paths and a phone LAN address that are absent from the
current tree. Before public visibility, every advertised ref must either be
rewritten from a verified backup and rescanned from a fresh clone, or those
historic disclosures must be accepted through a separate informed decision.
Nothing from the removed fixture ships in the application.
