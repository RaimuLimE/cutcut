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
  const out = git(`git diff --name-status ${remoteSha} ${HEAD}`).toString().trim()
  if (!out) { console.log('无差异'); return }
  const entries = []
  for (const line of out.split(/\r?\n/)) {
    const [status, ...rest] = line.split('\t')
    const rel = rest.join('\t')
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
