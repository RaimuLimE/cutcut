'use strict'
/**
 * 系统集成：把 CutCut 挂到资源管理器 / Edge・Chrome 的右键菜单上。
 *
 * 全部只写 HKCU（当前用户），不需要管理员权限，卸载时由 NSIS 的 customUnInstall 清掉。
 * 注册表操作走 reg.exe —— Electron/Node 没有原生注册表 API。
 */
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

/** Explorer 中「图片」这一族的注册表位置（比按扩展名逐个注册更省事，且自动覆盖新增格式） */
const MENU_KEY = 'HKCU\\Software\\Classes\\SystemFileAssociations\\image\\shell\\CutCut'

function reg (args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, out: String(stdout || ''), err: String(stderr || '') })
    })
  })
}

// ---------- 资源管理器图片右键菜单 ----------

async function explorerMenuState () {
  if (process.platform !== 'win32') return { supported: false, installed: false, exe: null }
  const r = await reg(['query', MENU_KEY, '/v', 'Icon'])
  if (!r.ok) return { supported: true, installed: false, exe: null }
  // 形如 "C:\...\CutCut.exe,0"
  const m = /Icon\s+REG_\w+\s+(.+)/.exec(r.out)
  const exe = m ? m[1].trim().replace(/,\s*\d+$/, '').replace(/^"|"$/g, '') : null
  return { supported: true, installed: true, exe }
}

async function installExplorerMenu (exePath) {
  if (process.platform !== 'win32') throw new Error('仅支持 Windows')
  const quoted = `"${exePath}" --cutout "%1"`
  const steps = [
    ['add', MENU_KEY, '/ve', '/d', '用 CutCut 抠出主体', '/f'],
    ['add', MENU_KEY, '/v', 'Icon', '/d', `${exePath},0`, '/f'],
    // 多选时每个文件起一个进程，交给单实例锁合并到同一个窗口
    ['add', MENU_KEY, '/v', 'MultiSelectModel', '/d', 'Player', '/f'],
    ['add', `${MENU_KEY}\\command`, '/ve', '/d', quoted, '/f'],
  ]
  for (const a of steps) {
    const r = await reg(a)
    if (!r.ok) throw new Error(`写入右键菜单失败：${r.err.trim() || a.join(' ')}`)
  }
  return explorerMenuState()
}

async function removeExplorerMenu () {
  if (process.platform !== 'win32') return { supported: false, installed: false }
  await reg(['delete', MENU_KEY, '/f'])
  return explorerMenuState()
}

// ---------- 浏览器扩展（解压目录 + 手动加载） ----------
//
// 为什么不用「写 HKCU\Software\Microsoft\Edge\Extensions + 本地 crx」这条路：
// 实测新版 Edge 会直接屏蔽注册表外置的第三方 CRX —— chrome-extension://<id>/
// 打不开，报 ERR_BLOCKED_BY_CLIENT，Secure Preferences 里 disable_reasons=256。
// 这条老路子对自签扩展已经失效，硬写只会往用户注册表里留垃圾。
//
// 改用：把扩展解压目录准备好，引导用户在浏览器扩展页「加载解压缩的扩展」。
// 实测同样的目录用 --load-extension 加载完全正常（contextMenus 可用、能连本地桥），
// 说明扩展本身没问题，只差一个浏览器认可的安装动作。

const BROWSER_EXES = [
  { id: 'edge', name: 'Edge', exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', page: 'edge://extensions/' },
  { id: 'edge', name: 'Edge', exe: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', page: 'edge://extensions/' },
  { id: 'chrome', name: 'Chrome', exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', page: 'chrome://extensions/' },
  { id: 'chrome', name: 'Chrome', exe: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', page: 'chrome://extensions/' },
]

/** 本机装了哪些浏览器（只认文件存在，不启动） */
function detectBrowsers () {
  const seen = new Set()
  const out = []
  for (const b of BROWSER_EXES) {
    if (seen.has(b.id)) continue
    if (fs.existsSync(b.exe)) { seen.add(b.id); out.push(b) }
  }
  return out
}

/** 扩展解压目录放哪：userData/browser-ext */
function extInstallDir () {
  return path.join(app.getPath('userData'), 'browser-ext')
}

/**
 * 「安装」扩展 = 把随包分发的解压目录复制到 userData/browser-ext。
 * 不写任何浏览器注册表。
 */
async function installExtension (srcDir, extId) {
  if (process.platform !== 'win32') throw new Error('仅支持 Windows')
  if (!fs.existsSync(path.join(srcDir, 'manifest.json'))) {
    throw new Error('找不到扩展源目录：' + srcDir)
  }
  const dest = extInstallDir()
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })
  fs.cpSync(srcDir, dest, { recursive: true })
  return { ...(await extState(extId)), dir: dest }
}

/** 「卸载」扩展 = 删掉那个解压目录 */
async function removeExtension (extId) {
  const dest = extInstallDir()
  try { fs.rmSync(dest, { recursive: true, force: true }) } catch {}
  return { ...(await extState(extId)), dir: null }
}

async function extState (extId) {
  const dir = extInstallDir()
  const installed = fs.existsSync(path.join(dir, 'manifest.json'))
  return {
    supported: process.platform === 'win32',
    id: extId,
    installed,
    dir: installed ? dir : null,
    browsers: detectBrowsers(),
  }
}

/** 打开浏览器的扩展管理页（引导用户点「加载解压缩的扩展」） */
async function openBrowserExtensionsPage (browserId) {
  const list = detectBrowsers()
  const b = list.find((x) => x.id === browserId) || list[0]
  if (!b) throw new Error('没有找到 Edge 或 Chrome')
  // 用 start 让浏览器自己新建标签页，不占用我们进程
  await new Promise((resolve) => {
    execFile('cmd.exe', ['/c', 'start', '', b.exe, b.page], { windowsHide: true }, () => resolve())
  })
  return { browser: b.name, page: b.page }
}

// ---------- 读取扩展元信息 ----------

/** 扩展源目录：打包后 resources/browser-ext/，开发期 app/browser-ext/ */
function extSourceDir () {
  const packed = path.join(process.resourcesPath || '', 'browser-ext')
  if (fs.existsSync(path.join(packed, 'manifest.json'))) return packed
  return path.join(__dirname, '..', 'browser-ext')
}

/** 从 app/browser-ext/manifest.json 读出扩展 id 与版本 */
function readExtMeta () {
  let version = '1.0.0'
  let id = null
  const src = extSourceDir()
  try {
    const mf = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'))
    version = mf.version || version
    // 扩展 id：由 manifest.key（公钥）SHA-256 前 16 字节映射 a–p 得到，
    // 构建时 make-crx.cjs 也按同一算法写进 build/ext-key.txt
    if (mf.key) {
      const crypto = require('node:crypto')
      const h = crypto.createHash('sha256').update(Buffer.from(mf.key, 'base64')).digest()
      let s = ''
      for (let i = 0; i < 16; i++) {
        s += String.fromCharCode(97 + (h[i] >> 4)) + String.fromCharCode(97 + (h[i] & 15))
      }
      id = s
    }
  } catch {}
  return { id, version, dir: src }
}

module.exports = {
  explorerMenuState, installExplorerMenu, removeExplorerMenu,
  extState, installExtension, removeExtension, readExtMeta,
  extInstallDir, extSourceDir, detectBrowsers, openBrowserExtensionsPage,
  MENU_KEY,
}
