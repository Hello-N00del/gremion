import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderTenantRouter } from '../src/render.js'
import { REPO_ROOT, deps } from './helpers.js'

const TEMPLATE = join(REPO_ROOT, 'infra', 'host', 'templates', 'edge', 'tenant-router.example.yml')

function render(slug: string, hosts: string[], extra: Partial<typeof deps> = {}) {
  return renderTenantRouter({ slug, domains: hosts.map((host) => ({ host })), ...deps, ...extra })
}

/** Section `<name>:` at two-space indent -> its four-space child keys. */
function childKeys(yaml: string, section: string): string[] {
  const lines = yaml.split('\n')
  const start = lines.indexOf(`  ${section}:`)
  if (start < 0) return []
  const out: string[] = []
  for (const l of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(l)) break
    const m = /^ {4}([A-Za-z0-9_-]+):$/.exec(l)
    if (m?.[1]) out.push(m[1])
  }
  return out
}

describe('renderTenantRouter — TDD 1: the fixture tenant IS the template', () => {
  it('renders byte-for-byte the committed tenant-router.example.yml', () => {
    const r = render('example', ['tenant.example.org'])
    expect(r.yaml).toBe(readFileSync(TEMPLATE, 'utf8'))
  })

  it('skips a reserved host with the code `reserved` and an invalid one with `invalid-host`', () => {
    const r = render('acme', ['www.example.org', 'example.org', 'bad host', 'council.example.net'])
    expect(r.hosts).toEqual(['council.example.net'])
    expect(r.skipped.map((s) => [s.host, s.code])).toEqual([
      ['www.example.org', 'reserved'],
      ['example.org', 'reserved'],
      ['bad host', 'invalid-host'],
    ])
    for (const s of r.skipped) expect(s.reason.length).toBeGreaterThan(0)
  })

  it('returns yaml null when no host survives', () => {
    const r = render('acme', ['example.org', '::nope'])
    expect(r.yaml).toBeNull()
    expect(r.routers).toEqual([])
    expect(r.skipped).toHaveLength(2)
  })

  it('gives two domains the -1 suffix for router AND pin, in sorted host order', () => {
    const r = render('acme', ['b.example.net', 'A.example.net.'])
    expect(r.hosts).toEqual(['a.example.net', 'b.example.net'])
    expect(r.routers.map((x) => [x.name, x.host, x.pin])).toEqual([
      ['tenant-acme', 'a.example.net', 'edge-hostpin-acme'],
      ['tenant-acme-1', 'b.example.net', 'edge-hostpin-acme-1'],
    ])
    expect(childKeys(r.yaml!, 'routers')).toEqual(['tenant-acme', 'tenant-acme-1'])
  })

  it('emits a host that appears twice (after normalisation) exactly once', () => {
    const r = render('acme', ['a.example.net', 'A.EXAMPLE.NET', 'a.example.net.'])
    expect(r.hosts).toEqual(['a.example.net'])
    expect(childKeys(r.yaml!, 'routers')).toEqual(['tenant-acme'])
  })
})

describe('renderTenantRouter — TDD 2: what the file declares and chains', () => {
  const r = render('acme', ['a.example.net', 'b.example.net', 'c.example.org'])
  const yaml = r.yaml!

  it('declares ONLY the pins and the per-IP limit, nothing else', () => {
    expect(childKeys(yaml, 'middlewares')).toEqual([
      'edge-hostpin-acme',
      'edge-hostpin-acme-1',
      'edge-hostpin-acme-2',
      'edge-perip-acme',
    ])
    // no other top-level section under http: (no services, no tls, no tcp)
    const sections = yaml.split('\n').filter((l) => /^ {2}[a-z]+:$/.test(l)).map((l) => l.trim())
    expect(sections).toEqual(['routers:', 'middlewares:'])
    expect(yaml.split('\n').filter((l) => /^\S/.test(l) && !l.startsWith('#'))).toEqual(['http:'])
  })

  it('chains pin, edge-hsts-custom@docker, edge-ratelimit-app@docker, per-IP — on every router', () => {
    expect(r.routers).toHaveLength(3)
    for (const x of r.routers) {
      expect(x.chain).toEqual([
        `${x.pin}@file`,
        'edge-hsts-custom@docker',
        'edge-ratelimit-app@docker',
        'edge-perip-acme@file',
      ])
    }
  })

  it('UNIVERSAL: every emitted router pins its own literal host, first, and nothing else pins', () => {
    const lines = yaml.split('\n')
    const pinValue = new Map<string, string>()
    for (let i = 0; i < lines.length; i++) {
      const m = /^ {4}(edge-hostpin-[a-z0-9-]+):$/.exec(lines[i]!)
      if (m?.[1]) {
        const v = /^ {10}X-Forwarded-Host: "([^"]+)"$/.exec(lines[i + 3] ?? '')
        expect(v, `pin ${m[1]} body`).not.toBeNull()
        pinValue.set(m[1], v![1]!)
      }
    }
    const routersSection = yaml.slice(0, yaml.indexOf('\n  middlewares:\n'))
    const routerBlocks = routersSection.split(/\n(?= {4}tenant-)/).slice(1)
    expect(routerBlocks).toHaveLength(3)
    for (const block of routerBlocks) {
      const host = /rule: "Host\(`([^`]+)`\)"/.exec(block)?.[1]
      const firstMw = /middlewares:\n {8}- "([a-z0-9-]+)@file"/.exec(block)?.[1]
      expect(host).toBeTruthy()
      expect(firstMw).toMatch(/^edge-hostpin-/)
      expect(pinValue.get(firstMw!)).toBe(host)
      expect((block.match(/edge-hostpin-/g) ?? []).length).toBe(1)
      expect(block).toContain('service: "app@file"')
      expect(block).toContain('entryPoints: ["websecure"]')
      expect(block).toMatch(/tls:\n {8}certResolver: "le-http"/)
      expect(block).not.toMatch(/HostRegexp|PathPrefix|\|\|/)
    }
  })

  it('carries no CDN API token, no deleted-planner carrier, no secret placeholder', () => {
    // assembled from parts: hygiene j2/j3 scan this file too
    const cdnToken = new RegExp(['CF', 'API', 'TOKEN'].join('_'), 'i')
    const carrier = new RegExp([['edge', 'plan'].join('-'), ['edge', 'Plan'].join(''), 'renderNs' + 'Delegation'].join('|'))
    for (const bad of [cdnToken, /cloudflare/i, carrier, /\$\{/, /proxytrust|x-proxy-trust/i]) {
      expect(yaml).not.toMatch(bad)
    }
  })
})

describe('renderTenantRouter — fail closed', () => {
  it.each(['', 'A', '../x', 'a/b', 'a.b', 'x'.repeat(31), 'apex', 'www', 'sales', 'control', 'a\nb'])(
    'throws on the slug %j',
    (slug) => {
      expect(() => render(slug, ['a.example.net'])).toThrow(/invalid slug/)
    },
  )

  it.each(['', ' ', 'le http', 'le-http\r', 'le"http', 'a:b', '-x'])('throws on the certResolver %j', (certResolver) => {
    expect(() => render('acme', ['a.example.net'], { certResolver })).toThrow(/certResolver/)
  })

  it('never emits a host the INJECTED normaliser let through but that is not rule-safe — it is skipped as invalid-host', () => {
    const leaky = (raw: string) => raw // an identity "normaliser" — a caller bug
    const hostile = ['a`) || Host(`b.example.net', 'a"b.example.net', 'a..b', '-a.example.net', 'a_b.example.net', 'localhost']
    const r = render('acme', [...hostile, 'ok.example.net'], { normaliseHost: leaky })
    expect(r.hosts).toEqual(['ok.example.net'])
    expect(r.skipped.map((x) => [x.host, x.code])).toEqual(hostile.map((h) => [h, 'invalid-host']))
    expect(r.yaml).not.toMatch(/b\.example\.net|a"b|a_b|localhost|-a\.example/)
  })

  it('refuses an IP literal (a tenant must never capture requests addressed by bare IP)', () => {
    // gremion-ui's real normaliseHost accepts these; the emitter must not route them
    const r = render('acme', ['203.0.113.5', '10.0.0.1:443', 'ok.example.net'])
    expect(r.hosts).toEqual(['ok.example.net'])
    expect(r.skipped.map((x) => x.code)).toEqual(['invalid-host', 'invalid-host'])
    expect(r.yaml).not.toMatch(/203\.0\.113\.5|10\.0\.0\.1/)
  })

  it('treats a throwing isReservedHost as a failure, not as "not reserved"', () => {
    const boom = () => {
      throw new Error('PLATFORM_DOMAIN unset')
    }
    expect(() => render('acme', ['a.example.net'], { isReservedHost: boom })).toThrow(/PLATFORM_DOMAIN unset/)
  })

  it('refuses a non-array domain list', () => {
    expect(() =>
      renderTenantRouter({ slug: 'acme', domains: undefined as never, ...deps }),
    ).toThrow(/domains/)
  })
})
