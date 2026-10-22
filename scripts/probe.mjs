import ort from 'onnxruntime-node'
import path from 'node:path'
import fs from 'node:fs'

const modelPath = process.argv[2]
const sess = await ort.InferenceSession.create(modelPath, {
  executionProviders: process.argv[3] ? [process.argv[3]] : ['cpu'],
  graphOptimizationLevel: 'all',
})
console.log('inputs :', sess.inputNames)
for (const n of sess.inputNames) console.log('  ', n, JSON.stringify(sess.inputMetadata?.[n] ?? null))
console.log('outputs:', sess.outputNames)
for (const n of sess.outputNames) console.log('  ', n, JSON.stringify(sess.outputMetadata?.[n] ?? null))
