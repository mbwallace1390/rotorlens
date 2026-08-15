# RotorLens governance

## Project leadership

RotorLens was founded and originally created by **Michael Wallace**
([@mbwallace1390](https://github.com/mbwallace1390)), who serves as lead
maintainer. The lead maintainer is the final decision-maker for the official
repository, official releases, safety claims, privacy boundaries, release
signing, and use of the RotorLens branding. This authority concerns the
official project only; it does not restrict anyone's rights under the
open-source licenses.

The lead maintainer may appoint or remove maintainers, delegate areas of
responsibility, and publish a maintainer list. Contributors become maintainers
through a sustained record of sound technical judgment, respectful community
participation, careful safety and privacy review, and reliable maintenance.

## How decisions are made

Routine decisions are made in public issues and pull requests whenever
security, privacy, or personal data does not require a private channel. The
project prefers evidence, reproducible tests, and rough consensus. Maintainers
may request changes, reject a proposal, or defer it until the project can verify
its safety and maintenance cost.

When consensus is not possible, the lead maintainer makes the decision for the
official project and records the reasoning when it is safe to do so. Changes
that affect tuning advice, log parsing, privacy promises, community learning,
licensing, release signing, or project branding require lead-maintainer review.

## Safety and privacy gate

RotorLens analyzes safety-relevant flight data and may present tuning advice.
No contribution earns acceptance merely because it produces plausible output.
Claims must be bounded by available evidence, failure modes must be explicit,
and the relevant automated and device-level checks must pass.

Public project spaces must not receive raw flight logs, configuration dumps,
GPS or home coordinates, serial numbers, device or aircraft identifiers,
private filenames or paths, or other personal data. Use the committed synthetic
fixtures or create a privacy-reviewed synthetic reproduction. Real-log or
community-data intake requires a separately adopted consent, provenance,
privacy, and data-license process; source-code contribution terms do not grant
rights to flight data.

## Contributions and copyright

Contributions follow [CONTRIBUTING.md](CONTRIBUTING.md), the repository's
applicable license notices, and the [Developer Certificate of Origin 1.1](DCO).
The project uses an inbound-equals-outbound model: a contribution to an
MPL-2.0-covered file is submitted under MPL-2.0, while a contribution to a
separately licensed file or component follows the license identified there.
The DCO is a certification, not a copyright assignment.

Some project work uses AI-assisted tools. A human must remain accountable for
every submission, disclose material assistance, verify provenance, and perform
the required tests. An AI system cannot sign the DCO, hold a maintainer role,
approve a contribution, or be named as an author or copyright holder.

## Conduct, security, and moderation

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security
reports follow [SECURITY.md](SECURITY.md). Maintainers may moderate project
spaces, close unsafe data submissions, and restrict participation to protect
people and the project.

## Governance changes and continuity

Governance changes are proposed by pull request and require approval from the
lead maintainer. The lead maintainer should document delegated authority and
appoint additional maintainers as the community grows. If project leadership
becomes inactive, the open-source licenses continue to permit community forks;
no fork becomes the official RotorLens project or receives rights to RotorLens
branding merely because the official repository is inactive.
