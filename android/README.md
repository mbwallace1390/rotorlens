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

And it keeps the WebView alive around those: it replaces a renderer that died
(see below), and hands a tapped About & Legal link to the user's browser.

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

The WebView is likewise configured with file and content access disabled.
`AssetServer` answers every request itself and refuses, with an empty 403, any
that is not `https://appassets.rotorlens.app` — it used to return null for a
foreign host, which tells the WebView to load the request itself, so the missing
permission had been the only barrier. Navigation off the app's origin never loads
in the WebView.

The one exception is a link the user taps on About & Legal: the source repository
and each bundled component's project page. Those go to the user's own browser
through `ACTION_VIEW`, which needs no permission — the browser makes the request,
because the user asked it to. Only the exact URLs the legal screen shows can leave
(`ExternalLinks.java`), only on a tap, and only as `https`: a URL is a message,
and if any URL could be handed over, anything the page can read could be sent in
one. `test/android-shell.test.mjs` fails if that list and the legal screen's links
ever differ.

## The imported log does not outlive the session

`ImportStore` keeps exactly one committed log in the cache directory. Selecting
another log immediately unlinks it, cancels the old copy/read, and gives the new
selection a generation-bound URL, so a slower old provider cannot replace or be
mislabelled as the newer choice. `onDestroy` cancels any copy and deletes the
committed log without waiting on provider I/O. A viewer has no reason to
accumulate other people's flight data, and a log is location history.

`onDestroy` is not guaranteed, though — a low-memory kill, or a swipe from recents
on some builds skips it, and the last flight would sit in the cache with nothing
to remove it. So the store also purges the import directory **once per process**
at startup. Once per process and not once per instance: the constructor runs again
on every activity recreation, and a purge there would race the new instance.

An exception from a document provider during the copy is reported to the page as
"unreadable" rather than escaping the import thread. Providers are other apps'
code and throw unchecked exceptions across the binder for stale, virtual, or
out-of-root documents; uncaught on that bare thread, any of them killed the app.

## Configuration changes do not recreate the viewer

Recreating the activity destroys the WebView and runs `onDestroy`, which unlinks
the open log — and a log chosen in the picker is not re-imported, because the
activity's intent is just the launcher's. So `android:configChanges` declares
rotation, window and screen size, smallest width, screen layout, density, font
scale, locale and layout direction, keyboard, navigation and `uiMode`: split
screen, fold and unfold, desktop windowing, display-size and font-size changes,
and a language change all keep the open log.

The WebView re-lays itself out for size and density. Font scale it reads only
when it is built, so `onConfigurationChanged` re-applies the text zoom a fresh
WebView would compute. `uiMode` needs nothing because nothing follows it: the
theme has no night variant and the page is dark-only, and
`test/android-shell.test.mjs` fails if either stops being true.

Still recreating, deliberately: a SIM change (`mcc`/`mnc`), touchscreen, colour
mode, bold text (`fontWeightAdjustment`) and grammatical gender. Nobody does those
mid-analysis, and whether the WebView follows them in place has not been checked.

## A dead renderer is replaced, not fatal

The WebView renders in a separate process. On a large log it can run out of
memory; in the background the system can reclaim it. Android reports that to
`onRenderProcessGone`, and an app that does not answer it is killed along with
the renderer — a hard crash. `MainActivity` answers it: it destroys the dead
WebView, unlinks the log that was open, builds a fresh viewer, and tells the new
page through the ordinary `rotorlens-import-failed` event which log was lost:
reason `viewer-restarted` when the renderer crashed (the log may be why), and
`viewer-reclaimed` when the system killed it to free memory (the log most
likely was not).

It never re-offers that log. It may be exactly what the renderer died on, and
handing it to the replacement could kill that one too, forever. A replacement
that dies before its own page finishes loading is not replaced again
(`RendererRecovery`); the activity shows a one-line native message instead of
looping.

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
- [ ] "Open in RotorLens" is offered from the Files app for `LOG00012.bak.bbl`
      and for a log inside a folder with a dot in its name. On Android 8-11 a
      path with five or more dots is still not offered; share it instead.
- [ ] With a log open from the in-app picker, change Display size, then Font
      size, then enter split screen (and fold/unfold on a foldable): the log stays
      open and the text follows the new font size.
- [ ] About & Legal: tapping the repository link and a component link opens the
      browser, and the back gesture returns to RotorLens.
- [ ] The renderer dying does not close the app. On a debug build, crash it from
      `chrome://inspect` with a log open: the viewer comes back and names the log
      it lost. Then try the real case — the largest dump on the lowest-memory
      phone available.

The last four were exercised on an Android 17 emulator (WebView 153) through the
real platform matcher, a real tap, and a DevTools-forced renderer crash. That is
not a phone: an OEM WebView, a real out-of-memory kill, a fold, and Android 8-11
have not been tried.

## Dependencies

The one declared dependency is `androidx.activity`, for the modern back-press
and activity-result APIs. Its resolved release closure is larger; the exact 27
artifacts are pinned in `shipping-dependencies.json` and represented in
`../THIRD_PARTY_NOTICES.md` and the generated in-app legal screen. The viewer
and engine have no npm dependencies.
