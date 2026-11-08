import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// Module Karenz (phase 2, Task 16): the files participant. A switch-off of the files module removes
// ONLY the Gremion binding (the org unit's Nextcloud ledger row and its wants_nextcloud_folder flag);
// the Nextcloud folder, its group and every file stay. The governance layer (org units, provisioning
// ledger) is a stateful fake; the fetch stub records every Nextcloud call so "nothing is deleted in
// Nextcloud" is an assertion on the wire, not on a mock. The REAL Nextcloud provisioning adapter runs
// against the restored ledger row to prove that the unit is provisioned again without a new folder.

const runWithTenant = vi.fn(<T>(_tenant: unknown, fn: () => T): T => fn())
vi.mock('$lib/server/tenant/context', () => ({
  getTenant: () => ({ id: 'default', slug: 'default' }),
  currentTenantId: () => 'default',
  runWithTenant,
}))

interface Unit { id: string; name: string }
interface LedgerRow { status: string; external_id: string | null }
const units: Unit[] = []
const ledger = new Map<string, LedgerRow>()
const wanted = new Map<string, boolean>()
let releaseFailures = new Set<string>()
let attachFailures = new Set<string>()
let order: string[] = []

vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnit: async (id: string) => units.find((u) => u.id === id) ?? null,
  listOrgUnits: async () => units,
  setSubsystemWanted: async (_tx: unknown, id: string, _s: string, value: boolean) => {
    if (value && attachFailures.has(id)) throw new Error('db down (' + id + ')')
    wanted.set(id, value)
    order.push(`wanted:${id}:${value}`)
  },
}))
vi.mock('$lib/server/governance/provisioning/ledger', () => ({
  getResource: async (unitId: string) => ledger.get(unitId) ?? null,
  enqueueResources: async (_tx: unknown, unitId: string) => {
    if (!ledger.has(unitId)) ledger.set(unitId, { status: 'pending', external_id: null })
    order.push(`enqueue:${unitId}`)
  },
  markResourceOk: async (unitId: string, _s: string, externalId: string) => {
    ledger.set(unitId, { status: 'ok', external_id: externalId })
    order.push(`ok:${unitId}:${externalId}`)
  },
}))
vi.mock('$lib/server/governance/provisioning/orchestrator', () => ({
  releaseSubsystem: async (unitId: string, _s: string, teardown: (id: string | null) => Promise<void>) => {
    const before = ledger.get(unitId)
    await teardown(before?.external_id ?? null)
    if (releaseFailures.has(unitId)) throw new Error('db down (' + unitId + ')')
    wanted.set(unitId, false)
    ledger.delete(unitId)
    order.push(`release:${unitId}`)
    return before?.external_id ?? null
  },
}))
vi.mock('$lib/server/db', () => ({
  getDb: () => ({ begin: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) }),
}))

import type { KarenzContext } from '$lib/server/module-karenz/participants'
import { KarenzPartialError } from '$lib/server/module-karenz/participants'
import type { ItemState, KarenzItemRow } from '$lib/server/module-karenz/store'

function makeItems() {
  const rows = new Map<string, KarenzItemRow>()
  let n = 0
  let setStateFailures = 0
  const items: KarenzContext['items'] = {
    list: async (kind) => [...rows.values()].filter((r) => kind === undefined || r.kind === kind),
    upsert: async (i) => {
      const k = `${i.kind}\u0000${i.externalId}`
      const prev = rows.get(k)
      if (prev && i.state === 'recorded' && prev.state !== 'recorded') return prev
      const row: KarenzItemRow = {
        itemId: prev?.itemId ?? `item-${++n}`, karenzId: 'k1', kind: i.kind, externalId: i.externalId, state: i.state,
        payload: i.payload ?? prev?.payload ?? null, detail: i.detail ?? null, updatedAt: new Date(),
      }
      rows.set(k, row)
      return row
    },
    setState: async (itemId, state: ItemState, detail) => {
      if (setStateFailures > 0) { setStateFailures--; throw new Error('db down (bookkeeping)') }
      const row = [...rows.values()].find((r) => r.itemId === itemId)
      if (!row) throw new Error(`Karenz item ${itemId} no longer exists`)
      row.state = state
      row.detail = detail ?? null
    },
  }
  return { rows, items, failNextSetStates: (count: number) => { setStateFailures = count } }
}

function makeCtx(items: KarenzContext['items']): KarenzContext {
  return {
    tenant: { id: 'default', slug: 'default' } as never,
    karenzId: 'k1', catalogueId: 'files', manifestId: 'files',
    switchedOffAt: new Date('2026-11-01T00:00:00Z'), finalAt: new Date('2026-12-01T00:00:00Z'),
    now: () => new Date('2026-11-01T12:00:00Z'), items, log: vi.fn(),
  }
}

/** A unit with a provisioned Nextcloud folder: external_id is "<folderId>:<groupId>" as the adapter writes it. */
function addBoundUnit(id: string, folderId: number): string {
  units.push({ id, name: `Gremium ${id}` })
  const externalId = `${folderId}:ou-${id}`
  ledger.set(id, { status: 'ok', external_id: externalId })
  wanted.set(id, true)
  return externalId
}

describe('filesKarenz', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let karenz: Awaited<typeof import('./karenz')>
  let store: ReturnType<typeof makeItems>
  let ctx: KarenzContext

  const itemOf = (externalId: string) => store.rows.get(`file_binding\u0000${externalId}`)
  const ncCalls = () => fetchMock.mock.calls.map((c) => `${String((c[1] as RequestInit | undefined)?.method ?? 'GET')} ${String(c[0])}`)

  beforeEach(async () => {
    vi.clearAllMocks()
    units.length = 0
    ledger.clear()
    wanted.clear()
    releaseFailures = new Set()
    attachFailures = new Set()
    order = []
    fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    store = makeItems()
    ctx = makeCtx(store.items)
    karenz = await import('./karenz')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('is the participant of the catalogue id files', () => {
    expect(karenz.filesKarenz.catalogueId).toBe('files')
  })

  it('switchOff releases the binding without deleting the folder and records the external id', async () => {
    const a = addBoundUnit('a', 7)
    const b = addBoundUnit('b', 8)

    await karenz.filesKarenz.switchOff(ctx)

    // the binding is gone: no ledger row, the wanted flag is off, so the provisioning worker does not recreate a folder
    expect(ledger.has('a')).toBe(false)
    expect(ledger.has('b')).toBe(false)
    expect(wanted.get('a')).toBe(false)
    expect(wanted.get('b')).toBe(false)
    // the external id (folder and group) is recorded per unit, as the restore needs it
    expect(itemOf(a)).toMatchObject({ kind: 'file_binding', externalId: a, state: 'locked', payload: { unitId: 'a' } })
    expect(itemOf(b)).toMatchObject({ kind: 'file_binding', externalId: b, state: 'locked', payload: { unitId: 'b' } })
    // and nothing happened in Nextcloud: no group folder, group, user or file was touched
    expect(ncCalls()).toEqual([])
  })

  it('records an item BEFORE releasing, so a crash between the two is found again', async () => {
    addBoundUnit('a', 7)
    releaseFailures = new Set(['a'])

    await expect(karenz.filesKarenz.switchOff(ctx)).rejects.toBeInstanceOf(KarenzPartialError)

    // the release failed, the item exists and says so; the binding is untouched
    expect(itemOf('7:ou-a')?.state).toBe('lock_failed')
    expect(ledger.get('a')).toMatchObject({ status: 'ok', external_id: '7:ou-a' })
    expect(wanted.get('a')).toBe(true)
  })

  it('switchOff is idempotent and converges after a crash between the release and the bookkeeping', async () => {
    const a = addBoundUnit('a', 7)
    store.failNextSetStates(1) // the release goes through, then recording "locked" fails

    await expect(karenz.filesKarenz.switchOff(ctx)).rejects.toBeInstanceOf(KarenzPartialError)
    expect(ledger.has('a')).toBe(false) // released
    expect(itemOf(a)?.state).toBe('recorded') // but not recorded as such

    await karenz.filesKarenz.switchOff(ctx) // the next pass
    expect(itemOf(a)).toMatchObject({ state: 'locked', payload: { unitId: 'a' } })
    expect(store.rows.size).toBe(1)

    await karenz.filesKarenz.switchOff(ctx) // and a third time changes nothing
    expect(itemOf(a)?.state).toBe('locked')
    expect(store.rows.size).toBe(1)
    expect(ncCalls()).toEqual([])
  })

  it('a unit whose folder was never created is released too and comes back as a pending row, not as an invented folder', async () => {
    units.push({ id: 'n', name: 'Neu' })
    ledger.set('n', { status: 'pending', external_id: null })
    wanted.set('n', true)

    await karenz.filesKarenz.switchOff(ctx)
    expect(ledger.has('n')).toBe(false) // the worker must not create a folder while the module is off
    expect(wanted.get('n')).toBe(false)
    const item = (await store.items.list('file_binding'))[0]!
    expect(item.state).toBe('locked')
    expect(item.payload).toMatchObject({ unitId: 'n', bound: false })

    await karenz.filesKarenz.restore(ctx)
    expect(wanted.get('n')).toBe(true)
    expect(ledger.get('n')).toEqual({ status: 'pending', external_id: null }) // the worker creates it, nothing is made up here
    expect((await store.items.list('file_binding'))[0]!.state).toBe('restored')
  })

  it('a failing release of one unit does not stop the others and fails the step with unit ids only', async () => {
    addBoundUnit('bad', 7)
    addBoundUnit('good', 8)
    releaseFailures = new Set(['bad'])

    const err = await karenz.filesKarenz.switchOff(ctx).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(KarenzPartialError)
    const failures = (err as KarenzPartialError).failures
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('bad')
    // no folder id, group id or unit name leaks into the failure labels
    expect(JSON.stringify(failures)).not.toMatch(/ou-bad|7:|Gremium/)
    expect(ledger.has('good')).toBe(false) // the other unit was still released
    expect(itemOf('8:ou-good')?.state).toBe('locked')
    expect(itemOf('7:ou-bad')?.state).toBe('lock_failed')
  })

  it('restore re-attaches the same external id and the unit is provisioned again without creating a new folder', async () => {
    const a = addBoundUnit('a', 7)
    await karenz.filesKarenz.switchOff(ctx)
    expect(ledger.has('a')).toBe(false)

    await karenz.filesKarenz.restore(ctx)

    expect(ledger.get('a')).toEqual({ status: 'ok', external_id: a })
    expect(wanted.get('a')).toBe(true)
    expect(itemOf(a)?.state).toBe('restored')
    expect(ncCalls()).toEqual([])

    // The REAL adapter: the provisioning worker's ensureResource gets the restored external id as `existing`
    // and must hand it back without creating a group folder or a group.
    const { createNextcloudSubsystem } = await import('./provisioning/nextcloud-subsystem')
    const nc = {
      createGroup: vi.fn(), listGroupFolders: vi.fn(), createGroupFolder: vi.fn(), assignGroupFolderPermissions: vi.fn(),
    }
    const subsystem = createNextcloudSubsystem({ nc: nc as never, kc: { getUser: vi.fn() } as never }, 1)
    const result = await subsystem.ensureResource(units[0]! as never, {} as never, ledger.get('a')!.external_id)
    expect(result).toEqual({ externalId: a })
    expect(nc.createGroupFolder).not.toHaveBeenCalled()
    expect(nc.createGroup).not.toHaveBeenCalled()
    expect(nc.listGroupFolders).not.toHaveBeenCalled()
  })

  it('restore attaches the row and the flag in one step, the row last (an interrupted restore is run again)', async () => {
    addBoundUnit('a', 7)
    await karenz.filesKarenz.switchOff(ctx)
    order = []
    await karenz.filesKarenz.restore(ctx)
    expect(order).toEqual(['enqueue:a', 'wanted:a:true', 'ok:a:7:ou-a'])
  })

  it('restore is idempotent: an already re-attached unit is not touched again', async () => {
    const a = addBoundUnit('a', 7)
    await karenz.filesKarenz.switchOff(ctx)
    await karenz.filesKarenz.restore(ctx)
    order = []
    await karenz.filesKarenz.restore(ctx)
    expect(order).toEqual([])
    expect(itemOf(a)?.state).toBe('restored')
  })

  it('restore after a crash between the re-attach and the bookkeeping finishes the item without re-attaching', async () => {
    const a = addBoundUnit('a', 7)
    await karenz.filesKarenz.switchOff(ctx)
    store.failNextSetStates(1)
    await expect(karenz.filesKarenz.restore(ctx)).rejects.toBeInstanceOf(KarenzPartialError)
    expect(ledger.get('a')).toEqual({ status: 'ok', external_id: a })
    order = []
    await karenz.filesKarenz.restore(ctx)
    expect(order).toEqual([])
    expect(itemOf(a)?.state).toBe('restored')
  })

  it('restore of a unit that was deleted meanwhile ends the item as gone, not as a failure', async () => {
    const a = addBoundUnit('a', 7)
    await karenz.filesKarenz.switchOff(ctx)
    units.length = 0

    await karenz.filesKarenz.restore(ctx)
    expect(itemOf(a)?.state).toBe('gone')
    expect(ledger.has('a')).toBe(false)
    expect(wanted.get('a')).toBe(false)
  })

  it('restore never overwrites a ledger row that names a DIFFERENT folder; the item is kept and says so', async () => {
    const a = addBoundUnit('a', 7)
    await karenz.filesKarenz.switchOff(ctx)
    ledger.set('a', { status: 'ok', external_id: '99:ou-a' }) // someone provisioned another folder meanwhile
    wanted.set('a', true)

    await karenz.filesKarenz.restore(ctx)
    expect(ledger.get('a')).toEqual({ status: 'ok', external_id: '99:ou-a' })
    expect(itemOf(a)).toMatchObject({ state: 'kept' })
    expect(itemOf(a)?.detail).toMatch(/another folder/)
  })

  it('a failing re-attach of one unit does not stop the others and fails the step with unit ids only', async () => {
    addBoundUnit('bad', 7)
    addBoundUnit('good', 8)
    await karenz.filesKarenz.switchOff(ctx)
    attachFailures = new Set(['bad'])

    const err = await karenz.filesKarenz.restore(ctx).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(KarenzPartialError)
    expect(JSON.stringify((err as KarenzPartialError).failures)).not.toMatch(/ou-bad|7:|Gremium/)
    expect(ledger.get('good')).toEqual({ status: 'ok', external_id: '8:ou-good' })
    expect(itemOf('7:ou-bad')?.state).toBe('unlock_failed')

    attachFailures = new Set() // the next pass converges
    await karenz.filesKarenz.restore(ctx)
    expect(ledger.get('bad')).toEqual({ status: 'ok', external_id: '7:ou-bad' })
    expect(itemOf('7:ou-bad')?.state).toBe('restored')
  })

  it('finalize deletes nothing in Nextcloud, dry run or not, and leaves the binding released', async () => {
    const a = addBoundUnit('a', 7)
    await karenz.filesKarenz.switchOff(ctx)

    await expect(karenz.filesKarenz.finalize(ctx, { dryRun: true })).resolves.toEqual({ deleted: {} })
    expect(itemOf(a)?.state).toBe('locked') // a preview changes nothing

    await expect(karenz.filesKarenz.finalize(ctx, { dryRun: false })).resolves.toEqual({ deleted: {} })
    expect(itemOf(a)?.state).toBe('kept')
    expect(itemOf(a)?.detail).toMatch(/stays in Nextcloud/)
    expect(ncCalls()).toEqual([]) // no DELETE of a folder, a group or a file
    expect(ledger.has('a')).toBe(false)

    await expect(karenz.filesKarenz.finalize(ctx, { dryRun: false })).resolves.toEqual({ deleted: {} }) // idempotent
    expect(itemOf(a)?.state).toBe('kept')
  })

  it('describe says that the files stay: nothing is deleted, the bound units are counted', async () => {
    addBoundUnit('a', 7)
    addBoundUnit('b', 8)
    units.push({ id: 'n', name: 'Neu' }) // no folder: not counted

    const d = await karenz.filesKarenz.describe!({ id: 'default', slug: 'default' } as never)
    expect(d.deletes).toEqual([])
    expect(d.retained).toHaveLength(1)
    expect(d.retained[0]).toMatchObject({ count: 2 })
    expect(d.retained[0]!.label).toMatch(/Nextcloud/)
    expect(runWithTenant).toHaveBeenCalled() // the ledger resolves the tenant from the ambient context
  })

  it('describe with no bound unit has nothing to report', async () => {
    const d = await karenz.filesKarenz.describe!({ id: 'default', slug: 'default' } as never)
    expect(d).toEqual({ deletes: [], retained: [] })
  })
})
