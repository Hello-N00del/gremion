// node --test test/host/fixtures/customer-provision/router-state.test.mjs
//
// TASK-043c P1: the proof's router check reads Traefik's STATE (enabled, no
// error), not the router's presence. The first case is the REAL shape the
// TASK-043b proof ledger recorded (edge-routers.txt): the four customer routers
// present but disabled because the chained edge-* middlewares were never
// declared on the production traefik service.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { judgeRouters } from './router-state.mjs'

const DISABLED = { status: 'disabled', error: ['middleware "edge-ratelimit-app@docker" does not exist'] }
const ENABLED = { entryPoints: ['websecure'], service: 'app@file', rule: 'Host(`rat.proof-x.proof.example.org`)', status: 'enabled', using: ['websecure'] }

describe('judgeRouters', () => {
  it('flags the 043b ledger shape: present but disabled with a missing middleware', () => {
    const v = judgeRouters({ 'tenant-proof-x': DISABLED, 'tenant-proof-x.kc': DISABLED, 'tenant-proof-y': DISABLED, 'tenant-proof-y.kc': DISABLED })
    assert.equal(v.length, 4)
    assert.match(v[0], /tenant-proof-x: status "disabled" \(middleware "edge-ratelimit-app@docker" does not exist\)/)
  })

  it('passes when every router is enabled and reports no error', () => {
    assert.deepEqual(judgeRouters({ 'tenant-proof-x': ENABLED, 'tenant-proof-x.kc': { ...ENABLED, error: [] } }), [])
  })

  it('fails an enabled router that still reports an error, and a router the API did not report', () => {
    assert.match(judgeRouters({ a: { status: 'enabled', error: ['boom'] } })[0], /a: enabled but reports boom/)
    assert.deepEqual(judgeRouters({ a: ENABLED, b: null }), ['b: not reported by Traefik'])
  })

  it('fails a router with no status at all', () => {
    assert.match(judgeRouters({ a: {} })[0], /a: status null/)
  })

  it('zero routers found is a failure, never a pass', () => {
    assert.equal(judgeRouters({}).length, 1)
    assert.equal(judgeRouters(undefined).length, 1)
  })
})

describe('the CLI the proof script calls', () => {
  const cli = fileURLToPath(new URL('./router-state.mjs', import.meta.url))
  const run = (input) => spawnSync(process.execPath, [cli], { input, encoding: 'utf8' })

  it('exits 0 on enabled routers and 1 on the ledger shape, printing the violations', () => {
    assert.equal(run(JSON.stringify({ 'tenant-x': ENABLED })).status, 0)
    const bad = run(JSON.stringify({ 'tenant-x': DISABLED }))
    assert.equal(bad.status, 1)
    assert.match(bad.stdout, /does not exist/)
  })

  it('exits 1 on an empty object and on non-JSON', () => {
    assert.equal(run('{}').status, 1)
    assert.equal(run('not json').status, 1)
  })
})
