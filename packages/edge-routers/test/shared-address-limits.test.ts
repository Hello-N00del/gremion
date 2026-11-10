// One audience (a whole room) arrives behind ONE public address. The per-address rate limit
// and the in-flight cap are keyed on that connection address, so they must be sized for that
// room: a cold page load is tens of requests and every open chat tab holds one stream open.
// The other guards (prod-compose-labels, edge-proto-fixture, render) only pin the places to
// EACH OTHER; this one pins the absolute numbers, so a one-sided revert cannot pass.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PER_IP_INFLIGHT, RATE_LIMIT_TIERS } from '../src/platform-middlewares.js'
import { REPO_ROOT } from './helpers.js'

const read = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p), 'utf8')

describe('edge limits sized for one audience behind one address', () => {
  it('the app tier is 3000 per minute with a burst of 1500; the portal and auth tiers are unchanged', () => {
    expect(RATE_LIMIT_TIERS.app).toEqual({ average: 3000, burst: 1500, period: '1m' })
    expect(RATE_LIMIT_TIERS.portal).toEqual({ average: 100, burst: 50, period: '1m' })
    expect(RATE_LIMIT_TIERS.auth).toEqual({ average: 30, burst: 10, period: '1m' })
  })

  it('the per-address in-flight cap is 500 and still exists', () => {
    expect(PER_IP_INFLIGHT).toBe(500)
  })

  it('the production compose labels state the same app tier', () => {
    const prod = read('docker-compose.prod.yml')
    expect(prod).toContain('"traefik.http.middlewares.edge-ratelimit-app.ratelimit.average=3000"')
    expect(prod).toContain('"traefik.http.middlewares.edge-ratelimit-app.ratelimit.burst=1500"')
    expect(prod).toContain('"traefik.http.middlewares.edge-ratelimit-auth.ratelimit.average=30"')
  })

  it('the edge-proto fixture states the same app tier', () => {
    const fixture = read('test', 'host', 'fixtures', 'edge-proto', 'docker-compose.yml')
    expect(fixture).toContain('edge-ratelimit-app.ratelimit.average: "3000"')
    expect(fixture).toContain('edge-ratelimit-app.ratelimit.burst: "1500"')
    expect(fixture).toContain('edge-ratelimit-auth.ratelimit.average: "30"')
  })

  it('the tenant router template and both fixtures carry the in-flight cap', () => {
    for (const file of [
      ['infra', 'host', 'templates', 'edge', 'tenant-router.example.yml'],
      ['test', 'host', 'fixtures', 'edge-proto', 'dynamic', 'tenant-a.yml'],
      ['test', 'host', 'fixtures', 'edge-proto', 'dynamic', 'tenant-b.yml'],
    ]) {
      expect(read(...file), file.join('/')).toContain('        amount: 500\n')
    }
  })
})
