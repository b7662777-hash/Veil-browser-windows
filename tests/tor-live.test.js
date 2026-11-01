// Integration: the real tor that Veil ships, started and stopped the way the app does it.
// If this machine has no tor for its platform, every case here is reported individually as
// SKIPPED with the reason and what to run (npm run tor:fetch) — never as a pass, and never
// silently absent from the totals.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { TorManager, findTor, ROOTS } = require('../src/main/tor')
const P = require('../src/main/platform')

const found = P.resolveTor({ roots: ROOTS, env: process.env })
const why = found.path ? undefined : `no tor for ${P.bundleKey()} here (${found.tried.length} places looked); run npm run tor:fetch`
// The skip goes on every case, never on the suite: a suite-level skip registers no children
// at all, so a machine without tor would print "skipped 0" and a CI reader would see a clean
// run. Here the six cases stay in the report as skipped, each with the reason.
const suite = test.describe

suite(`the bundled tor (${found.path || 'absent'} — source ${found.source || 'n/a'})`, () => {
  const tor = new TorManager()
  let dirBeforeRestart = null
  const live = (name, opts, fn) => test(name, { skip: why, ...opts }, fn)

  live('it bootstraps and authenticates to its own control port', { timeout: 240000 }, async () => {
    await tor.start({})
    await waitReady(tor)
    assert.equal(tor.progress, 100)
    assert.equal(tor.bridges.length, 0, 'this run is a direct connection')
    const version = await tor.control.getinfo('version')
    assert.match(version, /^\d+\.\d+\.\d+/)
    // tor answers this as "NOTICE BOOTSTRAP PROGRESS=100 TAG=done SUMMARY=…", not a bare number.
    const boot = await tor.control.getinfo('status/bootstrap-phase')
    assert.match(boot, /PROGRESS=100/, boot)
  })

  live('the data folder is Veil\'s own, owned by this process, and holds the control cookie', {}, () => {
    assert.ok(tor.dataDir.startsWith(os.tmpdir()), tor.dataDir)
    assert.match(path.basename(tor.dataDir), /^veil-tor-/)
    assert.equal(P.isStaleDir(tor.dataDir).verdict, 'mine', 'the sweep must never treat a live folder as garbage')
    assert.ok(fs.existsSync(path.join(tor.dataDir, 'control_auth_cookie')))
    assert.ok(fs.existsSync(path.join(tor.dataDir, 'veil.owner')))
  })

  live('the SOCKS port isolates by credential, so two sites get two circuits', { timeout: 60000 }, async () => {
    const { username, password } = { username: 'livetest.example', password: `${'veil-live'}:0` }
    const reply = await socksConnect(tor.socksPort, username, password, 'example.com')
    assert.equal(reply[1], 0x00, 'tor accepted the connection with our credential pair')
    const status = await tor.control.getinfo('circuit-status')
    const ours = status.split('\n').filter(l => l.includes(' BUILT ')
      && l.includes(`SOCKS_USERNAME="${username}"`) && l.includes(`SOCKS_PASSWORD="${password}"`))
    assert.equal(ours.length >= 1, true, 'IsolateSOCKSAuth built a circuit owned by these credentials')
    const circuit = await tor.control.circuitFor(username, password)
    assert.ok(circuit, `no circuit owned by these credentials: ${status}`)
    assert.equal(circuit.hops.length, 3, JSON.stringify(circuit))
    assert.ok(circuit.hops.every(h => h.fingerprint && h.nickname), 'every hop is named')
  })

  live('GeoIP is loaded, so the circuit map can name a country', {}, async () => {
    const geo = P.resolveGeoIP(found.path)
    assert.ok(geo, 'the bundle must carry a geoip database for the routing page')
    const country = await tor.control.getinfo('ip-to-country/8.8.8.8')
    assert.match(country, /^[a-z]{2}$/, `got ${country}`)
  })

  live('a restart wipes the previous data folder: nothing amnesic survives it', { timeout: 240000 }, async () => {
    dirBeforeRestart = tor.dataDir
    await tor.restart({})
    await waitReady(tor)
    assert.notEqual(tor.dataDir, dirBeforeRestart, 'a restart means a fresh folder')
    assert.equal(fs.existsSync(dirBeforeRestart), false, 'the old folder must be gone, not merely abandoned')
    assert.equal(P.isStaleDir(dirBeforeRestart).verdict, 'gone')
  })

  live('shutting down leaves no tor behind and no folder either', { timeout: 60000 }, async () => {
    const dirBefore = tor.dataDir
    const pidBefore = tor.proc.pid
    const startedStop = Date.now()
    const r = await tor.stop()
    assert.equal(r.exited, true, 'tor exited within the bounded grace')
    assert.ok(r.graceful, 'and did it because Veil asked over the control port, not because it was killed')
    console.log(`   tor shut down in ${Date.now() - startedStop} ms`)
    assert.equal(fs.existsSync(dirBefore), false, 'the amnesic promise: the data folder is wiped on the way out')
    assert.throws(() => process.kill(pidBefore, 0), 'the process is gone')
    assert.equal(P.sweepStale('veil-tor-').failed.length, 0, 'and nothing of ours is left undeleted in the temp dir')
  })

  live('a tor that dies of its own accord is reported, not hidden', { timeout: 240000 }, async () => {
    await tor.start({})
    await waitReady(tor)
    const diedDir = tor.dataDir
    const victim = tor.proc
    victim.kill() // the Windows crash case: TerminateProcess, no exit code of its own
    await new Promise(res => victim.once('exit', res))
    await new Promise(res => setTimeout(res, 300))
    assert.equal(tor.ready, false)
    assert.match(String(tor.error), /tor exited/i, 'the kill switch has to be told, and so has the user')
    await tor.stop()
    // A crash must not leave keys or state behind either: the wipe still runs on the way out.
    assert.equal(fs.existsSync(diedDir), false, diedDir)
    assert.equal(P.sweepStale('veil-tor-').failed.length, 0)
  })
})

// start() returns once tor is spawned and still alive; bootstrapping continues in the
// background and the app watches the 'status' event (main.js). Wait the same way, bounded,
// and fail with what tor actually said.
async function waitReady(tor, ms = 200000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (tor.ready) return
    if (tor.error && !tor.proc) throw new Error(`tor gave up: ${tor.error}`)
    await new Promise(res => setTimeout(res, 250))
  }
  throw new Error(`tor never became ready in ${ms} ms: ${tor.progress}% — ${tor.summary} ${tor.error || ''}`)
}

// A bare SOCKS5 CONNECT with username/password authentication, as the relay does it.
function socksConnect(port, username, password, host) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1')
    const chunks = []
    sock.on('error', reject)
    sock.on('data', d => chunks.push(d))
    sock.once('connect', () => {
      const u = Buffer.from(username), p = Buffer.from(password), h = Buffer.from(host)
      sock.write(Buffer.from([0x05, 0x01, 0x02])) // offer username/password only
      sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]))
      sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([0x01, 0xbb])]))
    })
    const deadline = setTimeout(() => { sock.destroy(); reject(new Error('no reply from the SOCKS port')) }, 30000)
    const poll = () => {
      const b = Buffer.concat(chunks)
      // [05 02] method choice, [01 00] auth ok, then the 10-byte connect reply
      if (b.length >= 14) { clearTimeout(deadline); sock.destroy(); resolve(b.subarray(4)) }
      else setTimeout(poll, 50)
    }
    poll()
  })
}

test('the tor Veil would pick is recorded with its real source', () => {
  const again = findTor()
  assert.equal(again.path, found.path)
  if (again.path) {
    assert.ok(['env', 'bundled', 'system', 'path'].includes(again.source), again.source)
  } else {
    // A refusal is only useful if it says where it looked — that text is what the user sees.
    assert.ok(again.tried.length > 0, 'a "no tor" verdict must list the places it checked')
    assert.match(P.describeTorInstallError(again.tried), /VEIL_TOR_PATH|tor\.exe|npm run tor:fetch/i)
  }
})
