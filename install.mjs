/**
 * Install dsh-browser-control into a DSH profile.
 *
 * DSH composes the profile's `cordis.yml` on every boot from the selected
 * bundle layers, so writing that file directly does not survive a restart. A
 * bundle is enabled durably by listing it in the profile manifest:
 *
 *   package.json -> dsh.profile.bundles -> <name>
 *
 * and the plugin declares its own layer through `dsh.bundle.patch`
 * (`cordis.patch.yml`), which the composition applies. This script therefore:
 *
 *   1. copies this package into `<profile>/node_modules/dsh-browser-control`
 *   2. declares it in `<profile>/package.json` dependencies
 *   3. adds it to `<profile>/package.json` `dsh.profile.bundles`
 *
 * It never runs a package manager and never edits the generated `cordis.yml`.
 *
 * Usage:
 *   node install.mjs                 # install into $DSH_PROFILE_DIR
 *   node install.mjs --profile <dir> # install into a specific profile directory
 *   node install.mjs --dry-run       # report what would change
 *   node install.mjs --uninstall     # remove both entries and the package copy
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package directory this script ships in. */
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))
/** The package name: its directory name, its bundle name, and its loader row id. */
const PACKAGE_NAME = 'dsh-browser-control'

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const uninstall = argv.includes('--uninstall')
const profileFlag = argv.indexOf('--profile')
const profileDir = profileFlag === -1
  ? process.env.DSH_PROFILE_DIR
  : resolve(argv[profileFlag + 1] ?? '')

if (typeof profileDir !== 'string' || profileDir === '') {
  console.error('no profile directory. Pass --profile <dir> or run with DSH_PROFILE_DIR set.')
  process.exit(2)
}

const manifestPath = join(profileDir, 'package.json')
if (!existsSync(manifestPath)) {
  console.error(`"${profileDir}" does not look like a DSH profile (no package.json).`)
  process.exit(2)
}

const target = join(profileDir, 'node_modules', PACKAGE_NAME)

/** Files and directories that make up the installed package. */
const ENTRIES = ['index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'icon.svg', 'locale', 'README.md', 'LICENSE']

/**
 * Report one planned or applied change.
 * @param {string} message - what changed.
 * @returns {void}
 */
function note(message) {
  console.log(`${dryRun ? '[dry-run] ' : ''}${message}`)
}

/**
 * Write one JSON file with a stable two-space layout.
 * @param {string} path - the file to write.
 * @param {unknown} value - the JSON value.
 * @returns {void}
 */
function writeJson(path, value) {
  if (dryRun) return
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.dependencies ??= {}
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles ??= []

if (uninstall) {
  if (manifest.dependencies[PACKAGE_NAME] !== undefined) {
    note(`remove the "${PACKAGE_NAME}" dependency from ${manifestPath}`)
    delete manifest.dependencies[PACKAGE_NAME]
  } else {
    note(`no "${PACKAGE_NAME}" dependency in ${manifestPath}`)
  }
  const at = manifest.dsh.profile.bundles.indexOf(PACKAGE_NAME)
  if (at !== -1) {
    note(`remove "${PACKAGE_NAME}" from dsh.profile.bundles`)
    manifest.dsh.profile.bundles.splice(at, 1)
  } else {
    note(`"${PACKAGE_NAME}" is not in dsh.profile.bundles`)
  }
  writeJson(manifestPath, manifest)
  if (existsSync(target)) {
    note(`remove ${target}`)
    if (!dryRun) rmSync(target, { recursive: true, force: true })
  }
  console.log('\nRestart DSH to finish unloading the plugin.')
  process.exit(0)
}

// 1. Copy the package.
mkdirSync(dirname(target), { recursive: true })
note(`copy ${PACKAGE_ROOT} -> ${target}`)
if (!dryRun) {
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  for (const entry of ENTRIES) {
    const from = join(PACKAGE_ROOT, entry)
    if (!existsSync(from)) continue
    cpSync(from, join(target, entry), { recursive: true })
  }
}

// 2. Declare the dependency so a later install keeps the package.
if (manifest.dependencies[PACKAGE_NAME] === undefined) {
  note(`declare "${PACKAGE_NAME}" in ${manifestPath} dependencies`)
  manifest.dependencies[PACKAGE_NAME] = 'file:./node_modules/dsh-browser-control'
} else {
  note(`"${PACKAGE_NAME}" is already declared in dependencies`)
}

// 3. Select the bundle so the composition inserts its layer at every boot.
if (!manifest.dsh.profile.bundles.includes(PACKAGE_NAME)) {
  note(`add "${PACKAGE_NAME}" to dsh.profile.bundles (this is what survives a restart)`)
  manifest.dsh.profile.bundles.push(PACKAGE_NAME)
} else {
  note(`"${PACKAGE_NAME}" is already in dsh.profile.bundles`)
}

writeJson(manifestPath, manifest)

console.log([
  '',
  dryRun ? 'Dry run only; nothing was written.' : 'Installed.',
  '',
  'Next:',
  '  1. Restart DSH so the composition includes the new bundle.',
  '  2. Reload the page so the browser-side worker starts polling.',
  '  3. Open the right Sidebar browser (Ctrl+T) and load an HTTP(S) page.',
  '  4. Ask the agent to list and read the sidebar tabs.',
].join('\n'))
