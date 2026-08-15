# Licensing boundary

The patch in this directory contains Rotorflight source expression and is not
covered by RotorLens' root MPL-2.0 license. Every added source file retains the
Rotorflight header granting redistribution and modification under GPL version 3
or, at the recipient's option, any later version. The manifest therefore
records the patch expression as `GPL-3.0-or-later` with
`source-file-headers` as its basis.

The pinned upstream repository does not publish an authoritative SPDX
expression. `upstreamDeclaredSpdx` remains null rather than converting the
presence of a GPL version 3 license text into a repository-declared SPDX claim.

[`LICENSES/GPL-3.0.txt`](LICENSES/GPL-3.0.txt) is byte-identical to `LICENSE` at
upstream commit `118e9120260bb33f46df4f92052fb0e9fd4e9ebc`:

- Git blob: `f288702d2fa16d3cdf0035b15a9fcbc552cd88e7`
- byte length: 35,149
- SHA-256: `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`

The exact upstream repository and base commit, complete patch bytes, touched
blob identities, and result tree are recorded in `artifact-manifest.json` and
verified in CI. No compiled firmware binary is distributed here. The
RotorLens-authored manifest, schema, and explanatory documentation do not
relicense the firmware-derived patch.

This file records an engineering boundary and source provenance, not legal
advice.
