'use strict'
/**
 * 蒙版后处理 —— 解决实测暴露的三类瑕疵：
 *   1. 边缘灰白雾状残留（模型的低置信过渡带）
 *   2. 主体边缘"白边/光晕"（原背景颜色溢出到半透明像素）
 *   3. 孤立噪点与水印类小色块（模型误判为前景）
 *
 * 全程无外部依赖（sharp 由调用方传入），不改模型、不联网。
 */

/** 1) alpha 对比度拉伸：把 0.12~0.88 的软过渡带拉成硬边，压掉雾状残留 */
function stretchAlpha (mask, lo = 0.12, hi = 0.88) {
  const a = Math.max(0, Math.min(0.49, lo)) * 255
  const b = Math.max(0.51, Math.min(1, hi)) * 255
  const k = 255 / (b - a)
  for (let i = 0; i < mask.length; i++) {
    let v = (mask[i] - a) * k
    mask[i] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v)
  }
  return mask
}

/**
 * 2) 去小块：连通域分析，把面积小于 minPx 的前景块整块抹掉（水印、杂物）
 *    只处理"整块都很小"的成分，主体内部的洞不会被动到。
 */
function despeckle (mask, width, height, minPx) {
  if (!(minPx > 0)) return mask
  const n = width * height
  const seen = new Uint8Array(n)
  const stack = new Int32Array(n)
  const comp = new Int32Array(n)
  let removed = 0

  for (let start = 0; start < n; start++) {
    if (seen[start] || mask[start] < 128) continue
    let sp = 0
    stack[sp++] = start
    seen[start] = 1
    let size = 0
    while (sp > 0) {
      const p = stack[--sp]
      comp[size++] = p
      const x = p % width
      const y = (p - x) / width
      // 四邻域
      if (x > 0 && !seen[p - 1] && mask[p - 1] >= 128) { seen[p - 1] = 1; stack[sp++] = p - 1 }
      if (x < width - 1 && !seen[p + 1] && mask[p + 1] >= 128) { seen[p + 1] = 1; stack[sp++] = p + 1 }
      if (y > 0 && !seen[p - width] && mask[p - width] >= 128) { seen[p - width] = 1; stack[sp++] = p - width }
      if (y < height - 1 && !seen[p + width] && mask[p + width] >= 128) { seen[p + width] = 1; stack[sp++] = p + width }
    }
    if (size < minPx) {
      for (let i = 0; i < size; i++) mask[comp[i]] = 0
      removed += size
    }
  }
  return { mask, removed }
}

/**
 * 3) 去边缘色溢（decontamination）
 *    合成公式 C = a*Fg + (1-a)*Bg，已知 C 和 a，估出局部 Bg 就能反解 Fg，
 *    白边正是因为 Fg 里混进了 (1-a)*Bg。
 *    局部 Bg 用"加权模糊"求：把 (C*w, w) 预乘后一起模糊，再相除，w = 1-a。
 */
async function decontaminate (sharp, rgb, mask, width, height, sigma = 24) {
  const n = width * height
  const pre = Buffer.alloc(n * 4)
  for (let i = 0; i < n; i++) {
    const w = 1 - mask[i] / 255                 // 背景权重：越透明越可信
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2]
    pre[i * 4] = Math.round(r * w)
    pre[i * 4 + 1] = Math.round(g * w)
    pre[i * 4 + 2] = Math.round(b * w)
    pre[i * 4 + 3] = Math.round(255 * w)
  }
  const { data } = await sharp(pre, { raw: { width, height, channels: 4 } })
    .blur(Math.max(1, sigma))
    .raw()
    .toBuffer({ resolveWithObject: true })

  const out = Buffer.alloc(n * 4)
  const clamp = v => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

  for (let i = 0; i < n; i++) {
    const a = mask[i] / 255
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2]
    let or = r, og = g, ob = b

    // 只修半透明过渡带；纯前景/纯背景不动
    if (a > 0.02 && a < 0.98) {
      const wAvg = data[i * 4 + 3] / 255          // = 模糊后的背景权重
      if (wAvg > 0.02) {
        const br = data[i * 4] / wAvg             // 局部背景色
        const bg = data[i * 4 + 1] / wAvg
        const bb = data[i * 4 + 2] / wAvg
        const k = 1 - a
        or = clamp((r - k * br) / a)
        og = clamp((g - k * bg) / a)
        ob = clamp((b - k * bb) / a)
      }
    }
    out[i * 4] = or
    out[i * 4 + 1] = og
    out[i * 4 + 2] = ob
    out[i * 4 + 3] = mask[i]
  }
  return out
}

/**
 * 统一入口：给 RGBA 前的 rgb + mask，返回处理后的 rgba
 * @param {object} o
 * @param {Function} o.sharp
 * @param {Buffer} o.rgb   3 通道原图
 * @param {Buffer} o.mask  单通道 alpha（原地会被修改）
 */
async function refineRgba (o) {
  const {
    sharp, rgb, mask, width, height,
    edge = true,            // 边缘优化总开关
    alphaLo = 0.18, alphaHi = 0.82,   // 拉伸带更收窄一点，保护细发丝
    decontam = true,
    despeckleRatio = 0.00004,   // 小于总面积的这个比例的前景块被抹掉
  } = o

  let removed = 0
  if (edge) {
    stretchAlpha(mask, alphaLo, alphaHi)
    const minPx = Math.max(24, Math.round(width * height * despeckleRatio))
    const r = despeckle(mask, width, height, minPx)
    removed = r.removed
  }

  if (edge && decontam) {
    return { rgba: await decontaminate(sharp, rgb, mask, width, height), removed }
  }

  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0, n = width * height; i < n; i++) {
    rgba[i * 4] = rgb[i * 3]
    rgba[i * 4 + 1] = rgb[i * 3 + 1]
    rgba[i * 4 + 2] = rgb[i * 3 + 2]
    rgba[i * 4 + 3] = mask[i]
  }
  return { rgba, removed }
}

module.exports = { refineRgba, stretchAlpha, despeckle, decontaminate }
