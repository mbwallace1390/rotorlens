# RotorLens security policy

## Supported versions

Until stable releases are published, security fixes target the latest version
of the default branch. Older commits, development branches, unofficial builds,
and modified distributions are not guaranteed to receive fixes. This policy
will be updated when release support windows exist.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability, exposed secret,
privacy bypass, malicious-log crash, update or signing problem, or a flaw that
could cause unsafe tuning advice.

Use GitHub's **private vulnerability reporting** form:

<https://github.com/mbwallace1390/rotorlens/security/advisories/new>

Repository administrators must keep private vulnerability reporting enabled for
that path. If GitHub cannot accept the report, email
[mbwallace1390@gmail.com](mailto:mbwallace1390@gmail.com) with the subject
`RotorLens security report` and only enough detail to establish a private
follow-up channel.

## Protect flight and configuration data

Do not attach or paste raw flight logs, controller or transmitter configuration
dumps, GPS or home coordinates, timestamps, device serials, aircraft or account
identifiers, credentials, signing material, private filenames, or filesystem
paths—even in a private report. Start with a minimal description and use a
committed synthetic fixture or synthetic reproduction whenever possible. The
maintainer will arrange a specific secure process if additional evidence is
both necessary and legally authorized.

If sensitive data was accidentally committed or posted, report the exact URL or
commit identifier privately without repeating the sensitive content. Deleting
or editing a comment does not necessarily remove cached copies or Git history.

## What to include

- the affected version, commit, platform, and component;
- the impact and realistic threat or safety scenario;
- minimal reproduction steps using non-sensitive synthetic data;
- whether the issue is already public or known to another project; and
- any suggested mitigation, if available.

Please avoid destructive testing against systems or data you do not own or have
permission to test.

## Response and disclosure

The maintainers aim to acknowledge a complete report within seven days, but
this is a volunteer project and not a service-level guarantee. The project will
validate the report, coordinate a fix and release when appropriate, and credit
the reporter if requested and safe. Please allow reasonable time for a fix
before public disclosure and coordinate disclosure timing with the maintainer.

Reports about Rotorflight or another upstream project that do not affect
RotorLens may need to be redirected to that project's own private security
process.
