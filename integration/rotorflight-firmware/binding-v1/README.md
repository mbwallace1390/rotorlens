# Binding protocol v1 firmware artifact boundary

Status: **partial source candidate only**. This directory now contains one
GPL-covered patch against Rotorflight 4.6.0 plus its exact license text. The
patch implements a streaming SHA-256 primitive, an immutable 90-row TLV
registry, and content-only semantic validation and row-TLV encoding of a
caller-provided immutable 103-byte value buffer. It also implements an isolated
task-context mutation-epoch primitive with nested outer-boundary transitions and
a permanent fail-closed state before unsigned 32-bit wrap. It is not a complete
configuration-to-flight binding implementation.

This remains the sole non-shipping directory in which the draft
`rl_binding_*` firmware protocol identifiers or firmware-derived patch bytes
may appear. The RotorLens app does not compile, package, load, or execute this
directory. Required CI alone applies the patch to a separate exact upstream
checkout and runs three bounded host tests. Nothing adds USB, serial, MSP,
Bluetooth, flight-controller write, Android, WebView, network, model, advice,
or runtime-inspection behavior.

## Pinned source transformation

`artifact-manifest.json` and its closed schema record:

- upstream commit `118e9120260bb33f46df4f92052fb0e9fd4e9ebc` and tree
  `7821f5ac9c18da9fb31844b3a9be4b1a77caac11`;
- the exact 89,537-byte patch, SHA-256
  `0bcb2f89bc9b6af3b2953952a3e015954511c71a8c718fd0b022cde47594cb6f`, every
  one of its ten base and result blob identities, and applied result tree
  `635c01e76fad457114bfbc8a11a7a42e2e115518`; and
- candidate manifest token `rotorlens-rf460-config-r1`, whose validator checks
  every registered scalar domain and the source-reviewed cross-field rules
  before any writer call, then emits 90 ordered TLVs from 103 value bytes into
  463 bytes, in writes no larger than six bytes.

The patch uses full Git object identifiers. CI applies it with `git apply
--index` and no three-way fallback, checks the exact changed-path set, and
requires the resulting index tree to equal the pinned result tree.

There is deliberately no `implementationCommit`. The result tree reconstructs
one reviewable partial source state, but a tree is not a clean public firmware
commit and cannot be substituted for the `firmwareCommit` in the protocol
preimage or in a Blackbox session.

## What the host checks prove

The bounded host gate runs only:

```text
make -C upstream-firmware/src/test CC=clang-18 CXX=clang++-18 LDFLAGS= V=1 test_sha256_unittest test_rotorlens_binding_manifest_unittest test_rotorlens_config_mutation_epoch_unittest
```

Those tests cover fixed SHA-256 vectors and boundaries, the immutable row
registry, the complete 90-row domain mapping and its domain-class boundaries,
the source-reviewed rate, governor, and signed-mixer cross-field rules, input
nonmutation, an independently fixed row-TLV vector, structural and semantic
rejection before a writer call, and the requirement to discard a partially
written sink after writer failure. The epoch test covers no-op generation
advance, all representable 16-bit nesting depths, outer-only transitions,
pre-wrap saturation, API and interrupt-context misuse, simulated PRIMASK
restoration and publication points, and a separate sticky fault bit across
modeled NMI/HardFault stale-write races. The empty `LDFLAGS` override keeps
these three leaf tests independent of the upstream test harness's unused
BlocksRuntime and parameter-group linker options.

This is a host source-conformance check, not an ARM target build, binary
identity, real Cortex-M DMB/PRIMASK/IPSR execution, concurrency proof, resource
measurement, timing measurement, or firmware toolchain claim. The
`SIMULATOR_BUILD` branches are compile-portability shims, not a mutex and not
proof for multithreaded SITL. Rotorflight's source wildcard would include the
epoch C file in a target build, but this artifact provides no target-family
compile evidence.

The validator is content-only: it does not normalize input, read or capture
live firmware settings, create or synchronize a snapshot, or prove the
caller-provided buffer's origin, profile identity, mutation generation,
atomicity, or stability. The encoder does not write the domain separator,
protocol or algorithm fields, nonce, firmware commit, target, manifest token,
profile indices, or row-count prefix. It does not hash a full commitment,
publish or consume a one-use token, emit Blackbox headers, or write an atomic
terminal seal.

The epoch primitive likewise has zero production callers, scoped writer hooks,
or capture consumers; CI checks that its public symbols occur only in its own C
file and header under `src/main`. Generation zero, or any other even value,
proves nothing while every relevant writer is not covered. A future capture
layer would have to accept only equal before/after, even, non-fault samples. A
latched epoch failure must disable RotorLens trusted capture only and must never
abort, roll back, or otherwise alter the user's normal configuration mutation.

## Acceptance stop

The version-4 artifact schema accepts only this partial state. It requires an
empty firmware-target list, an empty runtime-accepted manifest list, null
resource and terminal evidence, no wire captures, and
`runtimeAcceptance: false`. Production acceptance registries remain empty, so
every current session remains unavailable for configuration-to-flight binding.

A later, separate source change may become eligible for runtime review only
after all gates in
[`CONFIG_FLIGHT_BINDING_PROTOCOL.md`](../../../docs/CONFIG_FLIGHT_BINDING_PROTOCOL.md)
are satisfied: one clean public full implementation commit, exact target build
and measured resource bounds, mutation and terminal atomicity proof, and
independently captured clean plus invalidated real-hardware logs. This artifact
does not satisfy or waive any of them.

## Rollback

This partial candidate has no app or installed-firmware behavior to roll back.
Removing the patch, manifest state, and its CI job removes the review artifact.
Any future firmware implementation must keep pending/session binding state
RAM-only so reboot or reflashing official firmware removes it. RotorLens must
never reinterpret older logs or widen support to a nearby version.

See [`LICENSING.md`](LICENSING.md) for the GPL boundary.
