'use strict'
/**
 * 模型分发层验收：
 *   1) stateOf / installedAt 在空目录下的行为
 *   2) importFile 从本地已有模型导入 -> 校验通过 -> 落盘
 *   3) 体积不符 / 哈希不符时能正确拒绝
 *   4) download 走真实网络（可选，加 --net）
 *   5) 断点续传：手工造一个 .part 再续
 */
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const models = require('../src/models')

const SRC = path.resolve(__dirname, '..', 'models')
const TMP = path.join(os.tmpdir(), 'cutcut-models-test')

let pass = 0, fail = 0
function ok (name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')) }
}

async function main () {
  await fsp.rm(TMP, { recursive: true, force: true })
  await fsp.mkdir(TMP, { recursive: true })

  console.log('[1] 空目录状态')
  for (const id of ['rmbg', 'birefnet']) {
    const st = models.stateOf(TMP, id)
    ok(`${id} installed=false`, st.installed === false)
    ok(`${id} 期望体积 ${st.bytes}`, st.bytes > 1e8)
    ok(`${id} partialBytes=0`, st.partialBytes === 0)
    ok(`${id} installedAt=null`, models.installedAt(TMP, id) === null)
  }

  console.log('[2] 体积不符要拒绝')
  const bogus = path.join(TMP, 'bogus.onnx')
  await fsp.writeFile(bogus, Buffer.alloc(1024))
  let msg = ''
  try { await models.importFile('rmbg', TMP, bogus) } catch (e) { msg = e.message }
  ok('小文件被拒', /体积不符/.test(msg), msg)
  ok('拒绝后没有残留 .part', !fs.existsSync(models.partPath(TMP, 'rmbg')))

  console.log('[3] 从本地导入真实模型（rmbg 490MB）')
  const srcRmbg = path.join(SRC, 'model_fp16.onnx')
  if (!fs.existsSync(srcRmbg)) { console.log('  跳过：源模型不存在'); }
  else {
    const t0 = Date.now()
    let lastPhase = ''
    const r = await models.importFile('rmbg', TMP, srcRmbg, {
      onProgress: (p) => { lastPhase = p.phase },
    })
    ok('importFile ok', r.ok === true)
    ok('落到 userData/models', r.path === models.finalPath(TMP, 'rmbg'))
    ok('文件存在且体积正确', fs.statSync(r.path).size === models.CATALOG.rmbg.bytes)
    ok('最后阶段是 done', lastPhase === 'done', lastPhase)
    ok('installedAt 现在能返回路径', models.installedAt(TMP, 'rmbg') === r.path)
    console.log(`    耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  }

  console.log('[4] 哈希不符要拒绝')
  // 造一个正确体积但内容全 0 的文件（用 sparse 写，避免真占 490MB 内存）
  const fh = await fsp.open(models.finalPath(TMP, 'rmbg'), 'r+')
  await fh.truncate(0)
  await fh.close()
  // 直接伪造：截成正确长度但全零
  const bad = path.join(TMP, 'zero.onnx')
  const zfh = await fsp.open(bad, 'w')
  await zfh.truncate(models.CATALOG.rmbg.bytes)
  await zfh.close()
  msg = ''
  try { await models.importFile('rmbg', TMP, bad) } catch (e) { msg = e.message }
  ok('哈希不符被拒', /SHA-256/.test(msg), msg)
  ok('失败后 .part 已清理', !fs.existsSync(models.partPath(TMP, 'rmbg')))
  await fsp.rm(bad, { force: true })

  console.log('[5] 断点续传（真实网络，仅 rmbg 前 20MB）')
  if (process.argv.includes('--net')) {
    // 手工造一个 20MB 的 .part（真实前 20MB 内容），再让 download 续
    const ent = models.CATALOG.rmbg
    const part = models.partPath(TMP, 'rmbg')
    await fsp.mkdir(path.dirname(part), { recursive: true })
    const res = await fetch(ent.sources[0].url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0',
        Referer: 'https://modelscope.cn/',
        Range: 'bytes=0-20971519',
      },
    })
    ok('Range 请求 206', res.status === 206, 'status=' + res.status)
    const buf = Buffer.from(await res.arrayBuffer())
    await fsp.writeFile(part, buf)
    console.log(`    预置 .part ${(buf.length / 1048576).toFixed(1)} MB`)
    const st = models.stateOf(TMP, 'rmbg')
    ok('stateOf 看到 partialBytes', st.partialBytes === buf.length, 'partial=' + st.partialBytes)

    let maxPct = 0, sawVerify = false
    const t0 = Date.now()
    try {
      const r = await models.download('rmbg', TMP, {
        onProgress: (p) => {
          if (p.percent > maxPct) maxPct = p.percent
          if (p.phase === 'verify') sawVerify = true
        },
      })
      ok('续传下载完成', r.ok === true)
      ok('没走验证缓存分支', !r.cached)
      ok('进度到过 100%', maxPct > 99, 'max=' + maxPct.toFixed(1))
      ok('经过校验阶段', sawVerify)
      ok('文件体积正确', fs.statSync(r.path).size === models.CATALOG.rmbg.bytes)
      console.log(`    耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    } catch (e) {
      ok('续传下载完成', false, e.message)
    }
  } else {
    console.log('  跳过（加 --net 启用）')
  }

  console.log('[6] remove')
  const rr = await models.remove('rmbg', TMP)
  ok('remove ok', rr.ok === true)
  ok('文件已删除', !fs.existsSync(models.finalPath(TMP, 'rmbg')))

  await fsp.rm(TMP, { recursive: true, force: true })
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error('测试异常：', e); process.exit(1) })
