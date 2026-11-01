// The gate between pasted text and tor's configuration file. A custom bridge line is
// written into torrc verbatim ("Bridge <line>"), so this is an injection surface.
const test = require('node:test')
const assert = require('node:assert/strict')
const { isBridgeLine, parseBridgePaste, MAX_BRIDGE_LINE } = require('../src/main/bridge-lines')

const PT_CONFIG = require('../assets/pt_config.json')

test('every bridge line Veil ships by itself satisfies the grammar it demands of users', () => {
  const built = Object.entries(PT_CONFIG.bridges)
  assert.ok(built.length >= 3, 'expected the meek/obfs4/snowflake sets')
  for (const [mode, lines] of built) {
    assert.ok(lines.length > 0, `${mode} has no lines`)
    for (const line of lines) assert.equal(isBridgeLine(line), true, `${mode}: ${line.slice(0, 70)}`)
  }
})

test('the forms a user is actually told to paste are accepted', () => {
  const ok = [
    'obfs4 37.218.245.14:38224 D9A82D2F9C2F65A18407B1D2B764F130847F8B5D cert=bjRaMrr1BRiAW8IE9U5z27fQaYgOhX1UCmOpg2pFpoMvo6ZgQMzLsaTzzQNTlm7hNcb8oQ ikey=8JVyz95Q37X6K0EJcm9i4156mDnsY3BN5M9aHvU7bPUE',
    'meek_lite 192.0.2.20:80 url=https://cdn.example.org front=www.example.net utls=HelloRandomizedALPN',
    'snowflake 192.0.2.3:80 2B280B23E1107BB62ABFC40DDCC8824814F80A72 url=https://broker.example/',
    'webtunnel https://bridge.example/tunnel cert=abc123',
    'https://drtiger.example.org/plaintext',
    '192.0.2.1:9371 2B280B23E1107BB62ABFC40DDCC8824814F80A72',
    '1.2.3.4:443 D9A82D2F9C2F65A18407B1D2B764F130847F8B5D',
  ]
  for (const line of ok) assert.equal(isBridgeLine(line), true, line.slice(0, 60))
})

test('a line is a line: no newline can smuggle a second torrc directive in', () => {
  const smuggled = [
    'obfs4 1.2.3.4:443 ABCDEF\nSaveConfig 1',
    'obfs4\nSaveConfig 1', // the grammar alone allows this: \s matches \n
    'obfs4 1.2.3.4:443 ABCDEF\r\nRunAsDaemon 1',
    'obfs4\rDataDirectory /tmp/evil',
    'snowflake 1.2.3.4:80 ABC\nLog debug file /tmp/leak',
  ]
  for (const line of smuggled) assert.equal(isBridgeLine(line), false, JSON.stringify(line))
})

test('tor configuration directives are not bridge lines', () => {
  const rejected = [
    'UseBridges 1', 'RunAsDaemon 1', 'SaveConfig 1', 'DataDirectory C:\\Users\\victim\\evil',
    'SOCKSPort 9050', 'SocksPort 0', 'ControlPort 9051', 'CookieAuthentication 1',
    'Log debug file C:\\logs', 'VirtualAddrNetwork 10.192.0.0/10', '__OwningControllerProcess 1234',
    'Bridge obfs4 1.2.3.4:443 ABCDEF', // the prefix is stripped before validation, not part of a line
    '', ' ', '\n', 'x'.repeat(MAX_BRIDGE_LINE + 1),
  ]
  for (const line of rejected) assert.equal(isBridgeLine(line), false, JSON.stringify(line.slice(0, 50)))
  // What this gate promises is "no tor directive", not "this obfs4 line is well formed":
  // a truncated bridge such as "obfs4 1.2.3.4" passes the shape check and tor itself refuses
  // it on startup, which Veil reports through the same error path as a dead bridge.
  assert.equal(isBridgeLine('obfs4 1.2.3.4'), true)
})

test('the paste pipeline turns a distribution page into exactly the lines tor will read', () => {
  const pasted = [
    'Bridge obfs4 1.2.3.4:443 ABCDEF cert=x ikey=y',
    '',
    '   ',
    'Bridge snowflake 192.0.2.3:80 2B280B23E1107BB62ABFC40DDCC8824814F80A72 url=https://b.example/',
    'obfs4 5.6.7.8:9 ABCDEF',
  ].join('\r\n') // Windows line endings: \r must not survive into torrc
  const lines = parseBridgePaste(pasted)
  assert.equal(lines.length, 3)
  assert.deepEqual(lines[0], 'obfs4 1.2.3.4:443 ABCDEF cert=x ikey=y')
  for (const line of lines) {
    assert.ok(!/\r|\n/.test(line), JSON.stringify(line))
    assert.equal(isBridgeLine(line), true, line.slice(0, 50))
  }
})

test('a paste that mixes a real bridge with an injected directive is refused whole', () => {
  const lines = parseBridgePaste('Bridge obfs4 1.2.3.4:443 ABCDEF cert=x\r\nobfs4\nSaveConfig 1')
  const bad = lines.find(l => !isBridgeLine(l))
  assert.ok(bad, 'the injected line must be found, not silently dropped')
  assert.equal(isBridgeLine(bad), false)
})
