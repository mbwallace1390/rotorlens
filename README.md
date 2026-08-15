# RotorLens

An open-source mobile flight-log viewer and tuning adviser for Rotorflight
helicopters. RotorLens was originally created by **Michael Wallace**. The
[official project](https://github.com/mbwallace1390/rotorlens) is
maintained under the Mozilla Public License 2.0.

The decoder, analysis engine, UI, tests, tools, documentation, and committed
fixtures are authored for RotorLens. No Rotorflight or Betaflight Blackbox
viewer expression is copied into RotorLens-authored application source or a
shipping build. Their GPL-3.0 implementations remain separate from this
independently written MPL-2.0 codebase. One explicitly reserved, non-shipping
GPL viewer integration patch lives under `integration/rotorflight-blackbox/`
and is not covered by the root MPL license. The Android shell does ship
permissively licensed AndroidX, Kotlin, and related runtime components, all
resolved and attributed in
`android/shipping-dependencies.json`, `THIRD_PARTY_NOTICES.md`, and the in-app
About & Legal screen. See
[licensing and store readiness](docs/LICENSING_AND_STORE_READINESS.md) before
adding any dependency, asset, or log file.

## What works now

- **Our own Blackbox decoder** (`src/blackbox/`) — bounds-checked reader, all
  implemented field encodings and predictors, multi-session support, event
  frames, and resync-on-damage.
- An app-owned normalized parser contract (`src/parser-contract.mjs`) the decoder
  reports through, so the engine stays replaceable.
- A self-generated, reproducible fixture corpus with **real encoded frames**,
  written by our own log writer.
- A conformance checker (`npm run verify:log`) that tells you whether the decoder
  genuinely understood a real log.
- **PID tuning evidence** (`src/analysis/pid-evidence.mjs`) — per-direction stop
  evidence so yaw can be measured at all, and steady-state hold evidence so the
  I term can be measured at all.
- **A per-axis view** (`src/analysis/axis-report.mjs`) — peak commanded and
  measured rate, tracking error, gyro content above 50 Hz filtered against
  unfiltered, and a commanded-versus-measured trace you can zoom and pan with a
  finger. It needs only a setpoint and a gyro, so it renders on every log
  whatever was flown.
- **Capture briefs** — when an axis yields no tune evidence the app distinguishes
  *this flight contains no such manoeuvre* from *your manoeuvre was refused, at
  this gate*, and then names the manoeuvre that would produce evidence — quoting
  the detector's own thresholds, so a brief cannot send someone up to fly
  something that will be refused for the same reason again.
- **A gated recommendation path** (`src/analysis/recommendations.mjs` behind
  `src/analysis/advisor/recommendation-gates.mjs`) — see *What to adjust* below.
  It is wired into the viewer and renders only evidence that clears every safety
  gate, with at most one change offered as the next action.
- **A viewer shell** (`ui/`) — open a log, inspect sessions and fields, plot any
  signal, run the tune evidence. Runs in a browser today and in a WebView
  unchanged; no bundler, no dependencies.
- **An Android app** (`android/`) — a thin native shell that receives shared and
  opened `.bbl` files and serves the viewer from the APK. It requests no
  `INTERNET` or sensitive platform permission, so it cannot upload a flight.
- **A platform-neutral web core** — the same parser, analysis, and UI are kept
  free of Android-only APIs. An experimental iOS shell scaffold in `ios/` uses
  that shared core rather than forking the tuning implementation. It is not a
  shipping or parity claim: macOS/Xcode compilation, simulator and device
  validation, native persistence/backup verification, the 128 MiB memory proof,
  and store readiness remain pending. The source-level Phase 2 slice now includes
  private iOS history and sharing files behind the shared asynchronous host
  contract; see `docs/IOS_PORT.md` for the unverified device gates.
- Provenance tests that fail the build if unowned material appears or a
  dependency is adopted without a notice, plus a real-browser test that drives
  the shell end to end.

## Run offline

Requirements: Node.js 22 or newer. There are no npm dependencies.

```text
npm run ui                # open http://127.0.0.1:8173/
npm test                  # the whole suite, including a real headless-browser run
npm run inspect:fixture   # header/field inventory as JSON
npm run fixtures:generate # regenerate the corpus (must be byte-identical)
```

The shell loads `src/` directly as ES modules — the same code the tests run,
with no second implementation to drift. It needs the dev server rather than
`file://` because browsers refuse module imports from disk.

Both tools accept a path, so they work on any log you own:

```text
npm run inspect:fixture -- /path/to/LOG00001.BFL
npm run verify:log -- /path/to/LOG00001.BFL
```

## Decoder status

The compatibility gate accepts Rotorflight **4.3.x through 4.6.x** and rejects
earlier or future releases until their format is exercised deliberately. That is
an accepted range, not an equal verification claim: the committed synthetic
corpus covers 4.3, independently produced/private logs cover 4.4 and 4.6, and
the event serializer is pinned to 4.6 firmware source. No equivalent 4.5
firmware-output log is committed.

**Verified locally against real firmware.** A privately held Rotorflight 4.6.0
reference log — 8.5 MB and 89 fields — decodes to **134,429 samples with zero
errors**, a median sample interval of 993 µs with no outliers, and monotonic time
and loop iteration throughout. The only resync is the last 525 bytes, where the
capture stops mid-frame because the log was cut short. The log is deliberately
not redistributed by this repository without a donation sidecar proving consent.

That result exercised 7 of 8 field encodings and 9 of 12 predictors on real
firmware output, including the nibble-packed encoding that round-trip testing
could never have validated. Synthetic logs from the independently written local
writer also decode clean; those prove reader/writer agreement, while the private
reference log is the independent firmware check.

Scope of the claim, precisely: **Rotorflight 4.6, one board, one flight.** Widen
it only with a log for each version claimed. What remains unverified is listed in
[Blackbox format notes](docs/BLACKBOX_FORMAT_NOTES.md) — one encoding, three
predictors, and one event type nobody's log has contained yet.

Check any log yourself:

```text
npm run verify:log -- /path/to/YOUR_LOG.BFL
```

It checks properties that only hold if the bytes were genuinely understood — the
stream is consumed end to end, time and loop iteration advance monotonically, the
sample interval is stable, and values stay inside sensor range. A decoder subtly
wrong about a bit layout fails these within a few frames.

## For pilots

Everything below this line is about how the app is built. If you fly a
helicopter and want to use it, read the **[pilot guide](docs/PILOT_GUIDE.md)**
instead — how to get the log off the aircraft, what to fly so there is something
to measure, how to read the findings, and what the app keeps.

Its first section is the one that matters most: **turn on `gyroRAW`**. Vibration
is judged on the unfiltered gyro, every gain finding sits behind the airframe
being cleared, and a log without it can never produce a tuning suggestion no
matter how well it was flown.

## Getting a log off the helicopter

Today this needs the Rotorflight configurator: connect, open the Blackbox tab,
tap **Activate mass storage device mode**, then pick the `.bbl` from the drive
that appears. The import screen explains those steps inline rather than leaving
a new user staring at an empty app.

On Android that gets shorter in two ways: RotorLens registers for `.bbl` files,
so a log can be opened or shared straight into the app without copying it
anywhere; and it declares a USB filter for the mass-storage device class, so the
phone offers to open RotorLens the moment the controller mounts. What that costs
— the app now holds permission to talk to that device, and a test asserts no code
capable of it exists in the binary — is recorded in the manifest beside the
filter.

Whether that second app can ever be cut out — and why the answer differs between
Android and iOS, and between dataflash and SD-card controllers — is worked
through in [log import](docs/LOG_IMPORT.md).

## PID tuning evidence

`src/analysis/pid-evidence.mjs` is pure, dependency-free analysis that closes the
two gaps which made "tune P, I and D on roll, pitch and yaw" untrue:

- **Yaw** was previously unmeasurable because stop evidence pooled both command
  directions. A helicopter's tail works with main-rotor torque one way and
  against it the other, so pooling averages a real asymmetry into a number
  describing neither direction. Directions are kept separate end to end, and the
  asymmetry is reported as a finding — a tail running out of authority looks like
  a gain problem and is not one.
- **The I term** was unmeasurable because stop events only show what happens
  after a command is released, which is where P and D live. Steady holds are
  measured instead: steady-state error, whether it is still drifting, and
  low-frequency hunting.

It is a **measurement** module: field names deliberately avoid `delta`,
`direction`, and `recommendation`, and evidence that does not separate the
failure modes cleanly returns no conclusion at all.

Both kinds of evidence need a manoeuvre, and most flights do not contain one. A
blank panel reads as a broken app, so `src/analysis/axis-report.mjs` turns the
detector's diagnostics into an answer — see
[the axis view and capture briefs](docs/AXIS_VIEW_AND_CAPTURE.md).

The same code runs in the Rotorflight Blackbox viewer via a generated build —
see [integration/rotorflight-blackbox](integration/rotorflight-blackbox/README.md).

```text
npm run build:advisor-bundle
```

## What to adjust

**Decided by the owner on 12 August 2026, reversing this project's previous
rule.** RotorLens reads the log you select and recommends what to adjust,
because a screen full of graphs is not an answer to anyone who does not already
know what he is looking at. What that reversal did *not* change is written down
in [CLAUDE.md](CLAUDE.md) and
[architecture and provenance](docs/ARCHITECTURE_AND_PROVENANCE.md):

- A recommendation has to be **earned by evidence**. Where the evidence does not
  separate the candidate causes, the honest output is what can be seen plus what
  to fly to settle it.
- **Mechanical faults outrank gains.** A shaking airframe cannot be tuned, and a
  gain change on one makes it worse. The airframe is ruled out first, or the app
  says it could not be.
- **One change at a time**, with the measurement it rests on shown beside it.
- **RotorLens never writes to a flight controller.** Not behind a confirmation
  either. It reads logs.

Structurally, `src/analysis/recommendations.mjs` is the only module allowed to
tell a pilot to change something, and only where the five gates in
`src/analysis/advisor/recommendation-gates.mjs` pass — airframe, completeness,
agreement between directions, head speed, and stability against this repository's
own undetermined constants. Every other module in `src/` stays measurement-only,
so the raw number behind a claim is always findable somewhere that is not arguing
for a conclusion; `test/axis-report.test.mjs` reads every string literal in the
engine and fails the build on advice that took another route.

**Status, stated precisely:** the viewer calls the recommendation engine for the
selected session and renders its findings. Gain advice is emitted only when all
five gates pass, and only the single `actNow` finding is phrased as the change to
make next; the store and in-app safety copy describe that shipped behavior.

## Fixtures

`fixtures/synthetic/` is written by `tools/generate-fixtures.mjs` and reproduces
byte-for-byte, so its provenance is demonstrable rather than asserted. It covers
single-session, multi-session, GPS-declaring, truncated, and deliberately damaged
logs.

Real logs are exercised locally through `ROTORLENS_REAL_LOG` and related test
environment variables. They are not committed unless an adjacent donation
sidecar proves ownership, consent, and the privacy scan required by
[`docs/FIXTURE_POLICY.md`](docs/FIXTURE_POLICY.md); CI enforces that gate.

## Next steps

1. Record logs on your own aircraft and run `verify:log` against each. Fix any
   assumption it catches, then add only consented logs with complete donation
   sidecars — or keep them private and run the environment-gated corpus tests.
2. Extend the decoder to the frame types real logs exercise that the corpus does
   not yet: GPS frames with data, slow frames, and every event type encountered.
3. Keep every new deterministic analysis on the parser contract rather than on
   decoder internals, and add a regression at the public boundary.
4. Continue profiling large-log peak memory and cancellation on mid-range phones;
   the viewer now cancels superseded reads, but decode remains the dominant heap
   cost.
5. Re-measure every threshold in `src/analysis/`. They were calibrated against
   one flight, and every value that flight produced on a nibble-packed field was
   a sawtooth until an early private-development decode correction—so each
   constant is suspect until it has been derived again from corrected data.
6. Widen the capture briefs with flights that actually contain stops, and confirm
   the briefs describe a manoeuvre the detector then accepts. A brief that drifts
   from the detector sends a pilot up to fly something that will be refused again.

Read [architecture and provenance](docs/ARCHITECTURE_AND_PROVENANCE.md) before
adding any implementation.

## License

RotorLens-authored source is licensed under **MPL-2.0**; see
[`LICENSE`](LICENSE). Copyright (c) 2026 Michael Wallace and contributors.
[`REUSE.toml`](REUSE.toml) supplies machine-readable file-level copyright and
license metadata for first-party files that cannot carry an inline SPDX header;
the reserved GPL and third-party governance boundaries are explicitly excluded.
MPL-2.0 keeps modified RotorLens source files open while allowing native Android
and iOS shells and their store distributions to be built around them, provided
the covered source remains available under the license.

Copies already received under the project's former MIT license remain usable
under that grant; a later license change cannot revoke rights already given to
those recipients. MPL-2.0 applies to this version and later covered versions.

Third-party components retain their own licenses. The Android runtime components,
the verified Gradle wrapper, the non-shipping GPL viewer integration patch, and
the separate non-shipping GPL firmware evidence boundary are recorded in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and exposed where applicable
in the app's About & Legal screen. Project version `0.1.0` is still in
development; no release tag is claimed yet. Before a store build is published,
its About & Legal data must pin and link a signed, exact-source tag from the
official repository.
