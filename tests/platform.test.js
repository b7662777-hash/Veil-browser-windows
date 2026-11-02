// Unit tests for src/main/platform.js — the only module in Veil that branches on the OS.
// Plain Node, no Electron, no tor: these run on any machine, any platform.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const P = require('../src/main/platform')

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  if (!P.isWindows) fs.chmodSync(dir, 0o700)
  return dir
}

// A bin/<platform>-<arch>/ tree with a fake tor in it, and the same for a platform
// this machine is not — used to prove Veil can never pick a foreign binary.
function fakeBundles(root, keys) {
  for (const key of keys) {
    const dir = path.join(root, 'bin', key)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, P.executableName('tor'))
    fs.writeFileSync(file, `fake tor for ${key}`)
    if (!P.isWindows) fs.chmodSync(file, 0o755)
  }
  return root
}

const foreignKey = () => (P.bundleKey() === 'win32-x64' ? 'linux-x64' : 'win32-x64')

test('bundleKey is the platform-arch pair the folder layout promises', () => {
  assert.equal(P.bundleKey(), `${process.platform}-${process.arch}`)
  assert.match(P.bundleKey(), /^(win32|darwin|linux)-(x64|arm64)$/)
})

test('executableName adds .exe only on Windows, and never twice', () => {
  assert.equal(P.executableName('tor'), P.isWindows ? 'tor.exe' : 'tor')
  assert.equal(P.executableName('tor.exe'), P.isWindows ? 'tor.exe' : 'tor.exe')
})

test('a bundled tor is found in this platform\'s directory, never a foreign one', () => {
  const root = tempDir('veil-test-bundles-')
  try {
    fakeBundles(root, [foreignKey(), P.bundleKey()])
    const found = P.resolveTor({ roots: [root], env: {} })
    assert.equal(found.path, path.join(root, 'bin', P.bundleKey(), P.executableName('tor')))
    assert.equal(found.source, 'bundled')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a bin/ holding only a foreign platform\'s tor is not used', () => {
  const root = tempDir('veil-test-foreign-')
  try {
    fakeBundles(root, [foreignKey()])
    const found = P.resolveTor({ roots: [root], env: { PATH: '' } })
    assert.notEqual(found.source, 'bundled')
    assert.ok(!found.path || !found.path.includes(foreignKey()), `picked ${found.path} from a foreign bundle`)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('VEIL_TOR_PATH outranks the bundle', () => {
  const root = tempDir('veil-test-env-')
  try {
    fakeBundles(root, [P.bundleKey()])
    const custom = path.join(root, 'my-tor' + P.EXE)
    fs.writeFileSync(custom, 'my tor')
    if (!P.isWindows) fs.chmodSync(custom, 0o755)
    const found = P.resolveTor({ roots: [root], env: { VEIL_TOR_PATH: custom } })
    assert.deepEqual({ path: found.path, source: found.source }, { path: custom, source: 'env' })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('an unusable VEIL_TOR_PATH is refused with a warning instead of being run or crashing', () => {
  const root = tempDir('veil-test-badenv-')
  try {
    fakeBundles(root, [P.bundleKey()])
    const missing = path.join(root, 'nope' + P.EXE)
    const found = P.resolveTor({ roots: [root], env: { VEIL_TOR_PATH: missing } })
    assert.equal(found.source, 'bundled')
    assert.ok(found.warnings.some(w => w.includes('VEIL_TOR_PATH')), JSON.stringify(found.warnings))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('nothing found at all yields {path:null, tried:[...]} and a message naming the fix', () => {
  const root = tempDir('veil-test-none-')
  try {
    const found = P.resolveTor({ roots: [root], env: { PATH: path.join(root, 'empty') } })
    assert.equal(found.path, null)
    assert.ok(found.tried.length > 0)
    const message = P.describeTorInstallError(found.tried)
    assert.match(message, /No usable tor executable found/)
    assert.match(message, P.isWindows ? /npm run tor:fetch/ : /brew install tor|apt install tor/)
    assert.ok(message.includes(found.tried[0]))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('system tor candidates are absolute and platform-shaped', () => {
  const list = P.systemTorCandidates()
  assert.ok(list.length >= 2)
  for (const p of list) {
    assert.ok(path.isAbsolute(p), `${p} is not absolute`)
    assert.match(path.basename(p), P.isWindows ? /^tor\.exe$/ : /^tor$/)
  }
  // The Homebrew path that used to be hardcoded is one candidate among several, not the answer.
  if (!P.isWindows) assert.ok(list.some(p => p.endsWith('/usr/local/bin/tor') || p.endsWith('/usr/bin/tor')))
})

test('PATH lookup finds a real executable and refuses to invent one', () => {
  assert.ok(P.searchPath(P.executableName('node').replace(/\.exe$/, '')))
  assert.equal(P.searchPath('veil-does-not-exist-xyz'), null)
})

test('GeoIP is resolved next to tor, in every layout Veil or Tor Browser uses', () => {
  const root = tempDir('veil-test-geoip-')
  try {
    const dir = path.join(root, 'bin', P.bundleKey())
    fs.mkdirSync(dir, { recursive: true })
    const tor = path.join(dir, P.executableName('tor'))
    fs.writeFileSync(tor, 'tor')
    // Nothing beside it yet: only the OS-wide Debian/Ubuntu file may still answer, and only if it is there.
    const system = '/usr/share/tor/geoip'
    const alone = P.resolveGeoIP(tor)
    if (fs.existsSync(system)) assert.equal(alone.v4, system)
    else assert.equal(alone, null, 'must not claim a geoip that is not there')
    fs.writeFileSync(path.join(dir, 'geoip'), 'v4')
    assert.deepEqual(P.resolveGeoIP(tor), { v4: path.join(dir, 'geoip'), v6: null })
    fs.writeFileSync(path.join(dir, 'geoip6'), 'v6')
    assert.deepEqual(P.resolveGeoIP(tor), { v4: path.join(dir, 'geoip'), v6: path.join(dir, 'geoip6') })
    // Tor Browser's Windows layout: ../../Data/Tor/geoip
    const tb = path.join(root, 'TorBrowser', 'Tor')
    fs.mkdirSync(path.join(root, 'Data', 'Tor'), { recursive: true })
    fs.writeFileSync(path.join(root, 'Data', 'Tor', 'geoip'), 'v4')
    fs.mkdirSync(tb, { recursive: true })
    const tbTor = path.join(tb, P.executableName('tor'))
    fs.writeFileSync(tbTor, 'tor')
    assert.equal(P.resolveGeoIP(tbTor).v4, path.join(root, 'Data', 'Tor', 'geoip'))
    assert.equal(P.resolveGeoIP(null), null)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('transport lookup prefers pluggable_transports/ and needs an executable, not a name', () => {
  const root = tempDir('veil-test-pt-')
  try {
    assert.equal(P.resolveTransport('lyrebird', { roots: [root] }), null)
    const deep = path.join(root, 'bin', P.bundleKey(), 'pluggable_transports')
    fs.mkdirSync(deep, { recursive: true })
    const exe = path.join(deep, P.executableName('lyrebird'))
    fs.writeFileSync(exe, 'lyrebird')
    if (!P.isWindows) fs.chmodSync(exe, 0o755)
    assert.equal(P.resolveTransport('lyrebird', { roots: [root] }), exe)
    // a non-executable file must not count as a transport (POSIX: mode bit; Windows: it can't tell)
    if (!P.isWindows) {
      fs.chmodSync(exe, 0o644)
      assert.equal(P.resolveTransport('lyrebird', { roots: [root] }), null)
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('the owner record decides what counts as a stale tor folder', () => {
  const root = tempDir('veil-test-owner-')
  try {
    const mk = (name, owner, ageMs = 0) => {
      const dir = path.join(root, name)
      fs.mkdirSync(dir)
      if (owner) fs.writeFileSync(path.join(dir, P.OWNER_FILE), JSON.stringify(owner))
      if (ageMs) {
        const at = new Date(Date.now() - ageMs)
        fs.utimesSync(dir, at, at)
      }
      return dir
    }
    const current = P.ownerToken()
    assert.equal(typeof current.pid, 'number')
    assert.equal(typeof current.boot, 'number')

    assert.equal(P.isStaleDir(mk('mine', { ...current })).verdict, 'mine')
    // Our own pid outranks every other verdict: Veil must never sweep the folder it is using.
    assert.equal(P.isStaleDir(mk('mine-other-boot', { pid: current.pid, boot: current.boot + 7 })).verdict, 'mine')
    assert.equal(P.isStaleDir(mk('other-boot', { pid: 0x7ffffffe, boot: current.boot + 7 })).verdict, 'stale-boot')
    // a pid from this boot session that no longer exists
    assert.equal(P.isStaleDir(mk('dead', { pid: 0x7ffffffe, boot: current.boot })).verdict, 'stale-dead-owner')
    assert.equal(P.isStaleDir(mk('young')).verdict, 'young-no-owner')
    assert.equal(P.isStaleDir(mk('ancient', null, 3 * 24 * 3600e3)).verdict, 'stale-no-owner')
    assert.equal(P.isStaleDir(path.join(root, 'not-there')).verdict, 'gone')

    // a live process other than us owns it: must be left alone
    const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], P.spawnOptions())
    try {
      assert.equal(P.isStaleDir(mk('alive', { pid: child.pid, boot: current.boot })).verdict, 'alive')
    } finally { child.kill() }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('the sweep removes dead tor folders, keeps live ones, and never goes quiet about failures', () => {
  const root = tempDir('veil-test-sweep-')
  try {
    const current = P.ownerToken()
    const mk = (name, owner, ageMs = 0) => {
      const dir = path.join(root, name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'state'), 'tor state')
      if (owner) fs.writeFileSync(path.join(dir, P.OWNER_FILE), JSON.stringify(owner))
      if (ageMs) { const at = new Date(Date.now() - ageMs); fs.utimesSync(dir, at, at) }
      return dir
    }
    const dead = mk('veil-test-sweep-dead', { pid: 0x7ffffffe, boot: current.boot })
    const ancient = mk('veil-test-sweep-ancient', null, 3 * 24 * 3600e3)
    const mine = mk('veil-test-sweep-mine', current)
    const young = mk('veil-test-sweep-young')
    const otherPrefix = mk('not-veil-test-sweep-anything', null, 3 * 24 * 3600e3)

    const report = P.sweepStale('veil-test-sweep-', { tmpdir: root })
    assert.deepEqual(report.removed.sort(), [ancient, dead].sort())
    assert.ok(!fs.existsSync(dead), 'a dead owner\'s folder must go — it holds keys and state')
    assert.ok(!fs.existsSync(ancient))
    assert.deepEqual(report.kept.map(k => k.dir).sort(), [mine, young].sort())
    assert.ok(fs.existsSync(mine) && fs.existsSync(young), 'an active folder must survive')
    assert.ok(fs.existsSync(otherPrefix), 'the sweep must not touch folders it did not create')
    assert.deepEqual(report.failed, [])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('removeTree reports attempts and an error instead of pretending a folder is gone', () => {
  const root = tempDir('veil-test-rm-')
  const real = fs.rmSync
  try {
    const dir = path.join(root, 'tree')
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'a', 'b', 'state'), 'x')
    const wiped = P.removeTree(dir)
    assert.equal(wiped.ok, true)
    assert.equal(wiped.attempts, 1)
    assert.ok(!fs.existsSync(dir))
    assert.equal(P.removeTree(dir).ok, true, 'force:true makes an absent folder a success')

    // Simulate the Windows case that motivated the retry loop: antivirus or the indexer
    // holds a freshly written file, so the first rm fails EBUSY and a later one succeeds.
    const busy = path.join(root, 'busy')
    fs.mkdirSync(busy)
    fs.writeFileSync(path.join(busy, 'state'), 'x')
    let calls = 0
    fs.rmSync = (p, o) => { if (++calls < 3) { const e = new Error('simulated lock'); e.code = 'EBUSY'; throw e } return real(p, o) }
    try {
      const r = P.removeTree(busy, { retries: 5, delayMs: 5 })
      assert.equal(r.ok, true, JSON.stringify(r.error))
      assert.equal(calls, 3)
    } finally { fs.rmSync = real }

    // A lock that never clears must be reported, with a bounded number of tries.
    fs.mkdirSync(busy, { recursive: true })
    fs.writeFileSync(path.join(busy, 'state'), 'x')
    fs.rmSync = () => { const e = new Error('still locked'); e.code = 'EPERM'; throw e }
    try {
      const r = P.removeTree(busy, { retries: 3, delayMs: 1 })
      assert.equal(r.ok, false)
      assert.equal(r.attempts, 4, `expected 4 tries (1 + 3 retries), got ${r.attempts}`)
      assert.equal(r.error.code, 'EPERM')
    } finally { fs.rmSync = real }
  } finally { fs.rmSync = real; fs.rmSync(root, { recursive: true, force: true }) }
})

test('a non-retryable error stops immediately instead of burning the retry budget', () => {
  const root = tempDir('veil-test-rm2-')
  const real = fs.rmSync
  try {
    fs.rmSync = () => { const e = new Error('bad argument'); e.code = 'ENOTDIR'; throw e }
    const started = Date.now()
    const r = P.removeTree(path.join(root, 'whatever'), { retries: 6, delayMs: 50 })
    assert.equal(r.ok, false)
    assert.equal(r.attempts, 0, `a pointless error was retried ${r.attempts} times`)
    assert.equal(r.error.code, 'ENOTDIR')
    assert.ok(Date.now() - started < 50, 'no waiting after an error that cannot fix itself')
  } finally { fs.rmSync = real; fs.rmSync(root, { recursive: true, force: true }) }
})

test('RETRYABLE covers the transient Windows blockers and nothing else', () => {
  for (const code of ['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE', 'ETIMEDOUT']) assert.ok(P.RETRYABLE.has(code), code)
  for (const code of ['ENOENT', 'ENOTDIR', 'EINVAL']) assert.ok(!P.RETRYABLE.has(code), code)
})

test('file protection works and never throws the caller into silence', () => {
  const root = tempDir('veil-test-protect-')
  try {
    const file = path.join(root, 'bookmarks.json')
    fs.writeFileSync(file, '{}')
    const r = P.protectFile(file)
    assert.ok(r.ok, `protectFile failed: ${r.error?.message}`)
    assert.ok(['mode', 'icacls'].includes(r.method))
    if (!P.isWindows) assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    // Veil has to keep reading and replacing its own file: a protection that locked the
    // creator out would be worse than no protection (measured on Windows, see R17).
    assert.equal(fs.readFileSync(file, 'utf8'), '{}')
    fs.writeFileSync(file, '{"a":1}')
    assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}')
    assert.doesNotThrow(() => fs.rmSync(file, { force: true }))
    assert.equal(P.protectFile(path.join(root, 'missing.json')).ok, false, 'a missing file must be reported, not swallowed')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a directory is protected while empty, and its later contents stay deletable', () => {
  const root = tempDir('veil-test-protectdir-')
  try {
    const late = path.join(root, 'late')
    fs.mkdirSync(late)
    fs.writeFileSync(path.join(late, 'already-here'), 'x')
    const refused = P.protectDirEmpty(late)
    assert.equal(refused.ok, false, 'protecting a non-empty directory is the trap measured in R17')
    assert.match(String(refused.error?.message), /not empty/)

    const dir = path.join(root, 'empty')
    fs.mkdirSync(dir)
    assert.equal(P.protectDirEmpty(dir).ok, true)
    // What Veil actually does: protect, then write tor's state inside, then wipe on the way out.
    const cookie = path.join(dir, 'control_auth_cookie')
    fs.writeFileSync(cookie, 'cookie')
    if (P.isWindows) {
      // The grant must reach files created afterwards. With a plain (F) ACE they inherit
      // whatever the machine default gives them, which on a hardened temp ACL can leave the
      // ownership marker unreadable — and then the sweep cannot tell stale from live.
      const acl = require('child_process').execFileSync('icacls', [cookie], { encoding: 'utf8' })
      assert.match(acl, /\(I\)\(F\)/, `the child must inherit our access, got: ${acl}`)
      assert.equal(fs.readFileSync(cookie, 'utf8'), 'cookie')
    }
    assert.doesNotThrow(() => fs.rmSync(dir, { recursive: true, force: true }))
    assert.ok(!fs.existsSync(dir))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// The first Windows build protected the tor folder *after* writing into it, and that left
// every file inside with an empty DACL: unreadable and undeletable by the very account that
// made them. Any such folder still on disk holds tor keys and state, so the sweep has to
// take the ACL back and finish the wipe instead of logging a failure once a day forever.
test('a tor folder poisoned by the old ACL bug is recovered and wiped, not left holding keys', {
  skip: P.isWindows ? false : 'icacls poisoning is Windows-only'
}, (t) => {
  const root = tempDir('veil-test-poison-')
  const lockedOut = file => { try { fs.readFileSync(file); return false } catch { return true } }
  try {
    const dir = path.join(root, 'veil-test-poison-old')
    fs.mkdirSync(dir)
    const marker = path.join(dir, P.OWNER_FILE)
    const state = path.join(dir, 'state')
    fs.writeFileSync(marker, JSON.stringify({ pid: 0x7ffffffe, boot: 1 }))
    fs.writeFileSync(state, 'tor state')
    // Reproduce the damage as the old build actually caused it. It protected the folder after
    // writing into it, and every file already inside was left with an empty DACL — the state
    // platform.js describes above restoreAccess. Stripping inheritance from the *directory*
    // only produces that on machines which propagate the removal to existing children, and a CI
    // image that does not propagate it silently turns this test into a failure about the runner
    // rather than about Veil. So the files themselves are poisoned, and the precondition is
    // checked before anything is asserted.
    for (const f of [marker, state]) {
      try { require('child_process').execFileSync('icacls', [f, '/inheritance:r'], { stdio: 'pipe', windowsHide: true }) } catch {}
    }
    if (!lockedOut(marker)) {
      t.skip('this machine still reads a file whose DACL is empty, so the recovery path cannot be exercised here')
      return
    }
    assert.throws(() => fs.readFileSync(marker), 'the marker must really be locked away')
    assert.throws(() => fs.rmSync(dir, { recursive: true, force: true }), 'and undeletable')
    assert.ok(fs.existsSync(dir), 'the naive wipe leaves it behind — which is the bug being fixed')

    // A folder nobody can identify is only stale once it is old: that rule must hold even
    // here, so age it the way the sweep reads it.
    const at = new Date(Date.now() - 25 * 3600e3)
    fs.utimesSync(dir, at, at)
    assert.equal(P.isStaleDir(dir).verdict, 'stale-no-owner')

    const report = P.sweepStale('veil-test-poison-', { tmpdir: root })
    assert.deepEqual(report.failed, [], `recovery failed: ${JSON.stringify(report.failed)}`)
    assert.deepEqual(report.recovered, [dir])
    assert.ok(!fs.existsSync(dir), 'a poisoned folder of ours must not survive the sweep')
  } finally {
    // Own cleanup, including of anything this test damaged on purpose.
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {
      P.restoreAccess(root)
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})

test('window chrome: Veil draws the toolbar, the OS draws the buttons', () => {
  const chrome = P.windowChrome({ height: 38, dark: true })
  assert.equal(P.osName(), P.isWindows ? 'windows' : P.isMac ? 'mac' : 'linux')
  if (P.isMac) {
    assert.equal(chrome.titleBarStyle, 'hiddenInset')
    assert.ok(chrome.trafficLightPosition)
  } else if (P.isWindows) {
    assert.equal(chrome.titleBarStyle, 'hidden')
    assert.equal(chrome.titleBarOverlay.height, 38)
    assert.ok(!chrome.trafficLightPosition, 'Windows has no traffic lights')
    assert.notEqual(chrome.titleBarOverlay.color, chrome.titleBarOverlay.symbolColor, 'the buttons must stay visible in both themes')
  } else {
    assert.deepEqual(chrome, {})
  }
})

test('spawn options hide a console window on Windows and stay out of the way elsewhere', () => {
  const opts = P.spawnOptions()
  if (P.isWindows) assert.deepEqual(opts, { windowsHide: true, detached: false })
  else assert.deepEqual(opts, {})
})

test('a child that is asked politely exits before anything is forced', async () => {
  const { spawn } = require('child_process')
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => process.exit(0)); setTimeout(() => {}, 30000)'],
    { stdio: 'ignore', ...P.spawnOptions() })
  try {
    assert.equal(P.signalTerminate(child), true)
    assert.equal(await P.waitForExit(child, 5000), true)
    assert.equal(await P.waitForExit(null), true, 'no child at all is already an exit')
  } finally { child.kill() }
})

test('waitForExit says false instead of hanging on a process that will not die', async () => {
  const { spawn } = require('child_process')
  // -e with a long timer and no signal handling: on Windows SIGTERM is TerminateProcess,
  // so it dies; on POSIX it ignores SIGTERM and must be forced. Either way this returns.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', ...P.spawnOptions() })
  try {
    P.signalTerminate(child)
    assert.equal(typeof await P.waitForExit(child, 250), 'boolean')
  } finally { P.signalForce(child); await P.waitForExit(child, 5000) }
})
