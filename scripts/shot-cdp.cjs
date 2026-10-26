// CDP 截图（fromSurface:false 走视图合成，窗口被遮挡也能拿到内容）
// 用法: node shot-cdp.cjs <port> <out.png> [width] [height]
const fs = require('node:fs')

const port = process.argv[2] || '9501'
const out = process.argv[3]
const W = parseInt(process.argv[4] || '0', 10)
const H = parseInt(process.argv[5] || '0', 10)

;(async () => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const p = list.find((x) => x.type === 'page' && x.url.includes('index.html'))
  if (!p) { console.log('NO_TARGET'); process.exit(1) }
  const ws = new WebSocket(p.webSocketDebuggerUrl)
  let id = 0
  const pend = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
  }
  await new Promise((r) => { ws.onopen = r })
  const cmd = (method, params) => {
    const i = ++id
    ws.send(JSON.stringify({ id: i, method, params }))
    const timer = setTimeout(() => { if (pend.has(i)) { pend.get(i)({ __timeout: true }); pend.delete(i) } }, 20000)
    return new Promise((r) => pend.set(i, (v) => { clearTimeout(timer); r(v) }))
  }
  const ev = (ex) => cmd('Runtime.evaluate', { expression: ex, awaitPromise: true, returnByValue: true })

  if (W && H) {
    await cmd('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
    await new Promise((r) => setTimeout(r, 600))
    await ev(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
  }

  let shot = await cmd('Page.captureScreenshot', { format: 'png', fromSurface: false })
  if (!shot.result || !shot.result.data) {
    console.log('fromSurface:false 失败，试默认')
    shot = await cmd('Page.captureScreenshot', { format: 'png' })
  }
  if (!shot.result || !shot.result.data) { console.error('NO_DATA', JSON.stringify(shot).slice(0, 400)); process.exit(1) }
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
  console.log('saved', out, fs.statSync(out).size + 'B')
  ws.close()
  process.exit(0)
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })
