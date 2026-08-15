# Store privacy declarations

The answers to give Google Play's Data safety form and Apple's App Privacy
questionnaire, with the evidence for each. Both stores treat a wrong answer here
as a policy violation rather than a mistake, and both make you re-declare on
every release.

Keep this file and `docs/PRIVACY_POLICY.md` in step with the code. If a field is
written that the policy does not mention, **the policy is what is wrong.**

## The evidence

Everything below rests on these, each checked by `npm test`:

| Claim | Where it is enforced |
| --- | --- |
| No `INTERNET` or sensitive platform permission | the source manifest requests none; `test/provenance.test.mjs` protects that boundary, and the release build checks the merged manifest so a library cannot add one unseen |
| No network call in shipped JavaScript | one `fetch` in `ui/host.mjs`, to the app's own asset origin; asserted in `test/privacy-claims.test.mjs` |
| No browser storage or cookies | asserted in `test/privacy-claims.test.mjs`; the flight history and sharing preference are native files rather than `localStorage` |
| No analytics, ads, or crash SDK | `android/shipping-dependencies.json` is the resolved classpath; every artifact is AOSP, JetBrains, or Guava |
| The log does not outlive the session | `ImportStore` purges on start and clears on destroy |
| The flight history stores only the fields the policy lists | `RECORD_FIELDS` in `src/analysis/flight-history.mjs` is the allowlist the export is built from; `test/flight-history.test.mjs` fails on any field outside it, and on a timestamp, a filename, or a raw trace |
| The flight history holds no location and no clock | asserted in `test/flight-history.test.mjs`; the location half runs against a real log that declares eight GPS fields, and checks each declared field name against the built record and the export |
| The pilot can empty both persistent files | `forgetFlight`, `forgetAircraft`, `forgetEverything`, and `forgetSharing`; tests require the last two controls to unlink the applicable native files |
| The sharing file has a documented fixed shape | `exportSharing` writes only the consent state, terms version, local aircraft-key map and random 100-bit aircraft identities; `docs/PRIVACY_POLICY.md` describes each field |
| Nothing stored can leave the phone, including to another phone | `android:allowBackup="false"` **and** `android:dataExtractionRules` excluding every domain from cloud backup and device transfer; `test/privacy-claims.test.mjs` reads the attribute, both sections and the individual excludes |

Without `INTERNET`, the OS will not open a socket for this app. That is the
difference between a privacy policy and a privacy property.

## Google Play — Data safety

**Does your app collect or share any of the required user data types?**
→ **No.**

Play defines *collection* as transmitting data off the device. RotorLens
transmits nothing, so on-device processing of a log — including its location
frames — is not collection and must not be declared as such. Declaring it would
be inaccurate in the other direction and would drag in obligations that do not
apply.

**The two local stores do not change this answer, and here is the reasoning to
give if anybody asks.** They are stored, not collected: both remain in private
storage on the user's phone, are never transmitted, and without the `INTERNET`
permission cannot be. The flight history contains a user-configured helicopter
name (which could itself be a name or callsign) and board model, but no dedicated
account/device identifier, location, date, or time. The sharing file contains the
consent answer. While sharing is enabled it also retains the accepted wording
version, and it creates a cryptographically random 100-bit aircraft identity
mapped to each saved helicopter's local aircraft key. Turning sharing off clears
the wording version but does not erase an aircraft key or identity. Those mappings
remain until **Erase identity**, **Forget helicopter**, or **Forget everything**
removes them. The random identity is not derived from a person, device, account,
or advertising identifier and never leaves this device in this release. Play's Data
safety form asks about data *collected or shared*; the answer stays No on every
row. Apple's questionnaire asks the same question the same way, and the answer
stays "Data Not Collected".

The consent answer can be stored before a flight is saved. That timing changes
the product copy — it may not say “nothing is kept until Save” — but not the store
answer, because the preference is still never transmitted or shared.

| Question | Answer |
| --- | --- |
| Data collected | None |
| Data shared with third parties | None |
| Data types (location, personal info, files, etc.) | None declared |
| Is data encrypted in transit? | N/A — no data is transmitted |
| Can users request data deletion? | N/A — no data is retained off-device. On-device controls erase individual flights, aircraft histories, all history, and the sharing preference/identities |
| Committed to the Play Families policy? | No (not directed at children) |
| Independent security review | Not claimed |
| Privacy policy URL | required — see *Hosting* below |

**Note for the reviewer field, if one is offered:** RotorLens reads Blackbox
flight logs that the user opens explicitly. All decoding and analysis happen on
the device. The app requests no INTERNET permission, so it is technically
incapable of transmitting data. It can store a small summary of flights locally
for before/after comparison. Answering its future-sharing question also stores
the answer; enabling sharing creates a random per-aircraft identity, although
this release has no sharing transport. The stores contain no location or flight
timestamps, never leave the device, and have in-app view/export/erase controls.

## Apple — App Privacy

→ **"Data Not Collected"** for every category.

| Question | Answer |
| --- | --- |
| Do you or your third-party partners collect data from this app? | No |
| Tracking (ATT) | No — no tracking, so no `NSUserTrackingUsageDescription` and no ATT prompt |
| Third-party SDKs collecting data | None |
| Privacy policy URL | required, same URL as Play |

Apple asks separately about data used to *track* users across apps. RotorLens has
no personal, device, advertising, or cross-app identifier and no network access.
Its random local aircraft identity groups one helicopter only and is never
transmitted, so the answer is no on every branch.

**Privacy manifest (`PrivacyInfo.xcprivacy`).** An iOS build needs one declaring
no collected data types and no tracking domains. Required-reason APIs: if the app
ever reads file timestamps it must declare the file-timestamp reason code. Decide
this when the iOS target exists — RotorLens is Android-only today.

## Hosting the policy

Both stores require a URL that is **live before submission** and reachable
without logging in. The policy lives in this repository, which is private and
must stay that way — the source is the product.

Options, cheapest first:

1. **GitHub Pages from a separate public repository** — e.g. `rotorlens-site`,
   containing only the rendered policy. Free, and it does not expose this
   repository. Publish `docs/privacy-policy.html` there.
2. **GitHub Pages from this repository** — requires either making it public
   (do not) or a paid plan that allows Pages on private repos.
3. **Any static host** on a domain you own.

Whichever is chosen, the hosted page must be generated from
`docs/PRIVACY_POLICY.md` rather than typed again. Two copies drift, and the copy
that drifts is the one the store reads.

## Before each release, check

- [ ] The resolved dependency list has not gained a component that phones home
      (`gradlew :app:recordShippingDependencies`, then read the diff)
- [ ] The source and merged release manifests still contain no `INTERNET` or
      sensitive platform permission
- [ ] The hosted policy matches `docs/PRIVACY_POLICY.md`
- [ ] The store declarations still say "no data collected"
- [ ] The in-app Legal screen still shows the non-affiliation statement
- [ ] `RECORD_FIELDS` has not gained a field the policy's *what the flight
      history contains* table does not list (`test/flight-history.test.mjs`
      fails first, but the policy is what has to be rewritten)
- [ ] The history screen still offers Export and Forget everything
- [ ] The Sharing screen still shows and can erase its local preference and
      aircraft identities

## What would change every answer above

Adding any one of these turns "collects nothing" into a data declaration, a
policy rewrite, and a store re-review:

- The `INTERNET` permission, for any reason — an update check, a bug report, a
  "share this flight" button
- A crash reporter or analytics SDK, including ones added transitively by a
  dependency
- Cloud sync, accounts, or log backup
- Any personal, device, advertising, account, or tracking identifier persisted
  across sessions
- Any local identifier transmitted off-device, including the current random
  aircraft identity

The first of those is one line in a manifest, and it is the line that ends the
strongest claim this app has.

**What the current local identifiers are not.** The history identifies a
*helicopter* by a name its owner typed. When sharing is enabled, `sharing.json`
maps that same local aircraft key to a random 100-bit identity. Turning sharing
off retains that mapping until **Erase identity**, **Forget helicopter**, or
**Forget everything** removes it. Neither value identifies a person or device,
neither can track activity across apps, and neither leaves the phone. Both are
readable or erasable by the person holding the phone. The privacy
and store declarations must be reviewed again the moment any of these are added:

- A timestamp on a record, which turns a tuning history into a record of when
  somebody flies. Deliberately absent, and the reason is measured rather than
  assumed: restricting comparisons to the same day does not make them any more
  reliable, so the date would be collected for nothing.
- The imported file's name or path, which is a path into the user's storage.
- Any GPS field — coordinates, home position, or the satellite, ground-speed and
  altitude rows, which are location-adjacent even though they are not
  coordinates.
- A device, install, account, advertising, or personal identifier of any kind.
- A transport that sends the random aircraft identity or any record associated
  with it.
- `android:allowBackup` returning to `true`, which would put the history into
  Google's cloud backup and make "nothing leaves your phone" false without a
  single line of app code changing.
- `android:dataExtractionRules` being dropped from the manifest, or its
  `<device-transfer>` section being weakened or given an `<include>`.

**The backup hazard was real, not hypothetical.** `allowBackup="false"` was for a
time the only thing standing between the history and another device, and at
`targetSdk` 31 and above it is not enough on its own. Android's Auto Backup
documentation states that for apps targeting API 31 or higher, on devices from
some manufacturers `allowBackup="false"` disables cloud backup but "doesn't
disable device-to-device transfers for the app", and that when the
`<device-transfer>` section is not set "all the application data will be
transferred during a D2D migration". This app targets API 31 or newer and the
history lives in `getFilesDir()`, so setting up a new phone from an old one would
have copied it across — which would have made "Nothing leaves your phone" false during an
ordinary phone upgrade. `android/app/src/main/res/xml/data_extraction_rules.xml`
now excludes every data domain from both cloud backup and device transfer, and
`test/privacy-claims.test.mjs` reads the attribute, both sections and the
individual excludes, rather than only grepping the manifest for
`<uses-permission`. Below API 31 the rules file is ignored and
`allowBackup="false"` governs, which on those releases does disable both; `minSdk`
is 26, so the supported range is covered end to end.
