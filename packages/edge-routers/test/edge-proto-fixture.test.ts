import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { platformMiddlewareLabels } from '../src/platform-middlewares.ts'
import { renderTenantRouter } from '../src/render.ts'
import { REPO_ROOT, deps } from './helpers.ts'

// The edge-proto drill runs a REAL Traefik against these fixtures; they must
// be what the library emits and what the platform labels state, or the drill
// proves something about hand-written YAML instead of about the emitter.
const FIXTURE = join(REPO_ROOT, 'test', 'host', 'fixtures', 'edge-proto')

describe('edge-proto fixtures', () => {
  it.each(['a', 'b'])('dynamic/tenant-%s.yml is the byte-exact renderTenantRouter output', (slug) => {
    const r = renderTenantRouter({ slug, domains: [{ host: `tenant-${slug}.example.org` }], ...deps })
    expect(readFileSync(join(FIXTURE, 'dynamic', `tenant-${slug}.yml`), 'utf8')).toBe(r.yaml)
  })

  it('the traefik container carries every platform middleware label, with the stated value', () => {
    const compose = readFileSync(join(FIXTURE, 'docker-compose.yml'), 'utf8')
    const want = platformMiddlewareLabels({ apex: 'example.org', sales: 'sales.example.org' })
    expect(Object.keys(want).length).toBeGreaterThan(20)
    for (const [k, v] of Object.entries(want)) expect(compose).toContain(`      ${k}: "${v}"\n`)
    // no bare, untiered limiter survives anywhere in the fixture
    expect(compose).not.toMatch(/middlewares\.edge-ratelimit\./)
  })

  it('the traefik container declares an explicit internaltest-only router (no generated default router)', () => {
    const compose = readFileSync(join(FIXTURE, 'docker-compose.yml'), 'utf8')
    expect(compose).toContain('traefik.http.routers.traefik.entrypoints: "internaltest"')
  })

  it('the platform apex router chains edge-hostpin-apex@docker first and names a resolver', () => {
    const apex = readFileSync(join(FIXTURE, 'dynamic', 'platform-apex.yml'), 'utf8')
    expect(apex).toMatch(/middlewares:\n {8}- "edge-hostpin-apex@docker"\n/)
    expect(apex).toMatch(/rule: "Host\(`example\.org`\)"/)
    expect(apex).toMatch(/certResolver: "le-http"/)
  })
})
