# Rotorflight firmware integration evidence

This directory is a non-shipping review boundary for a possible Rotorflight
firmware implementation of RotorLens' configuration-to-flight binding protocol.
It is not firmware source, an app dependency, or a runtime support registry.

Only the versioned `binding-v1/` directory may contain protocol identifiers or,
after a separate review, GPL-covered patch context. Keeping that exception at
one exact path lets the rest of RotorLens retain its strict no-firmware-code and
no-flight-controller-control boundaries.

The current contents are a pinned Phase 2H-A partial source candidate: a GPL-
covered patch against one exact Rotorflight base, its license and provenance,
and bounded host tests for SHA-256, content-only semantic validation and row-TLV
encoding of a caller-provided immutable 103-byte value buffer, and an isolated
task-context mutation-epoch primitive. The primitive has an unsigned 32-bit
even/odd generation, nested 16-bit depth, pre-wrap permanent fault sentinel,
and a separate sticky fault bit whose stale-write defense is modeled in its host
test. It has zero production callers, scoped writer hooks, or capture consumers.
Generation zero proves nothing while those integrations are absent.

The validator covers every registered scalar domain and the source-reviewed
cross-field rules and rejects invalid input before calling the writer. Nothing
reads or captures live firmware state, creates or synchronizes a snapshot,
proves the buffer's origin or stability, or provides a complete binding
implementation or runtime support entry. See
[`binding-v1/README.md`](binding-v1/README.md) for the facts it proves and the
acceptance gates that remain deliberately closed.
