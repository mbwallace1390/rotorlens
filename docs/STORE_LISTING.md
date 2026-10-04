# Store listing copy

The text that goes in the Google Play and App Store descriptions. Kept here so
it is reviewed, versioned, and checkable against what the app actually says —
`test/legal-disclaimer.test.mjs` fails if this file and the in-app disclaimer
stop agreeing on any of the load-bearing claims.

Two copies of a promise drift. The copy that drifts is the one somebody reads
back to you.

## Why this file exists at all

Until 2026-08-12 RotorLens reported measurements and never instructions, and a
listing that said "plots your flight" was accurate. The owner reversed that:
the app now tells a pilot what to adjust on a machine with spinning blades.
"Advisory, based on your log, one change at a time" is a materially different
promise, and the listing, the screenshots and the first-run copy have to agree
with each other before it goes live.

## The disclaimer, for the store description

Goes at the end of the description, on both stores, verbatim.

> **Important**
>
> RotorLens analyses flight log data and suggests tuning changes. Suggestions
> are informational only and are based solely on the log you provide. You are
> responsible for your aircraft, its airworthiness, and every setting you apply.
>
> RotorLens never connects to or writes to a flight controller. All changes are
> made by you, in your own configurator.
>
> If you save a flight, RotorLens keeps a small set of numbers about it on your
> device so it can tell you next time whether a change helped. Answering the
> optional future-sharing question also stores your answer; turning it on creates
> a random 100-bit local identity for each saved helicopter. This release cannot send
> anything. It never keeps your log, your position, or the flight date, and the
> Flight history and Shared measurements panels let you inspect and erase what
> they store.
>
> Vibration and tracking findings indicate where to look. They are not a
> substitute for physically inspecting your helicopter. Always ground-check
> after any change, and increase inputs gradually.
>
> Model helicopters can cause serious injury. Fly within your ability, at a
> permitted site, following local law and manufacturer guidance.
>
> RotorLens is an independent product. It is not affiliated with, endorsed by,
> or sponsored by the Rotorflight or Betaflight projects, or by any transmitter
> or flight-controller manufacturer. Product names are trademarks of their
> respective owners.

## What the app itself guarantees

Worth stating separately from the disclaimer, because these are not comfort —
they are enforced, and each has something that fails the build if it stops
being true.

| Claim | What keeps it true |
| --- | --- |
| No connection to your aircraft | There is no flight-controller communication code, and the app requests no sensitive platform permission |
| Nothing leaves your phone | The shared app contains no upload transport and makes no network requests, and the viewer page carries a Content-Security-Policy that refuses any connection off its own origin. Android also omits the `INTERNET` permission; a tapped About & Legal link is handed to the phone's own browser, only for the fixed legal addresses. An iOS listing may use this claim only after source, WebView-policy, and on-device network verification |
| Every suggestion shows its measurements | Each finding carries `basis[]`, and a test requires it non-empty |
| One change at a time | At most one recommendation is rendered as a change to make now |
| Silent when it cannot tell | Five gates, plus a stability sweep that refuses any conclusion whose direction flips as the unconstrained constants move |
| It says when the airframe is not excluded | Every oscillation-based gain verdict carries the ambiguity note |

The no-network claim is the strongest of these and the most unusual. For logs
that can carry GPS home coordinates — a pilot's back garden — Android's missing
`INTERNET` permission is a stronger promise than any privacy policy because it
is an operating-system property of the binary rather than an intention. iOS has
no equivalent permission, so the Apple listing must not make the claim until the
source, WebView policy and a real device have independently proved the same
outcome. Keep both gates prominent, and do not trade either away for a cloud
feature without deciding deliberately that the claim is being given up. See
`docs/LOG_IMPORT.md`, which reaches the same conclusion from the other direction.

## Trademark

Not optional, and not merely polite. `docs/LICENSING_AND_STORE_READINESS.md`
covers it in full: the app is **RotorLens**, never "Rotorflight anything". The
Rotorflight name is used only descriptively — to say which logs RotorLens reads,
how to get them off the aircraft, and where RotorLens stands apart from the
Rotorflight project — never as part of RotorLens's own name or to suggest
endorsement. The Betaflight name appears only in the non-affiliation statement.

Compatibility wording follows section 8 of that document: name only versions a
real log has verified. Listing copy may say RotorLens reads **Rotorflight 4.6**
Blackbox logs. If it mentions the wider range the decoder accepts, it must carry
the qualifier in the same sentence — "accepts Rotorflight 4.3 to 4.6; verified on
real 4.6 logs only" — because this project has decoded no firmware-written 4.3,
4.4 or 4.5 log. It must never state 4.3 to 4.6 unqualified, and must not claim
Betaflight or any other firmware: the decoder refuses them. A store listing using
those names without the non-affiliation statement invites a takedown rather than
an email.

## If measurements are ever shared

`docs/SHARED_CORPUS_DESIGN.md` sets out what it would take to pool anonymous
measurements across pilots, and what it costs. The local consent, privacy-filtered
record projection, random aircraft identity, preview, and erase controls exist;
the server and upload transport do not; Android also omits the `INTERNET`
permission. The line above —
"RotorLens never connects to or writes to a flight controller" — is unaffected
either way, but "nothing leaves your phone" would cease to be true. Read that
document and revise the policy and store declarations before adding transport.

## Still the owner's to decide

- **Screenshots.** They are part of the claim. A screenshot showing a gain
  recommendation sets an expectation the app must meet on the reviewer's own
  log, and most real logs produce no gain recommendation at all. Re-measured on
  3 October 2026 with the current engine, across 110 real sessions, all
  Rotorflight 4.6 — logged under three craft-name-and-board combinations on two
  board models, which `corpus:report` counts as three aircraft; 31 of the
  sessions were flights, the rest bench runs: **zero** roll or pitch stop events, nine yaw stops spread
  over six sessions, and **not one gain adjustment of any kind** — no D, no P,
  no I. A screenshot of the axis view and the manoeuvre brief is both honest and
  more representative.

  (An earlier draft said "109 flights yielded one cyclic stop". Two independent
  counts put cyclic stops at zero; the sentence's conclusion gets stronger, not
  weaker, but the number was not reproducible and is corrected here.)
- **Whether the disclaimer also appears on first run**, rather than only on the
  Legal screen. It is reachable today; it is not forced.
- **Whether a lawyer reviews it.** `docs/LICENSING_AND_STORE_READINESS.md`
  already calls for an IP review. An app giving tuning advice for a bladed
  machine is the same conversation, and this is not legal advice.
