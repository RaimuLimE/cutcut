'use strict'
/**
 * CutCut 图标生成：矢量 SVG -> 各尺寸 PNG -> Windows ICO
 *
 * 要点：
 *  - 直接从 SVG 渲染每个尺寸，小图标（16/24/32）才不会糊
 *  - ICO 用 PNG 帧格式（Vista+ 支持），无需 BMP/调色板
 *  - SVG 自带 rx=64 圆角与棋盘格背景，不要再加圆角或改色
 *  - 默认水平镜像（flop）：原版眼睛在下偏左，会被桌面快捷方式的左下角
 *    箭头角标压住；镜像后眼睛移到右侧，角标区域是干净的帽檐。
 *    设 ICON_FLOP=0 可关闭镜像还原原方向。
 */
const sharp = require('sharp')
const fs = require('node:fs')
const path = require('node:path')

const SRC = process.env.ICON_SVG ||
  'D:\\Users\\xiure\\Downloads\\柠檬魔女_圆角图标_表情修正版..svg'
const BUILD = path.join(__dirname, '..', 'build')
const SIZES = [16, 24, 32, 48, 64, 128, 256]
const FLOP = process.env.ICON_FLOP !== '0'

/** 把多张 PNG 打包成 ICO（每帧 6 字节目录项 + PNG 数据） */
function buildIco (frames) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)          // reserved
  header.writeUInt16LE(1, 2)          // type: 1 = icon
  header.writeUInt16LE(frames.length, 4)

  const dir = Buffer.alloc(16 * frames.length)
  let offset = 6 + dir.length
  frames.forEach((f, i) => {
    const p = i * 16
    dir.writeUInt8(f.size >= 256 ? 0 : f.size, p)      // width（256 记作 0）
    dir.writeUInt8(f.size >= 256 ? 0 : f.size, p + 1)  // height
    dir.writeUInt8(0, p + 2)                            // 调色板数
    dir.writeUInt8(0, p + 3)                            // reserved
    dir.writeUInt16LE(1, p + 4)                         // color planes
    dir.writeUInt16LE(32, p + 6)                        // bpp
    dir.writeUInt32LE(f.png.length, p + 8)
    dir.writeUInt32LE(offset, p + 12)
    offset += f.png.length
  })
  return Buffer.concat([header, dir, ...frames.map(f => f.png)])
}

;(async () => {
  fs.mkdirSync(BUILD, { recursive: true })
  if (!fs.existsSync(SRC)) throw new Error('找不到 SVG：' + SRC)
  const svg = fs.readFileSync(SRC)
  console.log('source:', SRC.split(/[\\/]/).pop(), fs.statSync(SRC).size + 'B')

  const frames = []
  for (const size of SIZES) {
    // 小尺寸锐化一点，避免边缘糊成灰雾
    let pipeline = sharp(svg, { density: Math.max(72, Math.ceil(size / 512 * 72 * 8)) })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    if (FLOP) pipeline = pipeline.flop()
    if (size <= 32) pipeline = pipeline.sharpen({ sigma: 0.6 })
    const png = await pipeline.png({ compressionLevel: 9 }).toBuffer()
    frames.push({ size, png })
  }

  // 主 PNG（UI logo + 窗口图标）：512
  let main = sharp(svg, { density: 288 })
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  if (FLOP) main = main.flop()
  await main.png({ compressionLevel: 9 }).toFile(path.join(BUILD, 'icon.png'))

  const ico = buildIco(frames)
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico)
  console.log('icon.png 512x512' + (FLOP ? ' (flopped)' : ''))
  console.log('icon.ico frames=' + SIZES.join(',') + ' ' + ico.length + 'B')
})().catch(e => { console.error('FAIL', e.message); process.exit(1) })
