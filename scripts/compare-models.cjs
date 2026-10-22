'use strict'
/**
 * RMBG-2.0 vs BiRefNet 实测对比
 * 两个模型架构同源（BiRefNet），但 IO 契约不同：
 *   RMBG     : input pixel_values  -> output alphas        （已 sigmoid）
 *   BiRefNet : input input_image   -> output output_image  （未 sigmoid，需手动）
 */
const path = require('node:path')
const fs = require('node:fs')
const ort = require('onnxruntime-node')
const sharp = require('sharp')

const SIZE = 1024
const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]

const MODELS = {
  rmbg: {
    file: path.join(__dirname, '..', 'models', 'model_fp16.onnx'),
    input: 'pixel_values',
    output: 'alphas',
    sigmoid: false,
  },
  birefnet: {
    file: path.join(__dirname, '..', 'models', 'birefnet_fp16.onnx'),
    input: 'input_image',
    output: 'output_image',
    sigmoid: true,
  },
}

async function buildInput (inputPath) {
  const { data, info } = await sharp(inputPath)
    .rotate().removeAlpha().toColourspace('srgb').raw()
    .toBuffer({ resolveWithObject: true })
  const px = await sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } })
    .resize(SIZE, SIZE, { fit: 'fill', kernel: 'cubic' })
    .raw().toBuffer()
  const N = SIZE * SIZE
  const out = new Float32Array(3 * N)
  for (let i = 0; i < N; i++) {
    out[i] = (px[i * 3] / 255 - MEAN[0]) / STD[0]
    out[N + i] = (px[i * 3 + 1] / 255 - MEAN[1]) / STD[1]
    out[N * 2 + i] = (px[i * 3 + 2] / 255 - MEAN[2]) / STD[2]
  }
  return { tensor: out, width: info.width, height: info.height, rgb: data }
}

async function runOne (key, inputPath, sessions) {
  const m = MODELS[key]
  const t0 = Date.now()
  if (!sessions[key]) {
    sessions[key] = await ort.InferenceSession.create(m.file, {
      executionProviders: ['dml', 'cpu'],
      graphOptimizationLevel: 'extended',
      logSeverityLevel: 4,
    })
  }
  const sess = sessions[key]
  const img = await buildInput(inputPath)
  const feeds = { [m.input]: new ort.Tensor('float32', img.tensor, [1, 3, SIZE, SIZE]) }
  const tInfer = Date.now()
  const out = await sess.run(feeds)
  const inferMs = Date.now() - tInfer
  const raw = out[m.output].data

  const small = Buffer.alloc(SIZE * SIZE)
  for (let i = 0; i < small.length; i++) {
    let v = raw[i]
    if (m.sigmoid) v = 1 / (1 + Math.exp(-v))     // BiRefNet 输出是 logits
    v = v < 0 ? 0 : v > 1 ? 1 : v
    small[i] = Math.round(v * 255)
  }

  const { data, info } = await sharp(small, { raw: { width: SIZE, height: SIZE, channels: 1 } })
    .resize(img.width, img.height, { fit: 'fill', kernel: 'cubic' })
    .raw().toBuffer({ resolveWithObject: true })
  const ch = info.channels
  const mask = Buffer.alloc(img.width * img.height)
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * ch]

  const rgba = Buffer.alloc(img.width * img.height * 4)
  for (let i = 0; i < mask.length; i++) {
    rgba[i * 4] = img.rgb[i * 3]
    rgba[i * 4 + 1] = img.rgb[i * 3 + 1]
    rgba[i * 4 + 2] = img.rgb[i * 3 + 2]
    rgba[i * 4 + 3] = mask[i]
  }
  const png = await sharp(rgba, { raw: { width: img.width, height: img.height, channels: 4 } })
    .png({ compressionLevel: 9 }).toBuffer()

  let sum = 0, zero = 0, full = 0
  for (const a of mask) { sum += a; if (a < 8) zero++; else if (a > 247) full++ }
  const n = mask.length

  return {
    png, mask, width: img.width, height: img.height,
    inferMs, totalMs: Date.now() - t0,
    stats: {
      meanAlpha: +(sum / n).toFixed(1),
      transparentPct: +((zero / n) * 100).toFixed(1),
      opaquePct: +((full / n) * 100).toFixed(1),
    },
  }
}

/** 两个 mask 的像素级差异：平均绝对误差 + IoU（以 128 为阈值的二值化） */
function compareMasks (a, b) {
  if (a.length !== b.length) return { error: 'size mismatch' }
  let sumAbs = 0, inter = 0, union = 0
  for (let i = 0; i < a.length; i++) {
    sumAbs += Math.abs(a[i] - b[i])
    const pa = a[i] >= 128, pb = b[i] >= 128
    if (pa && pb) inter++
    if (pa || pb) union++
  }
  return {
    mae: +(sumAbs / a.length).toFixed(2),
    iou: +(inter / (union || 1)).toFixed(4),
    agreePct: +(((a.length - countDisagree(a, b)) / a.length) * 100).toFixed(2),
  }
}
function countDisagree (a, b) {
  let c = 0
  for (let i = 0; i < a.length; i++) if ((a[i] >= 128) !== (b[i] >= 128)) c++
  return c
}

;(async () => {
  const inputs = process.argv.slice(2)
  if (!inputs.length) { console.log('usage: node compare-models.cjs <img...>'); process.exit(1) }
  const OUT = path.join(__dirname, '..', 'verify', 'modelcmp')
  fs.mkdirSync(OUT, { recursive: true })

  const order = ['rmbg', 'rmbg', 'birefnet', 'birefnet']   // 各自 warm 一次
  const sessions = {}
  for (const k of order) await runOne(k, inputs[0], sessions)

  for (const img of inputs) {
    const base = path.basename(img, path.extname(img))
    console.log('\n=== ' + base + ' ===')
    const res = {}
    for (const k of ['rmbg', 'birefnet']) {
      const r = await runOne(k, img, sessions)
      res[k] = r
      fs.writeFileSync(path.join(OUT, `${base}.${k}.png`), r.png)
      console.log(`  ${k.padEnd(9)} infer=${String(r.inferMs).padStart(5)}ms  ${JSON.stringify(r.stats)}`)
      // 棋盘格预览
      const t = 24
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${r.width}" height="${r.height}">
        <defs><pattern id="c" width="${t * 2}" height="${t * 2}" patternUnits="userSpaceOnUse">
        <rect width="${t * 2}" height="${t * 2}" fill="#ffffff"/>
        <rect width="${t}" height="${t}" fill="#e2e4ea"/>
        <rect x="${t}" y="${t}" width="${t}" height="${t}" fill="#e2e4ea"/>
        </pattern></defs><rect width="100%" height="100%" fill="url(#c)"/></svg>`
      await sharp(Buffer.from(svg)).composite([{ input: r.png }]).png()
        .toFile(path.join(OUT, `${base}.${k}.checker.png`))
    }
    const cmp = compareMasks(res.rmbg.mask, res.birefnet.mask)
    console.log(`  差异      ${JSON.stringify(cmp)}`)
  }
  console.log('\n输出目录: ' + OUT)
})().catch(e => { console.error('FAIL', e.message); process.exit(1) })
