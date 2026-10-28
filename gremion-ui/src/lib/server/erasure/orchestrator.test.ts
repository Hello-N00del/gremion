// @vitest-environment node
//
// TRD-196 / PRD-OPS-005 — the erasure orchestrator reports PER MODULE and never
// publishes an aggregate "complete" that could conceal a skipped or failed module.
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

process.env.AUTH_SECRET ??= 'unit-test-auth-secret'
import type { Sql } from '@gremion/db'
import type { ModuleErasureOutcome } from '@gremion/ports/erasure'
import { overallErasureStatus } from '@gremion/ports/erasure'
import type { KernelErasureHook } from '$lib/server/modules/runtime-registry'
import {
  runErasure,
  subjectRef,
  type ErasureDeps,
  type ErasureReportStore,
} from './orchestrator'
import { ErasureSubjectUnknownError } from './subject'

const DB = { tag: 'tenant-db' } as unknown as Sql
const TENANT = 'tenant-a'
const SUBJECT = 'kc-user-4711'

function memoryStore(): ErasureReportStore & {
  headers: unknown[]
  outcomes: ModuleErasureOutcome[]
  finished: { id: string; status: string; reason?: string | null }[]
  sweeps: { tenantId: string; olderThan: Date }[]
} {
  const s = {
    headers: [] as unknown[],
    outcomes: [] as ModuleErasureOutcome[],
    finished: [] as { id: string; status: string; reason?: string | null }[],
    sweeps: [] as { tenantId: string; olderThan: Date }[],
    async begin(h: unknown) {
      s.headers.push(h)
      return 'report-1'
    },
    async record(_id: string, o: ModuleErasureOutcome) {
      s.outcomes.push(o)
    },
    async finish(id: string, status: 'complete' | 'incomplete', _at: Date, reason?: string | null) {
      s.finished.push(reason ? { id, status, reason } : { id, status })
    },
    async sweepStale(tenantId: string, olderThan: Date) {
      s.sweeps.push({ tenantId, olderThan })
      return 0
    },
  }
  return s
}

function hookOf(moduleId: string, erase?: KernelErasureHook['erase']): KernelErasureHook {
  return {
    moduleId,
    erase: erase ?? (async () => ({ status: 'erased', counts: { rows: 2 } })),
  }
}

function deps(
  enabled: string[],
  hooks: KernelErasureHook[],
  opts: {
    noConnection?: string[]
    store?: ErasureReportStore
    resolveSubject?: ErasureDeps['resolveSubject']
  } = {},
): ErasureDeps {
  const byId = new Map(hooks.map((h) => [h.moduleId, h]))
  return {
    enabledModuleIds: () => enabled,
    hookFor: (id) => byId.get(id),
    connectionFor: (id) => (opts.noConnection?.includes(id) ? null : DB),
    resolveSubject: opts.resolveSubject ?? (async (id) => ({ id, username: 'jdoe', email: 'jdoe@example.org' })),
    store: opts.store ?? memoryStore(),
    now: () => new Date('2026-10-27T10:00:00Z'),
  }
}

const input = { tenantId: TENANT, subjectId: SUBJECT, requestedBy: 'admin-1' }

describe('subjectRef (LOW): keyed, not a bare hash anyone can recompute', () => {
  it('is an HMAC under a per-tenant key derived from AUTH_SECRET, not sha256(tenant:subject)', () => {
    const bare = createHash('sha256').update(`${TENANT}:${SUBJECT}`).digest('hex')
    expect(subjectRef(TENANT, SUBJECT, 's1')).toMatch(/^[0-9a-f]{64}$/)
    expect(subjectRef(TENANT, SUBJECT, 's1')).not.toBe(bare)
    expect(subjectRef(TENANT, SUBJECT, 's1')).toBe(subjectRef(TENANT, SUBJECT, 's1'))
    expect(subjectRef(TENANT, SUBJECT, 's2')).not.toBe(subjectRef(TENANT, SUBJECT, 's1'))
    expect(subjectRef('tenant-b', SUBJECT, 's1')).not.toBe(subjectRef(TENANT, SUBJECT, 's1'))
  })

  it('defaults to AUTH_SECRET and refuses to run without one', () => {
    const saved = process.env.AUTH_SECRET
    try {
      process.env.AUTH_SECRET = 's1'
      expect(subjectRef(TENANT, SUBJECT)).toBe(subjectRef(TENANT, SUBJECT, 's1'))
      delete process.env.AUTH_SECRET
      expect(() => subjectRef(TENANT, SUBJECT)).toThrow(/AUTH_SECRET/)
    } finally {
      process.env.AUTH_SECRET = saved
    }
  })
})

describe('the subject is bound to the tenant BEFORE any hook runs (R33f HIGH)', () => {
  it('an id the tenant does not know is refused: no report, no hook, nothing touched', async () => {
    const store = memoryStore()
    const erase = vi.fn(async () => ({ status: 'erased' as const, counts: {} }))
    const resolveSubject = vi.fn(async () => null)
    await expect(
      runErasure(input, deps(['kernel', 'files'], [hookOf('kernel', erase), hookOf('files', erase)], { store, resolveSubject })),
    ).rejects.toBeInstanceOf(ErasureSubjectUnknownError)
    expect(resolveSubject).toHaveBeenCalledWith(SUBJECT)
    expect(erase).not.toHaveBeenCalled()
    expect(store.headers).toHaveLength(0)
  })

  it('every hook gets the VERIFIED identity in its context', async () => {
    const seen: unknown[] = []
    const spy = hookOf('files', async (ctx) => {
      seen.push(ctx.subject)
      return { status: 'erased', counts: {} }
    })
    await runErasure(
      input,
      deps(['files'], [spy], { resolveSubject: async () => ({ id: SUBJECT, username: 'anna', email: 'anna@example.org' }) }),
    )
    expect(seen).toEqual([{ id: SUBJECT, username: 'anna', email: 'anna@example.org' }])
  })

  it('a resolver that answers for a DIFFERENT id is refused', async () => {
    const erase = vi.fn(async () => ({ status: 'erased' as const, counts: {} }))
    await expect(
      runErasure(input, deps(['kernel'], [hookOf('kernel', erase)], { resolveSubject: async () => ({ id: 'someone-else', username: null, email: null }) })),
    ).rejects.toBeInstanceOf(ErasureSubjectUnknownError)
    expect(erase).not.toHaveBeenCalled()
  })

  it('a resolver error (Keycloak down) aborts the run before anything is touched', async () => {
    const erase = vi.fn(async () => ({ status: 'erased' as const, counts: {} }))
    const store = memoryStore()
    await expect(
      runErasure(input, deps(['kernel'], [hookOf('kernel', erase)], { store, resolveSubject: async () => { throw new Error('keycloak 503') } })),
    ).rejects.toThrow('keycloak 503')
    expect(erase).not.toHaveBeenCalled()
    expect(store.headers).toHaveLength(0)
  })
})

describe('overallErasureStatus', () => {
  it('is incomplete for no modules at all (an empty run proves nothing)', () => {
    expect(overallErasureStatus([])).toBe('incomplete')
  })
})

describe('runErasure', () => {
  it('all enabled modules erased -> overall complete, every module recorded erased with counts', async () => {
    const store = memoryStore()
    const report = await runErasure(
      input,
      deps(['kernel', 'calendar'], [hookOf('kernel'), hookOf('calendar')], { store }),
    )
    expect(report.status).toBe('complete')
    expect(report.modules.map((m) => [m.moduleId, m.status])).toEqual([
      ['kernel', 'erased'],
      ['calendar', 'erased'],
    ])
    expect(report.modules[0].counts).toEqual({ rows: 2 })
    expect(store.finished).toEqual([{ id: 'report-1', status: 'complete' }])
  })

  it('a module whose database connection is removed is skipped, its hook is NOT called, overall is NOT complete', async () => {
    const calendarErase = vi.fn(async () => ({ status: 'erased' as const, counts: { rows: 1 } }))
    const report = await runErasure(
      input,
      deps(['kernel', 'calendar'], [hookOf('kernel'), hookOf('calendar', calendarErase)], {
        noConnection: ['calendar'],
      }),
    )
    const cal = report.modules.find((m) => m.moduleId === 'calendar')!
    expect(cal.status).toBe('skipped')
    expect(cal.reason).toMatch(/no database connection/i)
    expect(cal.counts).toEqual({})
    expect(calendarErase).not.toHaveBeenCalled()
    expect(report.status).toBe('incomplete')
    expect(report.status).not.toBe('complete')
  })

  it('a hook that needs no connection still runs when there is none', async () => {
    const report = await runErasure(
      input,
      deps(['kernel', 'x'], [hookOf('kernel'), { ...hookOf('x'), requiresConnection: false }], {
        noConnection: ['x'],
      }),
    )
    expect(report.modules.find((m) => m.moduleId === 'x')!.status).toBe('erased')
  })

  it('an enabled module without an erasure hook is skipped with a reason, never erased', async () => {
    const report = await runErasure(input, deps(['kernel', 'elections'], [hookOf('kernel')]))
    const el = report.modules.find((m) => m.moduleId === 'elections')!
    expect(el.status).toBe('skipped')
    expect(el.reason).toMatch(/no erasure hook/i)
    expect(report.status).toBe('incomplete')
  })

  it('a hook that cannot reach its database (connection error) is skipped as unreachable', async () => {
    const down = hookOf('calendar', async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:5432'), { code: 'ECONNREFUSED' })
    })
    const report = await runErasure(input, deps(['kernel', 'calendar'], [hookOf('kernel'), down]))
    const cal = report.modules.find((m) => m.moduleId === 'calendar')!
    expect(cal.status).toBe('skipped')
    expect(cal.reason).toMatch(/unreachable/i)
    expect(report.status).toBe('incomplete')
  })

  it('a hook that throws any other error is failed; later modules still run', async () => {
    const boom = hookOf('calendar', async () => {
      throw new Error('constraint violated')
    })
    const after = vi.fn(async () => ({ status: 'erased' as const, counts: {} }))
    const report = await runErasure(
      input,
      deps(['kernel', 'calendar', 'board'], [hookOf('kernel'), boom, hookOf('board', after)]),
    )
    const cal = report.modules.find((m) => m.moduleId === 'calendar')!
    expect(cal.status).toBe('failed')
    // the stored reason is the error class only, never the (possibly identifying) message
    expect(cal.reason).toBe('Error')
    expect(cal.reason).not.toMatch(/constraint violated/)
    expect(after).toHaveBeenCalledOnce()
    expect(report.status).toBe('incomplete')
  })

  it('a hook that reports skipped is recorded skipped with its reason', async () => {
    const h = hookOf('calendar', async () => ({ status: 'skipped', reason: 'data lives in the calendar service' }))
    const report = await runErasure(input, deps(['kernel', 'calendar'], [hookOf('kernel'), h]))
    expect(report.modules[1]).toMatchObject({ status: 'skipped', reason: 'data lives in the calendar service' })
    expect(report.status).toBe('incomplete')
  })

  it('a malformed "erased" result (no counts object) is failed, not erased', async () => {
    const bad = hookOf('calendar', (async () => ({ status: 'erased' })) as unknown as KernelErasureHook['erase'])
    const report = await runErasure(input, deps(['kernel', 'calendar'], [hookOf('kernel'), bad]))
    expect(report.modules[1].status).toBe('failed')
    expect(report.status).toBe('incomplete')
  })

  it('carries a hook\'s residuals (what it deliberately left) into the outcome; none -> []', async () => {
    const residual = { table: 'protocols', column: 'created_by', rows: 2, reason: 'council record (TRD-160)' }
    const h = hookOf('kernel', async () => ({ status: 'erased', counts: { n: 1 }, residuals: [residual] }))
    const report = await runErasure(input, deps(['kernel', 'calendar'], [h, hookOf('calendar')]))
    expect(report.modules[0].residuals).toEqual([residual])
    expect(report.modules[1].residuals).toEqual([])
    expect(report.status).toBe('complete')
  })

  it('a malformed residual list is failed, not erased', async () => {
    const h = hookOf('kernel', (async () => ({
      status: 'erased',
      counts: {},
      residuals: [{ table: 'protocols', rows: -1 }],
    })) as unknown as KernelErasureHook['erase'])
    const report = await runErasure(input, deps(['kernel'], [h]))
    expect(report.modules[0].status).toBe('failed')
  })

  it('the enabled module list may be resolved asynchronously', async () => {
    const d = deps([], [hookOf('kernel')])
    d.enabledModuleIds = async () => ['kernel']
    const report = await runErasure(input, d)
    expect(report.modules.map((m) => m.moduleId)).toEqual(['kernel'])
  })

  it('records an outcome for EVERY enabled module (none silently dropped) and persists each', async () => {
    const store = memoryStore()
    await runErasure(input, deps(['kernel', 'a', 'b', 'c'], [hookOf('kernel')], { store }))
    expect(store.outcomes.map((o) => o.moduleId)).toEqual(['kernel', 'a', 'b', 'c'])
  })

  it('never stores the raw subject id: the report carries a tenant-bound pseudonymous reference', async () => {
    const store = memoryStore()
    const report = await runErasure(input, deps(['kernel'], [hookOf('kernel')], { store }))
    expect(report.subjectRef).toBe(subjectRef(TENANT, SUBJECT))
    expect(report.subjectRef).toMatch(/^[0-9a-f]{64}$/)
    expect(subjectRef('tenant-b', SUBJECT)).not.toBe(report.subjectRef)
    expect(JSON.stringify([store.headers, store.outcomes, report])).not.toContain(SUBJECT)
  })

  it('passes the tenant id, subject id and the module connection to the hook', async () => {
    const seen = vi.fn(async () => ({ status: 'erased' as const, counts: {} }))
    await runErasure(input, deps(['kernel'], [hookOf('kernel', seen)]))
    expect(seen).toHaveBeenCalledWith({
      tenantId: TENANT,
      subjectId: SUBJECT,
      subject: { id: SUBJECT, username: 'jdoe', email: 'jdoe@example.org' },
      db: DB,
    })
  })

  it('refuses an empty subject id before anything is recorded', async () => {
    const store = memoryStore()
    await expect(runErasure({ ...input, subjectId: '  ' }, deps(['kernel'], [hookOf('kernel')], { store }))).rejects.toThrow(
      /subject/i,
    )
    expect(store.headers).toHaveLength(0)
  })

  it('a store failure while recording an outcome propagates AND the header is finished incomplete with a reason', async () => {
    const store = memoryStore()
    store.record = async () => {
      throw new Error('db down')
    }
    await expect(runErasure(input, deps(['kernel'], [hookOf('kernel')], { store }))).rejects.toThrow('db down')
    expect(store.finished).toEqual([{ id: 'report-1', status: 'incomplete', reason: expect.stringMatching(/run aborted: db down/) }])
  })

  it('a refused "complete" finish is retried as incomplete with the reason, then propagates', async () => {
    const store = memoryStore()
    const finish = store.finish.bind(store)
    store.finish = async (id, status, at, reason) => {
      if (status === 'complete') throw new Error('cannot be complete')
      return finish(id, status, at, reason)
    }
    await expect(runErasure(input, deps(['kernel'], [hookOf('kernel')], { store }))).rejects.toThrow('cannot be complete')
    expect(store.finished).toEqual([{ id: 'report-1', status: 'incomplete', reason: expect.stringMatching(/cannot be complete/) }])
  })

  it('a second store failure while marking incomplete does not mask the original error', async () => {
    const store = memoryStore()
    store.record = async () => {
      throw new Error('first')
    }
    store.finish = async () => {
      throw new Error('second')
    }
    await expect(runErasure(input, deps(['kernel'], [hookOf('kernel')], { store }))).rejects.toThrow('first')
  })

  it('sweeps stale running reports (older than one hour) of the tenant before starting', async () => {
    const store = memoryStore()
    await runErasure(input, deps(['kernel'], [hookOf('kernel')], { store }))
    expect(store.sweeps).toEqual([{ tenantId: TENANT, olderThan: new Date('2026-10-27T09:00:00Z') }])
  })

  it('a failing sweep does not stop the run', async () => {
    const store = memoryStore()
    store.sweepStale = async () => {
      throw new Error('sweep down')
    }
    const report = await runErasure(input, deps(['kernel'], [hookOf('kernel')], { store }))
    expect(report.status).toBe('complete')
  })
})
