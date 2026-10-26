// 通用 CDP 小工具：读任意表达式
// 用法: node cdp-eval.cjs <port> '<expression>'
const port = process.argv[2]
const expr = process.argv[3]

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
  const ev = (ex) => {
    const i = ++id
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: ex, awaitPromise: true, returnByValue: true } }))
    return new Promise((r) => pend.set(i, r))
  }
  const r = await ev(expr)
  if (r.result && r.result.exceptionDetails) {
    console.log('EXCEPTION:', JSON.stringify(r.result.exceptionDetails).slice(0, 500))
  } else {
    console.log(JSON.stringify(r.result.result.value, null, 1))
  }
  ws.close()
  process.exit(0)
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })
