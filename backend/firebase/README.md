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
App Attest flows, publish correct privacy/store declarations, and obtain an
explicit deployment review.
