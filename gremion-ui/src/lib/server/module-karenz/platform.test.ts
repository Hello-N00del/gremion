// @vitest-environment node
//
// Module Karenz (phase 2, Task 8): the bridge to the platform rows. Two doors only, both through the
// council pool (gremion_ui_modules): plt.council_karenz_list and plt.council_karenz_report.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ text: string; values: unknown[] }>, result: [] as unknown[], fail: null as Error | null }))
vi.mock('$lib/server/module-switch/council-db', () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    h.calls.push({ text: strings.join('?'), values })
    return h.fail ? Promise.reject(h.fail) : Promise.resolve(h.result)
  }
  return { getCouncilDb: () => sql, CouncilNotConfigured: class extends Error {} }
})

import { listKarenz, reportKarenz } from './platform'

const CUSTOMER = '11111111-1111-4111-8111-111111111111'
const KARENZ = '44444444-4444-4444-8444-444444444441'
const T0 = new Date('2026-10-01T10:00:00Z')

const dbRow = (over: Record<string, unknown> = {}) => ({
  karenz_id: KARENZ,
  module_key: 'votes',
  state: 'open',
  switched_off_at: T0,
  final_at: new Date(T0.getTime() + 30 * 86_400_000),
  restore_requested_at: null,
  final_mode: null,
  platform_done_at: null,
  tenant_done_at: null,
  export_kept_until: null,
  ...over,
})

beforeEach(() => {
  h.calls.length = 0
  h.result = []
  h.fail = null
})

describe('listKarenz', () => {
  it('maps rows and exposes no actor field', async () => {
    h.result = [dbRow(), dbRow({ karenz_id: '44444444-4444-4444-8444-444444444442', module_key: 'messaging', state: 'restoring', restore_requested_at: T0, final_mode: 'live' })]
    const rows = await listKarenz(CUSTOMER)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({
      karenzId: KARENZ,
      catalogueId: 'votes',
      manifestId: 'votes',
      state: 'open',
      switchedOffAt: T0,
      finalAt: new Date(T0.getTime() + 30 * 86_400_000),
      restoreRequestedAt: null,
      finalMode: null,
      platformDoneAt: null,
      tenantDoneAt: null,
    })
    // a catalogue id that is not council-switchable has no manifest id; the row is still returned
    expect(rows[1]).toMatchObject({ catalogueId: 'messaging', manifestId: null, state: 'restoring', restoreRequestedAt: T0, finalMode: 'live' })
    for (const r of rows) {
      expect(Object.keys(r).join(',')).not.toMatch(/actor|path|sha|export/i)
    }
  })

  it('asks the platform for the customer and the default 14-day closed window', async () => {
    await listKarenz(CUSTOMER)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.text).toContain('plt.council_karenz_list')
    expect(h.calls[0]!.values).toEqual([CUSTOMER, 14])
    await listKarenz(CUSTOMER, 0)
    expect(h.calls[1]!.values).toEqual([CUSTOMER, 0])
  })

  it('a state or mode this build does not know is dropped (logged), never guessed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.result = [dbRow({ state: 'archived' }), dbRow({ final_mode: 'maybe' })]
    const rows = await listKarenz(CUSTOMER)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.finalMode).toBeNull()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('a platform failure rejects (the pass decides what to do with it)', async () => {
    h.fail = new Error('connection refused')
    await expect(listKarenz(CUSTOMER)).rejects.toThrow('connection refused')
  })
})

describe('reportKarenz', () => {
  it('passes the mark through', async () => {
    await reportKarenz(CUSTOMER, KARENZ, { step: 'final', level: 'info', message: 'tenant side done', mark: 'tenant_done' })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.text).toContain('plt.council_karenz_report')
    expect(h.calls[0]!.values).toEqual([CUSTOMER, KARENZ, 'final', 'info', 'tenant side done', 'tenant_done'])
  })

  it('no mark is sent as null', async () => {
    await reportKarenz(CUSTOMER, KARENZ, { step: 'notice:switchoff', level: 'error', message: 'SMTP unconfigured' })
    expect(h.calls[0]!.values[5]).toBeNull()
  })

  it('clips the message to the 1000 characters the platform accepts and the step to its 60', async () => {
    await reportKarenz(CUSTOMER, KARENZ, { step: `participant:${'x'.repeat(80)}`, level: 'error', message: 'm'.repeat(1500) })
    const [, , step, , message] = h.calls[0]!.values as string[]
    expect(step!.length).toBeLessThanOrEqual(60)
    expect(step).toMatch(/^[a-z][a-z0-9:_-]{0,59}$/)
    expect(message!.length).toBe(1000)
  })

  it('a refused report (the platform says 22023) rejects so the step stays unreported', async () => {
    h.fail = Object.assign(new Error('tenant_done is accepted only after final_at'), { code: '22023' })
    await expect(reportKarenz(CUSTOMER, KARENZ, { step: 'final', level: 'info', message: 'm', mark: 'tenant_done' })).rejects.toThrow('final_at')
  })
})
