// Creates the community signing keypair. Keep community.key secret.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const P = require('../src/main/platform') // no Electron in platform.js, so a script can use it

const dir = path.join(__dirname, '..', 'community')
const keyFile = path.join(dir, 'community.key')
if (fs.existsSync(keyFile)) {
  console.error('community.key already exists — refusing to overwrite')
  process.exit(1)
}
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
fs.writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
// NTFS ignores that mode, which would leave the signing key readable by everyone who can
// read the checkout. An explicit ACL is the only way to mean "owner only" on Windows.
const prot = P.protectFile(keyFile)
if (!prot.ok) console.warn(`could not restrict ${keyFile}: ${prot.error?.message} — set permissions by hand before using this key`)
fs.writeFileSync(path.join(dir, 'community.pub.pem'), publicKey.export({ format: 'pem', type: 'spki' }))
console.log('Wrote community/community.key (secret) and community/community.pub.pem')
