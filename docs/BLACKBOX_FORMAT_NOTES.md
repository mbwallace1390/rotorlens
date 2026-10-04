# Blackbox format notes and decoder assumptions

Working notes for `src/blackbox/`. Its purpose is to make our assumptions
*checkable*: everything below is either verified, or explicitly marked as an
assumption with the test that will settle it.

Read this before changing the decoder, and update it when a real log confirms or
refutes something.

## Why this file exists

A log format is a set of interoperability facts — header keys, encoding
identifiers, frame markers — and implementing one from those facts is ordinary
engineering. What is not fine is copying somebody's implementation. Writing the
assumptions down here keeps the distinction visible: this decoder was built by
reasoning about a byte layout and testing it, not by reading GPL source.

## Verification status

**Verified by round-trip** (`test/blackbox-encodings.test.mjs`,
`test/blackbox-decode.test.mjs`): every encoding and predictor listed below
encodes and decodes back to identical values, exercised over 10,032 frames × 34
fields of generated flight data, plus edge-value unit tests. Read what that does
*not* buy before relying on it — the writer and the reader share every layout
assumption, so a round-trip agreeing with itself is not evidence about the format.

**Verified against real firmware output on 2026-08-11.** A real Rotorflight
4.6.0 log (`Rotorflight 4.6.0 (118e912) STM32F7X2`, board `FRSK VANTAC_RF007`,
8.6 MB, 89 fields) decodes to **134,429 samples with zero errors through the body
of the log**, a median sample interval of 993 µs with **no outliers at all**, and
monotonic time and loop iteration throughout. The capture stops part-way through
its last frame — a power-off artefact, not a decoding fault: 13 bytes of a P
frame (30 of its 89 fields, carrying the same 994 µs and 2-iteration step as the
frame before it), then 512 bytes of erased flash (0xFF) to the end of the file.
Since 2026-10-03 that tail is reported as `truncated` with no resync; until then
the cut frame's varint ran into the 0xFF run and surfaced as one `corrupt-frame`
plus 525 resync bytes, which the integrity judgment counted as damage in the
body of the log. See [Erased flash after a cut frame](#deliberate-decoder-behaviors).

**That paragraph used to end here, and it was wrong.** Holding sync proves
alignment, not correctness — see the TAG8_4S16 section below. Two encodings and a
predictor were decoding real flights into sawteeth while every check above passed
perfectly.

**Verified again on 2026-08-12, this time for continuity.** The same log now
also passes an I-frame-phase continuity check (described below). Correcting
TAG2_3S32 selector 3 and the INCREMENT step brought the worst-behaved field on
the real log from **33x** down to **1.16x**, against a threshold of 2x.
Re-run on 2026-10-03: `verify:log` 13/13, worst field 1.16x over 4,200
keyframes.

**Three files this section used to count as cross-implementation agreement are
not firmware output.** They were described as logs from an independently
written Rotorflight encoder (`Blackbox Lab`, Rotorflight 4.4 format) that "also
decode clean". Their headers name a simulator board and a firmware revision
marked synthetic, and they carry no `Field I signed` line, which real firmware
writes. The shipped decoder refuses all three — `corrupt-header` for the missing
signed flags and, with that line supplied, `unsupported-firmware` for a revision
outside the accepted pattern — so each decodes to zero samples. They are not
Rotorflight 4.4 evidence and provide no cross-implementation agreement today.
Figures further down that were taken on them say so. (Even when they were read,
all six of their TAG2_3S32 selector-3 groups had equal outer widths and a P
interval of 1, so both 2026-08-12 fixes were byte-for-byte no-ops on them.)

**One slot layout is still undetermined, and it is not vague — it is exactly
one.** TAG2_3S32 selector 3's field-0/field-1 width slots are degenerate: swapping
them decodes the reference 4.6 log to bit-identical samples and passes
`verify:log` 13/13.

It is the only such slot in the family. Swept on the reference log, 2026-08-12,
by decoding it once under **every** permutation of each surface and diffing the
samples against the shipped order:

| surface | non-identity permutations | degenerate | caught by continuity |
| --- | --- | --- | --- |
| TAG8_4S16 widths | 23 | **0** | 23 |
| TAG2_3S32 selector 0 values | 5 | **0** | 5 |
| TAG2_3S32 selector 1 values | 5 | **0** | 5 |
| TAG2_3S32 selector 2 values | 5 | **0** | 5 |
| TAG2_3S32 selector 3 widths | 5 | **1** — `(1,0,2)` | 4 |

See [The one slot pair no log we hold can
separate](#the-one-slot-pair-no-log-we-hold-can-separate) for what that one costs
and for what log would settle it.

Still worth doing: real firmware-output 4.3, 4.4 and 4.5 logs, a log with GPS frames
carrying data **and a non-zero home coordinate**, a log with
`TAG2_3SVARIABLE` fields, a log containing a rescue event (type 51, to exercise
the firmware-defined path), and — the only one that closes an open
layout question rather than widening coverage — a log with a **TAG2_3S32
selector-3 group whose first two fields need different byte widths**. Re-run
after any decoder change:

```text
npm run verify:log -- /path/to/YOUR_LOG.BFL
```

against a log from your own aircraft. The checks it runs — full-stream
consumption, zero resyncs, monotonic time and loop iteration, stable sample
interval, values inside sensor range, **and continuity across I-frame
boundaries** — are not equivalent. The first five are all alignment checks. Only
the last one can see a field being decoded from the wrong bits while the stream
stays perfectly in step.

## Multi-session dumps, and what 110 sessions did and did not add (2026-08-13)

Two concatenated dumps were decoded end to end alongside the reference log: 85 MB
from an M4Max on an `RDMS NEXUS_XR` (36 sessions, firmware 4.6.0-RC1 and RC3) and
131 MB from an OMP4MAX on a `FRSK VANTAC_RF007` (73 sessions, 4.6.0-RC3 and 4.6.0
final). **110 sessions, 5,081,355 samples, and every one of them decodes.**

Facts about the format worth keeping:

- **Sessions concatenate with no separator and no index.** Each begins at its own
  `H Product:` header; splitting on that marker gives exactly the session count
  `findSessionStarts` reports (1, 36, 73), so the decoder's own session scan and
  a naive text split agree on all three files.
- **Field inventories differ between sessions of the same dump.** The M4Max dump
  carries three: 61 fields (10 sessions), 64 (23) and 69 (3). The OMP4MAX dump is
  uniform at 72, the reference log has 89. A decoder that assumes one field table
  per file is wrong on both dumps.
- **Two error cases in 110 sessions**, both benign and both at an end: the
  reference log's cut final frame (the known power-off artefact, followed by
  erased flash, reported as `truncated` since 2026-10-03 and as `corrupt-frame`
  before that) and one `truncated` session in the OMP4MAX dump. No mid-body
  resync anywhere.
- **Sample interval stays inside 988.9–1008.2 µs** across all 110 sessions,
  i.e. nominal 1 kHz on both board models with no rate switching.
- **Neither dump declares location fields and neither carries a G frame.**
  `locationFieldsDeclared` is `false` on all 109 dump sessions; only the reference
  log declares them. Nothing here narrows the GPS coverage gap noted above.
- **Both boards log `gyroRAW[0..2]`**, so unfiltered-gyro analysis is available on
  every session in the corpus.
- **The dumps do not all pass continuity.** Re-run on 2026-10-03, `verify:log`
  fails "values are continuous across I-frame boundaries" on 32 of the 109 dump
  sessions (5 of 36 on the NEXUS_XR, 27 of 73 on the VANTAC) and passes every
  other check on all 109. The flagged fields include governor terms (`govI` up
  to 87.5x), ESC telemetry (`EscPwm` 41.4x, `EscThr`, `EscRPM`, `EscI`),
  `rcCommand[4]` at about 10x in several sessions, `headspeed`, `Ibat` and
  `attitude[2]`. Most of them are SIGNED_VB (predicted by PREVIOUS, or by
  AVERAGE_2 for `headspeed` and `motor[0]`), which has no width selector to
  misread; `govI` and `govP` (TAG8_4S16) and `attitude[2]` (TAG2_3S32) are the
  exceptions. Whether this is the check misjudging fields that change only now
  and then, or a real decode fault, **has not been investigated**. Until it is,
  those sessions are evidence of alignment, not of correct values.

What it does **not** add matters more than the sample count: **110 decoded
sessions are not 110 flights.** 77 of them carry a setpoint that is identically
zero on all three axes for their whole length, and 26 never turn the rotor above
300 rpm — they are bench and spool-up recordings. Classifying on "rotor above
1000 rpm for more than 20 s and the sticks moved" leaves **33 flights and 35.1
airborne minutes**. For decoder conformance every session counts; for anything
measured about flying, only the 33 do, and the corpus block in
`src/analysis/records.mjs` states that distinction where the constants live.

Neither dump closes the open TAG2_3S32 selector-3 question. They widen board and
firmware coverage, not layout coverage.

## The continuity check

`src/blackbox/continuity.mjs`, run by `verify:log` and pinned by
`test/blackbox-continuity.test.mjs`.

A `P` frame carries a residual against a prediction; an `I` frame carries the
absolute truth. So a decoder that is wrong about a delta accumulates error across
the keyframe period and has it yanked away at the next `I` frame. Measure mean
`|Δ|` on the transition *into* an `I` frame, divide by mean `|Δ|` everywhere
else, and correct decoding gives ≈1 — a real signal does not know where the
keyframes are.

Measured margins on the reference flight's 134,429 samples. (This line said
224,429 samples across four logs until 2026-10-03; the other 90,000 were the
three simulator files above, which are not real flight.)

| population | ratio |
| --- | --- |
| every correctly decoded field above the movement floor | ≤ **1.16x** |
| `attitude[0]`, TAG2_3S32 widths permuted | 2.2x |
| `axisP[1]`, TAG2_3S32 widths permuted | 5.0x |
| `gyroADC[1]`, AVERAGE_2 using floor instead of truncation | 10.0x |
| `attitude[2]`, TAG2_3S32 widths permuted | 17.9x |
| `setpoint[3]`, TAG8_4S16 widths permuted | 346x |
| `loopIteration`, INCREMENT step 1 where the log declares 2 | 33.0x |

The threshold sits at 2x, in the empty band between those two populations on
that log. The two dumps do not show the same empty band — see their continuity
failures in the multi-session section above.

Two guards keep it honest:

- **A movement floor of 0.05 counts per keyframe.** A ratio between two
  near-zero means says nothing. Measured 2026-10-03 on real logs: the reference
  flight's ESC capacity counter (`EscCap`) moves 0.0067 counts per keyframe and
  reads 1.59x, and in one session of the NEXUS_XR dump the MCU temperature
  (`Tmcu`), whose whole range is 36..39 and which changes five times in 91,850
  samples, reads 7.75x. Across that dump's 36 sessions, 34 of the 951 below-floor
  field readings that move at all read 2x or more. Both examples are arithmetic,
  not evidence. (Until 2026-10-03 the second example was "a field whose range is
  0..5 and which moves five times in 30,000 samples". That was a simulator
  figure, not a real-log one: read in memory with the missing signed-flags line
  supplied, each of the three simulator files above is exactly 30,000 samples,
  and one has a below-floor field reading 7.75x. The decoder refuses those files,
  so the example was replaced.)
  The cost is real and worth stating: **a genuine defect on a field that barely
  moves will not be caught by this.**
- **It reports a measurement, not a diagnosis.** It says which field is
  discontinuous and by how much. Which bit is wrong is for a human to work out.

The decoder accepts Rotorflight **4.3.x through 4.6.x**, and fails closed outside
that exact range. Coverage is not equal across it: 4.3 is exercised only by the
committed synthetic corpus; firmware output has been decoded for 4.6 alone (the
reference flight on 4.6.0, and the two dumps on 4.6.0-RC1, RC3 and final); and
the event serializer is verified against 4.6 firmware source. No firmware-output
4.4 or 4.5 log has been decoded. The only files labelled 4.4 this project has
held are the simulator files above, which the decoder refuses. Do not widen the
gate or the compatibility claim ahead of a log and conformance run for the new
range.

## Structure

A log file is a sequence of independent **sessions**, concatenated with no
separator. Each session is a text header block followed by a binary frame stream.

A session begins at the marker `H Product:`. Because sessions are concatenated,
the byte before that marker is arbitrary binary from the previous session's last
frame — so session detection confirms the marker is followed by a complete
header line and another `H ` line, rather than requiring a preceding newline.
Getting this wrong silently drops every session after the first.

Header lines are `H key:value`, one per line, until the first line that is not
well-formed. That point is where frames begin. Bytes that do not start `H ` end
the header at once and are never measured as a line: frame data can run far past
the 64 KiB header-line limit without a 0x0A byte, and treating it as an overlong
header line used to discard sessions whose header was intact.

Before frames are trusted, the decoder requires the standard Blackbox recorder
product string, data version `2`, and a Rotorflight **4.3.x–4.6.x** firmware
type/revision. A marker-shaped file from another product, an earlier/future
Rotorflight release, or a future data version is returned as
`unsupported-firmware`; it is never decoded optimistically under today's field
rules. A repeated `H Product:` key alone stays in the current header, while the
firmware's complete `Product` + `Data version` preamble begins a new session even
when a preceding header-only session left no binary frame between them.

## Frames

| Marker | Meaning |
| --- | --- |
| `I` | intra/keyframe — absolute values, resync anchor |
| `P` | inter/delta frame — residuals against predictions |
| `S` | slow frame — infrequently changing state |
| `G` | GPS frame |
| `H` | GPS home coordinates |
| `E` | event |

`P` frames declare their own predictors and encodings but reuse the `I` frame's
field *names*: same fields, different compression.

Event payloads follow the pinned Rotorflight 4.6 firmware serializer, not the
length of values happened to appear in one log:

| ID | Meaning | Payload after the ID |
| --- | --- | --- |
| 0 | sync beep | time, unsigned variable-byte |
| 13 | in-flight adjustment | function byte; signed variable-byte value, or four-byte little-endian float when function bit 7 is set |
| 14 | logging resume | loop iteration and time, both unsigned variable-byte |
| 15 | disarm | reason, unsigned variable-byte |
| 30 | flight mode | flags and prior flags, both unsigned variable-byte |
| 50 | governor state | unsigned variable-byte |
| 51 | rescue state | unsigned variable-byte |
| 52 | airborne state | unsigned variable-byte |
| 100/101 | custom data/string | one-byte length followed by that many bytes |
| 255 | clean end | exact bytes `End of log\0` |

The old decoder read adjustment and state values as raw single bytes and accepted
bare `E FF` as clean. That was self-consistent with the synthetic writer but not
with firmware: integer `+2` is the byte `04` on disk, and decoded as `4`; a state
above 127 consumed only the first byte; a float consumed the next frame bytes.
The writer and independent byte-vector tests now pin the firmware representation.
Source: Rotorflight 4.6.0 commit `118e912`,
[`blackboxLogEvent`](https://github.com/rotorflight/rotorflight-firmware/blob/118e9120260bb33f46df4f92052fb0e9fd4e9ebc/src/main/blackbox/blackbox.c#L1793-L1856).

Measured event inventory over the full stream of every real log we hold
(re-measured 2026-10-03 with the shipped decoder), so the next log carrying
something new is recognisable as new evidence:

| log | event types present |
| --- | --- |
| real 4.6 flight | 0 (×1), 13 (×8), 50 (×3), 52 (×5) |
| M4Max dump, 36 sessions | 0 (×34), 13 (×8), 15 (×36), 30 (×36), 50 (×168), 52 (×112), 255 (×36) |
| OMP4MAX dump, 73 sessions | 0 (×72), 15 (×72), 30 (×72), 50 (×265), 52 (×10), 255 (×72) |

No **51**, no 14 and no 100/101 appear anywhere in it. Their layouts are
nevertheless known from the pinned firmware serializer above. (Until 2026-10-03
this table listed the three simulator files instead of the dumps, at one 255
each, and so also reported no 15 and no 30; the dumps carry both.) The real
flight's single error is 525 bytes from EOF — a truncated final frame followed
by erased flash, reported as `truncated`, not an unknown event.

## Field encodings

"Real log" below means the Rotorflight 4.6.0 flight described above actually used
that encoding, across 134,000 frames, without the stream ever losing sync.

| ID | Name | Layout | Status |
| --- | --- | --- | --- |
| 0 | SIGNED_VB | zigzag, then unsigned varint | real log |
| 1 | UNSIGNED_VB | 7 bits per byte, high bit continues, max 5 bytes | real log |
| 3 | NEG_14BIT | unsigned varint, low 14 bits, sign-extended, negated | real log |
| 6 | TAG8_8SVB | selector byte, bit *n* set → field *n* has a signed varint | real log |
| 7 | TAG2_3S32 | see below | real log — **except selector 3's first two width slots, which no log we hold separates** |
| 8 | TAG8_4S16 | see below | real log |
| 9 | NULL | no bytes; value comes entirely from the predictor | real log |
| 10 | TAG2_3SVARIABLE | as TAG2_3S32, widest selector uses signed varints | **round-trip only — declared by no real log we hold** |

Measured field-table inventory, 2026-08-12, re-measured 2026-10-03 across all
110 real sessions: the real 4.6 log declares encodings {0, 1, 3, 6, 7, 8, 9},
and each dump, across its sessions, declares the same set. Encoding 10 appears
in none of them. (The three simulator files declared {0, 1, 6, 7, 9}.)

### TAG2_3S32 — three fields, one lead byte

Top two bits of the lead byte select the packing:

- `0` — three 2-bit signed **values** in lead bits 5:0, field *n* at shift
  `4 - 2n` — field 0 in the **high** pair
- `1` — three 4-bit signed values: field 0 in the lead byte's low nibble, fields
  1 and 2 in the next byte (high nibble first)
- `2` — three 6-bit signed values, one per byte, in the low 6 bits
- `3` — per-field byte **widths**, 2 bits each in lead bits 5:0, field *n* at
  shift `2n` — field 0 in the **low** pair — width = `bits + 1`, each value
  little-endian and sign-extended. **Partly measured: see the degeneracy below.**

**Selector 0 and selector 3 pack from opposite ends of the byte.** That much is
measured, it is surprising, and reasoning by analogy from one to the other is
exactly what put the bug in selector 3: it read its widths high-pair-first until
12 August 2026.

#### The one slot pair no log we hold can separate

Selector 3 has six possible width-slot permutations. The logs we hold separate
the shipped order from **four** of them. They do not separate it from the fifth,
and the fifth is its **field-0/field-1 transposition** — reading `(1,0,2)`, so
field 0 takes the width in slot 1 and field 1 takes the width in slot 0.

Measured on the reference 4.6 log, 2026-08-12, by decoding it under all six
permutations and diffing the samples:

| permutation | samples differing from shipped | verify:log |
| --- | --- | --- |
| `(0,1,2)` — as shipped | — | 13/13 |
| `(1,0,2)` — field 0 ↔ field 1 | **0 of 134,429** | **13/13** |
| `(0,2,1)` | 53 | 12/13, `axisP[1]` 30.3x |
| `(1,2,0)` | 53 | 12/13, `axisP[1]` 30.3x |
| `(2,1,0)` | 53 | 12/13, `attitude[2]` 17.9x |
| `(2,0,1)` | 53 | 12/13, `attitude[2]` 17.9x |

The six collapse into **three** distinguishable classes, and the shipped order
shares its class with its own transposition. The reason is arithmetic, not luck:
**all 633 selector-3 groups in that log have `width[0] == width[1]`** — 624 are
`(1,1,1)`, 7 are `(1,1,2)`, 2 are `(4,4,4)` — so swapping those two slots is a
no-op on every group in the file. The three lines of evidence below are therefore
**silent** on this pair, not supporting of it: two decoders that emit identical
numbers cannot be told apart by any measurement of those numbers. The
byte-tightness argument is degenerate here too, since the two slots being
exchanged always hold the same width.

The three simulator files once cited here could not help either: all six of
their selector-3 groups had three equal widths, so every permutation was a no-op
on them — and the decoder now refuses them outright. The two dumps do not settle
it either (see the multi-session section above).

**What is at stake.** This group carries `axisP`, `axisI`, `axisD`, `axisF` and
`axisO`. On the day firmware emits a selector-3 group whose first two fields need
different byte widths, a wrong choice here is a silent **roll/pitch swap on the
PID terms** — no error, no resync, no continuity flag, just the wrong axis'
numbers under the right axis' heading.

**What would settle it:** a real firmware log containing at least one TAG2_3S32
selector-3 group where `width[0] != width[1]` — that is, a frame in which the
first two fields of the group have residuals in different byte-width bands (one
inside ±127, the other outside it) while the group as a whole is too wide for
selector 2. Continuity would then separate the two orders exactly as it separates
the other four. Until such a log exists, this layout is **inferred from the four
permutations that are excluded, plus the assumption that the slot order is
positional**, and not measured.

Our own corpus cannot settle it and does not pretend to. `rf46-stop-manoeuvres.TXT`
does carry selector-3 groups with unequal widths on purpose — including in the
first slot pair — so a change to the reader alone would now break round-trip
instead of passing silently. That pins our reader against our writer. Both are
ours; both would move together if the assumption is wrong.

Evidence for selector 3's order against the four permutations it *does* exclude,
three independent lines, in increasing order of how little each assumes:

1. **Continuity** (real 4.6 log, ratio at I-frame positions, old → corrected):
   `attitude[2]` 17.93x → 0.67x, `axisP[1]` 4.97x → 0.96x, `attitude[0]` 2.23x →
   0.97x. Σ|Δ| at I-frame positions over all 18 TAG2_3S32 fields: 26,693 →
   17,983.
2. **Byte-level tightness**, which uses no predictors, no keyframes and no
   continuity at all: an encoder that spends two bytes on a value that fits in
   one is wasting a byte, so on the correct assignment almost every value must be
   tight. Of the 7 groups in the real log whose outer widths differ, the old
   order leaves 6 of 21 values slack; this order leaves **0 of 21**.
3. **Physical range**: `attitude[2]` is heading in decidegrees. This order gives
   exactly `0..3599` with two clean wraps; the old one gave `-3..3595`, a
   negative heading that never reaches 3599, with the wraps misattributed to
   `attitude[0]` as a spurious −256 spike.

The blast radius was narrow and sharp: only 53 of 134,429 samples change, so
every median, RMS, quantile and frame count is identical — which is why nothing
caught it. But peak `|axisP[1]|` read **357** against a corrected **13**, a 27x
inflation of the peak pitch P term, and peak over a short window is precisely
what a tuning metric looks at.

Selectors **0, 1 and 2 were swept over all six permutations each** against the
real log and measured the same way. Every one of the five non-identity orders
changes the decoded samples and every one is caught; none of them is marginal.
The worst offender in each reversal:

| selector reversed | worst continuity ratio |
| --- | --- |
| 0 (three 2-bit values) | `axisO[0]` **5461x**, `axisI[2]` 71.5x, `axisD[2]` 52.3x |
| 1 (three 4-bit values) | `attitude[1]` **19.7x**, `axisP[1]` 15.5x |
| 2 (three 6-bit values) | `axisP[0]` **19.6x**, `axisP[2]` 10.5x |
| none — as shipped | 1.16x, and nothing above the threshold |

**TAG2_3SVARIABLE has no width-slot surface of its own.** Its selectors 0–2
delegate straight to TAG2_3S32 and therefore inherited nothing wrong; its
selector 3 is variable-byte with no width slots at all.

### TAG8_8SVB is in the silent class too

Worth stating plainly, because the intuition points the other way and got this
wrong at first. TAG8_8SVB's selector bit decides *whether a varint is read at
all*, so it looks like a reversed bit order must change byte consumption and
destroy sync. It does not. Reversing the bits **within the group** preserves
their popcount, so exactly the same number of varints is read.

Measured on the real 4.6 log on 2026-08-12: reversed, it still gave 134,429
samples, 1 error and 525 resync bytes — bit-identical to the correct order as it
decoded then (that error was the cut final frame, reported as `truncated` with
no resync since 2026-10-03). Only continuity separates them:

| order | worst continuity |
| --- | --- |
| bit *n* → field *n* (shipped) | 1.16x, nothing flagged |
| reversed within group | `altitude` **infinite**, `rssi` 29.6x |
| reversed, one simulator file (2026-08-12; refused by the decoder since) | `axisI[0]` **158.9x**, `axisI[2]` 39.0x |

(Reversing across all 8 bit positions regardless of group size *does* break sync,
which is presumably where the opposite intuition comes from. That is not the
permutation that matters — a decoder written from the spec would get the group
size right and the bit order wrong, not the other way round.)

### TAG8_4S16 — four fields, nibble-packed

Lead byte holds a 2-bit width per field, field *n* at shift `2n` — field 0 in the
**low** two bits: `0` = zero (no bytes), `1` = one nibble, `2` = two nibbles,
`3` = four nibbles. Values follow as a nibble stream, **high half of each byte
first**, with a trailing half byte as padding.

**This was read from the wrong end of the lead byte until 11 August 2026, and the
paragraph that used to sit here argued it was fine.** The argument was: a wrong
order would have desynchronized the stream within a few frames instead of holding
sync for 134,000 of them. That reasoning is invalid, and the invalidity is worth
keeping in front of whoever reads this next.

Reversing the four selectors permutes the widths but leaves their **sum**
unchanged, so the nibble stream consumes exactly the same number of bytes. Frame
alignment is untouched; sync is never lost; every frame decodes; the error count
stays at zero. Our encoder packed it the same wrong way, so round-trip agreed
with itself. This file even named the risk correctly — "both halves of our
implementation agree with each other" — and then accepted sync as proof anyway.

What actually settles it is **continuity**, because a P frame carries a delta and
an I frame an absolute. Mis-assigned widths make a field drift for 31 samples and
snap back at each I frame. Bucketing `|Δ|` by position in the 32-sample I-frame
period on the real 4.6 log:

| field | encoding | wrong order | corrected |
| --- | --- | --- | --- |
| `setpoint[0]` | TAG8_4S16 | **28.2x** spike at phase 0 | 1.3x |
| `setpoint[2]` | TAG8_4S16 | **55.1x** at phase 0 | 1.3x |
| `rcCommand[0]` | TAG8_4S16 | **45.9x** at phase 0 | 1.2x |
| `gyroADC[0]` | SVB (control) | 1.0x | 1.0x |
| `axisP[0]` | control | 1.1x | 1.1x |

Phase 0 is where the I frames land. The controls do not move, which is what makes
it the encoding rather than the log.

The consequence was not subtle: peak roll command read 287 °/s wrong and 56 °/s
right. Analysis built on it was measuring a sawtooth.

**The lesson for the rest of this file: a check that only proves the stream stays
aligned proves nothing about the values in it.** Any encoding whose widths are
selected by a header byte can be permuted without losing sync.

**That warning was correct and has now been discharged, the hard way.** It named
TAG2_3S32 as deserving the same continuity check, and when the check was finally
run, TAG2_3S32 selector 3 turned out to be broken in the identical shape — see
its section above. TAG2_3SVARIABLE was cleared for a different reason: it has no
width slots of its own.

Two things follow, and they are worth stating as rules rather than as history:

- **No round-trip test can ever adjudicate a slot order**, in any encoding, ever.
  The writer and the reader share the assumption by construction. Do not add one
  and believe it settles a layout question.
- **A synthetic corpus can be structurally incapable of seeing a bug.** If every
  field in a group needs the same width, permuting the slots is a no-op. Our own
  fixtures and the three simulator files once cited here are in that position
  for both encodings.
  `test/blackbox-continuity.test.mjs` therefore builds groups whose widths are
  deliberately all different, and mis-packs them on purpose. Measured 2026-08-12:
  `rf43-single-session.TXT` produces 87 selector-3 groups and **all 87 are
  `(1,1,1)`**, so the older corpus was blind to every one of the six
  permutations. `rf46-stop-manoeuvres.TXT` now injects three groups with widths
  `(1,2,1)`, `(2,1,1)` and `(1,1,2)`, which between them give a different byte
  layout under all six — `test/blackbox-stop-fixture.test.mjs` asserts that
  property directly off the committed frames.
- **And a real corpus can be too, in exactly one place.** No amount of fixture
  work fixes that: our writer shares our reader's assumption, so the two can only
  ever be pinned to each other. The selector-3 first-slot-pair question is open
  until a firmware log answers it.

## Predictors

| ID | Name | Prediction | Status |
| --- | --- | --- | --- |
| 0 | NONE | 0 | real log |
| 1 | PREVIOUS | previous frame's value | real log |
| 2 | STRAIGHT_LINE | `2·previous − previous2` | real log |
| 3 | AVERAGE_2 | `trunc((previous + previous2) / 2)` | real log — **truncation measured, see below** |
| 4 | MIN_THROTTLE | header `minthrottle` | **round-trip only** — once seen in third-party simulator files the decoder now refuses |
| 5 | MOTOR_0 | this frame's `motor[0]` | **round-trip only** |
| 6 | INCREMENT | `previous + step`, step per session | real log — **step measured, see below** |
| 7 | HOME_COORD | matching GPS home coordinate | real log, but **only with home = [0, 0]** |
| 8 | CONST_1500 | 1500 | real log |
| 9 | VBAT_REF | header `vbatref` | real log |
| 10 | LAST_MAIN_FRAME_TIME | last main frame's `time` | real log |
| 11 | MIN_MOTOR | header `motorOutput` low value | **round-trip only** |

Measured inventory, 2026-08-12, re-measured 2026-10-03 across all 110 real
sessions: the real 4.6 log declares predictors {0, 1, 2, 3, 6, 7, 8, 9, 10}, and
each dump, across its sessions, declares {0, 1, 2, 3, 6, 8, 9}. **MIN_THROTTLE
(4), MOTOR_0 (5) and MIN_MOTOR (11) appear in no real log we hold** and remain
round-trip only. MIN_THROTTLE used to carry a status of its own because the
three simulator files declare it for `motor[0]` and `motor[1]`; that was
independent of our writer, but it was never firmware output, and the decoder
now refuses those files.

**INCREMENT — the step is per session, and it is not always 1.** This file used
to say the real log "decoded it monotonically across every frame, so the step is
1", and closed with "a log with a P interval greater than 1 would still be worth
checking". The log being described **is** that log: the reference flight
declares `H I interval:64`, `H P interval:2`, `H P ratio:32`. The reasoning was
also the exact fallacy this file warns about three sections earlier —
monotonicity is a sync-style argument.

Measured with a hardcoded step of 1: `loopIteration` ramped 1 per delta frame and
was yanked forward **33** at every keyframe, at **4,200 of 4,200 I frames** and
**0 of 130,228** P frames, ending at 268,828 against a true 268,856. Both jumps
are forwards, so the monotonicity guard was satisfied and no frame was ever
rejected. The step is now derived as `I interval / P ratio`, falling back to the
leading integer of `P interval`; both derivations agree on all 110 real sessions
we hold, every one of them a step of 2 (re-measured 2026-10-03), and the phase
ratio on the real flight collapses to exactly 1.000.

**AVERAGE_2 — truncation toward zero, now measured rather than assumed.** The two
candidates differ only when `previous + previous2` is negative and odd, which
happens on **187,681 of the 2,083,648** AVERAGE_2 predictions in the real log
(16 fields × 130,228 delta frames), so the log has ample power to decide it.
Decoding with a floor puts the gyro fields into
unmistakable drift-and-snap — `gyroADC[1]` 9.99x, `gyroADC[2]` 9.14x,
`gyroADC[0]` 8.88x at I-frame positions — while truncation leaves every one of
them at ~1.0x. This matters more than it sounds: in the real log AVERAGE_2 covers
`gyroRAW[0..2]`, `gyroADC[0..2]`, `accADC[0..2]`, `headspeed`, `motor[0]` and
`servo[0..4]` — the entire gyro and servo path the pitch/roll/yaw analysis rests
on.

**HOME_COORD — pairing is by field, and the real log cannot confirm it.** The
Nth HOME_COORD-predicted field predicts against the Nth home coordinate. This was
indexed by position within the decoded *group* instead, and since `GPS_coord[0]`
and `GPS_coord[1]` both use SIGNED_VB with a group size of 1, both predicted
against home *latitude*. It produced no wrong output for one reason only, and it
is an accident of this one log: **all 13 of its H frames decode to `[0, 0]`**.
A zero home is indistinguishable from NONE, so the row above is downgraded
accordingly. (The H frames are genuinely interleaved with the 675 G frames — 51
G frames precede the first H frame and 653 precede the last — so the predictor
was live throughout; it simply had nothing to predict with.) The rule is pinned
by a hand-built log in `test/blackbox-decode.test.mjs` instead.

## Deliberate decoder behaviors

- **Predictor history is committed only by frames that pass validation.** A
  rejected frame leaves history untouched, so one bad frame cannot poison every
  frame after it. This is what stops a viewer from rendering confident garbage.
- **`I` frames reset prediction history.** They are absolute, so they double as
  resync anchors: decoding recovers fully at the next keyframe.
- **Desync is data.** A bad frame is recorded with a typed code and byte offset,
  then the loop scans forward for the next plausible frame marker. Damaged logs
  decode partially rather than failing whole.
- **No heuristic value filtering.** The decoder does not drop samples for being
  physically implausible — that belongs to `verify:log` and to analysis, not to
  the thing whose job is faithfully reporting bytes. A damaged span can therefore
  produce absurd values; callers must check `errors` and `frameCounts.resyncBytes`
  before trusting a session.
- **Bounds are enforced everywhere.** Reads past the end raise a typed truncation
  error rather than returning undefined. Varints are capped at 5 bytes and the
  fifth byte may carry only the four payload bits that still fit in a `uint32`.
  Sessions, main frames, events, auxiliary frames, total records and retained
  errors have separate caps. Reaching one records `limit-exceeded`; frame-stage
  caps also set `session.limitExceeded`. A partial prefix can therefore never
  report clean, and a session-count overflow returns no partial session list.
- **Decoded field values are bounded by the bytes that carry them.** NULL
  (encoding 9) consumes no bytes and a header may declare 1024 fields, so a
  crafted header could turn each body byte into a 1024-value frame — 1.66 GB of
  heap from a 215 KB file. Every I, P, S, G and H frame is charged its field
  count against 16 values per body byte plus a 65,536 floor, and crossing it
  records `limit-exceeded` with `resource: 'cell'`. Real sessions run 1.40–1.73
  values per byte (110 sessions), and no non-NULL encoding packs more than 8
  fields into one byte. The run of same-encoding fields is measured only up to
  the encoding's group capacity, which keeps each frame linear in its width.
- **Erased flash after a cut frame is the end of the capture.** Unwritten flash
  reads back 0xFF, and a 0xFF run never terminates a variable-byte field, so a
  frame cut by power-off fails as "exceeded 32 bits" rather than running out of
  input. When the failing frame began at or before an unbroken run of 0xFF that
  reaches the end of its session, and its reads went into that run, the failure
  is reported as `truncated` with `erasedBytes`, and the run is consumed rather
  than resynced through. Anything else stays damage: an erased run with data
  after it, a frame that failed on its own written bytes, and a run that a
  committed frame had already decoded as values (an erased byte and a data byte
  of 0xFF are indistinguishable). Zero fill is not treated this way; no log we
  hold ends in it. The 4096-byte tail tolerance in `log-integrity.mjs` still
  applies, so a cut followed by more than about 4 KB of erased flash reads as
  damage — no log we hold has one.
- **Unsigned fields stay unsigned.** An unsigned variable-byte value remains in
  JavaScript's exact `0..2^32-1` integer range. In particular, Blackbox time does
  not become negative at `2^31` microseconds (about 35.8 minutes).

## What the first real log changed

Worth recording, because it is the argument for getting more of them:

- **17 decode errors, all unknown event types.** Not a bit-layout fault. Their
  payload lengths were measurable from the log itself.
- **`verify:log` was wrong about its own result.** It counted a capture that
  stops mid-frame as a decoding failure, which would have condemned almost every
  real log.
- **The analysis reported a confident, wrong verdict.** Hunting was detected by
  counting how often the tracking error crossed its mean. On real gyro data that
  is dominated by sensor noise: the crossing rate was 61 Hz, and an aircraft with
  0.8 deg/s of steady error was told to reduce its I term. Fixed by measuring
  hunting only in the 0.3–3 Hz band the I term can actually produce, and
  reporting the fast component separately as noise.

Every one of those passed a full suite of synthetic tests first. Synthetic data
proves an implementation self-consistent; only real data proves it right.

## What the continuity sweep changed (2026-08-12)

The same argument, one level sharper: real data only proves it right if you
measure the right property. The real log, and the three simulator files counted
alongside it at the time, decoded "cleanly" for months.

- **TAG2_3S32 selector 3 read its widths from the wrong end** — the second
  instance of the TAG8_4S16 bug, found by generalizing the check that caught the
  first. Peak `|axisP[1]|` was inflated 27x. 53 of 134,429 samples changed, so no
  median, RMS, quantile or frame count moved at all. **Corrected against four of
  the six permutations, not all six**; the field-0/field-1 transposition remains
  undetermined and is now recorded as such rather than as measured.
- **INCREMENT used a step of 1 in a log that declares 2** — a 33-count sawtooth
  at 100% of keyframes, invisible because both jumps are forwards.
- **HOME_COORD paired coordinates by group offset** — latent, and only latent
  because the one log with GPS frames has a zero home.
- **AVERAGE_2's truncation was confirmed**, not merely assumed, and the same
  continuity check is what confirmed it (floor gives 10x, truncation 1x).
- **Everything else was cleared with a number rather than an argument**:
  TAG2_3S32 selectors 0/1/2 over all six permutations each and TAG8_8SVB by
  continuity. Event type 51 remained absent from every log measured, and is still
  absent from all 110 real sessions held on 2026-10-03, so its regression vector
  is pinned directly to the firmware serializer instead.

The methodological point, which is the part worth keeping: **three of these are
delta-vs-absolute defects, and one check finds all three.** If a future encoding
or predictor is added, the question to ask is not "does it round-trip" but "would
a wrong version of this survive the continuity check", and if the answer is yes,
the corpus needs a case that makes it visible.

## When a real log arrives

1. Run `npm run verify:log` against it.
2. Read the continuity line specifically, not just the pass/fail total. A worst
   ratio creeping towards 2x on a field that moves is the early warning; a log
   that reports "continuity not measured" has told you nothing about its values.
3. If every check passes, add it as a fixture per `docs/FIXTURE_POLICY.md` and
   record its decoded field inventory as a regression baseline.
4. If a check fails, correct the relevant assumption above, and add a unit test
   pinning the corrected layout before touching anything else. For a layout
   question, that test must be a continuity or tightness test — a round-trip test
   will pass either way and tell you nothing.
5. **Census its TAG2_3S32 selector-3 groups for one where `width[0] != width[1]`.**
   That is the one open layout question in this decoder, and a log containing such
   a group closes it: decode it both ways and compare continuity. If it has none,
   the log is silent on the question — say so, and do not read a clean pass as
   confirmation. Every log in the corpus so far is silent on it.
