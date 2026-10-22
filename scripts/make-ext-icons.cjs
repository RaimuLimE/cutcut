'use strict'
// 用 app 的图标生成浏览器扩展需要的 16/32/48/128 四张 png
const sharp = require('sharp')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'build', 'icon.png')
const OUT = path.join(ROOT, 'browser-ext', 'icons')

async function main () {
  if (!fs.existsSync(SRC)) throw new Error('缺少 build/icon.png，先跑 node scripts/make-icon.cjs')
  fs.mkdirSync(OUT, { recursive: true })
  for (const size of [16, 32, 48, 128]) {
    let img = sharp(SRC).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    if (size <= 32) img = img.sharpen({ sigma: 0.6 })
    const out = path.join(OUT, `icon${size}.png`)
    const info = await img.png({ compressionLevel: 9 }).toFile(out)
    console.log(`icon${size}.png ${info.width}x${info.height} ${info.size}B`)
  }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1 })
