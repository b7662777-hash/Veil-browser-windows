// TorManager — spawns and owns Veil's private tor process (ADR 0002).
//
// Platform branching lives in platform.js; this file only decides *what* to run.
const { spawn } = require('child_process')
const { EventEmitter } = require('events')
const fs = require('fs')
const os = require('os')
const net = require('net')
const path = require('path')
const { TorControl } = require('./control')
const P = require('./platform')

// Where a bin/ directory might be: the repo when developing, Electron's resources
// directory when packaged (extraResources land outside the asar so they can exec).
const ROOTS = [path.join(__dirname, '..', '..'), process.resourcesPath].filter(Boolean)

const DATA_PREFIX = 'veil-tor-'
// A bridge that makes no progress for this long is down or blocked. It is a *stall* limit,
// not a total one: measured from this network the built-in obfs4 lines took 45 s and the
// meek line 100 s to bootstrap, so a fixed 90 s deadline would have failed a working bridge.
const BRIDGE_STALL_MS = 90000
const BRIDGE_MAX_MS = 300000
const SHUTDOWN_GRACE_MS = 3000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function findTor(env = process.env) {
  return P.resolveTor({ roots: ROOTS, env })
}

// lyrebird runs obfs4 / Snowflake / meek / webtunnel bridges. Tor Browser's Windows
// bundle keeps it in pluggable_transports/ next to tor; `npm run tor:fetch` reproduces
// that layout under bin/<platform>-<arch>/.
function transportBinary(name, env = process.env) {
  const override = env[`VEIL_${name.toUpperCase()}`]
  if (override) {
    const abs = path.resolve(override)
    if (P.isExecutable(abs)) return abs
    console.warn(`[tor] VEIL_${name.toUpperCase()}="${override}" is not an executable file; ignoring it.`)
    return null
  }
  return P.resolveTransport(name, { roots: ROOTS })
}

// tor splits a ClientTransportPlugin line on whitespace and quotes do not protect the
// path (measured on Windows: "C:\Program Files\…" arrived as "C:\Program"). The official
// torrc-defaults therefore uses a *relative* path, resolved against tor's cwd. Same here:
// hand tor a relative exec and give the child a cwd we control, so an install directory
// with spaces or non-ASCII characters still gets bridges.
function transportSpawn(transportPath) {
  if (!transportPath) return null
  const dir = path.dirname(transportPath)
  const cwd = path.dirname(dir)
  const rel = path.join(path.basename(dir), path.basename(transportPath))
  if (/[\s"]/.test(rel)) return null // a directory name we do not control: cannot be expressed
  return { cwd, rel: rel.split(path.sep).join('/') }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

class TorManager extends EventEmitter {
  constructor() {
    super()
    this.progress = 0
    this.summary = 'Starting tor'
    this.ready = false
    this.error = null
    this.control = null
    this.warnings = []
    this.cleanup = null
    this._chain = Promise.resolve() // start/restart/stop never overlap
  }

  // bridges: bridge lines ("obfs4 1.2.3.4:443 FINGERPRINT cert=..."), or [] to connect directly
  // requireBridge: the user's saved setting says "through a bridge", so an empty list is a
  // broken configuration, not a licence to go direct (see _start).
  start(options) {
    this._chain = this._chain
      .then(() => this._start(options))
      .catch(err => this._fail(`Could not start tor: ${err.message}`))
    return this._chain
  }

  async _start({ bridges = [], requireBridge = false, mode = null } = {}) {
    this.stopping = false
    this.ready = false
    this.error = null
    this.progress = 0
    this.control = null
    this.bridges = bridges
    this.summary = bridges.length ? 'Starting tor with bridges' : 'Starting tor'

    // A bridge mode with no lines must fail closed. Starting plain tor instead would hand
    // the user's real IP to exactly the network they configured a bridge to hide from.
    if (requireBridge && !bridges.length) {
      return this._fail(`Veil is set to connect through a${mode ? ` "${mode}"` : ''} bridge, but there are no bridge lines to use. ` +
        'Not connecting directly: that would put your traffic on the open network. Add a bridge under Settings → Connection, or choose "Direct Tor" to go without one.')
    }

    const found = findTor()
    this.warnings = found.warnings || []
    for (const w of this.warnings) console.warn('[tor]', w)
    if (!found.path) return this._fail(P.describeTorInstallError(found.tried))
    this.torPath = found.path
    this.torSource = found.source

    const swept = P.sweepStale(DATA_PREFIX)
    if (swept.failed.length || swept.error) {
      // An old tor folder still holding keys or state is an anonymity leak: say so.
      console.error('[tor] stale data cleanup problems:', JSON.stringify({ failed: swept.failed, error: swept.error }))
    }
    // Folders an earlier Veil locked with a bad ACL are recoverable now; a user who sees
    // this line knows the cleanup reached them.
    if (swept.recovered.length) console.warn(`[tor] took back and wiped ${swept.recovered.length} tor folder(s) an older Veil had made undeletable`)
    this.cleanup = { swept }

    this.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), DATA_PREFIX))
    // Before anything is written: an ACL applied afterwards would lock Veil out of its
    // own folder on the way to the bin (see platform.protectDirEmpty).
    const prot = P.protectDirEmpty(this.dataDir)
    if (!prot.ok) console.warn(`[tor] could not lock down ${this.dataDir}: ${prot.error?.message}`)
    fs.writeFileSync(path.join(this.dataDir, P.OWNER_FILE), JSON.stringify({ ...P.ownerToken(), at: new Date().toISOString() }))

    const spawnOpts = P.spawnOptions()
    let lastError = null
    let started = false
    for (let attempt = 1; attempt <= 3; attempt++) {
      this.socksPort = await freePort()
      this.controlPort = await freePort()
      const launched = await this._spawn(found.path, spawnOpts, bridges)
      if (launched.ok) { started = true; break }
      lastError = launched.error
      if (!launched.bindConflict) break
      // Ports are released before tor binds them, so another process can steal one.
      this.summary = 'Retrying tor startup (port in use)'
      this.emit('status')
    }
    // Only wipe once we are really giving up: a retried tor still writes in this folder.
    if (!started) this._wipe()
    if (!started && !this.error) this._fail(lastError || 'tor did not start')
  }

  async _spawn(bin, spawnOpts, bridges) {
    this.ptCwd = null
    // Bridges go in the torrc: Bridge is a repeated option.
    let rc = ''
    if (bridges.length) {
      const lyr = transportBinary('lyrebird')
      const pt = transportSpawn(lyr)
      if (!pt) {
        // Fail closed: starting tor without the bridge would leak the user's IP to
        // whatever censors the bridge, so a bridge request must never fall back to direct.
        return { ok: false, bindConflict: false, error: lyr
          ? `The bridge transport at ${lyr} cannot be used: its directory name contains a space or quote.`
          : `Bridges need the lyrebird transport. Run: npm run tor:fetch` }
      }
      this.ptCwd = pt.cwd
      rc = [
        'UseBridges 1',
        `ClientTransportPlugin meek_lite,obfs2,obfs3,obfs4,scramblesuit,webtunnel exec ${pt.rel}`,
        `ClientTransportPlugin snowflake exec ${pt.rel}`,
        ...bridges.map(line => `Bridge ${line}`),
      ].join('\n') + '\n'
    }
    const torrc = path.join(this.dataDir, 'torrc')
    fs.writeFileSync(torrc, rc)

    const args = [
      '-f', torrc,
      '--defaults-torrc', torrc,
      '--DataDirectory', this.dataDir,
      // Different SOCKS username/password => different circuit (ADR 0003)
      // Same SOCKS flags as Tor Browser (REVERSE_ENGINEERING.md §4)
      '--SocksPort', `127.0.0.1:${this.socksPort} IsolateSOCKSAuth KeepAliveIsolateSOCKSAuth ExtendedErrors IPv6Traffic PreferIPv6`,
      '--ControlPort', `127.0.0.1:${this.controlPort}`,
      '--CookieAuthentication', '1',
      '--ClientOnly', '1',
      '--AvoidDiskWrites', '1',
      '--DormantCanceledByStartup', '1', // from Tor Browser's torrc-defaults
      // tor exits on its own if Veil dies
      '--__OwningControllerProcess', String(process.pid),
      '--Log', 'notice stdout',
    ]
    const geo = P.resolveGeoIP(bin)
    if (geo) args.push('--GeoIPFile', geo.v4, ...(geo.v6 ? ['--GeoIPv6File', geo.v6] : []))

    const proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Never the data dir: Windows refuses to delete a folder that is a live process's
      // cwd, and Veil must be able to wipe it. tor's own directory is stable.
      cwd: this.ptCwd || path.dirname(bin),
      ...spawnOpts,
    })
    this.proc = proc
    const exited = new Promise(resolve => proc.once('exit', (code, signal) => resolve({ code, signal })))

    proc.on('error', err => {
      this._fail(`Could not start tor (${err.message}). ${P.describeTorInstallError([bin])}`)
    })
    proc.on('exit', () => {
      if (proc !== this.proc) return // an old tor from before a restart
      this.ready = false
      if (!this.stopping) this._fail(`tor exited (code ${codeOf(proc)})`)
    })

    let buf = ''
    proc.stdout.on('data', chunk => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        // Windows writes \r\n: the \r must go, or /Bootstrapped (\d+)%...: (.*)$/ never
        // matches, bootstrap progress stalls at 0% and the kill switch stays closed.
        this._onLog(buf.slice(0, i).replace(/\r$/, ''))
        buf = buf.slice(i + 1)
      }
    })
    let errBuf = ''
    proc.stderr.on('data', chunk => {
      // Drain stderr or a full pipe buffer can stall tor; keep the tail for the error text.
      errBuf += chunk
      const lines = errBuf.split(/\r?\n/).filter(Boolean)
      errBuf = lines.slice(-20).join('\n')
      if (process.env.VEIL_DEBUG) for (const line of lines) console.log('[tor:err]', line)
    })
    this.lastStderr = () => errBuf

    // tor either stays alive and bootstraps, or exits quickly with a config error.
    const early = await Promise.race([
      exited,
      new Promise(resolve => setTimeout(() => resolve(null), 1500)),
    ])
    if (early) {
      const text = `${errBuf}\n${buf}`
      const bindConflict = /Address already in use|Cannot assign requested address|bind\(\) failed|Failed to bind/i.test(text)
      return { ok: false, bindConflict, error: bindConflict
        ? 'Another program took the port tor wanted. Retrying.'
        : `tor exited immediately (code ${early.code ?? early.signal}). ${text.split('\n').filter(Boolean).slice(-2).join(' ')}`.trim() }
    }
    this._armBridgeWatchdog(bridges)
    return { ok: true }
  }

  _armBridgeWatchdog(bridges) {
    clearTimeout(this._watchdog)
    this._bridgeDeadline = null
    if (!bridges.length) return
    this._bridgeDeadline = Date.now() + BRIDGE_MAX_MS
    this._touchBridgeWatchdog()
  }

  // Every bit of bootstrap progress restarts the stall clock; the overall deadline still holds.
  _touchBridgeWatchdog() {
    clearTimeout(this._watchdog)
    if (!this._bridgeDeadline || this.ready || this.stopping) return
    this._watchdog = setTimeout(() => {
      if (this.ready || this.stopping) return
      if (Date.now() < this._bridgeDeadline) return this._touchBridgeWatchdog()
      this._bridgeDeadline = null
      this._fail(`Tor is still stuck at ${this.progress}% after ${Math.round(BRIDGE_MAX_MS / 1000)}s. ` +
        'The bridge may be down or blocked — try another one, or a different transport.')
    }, BRIDGE_STALL_MS)
  }

  _onLog(line) {
    if (process.env.VEIL_DEBUG) console.log('[tor]', line)
    const m = line.match(/Bootstrapped (\d+)%[^:]*: (.*)$/)
    if (m) {
      const advanced = Number(m[1]) > this.progress
      this.progress = Number(m[1])
      this.summary = m[2].trim()
      if (advanced) this._touchBridgeWatchdog()
      if (this.progress === 100 && !this.control) this._connectControl()
      this.emit('status')
    }
  }

  async _connectControl() {
    clearTimeout(this._watchdog)
    try {
      const cookie = fs.readFileSync(path.join(this.dataDir, 'control_auth_cookie'))
      this.control = new TorControl()
      await this.control.connect(this.controlPort, cookie)
      await this.control.command('TAKEOWNERSHIP')
      this.ready = true
      this.error = null
      this.summary = this.bridges?.length ? 'Connected to the Tor network via a bridge' : 'Connected to the Tor network'
    } catch (err) {
      this.control = null
      this._fail(`Control port: ${err.message}`)
    }
    this.emit('status')
  }

  _fail(msg) {
    this.error = msg
    this.summary = msg
    this.emit('status')
  }

  status() {
    return { progress: this.progress, summary: this.summary, ready: this.ready, error: this.error, bridged: !!this.bridges?.length }
  }

  stop() {
    this._chain = this._chain
      .then(() => this._stop())
      .catch(err => console.error('[tor] error while stopping tor:', err.message))
    return this._chain
  }

  // Switching bridges: a fresh tor with a fresh data folder and new ports.
  async restart(options) {
    await this.stop()
    this.emit('status')
    return this.start(options)
  }

  // On Windows there is no SIGTERM: Node maps it to TerminateProcess, an immediate hard
  // kill (measured: tor died in 12 ms). So ask tor to shut itself down over the control
  // port first, wait a bounded time, and only then kill — and always wipe the folder.
  async _stop() {
    clearTimeout(this._watchdog)
    this.stopping = true
    this.ready = false
    const dir = this.dataDir // captured: after a restart this.dataDir is the new tor's
    const proc = this.proc
    const control = this.control
    this.control = null
    this.proc = null

    let graceful = false
    try {
      if (control) {
        // Bound it: tor exits as soon as it takes SHUTDOWN, and the reply may never
        // arrive if the socket dies mid-write. Awaiting that forever hangs the quit.
        await Promise.race([control.signal('SHUTDOWN').catch(() => {}), sleep(1200)])
        graceful = true
      } else if (!P.isWindows) P.signalTerminate(proc)
    } catch {}
    try { control?.close() } catch {}

    let exited = proc ? await P.waitForExit(proc, SHUTDOWN_GRACE_MS) : true
    if (!exited) {
      P.signalTerminate(proc)
      exited = await P.waitForExit(proc, SHUTDOWN_GRACE_MS)
    }
    if (!exited) {
      P.signalForce(proc)
      exited = await P.waitForExit(proc, SHUTDOWN_GRACE_MS)
      if (!exited) console.error('[tor] tor process is still alive after force kill; leaving its folder in place')
    }
    if (dir) this._wipe(dir, { torMayBeRunning: !exited })
    return { graceful, exited }
  }

  // tor may still be writing on its way out, and Windows antivirus or the indexer can
  // hold a file: retry with a bound and report, never swallow.
  _wipe(dir = this.dataDir, { torMayBeRunning = false } = {}) {
    if (!dir) return
    if (torMayBeRunning) {
      console.error(`[tor] not wiping ${dir}: tor may still be using it. It will be swept on next start.`)
      return
    }
    const r = P.removeTree(dir)
    this.cleanup = { ...(this.cleanup || {}), lastWipe: { dir, ok: r.ok, attempts: r.attempts, error: r.error?.message } }
    if (!r.ok) console.error(`[tor] FAILED to wipe ${dir} after ${r.attempts} attempts: ${r.error?.code || ''} ${r.error?.message || ''}`)
  }
}

function codeOf(proc) {
  return proc.exitCode != null ? proc.exitCode : proc.signalCode
}

module.exports = { TorManager, findTor, transportBinary, transportSpawn, ROOTS }
