// CD stage 1, unit U6g: pgModules.finalizeDue hands the day-30 job one optional dependency, afterDrop, built from the
// lifecycle deps' dumpRetire, so a live pre-migration dump of a database the job drops is retired with it. Pure:
// the lifecycle is a recording fake. The behaviour of afterDrop itself (row-driven, before the export step,
// idempotent, a throw never stops the finalize) is packages/tenant-store/test/unit/karenz-after-drop.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lifecycle = vi.hoisted(() => ({ finalizeDueKarenz: vi.fn() }))
vi.mock('@gremion/tenant-store/lifecycle', async (orig) => ({
  ...(await orig<typeof import('@gremion/tenant-store/lifecycle')>()),
  finalizeDueKarenz: lifecycle.finalizeDueKarenz,
}))

import { pgModules } from '../src/index.ts'

const calendar = { id: 'calendar', dir: '/m/calendar', moduleJson: { id: 'calendar', runtime: { version: '1.0.0', database: { postgresService: 'calendar-postgres' } } } }
const base = { server: () => ({ admin: {} }), exportDir: '/exports', releaseRef: 'r1', log: () => {} }
const port = (extra: Record<string, unknown> = {}) => pgModules({ platform: {} as never, catalogue: [calendar as never], lifecycle: { ...base, ...extra } as never })

beforeEach(() => lifecycle.finalizeDueKarenz.mockReset())

describe('pgModules.finalizeDue: afterDrop', () => {
  it('passes afterDrop that retires every live dump of the dropped database through dumpRetire', async () => {
    lifecycle.finalizeDueKarenz.mockResolvedValue({ due: 0, finalized: 0, kept: 0, dryRun: false, errors: [], orphanedExports: [] })
    const dumpRetire = { afterEnable: vi.fn(), afterDrop: vi.fn(async () => undefined) }
    await port({ dumpRetire }).finalizeDue!({ finalDeletion: true, deadlineMs: 1 })
    const arg = lifecycle.finalizeDueKarenz.mock.calls[0]![0] as { afterDrop?: (t: string, m: string, db: string) => Promise<void> }
    expect(typeof arg.afterDrop).toBe('function')
    await arg.afterDrop!('tenant-id', 'calendar', 't_x__calendar')
    expect(dumpRetire.afterDrop).toHaveBeenCalledExactlyOnceWith('t_x__calendar')
    expect(dumpRetire.afterEnable).not.toHaveBeenCalled()
  })

  it('a failure of the retire reaches the lifecycle as a throw (which logs it and goes on), not as a swallowed success', async () => {
    lifecycle.finalizeDueKarenz.mockResolvedValue({ due: 0, finalized: 0, kept: 0, dryRun: false, errors: [], orphanedExports: [] })
    const dumpRetire = { afterEnable: vi.fn(), afterDrop: vi.fn(async () => Promise.reject(new Error('LEDGER_LOCKED'))) }
    await port({ dumpRetire }).finalizeDue!({ finalDeletion: true, deadlineMs: 1 })
    const arg = lifecycle.finalizeDueKarenz.mock.calls[0]![0] as { afterDrop: (t: string, m: string, db: string) => Promise<void> }
    await expect(arg.afterDrop('t', 'calendar', 'db')).rejects.toThrow('LEDGER_LOCKED')
  })

  it('without dumpRetire no afterDrop is passed (every existing caller)', async () => {
    lifecycle.finalizeDueKarenz.mockResolvedValue({ due: 0, finalized: 0, kept: 0, dryRun: false, errors: [], orphanedExports: [] })
    await port().finalizeDue!({ finalDeletion: true, deadlineMs: 1 })
    expect(lifecycle.finalizeDueKarenz.mock.calls[0]![0]).not.toHaveProperty('afterDrop')
  })
})
