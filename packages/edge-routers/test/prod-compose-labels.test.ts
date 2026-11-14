// TASK-043c (P1, Qc1/Qc2): platformMiddlewareLabels is the SINGLE source of the
// edge-* middleware values. The production compose (docker-compose.prod.yml)
// must carry every host-independent key of it on the traefik service, with the
// stated value. Before this unit only the edge-proto TEST fixture declared them,
// so the drill was green while every tenant router reported
// `middleware "edge-ratelimit-app@docker" does not exist` and customer hosts 404'd.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { platformMiddlewareLabels } from '../src/platform-middlewares.js'
import { REPO_ROOT } from './helpers.js'

const PROD = readFileSync(join(REPO_ROOT, 'docker-compose.prod.yml'), 'utf8')

/** The `traefik:` service block: from its key to the next two-space service key. */
function traefikBlock(): string {
  const start = PROD.indexOf('\n  traefik:\n')
  expect(start, 'traefik service in docker-compose.prod.yml').toBeGreaterThan(0)
  const rest = PROD.slice(start + 1)
  const m = /\n {2}[a-z][a-z0-9_-]*:\n/.exec(rest.slice(rest.indexOf('\n') + 1))
  return m ? rest.slice(0, rest.indexOf('\n') + 1 + m.index) : rest
}

describe('docker-compose.prod.yml traefik labels = platformMiddlewareLabels (host-independent half)', () => {
  const block = traefikBlock()
  const all = platformMiddlewareLabels({ apex: 'example.org', sales: 'sales.example.org' })
  const independent = Object.entries(all).filter(([k]) => !k.includes('.edge-hostpin-'))

  it('is non-trivial: both HSTS middlewares and the three rate-limit tiers', () => {
    const names = new Set(independent.map(([k]) => String(/middlewares\.([a-z-]+)\./.exec(k)?.[1])))
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual([
      'edge-hsts-custom',
      'edge-hsts-platform',
      'edge-ratelimit-app',
      'edge-ratelimit-auth',
      'edge-ratelimit-portal',
    ])
  })

  it.each(independent)('declares %s = %s', (k, v) => {
    expect(block).toContain(`      - "${k}=${v}"\n`)
  })

  it('has no bare untiered edge-ratelimit limiter', () => {
    expect(block).not.toMatch(/middlewares\.edge-ratelimit\./)
  })

  it('declares exactly two edge-hostpin-* pins: the apex pin the pilot routers chain and the control pin of the opt-in control-panel router; www and sales stay TASK-034 34b (Qc2)', () => {
    // label lines only: the comments name the pins
    const pins = block.split('\n').filter((l) => /^\s*- "/.test(l) && /edge-hostpin-/.test(l))
    expect(pins).toHaveLength(2)
    // each value is the host read from the one guarded key, exactly platformMiddlewareLabels' shape
    expect(pins[0]).toContain('traefik.http.middlewares.edge-hostpin-apex.headers.customrequestheaders.X-Forwarded-Host=${PLATFORM_DOMAIN:?PLATFORM_DOMAIN required}')
    // the control pin reads CONTROL_PANEL_HOST (state.env), falling back to control.<apex> from the same guarded key
    expect(pins[1]).toContain('traefik.http.middlewares.edge-hostpin-control.headers.customrequestheaders.X-Forwarded-Host=${CONTROL_PANEL_HOST:-control.${PLATFORM_DOMAIN:?PLATFORM_DOMAIN required}}')
    expect(Object.keys(all).filter((k) => k.includes('.edge-hostpin-apex.'))).toHaveLength(1)
    expect(all['traefik.http.middlewares.edge-hostpin-control.headers.customrequestheaders.X-Forwarded-Host']).toBe('control.example.org')
    expect(block).not.toMatch(/edge-hostpin-(www|sales)\./)
  })

  it('the control pin carries a configured control host (data, like sales) and keeps the default derivation when none is given or the value is empty', () => {
    const key = 'traefik.http.middlewares.edge-hostpin-control.headers.customrequestheaders.X-Forwarded-Host'
    const custom = platformMiddlewareLabels({ apex: 'platform.example.org', sales: 'sales.platform.example.org', control: 'panel.example.com' })
    expect(custom[key]).toBe('panel.example.com')
    // the other pins do not move with it
    expect(custom['traefik.http.middlewares.edge-hostpin-apex.headers.customrequestheaders.X-Forwarded-Host']).toBe('platform.example.org')
    expect(custom['traefik.http.middlewares.edge-hostpin-www.headers.customrequestheaders.X-Forwarded-Host']).toBe('www.platform.example.org')
    expect(custom['traefik.http.middlewares.edge-hostpin-sales.headers.customrequestheaders.X-Forwarded-Host']).toBe('sales.platform.example.org')
    for (const control of [undefined, '']) {
      const dflt = platformMiddlewareLabels({ apex: 'platform.example.org', sales: 'sales.platform.example.org', control })
      expect(dflt[key]).toBe('control.platform.example.org')
    }
    // nothing but that one value differs
    const base = platformMiddlewareLabels({ apex: 'platform.example.org', sales: 'sales.platform.example.org' })
    const differing = Object.keys(custom).filter((k) => custom[k] !== base[k])
    expect(differing).toEqual([key])
  })

  it('declares the livekit-sfu-strip middleware on the traefik container (spec B B-09), not on livekit', () => {
    expect(block).toContain('"traefik.http.middlewares.livekit-sfu-strip.stripprefix.prefixes=/livekit-sfu"')
    const livekit = PROD.slice(PROD.indexOf('\n  livekit:\n'), PROD.indexOf('\n  collabora:\n'))
    expect(livekit).not.toMatch(/traefik\.http\.middlewares\./)
  })

  it('keeps the interim names the static routers still chain (34b retires them)', () => {
    for (const n of ['gremion-ui-proxytrust', 'gremion-ui-starting', 'public-ratelimit']) {
      expect(block).toContain(`traefik.http.middlewares.${n}.`)
    }
  })
})
