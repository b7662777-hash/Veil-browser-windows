# Building Veil for Windows

Everything here was run on Windows 11 x64 (10.0.26200) with Node v24 and npm 11. The same commands
run on macOS and Linux and produce those platforms' targets — this file is about the Windows path.

## Prerequisites

| | |
|---|---|
| Node.js | 22 or newer (`.github/workflows/windows.yml` uses 22; the local machine builds with 24) |
| `gpg` | required by `npm run tor:fetch` to verify the Tor Project signature. Candidate paths tried in order: `gpg` on `PATH`, `%PROGRAMFILES(X86)%\GnuPG\bin`, `%PROGRAMFILES%\GnuPG\bin`, `C:\Program Files\Git\usr\bin\gpg.exe` (the one that ships with Git for Windows) |
| Disk | ~2 GB free: `node_modules`, the unpacked build tree, and two release artifacts |
| Signing | **none required, and none available.** `CSC_IDENTITY_AUTO_DISCOVERY=false` is set deliberately so electron-builder does not hunt for a certificate; the outputs stay unsigned and say so |

## 1. Install and verify the app's own integrity

```powershell
npm ci          # reproducible: package-lock.json is committed
npm run check   # every .js parses, internal pages compile, community signature verifies
npm run test:unit
```

`npm ci` rather than `npm install` in CI, so a drifted dependency cannot silently enter a release.

## 2. Get tor, and prove where it came from

```powershell
npm run tor:fetch
```

This is the part that must not be shortcut. `scripts/fetch-tor.js`:

1. reads the pinned version from `scripts/fetch-tor.js` (`LOCKFILE`) — the Tor Browser 16.0
   **expert bundle** for `windows-x86_64`, from `https://dist.torproject.org/torbrowser/16.0/`;
2. downloads the `.tar.gz` **and its `.asc`**, over TLS, from the Tor Project's own host — never a
   mirror, never a random GitHub release, and never a Linux binary renamed to `.exe`;
3. imports the Tor Project signing key from `keys.openpgp.org` and requires it to match the pinned
   fingerprint `EF6E286DDA85EA2A4BA7DE684E2C6E8793298290`;
4. verifies the detached clearsign signature with `gpg --verify` before unpacking anything;
5. extracts to `bin/win32-x64/`: `tor.exe`, `torrc-defaults`, `geoip`, `geoip6`,
   `pluggable_transports/lyrebird.exe`, `pluggable_transports/conjure-client.exe`, `licenses/*`;
6. checks the PE header says **machine 0x8664 (x64)** and then actually **executes** `tor.exe
   --version` — a file that exists is not a file that runs;
7. writes `bin/win32-x64/manifest.json`: source URL, archive SHA-256 and byte count, the signature
   block (pinned fingerprint, key id, signing subkey), `torVersion` (0.4.9.15), the acquisition
   timestamp, and a SHA-256 for every extracted file.

`bin/` is gitignored. A build machine fetches its own copy and carries its own evidence; nothing is
committed but the recipe.

**Never** hand-place a `tor.exe` into `bin/` to make a build succeed. If the fetch fails, the fix is
the fetch.

## 3. Build

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
npm run dist        # electron-builder --publish never → veil-dist/
```

Two targets from one tree (`build.win.target` in `package.json`):

| target | artifact | what it is |
|---|---|---|
| `nsis` (x64) | `Veil-<version>-Windows-x64-Setup.exe` | per-user installer: `oneClick: false`, `perMachine: false`, `allowElevation: false`, licence page from `LICENSE`, Start Menu + desktop shortcuts, `runAfterFinish` |
| `portable` (x64) | `Veil-<version>-Windows-x64-Portable.exe` | single self-contained executable, `requestExecutionLevel: user`, unpacks to `%TEMP%` at run time |

`extraResources` copies `bin/win32-*/**` into `resources/bin/`, so **only** the Windows bundle goes
into a Windows build — the gate below fails if a `bin/darwin-*` or `bin/linux-*` directory turns up
inside it. A Unix or ARM executable bundled by accident would look fine in a file listing and would
fail at run time, which is the failure mode this filter exists to prevent.

`build.win.copyright`, `author.name` and `description` are the Windows port's attribution and are
covered in [CREDITS.md](CREDITS.md). **If any metadata or packaged About text changes, rebuild** —
the credits have to be in the bytes, not only in the docs.

## 4. Gate the artifacts

```powershell
node scripts/check-windows-artifacts.js veil-dist
```

28 checks, all of them against the files on disk:

- both artifacts exist and are non-trivial in size;
- the NSIS stubs are x86 **by design** (an NSIS installer is a 32-bit bootstrap), while
  `Veil.exe`, `tor.exe`, `lyrebird.exe` and `conjure-client.exe` are all x64 — the script asserts
  exactly that split rather than demanding everything be x64;
- `resources/bin/win32-x64/` contains tor, both transports, `geoip`, `geoip6`, the licence texts
  and the acquisition manifest;
- no `bin/darwin-*` or `bin/linux-*` inside the build;
- the manifest's source URL is the official `dist.torproject.org` one and its signature block says
  `verified: true`;
- `latest.yml` names the installer, and its `sha512` is recomputed from the installer bytes and
  compared — a release metadata file that does not match the artifact is caught here;
- the release directory holds no stray logs or caches;
- `SHA256SUMS.txt` re-hashes to what is actually on disk.

Exit status is 0 only if all of them pass; CI treats non-zero as a failed build.

## 5. Release evidence

```powershell
npm run release:evidence      # node scripts/release-evidence.js veil-dist
```

Writes, from the built bytes:

- `SHA256SUMS.txt` — one line per release artifact;
- `SBOM.json` — CycloneDX 1.5, 302 components: every npm package in the lockfile (with dev-only
  packages marked `excluded`), the tor bundle re-published from `manifest.json` including each
  per-file SHA-256 **re-hashed from disk** so the SBOM cannot claim a digest the shipped file does
  not have, the compiled ad-block engine, the OFL font, and the two artifacts themselves.

Then verify from a clean shell that the sums match what you will upload:

```powershell
Get-FileHash .\Veil-1.0.0-Windows-x64-Setup.exe -Algorithm SHA256
```

## 6. Run the packaged build, not just the source

`npm run selftest` executes from source. The packaged builds have to be tested as installed:

```powershell
# silent install into a throwaway folder
Start-Process -FilePath ".\Veil-1.0.0-Windows-x64-Setup.exe" -ArgumentList "/S" -Wait
$env:VEIL_SELFTEST = "1"
$env:VEIL_SELFTEST_REPORT = "$PWD\selftest-installed.txt"
& "$env:LOCALAPPDATA\Programs\Veil\Veil.exe"
```

`VEIL_SELFTEST_REPORT` exists because the NSIS portable launcher starts the app **without a
console**, so anything `console.log` prints is otherwise lost: the run is teed to a file as each
line happens, appended, so a run that dies halfway still leaves what it measured. The self-test also
redirects `userData` into a throwaway `%TEMP%\veil-selftest-<pid>` directory and removes it
afterwards with bounded retries (`P.removeTree`), because Chromium can still be holding storage
handles when the process exits.

`.github/workflows/windows.yml` runs exactly this in the `packaged` job, then **fails the build on
any `FAIL` line** and asserts that no `veil-tor-*` directory and no `tor.exe` process survived.

## Code signing: the honest state

There is no Windows code-signing certificate for this project. Consequences, stated rather than
worked around:

- SmartScreen shows a warning on first run and has no reputation to fall back on;
- some antivirus engines flag the unsigned self-extracting binary;
- the executable's "Digital signatures" tab says **Not signed**;
- nothing is faked: no self-signed certificate presented as authentic, no test build published as a
  release, no badge implying a scan that has not happened
  ([docs/security/VIRUSTOTAL.md](security/VIRUSTOTAL.md)).

Signing is a **release requirement**, documented as such. A code-signing certificate — an EV or OV
authenticode certificate, or Azure Trusted Signing — has to be obtained and its private key kept
outside the repository and outside CI logs. When one exists, the build changes to:

```powershell
$env:CSC_LINK = "<pfx path or keychain reference>"
$env:CSC_KEY_PASSWORD = "<from a secret store, never committed>"
npm run dist
```

and `.github/workflows/windows.yml` reads them from repository **secrets** — the workflow never
echoes them and never writes them to disk. `win.publisherName` then has to match the certificate's
subject exactly, and `SHA256SUMS.txt` plus the SBOM are regenerated from the *signed* bytes, because
signing changes them.

## Reproducing a published release

1. Check out the tag.
2. `npm ci` (the lockfile is committed, so the dependency tree is the same).
3. `npm run tor:fetch` — the manifest pins the bundle version and records the digests; compare the
   digests against the released SBOM.
4. `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist`.
5. `node scripts/check-windows-artifacts.js veil-dist` and `npm run release:evidence`.

Byte-for-byte reproducibility is **not** claimed: electron-builder embeds timestamps, the NSIS stub
is downloaded at build time, and tor is fetched fresh. Reproducibility here means the recipe and the
evidence are auditable, not that two builds hash the same.

## Updating the vendored data

```powershell
npm run adblock:update    # rebuilds assets/adblock.engine from EasyList + EasyPrivacy
npm run community:sign    # re-signs community/directory.json (key stays private: community/*.key is gitignored)
```

The ad-block engine is committed as data, not downloaded at run time, so every user gets the same
list — a per-user list would be a fingerprint. Both files are covered by `npm run check`.
