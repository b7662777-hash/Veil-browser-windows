# Veil for Windows — installation and support

For the Windows port. Upstream behaviour is documented in
[ARCHITECTURE.md](ARCHITECTURE.md) and the [ADRs](adr).

## Requirements

| | |
|---|---|
| OS | Windows 10 or 11, **64-bit** (x64). There is no ARM64 build. |
| Disk | the installer unpacks roughly 250 MB under `%LOCALAPPDATA%\Programs\Veil`; the portable build needs the same again in `%TEMP%` while it runs |
| Privileges | none — both builds run as your normal user. The installer never requests elevation. |
| Network | a path to the Tor network. If Tor itself is blocked where you are, you need a bridge before the first connection succeeds. |
| Nothing else | no Visual C++ redistributable, no Node.js, no separate tor, no Tor Browser install. `tor.exe` and the bridge transports are inside the build. |

## Install — Setup build

1. Download `Veil-<version>-Windows-x64-Setup.exe` and **verify its SHA-256** against
   `SHA256SUMS.txt` from the same release (commands in
   [README → Verify what you downloaded](../README.md#verify-what-you-downloaded)).
2. Run it. Windows will probably show the blue SmartScreen box, because the binary is unsigned and
   has no reputation. Read it as what it is: an absence of a signature, not a detection of malware.
   Only you can decide to continue; **More info → Run anyway** is the path if you have verified the
   hash and choose to proceed.
3. Pick a folder or accept the default (`%LOCALAPPDATA%\Programs\Veil`). It is a per-user install:
   it writes under your profile, needs no admin rights, and cannot escalate.
4. Veil starts when the install finishes (uncheck *Run Veil* if you would rather launch it later).

Launch it from the Start Menu entry **Veil**, from the desktop shortcut, or from a terminal:

```powershell
& "$env:LOCALAPPDATA\Programs\Veil\Veil.exe"
```

## Install — Portable build

`Veil-<version>-Windows-x64-Portable.exe` is one file. Put it anywhere you can read, double-click
it, and it extracts itself into a temporary directory, runs, and cleans up when it exits. Two
consequences worth knowing:

- the first window takes longer to appear than the installer build, because ~125 MB is being
  unpacked each time;
- while it runs there is a `%TEMP%` working copy of the whole app. That is normal, and it is gone
  after the process exits.

The portable build still writes its small persistent files (bookmarks, bridge settings) to
`%APPDATA%\Veil`, so switching between the two builds does not lose them.

## First launch

Veil starts its own `tor.exe` and shows `tor: <percent> · <what it is doing>` on the home page.
**Until Tor reports itself connected, every page load is cancelled** — that is the kill switch, not
a broken network stack. A cancelled load appears as an error page; the address bar and the leak
test work as soon as the circuit exists.

Expect the first bootstrap to take anything from a few seconds to a couple of minutes. If it stops
moving, see [Tor never connects](#tor-never-connects) below.

## What Veil writes to disk, and where

| path | what it is | removed when |
|---|---|---|
| `%TEMP%\veil-tor-<random>` | the tor data directory: circuit state, `control_auth_cookie`, nothing about the sites you visited | Veil shuts down. A leftover from a crashed run is swept by the next start, and only if the owner recorded in `veil.owner` is gone |
| `%APPDATA%\Veil\settings.json` | only the bridge mode and any bridge lines you pasted yourself. Veil restricts the file's ACL, because NTFS ignores the `0o600` mode bit | uninstall leaves it; delete it to reset |
| `%APPDATA%\Veil\bookmarks.json` | bookmarks, and only if you pressed `Ctrl+D` | `Panic` (`Ctrl+Shift+X`) deletes it |
| your Downloads folder | files you explicitly chose to save | you decide |

Browsing state — history, cookies, cache, `localStorage`, per-site partitions — lives in memory and
in a temporary profile that is deleted on exit. **There is no telemetry, no crash reporter, no
analytics and no update pinger in this build.** Veil does not phone home; the only outbound traffic
is the traffic you ask for, through Tor.

If Veil crashes and `%TEMP%\veil-tor-*` survives, do not attach that folder to a bug report. It is
tor's live state; a report that needs it is a security report and belongs in the private channel
([SECURITY.md](../SECURITY.md)).

## Uninstall

**Setup:** Settings → Apps → Installed apps → Veil → Uninstall, or the `Uninstall Veil.exe` in the
install folder. It is per-user and needs no admin rights. Bookmarks and bridge settings in
`%APPDATA%\Veil` are deliberately left in place (so a reinstall keeps them) — delete that folder to
remove everything.

**Portable:** delete the `.exe`. `%APPDATA%\Veil` is the only persistent thing it touched.

## Troubleshooting

### SmartScreen says "Windows protected your PC"
Expected for an unsigned binary. Verify the SHA-256 against `SHA256SUMS.txt` first; if it does not
match, do not run it and report it privately. If it matches, the choice to run is yours. There is no
signature to point at, and this project will not fake one.

### Your antivirus quarantined or deleted the file
An unsigned, self-extracting Electron executable that launches `tor.exe` is the shape many engines
watch for, and detection names on such files are frequently generic (`Trojan.Win32.Generic`,
`PUA:`-class) rather than specific. What helps:

1. confirm the hash matches `SHA256SUMS.txt` — this is the step that tells you whether the file was
   tampered with;
2. check the file's hash on a scanner you control rather than trusting a warning blindly;
3. report the false positive to the antivirus vendor, and to this repository as a bug with the
   engine name, the detection string and the exact build;
4. if you decide to keep running it, restore the file from the vendor's quarantine and add a
   targeted rule for the folder you installed into. Do **not** leave real-time protection off for
   the whole machine, and do not turn it off to make Veil "work" without doing step 1.

### Tor never connects (stuck at a percentage)
- **Is Tor itself blocked?** A censored network usually refuses the first hop. Open the home page →
  **Connection**, pick obfs4 or Snowflake, and Save and reconnect. If you have bridge lines from
  <https://bridges.torproject.org>, choose the custom mode and paste them (one per line, any of the
  formats Veil accepts). Reconnecting restarts tor and can take a minute or two.
- **A firewall or a filtering router** that only allows port 443 often still lets `meek` through.
- **Corporate TLS interception** breaks Tor: the machine's root certificate trust does not apply to
  what Tor sees. Expect failure and treat it as a network property, not a Veil bug.
- **Two builds at once** are supported, but if a previous run crashed and left `tor.exe` running,
  the new instance cannot reuse its control port. Check with
  `tasklist /FI "IMAGENAME eq tor.exe"`, and end only the process whose executable path is inside a
  `veil-tor-*` or Veil directory — do not kill a system tor you did not install.

### Every page says it failed to load, and the home page shows no "connected" state
That is the kill switch: no Tor, no traffic. Look at the status line on the home page. `ERR_BLOCKED_BY_CLIENT`
is what a cancelled load surfaces as, and it is the safe direction — the alternative is leaking the
request around Tor.

### The window opens but nothing is in it after a crash from a previous run
A stale `%TEMP%\veil-tor-*` from a process that died is removed at the next start, keyed on the
owner pid recorded in `veil.owner`. If a folder survives that sweep it is because a Veil is still
using it, and Veil says so instead of deleting an active directory.

### You need to see what went wrong
Veil writes no log file. Run it from a terminal and keep the output:

```powershell
& "$env:LOCALAPPDATA\Programs\Veil\Veil.exe" 2>&1 | Tee-Object veil-output.txt
```

For more verbosity from the Tor manager:

```powershell
$env:VEIL_DEBUG = "1"
& "$env:LOCALAPPDATA\Programs\Veil\Veil.exe" 2>&1 | Tee-Object veil-debug.txt
```

To measure the anonymity properties yourself rather than describe them (43 checks against the live
Tor network; PASS / FAIL / KNOWN, and KNOWN is never counted as a pass):

```powershell
$env:VEIL_SELFTEST = "1"
$env:VEIL_SELFTEST_REPORT = "selftest-report.txt"   # needed: a packaged build has no console
& "$env:LOCALAPPDATA\Programs\Veil\Veil.exe"
```

Before sending any of it: redact the onion address of a site you host, usernames, and anything a
screenshot would reveal. Never attach bookmarks, cookies, the tor state directory or a packet
capture to a public issue.

## Getting help

Search [existing issues](https://github.com/b7662777-hash/Veil-browser-windows/issues) first — the failure you are seeing is often already filed.
Then open **[→ Report a bug](https://github.com/b7662777-hash/Veil-browser-windows/issues/new?template=bug_report.yml)** with the version, which
build (Setup, Portable or from source), your Windows version and architecture, the steps, and what
you saw. Feature requests go to
**[→ Request a feature](https://github.com/b7662777-hash/Veil-browser-windows/issues/new?template=feature_request.yml)**.

Security problems are **not** issues: use the private route in [SECURITY.md](../SECURITY.md).

There is no Discord, Telegram, Matrix or email list for Veil. This page links only destinations
that exist.
