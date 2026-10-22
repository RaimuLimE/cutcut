'use strict'
// 只测 warm 推理耗时：load 一次，跑 3 次取后两次
const path = require('node:path')
const ort = require('onnxruntime-node')

const [file, ep] = process.argv.slice(2)
const threads = Number(process.argv[4] || 0)

;(async () => {
  const t0 = Date.now()
  const opts = {
    executionProviders: [ep],
    graphOptimizationLevel: 'extended',
    logSeverityLevel: 4,
  }
  if (ep === 'cpu' && threads) opts.intraOpNumThreads = threads
  const s = await ort.InferenceSession.create(path.resolve(file), opts)
  const loadMs = Date.now() - t0

  const N = 1024 * 1024
  const d = new Float32Array(3 * N)
  for (let i = 0; i < 3 * N; i++) d[i] = Math.random() * 2 - 1
  const feed = { [s.inputNames[0]]: new ort.Tensor('float32', d, [1, 3, 1024, 1024]) }

  const times = []
  for (let i = 0; i < 3; i++) {
    const t = Date.now()
    await s.run(feed)
    times.push(Date.now() - t)
  }
  console.log(`RESULT ${path.basename(file)} ep=${ep} threads=${threads || 'default'} load=${loadMs}ms runs=${times.join(',')}`)
  process.exit(0)
})().catch(e => { console.log('ERR ' + e.message.replace(/\s+/g, ' ').slice(0, 200)); process.exit(1) })
