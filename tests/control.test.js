// The control protocol client, tested against a server that speaks exactly the bytes real
// tor sent on this machine (captured with _research/probe-control-replies.js and
// probe-stream-status.js) — including the \r\n line endings Windows tor uses.
const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { TorControl } = require('../src/main/control')

const FP1 = '336694735E61C8B0B6D63CC48F78BB7A312BC829'
const FP2 = '133BBDA007B04F3EF3BAFEF9DE204425984CA841'
const FP3 = '5424110BF0524432D80605090638D9CA63689BAC'
const CIRCUIT_STATUS = [
  '250+circuit-status=\r\n',
  `1 BUILT $${FP1}~muffintop,$${FP2}~DemonHunter,$${FP3}~TorNode02 PURPOSE=GENERAL TIME_CREATED=2026-11-01T12:09:45.107839 SOCKS_USERNAME="example.com" SOCKS_PASSWORD="nonce1:0"\r\n`,
  '2 EXTENDED BUILD_FLAGS=NEED_CAPACITY PURPOSE=GENERAL TIME_CREATED=2026-11-01T12:09:52.391931\r\n',
  '..this line was dot-stuffed by tor\r\n',
  `3 BUILT $${FP1}~muffintop,$${FP2}~DemonHunter,$${FP3}~TorNode02 PURPOSE=GENERAL TIME_CREATED=2026-11-01T12:09:59.000000 SOCKS_USERNAME="example.com" SOCKS_PASSWORD="nonce1:0"\r\n`,
  '.\r\n250 OK\r\n',
].join('')

const descriptor = (fp, nick, ip) => [
  `250+ns/id/${fp}=\r\n`,
  `r ${nick} hHDqs2UkyngZieFfBMprj1IyZVQ wBioyn0dZvmyweNVK6MMT9JjcBs 2038-01-01 00:00:00 ${ip} 443 0\r\n`,
  's Fast HSDir Running Stable V2Dir Valid\r\n',
  'w Bandwidth=32000\r\n',
  '.\r\n250 OK\r\n',
].join('')

// tor's real stream-status layout: STREAMID STATUS CIRCUITID TARGET
const STREAM_STATUS = '250-stream-status=63 SUCCEEDED 1 [2606:4700:10::ac42:93f3]:443\r\n250 OK\r\n'

function route(line) {
  if (line.startsWith('AUTHENTICATE ')) return line === 'AUTHENTICATE deadbeef' ? '250 OK\r\n' : '515 Invalid cookie\r\n'
  if (line === 'TAKEOWNERSHIP') return '250 OK\r\n'
  if (line === 'SIGNAL NEWNYM' || line === 'SIGNAL SHUTDOWN') return '250 OK\r\n'
  if (line === 'GETINFO version') return '250-version=0.4.9.15 (git-4d8efff53a86670b)\r\n250 OK\r\n'
  if (line === 'GETINFO circuit-status') return CIRCUIT_STATUS
  if (line === 'GETINFO stream-status') return STREAM_STATUS
  if (line === 'GETINFO traffic/read') return '250-traffic/read=123456\r\n250 OK\r\n'
  if (line === 'GETINFO traffic/written') return '250-traffic/written=654321\r\n250 OK\r\n'
  if (line.startsWith('GETINFO ns/id/')) {
    const fp = line.slice('GETINFO ns/id/'.length)
    const table = { [FP1]: ['muffintop', '179.43.134.242'], [FP2]: ['DemonHunter', '5.6.7.8'], [FP3]: ['TorNode02', '9.10.11.12'] }
    if (!table[fp]) return '552 Unrecognized key\r\n'
    return descriptor(fp, table[fp][0], table[fp][1])
  }
  if (line.startsWith('GETINFO ip-to-country/')) {
    const ip = line.slice('GETINFO ip-to-country/'.length)
    const map = { '179.43.134.242': 'ch', '5.6.7.8': 'de', '9.10.11.12': 'nl' }
    return map[ip] ? `250-ip-to-country/${ip}=${map[ip]}\r\n250 OK\r\n` : `250-ip-to-country/${ip}=??\r\n250 OK\r\n`
  }
  return '501 Unknown command\r\n'
}

function fakeControl({ chunkSize = Infinity, events = [], seen = [] } = {}) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(sock => {
      let buf = ''
      sock.setEncoding('utf8')
      sock.on('error', () => {})
      const write = text => {
        if (!isFinite(chunkSize) || text.length <= chunkSize) return sock.write(text)
        let i = 0
        const step = () => {
          if (i >= text.length || !sock.writable) return
          sock.write(text.slice(i, i + chunkSize))
          i += chunkSize
          setTimeout(step, 1)
        }
        step()
      }
      sock.on('data', d => {
        buf += d
        let i
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 2)
          seen.push(line)
          if (line.startsWith('GETINFO circuit-status')) {
            for (const e of events) write(e) // async events arrive between the reply lines
            write(CIRCUIT_STATUS)
            continue
          }
          const reply = route(line)
          if (reply) write(reply)
        }
      })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }))
  })
}

const cookie = Buffer.from('deadbeef', 'hex')

async function connected(options = {}) {
  const srv = await fakeControl(options)
  const control = new TorControl()
  await control.connect(srv.port, cookie)
  return { srv, control }
}

const closeAll = async ({ srv, control }) => {
  control.close()
  srv.server.closeAllConnections?.()
  await new Promise(res => srv.server.close(res))
}

test('the first thing sent is the cookie, then ownership as ADR 0002 requires', async () => {
  const pair = await connected()
  try {
    assert.equal(pair.srv.seen[0], `AUTHENTICATE ${cookie.toString('hex')}`)
    await pair.control.command('TAKEOWNERSHIP')
    assert.deepEqual(pair.srv.seen.slice(1), ['TAKEOWNERSHIP'])
  } finally { await closeAll(pair) }
})

test('a wrong cookie fails the connection and does not leave the socket open', async () => {
  const srv = await fakeControl()
  const control = new TorControl()
  await assert.rejects(() => control.connect(srv.port, Buffer.from('cafebabe', 'hex')), /515/)
  assert.equal(control.sock.destroyed, true, 'a control socket that never authenticated is no use to anyone')
  await assert.rejects(() => control.command('GETINFO version'), /control socket is closed/)
  srv.server.closeAllConnections?.()
  await new Promise(res => srv.server.close(res))
})

test('single-line GETINFO replies lose neither the value nor the terminator', async () => {
  const pair = await connected()
  try {
    assert.equal(await pair.control.getinfo('version'), '0.4.9.15 (git-4d8efff53a86670b)')
    assert.equal(await pair.control.getinfo('ip-to-country/179.43.134.242'), 'ch')
    assert.equal(await pair.control.getinfo('ip-to-country/0.0.0.0'), '??')
  } finally { await closeAll(pair) }
})

test('multi-line replies: the key line, the data, the dot-stuffed line and the OK', async () => {
  const pair = await connected()
  try {
    const status = await pair.control.getinfo('circuit-status')
    const lines = status.split('\n')
    assert.equal(lines.length, 4)
    assert.ok(lines[0].startsWith('1 BUILT '), lines[0])
    assert.equal(lines[2], '.this line was dot-stuffed by tor', 'a leading .. means one literal .')
    assert.ok(!lines.some(l => l === 'OK' || l.startsWith('circuit-status=')), 'framing lines are not data')
  } finally { await closeAll(pair) }
})

test('a reply split into 7-byte pieces across the socket still parses', async () => {
  // Windows tor writes \r\n-terminated lines; a \r and its \n can land in different reads.
  const pair = await connected({ chunkSize: 7 })
  try {
    assert.equal(await pair.control.getinfo('version'), '0.4.9.15 (git-4d8efff53a86670b)')
    const status = await pair.control.getinfo('circuit-status')
    assert.equal(status.split('\n').length, 4)
    const ns = await pair.control.getinfo(`ns/id/${FP1}`)
    assert.ok(ns.startsWith('r muffintop '), ns.slice(0, 40))
  } finally { await closeAll(pair) }
})

test('an async 650 event between commands is not mistaken for a reply', async () => {
  const pair = await connected({ events: ['650 NOTICE Tor is initializing\r\n'] })
  try {
    assert.equal(await pair.control.getinfo('circuit-status').then(s => s.split('\n').length), 4)
    assert.equal(await pair.control.getinfo('version'), '0.4.9.15 (git-4d8efff53a86670b)')
  } finally { await closeAll(pair) }
})

test('two commands in flight are answered in order', async () => {
  const pair = await connected()
  try {
    const [version, status] = await Promise.all([
      pair.control.command('GETINFO version'),
      pair.control.command('GETINFO stream-status'),
    ])
    assert.ok(version[0].startsWith('version='), JSON.stringify(version))
    assert.ok(status[0].startsWith('stream-status='), JSON.stringify(status))
  } finally { await closeAll(pair) }
})

test('an error reply rejects the command that caused it', async () => {
  const pair = await connected()
  try {
    await assert.rejects(() => pair.control.command('GETINFO ns/id/DEADBEEF'), /552/)
    await assert.rejects(() => pair.control.command('FROBNICATE'), /501/)
    // the connection survives it: the next command still works
    assert.equal(await pair.control.getinfo('version'), '0.4.9.15 (git-4d8efff53a86670b)')
  } finally { await closeAll(pair) }
})

test('a command on a dead socket is refused at once instead of hanging the quit (R16)', async () => {
  const pair = await connected()
  pair.control.close()
  await assert.rejects(() => pair.control.signal('SHUTDOWN'), /control socket is closed/)
  await assert.rejects(() => pair.control.command('GETINFO version'), /control socket is closed/)
  pair.srv.server.closeAllConnections?.()
  await new Promise(res => pair.srv.server.close(res))
})

test('a command already queued when tor dies is rejected, not left pending forever', async () => {
  const srv = await fakeControl({ chunkSize: Infinity })
  const control = new TorControl()
  await control.connect(srv.port, cookie)
  // Ask for something this fake does not answer, then drop the connection underneath it.
  const pending = control.command('GETINFO never-answered')
  control.sock.destroy()
  await assert.rejects(() => pending, /control connection closed/)
  srv.server.closeAllConnections?.()
  await new Promise(res => srv.server.close(res))
})

test('circuitFor picks the built circuit carrying these credentials and names its hops', async () => {
  const pair = await connected()
  try {
    const circuit = await pair.control.circuitFor('example.com', 'nonce1:0')
    assert.equal(circuit.id, '3', 'the newest matching circuit wins')
    assert.equal(circuit.purpose, 'GENERAL')
    assert.deepEqual(circuit.hops.map(h => h.nickname), ['muffintop', 'DemonHunter', 'TorNode02'])
    assert.deepEqual(circuit.hops.map(h => h.country), ['ch', 'de', 'nl'])
    assert.equal(circuit.hops[0].ip, '179.43.134.242')
    assert.equal(circuit.hops[0].fingerprint, FP1)
    assert.equal(await pair.control.circuitFor('other.org', 'nonce1:0'), null,
      'a site with no circuit of its own must not be shown someone else\'s')
  } finally { await closeAll(pair) }
})

test('streamsOn reads tor\'s real field order: id, state, circuit, target', async () => {
  const pair = await connected()
  try {
    assert.deepEqual(await pair.control.streamsOn('1'),
      [{ id: '63', state: 'SUCCEEDED', target: '[2606:4700:10::ac42:93f3]:443' }])
    assert.deepEqual(await pair.control.streamsOn('99'), [])
  } finally { await closeAll(pair) }
})

test('traffic counters come back as numbers for the routing page', async () => {
  const pair = await connected()
  try {
    assert.deepEqual(await pair.control.traffic(), { read: 123456, written: 654321 })
  } finally { await closeAll(pair) }
})
