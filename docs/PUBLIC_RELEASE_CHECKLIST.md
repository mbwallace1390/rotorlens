# Public release checklist

This checklist is a gate, not a claim that RotorLens is already published or
that an unsigned CI artifact is an official release.

## Before changing repository visibility

- [ ] Review every advertised branch and tag; delete or archive obsolete refs.
- [ ] Run a full-history secret and privacy scan across every advertised ref.
- [ ] Confirm no raw or identifying flight log is reachable without the licence,
      consent, and sidecar required by `docs/FIXTURE_POLICY.md`.
- [ ] Decide whether historic author email addresses and removed third-party
      fixture objects are acceptable in the public record.
- [ ] Remove workstation paths, device addresses, signing material, and private
      corpus locations from tracked documentation and tests.
- [ ] Verify the root licence, generated in-app legal data, package metadata,
      README, notices, and parser metadata agree.
- [ ] Review the RotorLens name and logo for trademark clearance. Do not use the
      registered mark symbol unless a registration exists.

History rewriting is destructive and does not erase old clones or cached object
URLs. It requires a separate decision, a backup, and verification from a fresh
clone; this checklist does not authorize it.

## Public repository settings

- [ ] Protect `main` with a ruleset requiring the complete CI workflow and
      resolved conversations; block force-pushes and branch deletion.
- [ ] Enable secret scanning, push protection, dependency alerts and security
      updates, code scanning, and private vulnerability reporting.
- [ ] Keep workflow tokens read-only by default and never use
      `pull_request_target` to execute fork code.
- [ ] Confirm pull requests cannot access Android signing secrets or publish an
      artifact represented as an official RotorLens build.

## Official releases

- [ ] Choose the stable Android application ID and iOS bundle ID before the first
      store release; changing either later breaks normal update continuity.
- [ ] Build from a protected, signed semantic-version tag.
- [ ] Put signing credentials in a protected environment or sign offline. Never
      commit a keystore, certificate private key, or password file.
- [ ] Publish the APK/AAB hashes, signing-certificate fingerprint, exact source
      tag/archive, build instructions, third-party notices, and a standard
      SPDX/CycloneDX software bill of materials.
- [ ] Generate and verify build-provenance attestations for downloadable binaries.
- [ ] Treat the existing debug APK as a tester artifact, never an official release.

## Contributions and flight data

- [ ] Code contributors have accepted the project's inbound licence and DCO.
- [ ] Public issue templates warn against attaching raw logs, configuration
      dumps, location data, filenames, device identifiers, or pilot/craft names.
- [ ] Community-measurement terms have been formally reviewed and adopted under
      production identifiers before any contribution is solicited or accepted.
- [ ] Source availability does not imply that raw logs, individual measurement
      envelopes, a corpus, or model weights are publicly licensed.

## Device release checks

- [ ] Run the full Node/browser/Android suites from a clean checkout.
- [ ] Install the release candidate on a supported phone and repeat the core flow:
      import, session selection, analysis, history, sharing-state erase, and Legal.
- [ ] Verify the merged release manifest and packaged assets, not only source files.
- [ ] Repeat the equivalent flow on iPhone/iPad before claiming platform parity.
