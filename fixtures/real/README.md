# Real-log fixtures

No real flight log is committed here by default. A `.bbl`, `.bfl`, `.txt`, or
`.log` file is publishable only when an adjacent `.donation.json` sidecar proves
ownership or written redistribution permission and passes the location/privacy
scan in `docs/FIXTURE_POLICY.md`.

Use private logs without copying them into the repository:

```powershell
$env:ROTORLENS_REAL_LOG = 'C:\logs\reference.bbl'
npm test

$env:ROTORLENS_CORPUS_LOGS = 'C:\logs\a.bbl;C:\logs\b.bbl'
npm test
```

CI runs the same publication gate over this directory and accepts an empty
real-log corpus; adding bytes without a valid sidecar fails the build.
