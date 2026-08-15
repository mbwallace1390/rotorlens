# RotorLens for Android

The native shell. RotorLens itself is the viewer in `../ui/` running against the
engine in `../src/`; this project exists only to do what a web page cannot.

## What the native layer does — and deliberately does not

It does three things:

1. Serves the viewer over `https://appassets.rotorlens.app/` from the APK's
   assets. Not `file://` — browsers refuse ES module imports from file origins,
   so the app would render and its JavaScript would never run.
2. Receives a `.bbl` that was opened or shared, copies it into the app's cache,
   and tells the page where to fetch it.
3. Opens the system file picker when the page asks.

It decides nothing. Every byte of decoding, analysis, and presentation happens in
JavaScript, because that is the part this repository's tests can reach. Java here
is code that cannot be tested by `npm test`, so there is as little of it as the
job allows. **Resist adding logic to this layer** — if something belongs in
Java, ask first whether it could live in `ui/` instead.

The seam between the two is `ui/host.mjs`, and it is covered by
`test/ui-browser.test.mjs`: with a host present the page must defer to the system
picker, and a file the host announces must be fetched and decoded. That test
exercises the exact contract `MainActivity.java` implements.

## No INTERNET permission

The source manifest requests no permissions. AndroidX adds a package-signature
permission while manifests are merged, but the shipped app has no `INTERNET` or
sensitive runtime permission. RotorLens never contacts a network: the viewer
ships in the APK and the log is decoded on the device.

That absence is the product, not an oversight. An app without the INTERNET
permission *cannot* upload somebody's flight — which, for a log carrying GPS
coordinates and a home position, is a stronger promise than any privacy policy.
Adding that line later would silently give it up, so don't, and if a feature ever
seems to require it, treat that as a decision to make deliberately rather than a
dependency to satisfy.

The WebView is likewise configured with file and content access disabled, and
navigation is refused to any origin but the app's own.

## The imported log does not outlive the session

`ImportStore` keeps exactly one committed log in the cache directory. Selecting
another log immediately unlinks it, cancels the old copy/read, and gives the new
selection a generation-bound URL, so a slower old provider cannot replace or be
mislabelled as the newer choice. `onDestroy` cancels any copy and deletes the
committed log without waiting on provider I/O. A viewer has no reason to
accumulate other people's flight data, and a log is location history.

`onDestroy` is not guaranteed, though — a low-memory kill, an uncaught exception
on the import thread, or a swipe from recents on some builds skips it, and the
last flight would sit in the cache with nothing to remove it. So the store also
purges the import directory **once per process** at startup. Once per process and
not once per instance: the constructor runs again on every activity recreation,
so purging there would drop the user's open log when they rotate the phone.

## Building

Open the **`android/` directory** in Android Studio, not the repository root —
only `android/` is a Gradle build.

`gradle/wrapper/gradle-wrapper.properties` pins **Gradle 8.14.5** for **Android
Gradle Plugin 8.13.2**. The wrapper scripts and jar are tracked, and
`gradle/gradle-daemon-jvm.properties` pins the daemon to **JetBrains JDK 21** so
local builds and CI resolve the same toolchain. Studio reads these pins during
the first sync.

Build from the checked-in wrapper:

```text
cd android
./gradlew assembleDebug
```

Gradle verifies every downloaded plugin, build tool, runtime dependency, test
dependency, and repository metadata file against the SHA-256 values committed in
`gradle/verification-metadata.xml`. CI names strict mode explicitly. When an
intentional dependency or build-tool update changes that file, regenerate it
with the complete CI task graph, review every new hash against the publisher,
and commit the reviewed diff:

```text
./gradlew --write-verification-metadata sha256 assembleDebug lintDebug testDebugUnitTest bundleRelease :app:recordShippingDependencies
```

Do not work around a verification failure with lenient or off mode.

If sync ignores the daemon criteria, point Settings → Build Tools → Gradle →
Gradle JDK at the installed JetBrains JDK 21.

`syncWebAssets` copies `../ui` and `../src` into the APK on every build, so the
app can never ship a stale copy of the engine. There is one engine — the one the
tests run against — not a duplicate that drifts.

Requirements: JetBrains JDK 21, Android SDK with API 36, minSdk 26.

CI compiles the debug APK, runs Android lint and unit tests, audits the merged
release manifest, and builds the release app bundle. The same lint and release
bundle gates have also been run locally; they are release checks, not a claim
that the device checklist below can be skipped.

## First run checklist

Things worth confirming on a real device, in this order:

- [ ] The viewer loads at all — if the page is blank, the asset origin is wrong.
      `chrome://inspect` on a desktop Chrome gives full DevTools into the WebView
      on a debug build, which is the fastest way to see why.
- [ ] Opening a `.bbl` from a file manager launches RotorLens and decodes it.
      **Test this from a cold start** — force-stop the app first. A warm start
      routes through `onNewIntent` and works even when the cold path is broken,
      which is exactly how this bug hid.
- [ ] Sharing text (not a file) into RotorLens says so rather than opening a
      blank screen.
- [ ] Sharing a `.bbl` into RotorLens from the mass-storage drive works.
- [ ] The in-app picker button opens the system picker.
- [ ] A large log — the real 8.5 MB one is a good test — decodes without the UI
      locking up for an unacceptable time. If it does, the decode belongs in a
      worker; measure before assuming.
- [ ] Content is not hidden behind the notch or the gesture bar.

## Dependencies

The one declared dependency is `androidx.activity`, for the modern back-press
and activity-result APIs. Its resolved release closure is larger; the exact 28
artifacts are pinned in `shipping-dependencies.json` and represented in
`../THIRD_PARTY_NOTICES.md` and the generated in-app legal screen. The viewer
and engine have no npm dependencies.
