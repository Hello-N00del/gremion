// TASK-043 TDD 18 (G9, Q16): a customer's render carries its app@file router
// AND a Keycloak router on its issuer host, for its own realm's namespace and
// /auth/resources/ only, pin first, same chain; never /auth/admin, never
// another realm, never a host the tenant does not route.
import { describe, expect, it } from 'vitest'
import { KEYCLOAK_ROUTER_PRIORITY, KEYCLOAK_SERVICE, keycloakRouterName, renderTenantRouter } from '../src/render.js'
import { deps } from './helpers.js'

function render(hosts: string[], keycloak?: { realm: string; host: string }) {
  return renderTenantRouter({ slug: 'musterstadt', domains: hosts.map((host) => ({ host })), ...deps, ...(keycloak ? { keycloak } : {}) })
}

function block(yaml: string, name: string): string {
  const lines = yaml.split('\n')
  const start = lines.indexOf(`    ${name}:`)
  expect(start, `router ${name}`).toBeGreaterThan(-1)
  const out: string[] = []
  for (const l of lines.slice(start + 1)) {
    if (/^ {0,4}\S/.test(l)) break
    out.push(l)
  }
  return out.join('\n')
}

describe('the realm router (TDD 18)', () => {
  const r = render(['rat.musterstadt.example'], { realm: 'musterstadt', host: 'rat.musterstadt.example' })
  const yaml = r.yaml!

  it('holds the app@file router and a Keycloak router for exactly /auth/realms/<slug>/ and /auth/resources/', () => {
    expect(block(yaml, 'tenant-musterstadt')).toContain('service: "app@file"')
    const kc = block(yaml, keycloakRouterName('musterstadt'))
    expect(kc).toContain('rule: "Host(`rat.musterstadt.example`) && (PathPrefix(`/auth/realms/musterstadt/`) || PathPrefix(`/auth/resources/`))"')
    expect(kc).toContain(`service: "${KEYCLOAK_SERVICE}"`)
    expect(kc).toContain(`priority: ${KEYCLOAK_ROUTER_PRIORITY}`)
    expect(KEYCLOAK_ROUTER_PRIORITY).toBeGreaterThan(10)
    expect(kc).toMatch(/tls:\n {8}certResolver: "le-http"/)
  })

  it('chains the SAME pin first and the host router chain WITHOUT the proxy-trust stamp (TASK-043c Qc3)', () => {
    const kc = block(yaml, 'tenant-musterstadt.kc')
    const mws = [...kc.matchAll(/^ {8}- "([^"]+)"$/gm)].map((m) => m[1])
    // Keycloak never receives the app's shared secret
    expect(mws).toEqual(['edge-hostpin-musterstadt@file', 'edge-hsts-custom@docker', 'edge-ratelimit-app@docker', 'edge-perip-musterstadt@file'])
    expect(yaml).not.toMatch(/tenant-musterstadt\.kc:[\s\S]*proxytrust/)
    expect(r.routers[0]!.chain).toEqual([...r.keycloakRouter!.chain, 'gremion-ui-proxytrust@docker'])
    expect(r.keycloakRouter?.chain[0]).toBe(r.routers[0]!.chain[0])
  })

  it('never routes /auth/admin, /auth/js, a bare /auth or another realm', () => {
    expect(yaml).not.toMatch(/\/auth\/admin|\/auth\/js|PathPrefix\(`\/auth`\)|PathPrefix\(`\/auth\/realms\/`\)/)
    expect(yaml.match(/\/auth\/realms\/[a-z0-9-]+\//g)).toEqual(['/auth/realms/musterstadt/'])
    // declares no service and no new middleware: the pins and the per-IP cap only
    expect(yaml).not.toMatch(/^ {2}services:/m)
  })

  it('without the keycloak option the render is the TASK-034 shape (no Keycloak router)', () => {
    const plain = render(['rat.musterstadt.example'])
    expect(plain.yaml).not.toMatch(/keycloak|\/auth/)
    expect(plain.keycloakRouter ?? null).toBeNull()
  })

  it('refuses a Keycloak host the tenant does not route, and a realm that is not a slug', () => {
    expect(() => render(['rat.musterstadt.example'], { realm: 'musterstadt', host: 'other.example' })).toThrow(/not one of this tenant's routed hosts/)
    expect(() => render(['rat.musterstadt.example'], { realm: '../master', host: 'rat.musterstadt.example' })).toThrow(/invalid slug/)
  })

  it('refuses master, the ops realm platform, and any realm that is not the tenant slug (review B1, r2)', () => {
    for (const realm of ['master', 'platform', 'othertenant']) {
      expect(() => render(['rat.musterstadt.example'], { realm, host: 'rat.musterstadt.example' }), realm).toThrow(/realm/)
    }
    expect(() =>
      renderTenantRouter({ slug: 'master', domains: [{ host: 'rat.master.example' }], ...deps, keycloak: { realm: 'master', host: 'rat.master.example' } }),
    ).toThrow(/reserved realm/)
  })

  it("the realm router's name can collide with no other tenant's router: customers foo and foo-kc (review B1, r2)", () => {
    const foo = renderTenantRouter({ slug: 'foo', domains: [{ host: 'rat.foo.example' }], ...deps, keycloak: { realm: 'foo', host: 'rat.foo.example' } })
    const fooKc = renderTenantRouter({ slug: 'foo-kc', domains: [{ host: 'rat.foo-kc.example' }], ...deps, keycloak: { realm: 'foo-kc', host: 'rat.foo-kc.example' } })
    const names = (y: string) => [...y.matchAll(/^ {4}([A-Za-z0-9_.-]+):\s*$/gm)].map((m) => m[1])
    const a = new Set(names(foo.yaml!))
    const clash = names(fooKc.yaml!).filter((n) => a.has(n))
    expect(clash).toEqual([])
    // no slug can spell it: the slug alphabet has no dot
    expect(keycloakRouterName('foo')).not.toMatch(/^tenant-[a-z0-9-]{1,30}$/)
  })

  it('with two hosts, the realm router sits on the issuer host only', () => {
    const two = render(['a.musterstadt.example', 'rat.musterstadt.example'], { realm: 'musterstadt', host: 'rat.musterstadt.example' })
    expect(two.keycloakRouter?.host).toBe('rat.musterstadt.example')
    expect(two.keycloakRouter?.pin).toBe('edge-hostpin-musterstadt-1')
    expect((two.yaml!.match(/service: "keycloak@docker"/g) ?? []).length).toBe(1)
  })
})
