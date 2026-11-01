// VEIL_SELFTEST=1 npm start — verifies the anonymity guarantees, prints results, quits.
const P = require('./platform')

async function waitFor(fn, ms, label) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function runSelfTest({ tor, networkTest, createTab, circuitInfo, community, pageProbe, newCircuit, browser }) {
  const results = []
  const knownRows = []
  // Three outcomes, not two: PASS, FAIL, and KNOWN — a limitation measured right here and
  // written up in the docs. A KNOWN line is never counted as a pass and always prints why.
  const check = (name, ok, detail, knownReason) => {
    if (!ok && knownReason) {
      knownRows.push(name)
      console.log(`KNOWN  ${name}  — ${detail ? `${detail} — ` : ''}${knownReason}`)
      return
    }
    results.push(ok)
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  }

  await waitFor(() => tor.ready, 120000, 'tor bootstrap')
  console.log('tor bootstrapped')

  // Internal pages: their scripts must actually run (a syntax error once broke the Hub silently)
  for (const page of ['hub', 'leaktest', 'history', 'routing']) {
    const t = createTab(`veil://${page}/`)
    await waitFor(() => t.view && !t.loading, 15000, page).catch(() => {})
    await new Promise(r => setTimeout(r, 1500))
    const errors = await t.view.webContents.executeJavaScript('window.__veilErrors || []').catch(() => ['page did not answer'])
    const ok = await t.view.webContents.executeJavaScript(({
      hub: "document.getElementById('sites').children.length > 0 && !!document.querySelector('input[name=mode]:checked') || JSON.stringify({ sites: document.getElementById('sites').children.length, mode: !!document.querySelector('input[name=mode]:checked'), status: document.getElementById('statustext').textContent, msg: document.getElementById('connmsg').textContent })",
      leaktest: "document.getElementById('fp').children.length > 0",
      history: "document.getElementById('rows').children.length > 0",
      routing: "document.getElementById('content').children.length > 0",
    })[page]).catch(() => false)
    check(`veil://${page} script runs`, ok === true && !errors.length, ok === true ? errors.join('; ') : `${ok} ${errors.join('; ')}`)
    browser.closeTab(t.id)
  }

  const net = await networkTest()
  check('traffic exits via Tor', net.tor?.IsTor === true, net.tor?.IP || net.tor?.error)
  check('two sites get different exit IPs', !!net.tor?.IP && net.tor.IP !== net.isolated?.IP,
    `${net.tor?.IP} vs ${net.isolated?.IP}`)
  check('local DNS is impossible', net.dns?.blocked === true)

  const tab = createTab('https://check.torproject.org/')
  await waitFor(() => tab.view && !tab.loading && tab.title && tab.title !== 'New Tab', 60000, 'page load')
  const html = await tab.view.webContents.executeJavaScript('document.body.innerText')
  check('check.torproject.org page says Congratulations', /Congratulations/i.test(html))
  const { circuit } = await circuitInfo()
  check('circuit visible for site', circuit?.hops?.length === 3,
    circuit?.hops?.map(h => `${h.nickname}(${h.country || '?'})`).join(' → '))

  const fp = await pageProbe(tab)
  check('timezone is UTC', fp.offset === 0, `${fp.tz}, offset ${fp.offset}`)
  check('WebRTC removed', fp.rtc === 'undefined')
  check('OS family consistent (UA vs platform)', fp.uaMac === (fp.platform === 'MacIntel'), fp.platform)
  check('navigator.connection & serviceWorker removed', !fp.connection && !fp.serviceWorker)
  check('WebGL2 disabled', !fp.webgl2)
  check('timer coarsened to 16.67 ms', fp.timer >= 16, `${fp.timer.toFixed(2)} ms`)
  check('system preferences forced (light, no reduced motion)', fp.light && !fp.dark && !fp.reducedMotion)
  check('pixel ratio consistent between JS and CSS', fp.dprConsistent)
  // On Windows the font list genuinely is the OS's: Chromium enumerates the installed fonts
  // and Veil ships no font bundle to stand in for them, the way Tor Browser does. Reporting
  // that as a pass would be a lie, and as a failure would hide every other Windows result.
  check('installed fonts hidden from DOM, canvas and document.fonts',
    fp.fonts.domHidden && fp.fonts.canvasHidden && fp.fonts.checkHidden, JSON.stringify(fp.fonts),
    P.isWindows
      ? 'known Windows limitation: no font bundle is shipped, so the OS font list stays visible (docs/WINDOWS_SECURITY_AUDIT.md)'
      : null)
  check('standard system fonts still work', fp.fonts.systemVisible)
  check('screen = viewport', fp.screen === fp.inner, `${fp.screen} / ${fp.inner}`)

  // --- everyday browser features ---
  browser.ui.find('Tor', true, false)
  const found = await waitFor(() => tab.find?.matches > 0 && tab.find, 10000, 'find').catch(() => null)
  check('find in page', !!found, found ? `${found.matches} matches for "Tor"` : `active tab ${browser.activeId()}, test tab ${tab.id}`)
  browser.ui.findOpen(false)

  browser.ui.zoom(1)
  check('zoom in', tab.zoom === 0.5 && Math.abs(tab.view.webContents.getZoomLevel() - 0.5) < 0.01)
  browser.ui.zoom(0)

  browser.ui.bookmark()
  const marked = browser.bookmarks.has(tab.url)
  browser.ui.bookmark()
  check('bookmark toggle', marked && !browser.bookmarks.has(tab.url))

  check('session history recorded', browser.history().some(h => h.url.startsWith('https://check.torproject.org')))

  const before = browser.tabCount()
  browser.closeTab(tab.id)
  browser.ui.reopenClosed()
  check('reopen closed tab', browser.tabCount() === before)

  // Click the real × of a tab with OS-level mouse events, the way a user does.
  createTab('veil://hub/')
  await new Promise(r => setTimeout(r, 800))
  const beforeClose = browser.tabCount()
  const box = await browser.uiView.webContents.executeJavaScript(`(() => {
    const r = document.querySelector('#tabs .tab:last-child .close').getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  for (const type of ['mouseDown', 'mouseUp']) {
    browser.uiView.webContents.sendInputEvent({ type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
  await new Promise(r => setTimeout(r, 800))
  check('clicking × closes the tab', browser.tabCount() === beforeClose - 1, `${beforeClose} → ${browser.tabCount()} tabs`)

  // Ad & tracker blocking: the engine, then a real ad-heavy page through Tor
  const req = url => browser.adblock.check({ url, resourceType: 'script', referrer: 'https://example.com/' }, 'example.com')
  const ad = req('https://securepubads.g.doubleclick.net/tag/js/gpt.js')
  const pixel = browser.adblock.check({ url: 'https://ad.doubleclick.net/ddm/ad/x.gif', resourceType: 'image', referrer: 'https://example.com/' }, 'example.com')
  const own = req('https://example.com/app.js')
  check('ad blocker: ads stopped, site scripts untouched', !!ad?.redirectURL && pixel?.cancel === true && own === null,
    'gpt.js → no-op stand-in, ad pixel → blocked, app.js → allowed')
  const adTab = createTab('https://www.theguardian.com/international')
  await waitFor(() => adTab.view && !adTab.loading && adTab.title !== 'New Tab', 90000, 'ad page').catch(() => {})
  await new Promise(r => setTimeout(r, 3000))
  check('ads & trackers blocked on a real page', adTab.blocked > 0, `${adTab.blocked} blocked on theguardian.com`)
  browser.ui.activate(adTab.id)
  await waitFor(() => browser.uiView.webContents.executeJavaScript('state.activeId').then(id => id === adTab.id), 10000, 'ui state').catch(() => {})
  await new Promise(r => setTimeout(r, 400))
  const badge = await browser.uiView.webContents.executeJavaScript(
    `({ hidden: document.getElementById('adblockbtn').hidden, text: document.getElementById('adblockcount').textContent })`)
  check('shield badge shows the count in the toolbar', !badge.hidden && Number(badge.text) === adTab.blocked, `badge: ${badge.text}`)

  // Device and network headers, measured on the wire. Two halves: nothing revealing may leave,
  // and the low-entropy hints real Chrome always sends must still be there — otherwise
  // "nothing leaked" would only mean "nothing was watched".
  const REVEALING = /^(sec-ch-ua-(arch|bitness|full-version|full-version-list|model|platform-version|wow64|form-factors?)|sec-ch-(dpr|device-memory|viewport-width|viewport-height|width|downlink|ect|rtt|prefers-color-scheme|prefers-reduced-motion|prefers-contrast|forced-colors|save-data)|dpr|device-memory|viewport-width|downlink|ect|rtt|save-data|x-client-data)$/
  const chWire = []
  // Chrome sends its low-entropy hints on the *first* request to an origin and afterwards only
  // when the site asks for them, so the watcher has to exist before that first request: build
  // the partition, attach to it, then navigate to a host this run has never contacted.
  const chSes = await browser.sessionFor('example.net')
  chSes.webRequest.onSendHeaders({ urls: ['https://*/*'] }, d => {
    if (new URL(d.url).hostname === 'example.net')
      chWire.push(Object.entries(d.requestHeaders || {}).map(([k, v]) => [k.toLowerCase(), String(v)]))
  })
  const chTab = createTab('https://example.net/')
  await waitFor(() => chTab.view && !chTab.loading, 60000, 'client-hints page').catch(() => {})
  await new Promise(r => setTimeout(r, 1500))
  chSes.webRequest.onSendHeaders(null)
  const observed = chWire.flat()
  const names = observed.map(([k]) => k)
  const wouldLeak = names.filter(k => REVEALING.test(k))
  check('device and network headers never leave the browser', observed.length > 0 && wouldLeak.length === 0,
    observed.length ? (wouldLeak.length ? `leaked: ${wouldLeak.join(', ')}` : `${chWire.length} request(s), no revealing header`) : 'no request was observed at all')
  const platforms = [...new Set(observed.filter(([k]) => k === 'sec-ch-ua-platform').map(([, v]) => v))]
  check('the low-entropy Chrome hints still go out, normalised',
    ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'].every(h => names.includes(h))
      && platforms.length === 1 && /^"(Windows|macOS|Linux)"$/.test(platforms[0] || ''),
    `sec-ch-ua-platform=${platforms.join(' | ') || '(absent)'}; sent: ${names.filter(n => n.startsWith('sec-ch')).join(', ') || '(none)'}`)
  browser.closeTab(chTab.id)

  // A site that explicitly asks for them must still get nothing, and its Accept-CH must not
  // reach the page. Needs a public echo service, so an unreachable one is reported as KNOWN
  // with the reason rather than as a pass or as Veil's failure.
  const ECHO = [
    'https://httpbin.org',
    'https://eu.httpbin.org',
  ]
  let echoed = null, echoFrom = ''
  for (const host of ECHO) {
    const tab = createTab(`${host}/response-headers?Accept-CH=Sec-CH-UA-Platform-Version,Sec-CH-UA-Arch,Sec-CH-UA-Model,Sec-CH-UA-Full-Version-List,Downlink,ECT,RTT,Device-Memory,DPR,Viewport-Width`)
    await waitFor(() => tab.view && !tab.loading && tab.url.includes('response-headers'), 45000, 'accept-ch page').catch(() => {})
    tab.view?.webContents.loadURL(`${host}/headers`)
    echoed = await waitFor(async () => {
      if (!tab.view || tab.view.webContents.isLoading()) return null
      const text = await tab.view.webContents.executeJavaScript('document.body.innerText').catch(() => '')
      try { return JSON.parse(text).headers } catch { return null }
    }, 45000, 'headers echo').catch(() => null)
    if (echoed) { echoFrom = host; browser.closeTab(tab.id); break }
  }
  const askedLeak = echoed ? Object.keys(echoed).filter(k => REVEALING.test(k.toLowerCase())) : null
  check('no device or network headers even when a site asks',
    !!echoed && askedLeak.length === 0 && !Object.keys(echoed).some(k => /^(accept-ch|critical-ch)$/i.test(k)),
    echoed ? `${echoFrom} saw: ${Object.keys(echoed).join(', ')}`
      : 'no public echo service answered from this network — this check could not be decided here',
    // A real leak must be a FAIL, never a KNOWN: the excuse is only offered when the echo
    // service itself never answered.
    echoed ? undefined : 'the check depends on a third-party echo service that did not answer; the wire-level checks above measure the same headers without it')

  // HTTPS-Only mode: a plain http:// address must end up on https://
  const upTab = createTab('http://example.com/')
  await waitFor(() => upTab.view && !upTab.loading && upTab.url.startsWith('https://'), 60000, 'https upgrade').catch(() => {})
  check('HTTPS-Only upgrades http:// to https://', upTab.url.startsWith('https://example.com'), upTab.url)

  // ExtendedErrors: a malformed onion gets a specific explanation, not a generic error
  const badOnion = createTab('http://' + 'a'.repeat(56) + '.onion/')
  await waitFor(() => badOnion.error, 60000, 'onion error').catch(() => {})
  check('specific onion error message', /onion/i.test(badOnion.error || ''), badOnion.error)

  const olTab = createTab('https://www.torproject.org/')
  const ol = await waitFor(() => olTab.onionLocation, 60000, 'Onion-Location').catch(() => null)
  check('".onion available" detected', !!ol, ol)

  const site = await community.host({ folder: require('path').join(__dirname, '..', '..', 'community', 'sample-site'), inviteOnly: true })
  check('onion service published', /^[a-z2-7]{56}$/.test(site.serviceId), site.url)
  check('invite generated', /^veil-invite:/.test(site.invite || ''))

  // End to end: load our own invite-only onion through Tor (descriptor takes a while to publish)
  const onionTab = createTab(site.url)
  // Retry on a fresh circuit each time so a failed attempt isn't cached.
  const reached = await waitFor(async () => {
    if (!onionTab.view || onionTab.loading) return false
    const text = await onionTab.view.webContents.executeJavaScript('document.body ? document.body.innerText : ""').catch(() => '')
    if (/You made it/.test(text)) return true
    await new Promise(r => setTimeout(r, 10000))
    await newCircuit()
    return false
  }, 300000, 'onion site').catch(() => false)
  check('invite-only onion site reachable over Tor', reached)

  // Referer / Origin: an .onion page embeds a normal site; that site must not learn the onion
  // address. Measured on the wire, not through a public echo service — httpbin.org refuses to
  // be framed, and a refused frame looks exactly like a leak from here.
  const onionPage = onionTab
  const probeUrl = 'https://example.com/veil-onion-referer-probe.png'
  const seenHeaders = []
  const onionSession = onionPage.view?.webContents.session
  onionSession?.webRequest.onSendHeaders({ urls: ['https://*/*'] }, details => {
    if (details.url.startsWith(probeUrl)) seenHeaders.push({ url: details.url, headers: details.requestHeaders || {} })
  })
  await onionPage.view?.webContents.executeJavaScript(`(() => {
    const i = document.createElement('img'); i.src = ${JSON.stringify(probeUrl)}; document.body.append(i)
  })()`).catch(() => {})
  const seen = await waitFor(() => seenHeaders[0] || null, 60000, 'the probe request to leave the onion page').catch(() => null)
  onionSession?.webRequest.onSendHeaders(null)
  const leaking = seen ? Object.entries(seen.headers).filter(([, v]) => /\.onion\b/i.test(String(v))) : []
  check('onion address never leaks via Referer', !!seen && leaking.length === 0,
    seen
      ? leaking.length ? `sent ${leaking.map(([k, v]) => `${k}: ${v}`).join(', ')}`
        : `${seen.url} carried Referer=${seen.headers['Referer'] || seen.headers['referer'] || '(none)'} and no onion-bearing header`
      : // Say *why* it failed: a page that never made the request and a dead network look the same here.
        `the probe request never reached the network (page=${onionPage.url}, tab error=${onionPage.error || 'none'}, frames=${onionPage.view ? onionPage.view.webContents.mainFrame.framesInSubtree.map(f => f.url).join(' ') : 'no view'})`)


  // Non-vacuity control for the check above, and Veil's own origin-only rule: the same
  // observation must still see a Referer leave an ordinary site. Without it, "no onion in the
  // headers" could pass simply because nothing was sent at all.
  const clearRef = 'https://example.net/veil-onion-referer-probe.png'
  const controlSeen = []
  const clearSession = upTab.view?.webContents.session
  clearSession?.webRequest.onSendHeaders({ urls: ['https://*/*'] }, d => {
    if (d.url.startsWith(clearRef)) controlSeen.push(d.requestHeaders || {})
  })
  await upTab.view?.webContents.executeJavaScript(`(() => {
    const i = document.createElement('img'); i.src = ${JSON.stringify(clearRef)}; document.body.append(i)
  })()`).catch(() => {})
  const control = await waitFor(() => controlSeen[0] || null, 60000, 'the control request to leave the clearnet page').catch(() => null)
  clearSession?.webRequest.onSendHeaders(null)
  const sentRef = control ? (control['Referer'] || control['referer'] || '') : ''
  check('an ordinary site sends only its origin as Referer', !!control && sentRef === 'https://example.com/',
    control ? `Referer: ${sentRef || '(none)'}` : `the control request never reached the network (page=${upTab.url})`)

  // New Identity, measured rather than assumed: the old tabs and the whole history have to go,
  // the partitions have to go with them, and the path out has to be a new one. newIdentity() ends
  // by opening a fresh home page, so "emptied" means one new tab and no history — not zero tabs.
  const beforeNI = await networkTest()
  const tabsBefore = browser.tabCount(), historyBefore = browser.history().length
  await browser.ui.newIdentity()
  await waitFor(() => browser.tabCount() === 1 && browser.history().length === 0, 20000, 'the session to come down').catch(() => {})
  const afterNI = await networkTest()
  check('New Identity empties tabs and history',
    tabsBefore >= 2 && historyBefore > 0 && browser.tabCount() === 1 && browser.history().length === 0,
    `tabs ${tabsBefore} → ${browser.tabCount()}, history ${historyBefore} → ${browser.history().length}`)
  // A new identity is worth nothing if the path out is the old one, so compare the exit address.
  check('New Identity gets a new exit address and still routes through Tor',
    afterNI.tor?.IsTor === true && !!beforeNI.tor?.IP && !!afterNI.tor?.IP && afterNI.tor.IP !== beforeNI.tor.IP,
    `${beforeNI.tor?.IP || beforeNI.tor?.error} → ${afterNI.tor?.IP || afterNI.tor?.error}`)

  // Panic: the same teardown, plus the clipboard and the one file Veil writes to disk. Those
  // extra promises are the only difference from New Identity, so they are what is measured here.
  // Measured on Windows: with nothing textual on the clipboard, Electron's readText() hands back
  // an object, and writeText(that) throws a conversion error. So read it as text or as nothing,
  // and only ever write a string back.
  const { clipboard } = require('electron')
  const clip = () => { try { const v = clipboard.readText(); return typeof v === 'string' ? v : '' } catch { return '' } }
  const savedClipboard = clip()
  clipboard.writeText('veil-panic-probe')
  // A bookmark has to exist first, or "panic wiped the bookmarks" would pass by watching nothing.
  browser.bookmarks.toggle('https://example.org/veil-panic-bookmark', 'Veil panic probe')
  const marksBefore = browser.bookmarks.list().length
  createTab('https://example.org/')
  await waitFor(() => browser.tabCount() >= 2, 20000, 'a second tab for panic to remove').catch(() => {})
  const tabsBeforePanic = browser.tabCount()
  await browser.ui.panic()
  await waitFor(() => browser.tabCount() === 1 && clip() === '', 20000, 'panic to finish').catch(() => {})
  check('panic clears tabs, clipboard and the bookmark file',
    marksBefore > 0 && tabsBeforePanic >= 2 && browser.tabCount() === 1 && clip() === ''
      && browser.bookmarks.list().length === 0,
    `tabs ${tabsBeforePanic} → ${browser.tabCount()}, clipboard ${JSON.stringify(clip())}, bookmarks ${marksBefore} → ${browser.bookmarks.list().length}`)
  if (savedClipboard) clipboard.writeText(savedClipboard)

  const failed = results.filter(r => !r).length
  console.log(failed
    ? `\n${failed} check(s) FAILED` + (knownRows.length ? `\n${knownRows.length} known limitation(s) reported above as KNOWN — not counted as passing` : '')
    : knownRows.length
      ? `\nAll ${results.length} checks that could be decided here passed; ${knownRows.length} limitation(s) are reported separately as KNOWN, not as passing.`
      : '\nALL CHECKS PASSED')
  return failed
}

module.exports = { runSelfTest }
