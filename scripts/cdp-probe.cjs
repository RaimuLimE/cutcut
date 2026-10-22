'use strict'
// 通过 CDP 检查已安装应用的真实 DOM 状态（图标是否加载、有没有报错）
// 用法: node cdp-probe.cjs <port>
const port = process.argv[2] || '9222'

async function main () {
  let targets
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`)
      targets = await r.json()
      if (targets.some(t => t.type === 'page')) break
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500))
  }
  const page = (targets || []).find(t => t.type === 'page')
  if (!page) { console.log('FAIL no page target'); process.exit(1) }
  console.log('title: ' + page.title)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let id = 0
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id
    pending.set(mid, { res, rej })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m); pending.delete(m.id) }
  }
  await new Promise(r => { ws.onopen = r })

  const expr = `(() => {
    const out = { title: document.title, h1: (document.querySelector('h1')||{}).textContent };
    const img = document.querySelector('.logo img');
    if (img) { const b = img.getBoundingClientRect(); out.logo = {
      src: img.getAttribute('src'), complete: img.complete,
      nw: img.naturalWidth, nh: img.naturalHeight,
      w: Math.round(b.width), h: Math.round(b.height),
      x: Math.round(b.x), y: Math.round(b.y) } }
    out.badges = [...document.querySelectorAll('header .badge')].map(e => e.textContent.trim());
    out.groups = [...document.querySelectorAll('aside .group-title, aside h3, aside .grp-h')].map(e => e.textContent.trim());
    out.modelBtns = [...document.querySelectorAll('#segModel button')].map(b => ({ v: b.dataset.v, t: b.textContent.trim(), on: b.classList.contains('on') }));
    out.hint = (document.querySelector('#modelHint')||{}).textContent;
    out.warn = (document.querySelector('#modelWarn')||{}).textContent;
    out.overflow = [...document.querySelectorAll('aside *, header *')].filter(e => e.scrollWidth > e.clientWidth + 2 && e.clientWidth > 0)
      .slice(0, 8).map(e => (e.id || e.className || e.tagName) + ' sw=' + e.scrollWidth + ' cw=' + e.clientWidth);
    return out;
  })()`
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
  console.log(JSON.stringify(r.result && r.result.result && r.result.result.value, null, 2))
  ws.close()
  process.exit(0)
}
main().catch(e => { console.log('ERR ' + e.message); process.exit(1) })
