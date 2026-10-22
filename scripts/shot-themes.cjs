'use strict'
// 依次切到指定主题并抓窗口截图，用于人工/视觉复核
// 用法: node shot-themes.cjs <port> <输出目录>
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const port = process.argv[2] || '9225'
const outDir = process.argv[3] || path.join(__dirname, '..', 'verify', 'themes')

async function cdp () {
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
  if (!page) throw new Error('no page target')
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
  return {
    ev: async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      return r.result.result.value
    },
    close: () => ws.close(),
  }
}

;(async () => {
  const c = await cdp()
  for (const mode of ['light', 'dark']) {
    await c.ev(`document.querySelector('#segTheme button[data-v="${mode}"]').click(), 1`)
    await new Promise(r => setTimeout(r, 700))
    const out = path.join(outDir, `theme-${mode}.png`)
    const r = execFileSync('node', [path.join(__dirname, 'capture-window.cjs'), out], { encoding: 'utf8' })
    console.log(mode + ': ' + r.trim().split('\n').pop())
  }
  // 复原为 auto
  await c.ev(`document.querySelector('#segTheme button[data-v="auto"]').click(), 1`)
  c.close()
  console.log('done')
})()
