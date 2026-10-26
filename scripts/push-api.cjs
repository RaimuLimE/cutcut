// 用 GitHub Git Data API 推送本地 commit（github.com:443 不稳定时的备用通道）
// 用法: node push-api.cjs <owner/repo> <branch> [本地commit]
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const REPO = process.argv[2] || 'RaimuLimE/cutcut'
const BRANCH = process.argv[3] || 'main'
const HEAD = process.argv[4] || 'HEAD'
const TOKEN = process.env.GH_TOKEN
const CWD = process.env.PUSH_CWD || process.cwd()

if (!TOKEN) { console.error('GH_TOKEN 未设置'); process.exit(1) }

const API = 'https://api.github.com'
const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'cutcut-push',
  'Content-Type': 'application/json'
}

function git (cmd) {
  return execSync(cmd, { cwd: CWD, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 })
}

async function gh (method, url, body) {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(API + url, {
        method,
        headers: H,
        body: body === undefined ? undefined : JSON.stringify(body)
      })
      const text = await res.text()
      if (!res.ok) {
        throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 400)}`)
      }
      return text ? JSON.parse(text) : null
    } catch (e) {
      if (i === 3) throw e
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)))
    }
  }
}

;(async () => {
  // 远端当前 tip
  const ref = await gh('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`)
  const remoteSha = ref.object.sha
  console.log('remote tip:', remoteSha)
  const remoteCommit = await gh('GET', `/repos/${REPO}/git/commits/${remoteSha}`)
  const baseTree = remoteCommit.tree.sha
  console.log('base tree:', baseTree)

  const localSha = git(`git rev-parse ${HEAD}`).toString().trim()
  console.log('local tip :', localSha)
  if (localSha === remoteSha) { console.log('已一致，无需推送'); return }

  // 改动清单（相对远端 tip）
  // 远端 tip 是 API 重建的 commit，本地通常没有这个对象，所以先试着 git diff，
  // 失败就用「远端 tree 递归清单 vs 本地 git hash-object」按 blob sha 比对。
  let changes = null
  try {
    const out = git(`git diff --name-status ${remoteSha} ${HEAD}`).toString().trim()
    changes = out.split(/\r?\n/).filter(Boolean).map((line) => {
      const [status, ...rest] = line.split('\t')
      return { status, path: rest.join('\t') }
    })
  } catch {
    console.log('本地没有远端 commit，改用 tree 快照比对')
    const remoteTree = await gh('GET', `/repos/${REPO}/git/trees/${baseTree}?recursive=1`)
    const remote = new Map()
    for (const t of remoteTree.tree) if (t.type === 'blob') remote.set(t.path, t.sha)
    const listed = git(`git ls-tree -r ${HEAD}`).toString().trim().split(/\r?\n/).filter(Boolean)
    const local = new Map()
    for (const line of listed) {
      const m = line.match(/^(\d+)\s+\w+\s+([0-9a-f]+)\t(.+)$/)
      if (m) local.set(m[3], { mode: m[1], sha: m[2] })
    }
    changes = []
    for (const [p, v] of local) {
      if (remote.get(p) !== v.sha) changes.push({ status: remote.has(p) ? 'M' : 'A', path: p })
    }
    for (const p of remote.keys()) if (!local.has(p)) changes.push({ status: 'D', path: p })
  }
  if (!changes.length) { console.log('无差异'); return }
  const entries = []
  for (const { status, path: rel } of changes) {
    if (status === 'D') {
      entries.push({ path: rel, mode: '100644', type: 'blob', sha: null })
      console.log('  D', rel)
      continue
    }
    const buf = git(`git show ${HEAD}:"${rel}"`)
    const blob = await gh('POST', `/repos/${REPO}/git/blobs`, {
      content: buf.toString('base64'),
      encoding: 'base64'
    })
    // 权限位
    const ls = git(`git ls-tree ${HEAD} -- "${rel}"`).toString().trim()
    const mode = ls.split(/\s+/)[0] || '100644'
    entries.push({ path: rel, mode, type: 'blob', sha: blob.sha })
    console.log('  ' + status, rel, (buf.length / 1024).toFixed(0) + 'KB')
  }

  const tree = await gh('POST', `/repos/${REPO}/git/trees`, { base_tree: baseTree, tree: entries })
  const message = git(`git log -1 --format=%B ${HEAD}`).toString().trim()
  const commit = await gh('POST', `/repos/${REPO}/git/commits`, {
    message,
    tree: tree.sha,
    parents: [remoteSha]
  })
  console.log('new commit:', commit.sha)
  await gh('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false })
  console.log('PUSHED OK ->', branchUrl())
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })

function branchUrl () { return `https://github.com/${REPO}/tree/${BRANCH}` }
