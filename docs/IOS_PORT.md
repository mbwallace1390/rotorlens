<!-- SPDX-License-Identifier: MPL-2.0 -->
<!-- Copyright 2026 Michael Wallace and contributors. -->

# RotorLens iOS/iPadOS port

## Status: Phase 2 private-persistence slice, not release parity

The checked-in `ios/` tree is the smallest native shell that can exercise the
existing RotorLens viewer on iOS and iPadOS 16 or later. It does not rewrite the
decoder, analyzer, tuning advice, or legal screen. Xcode copies only the
repository's `ui/` and `src/` folders into the application bundle and WebKit
loads that same ES-module graph from a private custom origin.

Phase 2 now adds the same saved-flight history and optional sharing preference
that the Android shell exposes. The shared page awaits both Android's immediate
JavaScript-interface values and iOS's WebKit Promise replies through one ordered
host contract. It never paints a save or erase as successful before the native
reply confirms it. This is still intentionally **not** an iOS release and must
not be described as complete Android/iOS parity yet. In particular:

- native persistence still requires a macOS Xcode build plus simulator and
  physical-device save/relaunch/erase/backup-migration validation;
- iOS/iPadOS can open a log from Files, including supported external storage
  that Files exposes, but cannot reproduce Android's generic USB-device attach
  intent or offer/auto-launch behavior;
- the 128 MiB route and viewer still need memory, decode-time, thermal, and
  replacement testing on physical iPhones and iPads;
- the source has only Windows static-contract validation so far. A macOS Xcode
  build, simulator test run, signing pass, and physical-device pass are release
  gates.

## Source-of-truth project representation

No `.xcodeproj` is checked in. Hand-writing one on Windows would create a large
generated file that this repository cannot honestly open or verify. Instead,
`ios/project.yml` is the deterministic source and `ios/.xcodegen-version` pins
[XcodeGen 2.46.0](https://github.com/yonaskolb/XcodeGen/releases/tag/2.46.0).
The generated `ios/RotorLens.xcodeproj` is ignored.

XcodeGen is a build-time generator only: neither its executable nor its source
is linked, copied, or shipped in RotorLens. Version 2.46.0 is MIT-licensed,
Copyright (c) 2018 Yonas Kolb; its authoritative license is the
[tagged XcodeGen LICENSE](https://github.com/yonaskolb/XcodeGen/blob/2.46.0/LICENSE).
This build-tool provenance also belongs in the repository-wide third-party
notice inventory, clearly marked as non-shipping, whenever this phase lands.

On a Mac with Xcode 16 or newer and that exact XcodeGen version installed:

```sh
cd ios
sh scripts/generate-project.sh
xcodebuild -project RotorLens.xcodeproj -scheme RotorLens -showdestinations
xcodebuild -project RotorLens.xcodeproj -scheme RotorLens \
  -destination 'platform=iOS Simulator,name=<installed simulator>' test
```

The generator refuses a different XcodeGen version and never downloads or
installs a tool. `app.rotorlens` is the current bundle identifier; it must be
registered to the owner's Apple Developer team before device signing or store
distribution. No `DEVELOPMENT_TEAM` is committed.

## Architecture and trust boundaries

```text
UIKit scene
  └─ ViewerViewController
      ├─ UIDocumentPicker / open-in URL
      │   └─ ImportStore (security scope + NSFileCoordinator)
      │       └─ private Caches/RotorLensSessionImports/import-<generation>-*.bin
      └─ ephemeral WKWebView
          └─ rotorlens-app://app
              ├─ /ui/**       copied from repository ui/
              ├─ /src/**      copied from repository src/
              └─ /import/<current generation> only
  └─ PrivateStore
      ├─ Application Support/RotorLensPrivate/flight-history.json
      └─ Application Support/RotorLensPrivate/sharing.json
```

`ImportStore` invalidates the previous generation before starting its
replacement. It copies on a private queue in 64 KiB chunks, reports progress no
more than once per 200 ms, rejects declared or observed content beyond 128 MiB,
and publishes the route only after a complete copy. Old routes stop resolving.
The dedicated cache is purged at launch, at a clean scene shutdown, and after a
failed or replaced copy; that launch purge also handles a process killed during
copying. Provider URLs are accessed with a security scope when one is supplied
and read through `NSFileCoordinator`. `LSSupportsOpeningDocumentsInPlace` is
enabled so file-provider originals are not converted into persistent Inbox
copies; the original document is never edited. If an open-in context still
supplies an app-owned temporary copy, the shell discards it after the bounded
session copy completes or fails.

The `WKWebView` uses `WKWebsiteDataStore.nonPersistent()`, so cookies, web
storage, and WebKit cache data are memory-only. The custom handler rejects every
host/path outside the three routes above, normalizes and confines bundle paths,
and binds imports to the exact current generation. It injects a restrictive CSP
into `ui/index.html`; the CSP allows bundled same-origin modules and the current
same-origin log fetch but blocks network connections, frames, objects, forms,
and remote resources. The navigation delegate permits only the main
`/ui/index.html` document and rejects popups and other navigation. There is no
networking framework, URL-session client, local-network permission, background
mode, or network entitlement in this target.

At document start, before bundled modules execute, the shell defines
`RotorLensPlatform` as the string `ios` and exposes `RotorLensNative.pickFile()`
plus six history/sharing methods. Those six methods use
`WKScriptMessageHandlerWithReply`, so JavaScript receives Promises that resolve
only after the private file operation finishes. The shared host adapters await
`Promise.resolve(...)`: this accepts iOS replies while preserving Android's
synchronous JavaScript-interface implementation. A single shared operation
queue and per-store revision gates prevent stale taps from landing out of order.
The existing platform-aware legal UI can therefore select
`componentsByPlatform.ios` instead of showing Android Maven artifacts.

`PrivateStore` keeps the two records separately under the app's Application
Support directory. It caps history at 8 MiB and sharing at 64 KiB, writes through
separate staging files, synchronizes the staging handle before atomic
replacement, applies complete-until-first-unlock file protection, and excludes
the directory and committed files from backup through the platform's documented
resource value. The value is applied again after each replacement because Apple
documents that common file operations can reset it. Apple also says this value
is guidance to the system, not a guarantee that an item never appears in a
backup or on a restored device. The source-level marker is therefore necessary
but not sufficient for RotorLens's stronger privacy claim; backup/restore and
device-migration proof remain release blockers. A missing file reads as an empty
string; an existing file that cannot be read safely reads as `null`, which keeps
shared writes blocked until an explicit erase. The two erase replies remain
independent, so a failure deleting one file cannot make the other look deleted.

Apple's relevant platform contracts are documented in
[WKURLSchemeHandler](https://developer.apple.com/documentation/webkit/wkurlschemehandler),
[nonpersistent website data stores](https://developer.apple.com/documentation/webkit/wkwebsitedatastore/nonpersistent()),
[document picker opening](https://developer.apple.com/documentation/uikit/uidocumentpickerviewcontroller/init(foropeningcontenttypes:ascopy:)),
[security-scoped URL access](https://developer.apple.com/documentation/foundation/nsurl/startaccessingsecurityscopedresource()),
[file coordination](https://developer.apple.com/documentation/foundation/nsfilecoordinator),
[reply-capable script messages](https://developer.apple.com/documentation/webkit/wkscriptmessagehandlerwithreply),
and [backup exclusion](https://developer.apple.com/documentation/foundation/urlresourcekey/isexcludedfrombackupkey).

## File layout

```text
ios/
  .xcodegen-version                 pinned generator version
  .gitignore                        ignores generated Xcode project/user state
  project.yml                       iOS 16 app + unit-test targets
  RotorLens/
    AppDelegate.swift               UIKit application lifecycle
    SceneDelegate.swift             scene/open-in entry points
    ViewerViewController.swift      ephemeral WebKit + picker/event bridge
    NativeBridge.swift              document-start marker, picker, async storage replies
    PrivateStore.swift              protected/backup-excluded history + sharing files
    RotorLensOrigin.swift           one private origin
    RotorLensDocumentTypes.swift    .bbl/.bfl/.txt/.log contract
    ImportStore.swift               bounded coordinated session copy
    WebAssetSchemeHandler.swift     confined asset/import transport and CSP
    Info.plist                      document/open-in and scene declarations
    PrivacyInfo.xcprivacy           no tracking, collection, or required API use
  RotorLensTests/                   import, stale route, CSP, and type tests
  scripts/generate-project.sh       pinned, offline project generation
  tests/ios-static-contract.test.mjs
```

The app target's Copy Bundle Resources phase has exactly two external folder
references: `../ui` and `../src`. Root `LICENSE`, `NOTICE`, and this document are
visible as project file groups but are not extra runtime payload folders.

## Legal and privacy accuracy

The iOS source is under the same [root MPL-2.0 license](../LICENSE) as RotorLens;
there is no separate proprietary iOS license. New Swift, shell, and test sources
carry SPDX and copyright headers for Michael Wallace and contributors. The
[root NOTICE](../NOTICE) records Michael Wallace as founder and original
creator, while the shared legal screen remains the single place for the safety
disclaimer, source link, creator/MPL notices, and platform component notices.

For this dependency-free Phase 2 target, the iOS platform-specific bundled
component list is empty: UIKit, WebKit, Foundation, and Uniform Type Identifiers
are Apple system frameworks, not third-party libraries copied into the app.
Before any dependency is added, legal generation must derive a new iOS entry
from the actual Xcode build instead of borrowing Android's Maven list. A release
test must verify that an iOS build shows the common creator, source, MPL, and
safety notices, shows no Android Maven artifacts, and does not hide a real iOS
third-party component.

The privacy manifest accurately declares no tracking, collected-data types,
tracking domains, or required-reason API categories for this slice. The shell
does not read file creation/modification dates, device identifiers, defaults, or
free-disk-space APIs. The native files store only the page's already documented
flight-history and sharing JSON, and use no browser storage. Any later use of
required-reason APIs or any telemetry/networking feature requires a new manifest
and privacy-claim review before merging.

MPL-2.0 remains a practical open-source license for an iOS executable because
its executable-form obligation focuses on making the covered source available
and preserving notices; see [MPL 2.0 sections 3.2 and 3.4](https://www.mozilla.org/en-US/MPL/2.0/)
and [Mozilla's MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/). That is
engineering guidance, not a legal guarantee; distribution terms should still
receive legal review.

## Acceptance gates

The cross-platform source contract can run now from the repository root:

```sh
node --test ios/tests/ios-static-contract.test.mjs
```

On macOS, generate the project and require all `RotorLensTests` to pass. They
cover exact extensions, crash-leftover purge, successful bounded copying,
metadata oversize rejection, stale generation cancellation, custom-origin MIME
types, CSP injection, traversal/foreign-origin rejection, and old-route denial.

Then exercise these scenarios on at least one iPhone and one iPad running iOS /
iPadOS 16 or later:

1. Launch in airplane mode and decode a known `.bbl`; confirm advice and legal
   UI render without a network request in Instruments or a blocking proxy.
2. Pick `.bbl`, `.bfl`, `.txt`, and `.log` documents from On My iPhone/iPad and
   one third-party Files provider; use open-in/share-to-RotorLens as a separate
   path. Unsupported extensions must be refused.
3. Import from a USB/SD storage volume that appears in Files. Confirm this uses
   the picker/open-in path and never claim device-attach detection or auto-launch.
4. Replace a slow import before it completes. No old progress, terminal event,
   or `/import/<old generation>` route may win after the new selection.
5. Verify progress on a slow provider, accept a known-good file just below the
   cap, and reject a sparse/real file above 128 MiB without a large JavaScript
   allocation.
6. Kill the process during copy, relaunch, and verify the dedicated cache has no
   usable leftover. Background/foreground the app and repeat the current import.
7. Use Xcode memory/energy instruments on a near-limit real log. A test pass is
   required before claiming the 128 MiB ceiling is safe on either platform.
8. Verify back gestures, links, popups, `http`, `https`, `ws`, `wss`, `file`, and
   traversal URLs cannot leave the one local viewer document.
9. Save a flight, force-quit, relaunch, and verify the exact history returns.
   Turn the sharing preference on and off, repeat the relaunch, and verify its
   separate local identity is retained until its own erase control is used.
10. Exercise Forget flight, Forget helicopter, Erase sharing identity, and
    Forget everything. A forced native failure must stay visibly failed; no
    control may clear the screen before its reply. Confirm each operation leaves
    the other file alone except Forget everything, which independently checks
    both results.
11. Inspect the built container and an encrypted device backup to confirm both
    JSON files use the declared protection class and the system honors their
    exclusion marker during backup and restore. Repeat with every applicable
    device-to-device migration path before extending the privacy policy to a
    shipping iOS build. Apple's exclusion value is guidance rather than a
    guarantee; a failed outcome blocks release and requires a new storage/privacy
    design rather than softer wording hidden in a checklist.

## Remaining parity boundary

The asynchronous host migration and source-level native persistence are now in
place. Static Node tests cover the sync/Promise adapter and fail-closed replies;
Swift unit sources cover independent lifetime, size caps, interrupted staging
purge, and backup-exclusion metadata. Windows cannot compile or execute those
Swift tests, inspect a signed container, or prove device backup/migration
behavior, so none of those source checks is a release claim.

The remaining boundary is physical validation, platform legal validation,
signing, icons, accessibility, App Store packaging, and a deliberate audit of
every Android-only interaction. Generic USB attach detection remains impossible
on iOS and is not part of this slice; Files-visible USB/SD storage is the
documented substitute. Raw logs and the session cache remain outside persistent
storage. No network, cloud, analytics, model eligibility, or flight-analysis
behavior is added here.
