# Fixture policy

Every committed flight log must include adjacent machine-readable metadata and
the license or permission that allows its use and redistribution.

Required metadata:

- original filename and immutable SHA-256;
- byte length;
- source repository or owner;
- exact source commit or acquisition date;
- license or written permission reference;
- declared firmware family/version;
- whether GPS or other identifying fields are present;
- any redaction or transformation performed.

Acceptance rules:

1. Prefer purpose-made synthetic logs or public logs with an explicit permissive
   license.
2. Obtain the pilot/owner's consent before accepting privately supplied logs.
3. Do not commit GPS-bearing logs unless location data is deliberately removed
   and the transformed fixture is independently verified.
4. Keep original licenses and attribution with redistributed fixtures.
5. Pin third-party fixtures to an exact source revision and verify their hashes
   in tests.
6. Cover supported Rotorflight releases, multi-session logs, truncated files,
   damaged frames, absent optional fields, and representative helicopter
   governor/tail/debug modes before claiming compatibility.

## Checking it, rather than remembering it

```
npm run check:donation -- <file-or-directory>
npm run check:donation -- --template      # prints an empty sidecar and its reasons
```

Exit status 0 means every file may be published; 1 means at least one may not.
The metadata above goes in a sidecar named `<file>.donation.json` beside the log.

**A rule that is remembered is a rule somebody in a hurry eventually forgets**,
and rule 3 is the one where forgetting is permanent: a `.bbl` committed to a
public git history carries whatever was in it, forever. The decoder never emits
a coordinate — `GPS_coord[0..1]` and `GPS_home[0..1]` are decoded because the
frame is one packed group and then dropped on the floor — but that is a promise
about what RotorLens **reads**. A committed fixture is the file, not the reading
of it.

What the check refuses, and why in that shape:

- **A recorded position frame, by frame type, whatever value it holds.** It never
  reads a coordinate to decide. Clearing a log by checking that its coordinates
  look harmless would mean surfacing coordinates in order to prove a log has
  none, and the first tool to do that is the tool that leaks one. One frame is
  enough; the threshold is not a quantity.
- **Anything it could not scan end to end** — an unreadable header, a stream it
  could not follow, a file that is not a log. It fails closed. A location check
  that passes because it could not look is worse than no check at all, because
  it prints a green line beside a file nobody then examines.
- **A missing or incomplete sidecar**, field by field, each named.
- **A sidecar describing different bytes** from the file beside it.
- **A sidecar that contradicts the log** — `identifyingFieldsPresent: "none"` over
  a log with 675 GPS frames. That is the failure a human reviewer does not catch,
  because the reviewer reads the sidecar and believes it.

Declaring location fields in the header without ever recording one is a
**warning**, not a refusal: `fixtures/synthetic/rf46-gps-declared.TXT` exists
precisely to exercise location-field detection and carries no position. So does a
craft name — it is identifying, so the policy asks for it to be **declared**
rather than removed.

`test/donation-check.test.mjs` exercises the refusal on a log that really does
carry position frames, built at test time by splicing zero-coordinate `G` frames
into the GPS-declaring fixture. That is deliberate: a check whose refusal path is
never reached in the default suite is indistinguishable from one that works.

## Current inventory

Fifteen generated fixtures in `fixtures/synthetic/`, written by
`tools/generate-fixtures.mjs` and pinned by SHA-256 in
`fixtures/synthetic/manifest.json`, which `test/provenance.test.mjs` reproduces
byte-for-byte. They carry no third-party copyright. Their scope and limits are
recorded in the manifest's own `payloadNote`.

No real log is currently committed in `fixtures/real/`. Two logs that had been
present without sidecars were removed on 14 August 2026: a clean privacy scan is
not redistribution permission, and inventing metadata would have made the record
worse. Default tests now use generated fixtures; real-firmware and corpus checks
accept owner-supplied paths through environment variables.

On 14 August 2026 every published branch was rewritten, and a fresh mirror
verified that neither path nor either blob is reachable from an advertised ref.
That does not erase old clones or cached commit URLs; GitHub Support may still be
needed to purge server-side caches. Treat any remaining copy as sensitive: a
history rewrite does not retroactively supply redistribution consent.

`npm test` scans every committed real-log fixture through the publication gate,
and CI also runs `npm run check:donation -- --allow-empty fixtures/real` directly.
An empty directory is valid; the moment a log-looking file is added, the normal
sidecar, hash, provenance, permission, and location checks all apply and fail
closed.

Logs recorded by the project owner remain the preferred addition: fully owned, no
attribution, no consent question. Prefer them over any third-party corpus even
when its license permits reuse — a permissive license is still an obligation
attached to a test file.

## Donated logs that are used but never committed

Most donations will be measured and never published, which is a different thing
from being published, and the difference is worth stating so it does not get
blurred later:

- A log **measured locally** by `npm run corpus:report` never enters the
  repository. What comes out is `tools/corpus/measure.mjs`'s fixed shape —
  documented field by field in `CORPUS_FIELDS`, with `NEVER_REPORTED` listing
  what may not appear and `auditCorpusMeasurement` enforcing both by inspection.
  No craft name, no date, no path, no coordinate.
- A log **committed as a fixture** is redistribution. That needs everything on
  this page, including permission in writing for that specific file.

Asking for a `.bbl` in a chat window gets you the first. It does not get you the
second, and treating it as though it did is how a project ends up unable to say
where a file came from.
