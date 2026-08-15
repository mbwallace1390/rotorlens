# RotorLens Phase 1 manual contribution terms — engineering draft

These terms cover a deliberate, out-of-band contribution to RotorLens's private
Phase 1 community-learning corpus. They do **not** turn on networking in the app
and do not authorize automatic collection.

Draft technical identifiers:

- consent: `community-manual-consent-2026-08-14-v1`
- licence: `community-manual-licence-2026-08-14-v1`

These identifiers are recognized only by development fixtures. The production
consent and licence registries are empty, so an envelope carrying either draft
identifier fails production validation. A future adopted text must receive new
identifiers. A matching string inside a file would never be proof of agreement:
the operator must give the contributor the complete adopted text, receive an
affirmative acceptance, and keep the receipt separately from the measurement
corpus.

## What is contributed

The contributor chooses to hand RotorLens an audited JSON measurement envelope.
It may contain:

- random pseudonymous aircraft and contribution identifiers;
- Rotorflight board target, supported firmware revision, rate-curve fingerprint,
  installed gains, flight-window duration, and ordinal;
- per-axis headspeed, hold, stop, tracking, and filtered/unfiltered vibration
  summaries;
- rotor diameter in millimetres, blade count, power type, and cyclic/tail
  servo size classes;
- versioned one-way prototype fingerprints of filter and governor
  configuration. The current schema canonicalizes a deterministic,
  type-tagged, key-sorted settings map, but its coverage is explicitly
  `incomplete`: it has no approved required-key manifest and therefore can
  never make a record cohort- or advice-eligible;
- the mechanical-safety result;
- whether settings came from manual or RotorLens guidance, whether any community
  output influenced them, and the applicable model version; and
- for a controlled test, the exact pseudonymous baseline contribution plus the
  intended axis, P/I term, and relative direction.

The envelope does not contain the raw flight log, craft name, local aircraft key,
record ID, filename, filesystem path, GPS/location, flight date, or log-start
time. RotorLens audits the fixed allowlist before the envelope is eligible, but
pseudonymous does not mean impossible to recognize: unusual equipment and a
persistent aircraft identifier may be linkable by someone with outside
knowledge.

These terms do not cover a raw `.bbl` donation. If a raw log is requested for a
separate debugging study, that request needs its own scope and receipt.

## Consent to process

By affirmatively accepting these terms and handing over the envelope, the
contributor consents to RotorLens storing, validating, grouping, and analysing
the listed measurements for Phase 1 research and for improving RotorLens. The
current app cannot transmit them; the contributor or operator transfers the
file manually.

Participation is optional. Refusing has no effect on use of the app. The
contributor may request deletion of their individual envelopes using the receipt
described below. Deletion stops future use of those individual records, subject
to the aggregate limitation below.

## Licence

The contributor keeps ownership of their measurements. They grant RotorLens a
non-exclusive, worldwide, royalty-free licence to store, validate, analyse, and
modify the contributed envelope and to create derived statistics, thresholds,
evaluation results, and model parameters from it. RotorLens may use and
distribute those derived results in free releases and releases offered for a fee.

Individual contribution envelopes are not licensed for public release or
transfer to third parties. Publishing the corpus or sharing individual records
with the Rotorflight project would require a separate grant.

Deleting an individual envelope cannot remove its influence from an aggregate
or model already calculated and released without retaining the deleted record.
Previously calculated aggregate results may therefore remain. Deleted records
must be excluded from later retraining.

## Manual receipt

If adopted terms are created later, the operator records a receipt outside the
corpus before accepting a contribution. The receipt must contain at least:

```text
Consent version: <exact adopted consent identifier>
Licence version: <exact adopted licence identifier>
Terms SHA-256: <exact digest from the adopted version registry>
Contributor saw the complete terms: yes
Contributor affirmatively accepted: yes
Accepted contribution IDs: <exact hmac-sha256 ids>
Deletion receipt/capability: <separate random value>
Acceptance time and transfer channel: <operator record, not corpus data>
```

The receipt must not be embedded in the model input. Contact details, names, chat
handles, signatures, and exact acceptance times stay in the separately protected
receipt store and never enter the measurement corpus.

## Safety and review status

Contributing does not promise that a model will be produced or that any tuning
result will be suitable for a particular helicopter. Community output may never
override RotorLens's local mechanical, evidence, direction, headspeed, or
stability gates.

This file is an engineering draft, not legal advice and not adopted contributor
terms. No real contribution may be solicited or accepted under its identifiers.
The owner should have the eventual text reviewed and formally adopt it before
collecting production contributions; adoption must add new production version
identifiers and pin the exact canonical text digest. Changing the fields,
purposes, recipients, or licence requires another version and a new affirmative
acceptance; an old receipt cannot be stretched to cover them.
