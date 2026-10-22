'use strict'
/**
 * 模拟 Windows 桌面快捷方式外观：把 icon.ico 各尺寸渲染出来，
 * 并在左下角叠加一个「快捷方式箭头」角标，检查主体是否被遮挡。
 */
const sharp = require('sharp')
const fs = require('node:fs')
const path = require('node:path')

const ICO = path.join(__dirname, '..', 'build', 'icon.ico')
const OUT = path.join(__dirname, '..', 'verify', 'icon-shortcut-mock.png')
const SHOW = [16, 32, 48, 256]

/** 从 ICO 里按尺寸取出 PNG 帧 */
function readIcoFrames (buf) {
  const count = buf.readUInt16LE(4)
  const frames = []
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 16
    const w = buf.readUInt8(p) || 256
    const len = buf.readUInt32LE(p + 8)
    const off = buf.readUInt32LE(p + 12)
    frames.push({ size: w, png: buf.subarray(off, off + len) })
  }
  return frames
}

;(async () => {
  const frames = readIcoFrames(fs.readFileSync(ICO))
  console.log('ico frames:', frames.map(f => f.size).join(','))

  // 快捷方式箭头：一个白色圆角方块 + 深色折角箭头，占左下角约 46%
  const arrowSvg = (size) => {
    const s = Math.round(size * 0.46)
    return Buffer.from(`<svg width="${s}" height="${s}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${s}" height="${s}" rx="${Math.round(s * 0.28)}" fill="#ffffff" opacity="0.97"/>
      <path d="M${s * 0.30} ${s * 0.34} L${s * 0.30} ${s * 0.70} L${s * 0.72} ${s * 0.70} Z" fill="#2b2b2b"/>
      <path d="M${s * 0.30} ${s * 0.34} L${s * 0.60} ${s * 0.64} L${s * 0.30} ${s * 0.64} Z" fill="#2b2b2b"/>
    </svg>`)
  }

  const tiles = []
  for (const size of SHOW) {
    const frame = frames.find(f => f.size === size) || frames.find(f => f.size === 256)
    const big = size < 256 ? 256 : size          // 放大展示用
    const base = await sharp(frame.png)
      .resize(big, big, { kernel: 'nearest' })
      .png().toBuffer()
    const aSize = Math.round(big * 0.46)
    const withArrow = await sharp(base)
      .composite([{ input: arrowSvg(big), left: 0, top: big - aSize }])
      .png().toBuffer()
    tiles.push({ size, base, withArrow, big })
  }

  const gap = 24
  const cellW = 256
  const cellH = 256 + 34
  const W = tiles.length * cellW + gap * 2
  const H = cellH + gap * 2
  const canvas = sharp({
    create: { width: W, height: H, channels: 4, background: { r: 18, g: 21, b: 27, alpha: 255 } }
  })
  const comps = []
  tiles.forEach((t, i) => {
    const x = gap + i * cellW + Math.round((cellW - 256) / 2)
    comps.push({ input: t.withArrow, left: x, top: gap })
    comps.push({
      input: Buffer.from(`<svg width="256" height="30"><text x="128" y="21" font-family="Segoe UI" font-size="17" fill="#9aa6bb" text-anchor="middle">${t.size}px</text></svg>`),
      left: x, top: gap + 256 + 2
    })
  })
  await canvas.composite(comps).png().toFile(OUT)
  console.log('written', OUT, W + 'x' + H)
})().catch(e => { console.error('FAIL', e.message); process.exit(1) })
