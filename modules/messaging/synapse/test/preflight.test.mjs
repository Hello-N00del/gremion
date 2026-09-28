// TDD 4 (TASK-198): db-preflight.py refuses a Synapse database whose
// collation or ctype is not C, or a server whose major is not 18 -- naming the
// value -- and refuses zero rows. The query layer is injected: evaluate() is
// the pure judgement main() applies to what the live server returned.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import { PREFLIGHT, requireTools } from './helpers.mjs'

const LOADER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("db_preflight", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
rows, version = json.loads(sys.argv[2])
problems = m.evaluate([tuple(r) for r in rows], version)
print(json.dumps(problems))
`

function evaluate(rows, version) {
  requireTools(['python3'])
  const r = spawnSync('python3', ['-c', LOADER, PREFLIGHT, JSON.stringify([rows, version])], { encoding: 'utf8' })
  assert.equal(r.status, 0, `loading db-preflight.py failed: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

test('passes C / C on major 18', () => {
  assert.deepEqual(evaluate([['C', 'C']], '180003'), [])
})

test('fails on a non-C collation, naming it', () => {
  const p = evaluate([['en_US.utf8', 'C']], '180003')
  assert.equal(p.length, 1)
  assert.match(p[0], /datcollate/)
  assert.match(p[0], /en_US\.utf8/)
})

test('fails on a non-C ctype, naming it', () => {
  const p = evaluate([['C', 'en_US.utf8']], '180003')
  assert.equal(p.length, 1)
  assert.match(p[0], /datctype/)
  assert.match(p[0], /en_US\.utf8/)
})

test('fails on major 16, naming it', () => {
  const p = evaluate([['C', 'C']], '160004')
  assert.equal(p.length, 1)
  assert.match(p[0], /16/)
})

test('fails on zero rows and on an unreadable version', () => {
  assert.equal(evaluate([], '180003').length, 1)
  assert.match(evaluate([], '180003')[0], /no row/)
  assert.equal(evaluate([['C', 'C']], '').length, 1)
})

test('main() refuses without a config and exits non-zero, never 0', () => {
  requireTools(['python3'])
  const r = spawnSync('python3', [PREFLIGHT, '/nonexistent/homeserver.yaml'], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /db-preflight/)
})
