// 核对远端 blob 与本地文件是否一致
// 用法: node verify-remote.cjs
const { execSync } = require('child_process')
const fs = require('fs')

const TOKEN = process.env.GH_TOKEN
const H = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'cc' }
const FILES = [
  'README.md',
  'docs/screenshots/app-dark.png',
  'docs/screenshots/sample-compare.png',
  'docs/screenshots/app-light.png',
  'scripts/push-api.cjs',
  'scripts/shot-cdp.cjs'
]
const DELETED = ['docs/screenshots/sample-anime.png', 'docs/screenshots/sample-photo.png', 'docs/screenshots/sample-cutout.png']

;(async () => {
  const t = await (await fetch('https://api.github.com/repos/RaimuLimE/cutcut/git/trees/main?recursive=1', { headers: H })).json()
  const map = new Map()
  for (const x of t.tree) if (x.type === 'blob') map.set(x.path, x.sha)

  for (const f of FILES) {
    const local = execSync(`git hash-object "${f}"`, { encoding: 'utf8', cwd: __dirname + '/..' }).trim()
    const remote = map.get(f)
    console.log((local === remote ? 'SAME  ' : 'DIFF  ') + f + '  ' + (remote ? remote.slice(0, 10) : 'MISSING'))
  }
  console.log('--- 应已删除 ---')
  for (const f of DELETED) console.log((map.has(f) ? 'STILL THERE' : 'gone       ') + '  ' + f)
  console.log('total blobs:', map.size)
})()
