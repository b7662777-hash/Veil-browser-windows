// Per-site circuit isolation (ADR 0003) and the SOCKS5 handshake, tested against a fake
// tor SOCKS endpoint that records exactly which credentials each site presents.
const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { IsolationRelay } = require('../src/main/relay')

const OPTIONS = { timeout: 15000 }

// A stand-in for tor's SOCKS5 server with username/password isolation and ExtendedErrors.
function fakeTor({ replyCode = 0x00, accept = null } = {}) {
  return new Promise((resolve, reject) => {
    const connections = []
    const server = net.createServer(sock => {
      const conn = { credentials: null, target: null, cmd: null, data: [] }
      connections.push(conn)
      sock.on('error', () => {})
      sock.on('close', () => { conn.closed = true })
      let buf = Buffer.alloc(0)
      let stage = 0
      const onData = d => {
        buf = Buffer.concat([buf, d])
        for (;;) {
          if (stage === 0) { // method selection
            if (buf.length < 2) return
            const n = buf[1]
            if (buf.length < 2 + n) return
            conn.offered = [...buf.subarray(0, 2 + n)]
            buf = buf.subarray(2 + n)
            sock.write(Buffer.from([0x05, 0x02])) // insist on username/password
            stage = 1
          } else if (stage === 1) { // subnegotiation: VER ULEN USER PLEN PASS
            if (buf.length < 2) return
            const ulen = buf[1]
            if (buf.length < 2 + ulen + 1) return
            const plen = buf[2 + ulen]
            if (buf.length < 3 + ulen + plen) return
            conn.credentials = {
              username: buf.subarray(2, 2 + ulen).toString(),
              password: buf.subarray(3 + ulen, 3 + ulen + plen).toString(),
            }
            buf = buf.subarray(3 + ulen + plen)
            const ok = !accept || accept(conn.credentials)
            sock.write(Buffer.from([0x01, ok ? 0x00 : 0xff]))
            if (!ok) { conn.refused = true; sock.end(); stage = 9; return }
            stage = 2
          } else if (stage === 2) { // request: VER CMD RSV ATYP ADDR PORT
            if (buf.length < 4) return
            const atyp = buf[3]
            let need
            if (atyp === 1) need = 10
            else if (atyp === 4) need = 22
            else if (atyp === 3) { if (buf.length < 5) return; need = 5 + buf[4] + 2 }
            else { conn.badAddress = true; sock.end(); stage = 9; return }
            if (buf.length < need) return
            const body = buf.subarray(4, need)
            const port = (body[body.length - 2] << 8) | body[body.length - 1]
            conn.cmd = buf[1]
            conn.target = atyp === 3
              ? `${body.subarray(1, body.length - 2).toString('utf8')}:${port}`
              : `${[...body.subarray(0, 4)].join('.')}:${port}`
            buf = buf.subarray(need)
            sock.write(Buffer.from([0x05, replyCode, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
            stage = 3
            sock.off('data', onData)
            if (buf.length) conn.data.push(buf)
            sock.on('data', chunk => { conn.data.push(chunk); sock.write(Buffer.from(chunk.toString().toUpperCase())) })
          } else return
        }
      }
      sock.on('data', onData)
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, connections }))
  })
}

// Speak SOCKS5 the way Chromium does: the local end offers no authentication.
// The reply stream is [05 00] for the method selection, then the 10-byte connect reply,
// and the two may arrive coalesced or apart — so index the concatenated bytes, not events.
async function through(relayPort, { cmd = 0x01, target = 'example.com' } = {}) {
  const client = net.connect(relayPort, '127.0.0.1')
  await new Promise((res, rej) => { client.once('connect', res); client.once('error', rej) })
  const chunks = []
  client.on('data', d => chunks.push(d))
  const on = event => new Promise(res => (client.destroyed ? res() : client.once(event, res)))
  const bytes = () => Buffer.concat(chunks)
  const have = n => new Promise(res => {
    const tick = () => (bytes().length >= n ? res(true) : setTimeout(tick, 20))
    tick()
  })
  const host = Buffer.from(target)
  client.write(Buffer.from([0x05, 0x01, 0x00]))
  client.write(Buffer.concat([Buffer.from([0x05, cmd, 0x00, 0x03, host.length]), host, Buffer.from([0x01, 0xbb])]))
  return {
    client,
    closed: () => on('close'),
    got: () => on('data'),
    have,
    get reply() { return bytes() },
    get connectRep() { const b = bytes(); return b.length >= 12 ? b[3] : null },
  }
}

// Every test ends with the relay and the fake tor closed, or the runner never exits.
async function withRelay({ fake = {}, ready = true, onError } = {}, fn) {
  const tor = await fakeTor(fake)
  const relay = new IsolationRelay({ torPort: tor.port, isReady: () => ready, onError })
  const clients = []
  const connect = async (site, opts = {}) => {
    const c = await through(await relay.portFor(site), { target: site, ...opts })
    clients.push(c.client)
    return c
  }
  try {
    await fn({ tor, relay, connect })
  } finally {
    for (const c of clients) c.destroy()
    await relay.rotate('cleanup')
    tor.server.closeAllConnections?.()
    await new Promise(res => tor.server.close(res))
  }
}

test('two sites present two different credential pairs, so tor builds two circuits', OPTIONS, async () => {
  await withRelay({}, async ({ tor, connect }) => {
    const a = await connect('example.com')
    await connect('other.org')
    await new Promise(r => setTimeout(r, 150))
    const pairs = tor.connections.map(c => `${c.credentials.username}|${c.credentials.password}`)
    assert.deepEqual(pairs, ['example.com|:0', 'other.org|:0'])
    assert.notEqual(pairs[0], pairs[1], 'tor isolates on the pair: identical pairs would share a circuit')
    assert.equal(tor.connections[0].target, 'example.com:443')
    assert.equal(tor.connections[1].target, 'other.org:443')
    assert.equal(a.reply[1], 0x00, 'the relay accepts Chromium\'s no-auth greeting locally')
    await a.have(12)
    assert.equal(a.connectRep, 0x00, 'and forwards a successful connect reply')
  })
})

test('a site keeps its credential, and New Circuit rotates that site alone', OPTIONS, async () => {
  await withRelay({}, async ({ relay }) => {
    await relay.rotate('nonce1')
    const before = relay.credentialsFor('example.com')
    await through(await relay.portFor('example.com'))
    assert.deepEqual(relay.credentialsFor('example.com'), before, 'an ordinary connection rotates nothing')

    relay.newCircuit('example.com')
    const after = relay.credentialsFor('example.com')
    assert.equal(after.username, before.username)
    assert.notEqual(after.password, before.password, 'New Circuit for This Site must present a new password')
    assert.equal(after.password, 'nonce1:1')
    assert.equal(relay.credentialsFor('other.org').password, 'nonce1:0', 'other sites are untouched')
    relay.newCircuit('example.com')
    assert.equal(relay.credentialsFor('example.com').password, 'nonce1:2')
  })
})

test('New Identity changes the nonce everywhere and drops the old listeners', OPTIONS, async () => {
  await withRelay({}, async ({ tor, relay }) => {
    await relay.rotate('nonce-A')
    const portA = await relay.portFor('example.com')
    const a = await through(portA)
    a.client.destroy()
    await relay.rotate('nonce-B')
    const portB = await relay.portFor('example.com')
    assert.notEqual(portA, portB, 'a new identity must not reuse the old listener')
    assert.equal(relay.credentialsFor('example.com').password, 'nonce-B:0', 'the salt resets with the nonce')
    const b = await through(portB)
    await new Promise(r => setTimeout(r, 150))
    assert.equal(tor.connections.at(-1).credentials.password, 'nonce-B:0')
    b.client.destroy()
  })
})

test('the kill switch closes the client before tor is contacted', OPTIONS, async () => {
  await withRelay({ ready: false }, async ({ tor, connect }) => {
    const { client, closed, reply } = await connect('example.com')
    await closed()
    assert.equal(reply.length, 0, 'nothing may be forwarded while tor is not bootstrapped')
    assert.equal(tor.connections.length, 0, 'and tor must not even see the connection')
    client.destroy()
  })
})

test('only CONNECT is relayed: BIND is refused locally and never reaches tor', OPTIONS, async () => {
  await withRelay({}, async ({ tor, connect }) => {
    const c = await connect('example.com', { cmd: 0x02 })
    await c.have(12)
    assert.equal(c.connectRep, 0x07, 'command not supported')
    assert.equal(tor.connections.length, 0)
  })
})

test('a tor-side auth failure gives the browser no connected socket', OPTIONS, async () => {
  await withRelay({ fake: { accept: () => false } }, async ({ tor, connect }) => {
    const { reply, closed } = await connect('example.com')
    await closed()
    assert.equal(reply.length, 0, 'a refused authentication must not look like a live connection')
    assert.equal(tor.connections[0].refused, true)
  })
})

test('an ExtendedErrors onion code is reported, not passed off as success', OPTIONS, async () => {
  const reported = []
  await withRelay({ fake: { replyCode: 0xf4 }, onError: (site, code) => reported.push({ site, code }) },
    async ({ connect }) => {
      const c = await connect('invite-only.onion')
      await c.have(12)
      await c.closed()
      assert.deepEqual(reported, [{ site: 'invite-only.onion', code: 0xf4 }])
      assert.equal(c.connectRep, 0xf4, 'the code is forwarded so Veil can name the reason')
    })
})

test('after a successful connect, bytes travel both ways', OPTIONS, async () => {
  await withRelay({}, async ({ tor, connect }) => {
    const c = await connect('example.com')
    await c.have(12)
    assert.equal(c.connectRep, 0x00, 'the connect reply came before any payload')
    const before = c.reply.length
    c.client.write('hello')
    await c.have(before + 5)
    assert.equal(c.reply.subarray(before).toString(), 'HELLO')
    assert.equal(tor.connections[0].data.length >= 1, true, 'the client bytes reached the tor side')
  })
})

test('one listener per site, reused across connections; different sites, different ports', OPTIONS, async () => {
  await withRelay({}, async ({ tor, relay, connect }) => {
    const p1 = await relay.portFor('example.com')
    assert.equal(p1, await relay.portFor('example.com'))
    assert.notEqual(p1, await relay.portFor('other.org'))
    await connect('example.com')
    await connect('example.com')
    await new Promise(r => setTimeout(r, 150))
    assert.equal(tor.connections.length, 2, 'both connections went out through the site\'s own listener')
  })
})
