# Contributing to Veil

Veil is a small browser with a narrow job: put every request through Tor, give every site its own
circuit and its own memory, and keep nothing. Most of what makes it work is the decision *not* to
add things. Read that as the filter for any change you are considering.

Nothing here is a gate you have to pass before opening an issue — if you are unsure whether a
change belongs, ask in a Discussion or an issue first and save yourself the work.

## What Veil is trying to be

* An honest teaching tool about how Tor, per-site isolation and fingerprinting resistance fit
  together. The code is meant to be read.
* **Not** a hardened, audited, anonymous-by-right browser. If you want that, contribute to
  [Tor Browser](https://www.torproject.org/).
* Cross-platform: macOS and Linux are the original targets and Windows was added later. A change
  that works on one and breaks another is not finished.

The design decisions live in [docs/adr/](docs/adr) — thirteen short ADRs. If you touch routing,
storage, the kill switch, the fingerprint surface or the IPC boundary, find the ADR that covers it
and say in your pull request how your change relates to it.

## Getting set up

Prerequisites: Node.js 22 or newer, npm, git. Windows: Windows 10/11 x64. macOS: Xcode command
line tools. Linux: nothing special beyond a normal toolchain.

```powershell
git clone https://github.com/b7662777-hash/Veil-browser-windows.git
cd Veil-browser-windows
npm install
npm run tor:fetch    # downloads tor for *this* platform and verifies its signature
npm start
```

That URL is the Windows-port repository. The original project it was ported from is
[github.com/nishant-Tiwari24/veil](https://github.com/nishant-Tiwari24/veil), and Windows-specific
reports belong here, not there — see [docs/UPSTREAM.md](docs/UPSTREAM.md).

`npm run tor:fetch` pulls the official Tor Project expert bundle, checks the detached GPG
signature against a pinned fingerprint, records the SHA-256 of every file in
`bin/<platform>-<arch>/manifest.json`, and refuses to install anything that does not verify. That
folder is gitignored on purpose — nobody commits tor binaries.

If you already have a system tor you trust, point at it instead:

```powershell
$env:VEIL_TOR_PATH = "C:\tor\tor.exe"   # PowerShell (macOS/Linux: export VEIL_TOR_PATH=…)
npm start
```

### The commands you will actually use

| Command | What it does |
|---|---|
| `npm start` | Run Veil from source. |
| `npm run debug` | Same, with `VEIL_DEBUG=1` — tab lifecycle and tor's own stderr. |
| `npm run check` | Syntax-check every file in `src/`, `scripts/` and `tests/`, verify the community directory signature and the vendored assets. Fast; run it constantly. |
| `npm test` | The whole test suite. Needs tor for the live half. |
| `npm run test:unit` | Deterministic tests only — no network, no tor, a few seconds. |
| `npm run test:live` | Tests that start a real tor and talk to the Tor network. Slow, needs the network. |
| `npm run selftest` | Starts Veil and Tor and runs the anonymity checks against the live network, then quits. |
| `npm run dist` | Build the packages for your platform (`electron-builder`). |
| `node scripts/check-windows-artifacts.js veil-dist` | Gate a Windows build: both files present, right architecture, tor + transports + GeoIP inside, signature verified, nothing extra. |
| `npm run release:evidence` | Write `SHA256SUMS.txt` and `SBOM.json` from the built files. |
| `npm run bridges:setup` / `bridges:check` | Ask the Tor Project for your own obfs4 bridges and see whether they actually connect. |
| `npm run adblock:update` | Rebuild the bundled filter engine. Release-time only — it changes what every user sees. |

The `env-var` scripts go through `scripts/electron-run.js`, because `FOO=1 electron .` is a POSIX
shell feature that cmd and PowerShell read as a command named `FOO=1`. If you add a script that
needs an environment variable, use that launcher rather than inventing a shell wrapper.

## Tests, and what they are for

Four layers, and they are deliberately separate so a machine without tor still tells the truth:

1. **`npm run check`** — parse and data integrity.
2. **`npm run test:unit`** — [tests/](tests): the platform layer (paths, ACLs, process handling,
   stale-folder sweeps), bridge-line parsing, control-port protocol framing, relay/circuit
   isolation. No network, no tor, no Electron.
3. **`npm run test:live`** — a real tor bootstraps, authenticates, isolates two SOCKS credentials
   onto two circuits, restarts, shuts down, and survives a crash; pluggable transports are spawned
   for real. If tor is missing, every case is reported individually as **skipped with the reason** —
   never silently absent, never as a pass.
4. **`npm run selftest`** — the anonymity checks inside the running app, on the live network: exit
   addresses, DNS, WebRTC, timezone, client hints measured on the wire, storage clearing, onion
   hosting, New Identity, Panic.

`selftest` reports three outcomes, not two: `PASS`, `FAIL`, and `KNOWN`. A `KNOWN` line is a
measured limitation with its reason printed, and it is *never* counted as a pass. If you add a
check that can only be decided by a third-party service, use that third argument — do not make an
unreachable service look like success.

When you change something with a security property, the expectation is that you add the check that
would have caught the bug. Two examples already in the tree: a control socket that leaked between
identities, and bridge lines that kept a trailing newline and silently made tor refuse to start —
both were found by tests, not by reading.

## Making a change

* Branch from `main`, keep the branch name descriptive (`fix/tor-acl-sweep`, `docs/windows-build`).
* Keep commits small and reversible. One idea per commit, and a message that says *why* — the diff
  already shows *what*.
* Platform differences belong in `src/main/platform.js`. Everything else should be platform
  agnostic. If you find yourself writing `if (process.platform === 'win32')` in `tor.js` or
  `main.js`, that logic is in the wrong file.
* Do not weaken a security property to make something start. If the kill switch, session isolation,
  the sandbox or the header filter is in your way, open an issue and talk about it first.
* Never build a shell command string from user-controlled input. Use `spawn`/`execFile` with an
  argument array.
* `docs/` changes are welcome on their own; you do not need code to justify a documentation pull
  request.
* Before you push: `npm run check`, then `npm run test:unit`. Run `npm run test:live` and
  `npm run selftest` if your change touches tor, routing, storage or the fingerprint surface, and
  paste the summary into the pull request.
* UI changes have to be looked at. Type checks do not know what a window is; say which platforms
  and which themes you checked, and attach a screenshot if the layout moved.

### Style

Whatever the file already does. Concretely: CommonJS `require`, no semicolons at end of line,
two-space indent, single quotes, arrow functions for callbacks, and comments that explain
constraints and surprises rather than narrating the code. If you disagree with a rule the file is
following, argue about it in the pull request instead of mixing two styles in one diff.

## Pull requests

Fill in the template, and include:

* What changes and why, in the first screenful.
* Which platforms you ran, and what you ran (`npm run test:unit`, `selftest`, a packaged build).
* Numbers, not adjectives: "39 PASS, 1 KNOWN, 0 FAIL" is worth more than "tests pass".
* For a security-relevant change: which threat you think it closes, and what still does not close
  it.
* Screenshots for UI work.

Nobody will be annoyed by a small pull request. Large refactors are fine too, but split them.

## Packaging and releases

Only maintainers do this, but the steps are here so they are not folklore:

```powershell
npm ci
npm run check
npm run test:unit
npm run tor:fetch          # per platform, signature verified
npm run dist               # electron-builder
node scripts/check-windows-artifacts.js veil-dist
npm run release:evidence   # SHA256SUMS.txt + SBOM.json
```

Build output (`dist/`, `veil-dist/`), the acquired `bin/` folder and `node_modules/` stay out of
git. Windows builds are **unsigned** and that is disclosed everywhere they appear — do not add a
signing step, a fake signature, or a claim about SmartScreen reputation.

## Security problems

Do not open a public issue. See [SECURITY.md](SECURITY.md) — GitHub private vulnerability
reporting on the repository's Security tab. A missing feature, an annoying UI, and a slow bridge
are not security reports; a leak, a bypass, or state that survives Panic is.

## License

By contributing you confirm you may give your work to this project under its MIT licence, and that
you are not introducing code you do not have the right to redistribute. Third-party components and
their licences are listed in [docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md).
