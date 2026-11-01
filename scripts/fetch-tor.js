// npm run tor:fetch — acquire the Tor binaries Veil ships, from the Tor Project only.
//
// Replaces the old macOS/Linux-only scripts/fetch-lyrebird.sh, and does three things
// the shell script did not: it records a SHA-256 for every artifact, it verifies the
// detached signature against a pinned key fingerprint, and it proves the binaries it
// just copied actually execute on *this* platform (a Linux binary renamed to .exe is
// the failure mode this exists to prevent).
//
// Nothing is downloaded from a mirror, and there is no flag to skip verification.
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFileSync, spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const LOCKFILE = path.join(ROOT, 'config', 'tor-deps.json')
// Tor Browser Developers (signing key) — the same key the old script trusted.
// Get it out of band and change it here if you do not trust this copy.
const PINNED_FPR = 'EF6E286DDA85EA2A4BA7DE684E2C6E8793298290'
const KEY_URL = `https://keys.openpgp.org/vks/v1/by-fingerprint/${PINNED_FPR}`
const VERSION_URL = 'https://aus1.torproject.org/torbrowser/update_3/release/downloads.json'
const DIST_BASE = 'https://dist.torproject.org/torbrowser'

// Directory names must match platform.js's bundleKey(): `${process.platform}-${process.arch}`.
const BUNDLE_NAME = { // the expert-bundle file name for each target
  'win32-x64': 'tor-expert-bundle-windows-x86_64',
  'win32-ia32': 'tor-expert-bundle-windows-i686',
  'darwin-arm64': 'tor-expert-bundle-macos-aarch64',
  'darwin-x64': 'tor-expert-bundle-macos-x86_64',
  'linux-x64': 'tor-expert-bundle-linux-x86_64',
  'linux-arm64': 'tor-expert-bundle-linux-aarch64',
}
const ARCH_OF_BUNDLE = {
  'tor-expert-bundle-windows-x86_64': 'x86_64', 'tor-expert-bundle-windows-i686': 'i686',
  'tor-expert-bundle-macos-aarch64': 'aarch64', 'tor-expert-bundle-macos-x86_64': 'x86_64',
  'tor-expert-bundle-linux-x86_64': 'x86_64', 'tor-expert-bundle-linux-aarch64': 'aarch64',
}

function die(msg) { const e = new Error(msg); e.fatal = true; throw e }
function say(msg) { console.log(msg) }
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
function run(cmd, args, opts = {}) {
  // maxBuffer above the 1 MiB default: Tor's downloads.json is bigger than that.
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...opts })
}

const NODE_TO_SHORT = { win32: 'win', darwin: 'mac', linux: 'linux' }

// --platform win|mac|linux  --arch x64|arm64|ia32 ; defaults to this machine
function targetFromArgs(argv) {
  const get = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
  const platformToNode = { win: 'win32', win32: 'win32', mac: 'darwin', darwin: 'darwin', linux: 'linux' }
  const archAlias = { x64: 'x64', amd64: 'x64', x86_64: 'x64', arm64: 'arm64', aarch64: 'arm64', ia32: 'ia32', x86: 'ia32', i686: 'ia32' }
  const wanted = get('--platform')
  const platform = platformToNode[wanted || NODE_TO_SHORT[process.platform]]
  if (!platform) die(`Unsupported platform "${wanted}". Use win, mac or linux.`)
  const arch = archAlias[get('--arch') || process.arch]
  if (!arch) die(`Unsupported architecture "${get('--arch')}". Use x64, arm64 or ia32.`)
  const key = `${platform}-${arch}`
  const bundle = BUNDLE_NAME[key]
  if (!bundle) die(`No official Tor expert bundle for ${key}. Supported: ${Object.keys(BUNDLE_NAME).join(', ')}`)
  return { key, bundle, platform, arch, exe: platform === 'win32' ? '.exe' : '' }
}

function resolveVersion(pinned) {
  if (pinned && pinned.version) return pinned.version
  const json = JSON.parse(run('curl', ['-sSfL', '--max-time', '60', VERSION_URL]))
  return json.version
}

// GnuPG on Windows comes in two dialects: the native build wants "C:\x\y", Git-for-Windows'
// MSYS build reads that same string as a path *relative to the cwd* and misses. Rather than
// translate, every gpg call runs with cwd set to our scratch dir and only relative paths.
function gpgRun(gpg, cwd, homedirRel, args) {
  return run(gpg, ['--batch', '--no-tty', '--status-fd', '1', '--homedir', homedirRel, ...args], { cwd })
}

function findGpg() {
  const winGuess = [
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'GnuPG', 'bin', 'gpg.exe'),
    path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'GnuPG', 'bin', 'gpg.exe'),
    'C:\\Program Files\\Git\\usr\\bin\\gpg.exe',
  ]
  if (process.platform === 'win32') { const hit = winGuess.find(p => fs.existsSync(p)); if (hit) return hit }
  try { return run('gpg', ['--version']).length ? 'gpg' : 'gpg' } catch { die('gpg is required to verify Tor downloads and was not found on PATH.') }
}

// Verifies the detached .asc and returns the signing fingerprint, or dies.
function verifySignature(gpg, cwd, homedirRel, ascRel, fileRel) {
  const label = path.basename(fileRel)
  const out = (() => {
    try {
      return gpgRun(gpg, cwd, homedirRel, ['--verify', ascRel, fileRel])
    } catch (err) {
      const text = `${err.stdout || ''}${err.stderr || ''}`
      if (/BADSIG|ERRSIG|NO_PUBKEY|Good signature.*but/i.test(text)) die(`Tor Project signature check FAILED for ${label}:\n${text}`)
      die(`gpg could not verify ${label}: ${err.message}\n${text}`)
    }
  })()
  const validsig = out.split('\n').find(l => l.startsWith('[GNUPG:] VALIDSIG'))
  if (!validsig) die(`No VALIDSIG status for ${label} — signature did not verify`)
  // VALIDSIG carries, in order: signing-key fpr, sig-ts, exp-ts, version, reserved,
  // pubkey-algo, hash-algo, sig-class, primary-key fpr, then gpg-version-specific extras.
  // The extra fields move between gpg releases, so fingerprints are picked out by shape
  // (40 hex chars) rather than by a fixed index: first = signing subkey, second = primary.
  const fprs = validsig.trim().split(/\s+/).filter(t => /^[0-9A-Fa-f]{40}$/.test(t)).map(t => t.toUpperCase())
  if (fprs.length < 2) die(`Could not read the signing key from VALIDSIG for ${label}:\n  ${validsig.trim()}`)
  const [subkey, primary] = fprs
  if (primary !== PINNED_FPR) {
    die(`Signed by primary key ${primary} (subkey ${subkey}), not the pinned Tor Browser Developers key ${PINNED_FPR}\n  raw status: ${validsig.trim()}`)
  }
  return { primary, subkey }
}

function copyTree(from, to, filter) {
  let copied = 0
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    if (entry.isDirectory()) { copyTree(src, to, filter); continue }
    if (!filter(entry.name)) continue
    fs.copyFileSync(src, path.join(to, entry.name))
    copied++
  }
  return copied
}

const EXPECTED_MAGIC = {
  'win32-x64': 'pe', 'win32-ia32': 'pe',
  'darwin-arm64': 'macho-arm64', 'darwin-x64': 'macho-x86_64',
  'linux-x64': 'elf-x86_64', 'linux-arm64': 'elf-aarch64',
}

// Reads the file's own magic bytes, so a Unix binary saved with an .exe name is caught
// even when this machine cannot run the target image at all.
function imageFormat(file) {
  const fd = fs.openSync(file, 'r')
  const head = Buffer.alloc(20)
  try {
    fs.readSync(fd, head, 0, 20, 0)
  } finally {
    fs.closeSync(fd)
  }
  if (head.subarray(0, 2).toString('latin1') === 'MZ') return 'pe'
  if (head.subarray(0, 4).toString('latin1') === '\x7fELF') {
    return head[5] === 1 ? (head.subarray(18, 20).readUInt16LE(0) === 183 ? 'elf-aarch64' : 'elf-x86_64') : 'elf-32'
  }
  const macho = head.readUInt32BE(0)
  if (macho === 0xfeedfacf || macho === 0xcffaedfe) return head.readUInt32LE(4) === 0x0100000c ? 'macho-arm64' : 'macho-x86_64'
  return `unknown(0x${head.subarray(0, 4).toString('hex')})`
}

function canExecute(file) {
  // Proves the OS will load this image. A Unix binary renamed .exe fails here with
  // ENOEXEC / an invalid-image status rather than at the user's first bridge attempt.
  const r = spawnSync(file, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  if (r.error) return { ok: false, why: r.error.message }
  const out = `${r.stdout || ''}${r.stderr || ''}`
  if (/Tor version \d/i.test(out)) return { ok: true, version: out.match(/Tor version (\S+)/)[1] }
  return { ok: false, why: out.trim().split('\n')[0] || `exit ${r.status}` }
}

function main() {
  const argv = process.argv.slice(2)
  const force = argv.includes('--force')
  const { key, bundle, platform, arch, exe } = targetFromArgs(argv)
  const lock = fs.existsSync(LOCKFILE) ? JSON.parse(fs.readFileSync(LOCKFILE, 'utf8')) : { targets: {} }
  const pinned = lock.targets[key]

  const version = resolveVersion(pinned)
  const outDir = path.join(ROOT, 'bin', key)
  const manifestPath = path.join(outDir, 'manifest.json')

  if (!force && fs.existsSync(manifestPath)) {
    const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    if (existing.version === version && Object.values(existing.artifacts || {}).every(a => a.sha256 === sha256(path.join(outDir, a.name)))) {
      say(`bin/${key} already holds a verified Tor ${version}; use --force to re-acquire`)
      return
    }
  }

  const gpg = findGpg()
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'veil-fetch-'))
  const gnupg = path.join(work, 'gnupg')
  fs.mkdirSync(gnupg, { recursive: true, mode: 0o700 })
  try {
    say(`Tor Browser release: ${version} (${bundle})`)
    const tgz = path.join(work, `${bundle}-${version}.tar.gz`)
    const asc = `${tgz}.asc`
    run('curl', ['-sSfL', '--max-time', '900', '-o', tgz, `${DIST_BASE}/${version}/${bundle}-${version}.tar.gz`])
    run('curl', ['-sSfL', '--max-time', '120', '-o', asc, `${DIST_BASE}/${version}/${bundle}-${version}.tar.gz.asc`])

    // import the pinned key by fingerprint, so the trust anchor is this file, not the network
    const keyFile = path.join(work, 'pinned.asc')
    run('curl', ['-sSfL', '--max-time', '120', '-o', keyFile, KEY_URL])
    try {
      gpgRun(gpg, work, 'gnupg', ['--import', 'pinned.asc'])
    } catch (err) {
      die(`Could not import the pinned Tor signing key into ${gnupg}:\n${err.stdout || ''}${err.stderr || ''}${err.message}`)
    }

    const archiveSha = sha256(tgz)
    if (pinned && pinned.sha256 && pinned.sha256 !== archiveSha) {
      die(`SHA-256 mismatch for ${bundle} ${version}\n  expected ${pinned.sha256}\n  actual   ${archiveSha}\nRefusing to install. If Tor published a new build, update config/tor-deps.json deliberately.`)
    }
    const sig = verifySignature(gpg, work, 'gnupg', path.basename(asc), path.basename(tgz))
    say(`✓ signature OK — Tor Browser Developers ${sig.primary} (subkey ${sig.subkey})`)
    say(`✓ sha256 ${archiveSha}`)

    const ext = path.join(work, 'ext')
    fs.mkdirSync(ext, { recursive: true })
    // Relative again: Git-for-Windows' tar reads "C:\x" as a remote "host:C:\x" path and fails.
    run('tar', ['-xzf', path.basename(tgz), '-C', 'ext'], { cwd: work })
    const torDir = path.join(ext, 'tor')
    const dataDir = path.join(ext, 'data')
    const docsDir = path.join(ext, 'docs')
    for (const d of [torDir, dataDir]) if (!fs.existsSync(d)) die(`unexpected bundle layout in ${bundle} (no ${path.basename(d)}/)`)

    fs.rmSync(outDir, { recursive: true, force: true })
    for (const sub of ['pluggable_transports', 'licenses']) {
      fs.mkdirSync(path.join(outDir, sub), { recursive: true })
    }

    const artifacts = {}
    const place = (from, name, rel) => {
      const key = String(rel || name).split(path.sep).join('/') // manifest keys stay /-separated on every OS
      const dest = path.join(outDir, key)
      fs.copyFileSync(from, dest)
      // Preserve the bundle's own modes: NTFS ignores the bit, POSIX needs the execute bit on binaries.
      fs.chmodSync(dest, fs.statSync(from).mode & 0o777)
      artifacts[key] = { name: key, bytes: fs.statSync(dest).size, sha256: sha256(dest) }
    }

    place(path.join(torDir, `tor${exe}`), 'tor' + exe)
    for (const lib of fs.readdirSync(torDir).filter(n => /\.(dylib|so(\.\d+)*)$/.test(n))) {
      place(path.join(torDir, lib), lib) // shared libraries must sit next to the binary
    }
    for (const t of [`lyrebird${exe}`, `conjure-client${exe}`]) {
      const src = path.join(torDir, 'pluggable_transports', t)
      if (fs.existsSync(src)) place(src, t, path.join('pluggable_transports', t))
    }
    for (const g of ['geoip', 'geoip6']) {
      const src = path.join(dataDir, g)
      if (fs.existsSync(src)) place(src, g)
    }
    // License / attribution text: tor is GPL-3, lyrebird BSD, plus libevent/openssl/zlib notices.
    for (const doc of fs.existsSync(docsDir) ? fs.readdirSync(docsDir) : []) {
      place(path.join(docsDir, doc), doc, path.join('licenses', doc))
    }
    const torrcDefaults = path.join(dataDir, 'torrc-defaults')
    if (fs.existsSync(torrcDefaults)) place(torrcDefaults, 'torrc-defaults')

    const torExe = path.join(outDir, `tor${exe}`)
    const sameHost = platform === process.platform && arch === process.arch
    let check
    if (sameHost) {
      check = canExecute(torExe)
      if (!check.ok) die(`${path.basename(torExe)} is not runnable here (${check.why}). Not recording it as acquired — this is the incompatible-binary case.`)
      say(`✓ ${path.basename(torExe)} executes: Tor ${check.version}`)
    } else {
      check = { ok: false, skipped: `cross-acquisition: asked for ${key}, this machine is ${process.platform}-${process.arch}` }
      say(`! ${path.basename(torExe)} NOT executed — this machine cannot run a ${key} image. Image format verified only.`)
    }
    const lyr = path.join(outDir, 'pluggable_transports', `lyrebird${exe}`)
    if (fs.existsSync(lyr)) {
      if (!sameHost) say('! lyrebird execution not tested (different target platform)')
      else {
        const r = spawnSync(lyr, ['--help'], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
        say(`${r.error ? '✗ lyrebird did not execute: ' + r.error.message : '✓ lyrebird image loads on this platform' + (r.status === 0 ? '' : ` (exit ${r.status}; expected — it needs PT env vars)`)}`)
      }
    } else {
      // Tor Browser ships lyrebird; if a bundle ever stops containing it, bridges must not
      // be reported as supported on the strength of a config option alone.
      say(`! no lyrebird in ${bundle} — bridges will be unavailable for ${key} until a transport is installed (npm run bridges:setup)`)
    }

    const magic = imageFormat(torExe)
    if (magic !== EXPECTED_MAGIC[key]) {
      die(`${path.basename(torExe)} is a ${magic} image but ${key} needs ${EXPECTED_MAGIC[key]}. Refusing to install a binary the target OS cannot load.`)
    }
    const manifest = {
      source: `${DIST_BASE}/${version}/${bundle}-${version}.tar.gz`,
      signature: { verified: true, algorithm: 'RSA/SHA-256 detached clearsig', pinnedFingerprint: PINNED_FPR, signerKeyId: sig.primary, signingSubkey: sig.subkey },
      archive: { name: `${bundle}-${version}.tar.gz`, sha256: archiveSha, bytes: fs.statSync(tgz).size },
      version,
      torVersion: check.version || null,
      target: { platform, arch, bundleKey: key, bundleArchitecture: ARCH_OF_BUNDLE[bundle] },
      acquiredAt: new Date().toISOString(),
      acquiredBy: `scripts/fetch-tor.js on ${process.platform}-${process.arch}`,
      imageFormat: { file: `tor${exe}`, magic, expected: EXPECTED_MAGIC[key] },
      executableCheck: { file: `tor${exe}`, ...check },
      licenses: { tor: 'GPL-3.0-or-later', lyrebird: 'BSD-3-Clause', conjure_client: 'BSD-3-Clause (refraction-networking)', libevent: 'BSD-3-Clause', openssl: 'Apache-2.0-style OpenSSL dual (Apache-2.0 / OpenSSL)', zlib: 'Zlib', texts_in: 'licenses/' },
      artifacts,
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    // update the lockfile so the next fetch/CI run pins these exact hashes
    lock.targets = lock.targets || {}
    lock.targets[key] = { bundle, version, sha256: archiveSha, platform, arch }
    lock.pinnedFingerprint = PINNED_FPR
    fs.mkdirSync(path.dirname(LOCKFILE), { recursive: true })
    fs.writeFileSync(LOCKFILE, JSON.stringify(lock, null, 2))

    say(`\nInstalled to ${path.relative(ROOT, outDir)} (${Object.keys(artifacts).length} files)`)
    say(`Manifest: ${path.relative(ROOT, manifestPath)}`)
    say(`Pin updated: ${path.relative(ROOT, LOCKFILE)}`)
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch {}
  }
}

module.exports = {
  targetFromArgs, BUNDLE_NAME, ARCH_OF_BUNDLE, EXPECTED_MAGIC, imageFormat, sha256,
  verifySignature, gpgRun, findGpg, canExecute, PINNED_FPR, LOCKFILE, ROOT,
  slash: p => String(p).replace(/\\/g, '/'),
}

if (require.main === module) {
  try {
    main()
  } catch (err) {
    if (err && err.fatal) { console.error(`✗ ${err.message}`); process.exit(1) }
    throw err
  }
}
