/**
 * Publish this package to GitHub through the REST API.
 *
 * No git and no `gh` are required: repository creation and per-file writes both
 * work over HTTPS. The script is idempotent — an existing repository and
 * existing files are updated rather than treated as failures.
 *
 * This machine reaches GitHub through a TLS-intercepting middlebox whose
 * certificate Node does not trust by default, so run it with the system root
 * store exported to a PEM bundle:
 *
 *   NODE_EXTRA_CA_CERTS=<pem> node publish-github.mjs --token <token> [--repo <name>]
 *
 * The token needs `repo` (classic) or Contents + Administration read/write
 * (fine-grained). Prefer passing it through GITHUB_TOKEN rather than --token.
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const API = 'https://api.github.com'
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const wantPrivate = argv.includes('--private')
const tokenAt = argv.indexOf('--token')
const repoAt = argv.indexOf('--repo')
const token = tokenAt === -1 ? process.env.GITHUB_TOKEN : argv[tokenAt + 1]
const repoName = repoAt === -1 ? 'dsh-browser-control' : argv[repoAt + 1]

if (typeof token !== 'string' || token.trim() === '') {
  console.error('no token. Pass --token <token> or set GITHUB_TOKEN.')
  process.exit(2)
}
if (process.env.NODE_EXTRA_CA_CERTS === undefined || !existsSync(process.env.NODE_EXTRA_CA_CERTS)) {
  console.warn('warning: NODE_EXTRA_CA_CERTS does not point at an existing PEM bundle;')
  console.warn('         GitHub calls will fail with UNABLE_TO_VERIFY_LEAF_SIGNATURE on this network.')
}

/** Files uploaded to the repository, in the order they are sent. */
const FILES = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'install.mjs',
  'publish-github.mjs',
  'icon.svg',
  'LICENSE',
  '.gitignore',
  'README.md',
  'locale/en.json',
  'locale/zh.json',
  'test/harness.mjs',
  'test/client-harness.mjs',
  'test/real-schema-check.mjs',
]

/**
 * Call one GitHub endpoint.
 * @param {string} path - the API path.
 * @param {{method?: string, body?: object}} [options] - request facts.
 * @returns {Promise<{status: number, body: any}>} the response.
 */
async function call(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      authorization: `Bearer ${token}`,
      'user-agent': 'dsh-browser-control-publisher',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(45_000),
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

// 1. Identify the account and the scopes the token carries.
const me = await call('/user')
if (me.status !== 200) {
  console.error(`token rejected: HTTP ${me.status} ${JSON.stringify(me.body).slice(0, 200)}`)
  process.exit(1)
}
const owner = me.body.login
console.log(`authenticated as ${owner} (${me.body.name ?? 'unnamed'})`)

// 2. Create the repository, or reuse it.
const existing = await call(`/repos/${owner}/${repoName}`)
let created = false
if (existing.status === 200) {
  console.log(`repository ${owner}/${repoName} already exists; updating its files`)
  if (existing.body.private === true && !wantPrivate) {
    const opened = await call(`/repos/${owner}/${repoName}`, { method: 'PATCH', body: { private: false } })
    console.log(opened.status === 200 ? 'made the repository public' : `could not change visibility: HTTP ${opened.status}`)
  }
} else if (dryRun) {
  console.log(`[dry-run] would create ${owner}/${repoName} (private: ${wantPrivate})`)
} else {
  const creation = await call('/user/repos', {
    method: 'POST',
    body: {
      name: repoName,
      description: '让 DSH 的 Agent 查看并修改右侧边栏浏览器里的页面内容（desktop webview + loopback bridge）',
      private: wantPrivate,
      has_issues: true,
      has_wiki: false,
      auto_init: true,
    },
  })
  if (creation.status !== 201) {
    console.error(`could not create the repository: HTTP ${creation.status} ${JSON.stringify(creation.body).slice(0, 300)}`)
    process.exit(1)
  }
  created = true
  console.log(`created ${owner}/${repoName}`)
}

// 3. Upload or update each file.
let uploaded = 0
for (const path of FILES) {
  let content
  try {
    content = readFileSync(join(PACKAGE_ROOT, path)).toString('base64')
  } catch (error) {
    console.warn(`skipped ${path}: ${error.message}`)
    continue
  }

  const remote = `/repos/${owner}/${repoName}/contents/${posix.join(...path.split(/[\\/]/))}`
  const current = await call(remote)
  const sha = current.status === 200 && typeof current.body?.sha === 'string' ? current.body.sha : undefined

  if (dryRun) {
    console.log(`[dry-run] would ${sha === undefined ? 'create' : 'update'} ${path}`)
    uploaded += 1
    continue
  }

  const write = await call(remote, {
    method: 'PUT',
    body: {
      message: sha === undefined ? `Add ${path}` : `Update ${path}`,
      content,
      ...(sha === undefined ? {} : { sha }),
    },
  })
  if (write.status !== 200 && write.status !== 201) {
    console.error(`failed on ${path}: HTTP ${write.status} ${JSON.stringify(write.body).slice(0, 300)}`)
    process.exit(1)
  }
  uploaded += 1
  console.log(`${sha === undefined ? 'created' : 'updated'} ${path}`)
}

console.log(`\n${dryRun ? '[dry-run] ' : ''}${uploaded} files ${dryRun ? 'planned' : 'published'}`)
console.log(`repository: https://github.com/${owner}/${repoName}`)
