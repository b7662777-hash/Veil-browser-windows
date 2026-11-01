// npm run bridges:setup — get the pluggable-transport binaries Veil needs, for *this*
// platform, from either the official signed artifact or a Tor Browser already installed
// here. Homebrew/apt do not package lyrebird, so a build without this step cannot use
// bridges at all.
//
//   node scripts/bridges-setup.js                 copy from a Tor Browser found locally
//   node scripts/bridges-setup.js <path|dir|.app> copy from a specific Tor Browser
//   node scripts/bridges-setup.js --check         verify what is already in bin/
//
// Nothing is recorded as available until the binary has actually been executed here,
// which is what catches a Unix binary copied onto Windows (or vice versa).
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const KEY = `${process.platform}-${process.arch}`
const BUNDLE = path.join(ROOT, 'bin', KEY)
const PT_DIR = path.join(BUNDLE, 'pluggable_transports')
const MANIFEST = path.join(BUNDLE, 'manifest.json')
const TRANSPORTS = ['lyrebird', 'conjure-client']

const isWin = process.platform === 'win32'
const exe = n => (isWin && !/\.exe$/i.test(n) ? n + '.exe' : n)

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }

// Tor Browser's own layout, per platform.
function torBrowserRoots(arg) {
  const home = os.homedir()
  const list = [
    arg,
    ...['Tor Browser', 'tor-browser', 'tor-browser_en-US'].map(n => path.join(home, 'Desktop', n)),
    ...['Tor Browser', 'tor-browser'].map(n => path.join(home, n)),
  ].filter(Boolean)
  if (process.platform === 'darwin') list.push('/Applications/Tor Browser.app', path.join(home, 'Applications/Tor Browser.app'))
  if (isWin) list.push('C:\\Program Files\\Tor Browser', path.join(process.env.LOCALAPPDATA || '', 'Tor Browser'))
  if (process.platform === 'linux') list.push('/opt/tor-browser', path.join(home, 'tor-browser_en-US'))
  return list
}

// Inside a Tor Browser install, where are the PT binaries and their licence texts?
const LAYOUTS = [
  p => [path.join(p, 'Browser', 'TorBrowser', 'Tor', 'PluggableTransports'), path.join(p, 'Browser', 'TorBrowser', 'Docs', 'Licenses')],
  p => [path.join(p, 'Contents', 'MacOS', 'Tor', 'PluggableTransports'), path.join(p, 'Contents', 'Resources', 'TorBrowser', 'Docs', 'Licenses')],
  p => [p, path.join(path.dirname(p), '..', 'Docs', 'Licenses')], // the PluggableTransports dir passed directly
]

function findSource(arg) {
  for (const root of torBrowserRoots(arg)) {
    for (const layout of LAYOUTS) {
      const [ptDir, docDir] = layout(root)
      const hit = TRANSPORTS.map(n => path.join(ptDir, exe(n))).find(p => fs.existsSync(p))
      if (hit) return { ptDir, docDir, name: root }
    }
  }
  return null
}

// Runs the binary the way Veil will: as a child process on this machine.
function executes(file) {
  const r = spawnSync(file, ['--help'], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
  if (r.error) return { ok: false, why: r.error.code === 'ENOENT' ? 'not an executable this OS can load' : r.error.message }
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim()
  // A PT client started without tor's managed-proxy environment exits non-zero or waits;
  // either way, reaching that point proves the image loaded.
  if (/error while loading|cannot execute|not a valid Win32|ENOEXEC/i.test(out)) return { ok: false, why: out.split('\n')[0] }
  return { ok: true, note: out.split('\n')[0].slice(0, 90) || `exit ${r.status}` }
}

function updateManifest(entry) {
  const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {}
  manifest.artifacts = manifest.artifacts || {}
  manifest.artifacts[entry.artifact] = { name: entry.artifact, bytes: entry.bytes, sha256: entry.sha256 }
  manifest.transports = manifest.transports || {}
  manifest.transports[entry.name] = entry
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2))
}

function checkOne(name) {
  const file = path.join(PT_DIR, exe(name))
  if (!fs.existsSync(file)) return { name, state: 'missing' }
  const r = executes(file)
  return { name, state: r.ok ? 'ok' : 'broken', file, sha256: sha256(file), detail: r.ok ? r.note : r.why }
}

function reportCheck() {
  const rows = TRANSPORTS.map(checkOne)
  for (const r of rows) console.log(`${r.state === 'ok' ? '✓' : r.state === 'missing' ? '·' : '✗'} ${r.name}: ${r.state}${r.file ? ` (${path.relative(ROOT, r.file)})` : ''}${r.detail ? ` — ${r.detail}` : ''}`)
  const usable = rows.filter(r => r.state === 'ok').map(r => r.name)
  if (!usable.length) {
    console.error('\nNo usable transport. Run: npm run tor:fetch   (official signed download)')
    process.exit(1)
  }
  console.log(`\nUsable here: ${usable.join(', ')} — bridges can be configured in Veil's Connection settings.`)
  if (!usable.includes('lyrebird')) console.warn('! lyrebird is not usable: obfs4/Snowflake/meek/webtunnel bridges will be refused.')
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--check')) return reportCheck()

  const src = findSource(argv[0])
  if (!src) {
    console.error(`No Tor Browser install found${argv[0] ? ` at ${argv[0]}` : ''}.`)
    console.error('Install Tor Browser, pass its path, or run: npm run tor:fetch')
    process.exit(1)
  }
  fs.mkdirSync(PT_DIR, { recursive: true })
  console.log(`Tor Browser found at ${src.name}`)

  let copied = 0
  for (const name of TRANSPORTS) {
    const from = path.join(src.ptDir, exe(name))
    if (!fs.existsSync(from)) { console.log(`· ${name}: not present in this Tor Browser`); continue }
    const to = path.join(PT_DIR, exe(name))
    fs.copyFileSync(from, to)
    if (!isWin) fs.chmodSync(to, (fs.statSync(from).mode & 0o777) || 0o755)
    const r = executes(to)
    if (!r.ok) {
      fs.rmSync(to, { force: true })
      console.error(`✗ ${name}: copied but will NOT run here (${r.why}). Removed — Veil will not ship a binary this OS cannot load.`)
      continue
    }
    const artifact = path.relative(BUNDLE, to).split(path.sep).join('/')
    updateManifest({
      name, artifact, bytes: fs.statSync(to).size, sha256: sha256(to),
      source: `local Tor Browser copy: ${from}`, acquiredAt: new Date().toISOString(),
      signature: { verified: false, note: 'copied from an installed Tor Browser; run npm run tor:fetch for a signature-verified copy' },
      executedHere: true, executeDetail: r.note,
    })
    console.log(`✓ ${name} -> ${path.relative(ROOT, to)} (${r.note})`)
    copied++
  }

  // Keep the licence text with the binary it covers, as the Tor Project ships it.
  if (fs.existsSync(src.docDir)) {
    const dest = path.join(BUNDLE, 'licenses')
    fs.mkdirSync(dest, { recursive: true })
    for (const n of TRANSPORTS) {
      const lic = path.join(src.docDir, `${n}.txt`)
      if (fs.existsSync(lic)) fs.copyFileSync(lic, path.join(dest, `${n}.txt`))
    }
  }

  if (!copied) { console.error('\nNothing usable was installed.'); process.exit(1) }
  console.log(`\n${copied} transport(s) ready for ${KEY}. Veil reads them from ${path.relative(ROOT, PT_DIR)}.`)
}

main()
