'use strict'
// 打印 ONNX 模型的输入/输出名与形状
const ort = require('onnxruntime-node')
const path = require('node:path')

const f = process.argv[2]
if (!f) { console.log('usage: node probe-io.cjs <model.onnx>'); process.exit(1) }

;(async () => {
  const s = await ort.InferenceSession.create(path.resolve(f), {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'basic',
  })
  console.log('file:', path.basename(f), (require('fs').statSync(f).size / 1048576).toFixed(1) + ' MB')
  console.log('inputs:')
  for (const i of s.inputNames) console.log('  ', i)
  console.log('outputs:')
  for (const o of s.outputNames) console.log('  ', o)
  console.log('inputMetadata:', JSON.stringify(s.inputMetadata))
  console.log('outputMetadata:', JSON.stringify(s.outputMetadata))
})().catch(e => { console.error('FAIL', e.message); process.exit(1) })
