'use strict'
// 单个进程只试一种配置，避免一次失败拖垮其它测试
const path = require('node:path')
const ort = require('onnxruntime-node')

const [file, ep, opt, extra] = process.argv.slice(2)
const opts = {
  executionProviders: [ep],
  graphOptimizationLevel: opt || 'extended',
  logSeverityLevel: 4,
}
if (extra === 'nomem') opts.enableMemPattern = false
if (extra === 'seq') opts.executionMode = 'sequential'
if (extra === 'notreads') opts.intraOpNumThreads = 1

;(async () => {
  const t = Date.now()
  try {
    const s = await ort.InferenceSession.create(path.resolve(file), opts)
    const N = 1024 * 1024
    const d = new Float32Array(3 * N)
    for (let i = 0; i < 3 * N; i++) d[i] = 0.3
    const r = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', d, [1, 3, 1024, 1024]) })
    const o = r[s.outputNames[0]]
    let mn = 1e9, mx = -1e9
    for (const v of o.data) { if (v < mn) mn = v; if (v > mx) mx = v }
    console.log(`OK   ep=${ep} opt=${opt} ${extra || '-'} ${Date.now() - t}ms min=${mn.toFixed(2)} max=${mx.toFixed(2)}`)
  } catch (e) {
    console.log(`FAIL ep=${ep} opt=${opt} ${extra || '-'} ${Date.now() - t}ms :: ${e.message.replace(/\s+/g, ' ').slice(0, 160)}`)
  }
  process.exit(0)
})()
