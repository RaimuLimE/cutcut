'use strict'
/**
 * 把 browser-ext/ 打成可被 Chrome/Edge 通过注册表外置安装的 CRX3。
 *
 *   node scripts/make-crx.cjs
 *
 * 产出：
 *   build/ext-key.pem   RSA 私钥（PKCS#8）。**必须保留**——扩展 ID 由公钥决定，
 *                       换钥匙就等于换 ID，已安装的用户侧注册表会失效。
 *   build/ext-key.txt   第 1 行 base64 公钥（DER SPKI），第 2 行扩展 ID
 *   browser-ext.crx     签名后的安装包（放在 build/ 下由安装器复制）
 *   browser-ext.zip     未签名 zip（调试用）
 *
 * CRX3 结构：
 *   "Cr24" | uint32le version=3 | uint32le headerLen | header | zip
 *   header 是 protobuf：
 *     field 2  (sha256_with_rsa, repeated) { field 1 public_key, field 2 signature }
 *     field 10000 (signed_header_data) { field 1 crx_id(16B) }
 *   签名内容 = "CRX3 SignedData\0" + uint32le(len(signed_header_data)) + signed_header_data + zip
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')

const ROOT = path.resolve(__dirname, '..')
const EXT_DIR = path.join(ROOT, 'browser-ext')
const BUILD = path.join(ROOT, 'build')
const PEM = path.join(BUILD, 'ext-key.pem')
const TXT = path.join(BUILD, 'ext-key.txt')
const CRX = path.join(BUILD, 'browser-ext.crx')

// ---------- 极简 ZIP 写入（deflate，UTF-8 文件名，不带 data descriptor） ----------

function dosTime (d) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xffff
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff
  return { time, date }
}

function crc32 (buf) {
  let c
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })())
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

/** @param {Array<{name:string, data:Buffer, date:Date}>} files */
function makeZip (files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const f of files) {
    const nameBuf = Buffer.from(f.name.replace(/\\/g, '/'), 'utf8')
    const comp = zlib.deflateRawSync(f.data, { level: 9 })
    const crc = crc32(f.data)
    const { time, date } = dosTime(f.date)

    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)          // version needed
    lh.writeUInt16LE(0x0800, 6)      // flags: UTF-8 name
    lh.writeUInt16LE(8, 8)           // method: deflate
    lh.writeUInt16LE(time, 10)
    lh.writeUInt16LE(date, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(comp.length, 18)
    lh.writeUInt32LE(f.data.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28)
    const local = Buffer.concat([lh, nameBuf, comp])
    locals.push(local)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(8, 10)
    ch.writeUInt16LE(time, 12)
    ch.writeUInt16LE(date, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(comp.length, 20)
    ch.writeUInt32LE(f.data.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt16LE(0, 30)          // extra
    ch.writeUInt16LE(0, 32)          // comment
    ch.writeUInt16LE(0, 34)          // disk
    ch.writeUInt16LE(0, 36)          // internal attrs
    ch.writeUInt32LE(0, 38)          // external attrs
    ch.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([ch, nameBuf]))

    offset += local.length
  }
  const central = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, central, eocd])
}

// ---------- protobuf 手写（只有 varint 和 length-delimited） ----------

function varint (n) {
  const out = []
  while (n > 127) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128) }
  out.push(n & 0x7f)
  return Buffer.from(out)
}
function tag (field, wire) { return varint(field * 8 + wire) }
function pbBytes (field, buf) { return Buffer.concat([tag(field, 2), varint(buf.length), buf]) }
function pbVarint (field, n) { return Buffer.concat([tag(field, 0), varint(n)]) }

function extensionId (publicKeyDer) {
  const h = crypto.createHash('sha256').update(publicKeyDer).digest()
  let s = ''
  for (let i = 0; i < 16; i++) s += String.fromCharCode(97 + (h[i] >> 4)) + String.fromCharCode(97 + (h[i] & 15))
  return s
}

function loadOrCreateKey () {
  if (fs.existsSync(PEM)) {
    return crypto.createPrivateKey(fs.readFileSync(PEM))
  }
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  fs.mkdirSync(BUILD, { recursive: true })
  fs.writeFileSync(PEM, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  console.log('generated new key ->', PEM)
  return privateKey
}

function walk (dir, base = '') {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel))
    else out.push({ name: rel, data: fs.readFileSync(path.join(dir, e.name)), date: fs.statSync(path.join(dir, e.name)).mtime })
  }
  return out
}

function main () {
  if (!fs.existsSync(EXT_DIR)) throw new Error('缺少 browser-ext/ 目录')
  const manifestPath = path.join(EXT_DIR, 'manifest.json')
  if (!fs.existsSync(manifestPath)) throw new Error('缺少 browser-ext/manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (!manifest.version) throw new Error('manifest.json 缺少 version')

  const privateKey = loadOrCreateKey()
  const pubDer = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  const id = extensionId(pubDer)

  // manifest 的 key 字段让「未打包加载」也得到同一个 ID，避免两套 ID
  manifest.key = pubDer.toString('base64')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

  const files = walk(EXT_DIR)
  const zip = makeZip(files)
  fs.writeFileSync(path.join(BUILD, 'browser-ext.zip'), zip)

  const crxId = crypto.createHash('sha256').update(pubDer).digest().slice(0, 16)
  const signedHeaderData = pbBytes(1, crxId)

  const sig = crypto.createSign('RSA-SHA256')
  sig.update(Buffer.from('CRX3 SignedData\x00', 'binary'))
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32LE(signedHeaderData.length)
  sig.update(lenBuf)
  sig.update(signedHeaderData)
  sig.update(zip)
  const signature = sig.sign(privateKey)

  const proof = Buffer.concat([pbBytes(1, pubDer), pbBytes(2, signature)])
  const header = Buffer.concat([pbBytes(2, proof), pbBytes(10000, signedHeaderData)])

  const head = Buffer.alloc(12)
  head.write('Cr24', 0, 'ascii')
  head.writeUInt32LE(3, 4)
  head.writeUInt32LE(header.length, 8)

  const crxBuf = Buffer.concat([head, header, zip])
  fs.writeFileSync(CRX, crxBuf)

  fs.writeFileSync(TXT, pubDer.toString('base64') + '\n' + id + '\n')

  console.log('extension id : ' + id)
  console.log('files        : ' + files.length + '  (' + files.map(f => f.name).join(', ') + ')')
  console.log('zip          : ' + zip.length + ' B')
  console.log('crx          : ' + crxBuf.length + ' B -> ' + CRX)
}

main()
