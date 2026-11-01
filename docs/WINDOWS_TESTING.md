# Testing Veil on Windows

Four layers, run in this order. Every one of them has been executed on the real machine this
port was built on: Windows 11 x64 (10.0.26200), Node v24 (the runner also passes on the v26
build installed here), tor 0.4.9.15 from the official Windows bundle.

| layer | command | what it needs | result measured here |
| --- | --- | --- | --- |
| static | `npm run check` | nothing | all checks passed, exit 0 |
| unit | `npm run test:unit` | nothing (no tor, no network) | 51 pass / 0 fail |
| integration | `npm run test:live` | a tor for this platform | 16 pass / 0 fail, ~30 s |
| whole suite | `npm test` | a tor for this platform | 67 pass / 0 fail / 0 skipped, ~35 s |
| in-app security | `npm run selftest` | Electron + tor | 43 checks: 42 PASS, 1 KNOWN, 0 FAIL, exit 0 |

`npm run tor:fetch` puts tor, the pluggable transport, the GeoIP databases and their licences
under `bin/win32-x64/`. Without it the live layer is **reported as skipped**, not as passing.

## 1. Static — `npm run check`

`scripts/check.js` syntax-checks every `.js` under `src/`, `scripts/` **and `tests/`** (a test
file with a typo used to be discovered only when the suite ran, i.e. after the CI build step),
compiles the inline `<script>` of every internal page, verifies the community directory's
signature, and confirms the bundled data files exist. It is the only step that must pass before
anything else is tried.

## 2. Unit — `npm run test:unit`

Node's built-in runner (`node --test`). No new dependency was added for tests, and nothing here
touches the network or starts tor.

| file | cases | what is actually asserted |
| --- | --- | --- |
| `tests/platform.test.js` | 23 | path resolution for tor/GeoIP/transports across the Windows, macOS and Linux layouts; `VEIL_TOR_PATH` precedence and its refusal-with-warning; a foreign `bin/<other-platform>` is never executed; the stale-directory verdicts (`mine` / `stale-boot` / `stale-dead-owner` / `young-no-owner` / `gone` / `alive`) including the precedence that protects a live folder; `sweepStale` removing dead folders and keeping active ones and never touching another prefix; `removeTree` retry arithmetic under a simulated antivirus lock (transient EBUSY succeeds on the 3rd call, permanent EPERM stops after exactly 4, non-retryable ENOTDIR gives up in under 50 ms); `protectFile`/`protectDirEmpty`, the recovery of a directory poisoned by the old ACL bug, window chrome, spawn options and bounded termination |
| `tests/relay-isolation.test.js` | 9 | the per-site SOCKS5 relay against a fake tor: distinct credential pair per site, `newCircuit` rotates one site only, New Identity changes the nonce and the listener port, the kill switch makes the relay forward **zero bytes** and open no tor connection, `BIND` is refused with `0x07`, a tor that refuses authentication forwards nothing, an onion reply (`0xF4`) is passed back with the site recorded, and exactly one listener exists per site |
| `tests/control.test.js` | 13 | the control protocol against captured tor bytes: `AUTHENTICATE` before `TAKEOWNERSHIP`, a wrong cookie rejects **and closes the socket**, single-line and multi-line `GETINFO` replies, `.` dot-unstuffing, a reply arriving in 7-byte chunks, an interleaved `650` event not mistaken for a reply, pipelined ordering, `552`/`501` rejections that do not kill the session, a queued command rejected when the socket dies, `circuitFor` newest-match selection with three named hops and countries, `streamsOn` reading `STREAMID STATUS CIRCUITID TARGET`, and `traffic()` |
| `tests/bridge-lines.test.js` | 6 | the paste gate: every form the UI tells a user to paste is accepted (`obfs4`, `meek_lite`, `snowflake`, `webtunnel`, vanilla `ip:port fingerprint`, and a plain URL), while anything that is not a bridge line — and any line carrying a newline that could smuggle a second torrc directive such as `SaveConfig 1` — is rejected before it reaches tor |

Two defects were found *by* these tests and fixed in the product, not in the tests: `control.js`
left the socket open after a failed `AUTHENTICATE` (tor kept the control port busy and Veil held a
dead handle for the whole session), and `bridge-lines.js` accepted `obfs4\nSaveConfig 1` because
the transport grammar's `\s` matches a newline.

## 3. Integration — `npm run test:live`

`tests/tor-live.test.js` starts and stops the bundled `tor.exe` exactly the way the app does, and
`tests/transport-spawn.test.js` covers how a pluggable transport is handed to tor. Nothing is
mocked: the assertions read what tor itself reports.

1. tor bootstraps to 100 % and Veil authenticates to its own control port (`GETINFO version`,
   `status/bootstrap-phase` reading `PROGRESS=100`). Measured 8.7 s from a cold start.
2. the data folder is a fresh `veil-tor-*` in `%TEMP%`, `isStaleDir` calls it `mine` while tor is
   using it, and it holds `control_auth_cookie` and `veil.owner`.
3. a raw SOCKS5 CONNECT with a credential pair is accepted, and `circuit-status` shows a circuit
   carrying exactly that `SOCKS_USERNAME`/`SOCKS_PASSWORD` — proof that `IsolateSOCKSAuth` works
   with Veil's scheme on Windows; `circuitFor` then returns its three named hops.
4. GeoIP is loaded: `ip-to-country/8.8.8.8` answers a two-letter country.
5. a restart gives a new folder and the previous one **no longer exists**.
6. shutdown is graceful and bounded: `SIGNAL SHUTDOWN` over the control port, tor gone in
   52–121 ms, no process left, data folder wiped, `sweepStale().failed` empty.
7. a tor that dies of its own accord (Windows `TerminateProcess`, the crash case) is reported —
   `ready` false and an error matching `tor exited` — and its folder is still wiped.

The transport cases need no tor at all: the relative-`exec` + controlled-`cwd` arithmetic that
lets bridges survive an install directory with spaces and non-ASCII characters, the refusal to
guess when a transport path cannot be expressed, `VEIL_LYREBIRD` being refused *out loud*, and the
fail-closed rule — a bridge mode with no bridge lines never spawns tor and never creates a data
directory.

## 4. In-app security — `npm run selftest`

The packaged checks run inside a real Electron process with real tor: kill switch closed before
tor is ready and open after, no direct network path, per-site circuit isolation (two sites do not
share credentials), ephemeral storage, amnesic cleanup, onion-only routing, Referer behaviour and
fingerprint resistance. It reports **three outcomes, not two**:

```
PASS  …
KNOWN  an ordinary site sends only its origin as Referer — known Windows limitation: …
FAIL  …
```

`KNOWN` is a limitation measured in that very run and written up in
[`WINDOWS_SECURITY_AUDIT.md`](WINDOWS_SECURITY_AUDIT.md). A KNOWN line is never counted as a pass
and always prints its reason; the summary distinguishes the two explicitly, e.g. *"All 42 checks
that could be decided here passed; 1 limitation(s) are reported separately as KNOWN, not as
passing."* `npm run check`-style exit codes stay 0 only when nothing failed.

One check is a **non-vacuity control**: the onion-Referer test would also pass if no header were
sent at all, so the same run watches a clearnet request leave an ordinary page and asserts its
`Referer` is present and origin-only. Without that, "nothing leaked" could mean "nothing was
observed".

## Skipped tests are stated, not hidden

`node --test` was verified both ways by moving `bin/win32-x64` aside and putting it back:

* tor present → `tests 8, pass 8, fail 0, skipped 0`.
* tor absent → `tests 8, pass 1, fail 0, **skipped 7**`, each line ending with
  `# no tor for win32-x64 here (9 places looked); run npm run tor:fetch`.

The skip is attached to every individual case, not to the suite: a suite-level `skip` (including
`test.describe.skip`) registers no children at all, so a machine without tor would print
`skipped 0` and look like a clean run. That is exactly the "test passed because it was skipped"
failure this project forbids.

## Environment overrides used while testing

| variable | effect |
| --- | --- |
| `VEIL_TOR_PATH` | use this tor instead of the bundle; an unusable value is refused with a warning and Veil falls back, saying so |
| `VEIL_LYREBIRD` | use this transport binary; refused out loud if it is not executable |
| `VEIL_SELFTEST=1` | run the in-app checks and exit (what `npm run selftest` sets) |
| `VEIL_DEBUG=1` | tor's log lines and stderr are printed, which is how the `\r\n` bootstrap-parser bug was found |

## Manual Windows checks still required for a release

Automated tests cannot cover everything. `docs/WINDOWS_RELEASE.md` lists the release-time
checklist: install from the NSIS setup as a **standard user**, run the **portable** exe from a
path containing spaces and non-ASCII characters (`C:\Program Files\Vèil Browser`), watch Defender
during first launch, confirm the taskbar icon and window controls, and verify that killing Veil in
Task Manager leaves no `tor.exe` and no `veil-tor-*` folder behind.
