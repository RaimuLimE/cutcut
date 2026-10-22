// 读 1.3.0 的模型下载面板状态：node scripts/cdp-models.cjs <port>
'use strict'

const port = process.argv[2] || '9233'

async function main () {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  let targets
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`)
      targets = await r.json()
      if (targets.some(t => t.type === 'page')) break
    } catch { /* wait */ }
    await sleep(400)
  }
  const page = (targets || []).find(t => t.type === 'page')
  if (!page) { console.log('FAIL no page target'); process.exit(1) }

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let id = 0
  const send = (method, params) => new Promise((res) => {
    const mid = ++id
    pending.set(mid, res)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  await new Promise(r => { ws.onopen = r })

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result && r.result.exceptionDetails) return 'ERR: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300)
    return r.result.result.value
  }

  const probe = `(async () => {
    const $ = (s) => document.querySelector(s)
    const txt = (s) => { const e = $(s); return e ? (e.textContent || '').trim() : null }
    const vis = (s) => { const e = $(s); return e ? e.offsetParent !== null : null }
    const info = await window.api.info()
    const list = await window.api.modelList()
    return {
      title: document.title,
      badges: [...document.querySelectorAll('header .badge')].map(e => e.textContent.trim()),
      segModel: [...document.querySelectorAll('#segModel button')].map(b => b.textContent.trim() + (b.classList.contains('on') ? '*' : '')),
      modelHint: txt('#modelHint'),
      modelWarn: txt('#modelWarn'),
      iModel: txt('#iModel'),
      iSize: txt('#iSize'),
      iDevice: txt('#iDevice'),
      panelVisible: vis('#modelDown'),
      mdText: txt('#mdText'),
      mdGet: txt('#mdGet'),
      mdSize: txt('#mdSize'),
      mdImport: vis('#mdImport'),
      mdOpen: vis('#mdOpen'),
      mdRemove: vis('#mdRemove'),
      mdBarWidth: $('#mdBar') ? $('#mdBar').style.width : null,
      apiModels: list,
      dml: info.dml,
      version: info.version,
      overflow: [...document.querySelectorAll('body *')].filter(e => e.scrollWidth > e.clientWidth + 2).slice(0, 6).map(e => (e.id || e.className || e.tagName))
    }
  })()`

  console.log(JSON.stringify(await ev(probe), null, 2))
  ws.close()
}

main().catch(e => { console.error('FAIL', e.message); process.exit(1) })
