# Contributing to RotorLens

Thank you for helping improve RotorLens. The project welcomes focused,
well-tested contributions that preserve its safety, privacy, provenance, and
licensing boundaries.

## Before starting

1. Search existing issues and pull requests.
2. Open an issue before a large change, a new dependency, a protocol change, or
   anything affecting tuning advice, community learning, privacy, licensing,
   app signing, or project branding.
3. Read the relevant architecture and policy documents under `docs/`.
4. Never post sensitive flight or configuration data. See **Data privacy**
   below.

Small documentation corrections and narrowly scoped fixes may go directly to a
pull request.

## Licensing: inbound equals outbound

Unless a file contains a different license notice, RotorLens-authored files are
covered by the Mozilla Public License 2.0 (`MPL-2.0`). By submitting a
contribution to an MPL-2.0-covered file, you agree to provide that contribution
under MPL-2.0—the same license used for that covered file.

Some directories or files contain third-party material or separately licensed
integration artifacts, including GPL-covered firmware work. Contributions to
those areas follow the license identified in that file or directory. Preserve
copyright, provenance, and license notices. Do not copy material between
different licensing boundaries unless the licenses and provenance have been
reviewed first.

The project does not require copyright assignment. You retain copyright in
your contribution, subject to the license you grant by contributing it.

## Developer Certificate of Origin

Every non-merge contribution commit must certify the
[Developer Certificate of Origin 1.1](DCO),
reproduced verbatim from
[developercertificate.org](https://developercertificate.org/). Add a sign-off
with Git:

```text
git commit --signoff
```

The commit must contain a trailer in this form:

```text
Signed-off-by: Your Name <your-email@example.com>
```

Use a name and email address that identify you as the person making the
certification and that you are willing to have recorded publicly. The sign-off
certifies the DCO; it is not a transfer of copyright. Do not add an AI system as
a signatory or co-author.

In the retained private-development history, CI enforces this for every
non-merge commit after the pre-public migration baseline
`a222ba1e556b61ac46b7f28bceeef4a00178fc3e`. Earlier private-development
commits predate this contribution policy and are intentionally grandfathered.
If that baseline is not an ancestor of the selected head—as with a fresh public
root—the checker fails closed and verifies every reachable non-merge commit.
Set `ROTORLENS_DCO_HEAD` to check a prospective public-history ref before it is
published. Merge commits created only to combine already certified commits are
exempt; do not hide substantive conflict-resolution changes in a merge-only
commit.

## AI-assisted contributions

AI-assisted work is allowed, but the submitting human is responsible for it.
In the pull request:

- disclose material AI assistance and the tool or workflow used;
- confirm that you reviewed every submitted line and can explain the change;
- verify that the output did not copy code, prose, fixtures, or assets of
  uncertain provenance; and
- run the same tests and safety review expected for human-drafted work.

AI output is not evidence that a change is correct, original, or compatible
with the project's licenses.

## Data privacy

Do **not** attach, paste, commit, or link to:

- raw flight or Blackbox logs;
- flight-controller or transmitter configuration dumps;
- GPS coordinates, home positions, timestamps, or location traces;
- device serials, radio or aircraft identifiers, account identifiers, or other
  persistent identifiers; or
- private filenames, filesystem paths, credentials, keys, or personal data.

This rule applies to issues, pull requests, discussions, test output, commits,
and external paste or file-sharing links. Use the committed synthetic fixtures
or add a generator for the smallest synthetic reproduction. The source-code
license and DCO do not authorize collection or publication of anyone's flight
data.

If you accidentally disclose sensitive data, do not merely edit the public
comment. Contact the maintainers using the private process in
[SECURITY.md](SECURITY.md) so cached copies and repository history can be
assessed.

## Development and testing

- Keep changes small and at the narrowest responsible layer.
- Preserve the parser contract, deterministic analysis, and no-network privacy
  boundary unless an approved design explicitly changes them.
- Add regression coverage for behavior changes and negative coverage for every
  safety gate or parser refusal path affected.
- Run `npm run check:syntax` and `npm test` before submitting.
- Run the relevant Android, generated-file, privacy, licensing, and fixture
  checks shown in the repository's CI workflow when your change touches those
  areas.
- Test user-visible mobile behavior on an appropriate device when possible;
  browser automation alone does not prove touch, layout, file-picker, or
  platform behavior.

Do not weaken or delete a guard merely to make a test pass. Explain any test you
cannot run and why.

## Pull requests

A pull request should:

- explain the problem, chosen boundary, and user-visible result;
- list the exact validation performed;
- identify safety, privacy, compatibility, licensing, and migration effects;
- disclose new dependencies and third-party material;
- include DCO sign-offs on every commit; and
- avoid unrelated formatting or refactoring.

Reviewers may request a synthetic reproduction, stronger refusal behavior,
additional device proof, or a narrower change. Acceptance is not guaranteed,
and maintainers may decline changes whose safety or long-term maintenance cost
cannot be justified.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md)
and [project governance](GOVERNANCE.md).
