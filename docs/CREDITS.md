# Credits

Who built what, stated from the evidence in this repository rather than from memory.

## Original project — Veil

| | |
|---|---|
| Author | **Nishant Tiwari** — [`nishant-Tiwari24`](https://github.com/nishant-Tiwari24) |
| Project | <https://github.com/nishant-Tiwari24/veil> |
| Licence | MIT, `Copyright (c) 2026 Nishant Tiwari` — see [LICENSE](../LICENSE), unchanged here |
| Platforms shipped by upstream | macOS (`arm64`, `x64`) and Linux (`.AppImage`) |
| What upstream built | the whole application: the Tor controller, per-site circuit isolation, the kill switch, the amnesic storage model, the fingerprint work, the internal pages, the community hub, the ad-block pipeline, the reverse engineering of Tor Browser, and the 37-check self-test |

The facts above were checked against the GitHub API and against the upstream `v1.0.0` release
assets on 2026-11-01. Upstream has **not** reviewed, approved or endorsed this Windows port, and
nothing in this file should be read as their endorsement.

## Windows port — this repository

The Windows work is a separate contribution by a separate person: the GitHub account that owns
and pushes this repository. Its identity is the account shown as the owner of this repository and
in [the commit history](../../commits/main); no name is asserted here beyond what that record
shows, because inventing one would be a false credit to somebody and a false claim about somebody
else.

What the Windows port is responsible for — everything in this list is Windows-only work and none of
it is upstream's:

- `src/main/platform.js`: one place for path layout, process ownership, bounded termination,
  stale-state sweeping, window chrome and spawn options, instead of scattered `if (windows)`
- `src/main/tor.js`: launching and supervising the Windows `tor.exe` process, including the
  termination sequence (graceful `SHUTDOWN` first, then bounded forced kill, only after checking
  process ownership and executable identity)
- `scripts/fetch-tor.js`: downloading the Tor expert bundle for `win32-x64` from
  `dist.torproject.org`, importing the pinned Tor Project key, verifying the detached signature,
  checking the PE architecture, executing the binary to prove it runs on Windows, and writing
  `bin/win32-x64/manifest.json` with the per-file SHA-256 digests
- bridges on Windows: `lyrebird.exe` and `conjure-client.exe` spawn paths, transport plumbing and
  the `tests/transport-spawn.test.js` coverage
- packaging: the NSIS per-user installer and the single-file portable build, `CSC_IDENTITY_AUTO_DISCOVERY`
  handling for unsigned builds, and `scripts/check-windows-artifacts.js` (the 28-check artifact gate)
- release evidence: `scripts/release-evidence.js` → `SHA256SUMS.txt` and the CycloneDX `SBOM.json`
  generated from the bytes that were actually built
- the self-test grown from 37 to **43 checks**, with the PASS / FAIL / KNOWN reporting, the
  wire-level client-hint measurement, and `VEIL_SELFTEST_REPORT` so a packaged Windows build with
  no console can still produce evidence
- throwaway-profile isolation for self-tests (`veil-selftest-<pid>` in `%TEMP%`, swept by a
  liveness check on the owner pid) and bounded retries on Windows file locks
- this port's documentation: [UPSTREAM.md](UPSTREAM.md), this file,
  [WINDOWS_SUPPORT.md](WINDOWS_SUPPORT.md), [WINDOWS_BUILD.md](WINDOWS_BUILD.md),
  [WINDOWS_TESTING.md](WINDOWS_TESTING.md),
  [WINDOWS_REVERSE_ENGINEERING.md](WINDOWS_REVERSE_ENGINEERING.md),
  [security/VIRUSTOTAL.md](security/VIRUSTOTAL.md)
- CI: `.github/workflows/windows.yml`

What the Windows port is **not** responsible for: the design of Veil, its anonymity model, its
UI, its community network, or any upstream bug. Where a defect turned up while porting, it is
listed in [CHANGELOG.md](../CHANGELOG.md).

## The people and projects this build depends on

| project | what it contributes | licence |
|---|---|---|
| [The Tor Project](https://www.torproject.org/) | `tor.exe` 0.4.9.15 (Tor Browser 16.0 expert bundle), `geoip`, `geoip6`, `torrc-defaults` | GPL-3.0-or-later |
| [The Tor Project — lyrebird](https://gitlab.torproject.org/tpo/anti-censorship/pluggable-transports/lyrebird) | obfs4 and meek_azure bridge transports on Windows | BSD-3-Clause |
| [refraction-networking](https://refraction.networking/) | `conjure-client` (Snowflake / SecUnweaver transport) | BSD-3-Clause |
| libevent, OpenSSL, zlib | linked into the tor bundle | BSD-3-Clause, OpenSSL dual, Zlib |
| [Electron](https://www.electronjs.org/) 45.0.0 | the Chromium and V8 runtime, and Node.js, that Veil drives | MIT (Chromium and its bundled libraries carry their own licences) |
| [Chromium](https://www.chromium.org/) / [V8](https://v8.dev/) | the engine every page is actually rendered by | BSD-3-Clause-ish (Chromium licence) |
| [Node.js](https://nodejs.org/) | the JS runtime inside Electron, and the runner for the tests | MIT |
| [electron-builder](https://www.electron.build/) 26.18.0 | turns the app into the NSIS Setup and Portable builds | MIT (dev-only; not shipped in the app) |
| [`@ghostery/adblocker`](https://github.com/ghostery/adblocker) | the compiled ad/tracker engine behind `assets/adblock.engine` | MPL-2.0 |
| [`tldts`](https://github.com/remusao/tldts) | public-suffix handling, so per-site isolation keys off registrable domains | MIT |
| [EasyList / EasyPrivacy](https://easylist.cc/) | the filter rules compiled into `assets/adblock.engine` | their own share-alike licence |
| [Creepster font](https://www.fontsquirrel.com/fonts/creepster) | the title face in Veil's own pages | SIL Open Font License 1.1 ([text](../assets/fonts/Creepster-OFL.txt)) |
| DuckDuckGo | the private onion search endpoint the address bar uses | external service, not bundled |
| [check.torproject.org](https://check.torproject.org/), [httpbin.org](https://httpbin.org/) | third parties the leak test and self-test consult | external services, contacted only during tests |

Every dependency above is present in this build; per-version licence ids for the whole transitive
npm tree are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and in the machine-readable
`SBOM.json` attached to each release.

## How credit appears in the shipped product

- **Installer and executable metadata**: `ProductName = Veil`,
  `CompanyName = Nishant Tiwari (original Veil project)`, `FileDescription` names this as the
  independent Windows port, and `LegalCopyright` states both the upstream copyright and that the
  Windows port is an independent, unsigned build that the original author did not publish or
  endorse. Those fields are set in `package.json` (`author`, `description`, `build.copyright`) and
  re-read from the built binaries with PowerShell `VersionInfo` after every build.
- **In-app About**: the About panel on Veil's home page names the original project and its author,
  links to the upstream repository (opened through Tor), identifies the Windows edition as an
  independent port, and repeats that the build is unsigned and unaudited.
- **Add/Remove Programs**: the entry is a per-user install under the name "Veil" with the publisher
  string above; it is not registered as an upstream product and no upstream signature is claimed.

If the metadata or the packaged About text changes, the Windows executables are rebuilt — a
documented credit that is not in the binary is not a credit.
