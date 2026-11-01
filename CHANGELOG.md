# Changelog

What changed in Veil, release by release. Dates are the release date of the build, not the date a
commit was written.

## Unreleased

Nothing staged for the next version yet.

## 1.0.0 — 2026-11-01

The first release with Windows support, and the first whose anonymity claims are backed by checks
that run against the live Tor network rather than by documentation.

### Added — Windows

* **Windows 10/11 x64 builds**: an NSIS per-user installer and a separate portable executable, both
  produced by `npm run dist` and gated by `scripts/check-windows-artifacts.js`.
* **Bundled Tor for Windows.** macOS and Linux expected a tor from Homebrew or apt. Windows gets a
  tor that ships with the app: `npm run tor:fetch` downloads the official Tor Project expert
  bundle, verifies the detached signature against a pinned fingerprint, records every file's
  SHA-256 in `bin/win32-x64/manifest.json`, and refuses an archive that does not verify. Nothing is
  fetched at run time.
* **Pluggable transports that actually run on Windows** — obfs4 (Lyrebird) and Snowflake/Conjure —
  launched with an argument array and a controlled working directory, and verified by spawning the
  real binaries in a test rather than assuming a Unix executable would work.
* **`src/main/platform.js`**, the single place where the three operating systems differ: tor and
  transport lookup paths, the data directory, process ownership and termination (graceful first,
  then a bounded forced kill, checked against the executable's identity so an unrelated process
  that happens to share a name is never touched), NTFS ACL protection for the one file Veil writes
  to disk, and the sweep of folders left by a previous crash.
* **Recovery of tor folders an older build had made undeletable.** NTFS ACLs set with the wrong
  inheritance flags left children with an empty DACL — unreadable and undeletable by their own
  creator, holding a control-cookie. Those folders are now taken back and wiped instead of being
  left behind; the failure is reported, never swallowed.
* **Windows CI** (`.github/workflows/windows.yml`): build, artifact gate, deterministic tests, and
  a separately-run live-network job.

### Added — checks and evidence

* The self-test grew from 37 checks to **43**, and now measures rather than assumes:
  * client hints are read **off the wire** (`onSendHeaders`) instead of through a third-party echo
    service, with a non-vacuity control that the low-entropy Chrome hints do still go out,
    normalised — and a check that a site asking for them via `Accept-CH` gets nothing, and that the
    `Accept-CH`/`Critical-CH` negotiation never reaches the page;
  * **New Identity** is verified end to end: tabs and history emptied, partitions gone, and a
    different exit address on a still-Tor-routed connection;
  * **Panic** is verified to clear the clipboard and delete the bookmark file, after first putting
    a bookmark there so the check cannot pass by watching nothing;
  * the third `KNOWN` outcome: a limitation measured on the spot is printed with its reason and is
    never counted as a pass.
* A self-test run now uses a throwaway profile under the temp directory, so `npm run selftest`
  cannot destroy the bookmarks and settings of the person running it.
* **Integration tests against a real tor** (`npm run test:live`): bootstrap, control-port
  authentication, `IsolateSOCKSAuth` producing two circuits from two credentials, GeoIP resolution,
  restart, clean shutdown, and the crash-and-sweep path.
* `scripts/release-evidence.js` writes `SHA256SUMS.txt` and a CycloneDX `SBOM.json` from the bytes
  of the built files, so published hashes are the hashes of what is uploaded.

### Fixed

* **A control-port socket leaked between identities**, so a previous identity's connection could
  outlive New Identity. Found by the isolation test.
* **Bridge lines kept a trailing newline**, which made tor refuse to start with a pluggable
  transport and left Veil reporting a bootstrap failure with no useful reason.
* **`sweepStale` deleted a folder it did not own** if the ownership marker file was missing,
  instead of keeping it. Ownership and liveness are now established before anything is removed, and
  a folder that is young and unowned is kept for a bounded period rather than deleted.
* Windows: the tor data directory inherits no access from `%TEMP%` any more, an `icacls` failure is
  surfaced instead of ignored, and retry logic is bounded with the reason reported after the last
  attempt.

### Known limitations in this release

Disclosed rather than fixed, and stated the same way in the README and the release notes:

* Windows builds are **unsigned**. SmartScreen will warn on first run; there is no certificate and
  no reputation, and nothing is done to disguise that.
* **No font bundle** is shipped for Windows, so the installed font list stays observable from a
  page (`document.fonts`, DOM and canvas measurement). This is a real fingerprinting surface and the
  self-test reports it as `KNOWN` on every run.
* No ARM64 Windows build. No Windows 7/8/8.1 support.
* Tor Browser parity is **not** claimed. Veil is Electron and Chromium; Tor Browser is Firefox with
  a hardened engine, a tamper-resistant updater and years of audits. Veil has none of that.
* Veil is not security-audited by anyone. See [SECURITY.md](SECURITY.md).

### Notes

* macOS and Linux behaviour is unchanged in intent: the same kill switch, the same per-site
  partitions, the same amnesic storage. Those platforms still expect a system tor unless you run
  `npm run tor:fetch`.
* Documentation for the Windows work: [docs/WINDOWS_SUPPORT.md](docs/WINDOWS_SUPPORT.md),
  [docs/WINDOWS_BUILD.md](docs/WINDOWS_BUILD.md),
  [docs/WINDOWS_TESTING.md](docs/WINDOWS_TESTING.md),
  [docs/WINDOWS_REVERSE_ENGINEERING.md](docs/WINDOWS_REVERSE_ENGINEERING.md),
  [docs/security/WINDOWS_SECURITY_AUDIT.md](docs/security/WINDOWS_SECURITY_AUDIT.md),
  [docs/security/SECURITY_TEST_RESULTS.md](docs/security/SECURITY_TEST_RESULTS.md),
  [docs/security/THREAT_MODEL.md](docs/security/THREAT_MODEL.md),
  [docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md).

## Before 1.0.0

The initial macOS/Linux implementation, developed in the open but never packaged as a release: Tor
routing with a managed private tor process (ADR 0002), per-site circuit isolation through
`IsolateSOCKSAuth` (ADR 0003), the kill switch and leak prevention (ADR 0004), amnesic in-memory
per-site storage (ADR 0005), fingerprint resistance (ADR 0006, 0011), the community onion network
(ADR 0007), privileged UI separation (ADR 0008), and built-in ad blocking (ADR 0009).
