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
    const names = new Set(independent.map(([k]) => /middlewares\.([a-z-]+)\./.exec(k)![1]))
    expect([...names].sort()).toEqual([
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

  it('declares no edge-hostpin-* yet: the platform host pins stay TASK-034 34b (Qc2)', () => {
    // label lines only: the comments name the pins
    expect(block.split('\n').filter((l) => /^\s*- "/.test(l) && /edge-hostpin-/.test(l))).toEqual([])
  })

  it('keeps the interim names the static routers still chain (34b retires them)', () => {
    for (const n of ['gremion-ui-proxytrust', 'gremion-ui-starting', 'public-ratelimit']) {
      expect(block).toContain(`traefik.http.middlewares.${n}.`)
    }
  })
})
