'use strict'
// 对比：开启/关闭边缘优化，各出一张棋盘格预览，便于肉眼验收
const path = require('node:path')
const fs = require('node:fs')
const sharp = require('sharp')
const segment = require('../src/segment')

const MODEL = path.join(__dirname, '..', 'models', 'model_fp16.onnx')
const SRC = process.argv[2] || 'D:\\DeepSeekHarness\\userspace\\comfy-rmbg\\test-input\\desktop-photo-1.png'
const OUT = path.join(__dirname, '..', 'verify', 'refine')

async function checker (pngPath, dest) {
  const m = await sharp(pngPath).metadata()
  const t = 24
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${m.width}" height="${m.height}">
    <defs><pattern id="c" width="${t * 2}" height="${t * 2}" patternUnits="userSpaceOnUse">
      <rect width="${t * 2}" height="${t * 2}" fill="#ffffff"/>
      <rect width="${t}" height="${t}" fill="#e2e4ea"/>
      <rect x="${t}" y="${t}" width="${t}" height="${t}" fill="#e2e4ea"/>
    </pattern></defs><rect width="100%" height="100%" fill="url(#c)"/></svg>`
  await sharp(Buffer.from(svg)).composite([{ input: pngPath }]).png().toFile(dest)
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  for (const [tag, edge] of [['raw', false], ['refined', true]]) {
    const r = await segment.segment(SRC, { modelPath: MODEL, provider: 'auto', edge })
    const p = path.join(OUT, `${tag}.png`)
    fs.writeFileSync(p, r.png)
    await checker(p, path.join(OUT, `${tag}-checker.png`))
    console.log(tag, r.width + 'x' + r.height, r.ms + 'ms', JSON.stringify(segment.reportMaskStats(r.mask)), r.png.length + 'B')
  }
  // 边缘局部放大对比（头部左上角），看白边
  const box = { left: 380, top: 120, width: 420, height: 420 }
  for (const tag of ['raw', 'refined']) {
    await sharp(path.join(OUT, `${tag}-checker.png`)).extract(box)
      .resize(760, 760, { kernel: 'nearest' })
      .png().toFile(path.join(OUT, `${tag}-crop.png`))
  }
  console.log('crops written')
})().catch(e => { console.error('FAIL', e.message); process.exit(1) })
