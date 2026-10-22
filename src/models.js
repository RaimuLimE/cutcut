'use strict'
/**
 * 模型分发层：安装包里不再带模型，首次使用时按需下载到 userData/models。
 *
 * 设计要点
 *  - 断点续传：先写 <file>.part，靠 Range 续，完成后改名为正式文件
 *  - 完整性校验：下载/导入完成后按 SHA-256 全量校验，不匹配直接删除
 *  - 可取消：AbortController 中断网络流，.part 保留以便下次续传
 *  - 镜像可加：每个模型有 sources[]，第一源失败自动换下一个
 */
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 分发清单：byte/sha256 取自官方源，和 1.2.x 内置的模型文件逐字节一致 */
const CATALOG = {
  rmbg: {
    file: 'model_fp16.onnx',
    bytes: 513576499,
    sha256: '9dc47db40d113090ba5d7a13d8fcfd9ee4eda510ce92613219b2fe19da4746f6',
    sources: [
      {
        url: 'https://modelscope.cn/models/AI-ModelScope/RMBG-2.0/resolve/master/onnx/model_fp16.onnx',
        referer: 'https://modelscope.cn/',
      },
    ],
  },
  birefnet: {
    file: 'birefnet_fp32.onnx',
    bytes: 972666916,
    sha256: '58f621f00f5d756097615970a88a791584600dcf7c45b18a0a6267535a1ebd3c',
    sources: [
      // 官方 HF 仓库 onnx-community/BiRefNet-ONNX 里的 fp32 权重
      { url: 'https://hf-mirror.com/onnx-community/BiRefNet-ONNX/resolve/main/onnx/model.onnx' },
    ],
  },
}

function entry (id) { return CATALOG[id] || null }

function modelDir (userData) { return path.join(userData, 'models') }
function finalPath (userData, id) { return path.join(modelDir(userData), CATALOG[id].file) }
function partPath (userData, id) { return finalPath(userData, id) + '.part' }

function statSafe (p) {
  try { return fs.statSync(p) } catch { return null }
}

/** 只看体积，不做哈希（1 GB 每次启动都算一遍太慢）；下载/导入时已严格校验过 */
function installedAt (userData, id) {
  const p = finalPath(userData, id)
  const st = statSafe(p)
  return st && st.size === CATALOG[id].bytes ? p : null
}

/** 已下载但体积不对的文件（例如用户手动拷了个别的版本）视为不可用 */
function stateOf (userData, id) {
  const ent = CATALOG[id]
  const p = finalPath(userData, id)
  const st = statSafe(p)
  const part = statSafe(partPath(userData, id))
  return {
    id,
    file: ent.file,
    bytes: ent.bytes,
    sha256: ent.sha256,
    path: p,
    installed: !!(st && st.size === ent.bytes),
    broken: !!(st && st.size !== ent.bytes),
    partialBytes: part ? part.size : 0,
  }
}

function fmtMB (n) { return +(n / 1048576).toFixed(1) }

/** 流式算 SHA-256，边算边回调，避免再读一遍大文件 */
function hashFile (file, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    const total = statSafe(file)?.size || 0
    let done = 0
    const rs = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })
    let aborted = false
    const onAbort = () => { aborted = true; rs.destroy(new Error('已取消')) }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    rs.on('data', (chunk) => {
      h.update(chunk)
      done += chunk.length
      if (onProgress) onProgress({ received: done, total })
    })
    rs.on('error', (e) => { if (signal) signal.removeEventListener('abort', onAbort); reject(aborted ? new Error('已取消') : e) })
    rs.on('end', () => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve(h.digest('hex'))
    })
  })
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 下载单个源（支持续传）。返回临时文件路径 */
async function fetchToPart (src, ent, userData, id, opts) {
  const part = partPath(userData, id)
  let start = 0
  const st = statSafe(part)
  if (st && st.size <= ent.bytes) start = st.size
  else if (st) { await fsp.rm(part, { force: true }) }

  const headers = { 'User-Agent': UA, Accept: '*/*' }
  if (src.referer) headers.Referer = src.referer
  if (start > 0) headers.Range = `bytes=${start}-`

  const res = await fetch(src.url, { headers, redirect: 'follow', signal: opts.signal })
  if (!res.ok) {
    // 416 = 本地 .part 已经是完整文件
    if (res.status === 416) return part
    throw new Error(`HTTP ${res.status}`)
  }

  // 服务器忽略 Range 时（返回 200）只能从头写
  const resumed = res.status === 206
  if (start > 0 && !resumed) { start = 0; await fsp.rm(part, { force: true }) }

  const total = ent.bytes
  let received = start
  const out = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' })

  const t0 = Date.now()
  let lastEmit = 0
  let lastBytes = received
  let lastT = t0

  const report = (force) => {
    const now = Date.now()
    if (!force && now - lastEmit < 200) return
    lastEmit = now
    const dt = (now - lastT) / 1000
    const speed = dt > 0.25 ? (received - lastBytes) / dt : 0
    if (dt > 0.25) { lastBytes = received; lastT = now }
    opts.onProgress && opts.onProgress({
      phase: 'download',
      received,
      total,
      percent: total ? Math.min(100, (received / total) * 100) : 0,
      speed: Math.max(0, speed),
      source: src.url,
    })
  }

  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!out.write(Buffer.from(value))) await new Promise(r => out.once('drain', r))
      received += value.length
      report(false)
    }
  } finally {
    await new Promise((resolve, reject) => out.end(e => (e ? reject(e) : resolve())))
  }
  report(true)
  if (received !== total) throw new Error(`文件长度不符：期望 ${total}，实际 ${received}`)
  return part
}

/**
 * 下载模型
 * @param {string} id rmbg | birefnet
 * @param {string} userData app.getPath('userData')
 * @param {{ onProgress?:Function, signal?:AbortSignal }} opts
 */
async function download (id, userData, opts = {}) {
  const ent = entry(id)
  if (!ent) throw new Error('未知模型：' + id)
  if (installedAt(userData, id)) {
    opts.onProgress && opts.onProgress({ phase: 'done', percent: 100, received: ent.bytes, total: ent.bytes })
    return { ok: true, path: finalPath(userData, id), cached: true }
  }
  await fsp.mkdir(modelDir(userData), { recursive: true })

  let lastErr = null
  for (const src of ent.sources) {
    try {
      const part = await fetchToPart(src, ent, userData, id, opts)
      opts.onProgress && opts.onProgress({ phase: 'verify', percent: 100, received: ent.bytes, total: ent.bytes })
      const got = await hashFile(part, (p) => {
        opts.onProgress && opts.onProgress({
          phase: 'verify',
          received: p.received,
          total: p.total,
          percent: p.total ? (p.received / p.total) * 100 : 0,
          speed: 0,
        })
      }, opts.signal)
      if (got !== ent.sha256) {
        await fsp.rm(part, { force: true })
        throw new Error('SHA-256 校验失败，文件可能损坏，已删除')
      }
      await fsp.rename(part, finalPath(userData, id))
      opts.onProgress && opts.onProgress({ phase: 'done', percent: 100, received: ent.bytes, total: ent.bytes })
      return { ok: true, path: finalPath(userData, id) }
    } catch (e) {
      lastErr = e
      if (e && /已取消/.test(e.message)) throw e
      await sleep(300)
    }
  }
  throw new Error(`下载失败：${lastErr ? lastErr.message : '未知错误'}`)
}

/** 从本地文件导入（离线分发 / U 盘拷贝）。校验 SHA-256 后落到模型目录 */
async function importFile (id, userData, srcPath, opts = {}) {
  const ent = entry(id)
  if (!ent) throw new Error('未知模型：' + id)
  const st = statSafe(srcPath)
  if (!st) throw new Error('文件不存在：' + srcPath)
  if (st.size !== ent.bytes) {
    throw new Error(`体积不符：期望 ${fmtMB(ent.bytes)} MB，实际 ${fmtMB(st.size)} MB`)
  }
  await fsp.mkdir(modelDir(userData), { recursive: true })
  const part = partPath(userData, id)
  await fsp.copyFile(srcPath, part)
  opts.onProgress && opts.onProgress({ phase: 'verify', percent: 0, received: 0, total: st.size, speed: 0 })
  const got = await hashFile(part, (p) => {
    opts.onProgress && opts.onProgress({
      phase: 'verify', received: p.received, total: p.total,
      percent: p.total ? (p.received / p.total) * 100 : 0, speed: 0,
    })
  }, opts.signal)
  if (got !== ent.sha256) {
    await fsp.rm(part, { force: true })
    throw new Error('SHA-256 校验失败：这不是本应用支持的模型文件')
  }
  await fsp.rename(part, finalPath(userData, id))
  opts.onProgress && opts.onProgress({ phase: 'done', percent: 100, received: st.size, total: st.size })
  return { ok: true, path: finalPath(userData, id) }
}

async function remove (id, userData) {
  const ent = entry(id)
  if (!ent) throw new Error('未知模型：' + id)
  await fsp.rm(finalPath(userData, id), { force: true })
  await fsp.rm(partPath(userData, id), { force: true })
  return { ok: true }
}

module.exports = {
  CATALOG, entry, modelDir, finalPath, partPath,
  stateOf, installedAt, download, importFile, remove, hashFile, fmtMB,
}
