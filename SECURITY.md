# Security policy

Veil routes a browser through Tor and keeps nothing on disk. That makes an ordinary bug and a
security problem very different things, and this page is about telling them apart quickly.

**Read this first:** Veil is an educational project. It is **not security-audited**, it has no
formal verification, and nobody has reviewed it for the threats a targeted researcher, a hostile
network, or a state-level adversary would pose. If your safety depends on anonymity, use
[Tor Browser](https://www.torproject.org/), which is hardened, audited and maintained by the
organisation that runs the network. Say so in your report if you were relying on Veil — it is
useful to know where the expectation broke.

## What counts as a vulnerability here

Report these privately, not as an issue:

* Traffic that leaves Tor — a direct connection, a DNS lookup through a local resolver, WebRTC
  revealing a real address, or any path that works while the kill switch should be holding.
* A site that can see another site's data — cookies, localStorage, IndexedDB, cache, HSTS state,
  an HTTP auth prompt, a TLS session ticket, or a circuit shared across first parties.
* Anything that survives New Identity, Panic or shutdown — a file left on disk, a process left
  running, a Tor data folder not wiped, an entry in the Windows registry, or state that comes back
  on the next start.
* A way for a page to get privilege it should not have — escaping the sandbox, reaching Node from
  the preload, calling IPC handlers it was never given, or driving the control port.
* A fingerprint that separates one Veil user from another Veil user (this is the whole point of the
  feature, so a unique signal is a bug even when nothing "leaks").
* A bridge or transport that silently connects without it, in a situation where the user chose it
  to evade censorship.
* Community hub: a signature check that accepts a forged directory, or an invite-only onion site
  reachable without its invite.

## What is *not* a vulnerability

* "Veil is not as hardened as Tor Browser." True, and stated on every download page.
* "Tor is slow / an exit node was blocked by a website." That is the network, not this code.
* "A page failed to load while Tor was still bootstrapping." The kill switch cancelling requests is
  the design working.
* "Windows SmartScreen warns about the installer," or "the executable is unsigned." Both are
  disclosed as known limitations: there is no code-signing certificate, so the app is unsigned and
  unrepudiable — see [docs/WINDOWS_SUPPORT.md](docs/WINDOWS_SUPPORT.md).
* "My antivirus quarantined the build." Unsigned, self-extracting binaries look like that. Report
  it as a bug with the hash, and check the hash against SHA256SUMS.txt first.

## How to report privately

1. **GitHub private vulnerability reporting** is the preferred route, and it is switched on for
   this repository: <https://github.com/b7662777-hash/Veil-browser-windows/security/advisories/new>
   (the same form is reachable from **Security → Report a vulnerability**). The report is visible
   only to you and the maintainers, and it becomes a private advisory you can later publish jointly.
   That URL was checked on 2026-11-01; if it stops resolving, the form has been turned off and the
   next route applies.
2. If the Security tab offers no reporting form, the repository's private reporting is not enabled.
   In that case open **no** issue, and send only the minimum detail needed to reach you so a
   maintainer can respond — do not put the exploit itself in a public issue.

Please include, as far as you safely can:

* Which build: installer, portable, macOS, Linux, or source — and the version.
* The exact steps, and what you observed instead of what should happen.
* Whether the problem is reproducible, and on what Windows version.
* Whether you are running Veil's own self-test result: `VEIL_SELFTEST=1` prints 43 measured checks,
  and a FAIL line naming the check you are reporting is the fastest possible reproduction.

**Do not attach**: your real browsing history, a live onion address or its private key, cookies,
your Tor state folder, a pcap of your traffic, or anything that identifies the sites you visit.
Build a minimal reproduction against `https://example.com/` instead — it is almost always enough,
and it does not put you at risk to submit it.

## What happens next

* Veil is maintained by volunteers with day jobs, so there is no SLA and no bounty. There is no
  bug bounty programme, and nobody should ask for one — a payment demand in a security report is a
  scam signal, not a policy.
* Expect an acknowledgement on the advisory. If a fix lands, it ships in a release, and the
  advisory can be published jointly once users have a safe upgrade path.
* If the issue is in Tor itself rather than Veil, the report goes to the Tor Project
  (<https://torproject.org/about/contact/#security>) — they own that code, and Veil cannot fix it.
* If you report and hear nothing for a couple of weeks, ping the advisory. Silence is usually a
  missed notification, not a refusal.

## Coordinated disclosure

You are welcome to publish, and this project would rather you did than sit on a fix that helps
people. The ask is a window to ship first: report, let a release with the fix go out, then publish.
If you need a deadline for your own planning, say so in the advisory and you will get a straight
answer about what is achievable, rather than a promise nobody can keep.
