// Cross-platform `electron` launcher for the npm scripts that need env vars.
//
// `VEIL_SELFTEST=1 electron .` is a POSIX shell feature: cmd and PowerShell read it
// as a command named "VEIL_SELFTEST=1". Setting the variables here keeps one script
// that works on macOS, Linux and Windows without adding a dependency.
//
//   node scripts/electron-run.js .                              # plain launch
//   node scripts/electron-run.js VEIL_SELFTEST=1 .              # self-test, hidden window
//   node scripts/electron-run.js VEIL_DEBUG=1 VEIL_SELFTEST=1 . # several vars
//
// The Electron binary comes from require('electron') — the path the npm package
// wrote at install time — so nothing here goes through a shell.
const { spawnSync } = require('child_process')

const argv = process.argv.slice(2)
const env = { ...process.env }
const args = []
for (const a of argv) {
  const i = a.indexOf('=')
  if (args.length === 0 && i > 0 && /^[A-Z_][A-Z0-9_]*$/.test(a.slice(0, i))) env[a.slice(0, i)] = a.slice(i + 1)
  else args.push(a)
}

let bin
try {
  bin = require('electron')
} catch {
  console.error('electron is not installed — run npm install first.')
  process.exit(1)
}
if (typeof bin !== 'string') {
  console.error(`require('electron') did not give a binary path (got ${typeof bin}).`)
  process.exit(1)
}

const r = spawnSync(bin, args, { stdio: 'inherit', env })
if (r.error) { console.error(r.error.message); process.exit(1) }
// Ctrl+C kills Electron; report that as 130 rather than pretending it crashed.
process.exit(r.signal ? 128 : r.status)
