# RotorLens

An open-source Rotorflight helicopter blackbox log viewer and tuning adviser,
originally created by Michael Wallace and intended for Android and iOS.

This file covers what is specific to *this* repository and easy to get wrong. It
points at the documents that hold the detail rather than restating them, because
two copies of a rule drift and the copy that drifts is the one someone reads.

## The one rule that matters most

**Nothing from the Rotorflight or Betaflight Blackbox log viewers may enter
RotorLens-authored application source or a shipping build.** Both are GPL-3.0,
while RotorLens-authored source is MPL-2.0. The separation preserves independent
authorship, a checkable provenance record, and the iOS distribution path. Not
their code, markup, styles, assets, wording, or layouts; not a port, a mechanical
translation, or a rewrite done with their source open alongside.

The log *format* is fair game — header keys, field names, encoding and predictor
identifiers, frame markers. Formats are interoperability facts; implementations
are protected expression. That distinction is the whole basis of this project.

`docs/LICENSING_AND_STORE_READINESS.md` is the full picture, including trademark
(the app is **RotorLens**, never "Rotorflight anything") and the store checklist.

A separate GPL fork exists at `mbwallace1390/rotorflight-blackbox` and is a
different project. Never copy it into app-owned source. The one reserved
non-shipping boundary,
`integration/rotorflight-blackbox/0001-consume-rotorlens-pid-evidence.patch`,
contains GPL viewer context and modifications and remains GPL-covered; the root
MPL license does not cover it. The independently generated MPL-2.0 analysis
bundle flows the other way under the secondary-license path documented in its
header.

**One authorised same-author transfer into app source exists, and it is the
shape every future transfer must take.**
`src/analysis/advisor/` was written by this project's owner, on a branch of that
fork, and made available here under MPL-2.0 because he holds the copyright — the
GPL binds recipients of that project, not its author. Before anything else
crosses:
`git log` must show sole authorship with no co-author trailers; the file must be
new on that branch rather than a modified upstream file; it must not reference
the viewer (`FlightLog`, its DOM, its CSS); and the transfer must be recorded in
`docs/ARCHITECTURE_AND_PROVENANCE.md`. Anything touching the viewer's interface
gets rewritten against our own session shape, not adapted. An undocumented
transfer is indistinguishable from a violation.

## Standing constraints

- **No dependencies in `src/`, `ui/`, `tools/`, or `test/`.** None. `npm test`
  runs on a bare Node 22 with no install step, and a provenance test fails the
  build if that changes. `androidx.activity` in the Android app is the sole
  shipping dependency and it is recorded in `THIRD_PARTY_NOTICES.md`.
- **`src/` must stay platform-neutral.** No `Buffer`, no `node:*` imports. The
  engine runs in Node, in a browser, and in the Android WebView from one copy;
  the experimental iOS shell scaffold uses that same copy and must keep doing
  so. `Buffer` was removed once already; a Node-only API there breaks a mobile
  app silently, because Node tests provide the very globals whose absence is the
  risk.
- **The Android app requests no `INTERNET` or sensitive platform permission.**
  Without `INTERNET` it cannot upload someone's flight, which for logs carrying
  GPS home coordinates is a stronger promise than a privacy policy. A test fails
  if that permission appears. iOS has no equivalent permission gate, so the
  cross-platform property is separately enforced: current builds contain no
  upload transport and send no flight data.
- **Nothing in Java decides anything.** The native shell acquires a file and says
  so; all decoding, analysis, and presentation live in JavaScript where the tests
  can reach them. See `android/README.md`.

## The decoder

`src/blackbox/` is ours, written from the log format. Verified against a real
Rotorflight 4.6.0 flight: 134,429 samples, zero errors, 993 µs median interval
with no outliers.

**Understand exactly what that sentence does and does not claim.** Every number
in it is about the frame stream staying aligned, and TAG8_4S16 was decoded from
the wrong end of its lead byte for the whole time it was true. Reversing those
selectors permutes the field widths without changing their sum, so sync holds,
errors stay at zero, the interval stays at 993 µs — and every setpoint,
rcCommand, mixer and governor value is a sawtooth. Peak roll command read 287 °/s
instead of 56 °/s. `npm run verify:log` passed 12/12 throughout.

Round-trip cannot catch that class of bug, because our encoder makes the same
assumption as our decoder. Conformance checks on real logs cannot catch it
either, unless they test **continuity across I-frame boundaries** rather than
alignment. When you touch an encoding, that is the check that matters: a P frame
carries a delta, so a field decoded wrongly drifts and snaps back on a fixed
32-sample phase, and a correctly decoded one does not.

**The claim is Rotorflight 4.6, one board, one flight.** Do not widen it in the
README or store copy without a log for each version claimed.
`docs/BLACKBOX_FORMAT_NOTES.md` records exactly which encodings and predictors
real firmware has exercised and which are still round-trip only, plus which
event types no held log contains (51, 14, 30 — their layouts come from the
pinned firmware serializer, not from measurement). An unknown event resyncs
loudly; a known one with the wrong length would silently misread every frame
after it, which is why an event layout is only ever added against the pinned
serializer.

Check any log with `npm run verify:log -- <path>`.

## The analysis

**The product's defining rule was reversed on 12 August 2026, by the owner,
deliberately.** Until that date this file said the analysis reports measurements
and never instructions, and a test failed the build if instruction-shaped text
appeared anywhere it could speak. That is no longer what RotorLens is. In the
owner's words:

> i would like the app to analize the flight log the end user selects and
> recommend what to adjust, thats always been my plan for the app because a lot
> of people have no clue what they are looking at when they see all the info and
> graphs.

That is the purpose of the app, decided by the person who owns and ships it. It
is not open for relitigation, and it is not to be softened back into a caveat.
If you find yourself writing "we should not tell the pilot what to change", stop:
that question is settled.

**What did not change, because it is engineering rather than product:**

- **A recommendation must be earned by evidence.** Where the evidence does not
  separate the candidate causes, the honest output is *here is what I can see,
  here is what to fly to settle it* — not a guess dressed as a verdict.
- **Mechanical faults outrank gains.** A helicopter with a vibration problem
  cannot be tuned, and advising a gain change on a shaking airframe makes it
  worse. Rule out the airframe first, and say so plainly when you cannot.
- **One change at a time, with the basis shown**, so the pilot can disagree and
  so that re-flying it tells anyone something.
- **RotorLens never writes to a flight controller.** Not now, not behind a
  confirmation dialog. It reads logs. This has not changed and is not up for
  discussion either.
- **Confident and wrong is still worse than silent.** The bar moved from *never
  advise* to *advise when the evidence carries it*. It did not move to *always
  advise*.

**Advice comes from one place.** `src/analysis/recommendations.mjs` is the only
module permitted to tell a pilot to change something, and only where the five
gates in `src/analysis/advisor/recommendation-gates.mjs` pass — airframe,
completeness, agreement, headspeed, stability, all of which answer *no* until
evidence makes them answer *yes*. Every other module in `src/` stays
measurement-only, so the raw number behind a claim is always findable somewhere
that is not itself arguing for a conclusion.

That is enforced, not merely stated. `test/axis-report.test.mjs` reads every
string literal in every module under `src/` — concatenated fragments glued back
together first — and fails the build if one of them tells a pilot to change a
setting. A module may take the exemption only by declaring itself and consulting
the gates. The same file asserts that the gates default to refusing, that the
recommendation surface handed no evidence says nothing advisory, and that no
module anywhere reaches for a serial, USB, Bluetooth or HID transport.

Field names in `src/analysis/pid-evidence.mjs` still avoid `delta`, `direction`
and `recommendation`. It is a measurement module and it stays one; the words
moved one file over, not into every file.

This is a machine with spinning blades.

## Fixtures

`fixtures/synthetic/` is generated by `tools/generate-fixtures.mjs` and hash-
checked. Never hand-edit one. Regenerate with `npm run fixtures:generate` and
commit the result; the manifest and the tests must agree.

`.gitattributes` marks logs as binary. Git's text heuristics see `.TXT` and
rewrite line endings on Windows checkout, which changes a log's length and
corrupts its frame data. That has already happened once.

Real logs are not committed without written permission from whoever flew them,
and never with GPS data intact — `docs/FIXTURE_POLICY.md`.

## Testing, learned here

- **Synthetic data proves an implementation self-consistent. Only real data
  proves it right.** Real logs have caught, in order: 17 unknown event types, a
  conformance tool that called a normal truncated capture a decode failure, and
  an analysis confidently telling a healthy aircraft to reduce its I term because
  sensor noise crossed a threshold 61 times a second. Every one of those passed a
  fully green suite first.
- **A test may regenerate into memory, never onto disk.** Compare the committed
  artifact against what the generator produces; do not write the artifact and
  then read it back. This has now happened twice. The provenance test used to
  rewrite the fixtures, so whether corruption was visible depended on which file
  the runner reached first. The advisor-bundle test called `buildAdvisorBundle()`
  in every case, so "the committed bundle is up to date" read a file the two
  tests above it had just rebuilt, compared a rebuild against itself, and could
  not fail — while the GPL fork shipped whatever `dist/` happened to contain.
  Both passed a fully green suite for as long as they existed.
- **Asserting on static markup proves nothing about whether code ran.** The
  browser test once passed against a shell whose JavaScript had 404'd. It now
  opens a real log through the real file input.

## Commands

```text
npm test                    # the whole suite; needs Chrome/Edge for the browser test
npm run ui                  # http://127.0.0.1:8173/
npm run verify:log -- FILE  # conformance check against a real log
npm run fixtures:generate   # regenerate the corpus (must be byte-identical)
npm run build:advisor-bundle
```

```text
npm run check:donation -- FILE   # refuses a log carrying position data
npm run corpus:report -- DIR     # the distributions this repo still guesses at
```

Android: open `android/` in Studio, not the repo root. It compiles, installs and
runs on a real handset. Re-run the mobile-width and device checks on every target
class rather than treating one private handset model as the supported matrix.

## Where this actually stands

Read this before believing any plan. Written 2026-08-13.

**The engine has never produced a gain verdict on a real flight.** Across 110
real sessions on three boards and two aircraft: zero roll or pitch stop events,
nine yaw stops over six sessions, and not one gain finding of any kind. Every
gain card that has ever rendered came from a synthetic fixture. The blocking
item is not code — it is one deliberate sortie, described in
`docs/PILOT_GUIDE.md`, flown with `gyroRAW` enabled and one governor setting.

**Two shipped gates could never open, and both were found by volume rather than
by review.** `minimumComparisonHolds` was 5 per side; the maximum hold segments
ever observed on a flight-axis is 4, so all 310 same-aircraft pairs returned
not-enough-evidence and the comparison had never once fired. And the 0.39 deg/s
noise floor is a POOLED statistic that was applied per axis: measured per-axis
it is roll 0.915, pitch 1.390, yaw 0.0966, so it was ~4x too loose on yaw and
2.4-3.6x too tight on roll and pitch. Both were fixed on 17 August 2026: the
per-axis floors now live in `EVIDENCE_LIMITS.holdErrorNoiseFloorByAxisDps` and
gate `compareHoldEvidence` itself, and the hold minimum was rederived per axis
against those floors to 3 per side (the derivations are in
`src/analysis/pid-evidence.mjs`). Neither change has yet produced a verdict on
a real flight — the deliberate sortie below is still the blocking item.

**The Android memory cap is not solved.** Lazy decoding cut opening a 125 MiB
dump from 6.2 s to 40 ms, but the file's own bytes must now stay resident, so
peak is (file + one session) — roughly a wash on the largest single flight
against a cap commonly 192-256 MB. Not holding the whole file is the real fix.

**Sharing is designed and half-built, with no transport.** `docs/SHARED_CORPUS_DESIGN.md`
is the plan; `shareableRecord` and the consent and erasure screens exist; current
builds contain no upload transport, and Android requests no `INTERNET`
permission. Adding transport is one deliberate commit that also changes the
store listing, the privacy policy, the generated legal screen and three tests —
all together. Android's missing permission and the cross-platform no-upload
behavior are distinct claims and both must remain true.

**Private real logs** stay outside the repository. Point local checks at them
with `ROTORLENS_REAL_LOG` and the corpus environment variables documented by the
tests. The private reference log declares GPS and contains position frames: it
may be read for local verification but never committed or excerpted without the
required written permission and privacy sidecar.

**Device testing** may use USB or wireless ADB. Supply the current endpoint as
`ROTORLENS_ADB_SERIAL=<device-ip>:<port>` rather than recording a private network
address here. `.claude/skills/device-check/` is the procedure.

## Where things are

| | |
| --- | --- |
| `docs/LICENSING_AND_STORE_READINESS.md` | open-source, provenance, third-party, and store obligations; read before adding anything |
| `docs/BLACKBOX_FORMAT_NOTES.md` | format assumptions and what real firmware has verified |
| `docs/LOG_IMPORT.md` | how a log gets off the aircraft, and whether that can improve |
| `docs/FIXTURE_POLICY.md` | consent, GPS, and what may be committed |
| `docs/ARCHITECTURE_AND_PROVENANCE.md` | components, the provenance boundary, and the 12 Aug 2026 advice decision |
| `docs/AXIS_VIEW_AND_CAPTURE.md` | what the measurement panels say, and where advice is allowed instead |
| `android/README.md` | the native shell and its first-run checklist |
| `integration/rotorflight-blackbox/` | shipping our analysis to the GPL fork |
