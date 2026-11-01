// node scripts/release-evidence.js [distDir] — writes SHA256SUMS.txt and SBOM.json beside the
// built apps, from the bytes that are actually there. The published hashes are therefore the
// hashes of the files that get uploaded, not of whatever the build log remembered.
//
//   npm run release:evidence            veil-dist/
//   node scripts/release-evidence.js dist
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const distDir = path.resolve(root, process.argv[2] || 'veil-dist')
const pkg = require(path.join(root, 'package.json'))

const sha256 = file => {
  const h = crypto.createHash('sha256')
  h.update(fs.readFileSync(file))
  return h.digest('hex')
}
const sizeOf = file => fs.statSync(file).size

function licenseOf(name) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'))
    if (typeof j.license === 'string') return j.license
    if (j.license && j.license.type) return j.license.type
  } catch {}
  return null
}

// Every package the lockfile pins, including the transitive ones that end up inside app.asar.
function npmComponents() {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  const direct = Object.keys(pkg.dependencies || {})
  const out = []
  for (const [key, entry] of Object.entries(lock.packages || {})) {
    if (!key.startsWith('node_modules/') || !entry.version) continue
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)
    const license = licenseOf(name)
    out.push({
      type: 'library',
      name,
      version: entry.version,
      purl: `pkg:npm/${name.replace(/#/g, '%23')}@${entry.version}`,
      ...(license ? { licenses: [{ license: { id: license } }] } : {}),
      // Only the two direct deps are named in package.json; the rest arrive as their
      // requirements. Everything the lockfile marks dev never reaches a user's machine as an npm
      // package — electron does, but as the runtime, recorded separately below.
      scope: entry.dev ? 'excluded' : direct.includes(name) ? 'required' : 'optional',
    })
  }
  return out
}

// The tor expert bundle: its own manifest records where it came from, whether the signature was
// verified, and the hash of every file that ships. Republished here instead of re-deriving it,
// so the SBOM says what the fetch step actually proved.
function torComponents(bundleKey) {
  const manifestPath = path.join(root, 'bin', bundleKey, 'manifest.json')
  if (!fs.existsSync(manifestPath)) return []
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const entries = Object.entries(m.artifacts || {})
  return [{
    type: 'platform',
    name: 'tor',
    version: m.torVersion || m.version,
    purl: `pkg:generic/tor@${m.torVersion || m.version}`,
    description: `Tor daemon and pluggable transports from ${m.source}`,
    licenses: Object.entries(m.licenses || {})
      .filter(([k]) => k !== 'texts_in')
      .map(([component, license]) => ({ component, license })),
    hash: m.archive && m.archive.sha256 ? `SHA-256:${m.archive.sha256}` : null,
    signatureVerified: !!(m.signature && m.signature.verified),
    signature: m.signature || null,
    acquiredAt: m.acquiredAt,
    vendorFiles: entries.map(([file, a]) => ({
      file, bytes: a.bytes, sha256: a.sha256,
      // Re-hash what is on disk now; the manifest is the acquisition record, not a guarantee
      // that nobody touched the tree afterwards.
      matchesDisk: fs.existsSync(path.join(root, 'bin', bundleKey, file))
        && sha256(path.join(root, 'bin', bundleKey, file)) === a.sha256,
    })),
  }]
}

function vendoredAssets() {
  const out = []
  const engine = path.join(root, 'assets', 'adblock.engine')
  if (fs.existsSync(engine)) {
    out.push({
      type: 'data',
      name: 'adblock.engine',
      version: fs.statSync(engine).mtime.toISOString().slice(0, 10),
      description: 'Precompiled EasyList + EasyPrivacy + uBlock filter engine, built by scripts/adblock-update.js',
      licenses: [{ note: 'filter lists are used under their own terms (easylist.to, uBlock Origin); Veil ships a derived compiled engine, not the source lists' }],
      sha256: sha256(engine),
      bytes: sizeOf(engine),
    })
  }
  for (const f of fs.existsSync(path.join(root, 'assets/fonts')) ? fs.readdirSync(path.join(root, 'assets/fonts')) : []) {
    if (!/\.(ttf|otf)$/i.test(f)) continue
    out.push({
      type: 'font', name: f,
      licenses: [{ license: { id: 'OFL-1.1', url: 'https://openfontlicense.org/' } }],
      sha256: sha256(path.join(root, 'assets/fonts', f)),
      bytes: sizeOf(path.join(root, 'assets/fonts', f)),
    })
  }
  return out
}

const RELEASE_FILES = [
  'Veil-1.0.0-Windows-x64-Setup.exe',
  'Veil-1.0.0-Windows-x64-Portable.exe',
]

const sbomPath = path.join(distDir, 'SBOM.json')
const sumsPath = path.join(distDir, 'SHA256SUMS.txt')

if (!fs.existsSync(distDir)) {
  console.error(`no build directory at ${distDir} — run npm run dist (or electron-builder --win) first`)
  process.exit(1)
}

// Only files that are really present, so a partial build cannot be reported as a complete release.
const present = RELEASE_FILES.filter(f => fs.existsSync(path.join(distDir, f)))
const files = present.map(f => ({ name: f, sha256: sha256(path.join(distDir, f)), bytes: sizeOf(path.join(distDir, f)) }))

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: 'Veil', name: 'scripts/release-evidence.js', version: pkg.version }],
    component: {
      type: 'application',
      name: 'Veil',
      version: pkg.version,
      purl: `pkg:generic/veil@${pkg.version}`,
      description: pkg.description,
      licenses: [{ license: { id: pkg.license } }],
      properties: [{ name: 'releaseChannel', value: 'github-release' }],
    },
  },
  components: [
    {
      type: 'platform',
      name: 'electron',
      version: (() => { try { return require(path.join(root, 'node_modules/electron/package.json')).version } catch { return null } })(),
      purl: `pkg:npm/electron@${(() => { try { return require(path.join(root, 'node_modules/electron/package.json')).version } catch { return 'unknown' } })()}`,
      licenses: [{ license: { id: 'MIT' } }],
      scope: 'required',
      description: 'Chromium + Node runtime the browser is built on; ships inside the app',
    },
    ...npmComponents(),
    ...torComponents('win32-x64'),
    ...vendoredAssets(),
    ...files.map(f => ({
      type: 'file',
      name: f.name,
      version: pkg.version,
      sha256: f.sha256,
      bytes: f.bytes,
      description: 'Published Windows distribution',
    })),
  ],
}

fs.writeFileSync(sumsPath, files.map(f => `${f.sha256}  ${f.name}`).join('\n') + '\n')
fs.writeFileSync(sbomPath, JSON.stringify(sbom, null, 2) + '\n')

console.log(`wrote ${sumsPath}`)
for (const f of files) console.log(`  ${f.sha256}  ${f.name}  (${(f.bytes / 1048576).toFixed(1)} MB)`)
console.log(`wrote ${sbomPath} — ${sbom.components.length} components`)
if (present.length !== RELEASE_FILES.length) {
  console.error(`!! only ${present.length} of ${RELEASE_FILES.length} release files were found; the evidence above covers those and no more`)
  process.exit(1)
}
