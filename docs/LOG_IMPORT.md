# Getting logs into RotorLens

The analysis is worthless if the log never arrives, and today getting a log off a
Rotorflight helicopter requires a different app. This records what that costs,
what the shell does about it, and whether it can ever be removed.

## The flow today

1. Connect the flight controller to the phone or computer by USB.
2. Open the **Rotorflight configurator or tuning app** and connect to the board.
3. Go to the **Blackbox** tab, tap **Activate mass storage device mode**.
4. The controller reboots and reappears as a USB drive — and Android offers to
   open RotorLens, because the app declares a `USB_DEVICE_ATTACHED` filter
   matching the mass-storage device class. Ticking "always" makes that automatic.
5. Pick the `.bbl` file.
6. **Turn mass storage mode off again before unplugging**, or eject the volume
   from the storage notification.

Step 6 is not housekeeping. Pulling the cable while the volume is mounted makes
Android warn that a device was removed unsafely and suggest a restart, which is
alarming and unnecessary. Measured on 2026-08-13 while chasing exactly that
warning: RotorLens held **zero** file descriptors on the volume — every open fd
was its own APK, WebView internals or its own data directory — so the app is not
holding the drive. It is the ordinary consequence of an unmounted removal, and
the import panel now says so, because the app that explains the sequence is the
only thing the pilot has in front of them.

Step 4 used to mean leaving the configurator, finding RotorLens and opening it
by hand. What it costs is written in the manifest beside the filter: the app now
holds permission to talk to that USB device, and `test/provenance.test.mjs`
asserts that no code capable of doing so exists in the binary. The claim stays
structural rather than becoming a promise.

Steps 2–4 are somebody else's app. RotorLens cannot start the flight at step 1 or
finish it at step 5 without the user leaving and coming back.

This is a real product cost, and it should be treated as one:

- It is the single biggest source of first-run failure. A user who does not
  already know this sequence will open RotorLens, find nothing to open, and
  conclude the app is broken.
- It is why the import screen explains the sequence inline rather than hiding it
  in a help page. Being the app that *tells* you how to get your log is cheap and
  worth more than pretending the step does not exist.

## What the shell does about it

- **Explain, in place.** The import panel carries the five steps, the last being
  to turn mass storage off before unplugging, so the app is useful before it has
  a file.
- **Accept the log from anywhere.** File picker, drag and drop, and — on a phone
  — the system share sheet and document picker, so a log copied to local storage
  or shared from a file manager lands directly in RotorLens. On Android, "Open
  with" offers RotorLens in two ways:
  - **By name**, for `.bbl`, `.bfl`, `.txt` and `.log` in either case, with or
    without a MIME type on the intent. Android 12+ matches the real end of the
    path; Android 8–11 match a path with up to four dots in it, the extension's
    included, and a path with more can still be shared in or picked.
  - **By type**, for a `content:` URI typed `application/octet-stream`, whatever
    its path. Samsung My Files opens a file as a `content://media/...` id with no
    name or extension in it, so the by-name match can never see it; it types a
    `.bbl` as octet-stream (seen on a Galaxy Fold, Android 17, 3 October 2026).
    Text files are deliberately *not* matched by type,
    or RotorLens would be offered for every text file on the phone; a `.TXT` log
    from such a provider is shared in or picked from the app instead.

  Share accepts `application/octet-stream` and `text/plain`.
- **Say something useful when the file is wrong.** A file with no Blackbox
  session gets an explanation, not a blank screen. A log from firmware the
  decoder does not open — anything outside Rotorflight 4.3 to 4.6 — is named as
  that, with the range it does open, rather than as a damaged header.

- **Report progress, because the copy is slow.** Measured on a real board:
  85,538,816 bytes at **784 KiB/s over 106 seconds**, then 36 sessions decoded
  in 5.4 s, peak RSS 241 MB. The shell emits `rotorlens-import-started` and
  `rotorlens-import-progress` so the page can say so — 219 progress events on
  that copy, monotonic, with the total reported exactly, and `rotorlens-file`
  4 ms after the last one.

  `PROGRESS_INTERVAL_MS` is a floor, not a period: the observed median gap was
  489 ms, roughly twice it. Anything wanting a rate or a time-remaining must
  measure the gaps it receives rather than assume 200 ms.

**Already built**, and this file said otherwise until 2026-08-13: the Android
`VIEW`/`SEND` intent filters ship, and were confirmed on a real handset —
mass-storage drive mounted, `.bbl` tapped in a file manager, 3 MB decoded in
224 ms with no copy step. It was listed here as "not yet built" for as long as
it had been working.

**Also built since**, and this file listed both as not yet built until
2026-10-03:

- **The page side of import progress.** `ui/app.mjs` listens for both native
  events (see the contract in `MainActivity.notifyImportStarted`) and draws a
  bar after the first 300 ms. When `total` is -1, which is normal when the
  provider will not say, it shows the byte count copied so far rather than a
  fabricated percentage.
- **Something during the decode.** The page paints "Decoding…" and yields before
  the call, and no longer decodes the whole file at once: it reads every
  session's header block first (50–70 ms for all 73 headers of a 125 MiB dump,
  measured in Node on 3 October 2026) and a session's frames only when that
  session is opened, announcing each blocking step before it runs. One large
  session still blocks the thread while its frames are read. A Web Worker
  remains the real answer for that and needs the memory ceiling measured first —
  RSS peaked at 239 MB decoding a 128 MB log whole, against Android caps
  commonly 192–256 MB, and a worker handoff that copies rather than transfers
  doubles it.

Not yet built, and worth building in this order:

1. **Recent logs list**, so a re-analysis needs no import at all. Now the most
   valuable item here: advice is iterative — change one gain, re-fly, compare —
   and the comparison engine already exists.
2. **Remember the last folder** so repeat imports are one tap.
3. **iOS share extension**, the same idea through the share sheet. The
   experimental iOS scaffold already declares `.bbl`/`.bfl`/`.txt`/`.log` as
   document types it can open from Files; none of it has been run on a device
   yet (see `docs/IOS_PORT.md`).

**Check the wording against the configurator's actual button.** The import panel
tells the user to tap "Activate mass storage device mode". If that app renames
it, our instruction becomes the first-run failure it was written to prevent, and
nothing in this repository can notice.

## Can the other app be cut out entirely?

Maybe, on Android, for some flight controllers. Not on iOS. The honest answer
depends on where the log is stored, and these paths have **not been verified** —
they are the shape of an investigation, not a plan of record.

Measured on 2026-08-13, on the owner's own hardware: **both his flight
controllers log to onboard dataflash and neither has a removable card.** So the
card-reader escape below does not apply to him, and the configurator is on the
critical path for every log he will ever open.

### Two storage types, two very different problems

- **Onboard dataflash chip.** The configurator downloads these over the existing
  MSP serial link — the same link it already uses for everything else. If that
  holds, RotorLens could pull a log over USB serial with no mass-storage step at
  all: connect, list, download. This is the promising path and the one to
  investigate first.
- **SD card.** Mass storage exists because there is a filesystem involved.
  Replacing that step means implementing USB Mass Storage transport and reading
  FAT ourselves — a much larger undertaking. Reading the card in a USB card
  reader is the cheaper answer, and it already works today.

### Platform reality

- **Android** can do this. USB host access is available to ordinary apps: claim
  the interface, talk serial, no root. MSP is a protocol, and implementing a
  protocol from its specification is ordinary interoperability work — the same
  reasoning that makes our own Blackbox decoder legitimate.
- **iOS** cannot. USB accessory access to arbitrary hardware is restricted, so
  the import path there will always be the Files app or the share sheet. Any
  design that assumes direct download must degrade gracefully to file import, and
  file import must stay the primary path rather than a fallback nobody polished.

### Before building any of it

Verify, in this order, and stop at the first no:

1. Does the target flight controller log to dataflash or SD? Both exist in the
   field, and the answer decides everything downstream.
2. Can we open the board over USB serial from Android and complete an MSP
   handshake at all?
3. Can a dataflash log actually be read over that link, at a tolerable speed for
   a log worth analysing?
4. What happens on a board that is armed, or mid-flight, or has no log? Talking
   to a flight controller is not read-only by nature, and this is a machine with
   spinning blades — a bug here has consequences a log viewer bug does not.

Point 4 is the one to hold on to. RotorLens reads logs. The moment it opens a
link to a flight controller it becomes something that could, in principle, write
to one. If that link is ever built, it must be read-only by construction, not
read-only by intention — see the safety boundary in
`docs/ARCHITECTURE_AND_PROVENANCE.md`.

**And it now costs a published claim.** The store listing and the in-app
disclaimer both say RotorLens *never connects to or writes to a flight
controller* — see `docs/STORE_LISTING.md`, where a test pins the sentence to the
manifest. MSP is bidirectional: a log cannot be downloaded without sending
commands to the board, so a download feature gives that claim up. Note also that
USB host is a `<uses-feature>`, not a `<uses-permission>`, and device access is
granted by a per-device system dialog — so "the app requests no sensitive
platform permission" could stay technically true while the app talks to the
aircraft. That is exactly the kind of technically-true statement that makes a
safety claim rot; if this is ever built, the manifest test is not the thing to
check.

What would earn the claim back is absence rather than intent: no encoder for any
`MSP_SET_*` command anywhere in the codebase, with a test asserting the command
allowlist, so writing to a helicopter is not forbidden by policy but missing from
the binary.

The friction being bought out is two taps in an app the user already has
installed, because they needed it to set the helicopter up. The genuine
first-run failure is not the taps — it is not knowing the sequence, and the
import panel already fixes that.

## Privacy

Whatever path a log arrives by, it stays on the device. Nothing in the shell
uploads a log, and there is no network call in the analysis or the viewer. That
is a genuine selling point against a cloud analyser, and it is much easier to
keep than to regain — do not add a "just upload it for better analysis" feature
without deciding, deliberately, that the claim is being given up.
