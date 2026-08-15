# RotorLens privacy policy

**Effective 11 August 2026. Revised 15 August 2026** to distinguish the privacy
protections supplied by each platform — see **Changes** at the end. This is the
canonical text. The hosted copy at the URL given to the app stores is generated
from this file, and the two must not drift — see
`docs/STORE_PRIVACY_ANSWERS.md`.

## The short version

**RotorLens collects nothing.** It has no account, no analytics, no advertising,
no crash reporting, no upload transport, and makes no network requests. Your
flight logs are read on your device, and they stay there.

RotorLens can remember a short summary of a flight so that a later flight can be
compared against it. That summary is a few dozen numbers. It never includes the
log, never includes a position, never leaves the device, and you can read it,
export it, and delete it from inside the app.

If you answer the optional shared-measurements question, RotorLens remembers your
answer. If you turn sharing on, it also creates a random local identity for each
saved helicopter. That identity is not an account, device ID, advertising ID, or
identity for you. There is no sharing transport in this version, so neither the
answer nor an identity leaves the device. Both can be erased in the app.

This is enforced differently on each platform. The Android app does not request
the `INTERNET` permission, so Android will not let it open a network connection
even if it tried. iOS has no equivalent permission switch; an iOS release must
instead pass source, WebView-policy, and on-device network verification before
this policy may be used for that build. The iOS shell is currently experimental,
not a shipping release. Both platform shells request no sensitive platform
permission.

## What the app handles

A Blackbox flight log that you choose to open. You provide it deliberately —
through the system file picker, by opening a `.bbl` file, or by sharing one into
RotorLens. The app never goes looking for files on its own.

**A flight log can contain location data.** Blackbox logs from a flight
controller with GPS carry position frames, and often a home coordinate — which is
usually where you were standing, and may be where you live. RotorLens tells you
when a log declares location fields, so the fact is visible rather than assumed.
That data is processed on your device like every other field, and is not sent
anywhere, because nothing is sent anywhere.

## What is stored, and for how long

Three categories, with different lifetimes: the temporary copy of the log you
opened; flight summaries you explicitly save; and the sharing preference and
random aircraft identities created when you answer the optional sharing question.
The last two categories persist between uses until you erase them.

## The copy of the log you opened

When you open a log, RotorLens copies it into its own private cache. This is
necessary rather than optional: the permission granted by a share expires, often
before you have finished looking at the flight.

- **One log at a time.** Opening another deletes the previous copy.
- **Deleted when the app closes.** The copy is removed when the viewer is
  finished with it.
- **Deleted at next start regardless.** An app can be killed without warning by
  the system, which would otherwise leave the last flight in the cache. RotorLens
  clears that directory when it starts, so a log does not outlive the session
  that opened it even if the app never got the chance to tidy up.

## The flight history

RotorLens can tell you whether a change you made to your helicopter's tuning
actually helped. Answering that needs something remembered from the flight before
it, so when you choose to save a flight, RotorLens writes a short summary of it
into a single file in the app's own private storage.

**It is a summary, not a log.** Around 4.4 kilobytes of numbers per flight —
roughly a page of them. The log itself is not part of it, and cannot be
reconstructed from it.

## What the flight history contains

| | Why it is there |
| --- | --- |
| The craft name and board name from the log's header | to tell one of your helicopters from another, so two are never compared with each other |
| A counter — first flight, second flight, and so on | to know which flight came first. It replaces a date; see below |
| The firmware version string | so a comparison across a firmware update can be refused rather than misread |
| The nine PID gains, and the rest of each PID line | this is **what changed**, which is the entire point of the comparison |
| The rate-curve settings, as one short string | a change to them invalidates a comparison, so it is checked for |
| How long the flight was, and how it was detected | to keep ground runs out of the history |
| Per axis: hold, stop, vibration and headspeed measurements | the measurements the comparison is made from |

## What the flight history never contains

This list is enforced in the code, not just promised here: the file is written
from a fixed list of permitted fields, and a test rejects anything outside it.

| Never stored | Why |
| --- | --- |
| The flight log, or any part of it | keeping the source would make deleting the summary meaningless |
| GPS coordinates, or a home position | a home coordinate is usually where you were standing, and may be where you live |
| Satellite count, ground speed, altitude | not coordinates, but a series of them still describes where and how high you flew |
| **The date or time of the flight** | a list of them is a record of when you fly, which is behaviour rather than tuning. A counter orders the flights instead, and we checked that using the date would not have made the comparison any better |
| The name or path of the file you opened | that is a path into your own storage, and often a folder you named |
| Raw samples, traces, or graphs | a trace is the log again in another shape |
| Anything that never left the ground | a bench run is not a flight and does not belong in a flight history |

## What RotorLens works out from the flight history

RotorLens shows you what your saved flights add up to, gain by gain: how many it
can use, what it would take to teach it more, and — where enough flights have
earned it — an amount fitted to them. That display **stores nothing of its own.**
It is worked out from the flights listed in the same panel, every time the panel
is drawn, and then thrown away.

This is a deliberate choice and it is the one that matters for deletion. No
derived tuning model is fitted, cached, or written down, so there is no second
copy to delete and no way for something learned from a flight to survive that
flight being forgotten.
Delete a flight and what it contributed is gone with it, on the same tap. Delete
everything and there is nothing left to have learned from.

The table above is therefore the complete list of what is kept in the **flight
history**. The separate sharing file is described next.

## The sharing preference and random aircraft identities

After RotorLens has enough information to analyse a flight, it may ask whether
you want to contribute small, privacy-filtered measurements in a future version.
Answering either **Share** or **Not now** stores a separate `sharing.json` file in
the app's private storage so the same question is not shown every time. This can
happen before you save a flight.

That file contains:

- whether the question has been answered and whether sharing is enabled;
- while sharing is enabled, the version of the consent wording accepted (the
  field is `null` after **Not now** or after sharing is turned off);
- a random 100-bit identity created for each saved helicopter while sharing is
  enabled; and
- the local aircraft key used to associate each random identity with its flight
  history. That key is a lower-case form of the craft name and board model already
  present in the saved flight summary. It never enters a shared record.

Turning sharing off does not erase an aircraft key or its random identity. Those
mappings remain local so the same helicopter keeps the same identity if sharing
is enabled again. They remain until you use **Erase identity**, **Forget
helicopter**, or **Forget everything**. Uninstalling the app also removes them;
on Android, **Clear storage** does too.

The random identity identifies one helicopter's records to RotorLens. It is not
derived from the craft name, phone, advertising ID, account, email address, or
anything about you. This version has no server or upload transport, so the
preference and identities remain local even when sharing is enabled. On Android,
the missing `INTERNET` permission is an additional operating-system barrier. The
Sharing panel shows the state and can erase the identities and preference.
**Forget everything** erases this file as well as the flight history.

## How long the flight history is kept

- **Until you delete it.** Unlike the log copy above, the history is meant to
  outlive the session — that is what makes a comparison possible at all.
- **At most 200 flights per helicopter.** The oldest is dropped after that, so
  the file cannot grow into a record of every flight you have ever made.
- **You can see all of it.** The history screen shows every stored flight, and
  **Export** shows the whole history as plain text you can read yourself. It is
  displayed on screen; RotorLens writes no file and sends it nowhere.
- **You can delete any of it.** Forget one flight, forget one helicopter, or
  forget everything. Forgetting everything removes the counters too, so nothing
  is left behind — not even a count of how many times you flew.
- Uninstalling the app removes it as well; on Android, **Clear storage** does too.

Nothing else is stored. There are no accounts, email fields, device or advertising
IDs, cookies, or browser storage of any kind — no `localStorage`, no `IndexedDB`,
no web databases. A craft name is text the pilot configured on the flight
controller and could itself contain a name or callsign; RotorLens does not infer
or sanitize its meaning, and keeps it only in the local files described above.
The flight history and sharing preference are ordinary files the native app owns.

## What is not collected

To be explicit, because "we do not collect" is a sentence readers have learned to
distrust:

| | |
| --- | --- |
| Accounts or email | none — the app has no account system. A user-configured craft name may contain personal text, but remains local and is never transmitted |
| Device, advertising, account, or personal identifiers | none. The random local aircraft identity described above groups one helicopter only and is never transmitted |
| Location | never requested; location inside a log stays on the device, and never reaches the flight history |
| Usage analytics, telemetry, crash reports | none |
| Advertising or tracking SDKs | none |
| Contacts, photos, microphone, camera | never requested |

## Who your data is shared with

Nobody. There is no server, no third-party service, and no transmission of any
kind, so there is nothing to share, sell, or disclose.

## Third-party components

The app bundles open-source libraries from the Android Open Source Project,
JetBrains, and Google, listed in full on the app's **Legal** screen. They are
software components inside the app, not services: none of them contacts a network
on RotorLens' behalf, and the absence of the `INTERNET` permission would prevent
it if one tried.

## Your rights

GDPR and CCPA give you rights over personal data a company holds about you —
access, correction, deletion, portability, and the right to object. **We hold
none of it.** There is no server, no account, and no copy of anything of yours
anywhere but your own phone, so there is nothing for us to look up, hand over, or
erase on your behalf.

The flight history and sharing preference do not change that, and it is worth
saying why. They live on your device, under your control, and the app gives you
the same rights over them directly rather than through us:

- **Access** — the history screen shows every stored flight in full.
- **Portability** — **Export** shows the whole history as plain text on screen,
  which you can copy. RotorLens writes no export file.
- **Deletion** — forget one flight, one helicopter, or everything. There is no
  copy elsewhere to survive it.
- **Sharing identity control** — the Sharing panel can erase its local identities
  and preference without deleting flight history; Forget everything removes both.

If you are in the EU or UK, note that this means there is no controller holding
your data and no international transfer, because the data never leaves your
device.

## Children

RotorLens is a tool for analysing radio-controlled helicopter flight logs. It is
not directed at children, and since it collects nothing, it collects nothing from
anyone of any age.

## Changes

If a future version of RotorLens ever collects, transmits, or stores anything
beyond what is described here, this policy will be updated **before** that
version is released, and the store listings' data declarations will be updated
with it. On Android, network transmission would additionally require adding a
permission the app has deliberately never had. An iOS release must independently
prove the same no-transmission outcome because iOS has no equivalent permission.

**15 August 2026 — platform-specific network protection.** The policy now
distinguishes the shared no-upload implementation from Android's stronger
operating-system `INTERNET` permission barrier. It does not extend the policy to
the experimental iOS shell; that shell must pass its own source, WebView-policy,
and on-device network gates before release.

**14 August 2026 — the sharing preference and aircraft identities.** The app
already persisted a consent answer, consent-text version and random identity per
helicopter before it had any transport capable of using them. This revision
describes that second local file explicitly, including that answering **Not now**
can create it before a flight is saved. The store privacy answer remains “data not
collected” because nothing is transmitted, but the previous claims that flight
history was the only persistent file and that no identifiers existed were
incorrect and have been removed.

**13 August 2026 — the flight history.** This is that rule being followed rather
than an exception to it. The *flight history* section above was written before
the version that stores anything, so the description is in place first. Nothing
about it changes the claim the rest of this policy rests on: the app still has no
`INTERNET` permission and still cannot transmit anything anywhere. The store
declarations are unchanged, and remain "no data collected", because both stores
define collection as data leaving the device.

**13 August 2026 — what RotorLens works out from the history.** The app now
shows what your saved flights add up to, gain by gain, and will fit an amount to
them where they support one. **Nothing was added to what is stored.** The model
is derived from the flights already described above and kept only for as long as
it is on screen, which is why it appears in this policy as a section about
deletion rather than as a new row in the table of what is kept — delete a flight
and the model is rebuilt without it on the spot. The size figure in
*The flight history* was also corrected, from
about 2.5 kB a flight to about 4.4 kB: the smaller figure is the summary in its
compact form, and the file as actually written on the device is indented text.

## Contact

Questions about this policy: **mbwallace1390@gmail.com**

RotorLens is an independent project. It is not affiliated with, endorsed by, or
sponsored by the Rotorflight or Betaflight projects.
