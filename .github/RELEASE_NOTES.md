# Veil Browser for Windows — Independent Windows Port

**Veil** runs every request through the real Tor network, gives every site its own circuit and
storage, and keeps nothing. This release is the **Windows 10/11 x64** edition — an independent port
of upstream [Veil v1.0.0](https://github.com/nishant-Tiwari24/veil) by
**Nishant Tiwari**, maintained for Windows by **Gojo Kun**
([`b7662777-hash`](https://github.com/b7662777-hash)). The original author did not build, review or
endorse this port; the MIT licence and the upstream copyright notice are unchanged.

> ⚠️ **Educational project. Not security-audited.** If your safety depends on anonymity, use
> [Tor Browser](https://www.torproject.org/). Veil is Chromium-based, has a small user base, and
> does **not** claim parity with Tor Browser's fingerprint protection.

## Downloads in this release

| file | what it is |
|---|---|
| `Veil-1.0.0-Windows-x64-Setup.exe` | per-user NSIS installer (no admin rights, installs under `%LOCALAPPDATA%\Programs\Veil`) |
| `Veil-1.0.0-Windows-x64-Portable.exe` | single self-contained executable, no installation |
| `SHA256SUMS.txt` | SHA-256 of both files above, generated from the bytes that are attached here |
| `SBOM.json` | CycloneDX 1.5 — 302 components, including the SHA-256 of every bundled `tor` file and the signature-verification record for the Tor bundle |

Check before you run:

```powershell
Get-FileHash .\Veil-1.0.0-Windows-x64-Setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
```

## Signing and reputation — disclosed, not hidden

These binaries are **not code-signed**. There is no code-signing certificate for this project; no
signature is faked and no self-signed certificate is presented as authentic. Consequences: Windows
SmartScreen shows a warning on first run, some antivirus engines may flag the file, and the
"Digital signatures" tab of either executable says *Not signed*. Code signing is documented as a
release requirement in [docs/WINDOWS_BUILD.md](docs/WINDOWS_BUILD.md).

**No VirusTotal scan has been published for these files, because none has been run on them.** The
policy and the procedure are in [docs/security/VIRUSTOTAL.md](docs/security/VIRUSTOTAL.md).

## What is verified

Measured on Windows 11 x64 (10.0.26200), Node v24, tor 0.4.9.15:

| | |
|---|---|
| `npm run check` | exit 0 |
| `npm test` | 67 pass / 0 fail / **0 skipped** |
| `npm run selftest` | **43 checks: 42 PASS, 1 KNOWN, 0 FAIL** — kill switch, per-site circuits and storage, DNS/WebRTC/QUIC, the header surface on the wire, HTTPS-Only, amnesic state, New Identity getting a new exit address, Panic clearing tabs/history/clipboard/bookmarks |
| `node scripts/check-windows-artifacts.js` | 28 packaging checks: every executable is x64, no Unix binary inside a Windows build, tor provenance and signature record present, `latest.yml` sha512 cross-checked against the installer bytes, `SHA256SUMS.txt` re-hashed from disk |

A KNOWN line is a measured limitation, printed with its reason and never counted as a pass. The one
in this run is the check that reads request headers back from a third-party echo service that did
not answer; two other checks measure the same headers directly on the wire and passed.

## Windows-specific work in this port

`src/main/platform.js` (one place for paths, process ownership, bounded termination and stale-state
sweeping) · Windows tor supervision with graceful-then-bounded-forcible shutdown ·
signature-verified `tor.exe`, `lyrebird.exe` and `conjure-client.exe` fetched by
`npm run tor:fetch` (bridges work on Windows with no separate Tor Browser install) · NSIS per-user
installer + portable build · the 28-check artifact gate · release evidence (sums + SBOM) generated
from the built bytes · the self-test grown from 37 to 43 checks with PASS/FAIL/KNOWN reporting and a
file report channel for packaged builds that have no console · throwaway self-test profiles that
cannot touch your real browsing state · Windows-only CI.

## Known limitations

Unsigned, unaudited, no VirusTotal evidence · x64 only (no ARM64) · no Tor Browser fingerprint
parity · Windows' own font metrics are part of the fingerprint (no font bundle) · some sites refuse
Tor, which is the site's choice, not a bug · `Panic` and `New Identity` were measured on Windows;
other upstream guarantees were not re-measured here specifically.

## Get help / give feedback

Docs for Windows users: [docs/WINDOWS_SUPPORT.md](docs/WINDOWS_SUPPORT.md) · build and verification:
[docs/WINDOWS_BUILD.md](docs/WINDOWS_BUILD.md) · tests: [docs/WINDOWS_TESTING.md](docs/WINDOWS_TESTING.md)

**[Report a bug](https://github.com/b7662777-hash/Veil-browser-windows/issues/new?template=bug_report.yml)** ·
**[Request a feature](https://github.com/b7662777-hash/Veil-browser-windows/issues/new?template=feature_request.yml)** ·
[Discussions (Q&A, Show and tell, Ideas)](https://github.com/b7662777-hash/Veil-browser-windows/discussions) ·
[Contributing](https://github.com/b7662777-hash/Veil-browser-windows/blob/main/CONTRIBUTING.md)

Security problems are **not** issues: use
[private vulnerability reporting](https://github.com/b7662777-hash/Veil-browser-windows/security/advisories/new).

## Licence and third parties

MIT, unchanged from upstream, `Copyright (c) 2026 Nishant Tiwari` preserved — see
[LICENSE](https://github.com/b7662777-hash/Veil-browser-windows/blob/main/LICENSE) and
[docs/THIRD_PARTY_NOTICES.md](https://github.com/b7662777-hash/Veil-browser-windows/blob/main/docs/THIRD_PARTY_NOTICES.md).
tor (GPL-3.0-or-later) and the bridge transports (BSD-3-Clause) come from the Tor Project's signed
expert bundle; Electron/Chromium/V8 under their own licences; EasyList/EasyPrivacy under theirs;
the Creepster font under SIL OFL 1.1. "Tor" is a trademark of The Tor Project, Inc.; Veil is not
affiliated with or endorsed by The Tor Project.
