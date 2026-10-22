'use strict'
/**
 * CutCut 浏览器扩展后台（MV3 service worker）。
 *
 * 流程：网页图片右键 → 取 srcUrl → fetch 图片字节 → POST 到 CutCut 的本地桥
 *       → CutCut 抠图并把结果显示在应用窗口里。
 *
 * 桥的端口不固定（8770 起顺延），所以先 /ping 探到哪一端口活着，缓存起来，
 * 失败时重新探测。端口不会跨浏览器重启保证，缓存只是加速。
 */

const PORTS = [8770, 8771, 8772, 8773, 8774, 8775, 8776, 8777, 8778, 8779]
const MENU_ID = 'cutcut-cutout-image'
const MIN_BYTES = 64            // 1x1 追踪像素之类直接忽略
const MAX_BYTES = 64 * 1024 * 1024

let cachedPort = null

async function pingPort (port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/ping`, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(1200),
    })
    if (!r.ok) return false
    const j = await r.json()
    return !!(j && j.ok && j.app === 'CutCut')
  } catch { return false }
}

/** 找到活着的桥端口；找不到返回 null */
async function findBridge () {
  if (cachedPort && await pingPort(cachedPort)) return cachedPort
  cachedPort = null
  for (const p of PORTS) {
    if (await pingPort(p)) { cachedPort = p; return p }
  }
  return null
}

function notify (title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
    })
  } catch (e) { /* 没有通知权限时静默 */ }
}

/** 给扩展图标上画一个角标，提示处理中 / 完成 / 失败 */
function setBadge (text, color) {
  try {
    chrome.action.setBadgeText({ text })
    if (color) chrome.action.setBadgeBackgroundColor({ color })
  } catch (e) {}
}

async function fetchImageBytes (url) {
  // data: / blob: 之类直接取
  const r = await fetch(url, { credentials: 'omit', cache: 'no-store' })
  if (!r.ok) throw new Error(`取图片失败（HTTP ${r.status}）`)
  const buf = await r.arrayBuffer()
  if (buf.byteLength < MIN_BYTES) throw new Error('这张图太小了，可能不是真正的图片')
  if (buf.byteLength > MAX_BYTES) throw new Error('图片超过 64 MB，暂不支持')
  return buf
}

/** 图片加载失败时（防盗链 / 需要 referer）用 content script 在页面里重试 */
async function grabViaPage (tabId, frameId, srcUrl) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: frameId != null ? [frameId] : undefined },
      func: async (url) => {
        const img = [...document.images].find(i => i.currentSrc === url || i.src === url)
        if (!img) return null
        // 同源或带 CORS 时 canvas 可读
        try {
          const c = document.createElement('canvas')
          c.width = img.naturalWidth; c.height = img.naturalHeight
          c.getContext('2d').drawImage(img, 0, 0)
          return c.toDataURL('image/png')
        } catch { return null }
      },
      args: [srcUrl],
    })
    const dataUrl = results && results[0] && results[0].result
    if (!dataUrl) return null
    const r = await fetch(dataUrl)
    return await r.arrayBuffer()
  } catch (e) { return null }
}

async function handleImage (info, tab) {
  const srcUrl = info.srcUrl
  if (!srcUrl) return
  setBadge('…', '#4c8dff')

  try {
    const port = await findBridge()
    if (!port) {
      setBadge('!', '#ff6b6b')
      notify('CutCut 没有在运行', '请先打开 CutCut 应用，再在图片上右键重试。')
      return
    }

    let buf = null
    try {
      buf = await fetchImageBytes(srcUrl)
    } catch (e) {
      // 防盗链/跨域取不到，退回页面内 canvas
      buf = await grabViaPage(tab && tab.id, info.frameId, srcUrl)
      if (!buf) throw e
    }

    const r = await fetch(`http://127.0.0.1:${port}/cutout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-CutCut': '1' },
      body: buf,
      signal: AbortSignal.timeout(30000),
    })
    const j = await r.json().catch(() => null)
    if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || `桥返回 HTTP ${r.status}`)

    setBadge('✓', '#2bd6a4')
    setTimeout(() => setBadge(''), 2500)
  } catch (e) {
    cachedPort = null
    setBadge('!', '#ff6b6b')
    setTimeout(() => setBadge(''), 4000)
    notify('抠图没有成功', String(e && e.message ? e.message : e))
  }
}

function createMenus () {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '用 CutCut 抠出主体',
      contexts: ['image'],
    })
  })
}

chrome.runtime.onInstalled.addListener(createMenus)
chrome.runtime.onStartup.addListener(createMenus)
// service worker 冷启动时也确保菜单存在（onInstalled 只在安装/升级时触发）
createMenus()

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return
  handleImage(info, tab)
})

chrome.action.onClicked.addListener(() => {
  // 点图标：只做一次连通性自检，给个明确反馈
  findBridge().then((port) => {
    if (port) notify('CutCut 已就绪', '在网页图片上点右键，选「用 CutCut 抠出主体」即可。')
    else notify('CutCut 没有在运行', '请先打开 CutCut 应用。')
  })
})
