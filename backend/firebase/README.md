# RotorLens Firebase emulator boundary

This directory is a **local emulator proof**, not a deployed service. It uses
the reserved `demo-rotorlens` project id, has no `.firebaserc`, has no deploy
script, and requires no Firebase login or credentials.

What it proves:

- callable definitions require App Check;
- direct Firestore client reads and writes are denied;
- submission runs the shared app audit, then the current draft is refused with
  `PRODUCTION_INGESTION_CLOSED` and zero writes;
- deletion mechanics are exercised only against synthetic records seeded by the
  privileged emulator test, and leave a replay-blocking tombstone;
- a separate 256-bit deletion capability removes one aircraft's seeded records
  without exposing that capability in Firestore;
- public statistics count only validated records, hide populations below five,
  and never describe quarantine records as users or learning data;
- every exported callable requires the Functions emulator, the exact
  `demo-rotorlens` project, and Firestore at `127.0.0.1:8080`; an accidental
  cloud deployment or Functions-only emulator remains closed with
  `BACKEND_NOT_ACTIVATED`.

What it does **not** prove or enable:

- no Firebase project is selected, created, billed, or deployed;
- no Android or iOS app caller, Firebase SDK, `INTERNET` permission, upload,
  analytics, raw-log intake, model build, advice, or public counter is added;
- App Check emulator behavior is not device attestation proof;
- a public Firebase client configuration is routing metadata, not permission to
  submit; a production service must default to registered official RotorLens
  builds attested with Play Integrity on Android and App Attest on Apple
  platforms;
- a separately signed modified build must remain closed unless its maintainer is
  explicitly enrolled with a reviewed app identity, terms, schema, quotas, and
  quarantine policy; pointing a fork at its own backend does not contribute to
  the RotorLens corpus;
- no production terms, complete configuration schema, accepted contribution,
  production receipt, validated flight, or training corpus exists;
- the Functions source imports the shared app contract from outside the
  Functions directory, so this emulator scaffold is intentionally not a
  production deployment artifact.

Run the bounded proof from the repository root:

```text
npm ci --prefix backend/firebase
npm ci --prefix backend/firebase/functions
npm test --prefix backend/firebase
```

The first emulator run downloads the official Firestore emulator. Java 21 and
Node.js 22 are the supported CI toolchain. A later production phase must adopt
reviewed data terms, complete the configuration contract, choose a dedicated
Firebase project, add IAM and retention controls, test real Play Integrity and
App Attest flows, keep release-signing and debug credentials private, publish
correct privacy/store declarations, and obtain an explicit deployment review.

## Dependency audit status

CI audits the emulator tooling and the separate Functions graph in separate
steps. The Functions audit runs even when the emulator audit fails, and either
one failing fails the job. A weekly scheduled run audits `main` as well, so a
newly published advisory shows up there instead of on the next unrelated pull
request. Run the same checks locally:

```text
npm audit --audit-level=high --prefix backend/firebase
npm audit --omit=dev --audit-level=high --prefix backend/firebase/functions
```

On October 3, 2026 both exit 0. The Functions graph reports no advisories, and
the emulator graph reports five moderate ones and nothing high. Upstream
releases alone did not get it there. The October 2 refresh of the top-level
pins left three high advisories that no compatible release fixed, so
`package.json` forces three transitive versions with npm `overrides`:

- **`@grpc/grpc-js` 1.14.5.** `@firebase/firestore` 4.17.2 (inside `firebase`
  12.19.0) requires `~1.9.0`, and every 1.9 release is affected by
  [GHSA-m9gg-hp2v-232j](https://github.com/advisories/GHSA-m9gg-hp2v-232j) and
  [GHSA-f596-whhp-79r4](https://github.com/advisories/GHSA-f596-whhp-79r4)
  (fixed in 1.13.6). Firebase CLI's own `google-gax` already resolved 1.14.5,
  so the override leaves one copy in the graph instead of two.
- **`basic-ftp` 6.2.1.** It is reached only through Firebase CLI, `proxy-agent`,
  `pac-proxy-agent` and `get-uri` 6.0.5, which asks for `^5.0.2`.
  [GHSA-c475-qrg2-pj4r](https://github.com/advisories/GHSA-c475-qrg2-pj4r)
  covers everything up to 6.2.0. `get-uri` calls only `Client`, `access`,
  `lastMod`, `list`, `downloadTo` and `close`, all still present in 6.x, and
  only to fetch an `ftp://` proxy auto-config script, which this proof never
  does.
- **`chokidar` 4.0.3.** Firebase CLI asks for `^3.6.0`, and chokidar 3 depends on
  `braces`. [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
  covers every `braces` release up to 3.0.3, which is the newest one published,
  so the only way past it is to drop the dependency. chokidar 4 has no `braces`
  dependency. It also stopped supporting glob patterns, so the `**/<ignore>`
  strings the Functions emulator passes to its file watcher are now matched as
  literal paths. The emulator's regular-expression exclusions still cover
  `node_modules`, dotfiles and `.log` files, and the watcher only reloads
  triggers when a source file changes.

All three are major-version jumps under the CLI and the SDK, so only the
emulator proof can show they still work. `npm test --prefix backend/firebase`
passed locally with all three in place on October 3, 2026: 6 static and 8
emulator tests. That run used a Node 26 host, not CI's Node 22.23.2, so CI's run
of the same step is the one to trust. Re-run the proof after any change to the
overrides. Remove an override once upstream asks for a fixed version itself;
`npm ls <name>` prints `overridden` for as long as one is still doing something.
If a later Firebase CLI breaks under chokidar 4, drop only that override and have
the audit step skip exactly GHSA-vfj7-8cjw-p6xm. Do not lower the threshold.

Keep the audit gate enabled. None of these packages, overridden or not, reaches
the mobile app. Any further upstream update needs a new dependency review and a
new emulator proof.
