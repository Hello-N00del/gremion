// @vitest-environment node
//
// TRD-196 / PRD-OPS-005 — the calendar module's erasure hook. The only personal
// datum the in-process calendar holds is calendar_events.created_by (the author's
// identity-provider id); the hook pseudonymises it. When the calendar runs as its
// own service (CALENDAR_BACKEND=service) its data lives in the leaf's database,
// which the kernel holds no connection to: that is `skipped`, never `erased`.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Sql } from '@gremion/db'
import { calendarErasureHook, CALENDAR_ERASED_MARKER } from './erasure'

function fakeDb(count: number) {
  const calls: { text: string; values: unknown[] }[] = []
  const db = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values })
    return Promise.resolve({ count })
  }
  return { db: db as unknown as Sql, calls }
}

afterEach(() => vi.unstubAllEnvs())

describe('calendarErasureHook', () => {
  it('is registered under the module id and needs a connection', () => {
    expect(calendarErasureHook.moduleId).toBe('calendar')
    expect(calendarErasureHook.requiresConnection).not.toBe(false)
  })

  it('pseudonymises created_by of the subject and reports the count', async () => {
    const { db, calls } = fakeDb(3)
    const res = await calendarErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db })
    expect(res).toEqual({ status: 'erased', counts: { calendar_events: 3 } })
    expect(calls).toHaveLength(1)
    expect(calls[0].text).toMatch(/UPDATE calendar_events SET created_by/)
    expect(calls[0].values).toEqual([CALENDAR_ERASED_MARKER, 'u-1'])
  })

  it('CALENDAR_BACKEND=service: skipped with a reason, the kernel DB is not touched', async () => {
    vi.stubEnv('CALENDAR_BACKEND', 'service')
    const { db, calls } = fakeDb(9)
    const res = await calendarErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db })
    expect(res.status).toBe('skipped')
    expect(res.status === 'skipped' && res.reason).toMatch(/calendar service/i)
    expect(calls).toHaveLength(0)
  })
})
