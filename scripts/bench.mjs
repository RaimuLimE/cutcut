import ort from 'onnxruntime-node'
import sharp from 'sharp'

const SIZE = 1024
const modelPath = process.argv[2]
const imgPath = process.argv[3]
const ep = process.argv[4] || 'cpu'
const rounds = Number(process.argv[5] || 3)
const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]

const t0 = Date.now()
const sess = await ort.InferenceSession.create(modelPath, {
  executionProviders: [ep],
  graphOptimizationLevel: 'extended',
  logSeverityLevel: 3,
})
console.log('load', Date.now() - t0, 'ms on', ep)

const { data: rgb, info } = await sharp(imgPath).rotate().removeAlpha().toColourspace('srgb').raw()
  .toBuffer({ resolveWithObject: true })
const px = await sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } })
  .resize(SIZE, SIZE, { fit: 'fill' }).raw().toBuffer()
const N = SIZE * SIZE
const input = new Float32Array(3 * N)
for (let i = 0; i < N; i++) {
  input[i] = (px[i * 3] / 255 - MEAN[0]) / STD[0]
  input[N + i] = (px[i * 3 + 1] / 255 - MEAN[1]) / STD[1]
  input[2 * N + i] = (px[i * 3 + 2] / 255 - MEAN[2]) / STD[2]
}
const tensor = new ort.Tensor('float32', input, [1, 3, SIZE, SIZE])

const times = []
for (let r = 0; r < rounds; r++) {
  const t = Date.now()
  const out = await sess.run({ pixel_values: tensor })
  times.push(Date.now() - t)
  if (r === 0) {
    const d = out.alphas.data
    console.log('out sample', d[0].toFixed(4), d[(SIZE >> 1) * SIZE + (SIZE >> 1)].toFixed(4))
  }
}
console.log('run ms:', times.join(', '), '| warm avg', Math.round(times.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, times.length - 1)))
