# Third-party notices

Everything in a Veil Windows build that somebody else wrote, where it came from, under what
licence, and how to check it. Measured on 2026-11-01 from a real build
(`win-unpacked/` plus the downloaded Tor bundle), not copied from a website.

Per-release file hashes live in `SHA256SUMS.txt` and `SBOM.json` attached to each GitHub release;
that SBOM is generated from the bytes that were actually built (`npm run release:evidence`), so the
two publishable `.exe` files are always described by their own hashes rather than by a build log.

## Contents

| what | licence | ships in the app? |
|---|---|---|
| Veil itself (upstream project) | MIT | — |
| Tor expert bundle 16.0 (`tor.exe`, transports, GeoIP, licence texts) | GPL-3.0-or-later + the licences of what is linked in | yes, in `resources/bin/win32-x64/` |
| Electron 45.0.0 (Chromium, V8, Node.js) | MIT, plus Chromium's own bundled-library notices | yes |
| 13 npm packages (`@ghostery/adblocker*`, `@remusao/*`, `tldts*`) | MPL-2.0 and MIT | yes, inside `app.asar` |
| 283 other npm packages (electron-builder and its tree) | various | **no** — build-time only |
| EasyList / EasyPrivacy / uBlock filter data (compiled engine) | each list's own terms | yes, `assets/adblock.engine` |
| Creepster font | SIL OFL 1.1 | yes, `assets/fonts/` |
| `elevate.exe` | NSIS/electron-builder component | only inside the installer |

## 1. Veil — MIT

Copyright (c) 2026 Nishant Tiwari, author of the original Veil project
(<https://github.com/nishant-Tiwari24/veil>), MIT-licensed. This repository is an independent
Windows port of that MIT-licensed work; the `LICENSE` file is upstream's, unchanged. Starting with
this build the `LICENSE` text is also packed inside `app.asar`, so an installed copy carries the
notice it is distributed under.

SHA-256 of the `LICENSE` file in the source tree:
`6826ed925635801510c972b50e75fa805955af568acd1fcc10f3dab7f1737cb3` (1,071 bytes).

## 2. Tor expert bundle — the binaries that do the anonymising

| | |
|---|---|
| Product | Tor Browser 16.0 **expert bundle** for Windows x86_64 |
| Tor version | 0.4.9.15 |
| Source | `https://dist.torproject.org/torbrowser/16.0/tor-expert-bundle-windows-x86_64-16.0.tar.gz` |
| Signature | matching `.asc`, RSA/SHA-256 detached clearsignature |
| Pinned identity | fingerprint `EF6E286DDA85EA2A4BA7DE684E2C6E8793298290`, signing subkey `022DA248432D2A0E0F54E65E316C1FACD62D07D9` |
| Fetched on | 2026-11-01T10:35:51Z, by `npm run tor:fetch` |
| Architecture | x86_64 (PE machine `0x8664`) — verified per file before packaging |
| Modification | none; extracted, hashed, and copied verbatim |

These binaries carry **no Authenticode signature** — that is normal for the expert bundle, and the
GPG clearsignature above is Tor Project's official verification mechanism. `Get-AuthenticodeSignature`
therefore reports `NotSigned` for `tor.exe`, and no one should read that as tampering.

Per-file SHA-256 (`bin/win32-x64/manifest.json`, re-checked against disk at build time):

| file | bytes | SHA-256 |
|---|---:|---|
| `tor.exe` | 10,247,168 | `1607d98f5d13859077b1b349c55beba76b09acc788f0431fd824d11966fb1074` |
| `pluggable_transports/lyrebird.exe` | 18,255,872 | `6a8f58e82a39510f144bbef5815ece0762c8a632375da810e9d803d610622201` |
| `pluggable_transports/conjure-client.exe` | 15,697,920 | `51221664b9531cc3804a264989c68d4911ac40c11f8f739363ff5efa9e3eee42` |
| `geoip` | 9,855,249 | `5f0ebc505ad5a5b219f9c053ce6228c837669364349a1a70c236192dd99a1c3d` |
| `geoip6` | 16,075,127 | `d6bc775efb8f970afacbb702ea0c80dbf9e2add32232afcfe3f376a972503b56` |
| `torrc-defaults` | 928 | `0f5205266ccb37da3d8d6a4f5c52862e42dac9f1dc2650be60cad523fa6ee964` |
| `licenses/tor.txt` | 21,086 | `5dc29ea302cc75db6db4a7c88d7b5d4638b4e0f5f1d2e6d21ce71f707470b766` |
| `licenses/lyrebird.txt` | 289,240 | `e3364b4d60028936ab48835bd162a669d1693a4ba073e32f79e9e4f3ca819249` |
| `licenses/conjure.txt` | 127,227 | `0522541e3505d6669334f6eb488d4fde9c4af2234daec13170a0cf4d46d99e92` |
| `licenses/libevent.txt` | 4,528 | `ff02effc9b331edcdac387d198691bfa3e575e7d244ad10cb826aa51ef085670` |
| `licenses/openssl.txt` | 10,175 | `7d5450cb2d142651b8afa315b5f238efc805dad827d91ba367d8516bc9d49e7a` |
| `licenses/zlib.txt` | 1,002 | `e32ff4e00d9d94930537635291da39e7e612703334bf6fde8c7f1686fe8a45a2` |

Licences of what is inside those binaries, as declared in the bundle's own licence texts: Tor is
GPL-3.0-or-later; libevent, lyrebird and conjure-client are BSD-3-Clause; OpenSSL ships under its
Apache-2.0-style dual licence; zlib is Zlib. The five `licenses/*.txt` files above are installed
with the app at `resources/bin/win32-x64/licenses/`, so the notice travels with the binary.

Because the binaries are unmodified, the corresponding Tor source is the one Tor Project publishes
for the same release; upstream tarballs are available from `https://dist.torproject.org/torbrowser/16.0/`.

## 3. Electron 45.0.0 — the browser engine

| | |
|---|---|
| Package | `electron@45.0.0` (npm), pinned in `package-lock.json` |
| Licence | MIT (Electron) — the exact text is installed as `LICENSE.electron.txt` (1,096 bytes, SHA-256 `5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d`) |
| Chromium + bundled libraries | `LICENSES.chromium.html` is installed next to it (5,705,935 bytes, SHA-256 `7dac8267ac6da8d959cfe88f5f055b18a397f10230380b5329125e167bf5639b`) |
| `ffmpeg.dll` | shipped by Electron, not built here (3,097,600 bytes, SHA-256 `cdf2b70f0f0a97c9840af1466dd86a90e564c98f6892d783635cf9c3b303d613`) |
| Architecture | x64 |

Chromium, V8, Node.js and the codecs inside them are upstream's work under their own terms; the
two licence files above are the authoritative list and both are present in every Windows install.
Veil does not fork or patch Electron.

## 4. npm packages that actually ship inside `app.asar`

Enumerated from the built archive (`@electron/asar` listing of `resources/app.asar`), so this is
what is in the product — not what a manifest says could be. Each package's own `LICENSE` file is
packed alongside it inside the asar.

| package | version | licence |
|---|---|---|
| `@ghostery/adblocker` | 2.20.1 | MPL-2.0 |
| `@ghostery/adblocker-content` | 2.20.1 | MPL-2.0 |
| `@ghostery/adblocker-extended-selectors` | 2.20.1 | MPL-2.0 |
| `@ghostery/url-parser` | 1.3.1 | MPL-2.0 |
| `@remusao/guess-url-type` | 2.1.0 | MPL-2.0 |
| `@remusao/small` | 2.1.0 | MPL-2.0 |
| `@remusao/smaz` | 2.2.0 | MPL-2.0 |
| `@remusao/smaz-compress` | 2.2.0 | MPL-2.0 |
| `@remusao/smaz-decompress` | 2.2.0 | MPL-2.0 |
| `@remusao/trie` | 2.1.0 | MPL-2.0 |
| `tldts` | 7.4.19 | MIT |
| `tldts-core` | 7.4.19 | MIT |
| `tldts-experimental` | 7.4.19 | MIT |

MPL-2.0 is file-level copyleft: it applies to those packages' own source files, not to Veil's code,
and the sources are obtainable from the packages' npm/GitHub repositories. `npm run tor:fetch` etc.
never touch this tree — the versions above are the ones `package-lock.json` pins.

The remaining 283 lockfile packages (`electron-builder`, its signers, archivers, and their
transitive tree — MIT, ISC, BSD-2/3-Clause, Apache-2.0, BlueOak-1.0.0, MPL-2.0, 0BSD, Zlib, OFL-1.1,
Python-2.0, WTFPL and two SPDX expressions) are **build-time only** and are not inside the shipped
app. They are still in the release SBOM, marked by `type`, because a build machine's dependency
tree is worth recording even when it does not ship.

## 5. Filter lists (ad blocking)

`assets/adblock.engine` (6,864,737 bytes, SHA-256
`60ecdf7894e09b7f893dd6f68630370dfdf9182a7fdd0d08efb8688a164fc443`, dated 2026-10-28) is a compiled
engine built by `scripts/adblock-update.js` from EasyList, EasyPrivacy and uBlock Origin filter
data. Veil ships the derived compiled form, not the source lists, and those lists remain governed
by their own terms at `https://easylist.to/` and the uBlock Origin repository. Updating the engine
is a maintainer command, documented in [WINDOWS_BUILD.md](WINDOWS_BUILD.md); no filters are fetched
at run time and nothing about which lists you use is reported anywhere.

## 6. Creepster font

`assets/fonts/Creepster-Regular.ttf` (62,724 bytes, SHA-256
`402aeb734586c74aecd3dbdc454589b1fb12e2e1c71f782fd019ae68066d9f44`), designed by Font Diner, released
under the SIL Open Font License 1.1. The licence text is packed with the app at
`assets/fonts/Creepster-OFL.txt` inside `app.asar`, and the font is used unmodified.

## 7. Installer scaffolding

`resources/elevate.exe` (107,520 bytes, SHA-256
`9b1fbf0c11c520ae714af8aa9af12cfd48503eedecd7398d8992ee94d1b4dc37`) is the privilege helper that
electron-builder's NSIS target injects. It is not used by this port's installer at run time — the
NSIS configuration sets `allowElevation: false` and `perMachine: false`, so installation is
per-user and never asks for admin rights. It is listed here because it is a third-party binary
present in the build tree; its provenance is electron-builder's pinned npm package, and beyond that
we have not independently audited it. The NSIS stubs themselves are 32-bit by design (NSIS is
32-bit); the packaging gate asserts that everything that actually *runs* as Veil or Tor is x64.

## 8. Trademarks

"Tor", "Tor Browser" and the onion-logo are trademarks of The Tor Project, Inc. "Electron" is a
trademark of OpenJS Foundation contributors; "Chromium" and "Chrome" belong to Google LLC. "veil"
is the upstream project's name. Veil for Windows is an independent port: it is not affiliated with,
endorsed by, or supported by The Tor Project, Inc., the Tor Browser developers, or the original Veil
author. The installer's copyright field says so in those words.

## 9. How to verify any of this yourself

```powershell
# 1. hashes of what you downloaded
Get-FileHash .\SHA256SUMS.txt -Algorithm SHA256   # read the file, then:
Get-Content .\SHA256SUMS.txt | ForEach-Object {
  $h, $f = $_ -split '\s+', 2
  $actual = (Get-FileHash $f -Algorithm SHA256).Hash.ToLower()
  '{0}  {1}' -f ($(if ($actual -eq $h) {'OK  '} else {'FAIL'})), $f
}

# 2. the Tor bundle inside an installed copy, against the manifest that was signed for it
$dest = "$env:LOCALAPPDATA\Programs\Veil\resources\bin\win32-x64"
Get-ChildItem $dest -Recurse -File | ForEach-Object {
  '{0}  {1}' -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower(), $_.Name
}

# 3. the same numbers re-derived from the source tree
npm run tor:fetch        # re-downloads and re-verifies against the pinned fingerprint
npm run release:evidence # rebuilds SHA256SUMS.txt and SBOM.json from the files on disk
```

If `sha256sum -c SHA256SUMS.txt` on Linux/macOS, or step 1 above on Windows, prints anything other
than `OK` for both `.exe` files, do not run what you downloaded — report it as described in
[SECURITY.md](../SECURITY.md).
