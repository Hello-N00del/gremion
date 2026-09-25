import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COLOUR_BOUND_SERVICES, classifyRouter, classifyService, qualifyService } from '../src/classify.js'
import { renderTenantRouter, TENANT_SERVICE } from '../src/render.js'
import { REPO_ROOT, deps } from './helpers.js'

const VERIFY = join(REPO_ROOT, 'infra', 'host', 'bin', 'gremion-verify')

/**
 * The colour-bound alternatives of gremion-verify's check_routers `case`, read
 * as TEXT: the one line whose arm assigns ROUTER_CLASS[...]="colour-bound".
 */
function bashColourBoundTable(): string[] {
  const src = readFileSync(VERIFY, 'utf8').split('\n')
  const arms = src
    .map((l, i) => ({ l, next: src[i + 1] ?? '' }))
    .filter(({ l, next }) => /^\s+[a-z@|-]+\)\s*$/.test(l) && /ROUTER_CLASS\["\$name"\]="colour-bound"/.test(next))
  expect(arms, 'exactly one colour-bound case arm in gremion-verify').toHaveLength(1)
  return arms[0]!.l.trim().replace(/\)$/, '').split('|')
}

describe('classify — TDD 3', () => {
  it('app|public|app-next|public-next@file are colour-bound', () => {
    for (const s of ['app@file', 'public@file', 'app-next@file', 'public-next@file']) {
      expect(classifyService(s)).toBe('colour-bound')
    }
  })

  it('everything else is state-bound, including look-alikes from another provider', () => {
    for (const s of ['keycloak@docker', 'app@docker', 'app', 'fallback@docker', 'app@file ', 'App@file', 'apps@file', 'noop@internal']) {
      expect(classifyService(s)).toBe('state-bound')
    }
  })

  it('the bash check_routers table is EQUAL to COLOUR_BOUND_SERVICES', () => {
    expect([...bashColourBoundTable()].sort()).toEqual([...COLOUR_BOUND_SERVICES].sort())
  })

  it('an unqualified service resolves against the ROUTER\'s provider, as gremion-verify does', () => {
    expect(qualifyService('whoami', 'whoami@docker')).toBe('whoami@docker')
    expect(qualifyService('app', 'tenant-a@file')).toBe('app@file')
    expect(qualifyService('app@file', 'x@docker')).toBe('app@file')
    expect(classifyRouter({ name: 'tenant-a@file', service: 'app' })).toBe('colour-bound')
    expect(classifyRouter({ name: 'gremion-ui@docker', service: 'app' })).toBe('state-bound')
  })

  it('refuses a router name with no provider rather than guessing one', () => {
    expect(() => qualifyService('app', 'tenant-a')).toThrow(/provider/)
  })

  it('every router the emitter produces is colour-bound', () => {
    const r = renderTenantRouter({ slug: 'acme', domains: [{ host: 'a.example.net' }, { host: 'b.example.net' }], ...deps })
    expect(TENANT_SERVICE).toBe('app@file')
    for (const x of r.routers) expect(classifyRouter({ name: `${x.name}@file`, service: TENANT_SERVICE })).toBe('colour-bound')
  })
})
