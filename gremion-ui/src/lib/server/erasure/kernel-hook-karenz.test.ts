// @vitest-environment node
//
// Module Karenz (phase 2, Task 12): what the kernel erasure step does about the Karenz tables.
//   - the subject's mail-ledger rows (module_karenz_notice) are operative data and go;
//   - retained copies that name the subject and were already published (the files sink) are published
//     again, redacted, because the copy outlives its Karenz row and the folder keeps it for years.
// The hook is exercised with a statement-recording double of the tenant pool; the SQL of the older
// tables is covered by the integration suite (erasure.integration.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Sql } from '@gremion/db'
import type { TenantContext } from '$lib/server/tenant/context'
import { createKernelErasureHook, republishForErasure } from './kernel-hook'

process.env.AUTH_SECRET ??= 'unit-test-auth-secret'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SUBJECT = 'kc-subject-1'

/** A tenant pool double: every statement is recorded, every write answers "0 rows", count(*) answers 0. */
function fakePool(opts: { retainedHit?: boolean } = {}) {
  const log: Array<{ text: string; values: unknown[] }> = []
  const events: string[] = []
  const answer = (text: string, values: unknown[]) => {
    log.push({ text, values })
    if (/count\(\*\)::int AS n/.test(text)) return Object.assign([{ n: 0 }], { count: 1 })
    if (/FROM retained_record/.test(text)) return Object.assign(opts.retainedHit ? [{ found: 1 }] : [], { count: opts.retainedHit ? 1 : 0 })
    if (/DELETE FROM module_karenz_notice/.test(text)) return Object.assign([], { count: 2 })
    return Object.assign([], { count: 0 })
  }
  const tag = ((strings: TemplateStringsArray | string, ...values: unknown[]) => {
    // postgres.js: tx('name') / tx([..]) are identifier / list helpers, not statements
    if (!Array.isArray(strings) || !('raw' in strings)) return { helper: strings }
    return Promise.resolve(answer((strings as TemplateStringsArray).join('?'), values))
  }) as unknown as Sql & { begin: unknown }
  Object.assign(tag, {
    begin: async (fn: (tx: unknown) => Promise<unknown>) => {
      events.push('begin')
      const out = await fn(tag)
      events.push('commit')
      return out
    },
  })
  return { db: tag as Sql, log, events }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('kernel hook: Karenz tables', () => {
  it("deletes the subject's module_karenz_notice rows (operative data) inside the erasure transaction and counts them", async () => {
    const pool = fakePool()
    const hook = createKernelErasureHook({ republish: async () => ({ published: 0, unreachable: [], failed: [] }) })
    const res = await hook.erase({ tenantId: TENANT, subjectId: SUBJECT, db: pool.db })
    const del = pool.log.find((l) => /DELETE FROM module_karenz_notice/.test(l.text))
    expect(del?.values).toEqual([SUBJECT])
    // the statement is a plain per-subject delete (checked against the real 0064 schema by hand: column user_id)
    expect(del?.text.replaceAll(/\s+/g, ' ').trim()).toBe('DELETE FROM module_karenz_notice WHERE user_id = ?')
    expect(res).toMatchObject({ status: 'erased', counts: { module_karenz_notice: 2 } })
    expect(pool.events).toEqual(['begin', 'commit'])
  })

  it('republishes the retained copies that name the subject AFTER the erasure transaction committed', async () => {
    const pool = fakePool()
    const republish = vi.fn(async () => {
      pool.events.push('republish')
      return { published: 2, unreachable: [], failed: [] }
    })
    const hook = createKernelErasureHook({ republish })
    const res = await hook.erase({ tenantId: TENANT, subjectId: SUBJECT, db: pool.db })
    expect(republish).toHaveBeenCalledWith({ db: pool.db, tenantId: TENANT, subjectId: SUBJECT })
    expect(pool.events).toEqual(['begin', 'commit', 'republish'])
    expect(res).toMatchObject({ status: 'erased', counts: { retained_copies_republished: 2 } })
    expect(res.status === 'erased' && res.residuals).toEqual([])
  })

  it('a copy that could not be republished (sink off or failing) is a residual of the report, not silence', async () => {
    const hook = createKernelErasureHook({
      republish: async () => ({ published: 1, unreachable: ['publish:files:a'], failed: ['publish:files:b: NextcloudResponseError (HTTP 500)'] }),
    })
    const res = await hook.erase({ tenantId: TENANT, subjectId: SUBJECT, db: fakePool().db })
    expect(res.status).toBe('erased')
    const residuals = res.status === 'erased' ? (res.residuals ?? []) : []
    expect(residuals).toHaveLength(1)
    expect(residuals[0]).toMatchObject({ table: 'retained_record', column: 'subject_refs', rows: 2 })
    expect(residuals[0]!.reason).toMatch(/published copy/)
    // names of steps and error classes may reach the report; the subject may not
    expect(JSON.stringify(res)).not.toContain(SUBJECT)
  })

  it('a republish that throws leaves the kernel step erased with a residual that says the copies were not checked', async () => {
    const hook = createKernelErasureHook({
      republish: async () => {
        throw new Error(`boom for ${SUBJECT}`)
      },
    })
    const res = await hook.erase({ tenantId: TENANT, subjectId: SUBJECT, db: fakePool().db })
    expect(res.status).toBe('erased')
    const residuals = res.status === 'erased' ? (res.residuals ?? []) : []
    expect(residuals.some((r) => r.table === 'retained_record' && /not checked/.test(r.reason))).toBe(true)
    expect(JSON.stringify(res)).not.toContain(SUBJECT)
  })
})

describe('republishForErasure', () => {
  const tenant = { id: TENANT, slug: 'rat-a' } as unknown as TenantContext

  it('does nothing and needs no tenant context when no retained copy names the subject', async () => {
    const pool = fakePool({ retainedHit: false })
    const republishRetainedForSubject = vi.fn()
    const getTenant = vi.fn(() => {
      throw new Error('no tenant context')
    })
    const out = await republishForErasure({ db: pool.db, tenantId: TENANT, subjectId: SUBJECT }, { getTenant, republishRetainedForSubject })
    expect(out).toEqual({ published: 0, unreachable: [], failed: [] })
    expect(republishRetainedForSubject).not.toHaveBeenCalled()
    expect(getTenant).not.toHaveBeenCalled()
  })

  it("republishes with the subject's keyed ref against the pool the erasure used", async () => {
    const pool = fakePool({ retainedHit: true })
    const republishRetainedForSubject = vi.fn(async () => ({ published: 1, unreachable: [], failed: [] }))
    const out = await republishForErasure({ db: pool.db, tenantId: TENANT, subjectId: SUBJECT }, { getTenant: () => tenant, republishRetainedForSubject })
    expect(out.published).toBe(1)
    const [ctxArg, ref] = republishRetainedForSubject.mock.calls[0] as unknown as [TenantContext, string]
    expect(ctxArg.id).toBe(TENANT)
    expect(ctxArg.db).toBe(pool.db)
    expect(ref).toMatch(/^[0-9a-f]{64}$/)
    expect(ref).not.toContain(SUBJECT)
  })

  it('refuses a tenant context that is not the tenant being erased', async () => {
    const pool = fakePool({ retainedHit: true })
    await expect(
      republishForErasure({ db: pool.db, tenantId: 'someone-else', subjectId: SUBJECT }, { getTenant: () => tenant, republishRetainedForSubject: vi.fn() }),
    ).rejects.toThrow(/tenant/)
  })
})
