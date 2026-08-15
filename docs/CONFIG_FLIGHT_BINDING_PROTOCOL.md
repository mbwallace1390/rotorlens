# Configuration-to-flight binding protocol (draft)

Status: **Phase 2E protocol-only stop; not implemented by Rotorflight or
RotorLens.**

This document defines the minimum evidence that could bind one sanitized,
versioned controller-configuration snapshot to one Blackbox session without
placing raw configuration rows in the log. It deliberately does not add a
runtime inspector, Configurator collector, firmware patch, app caller, USB/MSP
transport, upload path, or community-model gate.

The current Rotorflight 4.3.0 through 4.6.0 release pins do not emit this
evidence. A matching Phase 2C overlap report plus a clean Phase 2D session report
therefore remains **unproven**. File time, import order, craft name, board name,
profile number, a user assertion, or matching values from the partial Blackbox
header are not substitutes for this protocol.

## 1. Claim and threat boundary

A future conforming implementation may establish only this claim:

> The collector artifact, start header, and terminal seal are mutually
> consistent with the behavior required by the source-reviewed protocol: one
> registered non-sensitive manifest commitment was accepted while logging was
> stopped, repeated at session start, and accompanied by no reported scoped
> mutation before the terminal seal.

That is consistency evidence, not attestation. The Blackbox header, terminal
event, firmware revision, board, nonce, and digest are all self-reported bytes.
Someone able to fabricate both a log and a collector artifact can fabricate a
matching pair. The protocol supplies no device identity, secret, signature,
remote authentication, replay service, or anti-poisoning protection. Those are
separate ingestion problems, and adding an MCU serial or board signature would
also create a privacy identifier this protocol intentionally excludes.

The public nonce prevents stable commitment equality across flights; it does not
make SHA-256 a hiding commitment. An observer who already knows almost every row
can still test guesses for a low-entropy unknown row. Production manifests must
therefore contain only separately privacy-reviewed, non-sensitive settings. The
protocol promises omission of raw rows from the log, not cryptographic secrecy
for the committed values.

Binding also does not make an incomplete configuration manifest complete. A
positive protocol result must remain cohort-, advice-, and model-ineligible until
the community contract separately adopts exhaustive filter, governor, mixer,
power, gearing, RPM-source, and other transitive configuration coverage.

## 2. Firmware facts that constrain the design

The design is pinned to the audited Rotorflight writer rather than inferred from
the viewer:

- `src/main/blackbox/blackbox.c` writes system-information `H` lines through the
  `BLACKBOX_STATE_SEND_SYSINFO` state before entering
  `BLACKBOX_STATE_RUNNING`. The same file writes `FLIGHT_LOG_EVENT_LOG_END` when
  logging shuts down.
- `src/main/blackbox/blackbox_encoding.c` supplies the bounded header-line
  writers, while `src/main/blackbox/blackbox_io.c` owns the header budget and
  output buffering. Sysinfo reserves approximately 64 bytes for one header line,
  so no new encoded line below exceeds that budget.
- `src/main/blackbox/blackbox_fielddefs.h` assigns event 100 to
  `FLIGHT_LOG_EVENT_CUSTOM_DATA`; `src/main/blackbox/blackbox.c` serializes it as
  one byte of payload length followed by that many bytes. The same serializer
  writes the exact `LOG_END` marker.
- `src/main/fc/rc_adjustments.c` changes live configuration, emits adjustment
  events, and calls `setConfigDirty()`. `src/main/config/config.c` owns the
  current dirty/save lifecycle. A binding generation must cover these and every
  other write path selected by a production manifest; the existing dirty bit is
  not a monotonic, sticky proof by itself.
- `src/main/cli/settings.c`, `src/main/cli/cli.c`, `src/main/msp/msp.c`, and the
  relevant `src/main/pg/`, mixer, rates, governor, motor, and RPM-source files
  are required inputs to the future manifest and mutation-path audit.

The reviewed release commits are:

| Release | Commit |
| --- | --- |
| 4.3.0 | `05570fec69fd566e713f11e84adc7b77a8d68abf` |
| 4.4.0 | `5fc142adfdc4031877061433c5052e473b9cdfd2` |
| 4.4.1 | `456633bcea79933142c7fee17922ab306028bcf9` |
| 4.5.0 | `e77d192c43c4b36ef4d18b67d24859ddc0968755` |
| 4.5.1 | `e69823a3c185cbf1b75fd2701e938e978591a36b` |
| 4.6.0 | `118e9120260bb33f46df4f92052fb0e9fd4e9ebc` |

None implements the `rl_binding_*` header contract or terminal seal below, so
all six are permanently unbound under protocol version 1. A version string or
nearby commit must never borrow support from a future reviewed implementation.

The four distinct reviewed writer implementations were checked at these exact
source locations. Patch releases in the 4.4 and 4.5 rows have identical writer
locations and behavior. None contains an `rl_binding` identifier.

| Writer releases and commits | `blackboxWriteSysinfo` | shutdown `LOG_END` call | `CUSTOM_DATA` case | `LOG_END` serializer |
| --- | ---: | ---: | ---: | ---: |
| 4.3.0 `05570fec69fd566e713f11e84adc7b77a8d68abf` | `src/main/blackbox/blackbox.c:1418` | `:1132` | `:1644` | `:1659` |
| 4.4.0 `5fc142adfdc4031877061433c5052e473b9cdfd2`; 4.4.1 `456633bcea79933142c7fee17922ab306028bcf9` | `src/main/blackbox/blackbox.c:1518` | `:1196` | `:1799` | `:1814` |
| 4.5.0 `e77d192c43c4b36ef4d18b67d24859ddc0968755`; 4.5.1 `e69823a3c185cbf1b75fd2701e938e978591a36b` | `src/main/blackbox/blackbox.c:1556` | `:1217` | `:1808` | `:1823` |
| 4.6.0 `118e9120260bb33f46df4f92052fb0e9fd4e9ebc` | `src/main/blackbox/blackbox.c:1587` | `:1244` | `:1838` | `:1853` |

The hash choice is also a draft engineering decision. Protocol version 1 uses
SHA-256 because RotorLens already has a tested, dependency-free implementation.
The reviewed firmware sources do not yet establish the required implementation,
flash/RAM cost, or execution time. Those must be measured outside the flight loop
before a firmware patch can be accepted. A different hash requires a new
protocol version; changing only a header string is forbidden.

## 3. Actors and one-use lifecycle

The collector is an external Rotorflight Configurator component or another
separately reviewed tool. It is not RotorLens.

1. While the controller is disarmed and Blackbox is stopped, the collector
   generates a fresh 16-byte nonce and prepares every row required by one
   registered manifest.
2. The collector canonicalizes the request, computes its SHA-256 commitment, and
   submits the protocol version, nonce, manifest identifier, firmware commit,
   target, active PID/rate profile indices, rows, and declared commitment.
3. Firmware validates only; it must never apply a submitted row. Protocol and
   algorithm identifiers, the full 20-byte commit, and target come from the
   reviewed firmware build and its closed manifest registry. Active profile
   indices and setting values come from live firmware state. The corresponding
   collector fields are assertions that must match those firmware-derived values;
   firmware must never hash caller-supplied identity or profile values as though
   they were its own.
4. Firmware takes one stable snapshot of the active profiles and complete
   registered row set. Every scoped writer and this reader must share a defined
   synchronization protocol: either a bounded critical-section/immutable copy or
   a generation-before/after scheme that rejects an unstable or changed read.
   Torn rows, profiles captured at a different boundary, and token publication
   racing a writer are forbidden. Firmware canonicalizes and hashes only the
   accepted stable copy during disarmed preparation.
5. Publishing a matching RAM-only pending token is atomic with the final stable-
   generation check. The token contains the nonce, manifest, commitment, and
   scoped generation. A mismatch or unstable snapshot creates no token.
6. Reboot, another acceptance request, any scoped mutation, or the first attempted
   Blackbox start destroys the pending token. It is never persisted to flash and
   never reused for a second session.
7. At `blackboxStart`, firmware atomically consumes a ready token only when its
   generation still equals the current stable generation. Relative to every
   scoped writer, that consume and the fixed-size copy into session state are one
   linearized operation. The start path must not rescan rows or rebuild/hash the
   commitment. Header transmission may remain incremental, but its binding values
   come only from that frozen session state rather than later live reads.
8. Every scoped mutation after the freeze increments an unsigned 32-bit generation
   and sets a sticky per-session invalidation flag. Wraparound cannot clear the
   sticky flag. Shutdown atomically enters the terminal state relative to those
   same writers, stops body logging, and captures the terminal generation and
   flags before serializing the seal and `LOG_END`.

Snapshot construction and hashing happen only during disarmed preparation, not
inside `blackboxStart`. Preparation still needs a measured scheduler budget;
`blackboxStart` needs a separate worst-case measurement for its fixed-size atomic
consume/copy. A firmware implementation must show both timing and memory results
before support is enabled.

## 4. Production manifest requirements

A production binding manifest is a source-pinned registry entry, not a caller
supplied schema. It defines:

- one bounded machine identifier;
- the exact firmware commits and targets to which it applies;
- the active PID and rate profile domains;
- every separately privacy-reviewed, non-sensitive setting in its claimed scope;
- one stable unsigned 16-bit field identifier per scalar component;
- an exact scalar type, legal range, post-validation meaning, and every
  cross-field invariant;
- every firmware read and mutation path that must participate in the sticky
  generation.

Rows are complete only when their identifiers exactly equal the registered set.
They are strictly increasing and may not be missing, duplicated, reordered, or
unknown. Array/vector components receive separate field identifiers, which keeps
the wire format scalar and bounded. Rows never contain strings. Names, dates,
paths, craft/profile labels, MCU identifiers, board serials/signatures, receiver
configuration, port configuration, or arbitrary CLI text are forbidden.

The machine tokens for target and manifest use ASCII
`[A-Za-z0-9._-]`, are one through 32 bytes, and are compared byte-for-byte. They
are identifiers, not free text. The collector artifact may retain the sanitized
typed rows locally, but neither the Blackbox header nor a future categorical
binding report returns them.

No production manifest exists in this phase. The small manifest in section 9 is
only a canonicalization vector and makes no configuration-coverage claim.

## 5. Canonical commitment preimage

All integers are big-endian. Concatenation is exact and has no padding, Unicode,
JSON, locale formatting, NUL terminator, or optional field.

| Order | Bytes | Meaning |
| --- | ---: | --- |
| 1 | 20 | ASCII domain separator `RotorLens binding v1` |
| 2 | 2 | unsigned protocol version; `0x0001` |
| 3 | 1 | hash algorithm identifier; `0x01` means SHA-256 |
| 4 | 16 | fresh nonce |
| 5 | 20 | full raw firmware Git commit decoded from 40 lowercase hex digits |
| 6 | 1 + N | target byte length, then target machine-token bytes |
| 7 | 1 + N | manifest byte length, then manifest machine-token bytes |
| 8 | 1 | active PID profile index |
| 9 | 1 | active rate profile index |
| 10 | 2 | unsigned row count, capped at 256 by protocol version 1 |
| 11 | variable | canonical rows in strictly increasing field-id order |

Each row is:

| Bytes | Meaning |
| ---: | --- |
| 2 | unsigned field identifier; zero is forbidden |
| 1 | scalar type identifier |
| 1 | value byte length, which must equal the type's fixed width |
| N | canonical scalar bytes |

Protocol version 1 scalar types are:

| Type id | Type | Width | Encoding |
| ---: | --- | ---: | --- |
| `0x01` | boolean | 1 | exactly `0x00` or `0x01` |
| `0x02` | unsigned 8-bit | 1 | binary |
| `0x03` | unsigned 16-bit | 2 | big-endian |
| `0x04` | unsigned 32-bit | 4 | big-endian |
| `0x05` | signed 16-bit | 2 | big-endian two's complement |
| `0x06` | signed 32-bit | 4 | big-endian two's complement |

The commitment is the 32 raw bytes of
`SHA-256(canonical-preimage)`. Text representations below use lowercase hex
only. The nonce is part of the preimage, so identical configurations in two
accepted sessions do not create a stable per-aircraft binding digest.

## 6. Start-of-session Blackbox evidence

A conforming session contains each of these unique `H` keys exactly once:

```text
H rl_binding_protocol:1
H rl_binding_hash:sha256
H rl_binding_nonce:<32 lowercase hex digits>
H rl_binding_manifest:<registered machine token>
H rl_binding_commitment_0:<first 32 lowercase hex digits>
H rl_binding_commitment_1:<last 32 lowercase hex digits>
H rl_binding_generation:<canonical unsigned 32-bit decimal>
```

The two commitment halves are required because one 64-hex-digit value would
exceed the reviewed writer's approximately 64-byte header-line reservation.
Half 0 is the first 16 digest bytes and half 1 is the last 16; both unique lines
must be present and are reassembled before comparison.

The ordinary `Firmware revision` and target evidence must select the same exact
source-reviewed commit and target used in the commitment preimage. Short commit
text is resolved only through the closed manifest registry; it is not accepted
as a caller-supplied full commit.

Missing, duplicated, malformed, unterminated, mutable/lookalike, or unreviewed
header evidence is unavailable, never a partial success. Legacy sessions simply
have no binding evidence.

## 7. Terminal seal

Immediately before the exact `FLIGHT_LOG_EVENT_LOG_END`, firmware writes exactly
one `FLIGHT_LOG_EVENT_CUSTOM_DATA` event (event 100). Its length-delimited payload
is exactly 60 bytes:

| Bytes | Meaning |
| ---: | --- |
| 4 | ASCII magic `RLB1` |
| 2 | big-endian protocol version `0x0001` |
| 1 | algorithm id `0x01` (SHA-256) |
| 16 | start nonce |
| 32 | start commitment |
| 4 | current unsigned generation, big-endian |
| 1 | flags; bit 0 is sticky scoped-mutation invalidation, bits 1-7 must be zero |

A seal record is 63 encoded bytes (`E`, event id, length, and 60-byte payload),
and the exact `LOG_END` record is another 13 bytes. These 76 consecutive encoded
bytes exceed the guarantee of the reviewed byte-at-a-time shutdown writer, which
can drop output when transmit space is exhausted. A conforming implementation
must first atomically transition from running to sealing under the same
synchronization protocol used by scoped writers. That transition is the logical
terminal boundary: it disables every further body/event record and captures an
immutable generation/flags snapshot. A mutation linearized before the boundary
must appear in that snapshot; one linearized afterward is outside the closed
session. Body logging may never resume after the boundary.

The implementation must then use a reserved or resumable terminal-write state:
it advances only after each byte is accepted, permits no intervening record,
confirms the complete pair has been flushed, and only then closes the backend.
Failure to complete or flush that state leaves the session unbound.

A valid seal has flags zero and exactly matches the header nonce, commitment,
protocol, algorithm, and generation. No frame or event may occur between the
seal and `LOG_END`. A duplicate magic payload, wrong length, unknown bit, changed
then restored setting, generation wrap, logging-resume gap, rejected/resynchronized
record, resource stop, truncation, bytes after `LOG_END`, or missing seal prevents
binding.

Using the existing length-delimited custom-data envelope avoids silently assigning
an unreviewed global event id. A future firmware implementation still needs a
source-pinned serializer audit and an independently captured log; RotorLens must
not infer support from a synthetic writer alone.

## 8. Future verification boundary

No verifier is implemented in Phase 2E. A later implementation must consume one
genuine decoder-registered result, one session index, the decoder's exact input
byte length, and one canonical collector snapshot. It must obtain header,
terminal, and body evidence for that same private registered session. It must not
join the current Phase 2C report to the current Phase 2D report: those categorical
reports intentionally retain no shared identity, and Phase 2C can be given a
different parsed header than Phase 2D's body.

The only positive binding state may require all of the following:

- a valid collector snapshot under the exact registered manifest;
- a source-reviewed firmware implementation of this protocol;
- exact snapshot/start/terminal nonce and commitment agreement;
- exact start/terminal generation agreement and zero sticky mutation flag;
- one clean, continuous, fully decoded session ending at the exact `LOG_END`;
- no observed in-flight adjustment and no event-coverage gap.

A future report remains categorical and must not echo or retain the nonce,
commitment, firmware/board identity, generation, row, offset, timestamp, path,
name, or event payload. Even a positive binding report remains configuration-
incomplete and has `complete`, `cohortEligible`, `adviceEligible`, and
`modelEligible` set to `false` until separately reviewed phases change those
contracts.

## 9. Independent canonical vector

This vector exercises every scalar type. Its manifest identifier is test-only;
the synthetic commit is not a supported firmware claim.

```text
protocolVersion = 1
hashAlgorithmId = 1 (SHA-256)
nonce = 000102030405060708090a0b0c0d0e0f
firmwareCommit = 00112233445566778899aabbccddeeff00112233
target = STM32F7X2
manifest = rotorlens-binding-vector-v1
activePidProfile = 2
activeRateProfile = 4
rows =
  0001 bool true
  0002 u8   6
  0003 u16  1500
  0004 u32  200000
  0005 i16  -120
  0006 i32  -50000
```

Canonical preimage hex:

```text
526f746f724c656e732062696e64696e67207631000101000102030405060708090a0b0c0d0e0f00112233445566778899aabbccddeeff001122330953544d3332463758321b726f746f726c656e732d62696e64696e672d766563746f722d763102040006000101010100020201060003030205dc0004040400030d4000050502ff8800060604ffff3cb0
```

SHA-256 digest:

```text
fb7eef68a7f7b68917657726b37129bbdabc37088098eb1bf1cff6e1b63ae494
```

`test/community-config-binding-protocol.test.mjs` independently rebuilds the
binary preimage from the semantic fields, compares it with the fixed byte vector,
and recomputes the fixed digest with the platform SHA-256 implementation.

## 10. Stop condition and non-goals

Phase 2E stops at this draft and its independent vector. There is no production
protocol identifier or caller. Work must not proceed to a positive runtime
inspector until both exist:

1. a reviewed Rotorflight firmware commit implementing the full manifest,
   mutation generation, headers, and terminal seal; and
2. an independently captured real log proving the firmware wire bytes, including
   at least one invalidated configuration-change case.

That later change requires source conformance tests, measured firmware resource
cost, and a fresh review. It must not silently widen the six existing release
pins.

Explicit non-goals of this phase are a RotorLens USB/serial/MSP connection,
flight-controller write path, Configurator implementation, app or Android UI,
history storage, contract/model/recommendation caller, Internet permission,
network service, upload/download path, firmware attestation, anti-poisoning,
complete community configuration schema, or phone installation/testing.
