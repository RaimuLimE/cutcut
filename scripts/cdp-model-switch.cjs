'use strict'
// 模拟用户点「BiRefNet」，检查 GPU 选项是否被正确禁用、提示是否更新
const port = process.argv[2] || '9223'

async function main () {
  let targets
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`)
      targets = await r.json()
      if (targets.some(t => t.type === 'page')) break
    } catch { /* wait */ }
    await new Promise(r => setTimeout(r, 500))
  }
  const page = (targets || []).find(t => t.type === 'page')
  if (!page) { console.log('FAIL no page'); process.exit(1) }

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
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    return r.result.result.value
  }

  const snap = () => `(() => ({
    model: [...document.querySelectorAll('#segModel button')].find(b=>b.classList.contains('on')).dataset.v,
    gpuDisabled: document.querySelector('#segProvider button[data-v="dml"]').disabled,
    gpuTitle: document.querySelector('#segProvider button[data-v="dml"]').title,
    hint: document.querySelector('#modelHint').textContent.trim(),
    badge: document.querySelector('#badgeModel').textContent.trim(),
    device: document.querySelector('#iDevice').textContent.trim(),
  }))()`

  console.log('初始: ' + JSON.stringify(await ev(snap())))

  await ev(`document.querySelector('#segModel button[data-v="birefnet"]').click()`)
  await new Promise(r => setTimeout(r, 900))
  console.log('点BiRefNet后: ' + JSON.stringify(await ev(snap())))

  await ev(`document.querySelector('#segModel button[data-v="rmbg"]').click()`)
  await new Promise(r => setTimeout(r, 900))
  console.log('切回RMBG后: ' + JSON.stringify(await ev(snap())))

  ws.close()
  process.exit(0)
}
main().catch(e => { console.log('ERR ' + e.message); process.exit(1) })
