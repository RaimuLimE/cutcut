'use strict'
// 分析图标里「深色元素」（眼睛、剪刀、线条）的分布，用于决定是否需要镜像
const sharp = require('sharp')
const path = require('node:path')

const file = process.argv[2] || path.join(__dirname, '..', 'build', 'icon.png')

;(async () => {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true })
  const ch = info.channels, W = info.width, H = info.height
  console.log(`image ${W}x${H} ch=${ch}`)

  let left = 0, right = 0, tl = 0, tr = 0, bl = 0, br = 0
  let minx = W, maxx = 0, miny = H, maxy = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch
      const r = data[i], g = data[i + 1], b = data[i + 2], a = ch === 4 ? data[i + 3] : 255
      if (a > 128 && r < 60 && g < 60 && b < 70) {
        if (x < minx) minx = x
        if (x > maxx) maxx = x
        if (y < miny) miny = y
        if (y > maxy) maxy = y
        if (x < W / 2) left++; else right++
        if (y < H / 2) { if (x < W / 2) tl++; else tr++ } else { if (x < W / 2) bl++; else br++ }
      }
    }
  }
  console.log('dark pixels: left=' + left + ' right=' + right)
  console.log('quadrants: TL=' + tl + ' TR=' + tr + ' BL=' + bl + ' BR=' + br)
  if (maxx >= minx) {
    console.log(`dark bbox x ${minx}..${maxx} (${((minx + maxx) / 2 / W).toFixed(3)} of width)  y ${miny}..${maxy}`)
  }
})().catch(e => { console.error('FAIL', e.message); process.exit(1) })
