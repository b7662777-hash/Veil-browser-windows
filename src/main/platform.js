// platform.js — the only place Veil branches on the operating system.
//
// Everything platform-specific (where tor lives, what an executable is called, how
// a process is stopped, how a folder is deleted) is resolved here so the rest of the
// app stays platform-independent. Deliberately requires no Electron, so it can be
// unit-tested in plain Node on any OS.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const isLinux = process.platform === 'linux'
const EXE = isWindows ? '.exe' : ''

// Veil's bundled binaries live in bin/<platform>-<arch>/ so a Windows build can never
// ship a Unix binary by accident.
const bundleKey = () => `${process.platform}-${process.arch}`

function executableName(name) {
  return isWindows && !/\.exe$/i.test(name) ? name + EXE : name
}

function isFile(p) {
  try { return fs.statSync(p).isFile() } catch { return false }
}

// On POSIX an existing file is not necessarily runnable; on Windows "read-only"
// is not "not executable", so existence of the .exe is what counts.
function isExecutable(p) {
  if (!p || !isFile(p)) return false
  if (isWindows) return true
  try { return (fs.statSync(p).mode & 0o111) !== 0 } catch { return false }
}

// PATH lookup without spawning `which`/`where`: those are separate executables, and
// a GUI-launched app has no shell to ask.
function searchPath(name) {
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)
  const wanted = executableName(name)
  for (const dir of dirs) {
    const candidate = path.join(dir, wanted)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

function envHome(name) {
  return process.env[name] || (isWindows ? process.env[name] : os.homedir())
}

// Candidate directories, most-specific first. `root` is Veil's own bundle.
function bundleDirs(root) {
  return [path.join(root, 'bin', bundleKey()), path.join(root, 'bin')]
}

function systemTorCandidates() {
  if (isWindows) {
    const pf = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']]
      .filter(Boolean)
    return [
      ...pf.map(d => path.join(d, 'Tor', 'tor.exe')),
      // a Tor Browser install also contains a usable tor.exe
      ...pf.map(d => path.join(d, 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'tor.exe')),
      path.join(envHome('USERPROFILE') || '', 'Desktop', 'Tor', 'tor.exe'),
    ]
  }
  if (isMac) return ['/opt/homebrew/bin/tor', '/usr/local/bin/tor', '/usr/bin/tor']
  return ['/usr/local/bin/tor', '/usr/bin/tor']
}

// The executable Veil will actually run, and where it came from.
// Order: VEIL_TOR_PATH → bundled → system install → PATH.
// Returns {path, source} or {path:null, tried:[...]} — never a bare name that
// would fail as ENOENT later with a confusing message.
// `roots` are the places a bin/ directory may live: the repo when developing, and
// Electron's resourcesPath when packaged. Bundled copies outrank system installs,
// so a Veil build never silently runs someone else's tor.
function resolveTor({ roots = [], env = process.env } = {}) {
  const tried = []
  const warnings = []
  let envRejected = null
  const consider = (p, source) => {
    if (!p) return null
    const abs = path.resolve(p)
    tried.push(abs)
    if (isExecutable(abs)) return { path: abs, source, warnings }
    return null
  }
  if (env.VEIL_TOR_PATH) {
    const hit = consider(env.VEIL_TOR_PATH, 'env')
    if (hit) return hit
    envRejected = env.VEIL_TOR_PATH
    warnings.push(`VEIL_TOR_PATH="${env.VEIL_TOR_PATH}" is not a readable executable; ignoring the override.`)
  }
  for (const root of roots) {
    for (const dir of bundleDirs(root)) {
      const hit = consider(path.join(dir, executableName('tor')), 'bundled')
      if (hit) return hit
    }
  }
  for (const p of systemTorCandidates()) {
    const hit = consider(p, 'system')
    if (hit) {
      if (envRejected) hit.warnings.push(`VEIL_TOR_PATH "${envRejected}" was unusable, falling back to a system tor.`)
      return hit
    }
  }
  const onPath = searchPath('tor')
  if (onPath) return { path: onPath, source: 'path', warnings }
  return { path: null, tried, warnings }
}

// GeoIP: tor needs these to answer `ip-to-country/*`, which the circuit map shows.
// Layouts differ per platform, and the old code knew only the Homebrew one.
function resolveGeoIP(torPath) {
  if (!torPath) return null
  const dir = path.dirname(torPath)
  const candidates = [
    [path.join(dir, 'geoip'), path.join(dir, 'geoip6')],                    // Veil bundle
    [path.join(dir, '..', 'share', 'tor', 'geoip'), path.join(dir, '..', 'share', 'tor', 'geoip6')], // Homebrew
    [path.join(dir, '..', '..', 'Data', 'Tor', 'geoip'), path.join(dir, '..', '..', 'Data', 'Tor', 'geoip6')], // Tor Browser (win)
    [path.join(dir, '..', '..', 'TorBrowser', 'Data', 'Tor', 'geoip'), path.join(dir, '..', '..', 'TorBrowser', 'Data', 'Tor', 'geoip6')],
    ['/usr/share/tor/geoip', '/usr/share/tor/geoip6'],                       // Debian/Ubuntu
  ]
  for (const [v4, v6] of candidates) {
    if (isFile(v4)) return { v4, v6: isFile(v6) ? v6 : null }
  }
  return null
}

// Pluggable transport binaries. Tor Browser's expert bundles put them in a
// pluggable_transports/ subdirectory, so both layouts are searched.
function transportDirs(root) {
  const key = bundleKey()
  return [
    path.join(root, 'bin', key, 'pluggable_transports'),
    path.join(root, 'bin', key),
    path.join(root, 'bin', 'pluggable_transports'),
    path.join(root, 'bin'),
  ]
}

function resolveTransport(name, { roots = [] } = {}) {
  for (const root of roots) {
    for (const dir of transportDirs(root)) {
      const p = path.join(dir, executableName(name))
      if (isExecutable(p)) return p
    }
  }
  return null
}

// A Veil killed hard can't wipe its tor folder; the next start does. `veil.owner`
// records which process and which boot session wrote it, because on Windows a
// directory is NOT locked while tor runs in it (measured), so the filesystem cannot
// tell a live instance from a dead one — and PIDs get recycled after a reboot.
const OWNER_FILE = 'veil.owner'

function ownerToken() {
  // ~stable within one boot session, different after a reboot.
  const bootMs = Date.now() - Math.round(os.uptime() * 1000)
  return { pid: process.pid, boot: Math.round(bootMs / 60000) }
}

function isStaleDir(dir, now = Date.now()) {
  const info = { dir, verdict: 'unknown' }
  let owner
  try {
    owner = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8'))
  } catch {
    // No owner record: only a directory we have never seen is safe to assume dead.
    let age
    try { age = now - fs.statSync(dir).mtimeMs } catch { return { ...info, verdict: 'gone' } }
    return { ...info, verdict: age > 24 * 3600e3 ? 'stale-no-owner' : 'young-no-owner', age }
  }
  if (owner.pid === process.pid) return { ...info, verdict: 'mine' }
  const current = ownerToken()
  if (Number(owner.boot) !== current.boot) return { ...info, verdict: 'stale-boot', owner }
  try {
    process.kill(owner.pid, 0) // same boot session: is the owner still running?
    return { ...info, verdict: 'alive', owner }
  } catch {
    return { ...info, verdict: 'stale-dead-owner', owner }
  }
}

// Windows: antivirus and indexer scans can hold a freshly written file for a moment,
// so a single rm fails with EBUSY/EPERM/ENOTEMPTY. Retry with a bound, and never let
// one undeletable directory abort the whole sweep or vanish without a report.
const RETRYABLE = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE', 'ETIMEDOUT'])

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function removeTree(dir, { retries = 5, delayMs = 100, backoff = 2 } = {}) {
  let attempt = 0
  let lastError = null
  let delay = delayMs
  while (attempt <= retries) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: retries, retryDelay: delayMs })
      if (!fs.existsSync(dir)) return { ok: true, attempts: attempt + 1 }
      lastError = new Error('directory still present after rmSync')
    } catch (err) {
      lastError = err
      if (!RETRYABLE.has(err.code)) break // a real permission/path problem: retrying won't help
    }
    if (++attempt > retries) break
    sleepSync(delay)
    delay = Math.min(delay * backoff, 2000)
  }
  return { ok: false, attempts: attempt, error: lastError }
}

// Wipe tor folders left behind by a previous Veil that was killed. Every decision is
// reported, because an undeletable directory is an anonymity leak: it must never pass
// silently. Returns {removed, recovered, kept, failed}.
function sweepStale(prefix, { tmpdir = os.tmpdir() } = {}) {
  const report = { removed: [], recovered: [], kept: [], failed: [] }
  let names
  try {
    names = fs.readdirSync(tmpdir)
  } catch (err) {
    report.error = `cannot read ${tmpdir}: ${err.message}`
    return report
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const dir = path.join(tmpdir, name)
    const verdict = isStaleDir(dir)
    if (verdict.verdict === 'mine' || verdict.verdict === 'alive' || verdict.verdict === 'young-no-owner' || verdict.verdict === 'unknown') {
      report.kept.push({ dir, ...verdict })
      continue
    }
    if (verdict.verdict === 'gone') continue
    let r = removeTree(dir)
    if (!r.ok && /^(EPERM|EACCES)$/.test(r.error?.code || '')) {
      // A directory an older Veil locked with a bad ACL would otherwise keep tor's keys in
      // the temp folder for good. Take the ACL back, then try again — once.
      const restored = restoreAccess(dir)
      if (restored.ok) r = removeTree(dir, { retries: 2 })
      if (r.ok) { report.recovered.push(dir); continue }
      report.failed.push({ dir, attempts: r.attempts, restore: restored.ok ? 'retried after icacls' : `icacls failed: ${restored.error?.message}`, error: `${r.error?.code || 'ERR'} ${r.error?.message || ''}`.trim() })
      continue
    }
    if (r.ok) report.removed.push(dir)
    else report.failed.push({ dir, attempts: r.attempts, error: `${r.error?.code || 'ERR'} ${r.error?.message || ''}`.trim() })
  }
  return report
}

// --- process lifecycle -------------------------------------------------------
// SIGTERM does not exist on Windows: Node maps it to TerminateProcess, an immediate
// hard kill (measured: tor died in 12 ms with no exit code). So Veil asks tor to stop
// over the control port first and only then falls back to killing.
function spawnOptions({ hidden = true } = {}) {
  return isWindows ? { windowsHide: hidden, detached: false } : {}
}

function signalTerminate(child) {
  if (!child || child.killed || child.exitCode != null) return false
  try { child.kill(isWindows ? undefined : 'SIGTERM'); return true } catch { return false }
}

function signalForce(child) {
  if (!child || child.killed || child.exitCode != null) return
  // On Windows there is no stronger signal: kill() already is TerminateProcess.
  try { child.kill(isWindows ? undefined : 'SIGKILL') } catch {}
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise(resolve => {
    if (!child) return resolve(true)
    if (child.exitCode != null || child.signalCode != null) return resolve(true)
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolve(true) })
  })
}

// --- application state -------------------------------------------------------
// userData/downloads come from Electron; the caller passes them in so this module
// stays testable. `0o600` is ignored by NTFS, so Windows needs an explicit ACL.
//
// The inheritable flag only goes on directories, and it must. Measured: a plain `USER:(F)`
// ACE does not reach files created later, and those files end up with an empty DACL — so
// empty that even the creator can neither read nor delete them (`icacls /inheritance:r`
// afterwards is what produced it, and that is exactly the old Veil bug). `(OI)(CI)F` on a
// directory makes every child inherit `USER:(F)` again. The same flags on a *file* are
// rejected by NTFS and leave the file with no access entry at all, so files keep plain `F`.
const icaclsProtect = (target, { dir = false } = {}) => {
  const user = process.env.USERNAME || process.env.USER
  if (!user) throw new Error('no username in the environment; cannot build an ACL')
  execFileSync('icacls', [target, '/inheritance:r', '/grant:r', `${user}:${dir ? '(OI)(CI)' : ''}F`],
    { stdio: 'pipe', windowsHide: true })
}

function protectFile(file) {
  if (!isWindows) {
    try { fs.chmodSync(file, 0o600); return { ok: true, method: 'mode' } }
    catch (err) { return { ok: false, method: 'mode', error: err } }
  }
  try { icaclsProtect(file); return { ok: true, method: 'icacls' } }
  catch (err) { return { ok: false, method: 'icacls', error: err } }
}

// A directory poisoned the old way (or by any other ACL accident) holds files whose own
// owner is locked out: they cannot be read, so they cannot even be identified, and they
// cannot be deleted, so tor's keys survive the wipe forever. Veil created them, so it is
// the owner and may rewrite their DACL. Applied recursively, with /c to keep going over
// entries another process still holds.
function restoreAccess(dir) {
  if (!isWindows) return { ok: true, method: 'none' }
  const user = process.env.USERNAME || process.env.USER
  if (!user) return { ok: false, method: 'icacls', error: new Error('no username in the environment; cannot build an ACL') }
  try {
    execFileSync('icacls', [dir, '/grant:r', `${user}:(OI)(CI)F`, '/t', '/c'], { stdio: 'pipe', windowsHide: true })
    return { ok: true, method: 'icacls' }
  } catch (err) {
    return { ok: false, method: 'icacls', error: err }
  }
}

// /inheritance:r on a directory that ALREADY has children leaves those children with an
// ACL their owner can no longer delete through (measured: rm of the pre-existing file
// fails EPERM while the directory itself shows USER:(F)). So a directory must be
// protected while it is still empty — which is exactly when Veil creates the tor folder.
function protectDirEmpty(dir) {
  if (!isWindows) {
    try { fs.chmodSync(dir, 0o700); return { ok: true, method: 'mode' } }
    catch (err) { return { ok: false, method: 'mode', error: err } }
  }
  try {
    if (fs.readdirSync(dir).length) return { ok: false, method: 'icacls', error: new Error('directory is not empty; protecting it would make its current contents undeletable') }
    icaclsProtect(dir, { dir: true })
    return { ok: true, method: 'icacls' }
  } catch (err) {
    return { ok: false, method: 'icacls', error: err }
  }
}

// Window chrome. Veil draws its own toolbar on every OS; what differs is who owns the
// caption buttons. macOS hides the title bar and moves the traffic lights into our
// toolbar. Windows has no such option: leaving the default frame gives the user a native
// title bar *above* Veil's toolbar, so the frame is hidden and the real min/max/close
// buttons are overlaid on the right edge of the toolbar (still native, still keyboard-
// accessible, and drag still works via -webkit-app-region in ui.css).
function windowChrome({ height = 38, dark = false } = {}) {
  if (isMac) return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } }
  if (isWindows) {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: dark ? '#121012' : '#dfe1e5',
        symbolColor: dark ? '#e8dcdc' : '#1b1b1b',
        height,
      },
    }
  }
  return {}
}

// The one canonical name for "which OS is this", used for the fake `navigator.platform`
// bucket (main.js) and for the CSS chrome the renderer draws.
function osName() {
  return isMac ? 'mac' : isWindows ? 'windows' : 'linux'
}

function describeTorInstallError(tried) {
  const where = isWindows
    ? 'Veil bundles tor.exe, so this usually means the Windows Tor binaries were not acquired. Run: npm run tor:fetch'
    : isMac
      ? 'Install tor with: brew install tor'
      : 'Install tor with: sudo apt install tor'
  return `No usable tor executable found. ${where}` +
    (tried && tried.length ? `\nLooked in:\n${tried.map(p => '  ' + p).join('\n')}` : '')
}

module.exports = {
  isWindows, isMac, isLinux, EXE,
  bundleKey, executableName, isFile, isExecutable, searchPath,
  bundleDirs, transportDirs, systemTorCandidates, resolveTor, resolveGeoIP, resolveTransport,
  OWNER_FILE, ownerToken, isStaleDir, sweepStale,
  removeTree, sleepSync, RETRYABLE,
  spawnOptions, signalTerminate, signalForce, waitForExit,
  protectFile, protectDirEmpty, describeTorInstallError,
  windowChrome, osName,
}
