import ort from 'onnxruntime-node'
import sharp from 'sharp'

const SIZE = 1024
const modelPath = process.argv[2]
const imgPath = process.argv[3]
const outPath = process.argv[4]
const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]
const INVERT = process.env.INVERT === '1'

const sess = await ort.InferenceSession.create(modelPath, {
  executionProviders: ['cpu'],
  graphOptimizationLevel: 'all',
})

// normalize orientation first: rotate() then read actual pixels
const { data: fgRaw, info } = await sharp(imgPath)
  .rotate()
  .removeAlpha()
  .toColourspace('srgb')
  .raw()
  .toBuffer({ resolveWithObject: true })
const W = info.width, H = info.height
console.log('oriented', W, H, info.channels)

const raw = await sharp(fgRaw, { raw: { width: W, height: H, channels: 3 } })
  .resize(SIZE, SIZE, { fit: 'fill' })
  .raw().toBuffer()

const N = SIZE * SIZE
const input = new Float32Array(3 * N)
for (let i = 0; i < N; i++) {
  for (let c = 0; c < 3; c++) input[c * N + i] = (raw[i * 3 + c] / 255 - MEAN[c]) / STD[c]
}
const t0 = Date.now()
const res = await sess.run({ pixel_values: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) })
const tInfer = Date.now() - t0
const d = res.alphas.data

const maskBuf = Buffer.alloc(N)
for (let i = 0; i < N; i++) {
  let v = d[i]
  if (INVERT) v = 1 - v
  maskBuf[i] = Math.round(Math.max(0, Math.min(1, v)) * 255)
}
await sharp(maskBuf, { raw: { width: SIZE, height: SIZE, channels: 1 } })
  .png().toFile(outPath.replace(/\.png$/, '-mask.png'))

const bigRes = await sharp(maskBuf, { raw: { width: SIZE, height: SIZE, channels: 1 } })
  .resize(W, H, { fit: 'fill' })
  .raw()
  .toBuffer({ resolveWithObject: true })
const maskBig = bigRes.data
const MC = bigRes.info.channels
console.log('maskBig channels', MC)

const rgba = Buffer.alloc(W * H * 4)
for (let i = 0; i < W * H; i++) {
  rgba[i * 4] = fgRaw[i * 3]
  rgba[i * 4 + 1] = fgRaw[i * 3 + 1]
  rgba[i * 4 + 2] = fgRaw[i * 3 + 2]
  rgba[i * 4 + 3] = maskBig[i]
}
await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toFile(outPath)

const at = (x, y) => maskBig[y * W + x]
console.log('infer', tInfer, 'ms; mask corner', at(2, 2), 'centre', at(W >> 1, H >> 1),
  'rawmask corner', maskBuf[0], 'rawmask centre', maskBuf[(SIZE >> 1) * SIZE + (SIZE >> 1)])
