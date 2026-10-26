// 深色主题 + 空工作区截图（1:1 CSS 像素）
// 用法: node shot-dark-empty.cjs <port> <out.png> [w] [h]
const fs = require('node:fs')

const port = process.argv[2]
const out = process.argv[3]
const W = parseInt(process.argv[4] || '1180', 10)
const H = parseInt(process.argv[5] || '780', 10)

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
    const t = setTimeout(() => { if (pend.has(i)) { pend.get(i)({ __timeout: 1 }); pend.delete(i) } }, 25000)
    return new Promise((r) => pend.set(i, (v) => { clearTimeout(t); r(v) }))
  }
  const ev = (ex) => cmd('Runtime.evaluate', { expression: ex, awaitPromise: true, returnByValue: true })
  const val = (r) => r.result && r.result.result && r.result.result.value

  await cmd('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await new Promise((r) => setTimeout(r, 800))

  // 清空工作区 + 切深色 + 状态复位
  await ev(`(() => {
    state.items.length = 0; seq = 0; state.running = false;
    render(); updateCounter();
    const s = document.querySelector('#status'); if (s) s.textContent = '就绪';
  })()`)
  await ev(`applyTheme('dark', { persist: false })`)
  await new Promise((r) => setTimeout(r, 400))

  console.log('theme  :', val(await ev(`document.documentElement.dataset.theme`)))
  console.log('items  :', val(await ev(`state.items.length`)))
  console.log('status :', val(await ev(`document.querySelector('#status').textContent`)))
  console.log('counter:', val(await ev(`document.querySelector('#counter')?.textContent || ''`)))
  console.log('grid   :', val(await ev(`document.querySelectorAll('.grid .card').length`)))

  await ev(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
  const shot = await cmd('Page.captureScreenshot', { format: 'png', fromSurface: true })
  if (!shot.result || !shot.result.data) { console.error('NO_DATA'); process.exit(1) }
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
  console.log('saved', out, fs.statSync(out).size + 'B')
  ws.close()
  process.exit(0)
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })
