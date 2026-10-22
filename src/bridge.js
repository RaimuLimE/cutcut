'use strict'
/**
 * 本地桥：给浏览器扩展一个「把网页图片交给 CutCut」的通道。
 *
 * 只监听 127.0.0.1，端口从 8770 起顺延（扩展会依次试 8770..8779）。
 * 安全策略：
 *  - 只接受 Origin 为 chrome-extension:// / edge-extension:// / moz-extension://
 *    或不带 Origin 的请求；网页（https:// 站点）的 Origin 不允许，直接 403。
 *  - 额外要求 X-CutCut: 1 头，避免被 <form>/<img> 之类的简单请求误触。
 *  - 只收图片字节，最大 64 MB。
 */
const http = require('node:http')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const HOST = '127.0.0.1'
const PORTS = [8770, 8771, 8772, 8773, 8774, 8775, 8776, 8777, 8778, 8779]
const MAX_BODY = 64 * 1024 * 1024

const EXT_ORIGIN = /^(chrome|edge|moz|ms-browser)-extension:\/\//i

/** 按 magic 判图片格式，返回 {ext, mime} */
function sniff (buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return { ext: '.png', mime: 'image/png' }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { ext: '.webp', mime: 'image/webp' }
  if (buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF') return { ext: '.gif', mime: 'image/gif' }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return { ext: '.bmp', mime: 'image/bmp' }
  if (buf.length >= 4 && (buf.readUInt32BE(0) === 0x49492a00 || buf.readUInt32BE(0) === 0x4d4d002a)) return { ext: '.tif', mime: 'image/tiff' }
  return null
}

function corsHeaders (origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-CutCut',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  }
}

function sendJson (res, code, obj, origin) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...corsHeaders(origin) })
  res.end(body)
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { reject(new Error('图片太大（超过 64 MB）')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 把收到的字节写成临时文件，返回路径。文件名带毫秒时间戳，保证 addPaths 去重不会误合并 */
async function saveTemp (buf) {
  const dir = path.join(os.tmpdir(), 'cutcut-bridge')
  await fsp.mkdir(dir, { recursive: true })
  const fmt = sniff(buf) || { ext: '.png', mime: 'image/png' }
  const name = `web-${Date.now()}${fmt.ext}`
  const p = path.join(dir, name)
  await fsp.writeFile(p, buf)
  return p
}

/** 启动一次，清理一天前的临时图，避免堆积 */
async function cleanOld (days = 1) {
  const dir = path.join(os.tmpdir(), 'cutcut-bridge')
  try {
    const out = await fsp.readdir(dir)
    const cut = Date.now() - days * 86400000
    for (const n of out) {
      const p = path.join(dir, n)
      try { const st = await fsp.stat(p); if (st.mtimeMs < cut) await fsp.unlink(p) } catch {}
    }
  } catch {}
}

/**
 * @param {object} opts
 * @param {(filePath:string)=>void} opts.onImage 收到一张图片时回调（主进程里推给渲染进程）
 * @param {()=>string} [opts.version]
 * @returns {Promise<{port:number, close:()=>Promise<void>}>}
 */
async function start ({ onImage, version = () => '' }) {
  const ver = typeof version === 'function' ? version : () => String(version || '')
  await cleanOld()
  let lastErr = null
  for (const port of PORTS) {
    const server = http.createServer(async (req, res) => {
      const origin = req.headers.origin || ''
      const url = (req.url || '/').split('?')[0]

      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(origin))
        return res.end()
      }

      if (url === '/ping') {
        return sendJson(res, 200, { ok: true, app: 'CutCut', version: ver() }, origin)
      }

      if (url !== '/cutout') return sendJson(res, 404, { ok: false, error: 'not found' }, origin)

      // Origin 白名单：网页站点一律拒绝
      if (origin && !EXT_ORIGIN.test(origin)) {
        return sendJson(res, 403, { ok: false, error: 'forbidden origin' }, origin)
      }
      if (String(req.headers['x-cutcut'] || '') !== '1') {
        return sendJson(res, 400, { ok: false, error: 'missing X-CutCut header' }, origin)
      }
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' }, origin)

      try {
        const buf = await readBody(req)
        if (!buf.length) return sendJson(res, 400, { ok: false, error: '空请求体' }, origin)
        if (!sniff(buf)) return sendJson(res, 415, { ok: false, error: '不是可识别的图片' }, origin)
        const p = await saveTemp(buf)
        onImage(p)
        return sendJson(res, 200, { ok: true, path: p, bytes: buf.length }, origin)
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message }, origin)
      }
    })

    const ok = await new Promise((resolve) => {
      server.once('error', (e) => { lastErr = e; resolve(false) })
      server.listen(port, HOST, () => resolve(true))
    })
    if (ok) {
      // 记录端口，方便排查（扩展自己会依次试，不依赖这个文件）
      try {
        const dir = path.join(os.tmpdir(), 'cutcut-bridge')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'port.txt'), String(port))
      } catch {}
      return {
        port,
        close: () => new Promise((r) => server.close(() => r())),
      }
    }
  }
  throw new Error('没有可用端口（8770–8779 都被占用了）：' + (lastErr && lastErr.message))
}

module.exports = { start, PORTS, sniff }
