// Builds Veil's application icon from its own palette — no image library, no network.
//
// The repo had no icon asset (only the docs wordmark, docs/images/logo.png, which is
// 1280x420 and unusable as an app icon), so the Windows installer had nothing to put on
// the .exe, the shortcuts or the uninstaller. This renders the same mark the UI uses —
// a light "V" with the red accent stroke on near-black — at every size Windows asks for.
//
//   node scripts/make-icon.js         # writes build/icon.ico and build/icon.png
//
// Colours are read from src/renderer/ui.css's dark palette so the icon cannot drift away
// from the app: --text #f3e6e6, --red #d8121b, body background #050405.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'build')

const BG_TOP = [0x12, 0x10, 0x12] // --frame-top (dark)
const BG_BOT = [0x05, 0x04, 0x05] // html,body background
const LIGHT = [0xf3, 0xe6, 0xe6] // --text
const RED = [0xd8, 0x12, 0x1b] // --red

// The "V": two slanted bars meeting at the bottom, in the logo's normalized box.
const LEFT = [[0.20, 0.22], [0.35, 0.22], [0.56, 0.80], [0.44, 0.80]]
const RIGHT = [[0.44, 0.80], [0.56, 0.80], [0.80, 0.22], [0.65, 0.22]]

const lerp = (a, b, t) => a + (b - a) * t
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v)

function inPolygon(x, y, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// Coverage of one shape over one pixel, by supersampling — enough AA for 16 px and 1024 px alike.
function coverage(x, y, size, shape, samples) {
  const step = 1 / samples
  let hit = 0
  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      const px = (x + (sx + 0.5) * step) / size
      const py = (y + (sy + 0.5) * step) / size
      if (inPolygon(px, py, shape)) hit++
    }
  }
  return hit / (samples * samples)
}

// Rounded square: signed distance to the corner arcs, feathered by one pixel.
function insideRoundedSquare(x, y, size, radiusPx) {
  const half = size / 2
  const cx = Math.abs(x + 0.5 - half)
  const cy = Math.abs(y + 0.5 - half)
  const r = radiusPx
  const dx = Math.max(cx - (half - r), 0)
  const dy = Math.max(cy - (half - r), 0)
  const d = Math.hypot(dx, dy) - r
  return clamp01(0.5 - d)
}

function render(size) {
  const samples = size >= 64 ? 3 : 4
  const radius = size * 0.22
  const rgba = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const bgT = y / (size - 1)
    const bg = [lerp(BG_TOP[0], BG_BOT[0], bgT), lerp(BG_TOP[1], BG_BOT[1], bgT), lerp(BG_TOP[2], BG_BOT[2], bgT)]
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const tile = insideRoundedSquare(x, y, size, radius)
      if (tile <= 0) continue // outside the rounded square: fully transparent
      let [r, g, b] = bg
      let a = tile
      // The light stroke first, then the red one on top of it, as in "Ve<i>l</i>".
      for (const [shape, col] of [[LEFT, LIGHT], [RIGHT, RED]]) {
        const c = coverage(x, y, size, shape, samples)
        if (c <= 0) continue
        r = lerp(r, col[0], c)
        g = lerp(g, col[1], c)
        b = lerp(b, col[2], c)
        a = Math.max(a, tile * c)
      }
      rgba[i] = Math.round(r)
      rgba[i + 1] = Math.round(g)
      rgba[i + 2] = Math.round(b)
      rgba[i + 3] = Math.round(a * 255)
    }
  }
  return rgba
}

// --- PNG ---------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function toPng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour + alpha
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --- ICO -------------------------------------------------------------
// A .ico is a directory of images; each one here is a 32-bit BGRA DIB with an AND mask.
// Windows accepts PNG-compressed entries, but the uncompressed form works on every version
// since 2000 and needs no assumption about the reader.
function toIcoEntry(size, rgba) {
  const dib = Buffer.alloc(40)
  dib.writeUInt32LE(40, 0) // biSize — a DIB header, not a BITMAPFILEHEADER
  dib.writeUInt32LE(size, 4)
  dib.writeInt32LE(size * 2, 8) // height counts the colour image plus the 1-bit mask
  dib.writeUInt16LE(1, 12) // planes
  dib.writeUInt16LE(32, 14) // bits per pixel
  dib.writeUInt32LE(0, 16) // BI_RGB
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = ((size - 1 - y) * size + x) * 4 // DIB rows go bottom-up
      const d = (y * size + x) * 4
      pixels[s] = rgba[d + 2]
      pixels[s + 1] = rgba[d + 1]
      pixels[s + 2] = rgba[d]
      pixels[s + 3] = rgba[d + 3]
    }
  }
  const maskRow = Math.ceil(size / 32) * 4
  const mask = Buffer.alloc(maskRow * size) // all zero: the alpha channel decides visibility
  dib.writeUInt32LE(pixels.length + mask.length, 20) // biSizeImage
  return Buffer.concat([dib, pixels, mask])
}

function toIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  const dir = Buffer.alloc(images.length * 16)
  let offset = 6 + images.length * 16
  images.forEach(({ size, data }, i) => {
    const e = dir.subarray(i * 16, i * 16 + 16)
    e[0] = size >= 256 ? 0 : size // 0 means 256
    e[1] = size >= 256 ? 0 : size
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
  })
  return Buffer.concat([header, dir, ...images.map(i => i.data)])
}

function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const sizes = [256, 48, 32, 24, 16]
  const images = sizes.map(size => ({ size, data: toIcoEntry(size, render(size)) }))
  const ico = path.join(OUT, 'icon.ico')
  fs.writeFileSync(ico, toIco(images))
  const png = path.join(OUT, 'icon.png')
  fs.writeFileSync(png, toPng(1024, render(1024)))
  console.log(`✓ ${path.relative(ROOT, ico)} (${sizes.join('/')} px, ${fs.statSync(ico).size} bytes)`)
  console.log(`✓ ${path.relative(ROOT, png)} (1024 px, ${fs.statSync(png).size} bytes)`)
}

if (require.main === module) main()
module.exports = { render, toPng, toIco, toIcoEntry }
