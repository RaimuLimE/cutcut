'use strict'
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, clipboard, globalShortcut } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')

const segment = require('./segment')
const models = require('./models')
const bridge = require('./bridge')
const integrations = require('./integrations')

const isDev = !app.isPackaged
let win = null

/** 启动前/运行中收到的「要处理的图片」，等渲染进程就绪后再塞进去 */
const pendingPaths = []
let bridgeHandle = null
let rendererReady = false

/**
 * 从命令行里挑出 --cutout 后面的文件路径（资源管理器右键 / 命令行都走这里）。
 *
 * 麻烦在于开发态（未打包）Electron 会把自己的开关和 app 路径插进 argv，
 * 实测 second-instance 拿到的是：
 *   [exe, --cutout, --allow-file-access-from-files, <app 目录>, <图片路径>]
 * 所以不能「取 --cutout 后的第一个参数」。这里改成：把 --cutout 之后所有
 * 非开关参数都收下，再只保留「真实存在、且有图片扩展名」的那些——
 * app 目录之类自然被过滤掉。同时兼容 --cutout=<路径>，并去掉引号。
 */
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|avif|heic|heif)$/i

function cutoutArgs (argv) {
  const out = []
  const clean = (p) => String(p).replace(/^"|"$/g, '')
  const push = (p) => {
    const s = clean(p)
    if (!s || s.startsWith('-') || s === '.') return
    if (!IMAGE_EXT.test(s)) return
    let ok = false
    try { ok = fs.existsSync(s) && fs.statSync(s).isFile() } catch { ok = false }
    if (ok && !out.includes(s)) out.push(s)
  }
  let armed = false
  for (const raw of argv) {
    const a = String(raw)
    if (a.startsWith('--cutout=')) { push(a.slice('--cutout='.length)); armed = false; continue }
    if (a === '--cutout') { armed = true; continue }
    if (armed) push(a)
  }
  return out
}

/** 把图片交给界面；渲染进程还没就绪就先排队 */
function deliverPaths (paths) {
  const list = paths.filter((p) => {
    try { return p && fs.existsSync(p) && fs.statSync(p).isFile() } catch { return false }
  })
  if (!list.length) return
  if (!rendererReady || !win || win.isDestroyed()) { pendingPaths.push(...list); return }

  win.webContents.send('app:openFiles', list)
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** 渲染进程挂好监听后调这里，把排队中的图片一次性发出去 */
function flushPending () {
  rendererReady = true
  if (!pendingPaths.length || !win || win.isDestroyed()) return
  const list = pendingPaths.splice(0)
  win.webContents.send('app:openFiles', list)
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * 模型放哪：userData/models 优先（1.3 起模型外置，首次运行下载到这里），
 * 其次安装目录 models/（兼容 1.2.x 的内置版），最后是仓库里的 models/（开发期）
 * 按模型 id 分别找，两个模型可以共存
 */
function modelCandidates (modelId) {
  const spec = segment.modelSpec(modelId)
  const roots = [
    path.join(app.getPath('userData'), 'models'),
    path.join(process.resourcesPath || __dirname, 'models'),
    path.join(__dirname, '..', 'models'),
  ]
  const out = []
  for (const root of roots) {
    for (const n of spec.files) out.push(path.join(root, n))
  }
  return out
}

function resolveModel (modelId) {
  for (const p of modelCandidates(modelId)) {
    try { if (fs.existsSync(p) && fs.statSync(p).size > 1024 * 1024) return p } catch {}
  }
  return null
}

/** 扫一遍所有已知模型，给 UI 展示「哪些可用」 */
function availableModels () {
  const out = []
  const ud = app.getPath('userData')
  for (const id of Object.keys(segment.MODELS)) {
    const p = resolveModel(id)
    const spec = segment.modelSpec(id)
    const st = models.stateOf(ud, id)
    out.push({
      id,
      label: spec.label,
      note: spec.note,
      gpu: spec.dml !== false,
      available: !!p,
      fileName: p ? path.basename(p) : null,
      sizeMB: p ? Math.round(fs.statSync(p).size / 1048576) : 0,
      // 下载相关：1.3 起模型不再随包分发
      downloadMB: models.fmtMB(st.bytes),
      partialMB: models.fmtMB(st.partialBytes),
      broken: st.broken,
    })
  }
  return out
}

function settingsPath () {
  return path.join(app.getPath('userData'), 'settings.json')
}
const DEFAULT_SETTINGS = {
  model: 'rmbg',             // rmbg | birefnet
  provider: 'auto',          // auto | dml | cpu
  outputDir: '',
  suffix: '-cutout',
  edgeRefine: true,          // 边缘优化（去白边/去杂点）
  theme: 'auto',             // light | dark | auto（auto = 白天浅色、夜间深色）
}

/** auto 主题：07:00–19:00 浅色，其余深色。与渲染进程同一套规则 */
const DAY_START = 7
const DAY_END = 19
function effectiveTheme (mode) {
  if (mode === 'light' || mode === 'dark') return mode
  const h = new Date().getHours()
  return (h >= DAY_START && h < DAY_END) ? 'light' : 'dark'
}
const THEME_BG = { dark: '#0f1115', light: '#f2f5fa' }

function readSettings () {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) } }
  catch { return { ...DEFAULT_SETTINGS } }
}
function writeSettings (s) {
  try { fs.mkdirSync(path.dirname(settingsPath()), { recursive: true }); fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2)) } catch {}
}

function createWindow () {
  const eff = effectiveTheme(readSettings().theme)
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 620,
    title: 'CutCut',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    // 与当前主题一致的底色，避免启动瞬间闪白/闪黑
    backgroundColor: THEME_BG[eff],
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  // 页面起来后把排队中的图片一次性交给界面（右键/命令行/桥可能在窗口之前就到）
  //
  // 这里必须等渲染进程「自己说准备好了」（app:ready），不能用 did-finish-load：
  // 后者在 HTML 解析完就触发，而渲染进程是在 init() 里一堆 await（读设置、拿
  // app:info）之后才挂 onOpenFiles 监听的。实测冷启动带 --cutout 时图片正是在
  // 这个空档里发出的，渲染进程收不到，界面显示「就绪」且没有卡片。
  win.webContents.on('did-finish-load', () => {
    // 兜底：渲染进程理论上会立刻发 app:ready，万一没发（脚本报错）也别让图片永远卡住
    setTimeout(() => { if (!rendererReady) flushPending() }, 3000)
  })
  // 开发期自动开 devtools；跑自动截图验收时用 CC_NO_DEVTOOLS=1 关掉，
  // 否则 detach 出来的窗口会让 capturePage 报 UnknownVizError
  if (isDev && !process.env.CC_NO_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' })
  win.on('closed', () => { win = null; rendererReady = false })
}

app.whenReady().then(async () => {
  // 打包后自检：CutCut.exe --selftest <输入图> [输出图]
  // 用于验证安装包在目标机器上模型与原生依赖都能加载
  const argv = process.argv.slice(1)
  const i = argv.indexOf('--selftest')
  if (i >= 0 && argv[i + 1]) {
    const input = argv[i + 1]
    const output = argv[i + 2] || path.join(path.dirname(input), 'selftest-cutout.png')
    const modelId = process.env.CC_MODEL || 'rmbg'
    const lines = []
    try {
      const modelPath = resolveModel(modelId)
      lines.push('model=' + modelId + ' path=' + (modelPath || 'NOT FOUND'))
      lines.push('electron=' + process.versions.electron + ' node=' + process.versions.node + ' packaged=' + app.isPackaged)
      if (!modelPath) throw new Error('未找到模型')
      const r = await segment.segment(input, {
        modelPath, modelId, provider: process.env.CC_EP || 'auto',
      })
      await fsp.writeFile(output, r.png)
      lines.push('provider=' + r.provider + ' size=' + r.width + 'x' + r.height + ' ms=' + r.ms)
      lines.push('stats=' + JSON.stringify(segment.reportMaskStats(r.mask)))
      lines.push('out=' + output)
      console.log('SELFTEST OK\n' + lines.join('\n'))
    } catch (e) {
      console.log('SELFTEST FAIL\n' + lines.join('\n') + '\nerror=' + e.message)
    }
    return app.quit()
  }

  // 单实例：资源管理器里多选图片会起多个进程，都合并到第一个窗口
  if (!app.requestSingleInstanceLock()) { app.quit(); return }
  app.on('second-instance', (_e, cmdline) => {
    if (process.env.CC_DEBUG) console.log('[second-instance] cmdline=' + JSON.stringify(cmdline))
    const paths = cutoutArgs(cmdline.slice(1))
    if (process.env.CC_DEBUG) console.log('[second-instance] paths=' + JSON.stringify(paths))
    if (paths.length) deliverPaths(paths)
    else if (win && !win.isDestroyed()) { win.show(); win.focus() }
  })

  createWindow()
  syncNativeTheme()

  // 命令行带 --cutout 的图片（首次启动，例如从资源管理器右键「用 CutCut 抠出主体」）
  const initial = cutoutArgs(argv)
  if (initial.length) pendingPaths.push(...initial)

  // 本地桥：给浏览器扩展用。失败不致命，界面上不依赖它
  try {
    bridgeHandle = await bridge.start({
      version: app.getVersion(),
      onImage: (p) => deliverPaths([p]),
    })
  } catch (e) {
    console.warn('本地桥启动失败：' + e.message)
  }

  // 全局热键：复制了图片后按 Ctrl+Alt+X，直接抠剪贴板里的图
  try {
    globalShortcut.register('Control+Alt+X', () => cutoutFromClipboard())
  } catch {}

  // auto 模式下主进程也每分钟对一次表，让标题栏跟随 07:00 / 19:00 切换
  let lastEff = effectiveTheme(readSettings().theme)
  setInterval(() => {
    const eff = effectiveTheme(readSettings().theme)
    if (eff !== lastEff) { lastEff = eff; syncNativeTheme() }
  }, 30000)
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

/**
 * 把剪贴板里的位图存成临时 PNG 交给界面。
 *
 * Electron 44 起 clipboard 换成了 Web 标准的异步 API：
 * 原来的 clipboard.readImage() 已被移除，现在只能
 *   const items = await clipboard.read('image/png')   // -> ClipboardItem[]
 *   const blob = await items[0].getType('image/png')  // -> Blob（getType 也返回 Promise）
 *   const bytes = Buffer.from(await blob.arrayBuffer())
 * 另外从资源管理器复制文件时剪贴板里是 text/uri-list，要解析出文件路径。
 */
async function clipboardImageBytes () {
  const items = await clipboard.read('image/png')
  const first = Array.isArray(items) ? items[0] : null
  if (!first || typeof first.getType !== 'function') return null
  const blob = await first.getType('image/png')
  if (!blob || typeof blob.arrayBuffer !== 'function' || !blob.size) return null
  return Buffer.from(await blob.arrayBuffer())
}

/** 从 text/uri-list 里解析出本地文件路径（资源管理器「复制」走这条） */
async function clipboardFilePaths () {
  const out = []
  const push = (s) => {
    if (!s) return
    if (s.startsWith('file://')) {
      try { out.push(decodeURIComponent(new URL(s).pathname).replace(/^\/([A-Za-z]:)/, '$1')) } catch {}
    } else if (/^[A-Za-z]:[\\/]/.test(s) && !out.includes(s)) {
      out.push(s)
    }
  }
  try {
    const items = await clipboard.read('text/uri-list')
    for (const it of Array.isArray(items) ? items : []) {
      // getType 可能给 string，也可能给 Blob（本机实测是 Blob），两种都兜住
      const v = await it.getType('text/uri-list')
      let txt = ''
      if (typeof v === 'string') txt = v
      else if (v && typeof v.text === 'function') txt = await v.text()
      for (const line of String(txt).split(/\r?\n/)) {
        const s = line.trim()
        if (s && !s.startsWith('#')) push(s)
      }
    }
  } catch {}
  return out
}

async function cutoutFromClipboard () {
  const toast = (m) => { if (win && !win.isDestroyed()) win.webContents.send('app:toast', m) }
  try {
    let bytes = null
    try { bytes = await clipboardImageBytes() } catch (e) {
      console.warn('读取剪贴板位图失败：' + e.message)
    }
    if (bytes) {
      const dir = path.join(os.tmpdir(), 'cutcut-bridge')
      await fsp.mkdir(dir, { recursive: true })
      const p = path.join(dir, `clip-${Date.now()}.png`)
      await fsp.writeFile(p, bytes)
      deliverPaths([p])
      return
    }
    // 复制的是文件而不是位图：直接拿文件路径
    const files = await clipboardFilePaths()
    if (files.length) { deliverPaths(files); return }
    toast('剪贴板里没有图片')
  } catch (e) {
    toast('读取剪贴板失败：' + e.message)
  }
}

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll() } catch {}
  try { bridgeHandle && bridgeHandle.close() } catch {}
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// ---------- IPC ----------

// 渲染进程在 init() 末尾挂好 onOpenFiles 之后发这个，主进程再把排队图片发出去
ipcMain.on('app:ready', () => flushPending())

ipcMain.handle('app:info', async () => {
  const s = readSettings()
  const model = resolveModel(s.model)
  return {
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    model: s.model,
    modelPath: model,
    modelName: model ? path.basename(model) : null,
    modelSizeMB: model ? Math.round(fs.statSync(model).size / 1048576) : 0,
    models: availableModels(),
    userData: app.getPath('userData'),
    threads: segment.defaultThreads(),
    cpus: os.cpus()?.length || 0,
    // DirectML 是否真的能用：只有 DML 会话能建起来才算，失败会被 catch 成 false
    dml: segment.dmlAvailable(),
  }
})

ipcMain.handle('settings:get', () => readSettings())
ipcMain.handle('settings:set', (_e, s) => {
  writeSettings({ ...readSettings(), ...s })
  if (s && 'theme' in s) syncNativeTheme()
  return readSettings()
})

/** 让窗口标题栏 / 原生控件跟随应用主题，而不是跟随系统 */
function syncNativeTheme () {
  const eff = effectiveTheme(readSettings().theme)
  try { nativeTheme.themeSource = eff } catch {}
  if (win && !win.isDestroyed()) {
    try { win.setBackgroundColor(THEME_BG[eff]) } catch {}
  }
}

ipcMain.handle('dialog:pickImages', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择图片',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'gif'] }],
  })
  return r.canceled ? [] : r.filePaths
})

ipcMain.handle('dialog:pickOutput', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择输出文件夹', properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})

ipcMain.handle('shell:openPath', async (_e, p) => { if (p) await shell.openPath(p) })
ipcMain.handle('shell:showItem', async (_e, p) => { if (p) shell.showItemInFolder(p) })

// ---------- 系统集成：右键菜单 / 浏览器扩展 ----------

/**
 * 扩展元信息（id / 版本 / 源目录）。
 * 1.4 起不再分发 crx，也不再往浏览器注册表里写外部扩展 ——
 * 实测新版 Edge 会直接屏蔽注册表外置的自签 CRX（ERR_BLOCKED_BY_CLIENT），
 * 改为把解压目录复制到 userData，由用户点一次「加载解压缩的扩展」。
 */
function extMeta () {
  return integrations.readExtMeta()
}

async function integrationState () {
  const meta = extMeta()
  const menu = await integrations.explorerMenuState()
  const ext = await integrations.extState(meta.id)
  return {
    platform: process.platform,
    exe: process.execPath,
    menu,
    ext: { ...ext, id: meta.id, version: meta.version, dir: ext.dir || meta.dir },
  }
}

ipcMain.handle('integration:state', () => integrationState())

ipcMain.handle('integration:menu', async (_e, on) => {
  try {
    if (on) await integrations.installExplorerMenu(process.execPath)
    else await integrations.removeExplorerMenu()
    return { ok: true, state: await integrationState() }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('integration:ext', async (_e, on) => {
  try {
    const meta = extMeta()
    if (!meta.id) throw new Error('扩展信息缺失（manifest.json 里没有 key）')
    if (on) await integrations.installExtension(meta.dir, meta.id)
    else await integrations.removeExtension(meta.id)
    return { ok: true, state: await integrationState() }
  } catch (e) { return { ok: false, error: e.message } }
})

/** 打开浏览器的扩展管理页，引导用户点「加载解压缩的扩展」 */
ipcMain.handle('integration:openExtPage', async (_e, browserId) => {
  try { return { ok: true, ...(await integrations.openBrowserExtensionsPage(browserId)) } }
  catch (e) { return { ok: false, error: e.message } }
})

/** 把扩展目录位置显示出来，方便用户在扩展页里选 */
ipcMain.handle('integration:showExtDir', async () => {
  const dir = integrations.extInstallDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
    await shell.showItemInFolder(path.join(dir, 'manifest.json'))
    return { ok: true, dir }
  } catch (e) { return { ok: false, error: e.message, dir } }
})

/** 手动触发一次剪贴板抠图（与 Ctrl+Alt+X 等价，也便于菜单/按钮调用） */
ipcMain.handle('app:clipboard', async () => { await cutoutFromClipboard(); return true })

// ---------- 模型管理（1.3：模型外置，首次运行下载） ----------

/** 正在进行的下载：id -> AbortController */
const downloads = new Map()

function sendModelProgress (payload) {
  if (win && !win.isDestroyed()) win.webContents.send('model:progress', payload)
}

ipcMain.handle('model:list', () => availableModels())

ipcMain.handle('model:download', async (_e, id) => {
  if (downloads.has(id)) return { ok: false, error: '该模型正在下载中' }
  const ac = new AbortController()
  downloads.set(id, ac)
  try {
    const r = await models.download(id, app.getPath('userData'), {
      signal: ac.signal,
      onProgress: (p) => sendModelProgress({ id, ...p }),
    })
    return { ok: true, path: r.path, models: availableModels() }
  } catch (e) {
    sendModelProgress({ id, phase: 'error', error: e.message })
    return { ok: false, error: e.message }
  } finally {
    downloads.delete(id)
  }
})

ipcMain.handle('model:cancel', (_e, id) => {
  const ac = downloads.get(id)
  if (ac) { ac.abort(); return { ok: true } }
  return { ok: false, error: '没有正在进行的下载' }
})

ipcMain.handle('model:import', async (_e, id) => {
  const r = await dialog.showOpenDialog(win, {
    title: `选择 ${segment.modelSpec(id).label} 的 ONNX 文件`,
    properties: ['openFile'],
    filters: [{ name: 'ONNX 模型', extensions: ['onnx'] }],
  })
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true }
  const ac = new AbortController()
  downloads.set(id, ac)
  try {
    const out = await models.importFile(id, app.getPath('userData'), r.filePaths[0], {
      signal: ac.signal,
      onProgress: (p) => sendModelProgress({ id, ...p }),
    })
    return { ok: true, path: out.path, models: availableModels() }
  } catch (e) {
    sendModelProgress({ id, phase: 'error', error: e.message })
    return { ok: false, error: e.message }
  } finally {
    downloads.delete(id)
  }
})

ipcMain.handle('model:remove', async (_e, id) => {
  try {
    await models.remove(id, app.getPath('userData'))
    return { ok: true, models: availableModels() }
  } catch (e) { return { ok: false, error: e.message } }
})

/** 打开模型目录（放离线文件 / 手动清理用） */
ipcMain.handle('model:openDir', async () => {
  const dir = models.modelDir(app.getPath('userData'))
  fs.mkdirSync(dir, { recursive: true })
  await shell.openPath(dir)
})

/** 单张处理：返回 { ok, dataUrl, width, height, ms, provider, outPath? } */
ipcMain.handle('image:cutout', async (_e, { inputPath, save, outputDir }) => {
  const s = readSettings()
  const t0 = Date.now()
  try {
    const modelId = s.model || 'rmbg'
    const modelPath = resolveModel(modelId)
    if (!modelPath) {
      const spec = segment.modelSpec(modelId)
      throw new Error(`未找到 ${spec.label} 模型文件（${spec.files[0]}），请把模型放到 userData/models/`)
    }
    const r = await segment.segment(inputPath, {
      modelPath, modelId, provider: s.provider, edge: s.edgeRefine !== false,
    })
    const dataUrl = await segment.previewDataUrl(r.png, 1400)

    let outPath = null
    if (save) {
      const dir = outputDir || s.outputDir || path.join(path.dirname(inputPath), 'cutout')
      await fsp.mkdir(dir, { recursive: true })
      const base = path.basename(inputPath, path.extname(inputPath))
      outPath = path.join(dir, `${base}${s.suffix || '-cutout'}.png`)
      let n = 1
      while (fs.existsSync(outPath)) { outPath = path.join(dir, `${base}${s.suffix || '-cutout'}-${n++}.png`) }
      await fsp.writeFile(outPath, r.png)
    }
    return { ok: true, name: path.basename(inputPath), dataUrl, ms: Date.now() - t0, provider: r.provider, outPath, width: r.width, height: r.height }
  } catch (e) {
    return { ok: false, name: path.basename(inputPath), error: e.message }
  }
})

ipcMain.handle('image:saveAs', async (_e, { dataUrl, suggested }) => {
  const r = await dialog.showSaveDialog(win, {
    title: '另存为',
    defaultPath: suggested || 'cutout.png',
    filters: [{ name: 'PNG 透明图', extensions: ['png'] }],
  })
  if (r.canceled || !r.filePath) return null
  const b64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, '')
  await fsp.writeFile(r.filePath, Buffer.from(b64, 'base64'))
  return r.filePath
})
