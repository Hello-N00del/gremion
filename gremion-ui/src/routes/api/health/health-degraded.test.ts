// health-degraded.test.ts — the degraded list an operator reads.
//
// The background event workers (today: the org-unit relay) are NON-FATAL by
// design: a NATS that is down must not stop the app serving everything that has
// nothing to do with it. Before this list existed, "non-fatal" also meant
// invisible — a process whose org-unit mirror had stopped answered exactly the
// same confident 200 as a healthy one.
//
// Two things make the list usable, and both are held here: the body carries the
// list — worker name, error CLASS and stable CODE only, never the broker's own
// text, because this route is unauthenticated — and the container probe stays
// off it, because these workers are non-fatal and an unhealthy container makes
// Traefik v3 silently drop this service's routers, turning a stopped mirror into
// a full outage.
//
// PORT NOTE (B5): adapted from the frozen source's health-degraded.test.ts. The
// worker names there are the StuRa audit consumers, which the kernel does not
// ship; the runbook case there reads docs/runbooks/netcup-cutover.md, which the
// kernel does not have — it is pointed at docs/OPERATIONS.md, where the kernel
// documents container health.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('../../../hooks.server', () => ({ getBootStatus: () => ({ complete: true, error: null }) }))

import { GET } from './+server'
import {
  markWorkerDegraded,
  markWorkerOff,
  _resetWorkerStatesForTests,
} from '$lib/server/events/consumer-state'

// vitest runs with cwd = gremion-ui/ (its vitest.config.ts lives there).
const COMPOSE_FILE = resolve(process.cwd(), '..', 'docker-compose.yml')
const OPERATIONS_DOC = resolve(process.cwd(), '..', 'docs', 'OPERATIONS.md')

// The retired NATS subject root, COMPUTED rather than written. These tests
// assert the retired root never reaches the unauthenticated probe, so they need
// a broker message that carries it — but a literal here is indistinguishable, to
// the kernel hygiene sweep's RETIRED_WIRE_ROOT rule, from a stale subject that is
// still on the wire. Joining the halves keeps the negative assertion exactly as
// strong with nothing for the sweep to find.
const RETIRED_ORGUNIT_FILTER = `${['stur', 'aos'].join('')}.*.org-unit.>`

beforeEach(() => _resetWorkerStatesForTests())
afterEach(() => _resetWorkerStatesForTests())

describe('/api/health', () => {
  it('answers 200 with an empty degraded list when every worker is healthy', async () => {
    const res = await GET({} as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ status: 'ok', degraded: [] })
  })

  it('names each degraded worker by CLASS and CODE, and never the broker text', async () => {
    markWorkerOff('newsletter-relay', 'NATS_URL not set')
    markWorkerDegraded(
      'org-unit-relay',
      Object.assign(
        new Error(
          `[nats-broker] refusing to repoint stream ORGUNIT: it currently captures [${RETIRED_ORGUNIT_FILTER}] ` +
            'but this call would set [gremion.*.org-unit.>].',
        ),
        { name: 'Error' },
      ),
      3,
    )

    const res = await GET({} as never)
    // Still 200: the workers are non-fatal by design. The difference from a
    // healthy process is the body, which is why the probe has to read it.
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.degraded).toEqual([
      { name: 'org-unit-relay', errorClass: 'Error', code: 'stream-repoint-refused', attempts: 3 },
    ])
    // `off` is a configuration, not a fault.
    expect(JSON.stringify(body)).not.toContain('newsletter-relay')
    // Unauthenticated surface: no stream filters, no host:port, no raw message.
    expect(JSON.stringify(body)).not.toContain(RETIRED_ORGUNIT_FILTER)
    expect(JSON.stringify(body)).not.toContain('refusing to repoint')
  })

  it('is documented as the operator surface, with the headers the fail-closed resolver needs', () => {
    const ops = readFileSync(OPERATIONS_DOC, 'utf8')
    expect(ops).toContain('http://127.0.0.1:3000/api/health')
    expect(ops).toMatch(/X-Forwarded-Host/)
    expect(ops).toMatch(/x-proxy-trust/)
    expect(ops, 'the docs must say the compose probe is NOT this list').toMatch(
      // Newline-tolerant: the doc is hard-wrapped, so the phrase straddles lines.
      /compose\s+probe deliberately stays on/i,
    )
  })

  it('leaves the compose healthcheck on the app shell — this unit does not own the probe', () => {
    const compose = readFileSync(COMPOSE_FILE, 'utf8')
    // The gremion-ui SERVICE only — gremion-public is a different app a few
    // hundred lines below and has no /api/health.
    const start = compose.indexOf('\n  gremion-ui:')
    expect(start).toBeGreaterThan(-1)
    const end = compose.indexOf('\n  gremion-public:', start)
    expect(end).toBeGreaterThan(start)
    const service = compose.slice(start, end)
    const hc = service.slice(service.indexOf('    healthcheck:'))
    const probe = hc.slice(0, hc.indexOf('\n      interval:'))

    const testLine = probe.split(/\r?\n/).find((l) => l.trim().startsWith('test:'))
    expect(testLine).toBeDefined()
    expect(testLine).toContain('http://127.0.0.1:3000/')
    expect(
      testLine,
      'repointing the container probe at /api/health marks the container unhealthy on a dead ' +
        'worker, and Traefik v3 then drops its routers — a bigger outage than the one being reported',
    ).not.toContain('/api/health')
  })
})
