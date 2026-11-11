// Module Karenz, phase 2 Task 4: what the provisioning library hands back when a
// module is switched off (blocked, not dropped; the day on which the Karenz ends)
// and the day-30 entry point of the modules port. Pure: ports are fakes.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lifecycle = vi.hoisted(() => ({
  disableModule: vi.fn(),
  finalizeDueKarenz: vi.fn(),
}))
vi.mock('@gremion/tenant-store/lifecycle', async (orig) => ({
  ...(await orig<typeof import('@gremion/tenant-store/lifecycle')>()),
  disableModule: lifecycle.disableModule,
  finalizeDueKarenz: lifecycle.finalizeDueKarenz,
}))

import { createPhaseA, createPhaseB, disableCustomerModule, pgModules, recordHostStep, type CreateSpec } from '../src/index.ts'
import { ADMINS, deps, DPIA, hostStamp, OPERATOR, world } from './fakes.ts'

const spec: CreateSpec = { slug: 'musterstadt', host: 'rat.musterstadt.example', enable: ['calendar', 'votes'], operatorId: OPERATOR, admins: ADMINS, dpia: { calendar: DPIA, votes: DPIA } }

async function active() {
  const w = world()
  const d = deps(w)
  const a = await createPhaseA(spec, d)
  hostStamp(w, a.customer)
  await recordHostStep(spec.slug, 'mail_principal_issued', spec.operatorId, d)
  await createPhaseB(spec, d)
  w.mutations.length = 0
  return { w, d }
}

beforeEach(() => {
  lifecycle.disableModule.mockReset()
  lifecycle.finalizeDueKarenz.mockReset()
})

describe('disableCustomerModule results (Karenz)', () => {
  it('disableCustomerModule returns blocked true, dropped false and finalAt from modules.disable', async () => {
    const { d } = await active()
    const finalAt = new Date('2026-12-01T10:00:00Z')
    d.modules.disable = vi.fn(async () => ({ noop: false, dropped: false, blocked: true, finalAt, database: 't_x__calendar', export: { path: '/exports/calendar.dump', sha256: 'a'.repeat(64), bytes: 10 } }))
    const r = await disableCustomerModule('musterstadt', 'calendar', { operatorId: OPERATOR }, d)
    expect(r).toMatchObject({ moduleKey: 'calendar', noop: false, dropped: false, blocked: true })
    expect(r.finalAt).toEqual(finalAt)
  })

  it('the shipped fake blocks and never drops (a switch-off drops nothing for 30 days)', async () => {
    const { d } = await active()
    const r = await disableCustomerModule('musterstadt', 'calendar', { operatorId: OPERATOR }, d)
    expect(r.dropped).toBe(false)
    expect(r.blocked).toBe(true)
    expect(r.finalAt).toBeInstanceOf(Date)
  })

  it('a noop disable keeps blocked false', async () => {
    const { d } = await active()
    // publishing was never enabled for this customer: nothing to block, no clock
    const r = await disableCustomerModule('musterstadt', 'publishing', { operatorId: OPERATOR }, d)
    expect(r).toMatchObject({ noop: true, dropped: false, blocked: false, finalAt: null })
  })
})

describe('pgModules (Karenz)', () => {
  const calendar = { id: 'calendar', dir: '/m/calendar', moduleJson: { id: 'calendar', runtime: { version: '1.0.0', database: { postgresService: 'calendar-postgres' } } } }
  const lifecycleDeps = { server: () => ({ admin: {} }), exportDir: '/exports', releaseRef: 'r1', log: () => {} } as never
  const platform = {} as never
  const port = () => pgModules({ platform, catalogue: [calendar as never], lifecycle: lifecycleDeps })

  it('disable maps blocked and the Karenz final day from the lifecycle result', async () => {
    const finalAt = new Date('2026-12-01T10:00:00Z')
    lifecycle.disableModule.mockResolvedValue({
      tenantId: 't',
      moduleId: 'calendar',
      database: 't_x__calendar',
      dropped: false,
      blocked: true,
      karenz: { karenzId: 'k1', finalAt },
      export: null,
      noop: false,
    })
    const r = await port().disable({ id: 't', slug: 's', token: 'tok', realm: 'r', host: 'h' }, 'calendar', OPERATOR)
    expect(r).toMatchObject({ noop: false, dropped: false, blocked: true, database: 't_x__calendar' })
    expect(r.finalAt).toEqual(finalAt)
  })

  it('disable without a Karenz row (nothing was blocked) reports blocked false and finalAt null', async () => {
    lifecycle.disableModule.mockResolvedValue({ tenantId: 't', moduleId: 'calendar', database: null, dropped: false, blocked: false, karenz: null, export: null, noop: true })
    const r = await port().disable({ id: 't', slug: 's', token: 'tok', realm: 'r', host: 'h' }, 'calendar', OPERATOR)
    expect(r).toMatchObject({ noop: true, blocked: false, finalAt: null })
  })

  it('finalizeDue builds FinalizeDeps from the lifecycle deps and the catalogue and returns the lifecycle result', async () => {
    const result = { due: 2, finalized: 1, kept: 0, dryRun: true, errors: [], orphanedExports: ['/exports/a/b/c.dump'] }
    lifecycle.finalizeDueKarenz.mockResolvedValue(result)
    const r = await port().finalizeDue!({ finalDeletion: false, deadlineMs: 5000 })
    expect(r).toBe(result)
    const arg = lifecycle.finalizeDueKarenz.mock.calls[0]![0] as Record<string, unknown>
    expect(arg).toMatchObject({ platform, exportDir: '/exports', finalDeletion: false, deadlineMs: 5000 })
    expect(arg.catalogue).toEqual([calendar])
    expect(typeof arg.server).toBe('function')
  })

  it('finalizeDue passes the deletion switch through unchanged (on stays on)', async () => {
    lifecycle.finalizeDueKarenz.mockResolvedValue({ due: 0, finalized: 0, kept: 0, dryRun: false, errors: [], orphanedExports: [] })
    await port().finalizeDue!({ finalDeletion: true, deadlineMs: 1 })
    expect(lifecycle.finalizeDueKarenz.mock.calls[0]![0]).toMatchObject({ finalDeletion: true })
  })
})
