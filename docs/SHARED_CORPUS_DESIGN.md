# Sharing measurements: global learning, offline first

What RotorLens would send, when, with what consent, and what it would cost.

**The owner has chosen global/community learning as the product goal.**
Measurements contributed by many pilots should improve the starting advice for
every compatible helicopter; evidence from the individual helicopter then
personalises that starting point. The goal is chosen. A backend, automatic
upload, and the consent needed for either are not.

**Phase 1 is an offline contract and shadow-evaluation phase.** Its built slice
freezes and audits the contribution shape, defines aircraft cohorts, and builds
a versioned shadow-only aggregate artefact from explicitly linked controlled
trials. The remaining Phase 1 work is to collect properly licensed controlled
trials, build a held-out-aircraft evaluator, and prove a candidate without
showing or applying its result.
Phase 1 adds no endpoint, cloud database, upload, download, automatic model
update, or network transport; on Android it adds no `INTERNET` permission.

**Sections 1–10 describe a later transport that does not exist and is not part of
Phase 1.** No code sends anything anywhere; Android requests no `INTERNET`
permission. Adding transport (and that Android permission) is a separate,
deliberate commit — the commit that spends the store claim in section 7. **The
offline schema, cohort builder, shadow aggregator, CLI, and sections 11 and 12
are built and running.** They are the part of the problem that needs no
permission: defining and auditing the shape, measuring donated `.bbl` files
locally, and refusing to publish one that carries a position. They do not yet
make an evaluated community tuning model.

The order is deliberate and worth stating, because it looks backwards. Building
the contract and safety proof before the transport is how the chosen goal stays
answerable. Retrofitting network access onto an installed base is worse than
shipping with it, so the shape has to exist first; and pilots are handing each
other `.bbl` files in Discord today, so the shape is useful before any transport
exists. **Choosing global learning does not authorize section 6.** That is a
later product and privacy decision after the offline shadow gate passes.

Written because the app hit a wall that one pilot cannot climb: across 109 real
flights on two aircraft, the learning model found **zero usable data points**, and
the effect-size sweep says a single term needs roughly twelve deliberate flights
before it can name a direction. Pooled across many pilots those numbers stop being
absurd. That is the whole case for this.

---

## 1. What the corpus would actually answer

Not one universal "what gains should I use" table. The community layer should
provide cohort-conditioned starting evidence — what conservative first test has
worked for comparable helicopters — while the local model verifies and
personalises it. The corpus also replaces the numbers this repository currently
guesses at.

| Question | Status today | What a corpus gives |
| --- | --- | --- |
| How many hold segments can a real flight produce? | `minimumComparisonHolds` sat at 5 while **the maximum ever observed is 4**, so the comparison had never once fired; rederived per axis to 3 on 17 August 2026, which observed flight-axes can reach. | The real distribution, and margin above the gate rather than a gate that barely opens. |
| What is the flight-to-flight noise floor per axis? | Measured on 2 aircraft: roll 0.915, pitch 1.390, yaw 0.0966 °/s. n = 5, 4 and 18. | The same numbers at n in the thousands, per aircraft class. |
| When is vibration worth chasing? | `8 °/s`, calibrated on synthetic signals, marked experimental. | Where normal sits, and — with labelled faults — where bad sits. |
| Is 80 °/s the right stop threshold? | Chosen for 3D flying. The owner's flights peak at 56 and 32. | What learners actually fly, so the gate matches the users. |
| Does a P change move roll standing error enough to measure? | **Unmeasured. Nobody has flown it.** | Answered by the first fifty pilots who try. |
| What conservative first adjustment is most promising for this aircraft class? | A new aircraft starts with only generic single-flight evidence and must teach the local model from scratch. | A cohort prior that narrows the first test, with local safety gates and a confirming flight still required. |

The first row is the strongest argument. A shipped gate that cannot open was
found only because two large dumps existed to test it against. Most such defects
need volume to surface at all.

---

## 2. What would be sent

**The flight record, not the log.** The record already exists: `buildFlightRecord`
runs on every analysis, before the pilot decides anything. It is about 4.4 kB.

It was designed for local storage under rules that forbid the log, any
coordinate, any date and any filename, with `auditFlightRecord` enforcing that by
inspection. Those rules happen to be exactly what a shared corpus needs.

### The shared shape is narrower than the local one

Two fields in the local record must never leave the device:

- **`craftName`** — whatever the pilot typed into the configurator. Harmless on
  their own phone. People name helicopters after themselves.
- **`aircraftKey`** — derived from `craftName`, so it carries the same problem.

They are replaced by an opaque **`sharingId`**: a random value generated on the
device, one per aircraft, stored locally beside the history. It groups one
machine's flights together — which is required, because null pairs are how noise
floors are measured. It is pseudonymous, not proof of anonymity: a persistent ID
plus unusual equipment can be linkable, and a future service would also see
request metadata unless it deliberately minimizes and expires those logs.

The remaining shared fields come only through a fixed allowlist. Equipment text
is canonicalized and bounded rather than treated as harmless free text:

```
schemaVersion, kind, sharingId, ordinal, board, firmwareRevision,
windowBasis, durationSeconds, ratesFingerprint,
gains.{roll,pitch,yaw},
axes.*.headspeedMedianRpm,
axes.*.hold.*      status, counts, steady-state error, drift, ripple,
                   crossing rate, I-term RMS
axes.*.stop.*      status, per-direction counts and shapes
axes.*.noise.*     filtered and unfiltered high-frequency RMS
```

### The implemented Phase 1 contribution envelope

The shared flight record is nested inside a second, fixed-shape envelope. That
envelope records the extractor and schema versions, separate consent and licence
versions, a keyed contribution ID, a structured airframe profile, configuration
fingerprints, the airframe safety assessment, guidance provenance, and an exact
controlled-trial link. Its audit has three deliberately different outcomes:

- **measurement eligible** — the scrubbed record can help measure broad corpus
  coverage, even when comparison context is incomplete;
- **cohort eligible** — all required configuration, airframe, headspeed, legal,
  and safety context is known and the airframe assessment is `clear`;
- **advice eligible** — the record clears the cohort rules and can participate
  in the private shadow calculation. A P/I effect still requires an accepted
  guidance source and a matching controlled-trial link on the after-record.

Both latter states are deliberately unreachable in the current engineering
draft. The production consent/licence registries are empty, and configuration
fingerprint schema 1 declares its setting coverage `incomplete`. This prevents
test data or a partial settings map from being mistaken for production evidence.

Malformed context is rejected; it is not converted to a convenient “unknown.”
Legitimately absent context is measurement-only. Rotor diameter is banded, and
each axis's headspeed is mapped to its own logarithmic band whose internal ratio
cannot exceed 1.05; a quiet roll/pitch median cannot hide a mismatched yaw RPM.
Board and firmware targets come from small reviewed registries rather than a
free-text regex. Prototype filter/governor digests carry a preimage-schema
version and are built from a deterministic key-sorted canonical representation,
so input ordering cannot manufacture different digests. Schema 1 has no approved
required-key manifest and is therefore never treated as complete. A later schema
must enumerate every required setting and its missing-value semantics before it
can unlock cohorting. The private shadow artefact publishes deterministic
anonymous cohort labels rather than board text or configuration digests, and it
omits exact per-aircraft extrema.

An ordinal is only the order of saved local history. It does **not** prove that
two records are consecutive real flights, that no repair happened between them,
or that the pilot changed only one setting. A P/I effect enters the shadow model
only when the after-record carries a versioned controlled-trial object naming
the exact baseline contribution ID, intended axis, term, and direction, and the
actual headers independently confirm exactly that change. Unknown provenance,
community ancestry (even when the immediate source is the local engine), D
changes, multi-setting changes, RPM-band changes, and non-clear airframes fail
closed. Across aircraft, an effect also needs at least five machines whose
observed gain and axis-RPM intervals share a real operating point. The point is
used privately for support selection and never published. Ordinary exported
history therefore cannot accidentally be relabelled as causal evidence, and
normalized slopes from disjoint gain ranges cannot be pooled.

The production legal registries are empty. The expanded Phase 1 text in
`docs/COMMUNITY_CONTRIBUTION_TERMS.md` has draft identifiers and a pinned digest
for engineering tests, but those identifiers are rejected by production audit;
the app's narrower `2026-08-14` local-sharing choice is also rejected. Formal
adoption must create new identifiers and preserve a separate acceptance receipt.
The current Discord request in section 12 deliberately obtains no such licence,
so those logs may measure demand and detector behaviour but may not train a model
that is shipped or sold.

`exportHistory` already rebuilds records from a documented allowlist rather than
stringifying what it was handed. The shared projection is a second, narrower
allowlist in the same place, and `auditFlightRecord` gains a rule that the shared
shape must never carry a name or a key.

### One thing the server adds, and it needs care

A receipt timestamp is a re-identification vector: "flights received at 14:02 on
a Tuesday" is a pattern. **Coarsen it to the month on arrival** and never store
finer. The record itself carries no date by design; do not let the transport
reintroduce one.

---

## 3. When it would be sent

**On open, after a single opt-in. Zero taps, ever again.**

The record is built during analysis regardless, so uploading costs the pilot
nothing. `checkFlightAdmissible` already rejects bench runs and spool-ups — 72%
of sessions in the reference corpus — so only real flights would be sent.

The alternative, sending only on **Save**, adds no friction either but yields
only the flights a pilot chose to keep. The corpus needs the boring ones: two
unremarkable flights with nothing changed are a null pair, and null pairs are how
the noise floor gets measured.

**Off by default.** Opt-in, never opt-out.

---

## 4. What the pilot is asked, and when

Not at first run. Asking before the app has done anything useful is how consent
becomes a reflex tap. Ask **after the first successful analysis**, once there is
something to point at:

> **Help RotorLens get better at this?**
>
> RotorLens can send the measurements from this flight — about 4 kB of numbers —
> to help work out what normal looks like across many helicopters. It is how the
> thresholds this app judges your aircraft against stop being guesses.
>
> **Your log never leaves your phone.** What would be sent is the same handful of
> numbers the app already keeps: your gains, how well each axis tracked, head
> speed, and how much vibration was measured. Never the log, never your location,
> never a date, never a file name, and never your helicopter's name.
>
> You can see everything that has been sent, and delete all of it, at any time.
>
> **You keep ownership of your measurements.** Sharing them lets RotorLens use
> them to improve the app, including free releases and releases distributed for
> a fee. [What this means]
>
> [ Not now ]   [ Share measurements ]

"Not now" rather than "No" because it is asked once; a pilot who declines can
turn it on later from the same screen and should not feel the door closed.

---

## 4a. The licence grant, and where it belongs

Without a licence you cannot legally use what people send. A contributor owns
what they contribute, and "they gave it to us" is not a right to build a
distributed product on it.

**It belongs in the consent dialog, as one sentence, with the detail behind a
link.** Two agreements are being made and they are legally different:

- **Consent to process** — GDPR territory. Must be specific, informed, freely
  given and revocable.
- **A licence to use** — contract and IP. Says what may be built with it.

Bundling both into one tap is ordinary practice. Burying the licence inside the
privacy sentence is not: it makes the consent weaker rather than the licence
stronger, and a regulator reading a dialog that hid a commercial grant inside a
privacy notice will treat the whole thing as tainted.

### The sentence in the dialog

Added below the privacy paragraph, visually separated:

> **You keep ownership of your measurements.** Sharing them lets RotorLens use
> them to improve the app, including free releases and releases distributed for
> a fee. [What this means]

Three things that sentence has to do, in that order: reassure that ownership is
not being taken, state plainly that this includes commercial use — because it
does, and finding that out later is how goodwill is lost — and offer the detail
without demanding it be read.

### What the full terms have to cover

- **Non-exclusive, worldwide, royalty-free.** You need to use it; they keep
  every right to their own data.
- **The right to derive.** The point is not the records — it is the thresholds
  computed from thousands of them. Say that derived statistics are the purpose.
- **Commercial use, named.** RotorLens is open source, and open-source releases
  may still be distributed for a fee. A grant that omits this is a grant
  somebody can reasonably dispute.
- **Redistribution, decided deliberately.** If the corpus might ever be published
  or shared with the Rotorflight project, the licence must permit it up front —
  it cannot be added afterwards to records already collected. If it is not
  wanted, say so, because "we may share it with partners" in boilerplate is worse
  than useless.
- **Termination that matches the deletion promise**, which is the one clause with
  a genuine wrinkle.

### The wrinkle worth getting right

A deletion request removes a contributor's records. It cannot remove a threshold
already computed from ten thousand of them, any more than a baker can return one
egg from a cake. The terms must say exactly that:

> Deleting your shared measurements removes your records from the collection.
> Statistics already calculated from them — averages and thresholds across many
> helicopters — cannot be recalculated to exclude records that no longer exist,
> and remain in the app.

This is standard for aggregate research data and it is honest. Discovering it
after a deletion request would not be.

### What this is not

Consent for one thing is not consent for another. If RotorLens ever wants to send
something beyond the shared record — raw logs, anything with a coordinate, crash
diagnostics — that is a new ask, not covered by this one, and the version of the
terms a contributor agreed to should be recorded with their records so it is
answerable later.

**This is the paragraph most worth an hour of a real lawyer's time.**
`docs/LICENSING_AND_STORE_READINESS.md` already calls for an IP review; the
wording above is a starting point for that conversation, not a substitute for it,
and nothing in this document is legal advice.

## 5. Deletion, and the honest problem with it

A **Shared measurements** screen shows a safe receipt for each aircraft, how many
records have been sent, and a button to delete everything sent from this device.
Deletion uses a separate random deletion capability; the public grouping ID is
not itself sufficient authority to erase records.

**The honest limit, which must be stated in the app rather than buried here:** the
deletion capability lives only on the device unless the pilot exports its
receipt. Clear the app's storage or lose the phone without that receipt, and the
authority is gone — the records remain pseudonymous in the corpus and can no
longer be found safely for that pilot. That is a deliberate consequence of not
holding an account, and it must be said plainly before someone opts in.

Show an exportable deletion receipt on screen so a pilot who wants that ability
can preserve it. If it is lost, the limitation must be stated honestly.

---

## 6. Transport

**Firestore behind App Check** is one later option because the owner already runs
it on other projects. App Check can reduce generic scripted abuse; it cannot
prove that a flight, aircraft, or measurement is truthful and it does not solve
Sybil attacks. Every record still needs server-side schema, licence-version,
replay, physical-range, configuration, controlled-trial, and safety validation,
followed by quarantine and bounded per-aircraft influence.

The Firebase client configuration embedded in an open-source app identifies a
project; it is not submission authority. Production intake defaults to official
RotorLens builds whose registered app identity is attested with Play Integrity
on Android or App Attest on Apple platforms. A fork signed by another maintainer
does not inherit that trust. A later federation policy may enroll a specific
fork only through an explicit app registration plus accepted terms, schema,
quotas, deletion behavior, and the same quarantine gates. A fork using its own
backend remains a separate corpus and cannot silently influence the official
RotorLens model.

Plain `fetch` against the REST API. **No SDK.** The zero-dependency property in
`src/`, `ui/`, `tools/` and `test/` is enforced by a provenance test, and an
analytics SDK would also bring data behaviour nobody in this repo has read.

Cloudflare Workers with D1 is an equivalent later choice if you would rather not
tie this to Google. Neither provider makes ingestion, deletion, abuse handling,
model release, or privacy obligations a thirty-line feature.

Whatever receives it, the write path must be **append-only for clients**. A client
that can read the corpus can enumerate other people's aircraft.

### The Firebase emulator stop

`backend/firebase/` now implements the next boundary as a local Emulator Suite
proof, using only the reserved `demo-rotorlens` project id. It has no
`.firebaserc`, credentials, deploy command, Firebase account binding, mobile SDK,
app caller, or Android `INTERNET` permission. The exported callables require App
Check, the Functions emulator, the exact demo project, and the loopback
Firestore emulator. An accidental cloud deployment or a Functions-only emulator
remains closed.

Submission is intentionally **zero-write**. The endpoint applies the canonical
community audit and checks a separate exact-pair terms receipt, but the only
registered terms are still engineering drafts. A well-formed draft therefore
returns `PRODUCTION_INGESTION_CLOSED`, malformed or invented terms fail closed,
and privileged emulator inspection proves no document was created. This does
not turn the draft into consent by calling the destination quarantine.

The emulator tests seed synthetic records through the Admin test boundary only
to prove deletion and statistics mechanics. Deletion requires a separate
256-bit capability, gives unknown aircraft and wrong capabilities the same
answer, removes records and replay claims, and retains a capability-hash
tombstone so an old retry cannot resurrect an erased aircraft. Direct
authenticated and unauthenticated Firestore reads and writes are denied.

Public statistics are not a user counter. With no account or analytics,
installations cannot be equated with people. The callable counts only active,
validated aircraft and flights, withholds everything below five aircraft, and
then returns rounded-down lower bounds (5, 10, 25, 50, 100, 250, 500, or 1000).
Rejected, draft, quarantined, deleted, and test records are not learning data.
The response remains `closed-no-production-corpus` because there is no accepted
corpus or model.

The proof has two isolated npm lockfiles because the emulator and Functions
tooling are not app dependencies. CI starts Firestore and Functions with Node 22
and Java 21, verifies the blanket-deny rules, hostile input, zero-write
submission, deletion tombstone, privacy floor, and missing-App-Check refusal,
then tears the emulators down. A real debug-token test is not device attestation
proof and belongs to a later, account-backed phase.

---

## 7. What this costs, stated plainly

**The strongest claim in the store listing weakens.** Today:

> All current builds contain no upload transport and do not send flight data.
> On Android, RotorLens also requests no `INTERNET` permission. Nothing leaves
> your phone.

The behavior is checkable in every build, and Android's stronger permission
boundary is pinned to its manifest by a test. Afterwards the copy becomes:

> Your flight logs never leave your phone. RotorLens can share anonymous
> measurements if you choose to.

The first half stays literally true and is still unusual. The second half is a
promise rather than a property, and **that change is permanent.**

Also acquired: a consent flow, materially different Play Data Safety and App Store
privacy answers, GDPR deletion obligations, a corpus that strangers contribute to,
and network transport (including Android's `INTERNET` permission) — which means
`test/provenance.test.mjs`,
`test/privacy-claims.test.mjs`, `test/legal-disclaimer.test.mjs`,
`docs/STORE_LISTING.md`, `docs/PRIVACY_POLICY.md` and the generated legal screen
all change together, deliberately, in one commit.

---

## 8. Store declarations — flagged, not answered

These change from "no data collected", and the taxonomies are picky enough that
guessing is worse than asking.

**Google Play Data Safety.** Collection means transmission off the device, so this
becomes a *yes*. The likely category is **App activity / Other actions** or
**App info and performance / Other app performance data**. Declare: collected, not
shared with third parties, optional, deletable on request, encrypted in transit.

**Apple App Privacy.** Moves from *Data Not Collected* to a **Diagnostics — Other
Diagnostic Data** entry. The awkward question is whether `sharingId` counts as an
identifier: it is random and device-generated, but it is persistent and groups
records, which is close enough to Apple's *Device ID* that declaring it is safer
than arguing. Not used for tracking, not linked to identity.

`docs/LICENSING_AND_STORE_READINESS.md` already calls for an IP review. This
belongs in the same conversation. **This document is not legal advice.**

---

## 9. Roadmap and the Phase 1 boundary

The chosen first phase is deliberately useful without a service. Its status is
kept explicit so an aggregate builder cannot be mistaken for a validated tuning
model:

1. **BUILT, FAIL-CLOSED:** the version-2 contribution shape is closed and audited
   at every boundary. Invalid or unknown enumerations fail closed rather than
   becoming pass-through strings. Draft legal identifiers are distinct from the
   empty production registries.
2. **PARTLY BUILT:** structured aircraft, per-axis logarithmic headspeed bands,
   safety, closed guidance provenance, controlled-trial links, and common
   gain/RPM support rules are defined. Configuration fingerprint schema 1 is
   intentionally incomplete and therefore cannot unlock a real cohort. A single
   universal gain table is not a model.
3. **PARTLY BUILT, TEST-ONLY:** deterministic, aircraft-balanced,
   privacy-floored shadow aggregation and strict artifact auditing exist. Its
   positive fixtures use an explicitly test-only prevalidated boundary; the CLI
   and production builder cannot use that seam. Provenance signing, a bundled
   fallback, and rollback rules must exist before the app can consume any later
   production artefact.
4. **PARTLY BUILT, STILL FAIL-CLOSED:** a firmware-versioned Blackbox extractor
   now fingerprints a reviewed, release-specific **partial tuning-context
   subset**. It includes the relevant feature mask, loop/process timing,
   Blackbox logging cadence, controller and gyro/RPM-filter context, plus
   emitted motor, actuator, and accelerometer context that changes how a
   flight should be compared. It
   rejects unclean or mutable header evidence, missing or duplicate settings,
   values outside their release-specific domains, inconsistent ranges, and
   unreviewed firmware/target claims. It is never a complete configuration:
   Blackbox omits collective-rate configuration and complete governor state.
   Contribution schema 1 therefore remains closed, and the extractor's schema-2
   context fingerprint is not accepted as cohort evidence. The next
   configuration step remains a separate sanitized CLI supplement; then
   terms can be reviewed and formally adopted under new identifiers, licensed
   controlled trials collected, and the offline evaluator built. Split train,
   validation, and test by aircraft, never by flight, so another flight from a
   known machine cannot masquerade as proof on a new one.
5. **NOT YET BUILT:** run candidate models in shadow mode: compare what they would recommend with
   held-out outcomes, but do not show, apply, or write those recommendations to
   a flight controller.
6. Require the shadow safety and usefulness gates to pass before proposing a
   transport commit.

**Explicitly outside Phase 1:** Android `INTERNET`, `fetch`, an upload or model
download path, a receiving endpoint, cloud storage, automatic updates, and any
change to the current consent, privacy, or store declarations.

### The implemented Blackbox configuration boundary

`src/analysis/community-config-extractor.mjs` consumes only output from
`parseSession(bytes, startOffset, index, {retainHeaderEntries: true})`. Ordered
entries are deliberately opt-in so the normal viewer and decoder do not retain
a second copy of every header line. For extraction, the frozen ordered snapshot
and `headerTerminationClean === true` are load-bearing evidence: the ordinary
`headers` map keeps only the last value, so it cannot expose duplicates, and a
parsed prefix cannot prove that an unterminated trailing `H ` line was harmless.
Header order does not affect the fingerprint, while changing one required value
does. The returned report contains only a tagged digest wrapper, manifest id,
partial-coverage states, and closed reason codes. It never returns raw settings,
craft name, log date, path, or arbitrary header text.

Each manifest publishes its official Rotorflight source paths and exact release
commit pins. The reviewed sources include
`src/main/blackbox/blackbox.c` for emitted header fields,
`src/main/blackbox/blackbox_fielddefs.h` for the logged-field mask,
`src/main/pg/pid.h` for controller storage domains,
`src/main/pg/rpm_filter.h` and `src/main/flight/rpm_filter.c` for RPM-filter
widths, signedness, and semantic source bounds, `src/main/config/config.c`
and `src/main/config/feature.h` for post-boot canonicalization and named
feature bits, the accelerometer-driver assignments for the runtime one-g scale,
and the relevant CLI-setting, receiver-enum, unified-target feature, and
parameter-name definitions. The release pins are 4.3.0
(`05570fec69fd566e713f11e84adc7b77a8d68abf`), 4.4.0/4.4.1
(`5fc142adfdc4031877061433c5052e473b9cdfd2` /
`456633bcea79933142c7fee17922ab306028bcf9`), 4.5.0/4.5.1
(`e77d192c43c4b36ef4d18b67d24859ddc0968755` /
`e69823a3c185cbf1b75fd2701e938e978591a36b`), and 4.6.0
(`118e9120260bb33f46df4f92052fb0e9fd4e9ebc`). Another patch, release
candidate, target, or commit claim cannot silently borrow one of those reviewed
manifests.

The fingerprint is a reviewed **partial Blackbox tuning-context subset**, not a
complete filter or aircraft configuration. Its release-specific domains cover
the relevant `features` bits, loop/process timing, command response and
acceleration, the internally consistent I/P logging cadence, non-duplicated
controller context, gyro/static/dynamic/notch filters, the correct 16-slot
RPM-filter layout, the logged-field mask, deadbands, accelerometer filter and
hardware context including the runtime one-g scale, and emitted motor/actuator
settings such as protocol, output rate, throttle bounds, and (where present)
`collectiveRange`. For 4.5/4.6 RPM filtering, only the post-validation custom
preset 0 form is currently accepted; built-in presets 1-3 fail closed until
their release-specific tables are embedded and pinned. Conditional firmware
builds and fields Blackbox does not emit remain outside that claim.

The firmware revision, short commit, and target in a Blackbox header are
self-reported text. Matching them to a reviewed manifest is strict input
selection, **not firmware attestation** and not proof of what binary actually
ran. The extractor also requires Rotorflight's exact fixed gyro-scale header;
a malformed scale cannot silently change the units under the measurements.
More importantly, even 4.4-4.6 expose only `govPID` and `yaw_tta`, not
`gov_mode` or the rest of the load-bearing governor configuration; 4.3 exposes
none. `collectiveRange` is not the missing collective-rate configuration.
Hashing either incomplete subset as though it were complete would merge
materially different controllers. Every successful extraction therefore keeps
`filterComplete: false`, `governorComplete: false`, `governor: null`, and
`complete: false`, with explicit partial/governor reason codes. A sanitized
CLI supplement for collective-rate and governor state remains mandatory. The
reviewed MSP replies cannot supply every required setting and therefore cannot
stand in for that supplement.

There is no app caller, CLI intake, UI or Android wiring, network path, or
model-consumption path for this extractor. It cannot change advice or app
behaviour in its current form.

### The sanitized configuration-supplement boundary

Phase 2B adds a second, separate offline boundary in
`src/analysis/community-config-supplement.mjs`. It accepts only a small,
versioned JSON snapshot whose rows have already been sanitized by a local
collector. It does **not** accept a raw Rotorflight `dump`, `diff`, serial
transcript, or MSP capture. Those sources can contain a craft or pilot name,
the MCU identifier, a board signature, receiver and port configuration, and
other data that is neither needed nor safe to include in a community record.
The boundary is byte-, row-, key-, and value-bounded, uses fatal UTF-8 and a
fixed allowlist, preserves duplicate detection, and returns only an opaque
digest, coverage counters, and closed reason codes. Raw rows and rejected text
are never returned.

The reviewed snapshot subset is release-specific for the same pinned
Rotorflight 4.3-4.6 STM32F7X2 builds. It covers the selected PID and rate
profile indexes, all reviewed tuning-relevant active rate-profile rows
(excluding the privacy-bearing profile name), the collective axis omitted by
Blackbox, and the governor setting rows exposed by that release. Version 1
accepts only a sanitized CLI-derived snapshot. The reviewed MSP replies omit
required rate or governor settings in every supported release, so an MSP label
fails closed rather than implying equivalent coverage.

This is still **not a complete or flight-bound configuration fingerprint**.
Rotorflight does not put a configuration checksum, capture nonce, or other
proof in a `.bbl` that can bind a later pasted snapshot to the exact controller
state flown. Firmware, target, board, profile, and overlapping-setting matches
can show compatibility but cannot prove that an omitted collective or
governor value did not change between captures. Governor behaviour also has
transitive motor, gearing, RPM-source, power, and battery dependencies outside
this first supplement manifest. Stabilized collective also depends on the
mixer's `SC` input scale: Blackbox 4.4+ records only its minimum and maximum,
not its rate, while 4.3 records neither. Consequently every report remains
explicitly unbound, incomplete, cohort-ineligible, and advice-ineligible. It is not
accepted by the contribution contract or shadow model and has no UI, Android,
serial, network, or upload caller.

The next configuration step is an atomic local collection workflow (or a new
firmware protocol field) that can bind the sanitized controller state to the
ensuing log, followed by a source-pinned audit of the remaining transitive
configuration. Neither a file timestamp, paste order, board name, nor a user
assertion is sufficient evidence for that promotion.

### The offline configuration-pairing stop

Phase 2C adds one offline consistency check and stops there. It compares the
exact reviewed firmware identity, board, and common roll/pitch/yaw rate rows in
immutable opt-in Blackbox header evidence with a valid sanitized supplement.
For 4.4 and later it also compares `govPID` (P/I/D/F/gain), `yaw_tta`
(gain/limit), and `collectiveRange` (the `SC` minimum/maximum); 4.3 emits none
of those three anchors.
`matched` means only that this partial overlap is compatible. The session body
and in-flight configuration-change events are explicitly not checked, so every
result remains unproven, incomplete, cohort-ineligible, and advice-ineligible.
The module has no production caller and emits no raw or stable session hash.

Promotion requires a decoded-session check for configuration-change events and
a reviewed firmware-authored one-time nonce plus configuration commitment in
the ensuing Blackbox header. Until that evidence exists, matching header values
cannot prove that the supplement describes the exact state that was flown.

### The offline decoded-session integrity stop

Phase 2D adds the separate, offline
`inspectCommunityConfigSessionIntegrity(decodeResult, sessionIndex, byteLength)`
boundary. It accepts only a live result from RotorLens' decoder and only the six
source-reviewed Rotorflight 4.3-4.6 STM32F7X2 release pins on the two reviewed
boards. The inspector reads a decoder-owned, immutable evidence snapshot through
a private capability; mutable public session arrays and lookalike result objects
cannot supply or change that evidence. A session body is `clean` only after
explicit frame decoding reaches the validated `LOG_END` at the exact session end,
with no truncation, damage, rejected/resynchronized record, resource limit, or
inconsistent frame/event count. A logging-resume event marks continuity as
`gapped`; without a positive in-flight-adjustment event, that gap makes
configuration-change-event coverage unavailable.

The categorical result retains no session index, byte offset, firmware or board
identity, event payload, timestamp, or count. `not-observed` means only that no
event 13 was present in one clean continuous decoded body. It does **not** mean
that no controller setting changed before logging began, after it ended, through
another configuration path, or between the sanitized snapshot and the flight.
The body report is intentionally not combined with the Phase 2C header report:
the current log format supplies no nonce or commitment that could bind either
one to a separately acquired snapshot. Every outcome therefore remains
unproven, incomplete, cohort-ineligible, advice-ineligible, and model-ineligible.
There is no UI, Android, CLI, history, contract, model, network, or advice caller.

### The configuration-to-flight protocol stop

Phase 2E is **protocol-only**. The normative draft is
[`CONFIG_FLIGHT_BINDING_PROTOCOL.md`](CONFIG_FLIGHT_BINDING_PROTOCOL.md). It
defines a typed-row commitment over separately privacy-reviewed, non-sensitive
settings, a one-use RAM token, versioned `rl_binding_*` Blackbox headers, sticky
scoped-mutation generation, and a length-delimited terminal seal. It does not
add a firmware patch, collector, runtime inspector, production
identifier/caller, USB/MSP path, UI, Android behaviour, network path,
contract/model promotion, or eligibility change.

All six currently reviewed 4.3.0-4.6.0 release pins remain unbound. Work stops
until a new exact firmware commit has been source-reviewed and an independently
captured real log proves its header and terminal bytes. A synthetic writer alone
cannot cross that boundary, and even later protocol-bound evidence will remain
self-reported consistency rather than firmware attestation or anti-poisoning.

The implemented builder is local and intentionally narrow:

```text
npm run community:model -- contributions.json [--out shadow-model.json]
```

It accepts at most 10,000 already scrubbed contribution envelopes in one JSON
array. It refuses malformed records and, by default, a corpus that produces no
privacy-qualified cohort. With the production legal registries empty and schema
1 configuration coverage incomplete, no current non-empty draft corpus can
produce one; `--allow-empty` exists only for deterministic smoke tests. The
explicit prevalidated-fixture seam used by unit tests is not imported by this
command. It cannot read a `.bbl`, upload, sign, publish, recommend a gain, or
alter any gate. An output file is created only when it does not already exist.
Future use is limited to a curated corpus with adopted terms and complete
configuration provenance; client-formatted IDs alone do not prevent one
helicopter from impersonating five. Any untrusted ingestion phase needs
server-authenticated pseudonyms, rate and influence caps, replay protection,
quarantine, and human-reviewed promotion criteria.

A later transport phase would require:

1. ~~`shareableRecord()` beside `exportableRecord()`~~ — **BUILT**, in
   `src/analysis/flight-history.mjs`, with `shareableRecord`,
   `auditShareableRecord`, `newSharingId` and `isSharingId`. It sends nothing;
   it returns an object to its caller. Two clarifications this section did not
   fix, both decided in the code:
   - **`kind` does not carry the local value.** It carries
     `SHARED_RECORD_KIND` — `'rotorlens-shared-flight-record'` — so a shared
     record and a local one can never be mistaken for each other. With the local
     kind, `addFlightRecord` would happily store a shared record as an aircraft
     whose key is `undefined`, which can then never be named, found or forgotten.
   - **`recordId` is excluded, and it is the field most likely to be re-added by
     someone tidying.** The list in section 2 already omits it without saying so.
     It is `${aircraftKey}#${ordinal}` — the craft name inside a value that reads
     like an opaque handle, which is exactly the leak a review of field *names*
     passes over. The audit catches it three separate ways, one of them by value.
2. **PARTLY BUILT:** random per-aircraft `sharingId` generation and local storage
   exist beside history. The current lifecycle is for local saved records. A
   transport still needs stable identities for eligible unsaved flights and a
   separate deletion capability that survives local history cleanup.
3. **PARTLY BUILT:** the local consent and Shared measurements screens exist.
   They store the choice and local identity map; they do not show upload
   receipts or delete server records because no server exists. Transport terms,
   sent-record visibility, retry/queue state, and remote deletion remain a new
   reviewed feature.
4. The `INTERNET` permission and a narrow, cancelable outbound request path in
   the shell rather than in `src/`.
5. Every claim and test listed in section 7, changed in the same commit.
6. A receiving endpoint plus authentication, replay protection, validation,
   quarantine, deletion, audit receipts, quotas, and an operator review path.

**The built offline pieces spend nothing.** No permission, no transport, no
change to any claim in section 7. What they buy is a concrete, testable shape and
a private shadow calculation that can be reviewed rather than a paragraph.

---

## 10. The recommendation

**Proceed with the offline contract, corpus, and shadow harness now; add no
transport yet.** With three contributors a pooled model is worse than the local
one and networking would spend a permanent privacy claim without improving the
advice. The first milestone is a community candidate that proves safer and more
useful on aircraft excluded from its training data.

Two Phase 1 collection paths supply that proof without spending the claim:

- **Ask.** Post in the Rotorflight Discord asking for `.bbl` files with the field
  set and what the pilot changed. If nobody answers, no upload path would have
  helped. *The message to post is in section 12, and the tools that measure what
  comes back are in section 11 — both built.*
- **Manual contribution pack.** After the complete configuration extractor and
  adopted terms exist, build a separate no-network export of the audited
  community envelope plus a retained consent/licence receipt. The existing
  history export contains local identity fields and is not suitable for donation.
  A file the pilot deliberately hands over keeps the no-network claim intact and
  measures willingness before an automatic transport is proposed.

If the offline shadow result passes its gates and manual sharing proves that a
useful corpus can be sustained, automatic opt-in upload becomes the next
proposal. It remains a separate decision and commit; the chosen global-learning
goal does not make networking implicit.

---

## 11. The half that needed no permission, and is now built

Everything above waits on a transport. The first of the two cheap experiments
does not: pilots hand `.bbl` files to each other in Discord today, and a log
that arrives that way can be measured for detector coverage with no upload path,
no in-app consent flow and no change to the app. **That reporting half is built.**
It is not the licensed controlled-trial intake required by the community model.
Nothing in it touches the network, and the store claim in section 7 is untouched.

### `npm run corpus:report -- <file-or-directory>`

`tools/corpus-report.mjs` measures every session in every log it is given and
reports the four distributions this repository currently guesses at, each
labelled with the constant it bears on:

1. **hold segments per flight-axis** — `minimumComparisonHolds`
2. **peak commanded rate per axis** — `COMMAND_THRESHOLD_DPS`
3. **broadband high-frequency gyro RMS** — beside `ATTENTION_BAND_RMS_THRESHOLD_DPS`
4. **identical-gain null pairs per axis** — `holdErrorNoiseFloorDps`

It is robust by requirement rather than by manners. A donation may be truncated,
from unknown firmware, or not a log at all; every failure is named and stepped
over, and the run always says how much of what it was given it could read. A
batch tool that dies on file 7 of 60 reports a corpus a third the size and says
nothing about it.

**The report obeys section 2 one level further out.** A measurement of somebody
else's flight is a shared projection, so `craftName` and `aircraftKey` are
absent from it exactly as they are from the shared record — replaced by a
run-local `aircraft-1`, `aircraft-2` label that groups one machine's flights,
which the null pairs require, and identifies nobody. `CORPUS_FIELDS` documents
every reported field with its reason, `NEVER_REPORTED` lists what may not
appear, and `auditCorpusMeasurement` enforces both by inspection — on the way
out of the CLI, not only under `npm test`, because the artefact being guarded is
the one that gets sent to a person.

### What the first run says

Both reference dumps plus the reference flight — 110 sessions, 31 of which flew,
31.1 airborne minutes, 3 aircraft:

| Measurement | Result |
| --- | --- |
| Hold segments per flight-axis | 0 in 47% of cases, 1 in 33%, **maximum 4**, and **0 of 93 flight-axes reach the 5 the gate needs** |
| Peak roll command | median 33 °/s, p75 56, max 197. 7 of 31 flights reach 80 |
| Peak pitch command | median 26 °/s, max 140. 4 of 31 reach 80 |
| Peak yaw command | median 119 °/s, max 289. 18 of 31 reach 80 |
| Broadband gyro RMS, filtered | never once reaches 8 °/s on any axis — 0 of 31 flights on all three (roll max 2.38) |
| Broadband gyro RMS, unfiltered | roll median 7.88, max 12.66 — **15 of 31 flights at or above 8**; pitch 6 of 31; yaw 0 of 31 |
| Null pairs | roll 0.915 °/s p90 (n=5), pitch 1.390 (n=4), yaw 0.0966 (n=18) |

The last row reproduces the figures quoted in `src/analysis/flight-history.mjs`
to four decimal places, from an independent path — which is the evidence that
the tool measures what those comments claim, rather than a second opinion that
happens to agree.

Two things in that table are worth naming rather than leaving in a cell:

- **The gate as originally shipped could not open.** Not one flight-axis in 93
  reached five holds — a property of a corpus rather than of a comment, and the
  number that drove the 17 August 2026 rederivation of `minimumComparisonHolds`
  to 3 per side (per-axis power arithmetic against the per-axis floors; see
  `src/analysis/pid-evidence.mjs`), which observed flight-axes can reach.
- **31 flights, not 33.** `src/analysis/records.mjs` says 33, from a hand-rolled
  classifier — "rotor above 1000 rpm for more than 20 s AND the sticks moved".
  This tool uses the shipped `checkFlightAdmissible` instead, and it admits two
  fewer. Neither is wrong; they are different questions, and any figure quoted
  from either should say which.

The broadband rows are not the attention gate. That threshold is a **narrowband**
band RMS around a detected peak; broadband RMS is larger by construction, so the
table brackets the threshold and cannot calibrate it. The report says so wherever
the number appears.

### `npm run check:donation -- <file-or-directory>`

The decoder never emits a coordinate. A donated **file** still contains one, and
a `.bbl` committed to this repository is the file rather than the reading of it —
somebody's home coordinate, in the open, in a public git history, forever.
`docs/FIXTURE_POLICY.md` already forbids that; `tools/check-donation.mjs` makes
it answerable by a command instead of remembered by a person.

It refuses on the **presence of a recorded position frame**, counted by frame
type, never on a coordinate's value — deciding "these coordinates look harmless"
would mean surfacing coordinates in order to clear a log of carrying them. It
also refuses when it cannot prove absence: an unreadable header, a stream it
could not follow to the end, a file that is not a log. A location check that
passes because it could not look is worse than no check.

On the reference flight it reads: **688 position frames (675 GPS, 13 home) —
REFUSED.**

---

## 12. The ask

Short enough that somebody reads it. Post as-is.

> **Anyone willing to send me a Rotorflight blackbox log? (~2 minutes)**
>
> I'm building a log analyser for helis, and I've hit a wall one pilot cannot get
> past on his own: several of the thresholds it judges an aircraft against are
> calibrated on **two helicopters — both mine**. One of them has never once
> fired on real data. More machines is the only thing that fixes that.
>
> **What would help:** one or more `.bbl` files, and four lines with them —
>
> - what the aircraft is (size, blades, electric or nitro);
> - what headspeed you fly;
> - what you changed since the flight before, if anything. **"Nothing" is
>   genuinely useful** — two unremarkable flights with nothing changed are how
>   the noise floor gets measured, and I need those more than I need good ones;
> - whether **`gyroRAW`** was in the Blackbox field set. If it was not, the log
>   cannot tell your airframe apart from your filter chain, and half of what I am
>   trying to measure is not in it. One checkbox in the configurator.
>
> Hovering and circuits are fine. It does not need to be tidy flying.
>
> **What it is used for:** working out what normal looks like across many
> helicopters, so thresholds this app judges an aircraft against stop being
> guesses taken from my two.
>
> **What will never be published:** your log. Nothing goes in the repository, the
> app, or anywhere public. A `.bbl` can contain the GPS coordinates of where you
> flew — often your garden — so I run every donated file through a check that
> refuses to let anything carrying a position be committed, and I would not
> commit yours anyway without asking you first, in writing, for that specific
> file. What comes out is numbers: hold counts, tracking error, headspeed,
> vibration. Not your craft name, not a date, not a filename, and never a
> coordinate.
>
> Happy to send you back what your own log measured.

Three things that wording is doing deliberately, since somebody will want to
change it later:

- **It asks for the boring flights explicitly.** The natural instinct is to send
  your best flight, and the corpus needs the pairs where nothing happened.
- **It says what will never be published before anybody asks.** A donor who has
  to ask is a donor who has already decided you had not thought about it.
- **It does not ask for a licence.** This is a request for logs to measure
  locally, not a contribution to a corpus that improves a distributed product. The
  moment anything derived from a donation is shipped, section 4a applies and the
  grant has to be asked for in those words — a `.bbl` sent to a stranger in a
  chat window is not a licence to build a product on it.
