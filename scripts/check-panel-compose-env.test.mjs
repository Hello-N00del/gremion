/**
 * Every SECONDARY_TENANT_* variable the control panel reads from its environment is passed to the
 * control-panel service of docker-compose.app.yml.
 *
 *   node --test scripts/check-panel-compose-env.test.mjs
 *
 * The panel reads these on "Neuer Mandant" (the allowed customer hosts and the modules the install opts
 * in for them). A variable that the panel reads but the compose file does not pass is empty inside the
 * container whatever the install sets, so the form shows the core-only note even for an install that opts
 * a secondary-host customer in. The panel's own tests feed the variable through a mocked env and cannot see
 * that gap; this reads both artefacts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PANEL_SRC = join(ROOT, 'apps', 'control-panel', 'src')

/** Every non-test source file of the panel. */
function sourceFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(ts|svelte|js|mjs)$/.test(name) && !/\.(test|spec)\.[a-z]+$/.test(name)) out.push(p)
  }
  return out
}

/** The SECONDARY_TENANT_* names the panel reads through `env.NAME` or `process.env.NAME`. */
function variablesRead() {
  const names = new Set()
  for (const file of sourceFiles(PANEL_SRC)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/\benv\.(SECONDARY_TENANT_[A-Z0-9_]+)\b/g)) names.add(m[1])
  }
  return [...names].sort()
}

/** The environment of the control-panel service as a plain map (compose accepts a map or KEY=value lines). */
function panelEnvironment() {
  const compose = parseYaml(readFileSync(join(ROOT, 'docker-compose.app.yml'), 'utf8'))
  const e = compose.services?.['control-panel']?.environment
  assert.ok(e, 'docker-compose.app.yml has no environment for control-panel')
  if (!Array.isArray(e)) return e
  return Object.fromEntries(e.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
}

test('the guard sees the SECONDARY_TENANT_* variables the panel reads', () => {
  const read = variablesRead()
  assert.ok(read.includes('SECONDARY_TENANT_HOSTS'), `found only ${read.join(', ') || 'none'}`)
  assert.ok(read.includes('SECONDARY_TENANT_MODULES'), `found only ${read.join(', ') || 'none'}`)
})

test('every SECONDARY_TENANT_* variable the panel reads is passed to the control-panel service, from the install\'s own value', () => {
  const e = panelEnvironment()
  const notPassed = []
  for (const name of variablesRead()) {
    const value = typeof e[name] === 'string' ? e[name] : ''
    // `${NAME:-}` (or `${NAME}`): the value the install sets, empty when it sets none. A literal would pin one install's value.
    if (!new RegExp(`^\\$\\{${name}(:-)?\\}$`).test(value)) notPassed.push(name)
  }
  assert.deepEqual(notPassed, [])
})
