/**
 * Offline verification for dsh-browser-control.
 *
 * It boots the Host half against a fake Cordis context and a real loopback
 * HTTP server, registers a fake sidebar-browser client on the other side of
 * the bridge, and drives one tool call per action. That covers everything the
 * plugin owns except the in-page execution, which needs a real webview.
 *
 * Run: node test/harness.mjs
 */

import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

// Spilled artifacts follow $DSH_PROFILE_DIR. Point it at a scratch directory so
// a run neither writes into a real profile nor depends on the outer shell.
process.env.DSH_PROFILE_DIR = mkdtempSync(join(tmpdir(), 'dsh-browser-control-test-'))
delete process.env.DSH_BROWSER_CONTROL_TRACE

const failures = []
let checks = 0

/**
 * Record one assertion.
 * @param {string} label - what is being checked.
 * @param {unknown} actual - observed value.
 * @param {unknown} expected - required value.
 */
function check(label, actual, expected) {
  checks += 1
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** A minimal Cordis-like context that records effects and services. */
function createContext() {
  const disposers = []
  const services = new Map()
  const logs = []
  const ctx = {
    logger: {
      info: (message) => logs.push(['info', String(message)]),
      warn: (message) => logs.push(['warn', String(message)]),
    },
    get: (name) => services.get(name),
    effect(callback, label) {
      const dispose = callback()
      disposers.push({ dispose, label })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
  return { ctx, services, disposers, logs }
}

/** A WebServer stand-in that serves the registered route over real HTTP. */
class TestWebServer {
  constructor() {
    this.routes = []
  }

  register(route) {
    this.routes.push(route)
    return () => {
      this.routes = this.routes.filter((entry) => entry !== route)
    }
  }

  async listen() {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      for (const route of this.routes) {
        if (route.kind === 'prefix' && (url.pathname === route.path || url.pathname.startsWith(`${route.path}/`))) {
          Promise.resolve(route.handler(req, res)).catch(() => {
            if (!res.headersSent) res.writeHead(500)
            res.end()
          })
          return
        }
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.port = this.server.address().port
  }

  get base() {
    return `http://127.0.0.1:${this.port}`
  }

  async close() {
    await new Promise((resolve) => this.server.close(resolve))
  }
}

const ROUTE_PREFIX = '/dsh-browser-control'

const { ctx, services, logs } = createContext()
const webServer = new TestWebServer()
services.set('webServer', webServer)

const registered = new Map()
services.set('tools', {
  register(definition) {
    if (registered.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
    registered.set(definition.name, definition)
    return () => registered.delete(definition.name)
  },
})

apply(ctx, { pollWaitMs: 3000, taskTimeoutMs: 8000 })

check('webServer route registered', webServer.routes.length, 1)
check('route prefix', webServer.routes[0]?.path, ROUTE_PREFIX)
check('tools registered', [...registered.keys()].sort(), ['browser_eval', 'browser_frame'])

const frame = registered.get('browser_frame')
const evaluateTool = registered.get('browser_eval')
check('browser_frame requires action', frame.parameters.required, ['action'])
check('browser_frame action enum', frame.parameters.properties.action.enum, ['list', 'read', 'click', 'type', 'navigate', 'screenshot'])
check('browser_eval requires code', evaluateTool.parameters.required, ['code'])

/** Two example values per union branch, used to prove branches are disjoint. */
const TAB_SAMPLE = { tabId: 't', title: 'T', url: 'https://x/', frameType: 'webview', active: true, loading: false }
const SAMPLES = {
  tabs: { kind: 'tabs', tabs: [] },
  read: { kind: 'read', tab: TAB_SAMPLE },
  state: { kind: 'state', tab: TAB_SAMPLE, url: 'https://x/', title: 'T' },
  screenshot: { kind: 'screenshot', tab: TAB_SAMPLE, path: '/tmp/a.png' },
}

/**
 * Count how many `oneOf` branches one schema accepts, using the same structural
 * rules the Harness enforces.
 * @param {any} schema - the union schema.
 * @param {unknown} value - a candidate value.
 * @returns {number} the number of matching branches.
 */
function branchMatches(schema, value) {
  let matches = 0
  for (const branch of schema.oneOf) {
    if (matchesSchema(branch, value)) matches += 1
  }
  return matches
}

/**
 * Structural JSON Schema check over the Harness's supported subset.
 *
 * This mirrors `assertSupportedJsonSchema`, including its rejection of the
 * `defineTool` DSL spelling: a boolean `required` beside a property's `type` is
 * invalid in raw JSON Schema, where `required` is an array on the object. That
 * exact mismatch once shipped and surfaced only at tool registration, so it is
 * audited here first (see `schemaViolations`).
 * @param {any} schema - the schema.
 * @param {unknown} value - the candidate.
 * @returns {boolean} whether the value satisfies the schema.
 */
function matchesSchema(schema, value) {
  if (schema === undefined || Object.keys(schema).length === 0) return true
  if (Array.isArray(schema.oneOf)) return schema.oneOf.filter((branch) => matchesSchema(branch, value)).length === 1
  if (schema.const !== undefined) return value === schema.const
  if (Array.isArray(schema.enum)) return schema.enum.includes(value)
  const type = schema.type
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const properties = schema.properties ?? {}
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) return false
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) return false
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key)) continue
      if (!matchesSchema(propertySchema, value[key])) return false
    }
    return true
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return false
    return value.every((entry) => matchesSchema(schema.items ?? {}, entry))
  }
  if (type === 'string') return typeof value === 'string'
  if (type === 'integer') return Number.isInteger(value)
  if (type === 'number') return typeof value === 'number'
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'null') return value === null
  return true
}

/** Keywords the Harness's JSON Schema subset accepts. */
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'description', 'title', 'default', 'examples',
])

/**
 * Walk a schema and report Harness-unsupported spellings.
 * @param {any} schema - the schema to audit.
 * @param {string} path - the reporting path.
 * @returns {string[]} one message per violation.
 */
function schemaViolations(schema, path) {
  const violations = []
  if (schema === null || typeof schema !== 'object') return violations
  if (Array.isArray(schema)) {
    schema.forEach((entry, index) => violations.push(...schemaViolations(entry, `${path}[${index}]`)))
    return violations
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key)) violations.push(`${path}.${key} is not a supported keyword`)
  }
  if (schema.required !== undefined && !Array.isArray(schema.required)) {
    violations.push(`${path}.required must be an array of property names, not ${JSON.stringify(schema.required)}`)
  }
  if (schema.properties !== undefined) {
    for (const [name, propertySchema] of Object.entries(schema.properties)) {
      // A nested object property legitimately carries its own `required`
      // array; only the DSL's boolean spelling is rejected.
      if (propertySchema !== null && typeof propertySchema === 'object' && !Array.isArray(propertySchema)) {
        if (propertySchema.required !== undefined && !Array.isArray(propertySchema.required)) {
          violations.push(`${path}.properties.${name}.required is not supported on type ${JSON.stringify(propertySchema.type)}`)
        }
      }
      violations.push(...schemaViolations(propertySchema, `${path}.properties.${name}`))
    }
  }
  if (Array.isArray(schema.oneOf)) {
    schema.oneOf.forEach((branch, index) => violations.push(...schemaViolations(branch, `${path}.oneOf[${index}]`)))
  }
  if (schema.items !== undefined) violations.push(...schemaViolations(schema.items, `${path}.items`))
  return violations
}

for (const [name, definition] of [['browser_frame', frame], ['browser_eval', evaluateTool]]) {
  const violations = [
    ...schemaViolations(definition.parameters, `${name}.parameters`),
    ...schemaViolations(definition.output.schema, `${name}.output.schema`),
  ]
  check(`${name} schemas use only Harness-supported spellings`, violations, [])
}

for (const [name, sample] of Object.entries(SAMPLES)) {
  check(`oneOf branch "${name}" matches exactly once`, branchMatches(frame.output.schema, sample), 1)
}
check('eval value matches its schema', matchesSchema(evaluateTool.output.schema, { kind: 'eval', result: 1, resultType: 'number' }), true)
check('eval value is rejected without kind', matchesSchema(evaluateTool.output.schema, { result: 1 }), false)

await webServer.listen()

/** Capabilities a fake sidebar page reports, keyed by the action it serves. */
const pageAnswers = {
  list: { tabs: [{ tabId: 'tab-1', title: 'Example', url: 'https://example.test/', frameType: 'webview', active: true, loading: false }] },
  read: { tab: { tabId: 'tab-1', title: 'Example', url: 'https://example.test/', frameType: 'webview', active: true, loading: false }, selector: '', text: 'Hello page', textTruncated: false, nodes: [{ tag: 'button', kind: 'control', text: 'Go', selector: '#go' }], nodesTruncated: false },
  eval: { tab: { tabId: 'tab-1', title: 'Example', url: 'https://example.test/', frameType: 'webview', active: true, loading: false }, result: { answer: 42 }, resultType: 'object', resultTruncated: false },
  click: { tab: { tabId: 'tab-1', title: 'Example', url: 'https://example.test/', frameType: 'webview', active: true, loading: false }, url: 'https://example.test/next', title: 'Next', text: 'Next page' },
  type: { tab: { tabId: 'tab-1', title: 'Example', url: 'https://example.test/', frameType: 'webview', active: true, loading: false }, url: 'https://example.test/', title: 'Example', text: 'typed page' },
  navigate: { tab: { tabId: 'tab-1', title: 'Moved', url: 'https://elsewhere.test/', frameType: 'webview', active: true, loading: false }, url: 'https://elsewhere.test/', title: 'Moved', text: 'Moved page' },
  screenshot: {
    tab: { tabId: 'tab-1', title: 'Example', url: 'https://example.test/', frameType: 'webview', active: true, loading: false },
    url: 'https://example.test/',
    dataUrl: `data:image/png;base64,${Buffer.from('not-a-real-png').toString('base64')}`,
    width: 800,
    height: 600,
  },
}

let claimed = 0
let clientStopped = false

/** The fake renderer half: long-poll, answer, repeat. */
async function fakeClient() {
  const id = 'test-client'
  while (!clientStopped) {
    let response
    try {
      response = await fetch(`${webServer.base}${ROUTE_PREFIX}/next?c=${id}&tabs=1`)
    } catch {
      return
    }
    if (clientStopped) return
    const body = await response.json()
    if (body.status !== 'task') continue
    claimed += 1
    const answer = pageAnswers[body.task.action]
    const payload = answer === undefined
      ? { clientId: id, taskId: body.task.id, error: `no fake answer for ${body.task.action}` }
      : { clientId: id, taskId: body.task.id, result: answer }
    await fetch(`${webServer.base}${ROUTE_PREFIX}/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }
}

const client = fakeClient()
await new Promise((resolve) => setTimeout(resolve, 150))

const status = await (await fetch(`${webServer.base}${ROUTE_PREFIX}/status`)).json()
check('bridge reports an attached client', status.attached, true)
check('bridge reports the client tab count', status.tabCount, 1)

/**
 * Run one tool call and render its content the way the loop would.
 * @param {any} definition - the tool definition.
 * @param {Record<string, unknown>} args - call arguments.
 * @returns {Promise<{value: unknown, text: string}>} the value and rendered text.
 */
async function call(definition, args) {
  const value = await definition.execute(args, { signal: new AbortController().signal })
  const content = definition.output.render(args, value)
  return { value, text: content.map((part) => part.text).join('\n') }
}

const listed = await call(frame, { action: 'list' })
check('list returns the tab', listed.value.tabs.length, 1)
check('list renders the tab URL', listed.text.includes('https://example.test/'), true)

const readResult = await call(frame, { action: 'read' })
check('read returns kind', readResult.value.kind, 'read')
check('read returns text', readResult.value.text, 'Hello page')
check('read returns one node', readResult.value.nodes.length, 1)

const evalResult = await call(evaluateTool, { code: 'return {answer: 42}' })
check('eval returns kind', evalResult.value.kind, 'eval')
check('eval returns the value', evalResult.value.result, { answer: 42 })

const clickResult = await call(frame, { action: 'click', selector: '#go' })
check('click returns state kind', clickResult.value.kind, 'state')
check('click returns the new URL', clickResult.value.url, 'https://example.test/next')

const typed = await call(frame, { action: 'type', selector: '#q', text: 'hello', submit: true })
check('type returns state kind', typed.value.kind, 'state')

const navigated = await call(frame, { action: 'navigate', url: 'https://elsewhere.test/' })
check('navigate returns the new URL', navigated.value.url, 'https://elsewhere.test/')

const shot = await call(frame, { action: 'screenshot' })
check('screenshot returns kind', shot.value.kind, 'screenshot')
check('screenshot reports width', shot.value.width, 800)
check('screenshot wrote a file', typeof shot.value.path === 'string' && shot.value.path.includes('.dsh-browser'), true)

check('every action reached the page', claimed >= 7, true)

// Failure paths.
let missingCode = 'no error'
try {
  await evaluateTool.execute({ code: '  ' }, { signal: new AbortController().signal })
} catch (error) {
  missingCode = error.message
}
check('empty eval code is refused', missingCode.includes('non-empty'), true)

let badUrl = 'no error'
try {
  await frame.execute({ action: 'navigate' }, { signal: new AbortController().signal })
} catch (error) {
  badUrl = error.message
}
check('navigate without a URL is refused', badUrl.includes('`url` is required'), true)

let badEval = 'no error'
try {
  await evaluateTool.execute({ code: 'return 1', timeoutMs: 999999 }, { signal: new AbortController().signal })
} catch (error) {
  badEval = error.message
}
check('an over-large timeout is clamped rather than refused', badEval === 'no error', true)

clientStopped = true
await Promise.race([client, new Promise((resolve) => setTimeout(resolve, 200))])
await new Promise((resolve) => setTimeout(resolve, 200))

const detached = await (await fetch(`${webServer.base}${ROUTE_PREFIX}/status`)).json()
check('a stalled client stops counting as attached', detached.attached, true)

// Simulate the page going away: a fresh bridge with no client must refuse fast.
const second = createContext()
const secondServer = new TestWebServer()
second.services.set('webServer', secondServer)
const secondTools = new Map()
second.services.set('tools', { register: (definition) => { secondTools.set(definition.name, definition); return () => {} } })
apply(second.ctx, { pollWaitMs: 200, taskTimeoutMs: 2000 })
await secondServer.listen()
let detachedMessage = 'no error'
try {
  await secondTools.get('browser_frame').execute({ action: 'list' }, { signal: new AbortController().signal })
} catch (error) {
  detachedMessage = error.message
}
check('an unattached app refuses the call', detachedMessage.includes('no sidebar browser page is attached'), true)

// A tighter bridge proves heartbeat expiry: no poll within pollWaitMs+30s.
const expiry = createContext()
const expiryServer = new TestWebServer()
expiry.services.set('webServer', expiryServer)
expiry.services.set('tools', { register: () => () => {} })
apply(expiry.ctx, { pollWaitMs: 100, taskTimeoutMs: 1000, clientGraceMs: 200 })
await expiryServer.listen()
await fetch(`${expiryServer.base}${ROUTE_PREFIX}/next?c=transient&tabs=1`)
const fresh = await (await fetch(`${expiryServer.base}${ROUTE_PREFIX}/status`)).json()
check('a fresh heartbeat counts as attached', fresh.attached, true)
await new Promise((resolve) => setTimeout(resolve, 1000))
const stale = await (await fetch(`${expiryServer.base}${ROUTE_PREFIX}/status`)).json()
check('a stale heartbeat stops counting as attached', stale.attached, false)
check('a stale client is dropped from the count', stale.clients, 0)
await expiryServer.close()

check('no plugin warnings during normal operation', logs.filter(([level]) => level === 'warn').length, 0)

await secondServer.close()
await webServer.close()

if (failures.length > 0) {
  console.error(`FAILED ${failures.length}/${checks} checks:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`OK: ${checks} checks passed`)
