// The pilot's Collabora router: every routed tenant host also carries a /office
// router that targets collabora@docker, so the editor iframe is same-origin with
// gremion-ui (CSP frame-src 'self') and the tenant needs no second host. The
// chain is the app chain WITHOUT the proxy-trust stamp (Collabora never receives
// the app's shared secret), with the SAME pin first.
import { describe, expect, it } from 'vitest'
import { COLLABORA_ROUTER_PRIORITY, COLLABORA_SERVICE, collaboraRouterName, renderTenantRouter } from '../src/render.js'
import { deps } from './helpers.js'

function render(slug: string, hosts: string[], keycloak?: { realm: string; host: string }) {
  return renderTenantRouter({ slug, domains: hosts.map((host) => ({ host })), ...deps, ...(keycloak ? { keycloak } : {}) })
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

describe('the Collabora router, one per routed host', () => {
  const r = render('musterstadt', ['rat.musterstadt.example'])
  const yaml = r.yaml!

  it('names the router tenant-<slug>.office (a dot the slug alphabet cannot spell) and targets collabora@docker', () => {
    expect(collaboraRouterName('musterstadt', 0)).toBe('tenant-musterstadt.office')
    expect(collaboraRouterName('musterstadt', 2)).toBe('tenant-musterstadt-2.office')
    const b = block(yaml, 'tenant-musterstadt.office')
    expect(b).toContain('rule: "Host(`rat.musterstadt.example`) && PathPrefix(`/office`)"')
    expect(b).toContain(`service: "${COLLABORA_SERVICE}"`)
    expect(COLLABORA_SERVICE).toBe('collabora@docker')
    expect(b).toContain(`priority: ${COLLABORA_ROUTER_PRIORITY}`)
    expect(COLLABORA_ROUTER_PRIORITY).toBeGreaterThan(10)
    expect(b).toContain('entryPoints: ["websecure"]')
    // an explicit resolver: a bare tls allocates a non-nil TLS struct and serves the default certificate
    expect(b).toMatch(/tls:\n {8}certResolver: "le-http"/)
  })

  it('chains the SAME pin first and the app chain WITHOUT the proxy-trust stamp', () => {
    const b = block(yaml, 'tenant-musterstadt.office')
    const mws = [...b.matchAll(/^ {8}- "([^"]+)"$/gm)].map((m) => m[1])
    expect(mws).toEqual(['edge-hostpin-musterstadt@file', 'edge-hsts-custom@docker', 'edge-ratelimit-app@docker', 'edge-perip-musterstadt@file'])
    expect(b).not.toMatch(/proxytrust/)
    expect(r.collaboraRouters).toHaveLength(1)
    expect(r.collaboraRouters![0]!.chain).toEqual(r.routers[0]!.chain.filter((m) => m !== 'gremion-ui-proxytrust@docker'))
    expect(r.collaboraRouters![0]!.pin).toBe(r.routers[0]!.pin)
  })

  it('routes /office and nothing else of Collabora, and declares no service and no new middleware', () => {
    expect(yaml.match(/PathPrefix\(`\/[a-z/]+`\)/g)).toEqual(['PathPrefix(`/office`)'])
    expect(yaml).not.toMatch(/^ {2}services:/m)
    expect(yaml).not.toMatch(/\/cool|\/browser|admin/)
  })

  it('emits one Collabora router per host, each with its own pin, in sorted host order', () => {
    const two = render('acme', ['b.example.net', 'a.example.net'])
    expect(two.collaboraRouters!.map((x) => [x.name, x.host, x.pin])).toEqual([
      ['tenant-acme.office', 'a.example.net', 'edge-hostpin-acme'],
      ['tenant-acme-1.office', 'b.example.net', 'edge-hostpin-acme-1'],
    ])
    expect(block(two.yaml!, 'tenant-acme-1.office')).toContain('rule: "Host(`b.example.net`) && PathPrefix(`/office`)"')
    // the pins are still declared exactly once each: the router reuses its host's pin
    expect([...two.yaml!.matchAll(/^ {4}(edge-hostpin-[a-z0-9-]+):$/gm)].map((m) => m[1])).toEqual(['edge-hostpin-acme', 'edge-hostpin-acme-1'])
  })

  it('a host that gets no router gets no Collabora router either', () => {
    const none = render('acme', ['example.org', 'bad host'])
    expect(none.yaml).toBeNull()
    expect(none.collaboraRouters ?? []).toEqual([])
  })

  it('sits beside the realm router on the same host without overlapping it (disjoint path sets, no shared name)', () => {
    const both = render('musterstadt', ['rat.musterstadt.example'], { realm: 'musterstadt', host: 'rat.musterstadt.example' })
    const names = [...both.yaml!.matchAll(/^ {4}(tenant-[a-z0-9.-]+):$/gm)].map((m) => m[1])
    expect(names).toEqual(['tenant-musterstadt', 'tenant-musterstadt.kc', 'tenant-musterstadt.office'])
    expect(new Set(names).size).toBe(names.length)
  })
})
