'use strict'
/**
 * CutCut 抠图引擎（纯 JS，无需 Python / ComfyUI）
 *  - onnxruntime-node 加载 ONNX 模型
 *  - sharp 负责解码 / 缩放 / 合成
 *  - 输出：原尺寸 RGBA PNG Buffer + mask Buffer
 *
 * 支持两种模型（架构同源 BiRefNet，但 IO 契约不同）：
 *   rmbg      → 输入 pixel_values  / 输出 alphas        / 输出已 sigmoid，直接用
 *   birefnet  → 输入 input_image   / 输出 output_image  / 输出是 logits，需手动 sigmoid
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const SIZE = 1024
const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]

/** 每个模型的 IO 契约；新增模型只需在这里加一条 */
const MODELS = {
  rmbg: {
    id: 'rmbg',
    label: 'RMBG-2.0',
    files: ['model_fp16.onnx', 'model_quantized.onnx', 'model.onnx'],
    input: 'pixel_values',
    output: 'alphas',
    sigmoid: false,
    // BiRefNet 系列在 DirectML 上会因某个 fused node 直接失败，RMBG 的导出可正常走 GPU
    dml: true,
    note: 'BRIA 官方权重，质量最稳，仅限非商用（CC BY-NC 4.0）',
  },
  birefnet: {
    id: 'birefnet',
    label: 'BiRefNet',
    files: ['birefnet_fp32.onnx', 'birefnet_fp16.onnx', 'birefnet.onnx'],
    input: 'input_image',
    output: 'output_image',
    sigmoid: true,
    dml: false,
    note: 'MIT 授权，可商用；CPU 推理较慢',
  },
}

function modelSpec (modelId) {
  return MODELS[modelId] || MODELS.rmbg
}

let ort = null
let sharp = null
const sessions = new Map()   // key -> { session, provider }
let lastProvider = ''

function lazyLibs () {
  if (!ort) ort = require('onnxruntime-node')
  if (!sharp) sharp = require('sharp')
}

/**
 * 可选执行后端，按优先级排序
 * 有些模型在 DirectML 上会崩，这里按模型能力先过滤掉
 */
function providerCandidates (preferred, spec) {
  const allowDml = process.platform === 'win32' && spec.dml !== false
  if (preferred === 'cpu') return ['cpu']
  if (preferred === 'dml') return allowDml ? ['dml', 'cpu'] : ['cpu']
  return allowDml ? ['dml', 'cpu'] : ['cpu']
}

async function getSession (modelPath, provider, threads, spec) {
  lazyLibs()
  const key = `${modelPath}|${provider}|${threads}`
  const hit = sessions.get(key)
  if (hit) { lastProvider = hit.provider; return hit.session }

  if (!fs.existsSync(modelPath)) throw new Error(`模型文件不存在：${modelPath}`)

  const wanted = providerCandidates(provider, spec)
  let lastErr = null
  for (const ep of wanted) {
    try {
      const opts = {
        executionProviders: [ep],
        // 注意：'all' 会让部分 fp16 模型在 ORT 上初始化失败（SimplifyLayerNorm 融合缺常量），
        // 'extended' 已验证最稳妥，速度不受明显影响。
        graphOptimizationLevel: 'extended',
        logSeverityLevel: 3,
      }
      if (ep === 'cpu' && threads > 0) opts.intraOpNumThreads = threads
      const session = await ort.InferenceSession.create(modelPath, opts)
      sessions.set(key, { session, provider: ep })
      lastProvider = ep
      return session
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(`加载模型失败：${lastErr && lastErr.message}`)
}

/** 读图 -> 统一朝向 -> { rgb:Buffer(3ch), width, height } */
async function decode (inputPath) {
  lazyLibs()
  const { data, info } = await sharp(inputPath)
    .rotate()                      // 尊重 EXIF 方向，避免手机照片被旋转
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { rgb: data, width: info.width, height: info.height }
}

/** 3chRGB -> 1024x1024 归一化 Float32 CHW */
async function toTensorInput (rgb, width, height) {
  lazyLibs()
  const px = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .resize(SIZE, SIZE, { fit: 'fill', kernel: 'cubic' })
    .raw()
    .toBuffer()
  const N = SIZE * SIZE
  const out = new Float32Array(3 * N)
  for (let i = 0; i < N; i++) {
    const r = px[i * 3], g = px[i * 3 + 1], b = px[i * 3 + 2]
    out[i] = (r / 255 - MEAN[0]) / STD[0]
    out[N + i] = (g / 255 - MEAN[1]) / STD[1]
    out[N * 2 + i] = (b / 255 - MEAN[2]) / STD[2]
  }
  return out
}

/** mask(1024) -> 原尺寸单通道 Buffer。注意 sharp 会把 1 通道升到 3 通道，必须按 stride 取 */
async function upscaleMask (maskBuf, width, height) {
  lazyLibs()
  const { data, info } = await sharp(maskBuf, { raw: { width: SIZE, height: SIZE, channels: 1 } })
    .resize(width, height, { fit: 'fill', kernel: 'cubic' })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const ch = info.channels
  if (ch === 1) return data
  const out = Buffer.alloc(width * height)
  for (let i = 0; i < width * height; i++) out[i] = data[i * ch]
  return out
}

/**
 * 执行一次抠图
 * @param {string} inputPath
 * @param {{ modelPath:string, modelId?:string, provider?:string, threads?:number,
 *           edge?:boolean, invert?:boolean }} opts
 * @returns {Promise<{ png:Buffer, mask:Buffer, width:number, height:number,
 *                     ms:number, provider:string, modelId:string }>}
 */
async function segment (inputPath, opts = {}) {
  lazyLibs()
  const t0 = Date.now()
  const spec = modelSpec(opts.modelId)
  const sess = await getSession(opts.modelPath, opts.provider || 'auto', opts.threads ?? 0, spec)
  const img = await decode(inputPath)
  const input = await toTensorInput(img.rgb, img.width, img.height)

  const feeds = { [spec.input]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) }
  let out
  try {
    out = await sess.run(feeds)
  } catch (e) {
    throw new Error(`推理失败（${spec.label}）：${e.message}`)
  }
  const raw = out[spec.output] || out[Object.keys(out)[0]]
  if (!raw) throw new Error(`模型没有返回预期输出 ${spec.output}`)

  const data = raw.data
  const maskSmall = Buffer.alloc(SIZE * SIZE)
  for (let i = 0; i < maskSmall.length; i++) {
    let v = data[i]
    if (spec.sigmoid) v = 1 / (1 + Math.exp(-v))   // BiRefNet 输出是 logits
    if (opts.invert) v = 1 - v
    v = v < 0 ? 0 : v > 1 ? 1 : v
    maskSmall[i] = Math.round(v * 255)
  }

  const mask = await upscaleMask(maskSmall, img.width, img.height)

  // 边缘优化：对比度拉伸 + 去小块 + 去色溢（详见 refine.js 注释）
  const refine = require('./refine')
  const { rgba } = await refine.refineRgba({
    sharp, rgb: img.rgb, mask, width: img.width, height: img.height,
    edge: opts.edge !== false,
  })

  const png = await sharp(rgba, { raw: { width: img.width, height: img.height, channels: 4 } })
    .png({ compressionLevel: 9 }).toBuffer()

  return {
    png, mask,
    width: img.width, height: img.height,
    ms: Date.now() - t0,
    provider: lastProvider,
    modelId: spec.id,
  }
}

/** 白底合成（可选导出） */
async function flattenToJpeg (pngBuf, bg = { r: 255, g: 255, b: 255 }) {
  lazyLibs()
  return sharp(pngBuf).flatten({ background: bg }).jpeg({ quality: 92 }).toBuffer()
}

/** 给 UI 用的缩略预览（棋盘格 + 主体），避免在渲染进程里解大图 */
async function previewDataUrl (pngBuf, max = 900) {
  lazyLibs()
  const buf = await sharp(pngBuf)
    .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 6 })
    .toBuffer()
  return `data:image/png;base64,${buf.toString('base64')}`
}

function defaultThreads () {
  const n = os.cpus()?.length || 4
  return Math.max(1, Math.min(8, n - 1))
}

function reportMaskStats (mask) {
  let sum = 0, zero = 0, full = 0
  for (let i = 0; i < mask.length; i++) {
    const a = mask[i]
    sum += a
    if (a < 8) zero++
    else if (a > 247) full++
  }
  const n = mask.length || 1
  return {
    meanAlpha: +(sum / n).toFixed(1),
    transparentPct: +((zero / n) * 100).toFixed(1),
    opaquePct: +((full / n) * 100).toFixed(1),
  }
}

/**
 * DirectML 到底能不能用：不同机器上 ORT 的 EP 列表可能不含 dml，
 * 或者驱动太老建会话就失败。这里做一次轻量静态判断（不建会话、不加载模型），
 * 只反映「本机是否有 DML 提供器」，避免界面上写死一句不可信的「GPU 可用」。
 */
let dmlCache = null
function dmlAvailable () {
  if (dmlCache !== null) return dmlCache
  if (process.platform !== 'win32') return (dmlCache = false)
  try {
    lazyLibs()
    const list = ort.listSupportedBackends?.() || []
    dmlCache = list.some(b => /dml/i.test(b.name || b))
  } catch {
    dmlCache = false
  }
  return dmlCache
}

module.exports = {
  segment, flattenToJpeg, previewDataUrl, defaultThreads,
  reportMaskStats, modelSpec, MODELS, SIZE, dmlAvailable,
}
