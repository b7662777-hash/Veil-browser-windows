# VirusTotal & malware-scan policy

**Status: no scan has been run on these binaries.** This file documents what will be done and what
evidence will be published. It deliberately contains no detection ratio, no permalink and no badge,
because publishing any of those before a scan exists would be a fabricated security claim.

## Why this matters more here than in a signed app

The Windows builds are **unsigned**. There is no code-signing certificate for this project, no
signature is faked, no self-signed certificate is passed off as authenticity, and SmartScreen
reputation is not established. With no signature to vouch for the bytes, an independent scan is one
of the few things a user can check — which is exactly why it must be real when it appears.

## What is true right now

| item | value |
|---|---|
| VirusTotal scan of `Veil-1.0.0-Windows-x64-Setup.exe` | **not run** |
| VirusTotal scan of `Veil-1.0.0-Windows-x64-Portable.exe` | **not run** |
| Permalinks / detection ratios published in README | **none** — nothing to link |
| Code-signing status of either file | `NotSigned` (measured with PowerShell `Get-AuthenticodeSignature`) |
| Authenticode signature of the bundled `tor.exe` | `NotSigned` — upstream signs Tor bundles with a GPG detached signature, not Authenticode. Provenance is established by that signature and by the SHA-256 recorded in `bin/win32-x64/manifest.json` |

## What a published report must contain

A scan result is only meaningful against the exact bytes a user can download. Before any VirusTotal
claim is added to [README.md](../../README.md), this file records, per artifact:

1. the SHA-256 of the file that was uploaded, and that it equals the entry in `SHA256SUMS.txt` for
   that release;
2. the date and time of the upload;
3. the analysis id / permalink, so anyone can re-read the report rather than take this file's word;
4. the engine count and the detection list **verbatim**, including any detections — a report with
   the awkward engines removed is not evidence;
5. which engines flagged it and, for each, whether the reason is understandable (a self-extracting
   NSIS stub, a bundled `tor.exe`, an Electron binary) rather than a claim that the detection is
   wrong without proof.

If a scan flags something real, the release is pulled, not re-labelled.

## Procedure

Uploads are made by a human who understands what they are publishing to a third party. Two things
are required first, and neither is currently in place:

- **A decision about publishing.** Anything uploaded to VirusTotal is retained and shared with
  security vendors. These are our own build outputs, not user data, so the exposure is the code and
  the hash — but it is a public act, so it is deliberate rather than incidental.
- **A way to submit.** Either the web UI at <https://www.virustotal.com/gui/file/upload> (signed in
  with a VirusTotal account) or the API with an API key held in the environment of the machine that
  runs the upload. The key is never pasted into a chat, never committed, and never printed in CI
  logs.

Then, per artifact, from the release directory:

```powershell
# 1. confirm what you are about to upload matches the published sums
Get-FileHash .\Veil-1.0.0-Windows-x64-Setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS.txt

# 2. submit with the v3 files API (VT_API_KEY must already be in the environment)
curl -s -X POST "https://www.virustotal.com/api/v3/files" `
  -H "x-apikey: $env:VT_API_KEY" -F "file=@./Veil-1.0.0-Windows-x64-Setup.exe"
```

The response carries an `analysis id`; read it back later with
`GET /api/v3/analyses/{id}` and record the JSON next to this document. Re-check the file hash
**after** the scan finishes: a rebuild changes the bytes, which invalidates the evidence and
requires a new scan.

## What will never be claimed

- "VirusTotal-clean" or "no engine detects it" unless the recorded report says exactly that, on the
  released hash.
- A scan of a *different* build as evidence for this one — including a scan of a rebuild that
  happened after the metadata or the About panel changed.
- A badge or shield in the README that points at a scan page nobody has opened.
- Any implication that a clean scan means the app is safe, audited or anonymous. A scan looks for
  known malware; it says nothing about whether Veil's own anonymity claims hold. That is what
  `npm run selftest` measures, and it is reported separately.
