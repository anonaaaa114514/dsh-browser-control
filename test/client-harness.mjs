/**
 * Offline verification for the Client half's page-expression generation.
 *
 * The riskiest code in this plugin is the JavaScript that gets built here and
 * evaluated inside the visited page. This test captures the Client module
 * through a stubbed `window.__ModuleLoader__`, then drives its real action
 * bodies against a small fake DOM. It proves the generated expression parses,
 * that the helper factory survives `toString()`, and that read/click/type/eval
 * behave — none of which the Host-only harness can reach.
 *
 * Run: node test/client-harness.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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

/** One fake element. */
class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.id = ''
    this.name = ''
    this.type = ''
    this.value = ''
    this.textContent = ''
    this.innerText = ''
    this.placeholder = ''
    this.attributes = new Map()
    this.children = []
    this.parentElement = null
    this.isConnected = true
    this.dispatched = []
    this.form = null
    this.style = {}
    this.scrolled = false
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
    if (name === 'id') this.id = String(value)
    if (name === 'name') this.name = String(value)
    if (name === 'type') this.type = String(value)
    if (name === 'placeholder') this.placeholder = String(value)
  }

  getAttribute(name) {
    if (name === 'id' && this.id) return this.id
    if (name === 'name' && this.name) return this.name
    if (name === 'type' && this.type) return this.type
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this
      this.children.push(node)
    }
    return this
  }

  contains(node) {
    if (node === this) return true
    return this.children.some((child) => child.contains(node))
  }

  matches(selector) {
    return parseSelector(selector).some((group) => matchCompound(this, group))
  }

  closest(selector) {
    let node = this
    while (node !== null) {
      if (node.matches(selector)) return node
      node = node.parentElement
    }
    return null
  }

  querySelector(selector) {
    const attributeOnly = /^\[([\w-]+)\]$/.exec(selector)
    if (attributeOnly !== null) {
      return all(this).find((element) => element.getAttribute(attributeOnly[1]) !== null) ?? null
    }
    const groups = parseSelector(selector)
    const candidates = all(this)
    const found = candidates.find((element) => groups.some((group) => group.some((compound) => matchCompound(element, compound)))) ?? null
    if (this === globalThis.document?.body?.parentElement && process.env.DSH_DEBUG_SELECTORS === '1') {
      console.error(`QS ${JSON.stringify(selector)} groups=${JSON.stringify(groups)} candidates=${candidates.length} found=${found === null ? 'null' : found.tagName}`)
    }
    return found
  }

  querySelectorAll(selector) {
    // The one selector the bundle applies to the document is an attribute-only
    // match for the sidebar browser carrier; the fixture handles it directly.
    const attributeOnly = /^\[([\w-]+)\]$/.exec(selector)
    if (attributeOnly !== null) {
      return all(this).filter((element) => element.getAttribute(attributeOnly[1]) !== null)
    }
    const groups = parseSelector(selector)
    return all(this).filter((element) => groups.some((group) => group.some((compound) => matchCompound(element, compound))))
  }

  getBoundingClientRect() {
    return { left: 10, top: 20, width: 100, height: 30, bottom: 50, right: 110 }
  }

  scrollIntoView() {
    this.scrolled = true
  }

  focus() {
    globalThis.document.activeElement = this
  }

  dispatchEvent(event) {
    this.dispatched.push(event.type)
    if (event.type === 'click' && typeof this.onclick === 'function') this.onclick(event)
    return true
  }
}

/** Every element under a root, in document order. */
function all(root) {
  const out = []
  for (const child of root.children) {
    out.push(child, ...all(child))
  }
  return out
}

/**
 * Parse a comma-separated selector list into compound groups.
 * Supports `tag`, `#id`, `[attr]`, `[attr="v"]`, `[attr=v]`,
 * `:nth-of-type(n)` and `>` between compounds.
 * @param {string} selector - the selector text.
 * @returns {Array<Array<{tag: string, id: string, attrs: Array<[string, string|null]>, nth: number|null}>>} groups.
 */
function parseSelector(selector) {
  return selector.split(',').map((group) =>
    group
      .split('>')
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .map((part) => {
        const compound = { tag: '', id: '', attrs: [], nth: null }
        let rest = part

        const idMatch = /#([A-Za-z][\w:.-]*)/.exec(rest)
        if (idMatch !== null) {
          compound.id = idMatch[1]
          rest = rest.replace(idMatch[0], ' ')
        }

        const nthMatch = /:nth-of-type\((\d+)\)/.exec(rest)
        if (nthMatch !== null) {
          compound.nth = Number(nthMatch[1])
          rest = rest.replace(nthMatch[0], ' ')
        }

        // A fresh regex per call: a global regex would carry `lastIndex` over
        // and silently skip attributes in the next compound.
        rest = rest.replace(/\[([\w-]+)(?:=("([^"]*)"|'([^']*)'|([^\]]*)))?\]/g, (_all, name, _value, quoted, single, bare) => {
          const value = quoted ?? single ?? bare
          compound.attrs.push([name, value === undefined || value === '' ? null : value])
          return ' '
        })

        const tag = rest.replace(/[.#:][\w:().-]*/g, ' ').trim().toLowerCase()
        compound.tag = tag
        return compound
      }),
  )
}

/**
 * Test one compound against one element (ignoring ancestor combinators, which
 * the fixture does not need).
 * @param {FakeElement} element - the element.
 * @param {{tag: string, id: string, attrs: Array<[string,string|null]>, nth: number|null}} compound - the compound.
 * @returns {boolean} whether it matches.
 */
function matchCompound(element, compound) {
  if (compound.tag !== '' && compound.tag !== '*' && compound.tag !== element.tagName.toLowerCase()) return false
  if (compound.id !== '' && element.id !== compound.id) return false
  for (const [name, value] of compound.attrs) {
    const actual = element.getAttribute(name)
    if (actual === null) return false
    if (value !== null && actual !== value) return false
  }
  if (compound.nth !== null && element.parentElement !== null) {
    const siblings = element.parentElement.children.filter((child) => child.tagName === element.tagName)
    if (siblings.indexOf(element) + 1 !== compound.nth) return false
  }
  return true
}

/** The fixture page. */
const html = new FakeElement('html')
const body = new FakeElement('body')
body.innerText = 'Welcome to the fixture page'
html.append(body)

const heading = new FakeElement('h1')
heading.innerText = 'Fixture'
body.append(heading)

const go = new FakeElement('button')
go.id = 'go'
go.innerText = 'Go now'
body.append(go)

const input = new FakeElement('input')
input.setAttribute('name', 'q')
input.setAttribute('placeholder', 'Search')
input.setAttribute('type', 'text')
body.append(input)

const anchor = new FakeElement('a')
anchor.setAttribute('href', 'https://example.test/')
anchor.innerText = 'Example link'
body.append(anchor)

const hidden = new FakeElement('button')
hidden.id = 'hidden'
hidden.innerText = 'Invisible'
hidden.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, bottom: 0, right: 0 })
body.append(hidden)

for (const element of all(html)) {
  // Default value property so the native-setter path is exercised.
  Object.defineProperty(element, 'value', {
    configurable: true,
    writable: true,
    value: element.value,
  })
}

globalThis.Element = FakeElement
globalThis.Node = FakeElement
globalThis.window = {
  innerHeight: 800,
  getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
  location: { href: 'https://example.test/page' },
}
globalThis.getComputedStyle = globalThis.window.getComputedStyle
globalThis.location = { href: 'https://example.test/page' }
globalThis.document = {
  body,
  title: 'Fixture page',
  activeElement: go,
  querySelector: (selector) => html.querySelector(selector),
  querySelectorAll: (selector) => html.querySelectorAll(selector),
  createElement: (tag) => new FakeElement(tag),
}
globalThis.setTimeout = setTimeout
globalThis.PointerEvent = class {
  constructor(type, init) {
    Object.assign(this, init ?? {}, { type })
  }
}
globalThis.MouseEvent = globalThis.PointerEvent
globalThis.KeyboardEvent = globalThis.PointerEvent
globalThis.Event = globalThis.PointerEvent

/** Captured bundle factories, keyed by bundle id. */
const bundles = new Map()
globalThis.window.__ModuleLoader__ = {
  load: (definition) => {
    bundles.set(definition.id, definition)
  },
}

// Load the real Client bundle so its factory registers, then materialize it.
const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
// eslint-disable-next-line no-new-func -- the bundle is plain script text, as the browser loads it
new Function('window', source)(globalThis.window)

check('client bundle registered its id', bundles.has('dsh-browser-control'), true)

const bundle = bundles.get('dsh-browser-control')
const clientModule = bundle.factory(() => {
  throw new Error('this bundle requires no platform modules')
})

check('client bundle exports apply', typeof clientModule.apply, 'function')
check('client bundle declares no required services', clientModule.inject, [])

// Drive the page bodies through the module's own public surface: the worker's
// `run` is private, so the expressions are rebuilt here from the bundle by
// asking the registered worker for one task each over a stubbed transport.
const posted = []
let claimQueue = []
/** Idle polls park briefly, exactly as a real long poll does. */
async function idlePoll() {
  await new Promise((resolve) => setTimeout(resolve, 5))
  return { ok: true, json: async () => ({ status: 'idle' }) }
}
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/result')) {
    posted.push(JSON.parse(init.body))
    return { ok: true, json: async () => ({ status: 'accepted' }) }
  }
  if (String(url).includes('/status')) {
    return { ok: true, json: async () => ({ status: 'ok' }) }
  }
  const next = claimQueue.shift()
  if (next === undefined) return idlePoll()
  return { ok: true, json: async () => ({ status: 'task', task: next }) }
}

/** Wait until one posted result is available for a task id. */
async function resultFor(taskId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs ?? 2000)
  while (Date.now() < deadline) {
    const found = posted.find((entry) => entry.taskId === taskId)
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return undefined
}

/**
 * Queue one task and collect its result.
 * @param {string} action - the action name.
 * @param {Record<string, unknown>} args - action arguments.
 * @returns {Promise<any>} the posted result or error payload.
 */
async function drive(action, args) {
  const id = `task-${action}-${Math.random().toString(36).slice(2, 7)}`
  claimQueue.push({ id, action, args })
  const result = await resultFor(id)
  if (result === undefined) return { error: `the worker never answered the ${action} task` }
  return result
}

/**
 * Materialize one expression from the bundle by re-running the body the worker
 * would run, using the bundle's own exported test seam when present.
 * @returns {Promise<void>} after the worker is started.
 */
async function startWorker() {
  const context = {
    effect(callback) {
      const dispose = callback()
      globalThis.__clientDispose = dispose
      return () => {}
    },
  }
  clientModule.apply(context)
  await new Promise((resolve) => setTimeout(resolve, 30))
}

await startWorker()

/**
 * Install the sidebar browser carrier the worker looks for.
 * @returns {FakeElement} the carrier element.
 */
function installCarrier() {
  const carrier = new FakeElement('webview')
  carrier.setAttribute('data-sidebar-browser-frame', 'webview')
  carrier.executeJavaScript = async (expression) => {
    // eslint-disable-next-line no-new-func -- the expression is what the guest would receive
    const run = new Function('return ' + expression)
    return await run()
  }
  carrier.getURL = () => 'https://example.test/page'
  carrier.getTitle = () => 'Fixture page'
  carrier.isLoading = () => false
  carrier.capturePage = async () => makeFakeCapture(1024, 768, 2_400_000)
  carrier.loadURL = async () => {}
  carrier.addEventListener = () => {}
  document.body.append(carrier)
  return carrier
}

/**
 * Build a fake NativeImage whose first encoding exceeds the screenshot budget,
 * so the downscale path is exercised rather than assumed.
 * @param {number} width - capture width.
 * @param {number} height - capture height.
 * @param {number} firstSize - characters the first `toDataURL()` returns.
 * @returns {any} the fake image.
 */
function makeFakeCapture(width, height, firstSize) {
  let size = { width, height }
  let calls = 0
  const image = {
    getSize: () => ({ ...size }),
    toDataURL: () => {
      calls += 1
      const length = calls === 1 ? firstSize : 400_000
      return `data:image/png;base64,${'A'.repeat(length)}`
    },
    resize: (options) => {
      const area = size.width * size.height
      const scale = Math.sqrt((options.width * options.height) / area)
      size = { width: options.width, height: options.height }
      // A real encoder shrinks with the pixel count; keep the same relationship.
      const scaled = { ...image, getSize: () => ({ ...size }) }
      scaled.toDataURL = () => {
        calls += 1
        return `data:image/png;base64,${'A'.repeat(Math.round(firstSize * scale * scale))}`
      }
      return scaled
    },
  }
  return image
}

const carrier = installCarrier()
const listed = await drive('list', {})
check('list finds the carrier', Array.isArray(listed.result?.tabs), true)
check('list reports a webview', listed.result?.tabs?.[0]?.frameType, 'webview')
check('list reports the guest URL', listed.result?.tabs?.[0]?.url, 'https://example.test/page')

const read = await drive('read', { limit: 500 })
check('read returned no error', read.error, undefined)
check('read reports the page text', String(read.result?.text ?? '').includes('Welcome to the fixture page'), true)
check('read reports the title', read.result?.tab?.title, 'Fixture page')
const nodeSelectors = (read.result?.nodes ?? []).map((node) => node.selector)
check('read exposed the button by id', nodeSelectors.includes('#go'), true)
check('read exposed the input by name', nodeSelectors.includes('input[name="q"]'), true)
check('read skipped the invisible button', nodeSelectors.includes('#hidden'), false)
check('read labelled the button', (read.result?.nodes ?? []).some((node) => node.text === 'Go now'), true)

const clicked = await drive('click', { selector: '#go' })
check('click returned no error', clicked.error, undefined)
check('click dispatched a full sequence', go.dispatched.join(','), 'pointerdown,mousedown,pointerup,mouseup,click')
check('click scrolled the element into view', go.scrolled, true)
check('click reported the page URL', clicked.result?.url, 'https://example.test/page')

const clickedByText = await drive('click', { text: 'Example link' })
check('click by text found the anchor', clickedByText.error, undefined)

const typed = await drive('type', { selector: 'input[name="q"]', text: 'hello' })
check('type returned no error', typed.error, undefined)
check('type set the field value', input.value, 'hello')
check('type dispatched input and change', input.dispatched.join(','), 'input,change')

const submitted = await drive('type', { selector: 'input[name="q"]', text: 'go', submit: true })
check('type with submit returned no error', submitted.error, undefined)
check('type with submit pressed Enter', input.dispatched.includes('keydown'), true)

const evaluated = await drive('eval', { code: 'return document.title + "!"' })
check('eval returned the value', evaluated.result?.result, 'Fixture page!')
check('eval reported the value type', evaluated.result?.resultType, 'string')

const evaluatedObject = await drive('eval', { code: 'return { links: [...document.querySelectorAll("a")].length }' })
check('eval returned a projected object', evaluatedObject.result?.result, { links: 1 })

const evaluatedFailure = await drive('eval', { code: 'throw new Error("boom")' })
check('an in-page throw is reported as an error', String(evaluatedFailure.error ?? '').includes('boom'), true)

const shot = await drive('screenshot', {})
check('screenshot returned no error', shot.error, undefined)
check('screenshot returned a PNG data URL', String(shot.result?.dataUrl ?? '').startsWith('data:image/png;base64,'), true)
check('an oversized capture is downscaled below the payload cap', shot.result?.dataUrl.length < 4 * 1024 * 1024, true)
check('downscaling is reported to the caller', shot.result?.scaledFrom, { width: 1024, height: 768 })
check('the downscaled size is reported', shot.result?.width < 1024, true)
check('the encoded size is reported', typeof shot.result?.encodedSize, 'number')

const missing = await drive('read', { selector: '#not-there' })
check('a missing selector is reported', String(missing.error ?? '').includes('no element matches selector'), true)

const missingTab = await drive('read', { tab: 'https://nothing.test/' })
check('an unknown tab is reported', String(missingTab.error ?? '').includes('no sidebar browser tab matches'), true)

// Text-match disambiguation, run last so the extra fixture links do not change
// the counts asserted above.
//
// Regression: "用户" must not resolve to a "用户协议" link that merely sits
// earlier in document order — the old single-pass partial match did exactly
// that on bilibili's search page.
const userTab = new FakeElement('a')
userTab.id = 'user-tab'
userTab.innerText = '用户'
body.append(userTab)
const userAgreement = new FakeElement('a')
userAgreement.id = 'user-agreement'
userAgreement.innerText = '用户协议'
body.append(userAgreement)

const clickedAmbiguous = await drive('click', { text: '用户' })
check('an exact text match wins over an earlier partial one', clickedAmbiguous.error, undefined)
check('the exact-match element received the click', userTab.dispatched.includes('click'), true)
check('the partial-match element was left alone', userAgreement.dispatched.includes('click'), false)

const unmatched = await drive('click', { text: '这个文本绝对不存在' })
check('an unmatched text reports close candidates', String(unmatched.error ?? '').includes('closest matches'), true)

// The worker must keep polling after every one of those actions.
await new Promise((resolve) => setTimeout(resolve, 50))
check('the worker is still alive after every action', typeof globalThis.__clientDispose, 'function')

// Stop the worker so the test process can exit: the production plugin stops the
// same way, through the disposer its `ctx.effect` returned.
if (typeof globalThis.__clientDispose === 'function') {
  await globalThis.__clientDispose()
}
await new Promise((resolve) => setTimeout(resolve, 50))

if (failures.length > 0) {
  console.error(`FAILED ${failures.length}/${checks} checks:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`OK: ${checks} checks passed`)
process.exit(0)
