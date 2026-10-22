'use strict'
/**
 * 无界面验收：直接跑两个模型 + 出棋盘格预览 + 极性统计
 * 不依赖 Electron / 图片捕获，纯 Node 就能跑。
 *
 * 用法：
 *   node verify-models.cjs                 # 用自动生成的测试图（一条命令就能冒烟）
 *   node verify-models.cjs a.png b.webp    # 指定图片
 *
 * 模型从这些位置依次找（1.3 起模型不随包分发，开发期常常只在 userData 里）：
 *   $CC_MODEL_DIR → 仓库 ../models → %APPDATA%/cutcut/models
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const sharp = require('sharp')
const seg = require('../src/segment')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'verify', 'models')

function modelDirs () {
  const list = []
  if (process.env.CC_MODEL_DIR) list.push(process.env.CC_MODEL_DIR)
  list.push(path.join(ROOT, 'models'))
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  list.push(path.join(appData, 'cutcut', 'models'))
  return list
}

function findModel (spec) {
  for (const dir of modelDirs()) {
    for (const n of spec.files) {
      const p = path.join(dir, n)
      try { if (fs.existsSync(p) && fs.statSync(p).size > 1048576) return p } catch {}
    }
  }
  return null
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

/** 没有给样图时自己造一张：浅灰渐变背景 + 中间一个饱和彩色「主体」 */
async function makeSample (file) {
  const w = 900; const h = 1200
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#dfe4ec"/><stop offset="1" stop-color="#c3cbd8"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#bg)"/>
    <ellipse cx="${w / 2}" cy="${h * 0.34}" rx="150" ry="170" fill="#e2603f"/>
    <path d="M ${w * 0.22} ${h * 0.95}
             C ${w * 0.24} ${h * 0.62}, ${w * 0.76} ${h * 0.62}, ${w * 0.78} ${h * 0.95} Z"
          fill="#2f6fed"/>
  </svg>`
  await sharp(Buffer.from(svg)).png().toFile(file)
  return file
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })

  let inputs = process.argv.slice(2)
  if (!inputs.length) {
    const sample = path.join(OUT, 'sample.png')
    await makeSample(sample)
    inputs = [sample]
    console.log('未指定样图，使用自动生成的测试图：' + sample)
  }
  for (const f of inputs) {
    if (!fs.existsSync(f)) { console.error('找不到图片：' + f); process.exit(1) }
  }

  let fail = 0
  let ran = 0
  for (const id of Object.keys(seg.MODELS)) {
    const spec = seg.modelSpec(id)
    const mp = findModel(spec)
    console.log(`\n### ${id} (${spec.label})  ${mp ? path.basename(mp) : '未安装'}`)
    if (!mp) { console.log('  SKIP 模型缺失（安装版首次运行会下载到 ' + modelDirs()[2] + '）'); continue }

    for (const img of inputs) {
      const base = path.basename(img, path.extname(img))
      const t = Date.now()
      try {
        const r = await seg.segment(img, { modelPath: mp, modelId: id, provider: 'auto' })
        const st = seg.reportMaskStats(r.mask)
        const out = path.join(OUT, `${base}.${id}.png`)
        fs.writeFileSync(out, r.png)
        await checker(r.png, r.width, r.height, path.join(OUT, `${base}.${id}.checker.png`))
        // 极性自检：透明率或就是不透明率接近 100% 视为异常
        const bad = st.transparentPct > 95 || st.opaquePct > 95 || st.transparentPct < 3
        if (bad) fail++
        ran++
        console.log(`  ${base.padEnd(18)} ${String(Date.now() - t).padStart(6)}ms  ${r.provider.padEnd(3)}  ${r.width}x${r.height}  ` +
          `T=${st.transparentPct}% O=${st.opaquePct}% mean=${st.meanAlpha}  ${bad ? '!! 极性可疑' : 'ok'}`)
      } catch (e) {
        fail++
        console.log(`  ${base.padEnd(18)} FAIL: ${e.message}`)
      }
    }
  }
  console.log(`\n输出目录: ${OUT}`)
  if (!ran) {
    console.log('\n一个模型都没跑（本机没装模型）。这不算失败——打包不依赖模型文件。')
    process.exit(0)
  }
  console.log(fail ? `\n有 ${fail} 项异常` : '\n全部通过')
  process.exit(fail ? 1 : 0)
})()
