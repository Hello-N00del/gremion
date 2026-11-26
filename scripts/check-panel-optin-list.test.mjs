/**
 * The control panel's list of opt-in modules for a secondary host is one source, not two.
 *
 *   node --test scripts/check-panel-optin-list.test.mjs
 *
 * apps/control-panel .../customers/new/+page.server.ts keeps SECONDARY_OPT_IN, a hand copy of
 * SECONDARY_TENANT_MODULES_SET in infra/host/lib/common.sh (the host-side create decides; the panel only shows).
 * A module added to one and not the other would show the operator a promise the host refuses, or hide one it
 * grants. This guard reads both files of the tree it runs in and requires the two lists to be the same set.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

const PANEL = 'apps/control-panel/src/routes/(shell)/customers/new/+page.server.ts'
const HOST = 'infra/host/lib/common.sh'

/** The ids of `const SECONDARY_OPT_IN = ['a', 'b']` in the panel source. */
function panelList(src) {
  const m = src.match(/const SECONDARY_OPT_IN\s*=\s*\[([^\]]*)\]/)
  return m ? [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]) : []
}

/** The ids of `SECONDARY_TENANT_MODULES_SET="a b"` in common.sh. */
function hostList(src) {
  const m = src.match(/^SECONDARY_TENANT_MODULES_SET="([^"]*)"/m)
  return m ? m[1].split(/\s+/).filter(Boolean) : []
}

test('the panel opt-in list equals SECONDARY_TENANT_MODULES_SET of common.sh (one list, no drift)', () => {
  const panel = panelList(read(PANEL))
  const host = hostList(read(HOST))
  assert.ok(panel.length >= 3, `the panel list is found (${panel.join(' ')})`)
  assert.ok(host.length >= 3, `the host list is found (${host.join(' ')})`)
  assert.equal(new Set(panel).size, panel.length, 'the panel list has no repeat')
  assert.deepEqual([...panel].sort((a, b) => a.localeCompare(b)), [...host].sort((a, b) => a.localeCompare(b)), 'the panel and the host name the same opt-in modules')
})

test('the list readers see what they should (a hand copy that drifts is told apart)', () => {
  assert.deepEqual(panelList("const SECONDARY_OPT_IN = ['files', 'votes']"), ['files', 'votes'])
  assert.deepEqual(panelList('nothing here'), [])
  assert.deepEqual(hostList('X=1\nSECONDARY_TENANT_MODULES_SET="files votes"\n'), ['files', 'votes'])
  assert.deepEqual(hostList('  SECONDARY_TENANT_MODULES_SET="files"'), [], 'an indented line is not the assignment')
})
