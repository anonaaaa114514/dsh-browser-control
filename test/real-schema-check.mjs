/**
 * Validate this plugin's tool schemas with the real Harness implementation.
 *
 * `test/harness.mjs` checks the schemas with a local reimplementation, which is
 * exactly how a wrong `required` spelling once shipped: the copy agreed with
 * the mistake. This script imports `assertSupportedJsonSchema` out of the app's
 * own `@deepseek-ai/dsh-tools` (readable through Electron's ASAR support) so the
 * verdict comes from the code that rejects a tool at registration.
 *
 * Run with the app binary, not plain Node:
 *   ELECTRON_RUN_AS_NODE=1 "<app>/DeepSeek Harness.exe" \
 *     --expose-internals test/real-schema-check.mjs
 */

const TOOLS_URL = 'file:///E:/Deepseek%20Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'

const tools = await import(TOOLS_URL)
if (typeof tools.assertSupportedJsonSchema !== 'function') {
  console.error('assertSupportedJsonSchema is not exported; exported names:', Object.keys(tools).slice(0, 40).join(', '))
  process.exit(2)
}

const { apply } = await import('../index.js')

/** One tool registration target that records what the real registry would keep. */
const registered = new Map()
const ctx = {
  logger: { info: () => {}, warn: (message) => console.error('plugin warning:', message) },
  get: (name) => {
    if (name === 'webServer') return { register: () => () => {} }
    if (name === 'tools') {
      return {
        register(definition) {
          // Register exactly as the runtime does, so a bad schema throws here.
          if (typeof definition.output?.render !== 'function') throw new TypeError(`tool "${definition.name}" must declare output { schema, render }`)
          tools.assertSupportedJsonSchema(definition.output.schema)
          tools.assertSupportedJsonSchema(definition.parameters)
          registered.set(definition.name, definition)
          return () => registered.delete(definition.name)
        },
      }
    }
    return undefined
  },
  effect: (callback) => {
    const dispose = callback()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
}

apply(ctx, {})

const names = [...registered.keys()].sort()
console.log('tools registered through the real validator:', JSON.stringify(names))
if (names.length !== 2) {
  console.error(`FAILED: expected browser_eval and browser_frame, got ${names.length}`)
  process.exit(1)
}

// Prove the validator actually rejects the spelling that shipped the bug.
let caught = false
try {
  tools.assertSupportedJsonSchema({ type: 'object', properties: { kind: { type: 'string', const: 'read', required: true } }, required: ['kind'] })
} catch (error) {
  caught = error instanceof Error && error.message.includes('unsupported JSON schema')
}
console.log('boolean `required` is rejected by the real validator:', caught)
if (!caught) {
  console.error('FAILED: the real validator accepted the DSL spelling, so this check proves nothing')
  process.exit(1)
}

console.log('OK: both tool schemas pass the real Harness validator')
