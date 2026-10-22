'use strict'
/**
 * 打包前校验：模型分发清单（src/models.js 的 CATALOG）与本地 ../models 下的
 * 真实模型文件必须逐字节一致。
 *
 * 为什么必须查：1.3 起安装包不带模型，用户装完靠下载。清单里的 bytes/sha256
 * 一旦写错，所有人都会下载到「SHA-256 校验失败」，而本地开发环境完全正常。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const models = require('../src/models')

const SRC = path.resolve(__dirname, '..', 'models')

function sha256 (file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file, { highWaterMark: 8 * 1024 * 1024 })
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

async function main () {
  let bad = 0
  for (const [id, ent] of Object.entries(models.CATALOG)) {
    const local = path.join(SRC, ent.file)
    if (!fs.existsSync(local)) {
      console.log(`  SKIP ${id}  本地没有 ${ent.file}（仅影响开发期冒烟，不影响打包）`)
      continue
    }
    const size = fs.statSync(local).size
    if (size !== ent.bytes) {
      console.log(`  FAIL ${id}  体积不符：本地 ${size}，清单 ${ent.bytes}`)
      bad++
      continue
    }
    const got = await sha256(local)
    if (got !== ent.sha256) {
      console.log(`  FAIL ${id}  SHA-256 不符：\n        本地 ${got}\n        清单 ${ent.sha256}`)
      bad++
      continue
    }
    console.log(`  OK   ${id}  ${ent.file}  ${(size / 1048576).toFixed(1)} MB  sha256 一致`)
  }
  if (bad) {
    console.log(`\n模型分发清单有 ${bad} 处不一致，打包中止。`)
    process.exit(1)
  }
  console.log('\n模型分发清单校验通过。')
}

main().catch(e => { console.error(e); process.exit(1) })
