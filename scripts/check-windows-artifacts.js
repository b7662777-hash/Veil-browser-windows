// Artifact check for a Windows release build: both distributions must exist, be real x64
// PE files, carry Veil's metadata, and ship the runtime they claim to ship. Run it against
// the directory electron-builder wrote (default dist/).
//
// This is deliberately not a "the file is non-empty" test: the portable exe must not be a
// renamed installer, and the tor inside must be the Windows one with its GeoIP databases and
// licence texts next to it.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const dir = path.resolve(process.argv[2] || 'dist')
const problems = []
const note = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) problems.push(msg) }

const find = suffix => {
  if (!fs.existsSync(dir)) return null
  return fs.readdirSync(dir).filter(f => f.endsWith(suffix)).map(f => path.join(dir, f))[0] || null
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

// Machine type from the PE header: 0x8664 is amd64, 0x14c is the 32-bit one.
function peMachine(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const dos = Buffer.alloc(2)
    fs.readSync(fd, dos, 0, 2, 0)
    if (dos.toString('latin1') !== 'MZ') return { error: 'not an MZ file' }
    const head = Buffer.alloc(4)
    fs.readSync(fd, head, 0, 4, 60)
    const peOffset = head.readUInt32LE(0)
    const sig = Buffer.alloc(4)
    fs.readSync(fd, sig, 0, 4, peOffset)
    if (sig.toString('latin1') !== 'PE\0\0') return { error: 'missing PE signature' }
    const m = Buffer.alloc(2)
    fs.readSync(fd, m, 0, 2, peOffset + 4)
    const machine = m.readUInt16LE(0)
    return { machine, arch: machine === 0x8664 ? 'x64' : machine === 0x14c ? 'x86' : `0x${machine.toString(16)}` }
  } finally { fs.closeSync(fd) }
}

// What must be 64-bit: everything that actually runs as our app or as tor. The .exe files
// electron-builder produces for Windows are NSIS stubs, and NSIS is 32-bit by design — they
// start fine on Windows x64 and launch the 64-bit app inside. Demanding 0x8664 there would
// be demanding something that no Windows installer can satisfy.
const MUST_BE_X64 = [
  ['win-unpacked/Veil.exe', 'the application itself'],
  ['win-unpacked/resources/bin/win32-x64/tor.exe', 'the bundled tor'],
  ['win-unpacked/resources/bin/win32-x64/pluggable_transports/lyrebird.exe', 'the bridge transport'],
  ['win-unpacked/resources/bin/win32-x64/pluggable_transports/conjure-client.exe', 'the Snowflake client'],
]

const MB = f => (fs.statSync(f).size / 1048576).toFixed(1) + ' MB'
note(fs.existsSync(dir), `build directory ${dir}`)

const setup = find('-Windows-x64-Setup.exe')
const portable = find('-Windows-x64-Portable.exe')
note(!!setup, `NSIS installer present: ${setup || 'none'}${setup ? ' (' + MB(setup) + ')' : ''}`)
note(!!portable, `portable executable present: ${portable || 'none'}${portable ? ' (' + MB(portable) + ')' : ''}`)
if (setup && portable) {
  const [a, b] = [sha256(setup), sha256(portable)]
  note(a !== b, 'the portable build is not a copy of the installer')
  console.log(`  sha256 setup    ${a}\n  sha256 portable ${b}`)
}

for (const f of [setup, portable].filter(Boolean)) {
  const { arch, error } = peMachine(f)
  note(!error, `${path.basename(f)} is a Windows PE executable${error ? ` (${error})` : ` (NSIS stub, ${arch})`}`)
}

const unpacked = path.join(dir, 'win-unpacked')
if (fs.existsSync(unpacked)) {
  const res = path.join(unpacked, 'resources')
  note(fs.existsSync(path.join(res, 'app.asar')), 'the app itself is packed in app.asar')
  note(fs.existsSync(path.join(res, 'bin')), 'bin/ sits outside the asar, where it can be executed')
  const bundle = path.join(res, 'bin', 'win32-x64')
  for (const [what, file] of [
    ['tor.exe', 'tor.exe'],
    ['GeoIP (IPv4)', 'geoip'],
    ['GeoIP (IPv6)', 'geoip6'],
    ['pluggable transport', 'pluggable_transports/lyrebird.exe'],
    ['licences', 'licenses/tor.txt'],
    ['acquisition manifest', 'manifest.json'],
  ]) note(fs.existsSync(path.join(bundle, ...file.split('/'))), `${what} bundled: ${file}`)
  for (const [rel, what] of MUST_BE_X64) {
    const f = path.join(dir, rel.split('/').join(path.sep))
    if (!fs.existsSync(f)) { note(false, `${what} is missing at ${rel}`); continue }
    const { arch, error } = peMachine(f)
    note(!error && arch === 'x64', `${what} (${rel}) runs as x64${error ? `: ${error}` : ` — ${arch}`}`)
  }
  // A Unix executable copied in by mistake is the failure this port must never ship.
  for (const foreign of ['bin/darwin-arm64', 'bin/linux-x64']) {
    note(!fs.existsSync(path.join(res, foreign)), `${foreign} must not be inside a Windows build`)
  }
  const manifest = path.join(bundle, 'manifest.json')
  if (fs.existsSync(manifest)) {
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    const sig = m.signature || {}
    note(!!m.source, `tor came from ${m.source}`)
    note(sig.verified === true, `official signature verified: ${JSON.stringify(sig)}`)
    note(!!m.version, `tor bundle version ${m.version}`)
  }
}

// Auto-update metadata must describe the file that was actually built, or an updater would
// download one thing and verify another.
const latest = path.join(dir, 'latest.yml')
if (fs.existsSync(latest) && setup) {
  const y = fs.readFileSync(latest, 'utf8')
  note(y.includes(path.basename(setup)), `latest.yml names ${path.basename(setup)}`)
  const declared = (y.match(/sha512: (\S+)/) || [])[1]
  const actual = crypto.createHash('sha512').update(fs.readFileSync(setup)).digest('base64')
  note(declared === actual, `latest.yml sha512 matches the installer bytes (${(declared || '').slice(0, 12)}… vs ${actual.slice(0, 12)}…)`)
}

// Nothing that belongs to a developer's machine may end up in a release.
const stray = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter(f => /\.(log|tmp|lock)$/.test(f) || f === 'node_modules')
  : []
note(stray.length === 0, `no stray logs or caches in the release directory${stray.length ? ': ' + stray.join(', ') : ''}`)

const sums = find('SHA256SUMS.txt')
if (sums) {
  const lines = fs.readFileSync(sums, 'utf8').split(/\r?\n/).filter(Boolean)
  const byName = new Map(lines.map(l => [l.trim().split(/\s+/)[1], l.trim().split(/\s+/)[0]]))
  for (const f of [setup, portable].filter(Boolean)) {
    note(byName.get(path.basename(f)) === sha256(f), `SHA256SUMS.txt matches ${path.basename(f)}`)
  }
}

if (problems.length) {
  console.log(`\n${problems.length} artifact problem(s)`)
  process.exit(1)
}
console.log('\n✓ every Windows artifact is present, x64, and carries its runtime')
