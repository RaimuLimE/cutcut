'use strict'
/**
 * 两个模型的质量 / 速度实测对比（直接走 segment.js，与应用内链路一致）
 */
const path = require('node:path')
const fs = require('node:fs')
const sharp = require('sharp')
const seg = require('../src/segment')

const ROOT = path.join(__dirname, '..')
const MODEL_DIR = path.join(ROOT, 'models')
const OUT = path.join(ROOT, 'verify', 'modelcmp')

const CASES = [
  { id: 'rmbg', file: 'model_fp16.onnx' },
  { id: 'birefnet', file: 'birefnet_fp32.onnx' },
]

function mae (a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
  return +(s / a.length).toFixed(2)
}
function iou (a, b) {
  let inter = 0, union = 0
  for (let i = 0; i < a.length; i++) {
    const pa = a[i] >= 128, pb = b[i] >= 128
    if (pa && pb) inter++
    if (pa || pb) union++
  }
  return +(inter / (union || 1)).toFixed(4)
}

async function checker (png, w, h, file) {
  const t = 24
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><pattern id="c" width="${t * 2}" height="${t * 2}" patternUnits="userSpaceOnUse">
    <rect width="${t * 2}" height="${t * 2}" fill="#ffffff"/>
    <rect width="${t}" height="${t}" fill="#e2e4ea"/>
    <rect x="${t}" y="${t}" width="${t}" height="${t}" fill="#e2e4ea"/>
    </pattern></defs><rect width="100%" height="100%" fill="url(#c)"/></svg>`
  await sharp(Buffer.from(svg)).composite([{ input: png }]).png().toFile(file)
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const inputs = process.argv.slice(2)
  if (!inputs.length) { console.error('usage: node compare.cjs <img...>'); process.exit(1) }

  for (const img of inputs) {
    const base = path.basename(img, path.extname(img))
    console.log('\n=== ' + base + ' ===')
    const got = {}
    for (const c of CASES) {
      const mp = path.join(MODEL_DIR, c.file)
      if (!fs.existsSync(mp)) { console.log(`  ${c.id}: 模型缺失 ${c.file}`); continue }
      const t = Date.now()
      try {
        const r = await seg.segment(img, { modelPath: mp, modelId: c.id, provider: 'auto' })
        got[c.id] = r
        fs.writeFileSync(path.join(OUT, `${base}.${c.id}.png`), r.png)
        await checker(r.png, r.width, r.height, path.join(OUT, `${base}.${c.id}.checker.png`))
        console.log(`  ${c.id.padEnd(9)} ${String(Date.now() - t).padStart(6)}ms  ${r.width}x${r.height}  ${JSON.stringify(seg.reportMaskStats(r.mask))}`)
      } catch (e) {
        console.log(`  ${c.id} FAIL: ${e.message}`)
      }
    }
    if (got.rmbg && got.birefnet) {
      console.log(`  差异      MAE=${mae(got.rmbg.mask, got.birefnet.mask)}  IoU=${iou(got.rmbg.mask, got.birefnet.mask)}`)
    }
  }
  console.log('\n输出: ' + OUT)
})()
