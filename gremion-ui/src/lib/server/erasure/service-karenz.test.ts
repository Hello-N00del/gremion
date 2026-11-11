// @vitest-environment node
//
// Module Karenz (phase 2, Task 12): the wired erasure service during a Karenz.
//
// While a module is off its external data (Nextcloud Polls, Matrix) is still alive, so an erasure must
// still run the module's hook, with the FULL verified subject. The votes hook below is the REAL factory
// from the module half; only the Nextcloud behind it is a double (a stubbed fetch). Nothing here
// replaces a hook by a fake that always answers erased.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModuleErasureOutcome } from '@gremion/ports/erasure'

const h = vi.hoisted(() => ({
  modules: {} as Record<string, boolean>,
  listKarenz: vi.fn(),
  ledger: [] as string[],
  ledgerFails: false,
  tenant: { id: '11111111-1111-4111-8111-111111111111', slug: 'rat-a', db: {} } as unknown,
}))

vi.mock('$lib/server/config', () => ({ readConfig: () => ({ modules: h.modules }) }))
vi.mock('$lib/server/module-karenz/platform', () => ({ listKarenz: h.listKarenz }))
vi.mock('$lib/server/db', async (orig) => ({
  ...(await orig<typeof import('$lib/server/db')>()),
  getDb: () => {
    const tag = async (strings: TemplateStringsArray, ...v: unknown[]) => {
      const text = strings.join('?')
      if (/schema_migrations/.test(text)) return []
      if (/INSERT INTO module_karenz_erasure/.test(text)) {
        if (h.ledgerFails) throw new Error('ledger down')
        h.ledger.push(v[0] as string)
        return []
      }
      throw new Error(`unexpected statement: ${text}`)
    }
    return tag
  },
}))
vi.mock('$lib/server/tenant/context', async (orig) => ({
  ...(await orig<typeof import('$lib/server/tenant/context')>()),
  getTenant: () => h.tenant,
  currentTenantId: () => (h.tenant as { id: string }).id,
}))

import { createVotesErasureHook, deleteNextcloudAccount } from '$lib/server/polls/erasure'
import type { KernelErasureHook } from '$lib/server/modules/runtime-registry'
import { defaultErasureDeps, startErasure } from './service'
import type { ErasureReport, ErasureReportStore } from './orchestrator'
import type { KarenzRowView, KarenzState } from '$lib/server/module-karenz/platform'

process.env.AUTH_SECRET ??= 'unit-test-auth-secret'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const SUBJECT = 'kc-subject-1'

const row = (state: KarenzState, manifestId = 'votes'): KarenzRowView => ({
  karenzId: '44444444-4444-4444-8444-444444444441',
  catalogueId: manifestId,
  manifestId,
  state,
  switchedOffAt: new Date('2026-10-10T08:00:00Z'),
  finalAt: new Date('2026-11-09T08:00:00Z'),
  restoreRequestedAt: null,
  finalMode: null,
  platformDoneAt: null,
  tenantDoneAt: null,
})

/** In-memory report store: what the append-only report would hold. */
function memoryStore(opts: { failOnRecord?: number } = {}) {
  const outcomes: ModuleErasureOutcome[] = []
  const finished: Array<{ status: string; reason: string | null | undefined }> = []
  let began = 0
  const store: ErasureReportStore = {
    async begin() {
      began++
      return 'report-1'
    },
    async record(_id, outcome) {
      if (opts.failOnRecord !== undefined && outcomes.length + 1 === opts.failOnRecord) throw new Error('report store down')
      outcomes.push(outcome)
    },
    async finish(_id, status, _at, reason) {
      finished.push({ status, reason })
    },
    async sweepStale() {
      return 0
    },
  }
  return { store, outcomes, finished, began: () => began }
}

/** A Nextcloud double behind the REAL deleteNextcloudAccount: records the DELETEs it receives. */
function fakeNextcloud() {
  const deleted: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const m = /\/cloud\/users\/([^?]+)/.exec(url)
      if (init.method === 'DELETE' && m) {
        deleted.push(decodeURIComponent(m[1]!))
        return new Response('{}', { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }),
  )
  return deleted
}

const stub = (moduleId: string): KernelErasureHook => ({
  moduleId,
  requiresConnection: false,
  erase: async () => ({ status: 'skipped', reason: 'test double' }),
})

const realVotesHook = () =>
  createVotesErasureHook({
    deleteAccount: (userId) => deleteNextcloudAccount(userId, { baseUrl: 'http://nc', adminUser: 'admin', adminPassword: 'pw' }),
  })

beforeEach(() => {
  h.modules = { votes: false }
  h.listKarenz.mockReset()
  h.ledger.length = 0
  h.ledgerFails = false
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('defaultErasureDeps().enabledModuleIds', () => {
  it('includes a module with an open or restoring Karenz row and excludes one with no live row', async () => {
    h.listKarenz.mockResolvedValue([row('open', 'votes'), row('restoring', 'elections'), row('finalizing', 'calendar'), row('restored', 'board')])
    const ids = [...(await defaultErasureDeps().enabledModuleIds())]
    expect(ids).toEqual(expect.arrayContaining(['kernel', 'identity', 'votes', 'elections']))
    expect(ids).not.toContain('calendar')
    expect(ids).not.toContain('board')
    expect(ids).not.toContain('module-karenz')
    expect(h.listKarenz).toHaveBeenCalledWith(TENANT_ID, 0)
  })

  it('lists a module once when it is enabled in the config as well', async () => {
    h.modules = { votes: true }
    h.listKarenz.mockResolvedValue([row('open', 'votes')])
    const ids = [...(await defaultErasureDeps().enabledModuleIds())]
    expect(ids.filter((i) => i === 'votes')).toHaveLength(1)
  })

  it('if listKarenz fails the report carries an error for the Karenz modules instead of silently omitting them', async () => {
    h.listKarenz.mockRejectedValue(new Error('platform down'))
    const deps = defaultErasureDeps()
    const ids = [...(await deps.enabledModuleIds())]
    expect(ids).toContain('module-karenz')
    const mem = memoryStore()
    const report = await startErasure(
      { subjectId: SUBJECT, requestedBy: 'admin-1' },
      {
        ...deps,
        hookFor: (id) => (id === 'module-karenz' ? deps.hookFor(id) : stub(id)),
        resolveSubject: async (id) => ({ id, username: 'jdoe', email: null }),
        store: mem.store,
      },
    )
    const karenz = report.modules.find((m) => m.moduleId === 'module-karenz')
    expect(karenz).toMatchObject({ status: 'failed', reason: 'KarenzListUnavailable' })
    expect(report.status).toBe('incomplete')
  })
})

describe('an erasure during a live Karenz', () => {
  it('runs the REAL votes hook with the full subject and the shared Nextcloud account is deleted: erased, never skipped', async () => {
    h.listKarenz.mockResolvedValue([row('open', 'votes')])
    const deleted = fakeNextcloud()
    const deps = defaultErasureDeps()
    const mem = memoryStore()
    const report: ErasureReport = await startErasure(
      { subjectId: SUBJECT, requestedBy: 'admin-1' },
      {
        ...deps,
        hookFor: (id) => (id === 'votes' ? realVotesHook() : stub(id)),
        resolveSubject: async (id) => ({ id, username: 'jdoe', email: 'jdoe@example.test' }),
        store: mem.store,
      },
    )
    const votes = report.modules.find((m) => m.moduleId === 'votes')
    expect(votes).toMatchObject({ status: 'erased', counts: { nextcloud_accounts: 1 } })
    expect(deleted).toEqual([SUBJECT])
  })

  it('without the Karenz row the same switched-off module is not walked (the failure this task closes)', async () => {
    h.listKarenz.mockResolvedValue([])
    const deleted = fakeNextcloud()
    const deps = defaultErasureDeps()
    const mem = memoryStore()
    const report = await startErasure(
      { subjectId: SUBJECT, requestedBy: 'admin-1' },
      { ...deps, hookFor: (id) => (id === 'votes' ? realVotesHook() : stub(id)), resolveSubject: async (id) => ({ id, username: 'jdoe', email: null }), store: mem.store },
    )
    expect(report.modules.find((m) => m.moduleId === 'votes')).toBeUndefined()
    expect(deleted).toEqual([])
  })
})

describe('the Karenz erasure ledger', () => {
  it('an erasure run is recorded in module_karenz_erasure even when it fails midway, and only the subject id is written', async () => {
    h.listKarenz.mockResolvedValue([])
    const deps = defaultErasureDeps()
    const mem = memoryStore({ failOnRecord: 2 })
    await expect(
      startErasure(
        { subjectId: SUBJECT, requestedBy: 'admin-1' },
        { ...deps, hookFor: stub, resolveSubject: async (id) => ({ id, username: 'jdoe', email: 'jdoe@example.test' }), store: mem.store },
      ),
    ).rejects.toThrow('report store down')
    expect(h.ledger).toEqual([SUBJECT])
  })

  it('a ledger that cannot be written stops the erasure BEFORE any hook ran (retry is safe, nothing is half-done)', async () => {
    h.listKarenz.mockResolvedValue([])
    h.ledgerFails = true
    const deps = defaultErasureDeps()
    const mem = memoryStore()
    await expect(
      startErasure({ subjectId: SUBJECT, requestedBy: 'admin-1' }, { ...deps, hookFor: stub, resolveSubject: async (id) => ({ id, username: 'jdoe', email: null }), store: mem.store }),
    ).rejects.toThrow('ledger down')
    expect(mem.began()).toBe(0)
    expect(mem.outcomes).toEqual([])
  })
})
