// How Veil hands tor a pluggable transport, and what it refuses to do when it can't.
// These run everywhere: the fail-closed paths need no network, and the path arithmetic
// needs no tor — only the two assertions marked as machine-dependent look at bin/.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { TorManager, findTor, transportBinary, transportSpawn, ROOTS } = require('../src/main/tor')
const P = require('../src/main/platform')

test('the transport is started with a relative path and a cwd Veil controls (R11)', () => {
  // An install root with a space and a non-ASCII letter, exactly like
  // C:\Program Files\Vèil Browser — what tor is handed must still contain neither.
  const install = path.join(os.tmpdir(), 'Vèil Browser', 'bin', P.bundleKey())
  const exe = path.join(install, 'pluggable_transports', P.executableName('lyrebird'))
  const spawn = transportSpawn(exe)
  assert.equal(spawn.cwd, install)
  assert.equal(spawn.rel, 'pluggable_transports/' + P.executableName('lyrebird'))
  assert.ok(!/[\s"]/.test(spawn.rel), 'tor splits the exec value on whitespace: no space may survive')
  assert.ok(!spawn.rel.includes(path.sep), `the exec value must be slash-separated, not ${spawn.rel}`)
})

test('a transport directory Veil does not control is refused, not quoted and hoped for', () => {
  // Measured: quotes do not protect a path — tor splits ClientTransportPlugin on whitespace.
  const spaced = path.join(os.tmpdir(), 'pluggable transports', P.executableName('lyrebird'))
  assert.equal(transportSpawn(spaced), null)
  assert.equal(transportSpawn(null), null)
})

test('the binary Veil would run is one this machine can actually run', () => {
  const found = findTor()
  if (!found.path) {
    // Nothing bundled and nothing installed: that is a legitimate state for a fresh clone,
    // and the message has to tell the developer what to do about it.
    assert.match(P.describeTorInstallError(found.tried), /No usable tor executable found/)
    return
  }
  assert.ok(P.isExecutable(found.path), found.path)
  assert.equal(path.basename(found.path), P.executableName('tor'))
  assert.ok(!found.path.includes('win32') || P.isWindows, 'a Windows binary on a Unix host')
  assert.ok(!P.isWindows || /\btor\.exe$/i.test(found.path), 'tor on Windows must be a .exe')
  if (found.source === 'bundled') {
    assert.ok(found.path.includes(path.join('bin', P.bundleKey())), `${found.path} is not in this platform's bundle`)
  }
})

test('a bundled lyrebird, if present, is executable and lives in this platform\'s bundle', () => {
  const lyr = transportBinary('lyrebird')
  if (!lyr) {
    assert.ok(true, 'no transport on this machine: bridges will be reported unavailable, not assumed')
    return
  }
  assert.ok(P.isExecutable(lyr), lyr)
  assert.ok(lyr.includes(P.bundleKey()) || lyr.includes('pluggable_transports'), lyr)
  assert.ok(!!transportSpawn(lyr), 'the found transport must be expressible in a torrc line')
})

test('VEIL_LYREBIRD replaces the bundle, and a bad override is refused out loud', () => {
  const warnings = []
  const warn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const missing = path.join(os.tmpdir(), 'not-a-transport-xyz')
    process.env.VEIL_LYREBIRD = missing
    assert.equal(transportBinary('lyrebird'), null)
    assert.match(warnings.join('\n'), /VEIL_LYREBIRD/, 'silently ignoring an override the user set is how support tickets start')
  } finally {
    delete process.env.VEIL_LYREBIRD
    console.warn = warn
  }
})

test('a bridge setting with no bridge lines refuses to connect at all — no silent direct fallback', async () => {
  const tor = new TorManager()
  try {
    await tor.start({ requireBridge: true, bridges: [], mode: 'snowflake' })
    assert.equal(tor.ready, false)
    assert.ok(!tor.proc, 'tor must not even be spawned')
    assert.equal(tor.dataDir, undefined, 'and no data directory may be created')
    assert.match(String(tor.error), /bridge/i)
    assert.match(String(tor.error), /not connecting directly|would put your traffic/i)
    assert.match(String(tor.error), /snowflake/)
  } finally { await tor.stop() }
})

test('an empty custom bridge list is a broken configuration, not permission to go direct', async () => {
  const tor = new TorManager()
  try {
    await tor.start({ requireBridge: true, bridges: [], mode: 'custom' })
    assert.equal(tor.ready, false)
    assert.ok(!tor.proc, 'tor must not be spawned for an empty custom bridge list either')
    assert.match(String(tor.summary), /no bridge lines/i)
  } finally { await tor.stop() }
})

test('ROOTS covers the development tree', () => {
  assert.ok(ROOTS.some(r => fs.existsSync(path.join(r, 'package.json'))), 'expected the repo root among ' + ROOTS.join(', '))
})
