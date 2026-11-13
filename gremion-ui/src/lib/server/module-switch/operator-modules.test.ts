// @vitest-environment node
//
// Settings > Module lists every module the customer has. The council switches only some of them; the rest are
// the operator's. This pins which modules make the second list and when, and that the list is read from the
// same two sources the app itself gates on (config.modules and the platform enablement row), never widening
// what a council may switch.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TenantContext } from '$lib/server/tenant/context'

const h = vi.hoisted(() => ({ getCouncilDb: vi.fn(), readConfig: vi.fn() }))
vi.mock('./council-db', async (orig) => ({ ...(await orig<typeof import('./council-db')>()), getCouncilDb: h.getCouncilDb }))
vi.mock('$lib/server/config', () => ({ readConfig: h.readConfig }))
vi.mock('$env/dynamic/private', () => ({ env: {} }))

import { SWITCHABLE_CATALOGUE_IDS } from '$lib/modules/catalogue-map'
import { CouncilNotConfigured } from './council-db'
import { buildOperatorModules, loadOperatorModules } from './operator-modules'

const CUSTOMER = '11111111-1111-4111-8111-111111111111'
const tenant = { id: CUSTOMER, slug: 'rat-a', db: {} } as unknown as TenantContext

type Row = { module_key: string; state: string; has_row: boolean }
const row = (module_key: string, over: Partial<Row> = {}): Row => ({ module_key, state: 'disabled', has_row: false, ...over })
const stateOf = (...rows: Row[]) => new Map(rows.map((r) => [r.module_key, r]))
const ids = (list: { moduleId: string }[]) => list.map((m) => m.moduleId)

// The pilot customer: calendar, content, files, messaging, publishing and votes are on (every platform row enabled).
const SIX = ['calendar', 'content', 'files', 'messaging', 'publishing', 'votes']
const pilotState = () => stateOf(...SIX.map((k) => row(k, { state: 'enabled', has_row: true })))
const pilotConfig = { calendar: true, content: true, files: true, messages: true, newsletter: true, votes: true, board: false, elections: false }

describe('buildOperatorModules', () => {
  it('the pilot customer: every module the council cannot switch but the customer has is listed, with the neighbouring German names', () => {
    expect(buildOperatorModules(pilotState(), pilotConfig)).toEqual([
      { moduleId: 'messaging', label: 'Chat' },
      { moduleId: 'files', label: 'Dokumente' },
      { moduleId: 'content', label: 'Inhalte' },
      { moduleId: 'publishing', label: 'Newsletter' },
    ])
  })

  it('never names a module the council may switch (that list has its own rows and controls)', () => {
    const list = buildOperatorModules(pilotState(), { ...pilotConfig, elections: true })
    expect(list.length).toBeGreaterThan(0)
    for (const m of list) expect(SWITCHABLE_CATALOGUE_IDS.has(m.moduleId)).toBe(false)
  })

  it('a module that is off is not listed: config says off, even with an enabled platform row', () => {
    const list = buildOperatorModules(pilotState(), { ...pilotConfig, files: false })
    expect(ids(list)).not.toContain('files')
    expect(ids(list)).toContain('content')
  })

  it('a module whose platform row says it is not enabled is not listed, even when config.modules still reads on', () => {
    const state = stateOf(row('content', { state: 'disabled', has_row: true }), row('files', { state: 'enabled', has_row: true }))
    expect(ids(buildOperatorModules(state, pilotConfig))).toEqual(['files'])
  })

  it('without a platform row the module follows config.modules, and an absent key reads as on', () => {
    const state = stateOf(row('content'), row('files'))
    expect(ids(buildOperatorModules(state, { content: false }))).toContain('files')
    expect(ids(buildOperatorModules(state, { content: false }))).not.toContain('content')
    expect(ids(buildOperatorModules(new Map(), {}))).toEqual(['board', 'messaging', 'files', 'content', 'publishing'])
  })

  it('handover, vault and elections are never listed: no manifest, not shipped, held off', () => {
    const state = stateOf(...['handover', 'vault', 'elections'].map((k) => row(k, { state: 'enabled', has_row: true })))
    const list = buildOperatorModules(state, { ...pilotConfig, elections: true, vault: true })
    for (const id of ['handover', 'vault', 'elections']) expect(ids(list)).not.toContain(id)
  })

  it('board is listed when it is on (the sidebar shows Aufgaben then), under its own name', () => {
    expect(buildOperatorModules(pilotState(), { ...pilotConfig, board: true })).toContainEqual({ moduleId: 'board', label: 'Aufgaben' })
  })

  it('the result carries nothing but the id and the label', () => {
    const list = buildOperatorModules(pilotState(), pilotConfig)
    expect(list.length).toBeGreaterThan(0)
    for (const m of list) expect(Object.keys(m).sort()).toEqual(['label', 'moduleId'])
  })
})

describe('loadOperatorModules', () => {
  beforeEach(() => {
    h.getCouncilDb.mockReset()
    h.readConfig.mockReset().mockReturnValue({ modules: pilotConfig })
  })

  it('reads the platform state of this customer and the tenant config', async () => {
    const calls: { text: string; values: unknown[] }[] = []
    h.getCouncilDb.mockReturnValue((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values })
      return Promise.resolve([...pilotState().values()])
    })
    const list = await loadOperatorModules(tenant)
    expect(ids(list)).toEqual(['messaging', 'files', 'content', 'publishing'])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.text).toContain('council_module_state')
    expect(calls[0]!.values).toEqual([CUSTOMER])
    expect(h.readConfig).toHaveBeenCalledWith(tenant)
  })

  it('CouncilNotConfigured is thrown, never an empty list that reads as "nothing here"', async () => {
    h.getCouncilDb.mockImplementation(() => {
      throw new CouncilNotConfigured()
    })
    await expect(loadOperatorModules(tenant)).rejects.toBeInstanceOf(CouncilNotConfigured)
  })
})
