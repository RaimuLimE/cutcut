// 读安装版 CutCut 的 UI 状态（CDP）
const port = process.argv[2] || '9491'
;(async () => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const p = list.find((x) => x.type === 'page' && x.url.includes('index.html'))
  if (!p) { console.log('NO_TARGET'); process.exit(1) }
  console.log('target:', p.url)
  const ws = new WebSocket(p.webSocketDebuggerUrl)
  let id = 0
  const pend = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
  }
  await new Promise((r) => { ws.onopen = r })
  const ev = (ex) => {
    const i = ++id
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: ex, awaitPromise: true, returnByValue: true } }))
    return new Promise((r) => pend.set(i, r))
  }
  const q = (sel) => `document.querySelector('${sel}')?.textContent`

  const ui = await ev(`(() => ({
    title: document.title,
    h1: ${q('h1')},
    footer: ${q('#status')},
    badges: [...document.querySelectorAll('.badge')].map((b) => b.textContent),
    theme: document.documentElement.dataset.theme,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    groups: [...document.querySelectorAll('aside h2')].map((h) => h.textContent),
    overflow: [...document.querySelectorAll('aside *')].filter((e) => e.scrollWidth > e.clientWidth + 1).length,
    apiKeys: Object.keys(window.api).length
  }))()`)
  console.log('UI:', JSON.stringify(ui.result.result.value, null, 1))

  const info = await ev('window.api.info()')
  console.log('INFO:', JSON.stringify(info.result.result.value, null, 1))

  const integ = await ev('window.api.integrationState()')
  console.log('INTEG:', JSON.stringify(integ.result.result.value, null, 1))

  ws.close()
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })
