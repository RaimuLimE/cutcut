'use strict'
// 用指定目录里的 onnxruntime-node 测试 BiRefNet 能否在 DML 上跑
// 用法: node probe-ort.cjs <ort模块路径> <模型> <ep> [opt]
const path = require('node:path')

const [ortPath, model, ep, opt] = process.argv.slice(2)
const ort = require(path.resolve(ortPath))

;(async () => {
  console.log('ort version: ' + require(path.resolve(ortPath, 'package.json')).version)
  try { console.log('backends: ' + (ort.listSupportedBackends?.() || []).join(',')) } catch {}
  const t = Date.now()
  try {
    const s = await ort.InferenceSession.create(model, {
      executionProviders: [ep],
      graphOptimizationLevel: opt || 'extended',
      logSeverityLevel: 4,
    })
    const d = new Float32Array(3 * 1024 * 1024).fill(0.3)
    const r = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', d, [1, 3, 1024, 1024]) })
    const o = r[s.outputNames[0]]
    let mn = 1e9, mx = -1e9
    for (const v of o.data) { if (v < mn) mn = v; if (v > mx) mx = v }
    console.log(`OK ep=${ep} ${Date.now() - t}ms out=${o.dims} min=${mn.toFixed(2)} max=${mx.toFixed(2)}`)
  } catch (e) {
    console.log(`FAIL ep=${ep} ${Date.now() - t}ms :: ${String(e.message).replace(/\s+/g, ' ').slice(0, 200)}`)
  }
  process.exit(0)
})()
