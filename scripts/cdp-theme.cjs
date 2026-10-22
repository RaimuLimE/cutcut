'use strict'
// 主题验收：读取真实 DOM 计算样式，验证浅色/深色/自动三态
const port = process.argv[2] || '9225'

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
    if (r.result && r.result.exceptionDetails) return 'ERR: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 200)
    return r.result.result.value
  }

  const probe = `(() => {
    const g = (sel, prop) => {
      const el = document.querySelector(sel)
      return el ? getComputedStyle(el)[prop] : null
    }
    return {
      mode: [...document.querySelectorAll('#segTheme button')].filter(b => b.classList.contains('on')).map(b => b.dataset.v).join('') || 'none',
      htmlTheme: document.documentElement.dataset.theme,
      bodyBg: g('body', 'backgroundColor'),
      bodyFg: g('body', 'color'),
      asideBg: g('aside', 'backgroundColor'),
      headerBg: g('header', 'backgroundImage').slice(0, 44),
      badgeOkFg: g('.badge.ok', 'color'),
      segOnBg: g('.seg button.on', 'backgroundColor'),
      cardBg: g('.card', 'backgroundColor'),
      footerBg: g('footer', 'backgroundColor'),
    }
  })()`

  console.log('--- 初始（应跟随 settings.theme）---')
  console.log(JSON.stringify(await ev(probe), null, 1))

  for (const mode of ['light', 'dark', 'auto']) {
    const r = await ev(`document.querySelector('#segTheme button[data-v="${mode}"]').click(), 'clicked'`)
    if (r === 'clicked' || String(r).includes('clicked')) { /* ok */ }
    await sleep(500)
    const p = await ev(probe)
    console.log(`--- 点「${mode}」---`)
    console.log(JSON.stringify(p, null, 1))
  }

  // 检查两套主题的关键色差是否足够（浅色应明显更亮）
  await ev(`document.querySelector('#segTheme button[data-v="light"]').click(), 1`)
  await sleep(400)
  const light = await ev(probe)
  await ev(`document.querySelector('#segTheme button[data-v="dark"]').click(), 1`)
  await sleep(400)
  const dark = await ev(probe)
  const lum = (c) => {
    const m = /rgba?\((\d+), (\d+), (\d+)/.exec(c || '')
    return m ? (Number(m[1]) * 0.299 + Number(m[2]) * 0.587 + Number(m[3]) * 0.114) : NaN
  }
  console.log('--- 对比度校验 ---')
  console.log('light body bg 亮度 =', lum(light.bodyBg).toFixed(0), '| dark =', lum(dark.bodyBg).toFixed(0))
  console.log('light aside bg 亮度 =', lum(light.asideBg).toFixed(0), '| dark =', lum(dark.asideBg).toFixed(0))
  console.log('light fg 亮度 =', lum(light.bodyFg).toFixed(0), '| dark =', lum(dark.bodyFg).toFixed(0))
  const ok = lum(light.bodyBg) > 200 && lum(dark.bodyBg) < 40 && lum(light.bodyFg) < 90 && lum(dark.bodyFg) > 180
  console.log(ok ? 'THEME OK 两套主题对比正确' : 'THEME FAIL 对比不达标')

  // 自动模式的时段规则自检（不改系统时间，只验函数边界）
  const rule = await ev(`(() => {
    // 与 src/main.js 与 renderer 保持一致的规则
    const eff = (h) => (h >= 7 && h < 19) ? 'light' : 'dark'
    return [0, 6, 7, 12, 18, 19, 23].map(h => h + 'h=' + eff(h)).join(' ')
  })()`)
  console.log('auto 时段规则:', rule)
  console.log('当前小时:', await ev('new Date().getHours()'))

  ws.close()
  process.exit(ok ? 0 : 1)
}
main().catch(e => { console.log('ERR ' + e.message); process.exit(1) })
