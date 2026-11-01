# Upstream

Veil Browser for Windows is **not** a rewrite and **not** an original application. It is a Windows
port of an existing project, and this file records exactly where that project comes from, what
changed here, and what still comes from there.

## The original project

| | |
|---|---|
| **Original developer** | Nishant Tiwari — GitHub login [`nishant-Tiwari24`](https://github.com/nishant-Tiwari24) (user id 124623023) |
| **Upstream repository** | <https://github.com/nishant-Tiwari24/veil> |
| **Description** | "Anonymous browser inspired by Tor Browser, built on Tor onion routing" |
| **Licence** | MIT — `LICENSE` in both trees, copyright line `Copyright (c) 2026 Nishant Tiwari`, unchanged |
| **Default branch** | `main` |
| **Repository created** | 2026-10-28T20:42:35Z (GitHub API) |
| **Upstream release this port is based on** | [`v1.0.0`](https://github.com/nishant-Tiwari24/veil/releases/tag/v1.0.0), published 2026-10-28T21:11:25Z |
| **Upstream release assets** | `Veil-1.0.0-mac-arm64.dmg`, `Veil-1.0.0-mac-x64.dmg`, `Veil-1.0.0-linux-x86_64.AppImage` — macOS and Linux only |
| **Topics** | anonymity, browser, electron, onion-routing, privacy, tor |

Those facts were read from the GitHub REST API and from the repository's own `README.md`,
`package.json` (`repository.url`, `homepage`) and `LICENSE`. Nothing in this file is inferred from a
name or a guess.

**The upstream author has not reviewed, approved or endorsed this Windows port.** Do not read this
document, the About box, or the release notes as implying otherwise. Questions about the original
design belong upstream; questions about Windows behaviour belong here.

## This repository (the Windows edition)

| | |
|---|---|
| **Windows port developer and maintainer** | Gojo Kun — GitHub [`b7662777-hash`](https://github.com/b7662777-hash) (user id 232144110) |
| **Windows edition repository** | <https://github.com/b7662777-hash/Veil-browser-windows> |
| **Release name** | *Veil Browser for Windows* — Independent Windows Port |
| **Licence** | MIT, upstream copyright preserved; the port adds no licence change |

## What arrived here

The starting point was the upstream source archive (the `veil-main.zip` download, matching
upstream `main` around 2026-10-29). That archive contains no `.git` directory, so the exact base
commit cannot be named from this tree — that is a limit of what was received, and it is stated
rather than papered over. Everything before the Windows work — the engine choice, the Tor manager,
the relay and circuit isolation, the amnesic partitions, the fingerprint surface, the UI, the
community onion network, the ad blocker and the eleven ADRs in `docs/adr` — is upstream's, and its authorship is
untouched in the files where it lives.

## What the Windows edition adds

Platform work only. No upstream feature was removed, renamed or disabled to make Windows start.

* **`src/main/platform.js`** — the single place where operating systems differ: tor and transport
  resolution, the data directory, child-process ownership and termination (graceful signal first,
  then a bounded forced kill, verified against the executable's identity so an unrelated process
  sharing a name is never touched), NTFS ACL protection for the one file Veil writes to disk, and
  the sweep of folders left behind by a crashed previous run.
* **Windows Tor integration** — a bundled `tor.exe` for `win32-x64`, discovered through
  `resourcesPath` when packaged, with `--__OwningControllerProcess` so a killed Veil does not orphan
  a tor.
* **Signature-verified acquisition** — `scripts/fetch-tor.js` downloads the official Tor Project
  expert bundle for the *host* platform, verifies the detached GPG signature against a pinned
  fingerprint, records every SHA-256 in `bin/<platform>-<arch>/manifest.json`, and refuses an
  archive that does not verify. macOS and Linux keep using a system tor if you prefer.
* **Pluggable transports that execute** — obfs4 (Lyrebird) and Snowflake (Conjure) Windows binaries,
  launched with an argument array and a controlled working directory, and proven by spawning them in
  a test rather than by assuming a Unix binary would work.
* **Windows packaging** — NSIS per-user installer and a separate portable target, with the Tor
  runtime as `extraResources` outside the asar so it can be executed; `scripts/check-windows-artifacts.js`
  refuses a build that is missing its runtime or ships the wrong architecture.
* **Windows process and file-system handling** — data-directory lifecycle, cleanup on shutdown,
  recovery of folders an earlier build had made undeletable through NTFS inheritance mistakes.
* **A test pyramid that runs on Windows** — deterministic unit tests, live-tor integration tests,
  transport-spawn tests, and the anonymity self-test, which grew from 37 checks to 43 and now
  measures client hints off the wire, New Identity and Panic instead of assuming them.
* **Windows CI** — `.github/workflows/windows.yml`, on Windows runners, because a green Ubuntu job
  proves nothing about a `.exe`.
* **Windows documentation** — `docs/WINDOWS_SUPPORT.md`, `docs/WINDOWS_BUILD.md`,
  `docs/WINDOWS_TESTING.md`, `docs/WINDOWS_REVERSE_ENGINEERING.md`, and the security documents under
  `docs/security/`.

## Differences a user should know about

* **Signed vs unsigned.** Upstream's macOS build is unsigned too (right-click → Open); the Windows
  build is unsigned as well, which means SmartScreen warns on first run. There is no certificate and
  no reputation, and nothing in this port pretends otherwise.
* **No updater.** Upstream has none either. You update by downloading a new build and checking its
  hash.
* **Fonts.** Windows has no font bundle shipped, so the installed font list remains observable from
  a page. This is a real fingerprinting surface; the self-test prints it as `KNOWN` on every run.
  See `docs/security/WINDOWS_SECURITY_AUDIT.md`.
* **Architecture.** Windows is x64 only. No ARM64, no 32-bit, no Windows 7/8/8.1.

## Keeping in sync with upstream

There is no automated sync, and pretending otherwise would be a lie. The policy is deliberate and
manual:

1. Watch upstream `main` and its releases.
2. When something lands that matters — a routing, storage or fingerprint change in particular —
   re-apply the Windows layer on top of it rather than merging blindly, because `platform.js` is
   designed to make that a small diff.
3. Re-run `npm run check`, `npm run test:unit`, `npm run test:live` and `npm run selftest` after any
   sync. A merge that has not been through the anonymity self-test is not a release.
4. Keep the two lineages visible: upstream fixes stay attributed to upstream in `CHANGELOG.md`, and
   Windows work is labelled as such.

If a future upstream change conflicts with a Windows security property, the Windows property does
not silently lose — the conflict gets written up here and in the pull request that resolves it.

## Attribution and copyright

* `LICENSE` is upstream's MIT licence with upstream's copyright line intact. This port adds nothing
  to it and removes nothing from it.
* No file header, author field or comment belonging to upstream has been rewritten to carry this
  port's name.
* Third-party components — tor, Lyrebird, Conjure, Electron/Chromium, Node, the filter lists, the
  bundled font — keep their own licences and are listed with their SHA-256 and verification method
  in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
* The MIT licence obliges redistributions to keep the copyright notice and the licence text. Both
  ship in the installer and the portable build.
