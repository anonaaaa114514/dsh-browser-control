/**
 * dsh-browser-control — Host half.
 *
 * Registers two agent tools that drive the DeepSeek Harness right-Sidebar
 * browser tabs:
 *
 * - `browser_frame` — list tabs, read a tab's page, click, type, navigate,
 *   take a screenshot;
 * - `browser_eval` — run arbitrary JavaScript inside the page.
 *
 * The pages themselves live in the Electron renderer (a `<webview>` guest, or
 * an iframe in the Web profile), which no Host plugin can reach. The two halves
 * therefore speak a small request/response protocol over this plugin's own HTTP
 * route on the app's loopback server:
 *
 *   GET  <base>/next?c=<clientId>&tabs=<n>   long-poll; answers one claimed task
 *   POST <base>/result                       body {clientId, taskId, result|error}
 *   GET  <base>/status                       bridge diagnostics
 *
 * A tool creates a task and awaits its promise; the attached browser tab claims
 * it through the long poll, runs it against the page, and posts the result back.
 * Nothing leaves the machine: the route is served by the app's own `127.0.0.1`
 * listener and only the app page calls it.
 *
 * This module is plain JavaScript and imports only Node built-ins, because a
 * profile-installed package resolves bare `@deepseek-ai/*` specifiers against
 * the profile, where none of them exist. The Harness accepts a plain tool
 * definition object (`name`, `description`, `parameters`, `output`, `execute`),
 * which is exactly how `dsh-ops` publishes its own tools.
 *
 * @module dsh-browser-control
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** HTTP prefix this plugin owns on the app's loopback server. */
const ROUTE_PREFIX = '/dsh-browser-control'

/** Artifact directory name, shared by the spill destination and the trace marker. */
const ARTIFACT_DIR_NAME = '.dsh-browser'

/**
 * Resolve the directory for spilled artifacts.
 *
 * `process.cwd()` is the DSH installation (the host's own cwd), not the session
 * workspace, so artifacts written there would be invisible to the agent's file
 * tools. `$DSH_PROFILE_DIR/.dsh-browser/` is a stable location both sides agree
 * on, and every result carries its absolute path so no caller has to guess.
 *
 * Resolved per call rather than at module load: a test (or a redirected
 * profile) can point it somewhere writable without reloading the module.
 * @returns {string} the artifact root directory.
 */
function artifactRoot() {
  const profile = process.env.DSH_PROFILE_DIR
  return join(typeof profile === 'string' && profile !== '' ? profile : join(homedir(), '.dsh'), ARTIFACT_DIR_NAME)
}

/** How long one long poll may stay open before it answers "no task". */
const DEFAULT_POLL_WAIT_MS = 50_000

/** How long a claimed task stays valid before the Host abandons it. */
const DEFAULT_TASK_TIMEOUT_MS = 60_000

/**
 * Extra slack before a silent renderer stops counting as attached. It must
 * exceed one poll interval so a reconnect is not mistaken for a closed page.
 */
const DEFAULT_CLIENT_GRACE_MS = 30_000

/** Upper bound on one page→Host payload. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Inline result budget; a larger payload is written beside the workspace. */
const INLINE_LIMIT_BYTES = 12_000

/**
 * Services this plugin needs before it can do anything useful.
 *
 * `webServer` owns the loopback route the browser half polls, and `tools` is
 * the registry the two agent tools register into. Declaring them here makes
 * Cordis hold activation until both exist; without it `apply` runs while the
 * composition is still settling, `ctx.get` returns undefined for both, and the
 * plugin degrades to a warning that is easy to miss.
 */
export const inject = ['webServer', 'tools']

/**
 * Read a request body with a hard byte cap.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {number} limit - maximum accepted bytes.
 * @returns {Promise<string>} the decoded body.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        reject(new Error(`request body exceeds ${limit} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Answer one request with JSON.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} value - JSON-serializable payload.
 * @returns {void}
 */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * One open browser tab, as the renderer reports it.
 *
 * These are raw JSON Schemas, not the `defineTool` DSL: a profile plugin
 * cannot import `@deepseek-ai/dsh-tools`, so it publishes plain schemas. That
 * means `required` is an array of property names on the *object* — a
 * `required: true` beside a `type` is the DSL spelling and is rejected by
 * `assertSupportedJsonSchema` when the tool registers.
 */
const TAB_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tabId: { type: 'string' },
    title: { type: 'string' },
    url: { type: 'string' },
    frameType: { type: 'string' },
    active: { type: 'boolean' },
    loading: { type: 'boolean' },
    sandboxed: { type: 'boolean' },
  },
  required: ['tabId', 'title', 'url', 'frameType', 'active', 'loading'],
}

/** One interactable element discovered while reading a page. */
const NODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tag: { type: 'string' },
    kind: { type: 'string' },
    text: { type: 'string' },
    selector: { type: 'string' },
    id: { type: 'string' },
    name: { type: 'string' },
    type: { type: 'string' },
  },
  required: ['tag', 'kind', 'text', 'selector'],
}

/** Page identity plus the parts of a read result the caller asked for. */
const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'read' },
    tab: TAB_SCHEMA,
    selector: { type: 'string' },
    text: { type: 'string' },
    textTruncated: { type: 'boolean' },
    nodes: { type: 'array', items: NODE_SCHEMA },
    nodesTruncated: { type: 'boolean' },
  },
  required: ['kind'],
}

/** An operation that changed or observed a page, with the resulting state. */
const STATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'state' },
    tab: TAB_SCHEMA,
    url: { type: 'string' },
    title: { type: 'string' },
    text: { type: 'string' },
    textTruncated: { type: 'boolean' },
  },
  required: ['kind'],
}

/** A captured screenshot written into the session workspace. */
const SHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'screenshot' },
    path: { type: 'string' },
    tab: TAB_SCHEMA,
    url: { type: 'string' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    bytes: { type: 'integer' },
    capturedAt: { type: 'string' },
    scaledDown: { type: 'boolean' },
  },
  required: ['kind'],
}

/** The union every `browser_frame` call projects onto. */
const FRAME_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'tabs' },
        tabs: { type: 'array', items: TAB_SCHEMA },
      },
      required: ['kind', 'tabs'],
    },
    READ_SCHEMA,
    STATE_SCHEMA,
    SHOT_SCHEMA,
  ],
}

/** The union every `browser_eval` call projects onto. */
const EVAL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'eval' },
    tab: TAB_SCHEMA,
    result: { description: 'The value the expression returned, when it is small enough to inline.' },
    resultPath: { type: 'string' },
    bytes: { type: 'integer' },
    truncated: { type: 'boolean' },
    resultType: { type: 'string' },
  },
  required: ['kind'],
}

/**
 * Format a screenshot result for the model.
 * @param {Record<string, any>} value - the declared screenshot value.
 * @returns {Array<{type: string, text: string}>} model-facing content.
 */
function renderShot(value) {
  const tab = value.tab ?? {}
  return [
    {
      type: 'text',
      text: [
        `Screenshot of ${tab.title ?? 'the page'} (${value.url ?? tab.url ?? 'unknown URL'})`,
        `Saved to ${value.path} (${value.width}x${value.height}, ${value.bytes} bytes).`,
        ...(value.scaledDown === true
          ? ['The capture was downscaled to stay inside the bridge payload budget, so fine text may be unreadable; use read or browser_eval for exact content.']
          : []),
        'The image itself is not attached to this result; read the file with read_image or show it to the user with present.',
      ].join('\n'),
    },
  ]
}

/**
 * Format a `browser_frame` value for the model.
 * @param {Record<string, any>} value - the declared value.
 * @returns {Array<{type: string, text: string}>} model-facing content.
 */
function renderFrame(value) {
  if (value.kind === 'tabs') {
    const tabs = Array.isArray(value.tabs) ? value.tabs : []
    if (tabs.length === 0) {
      return [{ type: 'text', text: 'No sidebar browser tab is open. Ask the user to open the right Sidebar browser (Ctrl+T) and load a page first.' }]
    }
    const lines = tabs.map((tab, index) => {
      const marks = [tab.active ? 'active' : 'idle', tab.loading ? 'loading' : 'loaded']
      if (tab.sandboxed === false) marks.push('sandbox-off')
      if (tab.frameType === 'iframe') marks.push('web-iframe')
      return `${index}. id=${tab.tabId} [${marks.join(', ')}] ${tab.title} — ${tab.url}`
    })
    return [{ type: 'text', text: `Open sidebar browser tabs (${tabs.length}):\n${lines.join('\n')}` }]
  }
  if (value.kind === 'screenshot') return renderShot(value)

  const tab = value.tab ?? {}
  const parts = [`${tab.title ?? 'page'} — ${value.url ?? tab.url ?? 'unknown URL'}`]
  if (typeof value.selector === 'string' && value.selector !== '') parts.push(`selector: ${value.selector}`)
  if (typeof value.text === 'string' && value.text !== '') {
    parts.push(value.textTruncated === true ? `${value.text}\n[text truncated]` : value.text)
  }
  if (Array.isArray(value.nodes) && value.nodes.length > 0) {
    const nodes = value.nodes.map((node) => {
      const attrs = [
        node.id !== undefined ? `#${node.id}` : undefined,
        node.type !== undefined ? `type=${node.type}` : undefined,
        node.name !== undefined ? `name=${node.name}` : undefined,
      ].filter((part) => part !== undefined)
      const suffix = attrs.length > 0 ? ` (${attrs.join(' ')})` : ''
      return `- <${node.tag}> ${JSON.stringify(node.text)}${suffix} → ${node.selector}`
    })
    parts.push(`Interactable elements${value.nodesTruncated === true ? ' (truncated)' : ''}:\n${nodes.join('\n')}`)
  }
  return [{ type: 'text', text: parts.join('\n\n') }]
}

/**
 * Format a `browser_eval` value for the model.
 * @param {Record<string, any>} value - the declared value.
 * @returns {Array<{type: string, text: string}>} model-facing content.
 */
function renderEval(value) {
  const tab = value.tab ?? {}
  const head = `${tab.title ?? 'page'} — ${tab.url ?? 'unknown URL'}`
  if (value.resultPath !== undefined) {
    return [
      {
        type: 'text',
        text: `${head}\n\nThe expression returned ${value.bytes ?? 0} bytes of ${value.resultType ?? 'JSON'}, too large to inline. The full value is at ${value.resultPath}.`,
      },
    ]
  }
  if (value.result === undefined) {
    return [{ type: 'text', text: `${head}\n\nThe expression returned no value (undefined).` }]
  }
  let text
  try {
    text = JSON.stringify(value.result, null, 2)
  } catch {
    text = String(value.result)
  }
  if (typeof text !== 'string') text = String(value.result)
  return [
    {
      type: 'text',
      text: `${head}\n\nReturn value (${value.resultType ?? 'json'}):\n${text}`,
    },
  ]
}

/**
 * The Host-side bridge between agent tool calls and the attached browser page.
 *
 * One instance per plugin activation. It owns the pending-task table, the
 * client heartbeat state, and the loopback route that carries both.
 */
class BrowserBridge {
  /**
   * @param {object} options - bridge inputs.
   * @param {{get: Function, logger?: {info?: Function, warn?: Function}}} options.ctx - the plugin context.
   * @param {object} options.config - resolved plugin configuration.
   */
  constructor({ ctx, config }) {
    this.ctx = ctx
    this.config = config
    /** @type {Map<string, any>} */
    this.tasks = new Map()
    /** @type {Array<() => void>} */
    this.waiters = []
    /** @type {Map<string, {seenAt: number, userAgent: string, tabCount: number}>} */
    this.clients = new Map()
    this.disposed = false
  }

  /**
   * Record a client heartbeat and refresh its tab inventory.
   * @param {string} clientId - renderer-generated stable id.
   * @param {{userAgent?: string, tabCount?: number}} [facts] - reported facts.
   * @returns {void}
   */
  touchClient(clientId, facts = {}) {
    const previous = this.clients.get(clientId)
    this.clients.set(clientId, {
      seenAt: Date.now(),
      userAgent: typeof facts.userAgent === 'string' ? facts.userAgent : previous?.userAgent ?? '',
      tabCount: Number.isFinite(facts.tabCount) ? Number(facts.tabCount) : previous?.tabCount ?? 0,
    })
  }

  /**
   * Describe which browser tabs are currently reachable.
   * @returns {{attached: boolean, clients: number, tabCount: number, since: number|null}} liveness.
   */
  liveness() {
    const now = Date.now()
    let clients = 0
    let tabCount = 0
    let since = null
    for (const record of this.clients.values()) {
      if (now - record.seenAt > this.config.pollWaitMs + this.config.clientGraceMs) continue
      clients += 1
      tabCount += record.tabCount
      since = since === null ? record.seenAt : Math.min(since, record.seenAt)
    }
    return { attached: clients > 0, clients, tabCount, since }
  }

  /** @returns {Error} the refusal used when no renderer polls this bridge. */
  detachedError() {
    return new Error(
      'no sidebar browser page is attached to this app window. Open the right Sidebar browser (Ctrl+T), load a page, and keep the app page open; then retry.',
    )
  }

  /**
   * Wake every pending long poll.
   * @returns {void}
   */
  wake() {
    const waiters = this.waiters
    this.waiters = []
    for (const wake of waiters) wake()
  }

  /**
   * Claim the oldest unclaimed task, if any.
   * @returns {any|undefined} the claimed task.
   */
  claim() {
    const now = Date.now()
    for (const task of this.tasks.values()) {
      if (task.state !== 'pending') continue
      task.state = 'claimed'
      task.claimedAt = now
      return task
    }
    return undefined
  }

  /**
   * Settle one task from a renderer result.
   * @param {string} taskId - the claimed task id.
   * @param {{ok: boolean, result?: unknown, error?: string}} outcome - the renderer's answer.
   * @returns {{accepted: boolean, reason?: string}} whether the submission applied.
   */
  resolve(taskId, outcome) {
    const task = this.tasks.get(taskId)
    if (task === undefined) return { accepted: false, reason: 'unknown-or-settled-task' }
    if (task.state === 'cancelled') return { accepted: false, reason: 'cancelled' }
    if (task.state === 'pending') return { accepted: false, reason: 'not-claimed' }
    this.finish(task)
    if (outcome.ok === true) task.resolve(outcome.result)
    else task.reject(new Error(typeof outcome.error === 'string' && outcome.error !== '' ? outcome.error : 'the page operation failed'))
    return { accepted: true }
  }

  /**
   * Drop a task's bookkeeping; the caller keeps the promise.
   * @param {any} task - the task to settle.
   * @returns {void}
   */
  finish(task) {
    if (task.timer !== undefined) clearTimeout(task.timer)
    task.timer = undefined
    if (typeof task.releaseAbort === 'function') task.releaseAbort()
    task.releaseAbort = undefined
    task.settledAt = Date.now()
    task.state = 'settled'
    this.tasks.delete(task.id)
  }

  /**
   * Abandon claims whose renderer never answered, so a later poll can retry.
   * @returns {void}
   */
  reapClaims() {
    const now = Date.now()
    for (const task of this.tasks.values()) {
      if (task.state !== 'claimed') continue
      if (now - task.claimedAt <= this.config.taskTimeoutMs) continue
      task.state = 'pending'
      task.claimedAt = undefined
      this.ctx.logger?.warn?.(`dsh-browser-control: task ${task.action} was claimed but never answered; returning it to the queue`)
    }
  }

  /**
   * Run one action in the attached browser page and wait for its result.
   * @param {string} action - the wire action name.
   * @param {object} args - action arguments.
   * @param {{signal?: AbortSignal}} exec - tool execution facts.
   * @param {number} [timeoutMs] - override for the per-task deadline.
   * @returns {Promise<any>} the renderer's declared result value.
   */
  request(action, args, exec, timeoutMs) {
    if (this.disposed) return Promise.reject(new Error('dsh-browser-control: the plugin has been unloaded'))
    const signal = exec?.signal
    if (signal?.aborted) return Promise.reject(new Error('the tool call was aborted'))

    return new Promise((resolve, reject) => {
      const task = {
        id: randomUUID(),
        action,
        args,
        createdAt: Date.now(),
        state: 'pending',
        resolve,
        reject,
      }
      const settle = (fn, value) => {
        if (task.state === 'settled') return
        this.finish(task)
        fn(value)
      }
      const deadline = Number.isFinite(timeoutMs) ? timeoutMs : this.config.taskTimeoutMs
      task.timer = setTimeout(() => {
        const liveness = this.liveness()
        const suffix = liveness.attached
          ? `the attached browser page did not answer within ${deadline} ms`
          : 'no sidebar browser page is attached to this app window'
        settle(reject, new Error(`dsh-browser-control: ${suffix}`))
      }, deadline)
      if (typeof task.timer.unref === 'function') task.timer.unref()
      if (signal !== undefined) {
        const onAbort = () => {
          task.state = 'cancelled'
          settle(reject, new Error('the tool call was aborted'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        task.releaseAbort = () => signal.removeEventListener('abort', onAbort)
      }
      this.tasks.set(task.id, task)
      this.wake()
    })
  }
}

/**
 * Build the loopback route handler for the bridge.
 * @param {BrowserBridge} bridge - the owning bridge.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} the handler.
 */
function createRouteHandler(bridge) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.slice(ROUTE_PREFIX.length) || '/'
    const method = req.method ?? 'GET'

    try {
      if (method === 'GET' && path === '/status') {
        sendJson(res, 200, { status: 'ok', pendingTasks: bridge.tasks.size, ...bridge.liveness() })
        return
      }

      if (method === 'GET' && path === '/next') {
        const clientId = url.searchParams.get('c')
        if (typeof clientId !== 'string' || clientId === '') {
          sendJson(res, 400, { status: 'error', error: 'missing client id' })
          return
        }
        const tabs = Number(url.searchParams.get('tabs') ?? '')
        bridge.touchClient(clientId, { userAgent: String(req.headers['user-agent'] ?? ''), tabCount: Number.isFinite(tabs) ? tabs : undefined })
        bridge.reapClaims()

        let task = bridge.claim()
        const deadline = Date.now() + bridge.config.pollWaitMs
        while (task === undefined && !bridge.disposed && Date.now() < deadline) {
          const remaining = deadline - Date.now()
          if (remaining <= 0) break
          let wake
          const notified = new Promise((resolve) => {
            wake = resolve
            bridge.waiters.push(wake)
          })
          const timer = setTimeout(() => {
            bridge.waiters = bridge.waiters.filter((entry) => entry !== wake)
            wake()
          }, Math.min(remaining, 5_000))
          await notified
          clearTimeout(timer)
          bridge.reapClaims()
          task = bridge.claim()
        }
        if (res.writableEnded || res.destroyed) return
        if (task === undefined) {
          sendJson(res, 200, { status: 'idle' })
          return
        }
        sendJson(res, 200, { status: 'task', task: { id: task.id, action: task.action, args: task.args } })
        return
      }

      if (method === 'POST' && path === '/result') {
        const raw = await readBody(req, MAX_BODY_BYTES)
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          sendJson(res, 400, { status: 'error', error: 'invalid JSON body' })
          return
        }
        if (typeof parsed !== 'object' || parsed === null) {
          sendJson(res, 400, { status: 'error', error: 'expected an object body' })
          return
        }
        const { clientId, taskId, result, error } = parsed
        if (typeof clientId !== 'string' || typeof taskId !== 'string') {
          sendJson(res, 400, { status: 'error', error: 'clientId and taskId are required' })
          return
        }
        bridge.touchClient(clientId, {})
        const outcome = typeof error === 'string' && error !== '' ? { ok: false, error } : { ok: true, result }
        const applied = bridge.resolve(taskId, outcome)
        sendJson(res, 200, { status: applied.accepted ? 'accepted' : 'ignored', reason: applied.reason })
        return
      }

      sendJson(res, 404, { status: 'error', error: `no route for ${method} ${path}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      bridge.ctx.logger?.warn?.(`dsh-browser-control: route failed: ${message}`)
      if (!res.headersSent) sendJson(res, 500, { status: 'error', error: message })
      else res.end()
    }
  }
}

/**
 * Write a spilled payload into the session workspace.
 * @param {string} name - file name within the artifact directory.
 * @param {Buffer} bytes - the payload.
 * @returns {string} the absolute path written.
 */
function writeArtifact(name, bytes) {
  const target = join(artifactRoot(), name)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes)
  return target
}

/**
 * Render any value as JSON text, trimming to `limit` characters.
 * @param {unknown} value - the value.
 * @param {number} limit - maximum number of characters.
 * @returns {{text: string, truncated: boolean}} the rendering.
 */
function textOf(value, limit) {
  if (value === null || value === undefined) return { text: '', truncated: false }
  if (typeof value === 'string') {
    return value.length > limit ? { text: value.slice(0, limit), truncated: true } : { text: value, truncated: false }
  }
  let text
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  if (typeof text !== 'string') text = String(value)
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false }
}

/**
 * Project a page-state renderer answer onto the declared state schema.
 * @param {any} result - the renderer answer.
 * @returns {Record<string, unknown>} the declared value.
 */
function projectState(result) {
  if (result?.tab === undefined) throw new Error('the page returned no tab identity')
  const value = {
    kind: 'state',
    tab: result.tab,
    url: typeof result.url === 'string' && result.url !== '' ? result.url : result.tab.url,
    title: typeof result.title === 'string' && result.title !== '' ? result.title : result.tab.title,
  }
  const rendered = textOf(result.text, 20_000)
  if (rendered.text !== '') {
    value.text = rendered.text
    if (rendered.truncated === true || result.textTruncated === true) value.textTruncated = true
  }
  return value
}

/**
 * Summarize one `browser_frame` result value for the tool log.
 * @param {Record<string, unknown>} args - the call arguments.
 * @returns {Record<string, unknown>} presentation metadata.
 */
function frameMeta(args) {
  return { action: args.action }
}

/**
 * Append one line to the plugin's boot log.
 *
 * Loading a profile plugin is otherwise invisible: the loader reports a failed
 * fiber without saying which module it was, and the Host process keeps no log
 * file. The log is written only when a marker file exists, so it stays off
 * until someone opts in by creating the marker:
 *
 *   `$DSH_PROFILE_DIR/.dsh-browser/TRACE`      write `boot.log` beside it
 *   `$DSH_PROFILE_DIR/.dsh-browser/TRACE_ABS`  write `DSH_BROWSER_CONTROL_TRACE`
 *
 * The marker lives beside the spilled artifacts rather than in the session
 * working directory, because the Host's own cwd is the DSH installation.
 * @param {string} message - the line to record.
 * @returns {void}
 */
function trace(message) {
  const explicit = process.env.DSH_BROWSER_CONTROL_TRACE
  const base = artifactRoot()
  const marker = existsSync(join(base, 'TRACE_ABS')) || existsSync(join(base, 'TRACE'))
  const target = typeof explicit === 'string' && explicit !== ''
    ? explicit
    : (marker ? join(base, 'boot.log') : undefined)
  if (target === undefined) return
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `${new Date().toISOString()} ${message}\n`, { flag: 'a' })
  } catch (error) {
    /* a failed trace never fails activation */
  }
}

// Marker checks happen at module scope so a loaded-but-mis-ordered plugin is
// distinguishable from one the loader never resolved.
trace(`module loaded (pid ${process.pid}, cwd ${process.cwd()}, profile ${process.env.DSH_PROFILE ?? 'none'})`)

/**
 * Register the whole Host surface.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {object} [rawConfig] - the loader row's `config`.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  trace(`apply() entered (pid ${process.pid}, cwd ${process.cwd()}, profile ${process.env.DSH_PROFILE ?? 'none'})`)
  const config = {
    pollWaitMs: Number.isFinite(rawConfig?.pollWaitMs) ? Number(rawConfig.pollWaitMs) : DEFAULT_POLL_WAIT_MS,
    taskTimeoutMs: Number.isFinite(rawConfig?.taskTimeoutMs) ? Number(rawConfig.taskTimeoutMs) : DEFAULT_TASK_TIMEOUT_MS,
    clientGraceMs: Number.isFinite(rawConfig?.clientGraceMs) ? Number(rawConfig.clientGraceMs) : DEFAULT_CLIENT_GRACE_MS,
    maxResultBytes: Number.isFinite(rawConfig?.maxResultBytes) ? Number(rawConfig.maxResultBytes) : 512 * 1024,
  }
  const bridge = new BrowserBridge({ ctx, config })

  /** Reject every outstanding task; used by both teardown effects. */
  const rejectAll = (reason) => {
    bridge.disposed = true
    for (const task of [...bridge.tasks.values()]) {
      bridge.finish(task)
      task.reject(new Error(reason))
    }
    bridge.wake()
  }

  // Both services are declared in `inject`, so they are present here. The
  // guards stay anyway: a plugin is mounted into profiles it does not control,
  // and a missing service must degrade to a warning rather than a failed fiber.
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    trace('no webServer service: bridge inactive')
    ctx.logger?.warn?.('dsh-browser-control: no webServer service; the sidebar browser bridge is inactive')
  } else {
    ctx.effect(() => {
      const dispose = webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: createRouteHandler(bridge) })
      trace(`bridge route registered on ${ROUTE_PREFIX}`)
      ctx.logger?.info?.(`dsh-browser-control: bridge listening on ${ROUTE_PREFIX}`)
      return () => {
        dispose()
        rejectAll('dsh-browser-control: the plugin was unloaded before the page answered')
      }
    }, 'dsh-browser-control: http bridge')
  }

  ctx.effect(() => () => {
    rejectAll('dsh-browser-control: the plugin was unloaded before the page answered')
  }, 'dsh-browser-control: task cleanup')

  const tools = ctx.get('tools')
  if (tools === undefined) {
    trace('no tools service: agent tools were not registered')
    ctx.logger?.warn?.('dsh-browser-control: no tools service; the agent tools were not registered')
    return
  }
  trace('tools service found; registering browser_frame and browser_eval')

  ctx.effect(() => tools.register({
    name: 'browser_frame',
    description: [
      'Inspect and modify the page shown in a DeepSeek Harness right-Sidebar browser tab.',
      'That tab is the browser the user opened inside DSH (right Sidebar → Browser, Ctrl+T). It is not the user\'s system browser, not this agent\'s web_fetch, and not a real Chromium session you own.',
      'Actions:',
      '- list: list the open sidebar tabs with their ids, titles, and URLs. Start here, then pass the index or the tab id of the tab you want as `tab`.',
      '- read: return a tab\'s URL, title, visible text, and its interactable elements with exact CSS selectors. Read before you click or type.',
      '- click: click one element, found by `selector` or by visible `text`.',
      '- type: set the value of an input, textarea, or contenteditable element found by `selector`, dispatching input and change events; with `submit` it presses Enter afterwards.',
      '- navigate: load an HTTP(S) URL in the tab.',
      '- screenshot: capture the visible page into a PNG file inside the session workspace and return its path.',
      'The page is live and shared with the user. Read before writing, and do not submit forms, sign in, buy, or delete anything unless the user asked for it.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read', 'click', 'type', 'navigate', 'screenshot'],
          description: 'Which operation to run.',
        },
        tab: {
          type: 'string',
          description: 'Target tab: the tab id from `list`, the tab title, or a substring of its URL. Defaults to the active tab, then the first tab.',
        },
        selector: {
          type: 'string',
          description: 'CSS selector for read/click/type. For `read` it narrows the extracted text and elements.',
        },
        text: {
          type: 'string',
          description: 'For click without a selector: the visible text of the element to click. For type: the text to enter.',
        },
        url: { type: 'string', description: 'Absolute HTTP(S) URL for navigate.' },
        submit: { type: 'boolean', description: 'For type: press Enter after entering the text.' },
        limit: { type: 'integer', description: 'Maximum characters of page text to return (default 20000, max 200000).' },
        includeElements: { type: 'boolean', description: 'For read: include interactable elements with selectors (default true).' },
        timeoutMs: { type: 'integer', description: 'How long to wait for the page to answer (default 60000, max 120000).' },
      },
    },
    output: { schema: FRAME_OUTPUT_SCHEMA, render: (_args, value) => renderFrame(value), presentationMeta: frameMeta },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(200_000, Math.trunc(args.limit))) : 20_000
      const timeoutMs = Number.isFinite(args.timeoutMs) ? Math.max(1_000, Math.min(120_000, Math.trunc(args.timeoutMs))) : config.taskTimeoutMs

      if (args.action !== 'list' && !bridge.liveness().attached) throw bridge.detachedError()

      const request = { tab: args.tab, selector: args.selector, limit }

      if (args.action === 'list') {
        const result = await bridge.request('list', {}, exec, timeoutMs)
        return { kind: 'tabs', tabs: Array.isArray(result?.tabs) ? result.tabs : [] }
      }

      if (args.action === 'read') {
        const result = await bridge.request('read', { ...request, includeElements: args.includeElements !== false }, exec, timeoutMs)
        if (result?.tab === undefined) throw new Error('the page returned no tab identity')
        const value = { kind: 'read', tab: result.tab }
        if (typeof result.selector === 'string' && result.selector !== '') value.selector = result.selector
        if (typeof result.text === 'string' && result.text !== '') {
          value.text = result.text
          if (result.textTruncated === true) value.textTruncated = true
        }
        if (Array.isArray(result.nodes) && result.nodes.length > 0) {
          value.nodes = result.nodes
          if (result.nodesTruncated === true) value.nodesTruncated = true
        }
        return value
      }

      if (args.action === 'click') {
        return projectState(await bridge.request('click', { ...request, text: args.text }, exec, timeoutMs))
      }

      if (args.action === 'type') {
        if (typeof args.text !== 'string') throw new Error('`text` is required for the type action')
        return projectState(await bridge.request('type', { ...request, text: args.text, submit: args.submit === true }, exec, timeoutMs))
      }

      if (args.action === 'navigate') {
        if (typeof args.url !== 'string' || args.url.trim() === '') throw new Error('`url` is required for the navigate action')
        return projectState(await bridge.request('navigate', { ...request, url: args.url.trim() }, exec, timeoutMs))
      }

      if (args.action === 'screenshot') {
        const result = await bridge.request('screenshot', request, exec, timeoutMs)
        if (typeof result?.dataUrl !== 'string' || !result.dataUrl.startsWith('data:image/png;base64,')) {
          throw new Error('the page did not return a PNG screenshot')
        }
        const bytes = Buffer.from(result.dataUrl.slice('data:image/png;base64,'.length), 'base64')
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const path = writeArtifact(join('shots', `shot-${stamp}.png`), bytes)
        return {
          kind: 'screenshot',
          tab: result.tab,
          path,
          url: typeof result.url === 'string' ? result.url : result.tab?.url,
          width: Number.isFinite(result.width) ? Math.trunc(result.width) : 0,
          height: Number.isFinite(result.height) ? Math.trunc(result.height) : 0,
          bytes: bytes.length,
          capturedAt: new Date().toISOString(),
          ...(result.scaledFrom !== undefined ? { scaledDown: true } : {}),
        }
      }

      throw new Error(`unsupported action ${JSON.stringify(args.action)}`)
    },
  }), 'dsh-browser-control: browser_frame tool')

  ctx.effect(() => tools.register({
    name: 'browser_eval',
    description: [
      'Run JavaScript inside a DeepSeek Harness right-Sidebar browser tab and return the value it produces.',
      'This is the escape hatch for what browser_frame cannot express: reading page data structures, driving multi-step flows, measuring layout, waiting for async work.',
      'The code runs in the visited page\'s own JavaScript context, as an async function body: use `return` to produce a value and `await` freely.',
      'Returned values must be JSON-serializable. DOM nodes are not, so project them — for example `return [...document.querySelectorAll("a")].map((a) => a.href)`.',
      'The page is live and shared with the user: keep the code small and idempotent, and avoid destructive or account-changing side effects unless the user asked for them.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['code'],
      properties: {
        code: { type: 'string', description: 'JavaScript function body executed inside the page. Use `return` for the result.' },
        tab: { type: 'string', description: 'Target tab: id, title, or URL substring. Defaults to the active tab.' },
        timeoutMs: { type: 'integer', description: 'How long to wait for the page to answer (default 60000, max 120000).' },
      },
    },
    output: { schema: EVAL_OUTPUT_SCHEMA, render: (_args, value) => renderEval(value), presentationMeta: () => ({}) },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (typeof args.code !== 'string' || args.code.trim() === '') throw new Error('`code` must be a non-empty string')
      if (!bridge.liveness().attached) throw bridge.detachedError()
      const timeoutMs = Number.isFinite(args.timeoutMs) ? Math.max(1_000, Math.min(120_000, Math.trunc(args.timeoutMs))) : config.taskTimeoutMs
      const result = await bridge.request('eval', { tab: args.tab, code: args.code }, exec, timeoutMs)
      if (result?.tab === undefined) throw new Error('the page returned no tab identity')
      const value = { kind: 'eval', tab: result.tab }
      if (typeof result.resultType === 'string') value.resultType = result.resultType
      const rendered = textOf(result.result, INLINE_LIMIT_BYTES)
      if (result.resultTruncated === true || rendered.truncated) {
        const serialized = typeof result.result === 'string' ? result.result : safeStringify(result.result)
        const path = writeArtifact(join('eval', `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), Buffer.from(serialized, 'utf8'))
        value.resultPath = path
        value.bytes = Buffer.byteLength(serialized, 'utf8')
        value.truncated = true
        return value
      }
      if (result.result !== undefined) value.result = result.result
      return value
    },
  }), 'dsh-browser-control: browser_eval tool')

  ctx.logger?.info?.('dsh-browser-control: browser_frame and browser_eval registered')
}

/**
 * Stringify a value for spilling, falling back to a safe rendering.
 * @param {unknown} value - the value to serialize.
 * @returns {string} the serialized text.
 */
function safeStringify(value) {
  try {
    const text = JSON.stringify(value, null, 2)
    return typeof text === 'string' ? text : String(value)
  } catch {
    return String(value)
  }
}
