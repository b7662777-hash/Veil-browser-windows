# Veil — Windows port: reverse engineering & compatibility audit

**Audited:** Veil v1.0.0 (`893d2a4c16ee`, zip of `veil-main`)
**Audit host:** Windows 11 build 26200, x64 · Node.js 26.13.0 · npm 11.20.0 · Electron 45.0.0
**Date:** 2026-11-01
**Method:** every file in the repository read (`src/`, `scripts/`, `docs/`, `.github/`, `assets/`, `community/`),
a repository-wide grep audit for platform-specific constructs, and **live runtime probes against a real
Tor daemon on Windows** (see §9) rather than assumptions.

Nothing in this file is inferred from `docs/ARCHITECTURE.md` or the ADRs alone. Where the documentation and
the code disagree, the code wins and the disagreement is recorded (§2).

---

## 1. Architecture as actually implemented

7,400 lines total; 3,277 lines of JavaScript. No framework beyond Electron + 2 runtime deps.
No build step, no transpiler, no bundler: `npm start` runs `electron .` against plain CommonJS.

```
main.js ──┬── tor.js        TorManager  — spawns/owns the private tor process (ADR 0002)
          ├── relay.js      IsolationRelay — local SOCKS5 listener per first party (ADR 0003)
          ├── control.js    TorControl — control-port client (cookie auth)
          ├── community.js  Community — signed directory, ADD_ONION hosting, client auth (ADR 0007)
          ├── adblock.js    AdBlocker — prebuilt @ghostery/adblocker engine (ADR 0009)
          ├── bookmarks.js  Bookmarks — the only opt-in on-disk state
          ├── contextmenu.js/ demo.js/ selftest.js
          ├── preload/ui.js    → contextBridge, sandboxed, contextIsolation:true   (ADR 0008)
          ├── preload/page.js  → patches page globals, sandboxed, contextIsolation:FALSE (ADR 0006)
          └── renderer/         ui.html/css/js + pages/{hub,leaktest,history,routing}.html over veil://
```

Data path of a page load, verified end to end:

`WebContentsView` (per-site partition) → `ses.setProxy socks5://127.0.0.1:<relay port>` →
`IsolationRelay._handle` (adds username=site, password=`nonce:salt`) → tor `SocksPort` with
`IsolateSOCKSAuth` → circuit. `onBeforeRequest` refuses everything unless `tor.ready` (kill switch).

Key structural facts that matter for the port:

| Fact | Where | Consequence for Windows |
|---|---|---|
| Process model is `BaseWindow` + `WebContentsView`, never `BrowserWindow` | main.js:944-958 | Custom-drawn toolbar; window chrome must be handled per-OS |
| Every site gets a *non-persistent* partition (`veil-<hash>`, `cache:false`) | main.js:229-246 | No disk layout assumption; portable as-is |
| `contextIsolation:false` in page preloads is deliberate, not an oversight | main.js:333, page.js:1-4 | Must not be "fixed"; it is compensated by `sandbox:true` |
| tor's data dir is a fresh `mkdtemp` under `os.tmpdir()` | tor.js:73 | Windows `%TEMP%` works, but cleanup semantics differ (§4, W6/W13) |
| `--__OwningControllerProcess` is the orphan backstop | tor.js:108 | **Verified working on Windows** (§9, R1) |
| GeoIP files are located from the *binary's* real path | tor.js:111-118 | Breaks on Windows: no `../share/tor` (§4, W5) |

## 2. Documentation vs. implementation

The docs are unusually accurate. Verified true: the 37-check self-test count (README.md:68, ci.yml:23 —
exactly 37 `check(` call sites in `selftest.js`); the `torrc` flags attributed to Tor Browser (tor.js:95-110
really does pass `KeepAliveIsolateSOCKSAuth ExtendedErrors IPv6Traffic PreferIPv6` and `DormantCanceledByStartup 1`);
the `V3Auth` discovery (community.js:103-109 really sends `Flags=DiscardPK,V3Auth`); and the isolation design
matching `TorDomainIsolator` (relay.js:102-111).

Discrepancies found:

| # | Documented | Actual | Impact |
|---|---|---|---|
| D1 | README.md:159-160 "release builds also ship lyrebird … licence included next to the binary" | `package.json` `extraResources` ships only `lyrebird` + its license. **tor itself is never bundled** — it is a Homebrew/apt prerequisite (README.md:58). | Windows has no system tor; a port that only fixes path lookup would still ship an app that cannot connect. Bundling tor is a *new* requirement, not a relocation. |
| D2 | REVERSE_ENGINEERING.md:38 "`ClientTransportPlugin … lyrebird / conjure`  # Veil: missing" | Only `lyrebird` is supported (tor.js:87-88). `conjure-client` (WebTunnel/conjure) is never referenced. | Bridge claim is narrower than the ADR-0011 table implies; `webtunnel` is listed in the `exec` transport name list but depends on the same single binary. |
| D3 | ADR 0011 offers "obfs4, Snowflake, meek (Tor Browser's `pt_config.json`)" as built-in bridge choices | `BRIDGE_MODES = ['none','snowflake','obfs4','meek','custom']` (main.js:61) reads `PT_CONFIG.bridges[mode]` (main.js:670). The `meek` and both `snowflake` lines point at `192.0.2.20` / `192.0.2.3` / `192.0.2.4` — RFC 5737 TEST-NET-1 documentation addresses — which I first read as *template* lines that can never connect. **Measured (R19): all three modes bootstrap on Windows with these exact lines.** For snowflake and meek the address field is unused: lyrebird takes the real endpoint from `url=`/the broker list. What remains true is the structural complaint — Veil trusts these lines with no liveness signal, and a mode whose lines stop working gives the user only a timeout. | MEDIUM (censorship robustness, not a leak): fixed by V-A (fail closed) + R20 (stall deadline). |
| D4 | ADR 0005 amnesic; TODO "no disk writes" | `settings.json` (main.js:664) and `bookmarks.json` (bookmarks.js:13) are written, and `community-keygen.js` writes a **private** key with `mode:0o600` | Documented in ADR-0011 consequences, but the `0o600` is a silent no-op on Windows (§4, W14). |
| D5 | README/`fetch-lyrebird.sh` "verifies its signature against the Tor Browser Developers key" | `fetch-lyrebird.sh:23` greps `VALIDSIG … EF6E286DDA85EA2A4BA7DE684E2C6E8793298290` — correct, but only for the *macOS dmg / Linux tar* it downloads; **no hash is recorded anywhere** | Port must record SHA-256 + version + arch per artifact (release requirement §5 of the brief). |

## 3. Platform dependency inventory

Exhaustive — the grep audit found only these three hardcoded Unix path sets in shipped code:

| File:line | Construct | Kind |
|---|---|---|
| `src/main/tor.js:10` | `/opt/homebrew/bin/tor`, `/usr/local/bin/tor`, `/usr/bin/tor` | Unix-only binary discovery |
| `scripts/bridges-setup.js:8,11-12` | `Contents/MacOS/Tor/PluggableTransports/lyrebird`, `/Applications/Tor Browser.app`, `~/Desktop/veil-re/…` | macOS bundle layout |
| `scripts/fetch-lyrebird.sh` | `bash`, `uname`, `mktemp -d`, `curl`, `gpg`, `hdiutil`, `tar -xJf`, `GNUPGHOME` | macOS/Linux-only acquisition |
| `package.json:13` | `"selftest": "VEIL_SELFTEST=1 electron ."` | POSIX env-assignment prefix |
| `package.json:14` | `"dist": "electron-builder --publish never"` | portable, no change needed |
| `tor.js:23`, `bridges-setup.js:23` | `chmod 0o755`, `0o600` modes | POSIX permission semantics |
| `main.js:1084` | `SIGTERM`, `SIGINT`, `SIGHUP` handlers | POSIX signal semantics |
| `main.js:948` | `titleBarStyle:'hiddenInset'`, `trafficLightPosition` | macOS window chrome |
| `renderer/ui.css:32` | `padding: 0 10px 0 80px` + `-webkit-app-region: drag` | space reserved for traffic lights |
| `main.js:904` | accelerator `'Ctrl+CmdOrCtrl+F'` | macOS full-screen gesture |

Everything else is already platform-neutral: `relay.js` and `control.js` use only `net`; `path.join` is used
for all internal paths (no string concatenation with `/`); `adblock`/`tldts` are pure JS with no native
bindings; `process.resourcesPath` is already consulted (tor.js:22); and the fingerprint layer already has a
`windows` bucket (`main.js:34-40`, `page.js:13`, `page.js:129` — Segoe UI font list). **The port does not need
to touch the anonymity core.** That is the most important finding of this audit.

## 4. Windows incompatibilities

Severity: **BLOCKER** = app cannot run · **FUNCTIONAL** = feature broken/silent · **SECURITY** = an anonymity
property is at risk · **COSMETIC**.

| ID | File:line | Problem | Sev | Evidence / required fix |
|---|---|---|---|---|
| W1 | tor.js:10-15 | Discovery returns the bare string `'tor'`; `spawn` without `shell` cannot resolve `.exe` from `%PATH%` the way a POSIX `execvp` does → `ENOENT`. | BLOCKER | `where tor` → not found. Fix: `platform.resolveTor()` candidate list incl. bundle dir, `VEIL_TOR_PATH`, `%PROGRAMFILES%\Tor*`, PATH probe. |
| W2 | tor.js:122 | Error text tells Windows users to `brew install tor`. | FUNCTIONAL | Platform-appropriate remediation string. |
| W3 | tor.js:20-23 | `LYREBIRD` never gets `.exe`; dev path (`__dirname/../../bin/lyrebird`) is tested **first** and shadows the packaged `Resources/bin`. | BLOCKER (bridges) | Windows executable name is `lyrebird.exe`. |
| W4 | tor.js:87-88 | `exec ${LYREBIRD}` writes a raw Windows path into torrc. **A path containing a space cannot be expressed at all**: tor splits the value at whitespace, and quotes do not protect it (they stay in the token). Corrects the earlier note in this row, which claimed unquoted spaced paths worked — they do not. | BLOCKER (bridges) | §9 R7/R8 (all four spellings truncate) and R11. The bundle's own `torrc-defaults` proves the intended form: `exec TorBrowser\Tor\PluggableTransports\lyrebird.exe` — a **relative** path resolved against tor's cwd. Fixed: `transportSpawn()` emits `exec pluggable_transports/lyrebird.exe` and spawns tor with `cwd` = the bundle directory; verified end-to-end from a directory named `…\Program Files\Vèil Browser` (R11, R12). |
| W5 | tor.js:111-118 | GeoIP found via `realpathSync(dirname(bin))/../share/tor` (Homebrew/FHS layout). Absent on Windows → flags never passed. | FUNCTIONAL (silent) | Spike: tor logs `Parsing GEOIP IPv4 file …` **only** when `--GeoIPFile` is given explicitly. Without it `GETINFO ip-to-country/*` fails → `veil://routing` and the circuit panel show no country names. Not a leak; a degraded feature nobody notices. |
| W6 | tor.js:194 | `proc.kill('SIGTERM')` on Windows is `TerminateProcess` — an **immediate hard kill**. | SECURITY (amnesic) | Measured: tor exited in **12 ms**, `code = null`. No graceful stream/lookup drain, and tor cannot do its own state cleanup. Fix: control-port `SIGNAL SHUTDOWN`, bounded wait, then `kill()`. |
| W7 | main.js:948 | `titleBarStyle:'hiddenInset'` + `trafficLightPosition` are ignored on Windows → native title bar **plus** the 76px custom toolbar. | COSMETIC/UX | Use `titleBarStyle:'hidden'` with `titleBarOverlay` (or `frame:false`) on Windows; keep macOS path unchanged. |
| W8 | ui.css:32 | 80px left padding reserved for traffic lights is dead space on Windows. | COSMETIC | Platform-aware padding. |
| W9 | package.json:13 | `VEIL_SELFTEST=1 electron .` is invalid in `cmd`/PowerShell. | BLOCKER (tooling) | `npm run selftest` fails on Windows. Fix with `cross-env` or a Node launcher; must keep working on macOS/Linux. |
| W10 | package.json:32-80 | No `win` target, no `.ico`, and `extraResources` ships only lyrebird — **tor.exe, geoip, geoip6, DLL-free runtime and licenses are not packaged**. | BLOCKER (release) | Add `win` nsis+portable, bundle the acquired Windows tor set. |
| W11 | scripts/bridges-setup.js | macOS bundle paths + `chmod 0o755` (no-op on NTFS). | BLOCKER (bridges) | Rewrite cross-platform, driven by the acquired artifacts. |
| W12 | scripts/fetch-lyrebird.sh | `#!/usr/bin/env bash`, `hdiutil`, `uname` — cannot run in Windows CI. | BLOCKER (CI) | Replace with a Node acquisition script; gpg is available here (`C:\Program Files\Git\usr\bin\gpg.exe`). |
| W13 | main.js:1084 | `SIGHUP` does not exist on Windows; closing a console window sends `CTRL_CLOSE_EVENT`, which terminates Node without running handlers → `before-quit` (main.js:1076) never fires. | SECURITY (amnesic) | Tor's own dir is left in `%TEMP%`; relies on the next launch's sweep (§6, V-C makes that sweep unsafe). Fix: bounded retry sweep + owned-handle shutdown. |
| W14 | main.js:664, bookmarks.js:13, community-keygen.js:13 | `{mode:0o600}` is ignored on NTFS; files inherit the parent ACL. | SECURITY (local) | `settings.json` (bridge lines), `bookmarks.json`, and the community **private** key become readable by every user in that ACL scope. Fix: explicit ACL hardening where practical + document the residual risk. |
| W15 | community.js:45-46 | `path.join(root, path.normalize(rel))` then `file.startsWith(root)`. On a case-insensitive FS this (a) rejects legitimate case-differing roots and (b) admits a sibling-prefix escape (`…\sites` vs `…\sitesecret`). | SECURITY | Not Windows-only, but Windows makes it live. Fix with `path.resolve` + separator-aware containment test. |
| W16 | tor.js:38-50 | `sweepStaleDataDirs` is unsafe on Windows: `fs.readdirSync(tmpdir())` throws if the dir is missing (kills startup); `fs.statSync(dir)` inside the `catch` can itself throw; `rmSync` has **no `maxRetries`** so one AV-locked file aborts the whole sweep; and `process.kill(pid,0)` succeeds for a **recycled PID** belonging to an unrelated process, so a stale dir is skipped forever. | SECURITY (amnesic) | Windows reuses PIDs aggressively; Defender/OneDrive scan new directories. Needs identity checks + bounded retries + isolation of per-directory failures. **Note (§9, Probe B): a rename/delete probe is NOT usable** — a live tor's DataDirectory renamed successfully, so the filesystem cannot tell us whether the owner is alive. Ownership must therefore be recorded by Veil and validated against the *boot session*. |
| W17 | main.js:904 | Accelerator `Ctrl+CmdOrCtrl+F` duplicates `Ctrl` on Windows. | COSMETIC | `F11` on Windows. |
| W18 | tor.js:25-35, 75-76 | `freePort()` binds, reads the port, then **closes** it (TOCTOU). Windows' dynamic-port range plus Hyper-V/WinNAT reserved ranges make re-allocation races more likely than on macOS. | FUNCTIONAL | tor then fails to bind a port Veil already "reserved". Mitigate: verify bind, surface a distinct error, retry. |
| W19 | main.js:152 | `app.getPath('downloads')` | OK | Present on Windows; no change. |
| W20 | main.js:969 | `requestSingleInstanceLock` | OK | Works on Windows via named mutex. |
| W21 | tor.js:130-137 | stdout is split on `\n` only, so every Windows line keeps a trailing `\r`; `/Bootstrapped (\d+)%[^:]*: (.*)$/` then matches nothing and bootstrap progress is invisible. | BLOCKER (silent) | Found in Phase 2 runtime, not by reading: tor reached 100 % while `progress` stayed 0 and `ready` stayed false. Fails *closed* (kill switch keeps blocking), so it presents as "Veil never connects". Fix: strip `\r` (§9 R14). |
| W22 | tor.js (new `protectFile` on a directory) | `icacls <dir> /inheritance:r /grant:r USER:F` applied **after** files exist makes those files undeletable by their own owner (`EPERM`), so the amnesic wipe can never finish. | SECURITY (amnesic) | §9 R17 A/B test: same ACL on an empty dir or on the file itself → deletes cleanly. Fix: `protectDirEmpty()` before anything is written, plus per-file `protectFile()` for secrets. |
| W23 | tor.js:186 / control.js:58-63 | `await control.signal(...)` on a socket tor has already closed leaves the promise queued forever; with no other handle pending **Node exits 0 in the middle of the quit path**. | BLOCKER (shutdown) | §9 R16. Fix: bound the await (1.2 s), reject `command()` on a dead socket, drop queued commands on `error` as well as `close`. |
| W24 | scripts/fetch-lyrebird.sh + any gpg/tar call | Git-for-Windows `gpg`/`tar` are MSYS builds: they read `C:\Users\…` as a path *relative to the cwd* (`keyblock resource '/r/AAAA/veil-main/C:\Users\…'`, `tar: Cannot connect to C: resolve failed`). Forward slashes alone do not fix gpg. | BLOCKER (tooling) | Fixed by running both with `cwd` = the scratch directory and **only relative arguments** — works for MSYS and native builds alike. |
| W25 | `npm run dist` output directory inside an agent-watched tree | electron-builder cannot unlink `dist\win-unpacked.tmp\resources\default_app.asar` (`EBUSY`, R22): a watcher holds the freshly extracted asar open. Nothing to do with Veil's code, but it stops a Windows build dead in this environment. | BLOCKER (tooling, environment) | Documented workaround: build with `--config.directories.output=<path outside the watch root>` (used for every artifact in §11). CI runners have no such watcher, so `npm run dist` stays as-is. |

## 5. Existing security controls — and where the port could break them

Verified present and effective (and platform-neutral, so the port must preserve them):

- **Kill switch** — three layers: `onBeforeRequest` gate on `tor.ready` (main.js:184-186), the relay refusing
  to forward until ready (relay.js:80), and `host-resolver-rules MAP * ~NOTFOUND` (main.js:78). Default and
  internal sessions separately cancel all network (main.js:977, main.js:266). `proxyBypassRules:'<-loopback>'`
  is set per-session (main.js:239), so even localhost cannot be reached directly.
- **DNS** — Chromium's resolver is neutered engine-wide; resolution happens remotely in tor. `networkTest()`
  proves it with `ses.resolveHost('example.com')` (main.js:696-709).
- **Circuit isolation** — `username=site`, `password=nonce:salt` (relay.js:59-61); salt increments per site
  (relay.js:140), nonce rotates globally on New Identity (relay.js:145-153).
- **Storage isolation** — one non-persistent partition per site per identity nonce (main.js:233).
- **Amnesic** — fresh `mkdtemp` tor dir, wiped on exit and on the next start (tor.js:189-195, 38-50).
- **Fingerprint** — per-OS UA bucket, `sec-ch-ua-*` header stripping, `Accept-CH` suppression, forced media
  queries via CDP, letterboxing to 200×100 (main.js:519-549), canvas noise seeded per site+identity, 16.67 ms
  timer clamping, font allowlists, WebGL vendor masking, WebRTC/`connection`/`serviceWorker` removal.
- **UI separation** — `ui.js` uses `contextBridge` + `contextIsolation:true` + `sandbox:true`; `veil:ui`
  validates `e.sender === uiView.webContents` (main.js:713-715) and allowlists commands (main.js:820-823);
  internal pages additionally require `senderFrame.url.startsWith('veil://')` (main.js:717-720) and an
  offline-capability split (`OFFLINE_OK`, main.js:826).

Weaknesses found during the audit (independent of, or aggravated by, Windows):

| ID | Finding | Severity | Note |
|---|---|---|---|
| V-A | **Bridge intent was not enforced.** `start()` wrote `UseBridges 1` only `if (bridges.length)` (tor.js:80-91), so an empty bridge list silently started tor **directly** — a censored user asking for a bridge and getting plain Tor. `setConnection` answered `{ok:true}` either way. | SECURITY-adjacent (censorship) | **Fixed:** `main.js:bridgeConfig()` now sends `{bridges, requireBridge, mode}` and `TorManager._start()` fails closed when `requireBridge` and the list is empty ("Not connecting directly: that would put your traffic on the open network"); `setConnection` re-throws `tor.error` instead of reporting ok. A missing/unusable transport already failed closed (tor.js `_spawn`). |
| V-B | `ipcMain.on('veil:page-config')` (main.js:722-725) has **no sender check**, and it is a synchronous `sendSync` reply available to any sandboxed page preload. Contents (`seed`, `level`, `os`) are low-sensitivity, so this is defence-in-depth, not a leak. | LOW | Add `tabFor(e.sender)` validation for consistency with the other channels. |
| V-C | `sweepStaleDataDirs` trust model: a directory with no `veil.pid` but <24h old is *kept*; with a `veil.pid` whose PID is alive it is *kept*. PID recycling on Windows (W16) makes "kept" the wrong answer. | MEDIUM | Fix with executable-identity verification + age ceiling. |
| V-D | `customBridges` are written into torrc as `Bridge ${line}` after splitting on `\n` and stripping a leading `Bridge` (main.js:849) — newline injection is blocked, but the line is otherwise unvalidated and unbounded in length. | LOW | **Fixed:** `setConnection` rejects a pasted line longer than 512 chars or whose first token is not a transport name / `ip:port` / URL (`BRIDGE_LINE`, main.js) before it reaches torrc, and names the offending line in the error. |
| V-E | `tor.stop()` swallows all cleanup failures (`catch {}`, tor.js:190) — an un-wiped amnesic directory produces **no diagnostic**. | MEDIUM | Contradicts the brief's "do not silently ignore cleanup failures". |
| V-F | `restart()` calls `stop()` then `await start()` (tor.js:176-181) without awaiting tor's actual exit; the new tor and the old one briefly coexist, and `relay.torPort` is reassigned by the caller (main.js:676) after the restart. | MEDIUM | Race during bridge switching; must serialize on the exit event. |
| V-G | Download handler is a **synchronous modal** per file (main.js:142-155) via `dialog.showMessageBoxSync` — blocks the main process; a page triggering many downloads stalls tor control traffic. | LOW | |

## 6. Required modifications

| Phase | Change | Files |
|---|---|---|
| 1 | New single source of platform truth; nothing else branches on `process.platform`. | `src/main/platform.js` (new) |
| 2 | tor discovery (bundled → env → system), GeoIP/transport resolution, quoted torrc values, graceful-then-forced shutdown, safe stale-dir sweep with bounded retries. | `src/main/tor.js` |
| 3 | Signature-verified acquisition of the official Windows expert bundle (tor.exe, lyrebird.exe, conjure-client.exe, geoip, geoip6, licenses) with recorded SHA-256/version/arch; cross-platform bridge setup; bridge-mode validation (V-A). | `scripts/fetch-tor.js`, `scripts/bridges-setup.js`, `main.js:setConnection` |
| 4 | Windows window chrome, accelerators, UI padding; ACL hardening for on-disk state; `veil:page-config` sender check; path-containment fix; restart serialization. | `main.js`, `ui.css`, `ui.html`, `community.js` |
| 5 | `win` build targets (nsis + portable), icon, extraResources for the whole tor set. | `package.json`, `build/icon.ico` |
| 6 | Cross-platform npm scripts; unit/integration/security tests that run on Windows; Windows CI. | `package.json`, `tests/`, `.github/workflows/windows.yml` |

Explicitly **not** changed: `relay.js`, `control.js` (verified working unmodified on Windows against real tor,
§9), the fingerprint layer, the kill switch, the partition scheme, the IPC command allowlists, and the UI design.

## 7. Dependencies to replace or add

| Dependency | Verdict |
|---|---|
| Homebrew `tor` formula | **Replace.** Bundle the Tor Project's signed `tor-expert-bundle-windows-x86_64`; keep `VEIL_TOR_PATH` and PATH lookup as optional overrides. |
| lyrebird copied out of a locally installed Tor Browser.app | **Replace.** Same signed expert bundle already contains `pluggable_transports/lyrebird.exe` — no Tor Browser install and no NSIS extraction needed (verified, §9 R4). |
| `fetch-lyrebird.sh` (bash) | **Replace** with a Node script that works on all three OSes. |
| `VEIL_SELFTEST=1` shell prefix | **Replace** with `cross-env` or a Node launcher. |
| `@ghostery/adblocker`, `tldts` | **Keep.** Pure JS, no native compilation; installed cleanly on Windows (`npm install` → 296 packages, exit 0). |
| `electron@45`, `electron-builder@26` | **Keep.** Windows x64 binaries exist; note that npm ≥11's script policy blocks Electron's `install.js` postinstall, so the binary must be fetched explicitly (`node node_modules/electron/install.js`) or the script approved. |
| New: none for signing | Verification uses the **already-present** `gpg.exe` from Git for Windows; no new dependency. |

## 8. Build & runtime requirements (Windows)

- Windows 10 2004+/11, x64. **No Visual C++ redistributable is required** — PE import analysis of the acquired
  `tor.exe` (SHA-256 `1607d98f…fb1074`, 10,247,168 bytes, PE32+ amd64) shows 307 imports across 21 DLLs and
  **every one of them is in-box**: `KERNEL32`, `WS2_32`, `SHELL32`, `SHLWAPI`, `ADVAPI32`, `IPHLPAPI`, `USER32`,
  `CRYPT32` and `api-ms-win-crt-*` (UCRT, shipped with Windows 10+). There is no `vcruntime140.dll`, and
  OpenSSL 3.5.9 / libevent 2.1.13 / zlib 1.3.2 are statically linked (the bundle ships no DLLs at all).
  Runtime confirmation: `tor.exe --version` and a full bootstrap both succeeded on this host.
- Node.js ≥20 for development; `npm ci` must be followed by the Electron binary fetch (see §7).
- `gpg` (Git for Windows) and `curl` for artifact verification; both confirmed present here.
- Outbound access to `dist.torproject.org` only at build time. At *run* time Veil needs nothing but Tor.
- No WSL, no Homebrew, no separate Tor install for the end user (release requirement 5.6).

## 9. Runtime evidence collected on Windows

Probe 1 — Veil's exact torrc/argument set against a real tor (spike, then re-run through Veil's own
`TorControl` class, unmodified):

| # | Result | Detail |
|---|---|---|
| R1 | `mkdtemp` in `%TEMP%`, GeoIP loaded, **bootstrap 100 %** | `Bootstrapped 100%: Done`, `Parsing GEOIP IPv4/IPv6 file` |
| R2 | Cookie control auth, `TAKEOWNERSHIP`, `SIGNAL NEWNYM`, `GETINFO version/circuit-status` | `version: 0.4.9.15`; 12 circuits listed |
| R3 | **Per-site isolation works** | 5 circuits carrying `SOCKS_USERNAME=`; two distinct credentials produced three *different* 3-hop paths |
| R4 | `ADD_ONION`/`DEL_ONION`, incl. invite-only `Flags=DiscardPK,V3Auth ClientAuthV3=…` | Community hosting is functional on Windows |
| R5 | Orphan prevention: the controller process **crashed** mid-run | tor exited by itself via `--__OwningControllerProcess`; `Get-Process tor` → none |
| R6 | `SIGTERM` semantics | exit `code=null` after **12 ms** → hard kill, not graceful (→ W6) |
| R7 | Pluggable transport launch, **absolute path containing a space**, unquoted | **CORRECTED (was recorded as working).** tor reports the program as the value up to the first space: `Managed proxy "C:\Users\…\veil-pt-4KG0qk\Program" changed state: Infant -> Waiting`, then `Delaying directory fetches: No running bridges` — the PT never registers. `probe-pt-spaces.js`, 4 spellings, all truncated. |
| R8 | Same line with the path **quoted** (backslash or forward slashes) | Also truncated, *and* the quote stays in the token: `Managed proxy ""C:\Users\…\Program"`. **No torrc spelling can express a path with a space.** The official Windows `torrc-defaults` in the same bundle uses a *relative* path (`ClientTransportPlugin … exec TorBrowser\Tor\PluggableTransports\lyrebird.exe`) for exactly this reason. |
| R9 | Live tor's DataDirectory rename probe | **succeeded while tor ran** (`lock`, `state`, `keys`, `pt_state`, `control_auth_cookie` all present) → the filesystem cannot prove liveness; ownership token + boot-session check required (→ W16) |
| R10 | `tor.exe` PE imports | 307 imports / 21 DLLs, all in-box (UCRT + kernel32/ws2_32/advapi32/iphlpapi/crypt32/shell32/user32/shlwapi); no VC++ redist, no DLLs shipped (→ §8) |
| R11 | **Relative exec + `cwd`** from a root named `…\Program Files\Vèil Browser` (space + non-ASCII) | lyrebird spawns with the full path intact: `Managed proxy "pluggable_transports\lyrebird.exe"` → `CMETHOD meek_lite/obfs2/obfs3/obfs4/scramblesuit/webtunnel` → `configuration completed!`. Forward- and back-slash relative forms behave the same. |
| R12 | **Snowflake bridge bootstrap through the shipped `TorManager`** | `restart({bridges:[snowflake]})` → `Bootstrapped 100%`, `status.bridged = true`, using `exec pluggable_transports/lyrebird.exe` + `cwd`. Transports are functional on Windows, not merely configurable (→ §6 phase 3). |
| R13 | Bundled obfs4 line `37.218.245.14:38224` (from `assets/pt_config.json`) | **SUPERSEDED by R19 — the conclusion was wrong.** At the time of this probe the PT launched, registered `obfs4`, and bootstrap sat at 10 % with `Delaying directory fetches: No running bridges`; I recorded that as "the shipped obfs4 lines are stale". Re-running the same lines through the same module later reached `Bootstrapped 100%` in 45 s. A slow bridge handshake looks identical to a dead one from a single observation — measure with a deadline, not a glance. |
| R14 | stdout line splitting | tor logs `\r\n` on Windows. `line.match(/Bootstrapped (\d+)%[^:]*: (.*)$/)` never matches a `\r`-terminated line because `.` excludes line terminators and `$` demands the true end → progress stayed **0 %** while tor had reached 100 %; the kill switch correctly kept blocking, so the app looked hung rather than unsafe. Fixed in `tor.js` (strip `\r`). |
| R15 | `SIGNAL SHUTDOWN` through Veil's `TorControl` | tor exits on its own, `code=0`, in **59–96 ms**. `TorManager.stop()` = 59 ms total including the wipe (→ W6 resolved; SIGTERM/TerminateProcess is now only the fallback). |
| R16 | Unbounded `await control.signal()` when tor has already exited | The queued promise never settles (no more `close` event) and **the Node event loop drains: the process exits 0 mid-quit**. Now raced against a 1.2 s bound, and `TorControl.command()` rejects immediately on a dead socket. |
| R17 | `icacls <dir> /inheritance:r /grant:r USER:F` applied *after* files exist | The pre-existing file becomes undeletable by its own owner: `rm` → `EPERM` on `veil.owner` after 6 attempts, while the directory ACL reads `<machine>\<user>:(F)`. Applying the same ACL to an **empty** directory, or to the file itself, deletes fine. → `platform.protectDirEmpty()`. |
| R18 | Ephemeral tor folder lifecycle in the shipped module | start → `dataDir` + `veil.owner`; `restart` → old dir `wiped=true`; `stop` → `dir gone=true`, `removeTree attempts=1`; `tasklist` → **0 stray `tor.exe`**; `sweepStale` → keeps a live owner's dir, removes a dead-owner dir, `failed=[]` |
| R19 | **All three built-in bridge modes bootstrap on Windows** through the shipped `TorManager`, using the shipped `assets/pt_config.json` lines (`probe-bridge-lines.js`) | snowflake → 100 % (R12); obfs4 (7 lines) → 100 % in **45 s**; meek (1 line) → 100 % in **100 s**. The `192.0.2.x` in the snowflake/meek lines is *not* a dead placeholder: lyrebird ignores that field and resolves the real endpoint from `url=`/the broker list (→ corrects D3). |
| R20 | Bridge deadline vs. measured times | The 90 s absolute watchdog armed at spawn would have **failed the working meek bridge** (100 s) and nearly failed obfs4 (45 s). Now a *stall* deadline (90 s without any bootstrap progress) with a 300 s overall cap, re-armed on every progress line (`tor.js`). |
| R21 | `npm run tor:fetch -- --platform linux --arch x64` on a Windows host | Signature verified against the pinned Tor Browser Developers key, sha256 recorded, image-format check run, and **execution correctly not claimed** (`executableCheck.skipped: cross-acquisition`). The Linux expert bundle contains `pluggable_transports/lyrebird` + `conjure-client` + `geoip`/`geoip6` + licences — i.e. `tor:fetch` is a superset of what `fetch-lyrebird.sh` used to produce, so the shell script is now a 4-line shim. |
| R22 | `npm run dist` **inside** this workspace | Fails reproducibly at `unlink dist\win-unpacked.tmp\resources\default_app.asar` → `EBUSY: resource busy or locked`, with no `Veil.exe`/`electron`/`app-builder` process holding it (checked `Win32_Process` by path and by command line). A file-system watcher in the tooling opens freshly extracted `.asar` files and keeps a non-shareable handle. Building with `--config.directories.output` pointed **outside** the watched tree succeeds first time. → W25 |
| R23 | Packaged `win-unpacked\Veil.exe` with `VEIL_SELFTEST=1` | tor bootstrapped, all internal pages ran, `traffic exits via Tor`, `two sites get different exit IPs`, `local DNS is impossible` — from the **packaged** build. Full run recorded in §11. |

## 10. Migration strategy

Execute in dependency order, smallest reversible change first, never breaking macOS/Linux:

1. **Isolate the platform seam** (`platform.js`) before touching behaviour, so every later fix is a data
   change rather than another `if (process.platform)`.
2. **Prove Tor first, UI second.** The spike already shows the anonymity core needs no porting work; get a
   real bootstrap in the app, then chase chrome/packaging.
3. **Acquire, don't assume.** tor/lyrebird come from a signature-verified official artifact with recorded
   hashes, so CI and a release are reproducible without a developer's Tor Browser install.
4. **Fix silent degradations explicitly** (W5 GeoIP, V-A bridge fallback, V-E cleanup swallow) — these are
   the class of bug that "the app launches" hides.
5. **Test on Windows, not about Windows.** Unit tests for path resolution run everywhere; Tor lifecycle and
   kill-switch tests run only where a real tor exists, and report `SKIPPED` rather than pretending.

## 11. Feature parity checklist

Status legend: `PASS` verified on Windows · `PARTIAL` works but not yet verified · `FAIL` broken on Windows
before the port · `N/A` platform-neutral, untouched.

| # | Feature | Source | Pre-port Windows status | Port target |
|---|---|---|---|---|
| 1 | Tor process launch | tor.js:95-120 | **FAIL** (W1 ENOENT) | PASS |
| 2 | Bootstrap progress UI | tor.js:140-149 | N/A — pure stdout parsing | PASS |
| 3 | Control-port cookie auth | control.js:12-26 | N/A (verified PASS, R2) | PASS |
| 4 | Kill switch / no fallback | main.js:78,184,266,977; relay.js:80 | N/A | PASS |
| 5 | Remote DNS only | main.js:78 | N/A | PASS |
| 6 | Per-site circuit isolation | relay.js:59-61 | N/A (verified PASS, R3) | PASS |
| 7 | New circuit / New identity | relay.js:140-153; main.js:596-634 | N/A | PASS |
| 8 | Per-site in-memory partitions | main.js:229-246 | N/A | PASS |
| 9 | Amnesic tor data dir | tor.js:73,183-196 | **FAIL** (W6 hard kill, W13 console close, W16 unsafe sweep) | PASS |
| 10 | GeoIP / country names in circuit map | tor.js:111-118 | **FAIL** (W5, silent) | PASS |
| 11 | Circuit viewer + `veil://routing` | main.js:637-646 | PARTIAL (works, no countries) | PASS |
| 12 | Traffic stats | control.js:112-115 | N/A | PASS |
| 13 | Fingerprint resistance | main.js:30-57,519-549; page.js | N/A — `windows` bucket already implemented | PASS |
| 14 | Security levels standard/safer/safest | main.js:313-319 | N/A | PASS |
| 15 | Ad & tracker blocking | adblock.js | N/A (pure JS, installed OK) | PASS |
| 16 | Panic wipe | main.js:619-623 | N/A | PASS |
| 17 | Leak test page | main.js:696-709 | N/A | PASS |
| 18 | Onion site browsing | relay.js + tor | N/A | PASS |
| 19 | Hosting onion services | community.js:93-128 | N/A (verified PASS, R4) | PASS |
| 20 | Invite-only hosting + client auth | community.js:83-91 | N/A (verified PASS, R4) | PASS |
| 21 | Signed community directory | community.js:67-81 | N/A | PASS |
| 22 | Bridges obfs4 / snowflake / webtunnel | tor.js:80-91 | **FAIL** (W3/W4/W11/W12) | PASS where an official Windows transport binary exists |
| 23 | Custom bridge lines | main.js:847-855 | **FAIL** (same torrc path issue) | PASS |
| 24 | Settings persistence (bridges) | main.js:652-665 | PARTIAL (W14 ACL) | PASS + hardened |
| 25 | Bookmarks | bookmarks.js | PARTIAL (W14 ACL) | PASS + hardened |
| 26 | Downloads via Tor + warning | main.js:142-155 | N/A | PASS |
| 27 | HTTPS-Only mode | main.js:187-195 | N/A | PASS |
| 28 | Onion-Location ".onion available" | main.js:158-167 | N/A | PASS |
| 29 | Referer onion-hiding | main.js:214-221 | N/A | PASS |
| 30 | ExtendedErrors onion messages | main.js:64-73 | N/A | PASS |
| 31 | Tabs / reorder / reopen / zoom / find / print / full-screen | main.js:283-500 | N/A | PASS |
| 32 | Right-click menu | contextmenu.js | N/A | PASS |
| 33 | Native window controls & taskbar icon | main.js:948 | **FAIL** (W7/W8/W17) | PASS |
| 34 | `npm ci` / `npm run check` | scripts/check.js | N/A (already cross-platform) | PASS |
| 35 | `npm start` | package.json:7 | N/A | PASS |
| 36 | `npm run selftest` | package.json:13 | **FAIL** (W9) | PASS |
| 37 | `npm run bridges:setup` | package.json:11 | **FAIL** (W11) | PASS |
| 38 | `npm run dist` → Windows installer | package.json | **FAIL** (W10, no `win` target) | PASS (nsis + portable) |
| 39 | Windows CI | .github/workflows | **FAIL** (none exists) | PASS |
| 40 | `docs/re/fp.html` fingerprint harness | main.js:1020-1030 | N/A (`VEIL_FP` env — needs W9 fix) | PASS |
