// 一次性：解析 kimi 的 CRX3，验证我对 protobuf 结构 / 签名算法的理解
const fs = require('fs')

function readVarint (b, o) {
  let r = 0, s = 0, i = o
  while (true) { const c = b[i++]; r += (c & 0x7f) * Math.pow(2, s); s += 7; if (!(c & 0x80)) break }
  return [r, i]
}

function parseFields (b) {
  const out = []
  let o = 0
  while (o < b.length) {
    const [tag, o2] = readVarint(b, o); o = o2
    const field = Math.floor(tag / 8), wire = tag % 8
    if (wire === 2) {
      const [len, o3] = readVarint(b, o); o = o3
      out.push({ field, wire, value: b.slice(o, o + len) }); o += len
    } else if (wire === 0) {
      const [v, o4] = readVarint(b, o); o = o4
      out.push({ field, wire, value: v })
    } else throw new Error('unsupported wire ' + wire)
  }
  return out
}

const f = process.argv[2]
const b = fs.readFileSync(f)
console.log('magic', b.slice(0, 4).toString('ascii'))
console.log('version', b.readUInt32LE(4))
const hlen = b.readUInt32LE(8)
console.log('headerlen', hlen)
const hdr = b.slice(12, 12 + hlen)
const zip = b.slice(12 + hlen)
console.log('zip magic', zip.slice(0, 4).toString('hex'), '(504b0304 = ok)')

const fields = parseFields(hdr)
for (const fl of fields) {
  if (fl.field === 2) {
    const sub = parseFields(fl.value)
    const pk = sub.find(x => x.field === 1)
    const sig = sub.find(x => x.field === 2)
    const crypto = require('crypto')
    console.log('sha256_with_rsa: public_key', pk.value.length, 'B, sig', sig.value.length, 'B')
    const id = crypto.createHash('sha256').update(pk.value).digest().slice(0, 16)
    console.log('  derived id:', [...id].map(x => String.fromCharCode(97 + (x >> 4)) + String.fromCharCode(97 + (x & 15))).join(''))
    const shd = fields.find(x => x.field === 10000)
    console.log('  signed_header_data', shd.value.length, 'B ->', JSON.stringify(parseFields(shd.value).map(x => ({ f: x.field, v: Buffer.isBuffer(x.value) ? x.value.toString('hex') : x.value }))))
    // 验证签名：CRX3 SignedData\0 + uint32le(len) + shd + zip
    const prefix = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'binary'), (() => { const t = Buffer.alloc(4); t.writeUInt32LE(shd.value.length); return t })()])
    const msg = Buffer.concat([prefix, shd.value, zip])
    const ok = crypto.createVerify('RSA-SHA256').update(msg).verify({ key: pk.value, format: 'der', type: 'spki' }, sig.value)
    console.log('  signature verifies:', ok)
  }
}
