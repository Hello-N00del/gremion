// @vitest-environment node
//
// Module Karenz (phase 2, Task 17): the settings page's view of one live Karenz row. Everything the view
// reads (the step ledger, the items, the notice counts, the sealed copies, the role holders) is a double;
// what these tests pin is the mapping: the clock, the restore rule, the mail counts, the problems (step
// names and ids only), the retained downloads, and that no person or actor can reach the view.
import { KARENZ_DAYS } from '@gremion/tenant-store/lifecycle'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KarenzRowView } from '$lib/server/module-karenz/platform'
import type { KarenzItemRow, StepRow } from '$lib/server/module-karenz/store'
import type { TenantContext } from '$lib/server/tenant/context'
import { BACKUP_HREF, buildKarenzView, GRACE_DAYS, retainedBasis, retainedLabel, type KarenzViewDeps } from './karenz-view'

const tenant = { id: '11111111-1111-4111-8111-111111111111', slug: 'rat-a', db: { tenantDb: true } } as unknown as TenantContext
const KARENZ = '55555555-5555-4555-8555-555555555555'
const NOW = new Date('2026-11-10T12:00:00Z')

function row(over: Partial<KarenzRowView> = {}): KarenzRowView {
  return {
    karenzId: KARENZ,
    catalogueId: 'votes',
    manifestId: 'votes',
    state: 'open',
    switchedOffAt: new Date('2026-11-05T09:00:00Z'),
    finalAt: new Date('2026-12-05T09:00:00Z'),
    restoreRequestedAt: null,
    finalMode: null,
    platformDoneAt: null,
    tenantDoneAt: null,
    ...over,
  }
}
const step = (name: string, state: StepRow['state'], lastError: string | null = null): StepRow => ({
  karenzId: KARENZ,
  step: name,
  state,
  attempts: 1,
  lastError,
  lastReportedAt: null,
  doneAt: state === 'done' ? NOW : null,
  updatedAt: NOW,
})
const item = (kind: string, externalId: string, state: KarenzItemRow['state']): KarenzItemRow => ({
  itemId: `item-${kind}-${externalId}`,
  karenzId: KARENZ,
  kind,
  externalId,
  state,
  payload: null,
  detail: null,
  updatedAt: NOW,
})
const listing = (id: string, catalogueId: string, over: Record<string, unknown> = {}) => ({
  id,
  catalogueId,
  retentionClass: 'RC-GOV-RES',
  lineCount: 7,
  createdAt: NOW,
  ...over,
})

function deps(over: Partial<KarenzViewDeps> = {}): KarenzViewDeps {
  return {
    listSteps: async () => [],
    listItems: async () => [],
    noticeCounts: async () => ({ sent: 0, failed: 0 }),
    listRetained: async () => [],
    skippedHolders: async () => 0,
    now: () => NOW,
    ...over,
  }
}

afterEach(() => vi.restoreAllMocks())

describe('the clock and the restore rule', () => {
  it('the grace period is the lifecycle library\'s KARENZ_DAYS', () => {
    expect(GRACE_DAYS).toBe(KARENZ_DAYS)
  })

  it('maps the row: ISO dates, whole days left rounded UP, the backup link', async () => {
    const v = await buildKarenzView(tenant, row(), deps())
    expect(v).toMatchObject({
      karenzId: KARENZ,
      state: 'open',
      switchedOffAt: '2026-11-05T09:00:00.000Z',
      finalAt: '2026-12-05T09:00:00.000Z',
      daysLeft: 25, // 24 days 21 hours
      canRestore: true,
      backupHref: BACKUP_HREF,
    })
    expect(BACKUP_HREF).toBe('/settings/sicherungen')
  })

  it('daysLeft is never negative (a late restore inside the late window still shows 0)', async () => {
    const v = await buildKarenzView(tenant, row({ finalAt: new Date('2026-11-09T09:00:00Z') }), deps())
    expect(v.daysLeft).toBe(0)
    expect(v.canRestore).toBe(true) // open until the platform job moves it (plan Open Decision 5)
  })

  it.each(['restoring', 'finalizing'] as const)('canRestore is false in the state %s', async (state) => {
    expect((await buildKarenzView(tenant, row({ state }), deps())).canRestore).toBe(false)
  })
})

describe('the info mail', () => {
  it('mail is null until the switch-off notice step is done (nothing is claimed that has not happened)', async () => {
    const pending = await buildKarenzView(tenant, row(), deps({ listSteps: async () => [step('started', 'done')], noticeCounts: async () => ({ sent: 2, failed: 0 }) }))
    expect(pending.mail).toBeNull()
    expect(pending.mailFailed).toBe(false)
  })

  it('a done notice step carries the counts and the skipped holders', async () => {
    const v = await buildKarenzView(
      tenant,
      row(),
      deps({ listSteps: async () => [step('notice:switchoff', 'done')], noticeCounts: async () => ({ sent: 2, failed: 1 }), skippedHolders: async () => 3 }),
    )
    expect(v.mail).toEqual({ recipients: 2, failed: 1, skippedHolders: 3 })
    expect(v.mailFailed).toBe(false)
  })

  it('asks the counts for the switchoff kind of THIS row', async () => {
    const noticeCounts = vi.fn(async () => ({ sent: 1, failed: 0 }))
    await buildKarenzView(tenant, row(), deps({ listSteps: async () => [step('notice:switchoff', 'done')], noticeCounts }))
    expect(noticeCounts).toHaveBeenCalledWith(tenant.db, KARENZ, 'switchoff')
  })

  it('a failed notice step: mail stays null, mailFailed is true and the step is a problem', async () => {
    const v = await buildKarenzView(tenant, row(), deps({ listSteps: async () => [step('notice:switchoff', 'failed', 'KarenzNoticeError_NO_RECIPIENTS')] }))
    expect(v.mail).toBeNull()
    expect(v.mailFailed).toBe(true)
    expect(v.problems).toHaveLength(1)
    expect(v.problems[0]).toContain('notice:switchoff')
    expect(v.problems[0]).toContain('KarenzNoticeError_NO_RECIPIENTS')
  })

  it('a role-holder lookup that fails does not break the view: 0 skipped, logged', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const v = await buildKarenzView(
      tenant,
      row(),
      deps({
        listSteps: async () => [step('notice:switchoff', 'done')],
        noticeCounts: async () => ({ sent: 1, failed: 0 }),
        skippedHolders: async () => {
          throw new Error('keycloak down')
        },
      }),
    )
    expect(v.mail).toEqual({ recipients: 1, failed: 0, skippedHolders: 0 })
    expect(err).toHaveBeenCalled()
  })

  it('does not look up holders while the notice has not been sent', async () => {
    const skippedHolders = vi.fn(async () => 0)
    await buildKarenzView(tenant, row(), deps({ skippedHolders }))
    expect(skippedHolders).not.toHaveBeenCalled()
  })
})

describe('problems: failed steps and refused items, by step name and id only', () => {
  it('lists every failed step and every lock_failed / unlock_failed item, and nothing that merely waits or worked', async () => {
    const v = await buildKarenzView(
      tenant,
      row(),
      deps({
        listSteps: async () => [
          step('participant:votes:switchoff', 'failed', 'KarenzPartialError (2 item(s))'),
          step('retained', 'done'),
          step('notice:t23', 'pending'),
          step('final:dry', 'pending'),
        ],
        listItems: async () => [item('poll', '41', 'locked'), item('poll', '42', 'lock_failed'), item('poll', '43', 'unlock_failed'), item('poll', '44', 'gone'), item('poll', '45', 'recorded')],
      }),
    )
    expect(v.problems).toHaveLength(3)
    expect(v.problems.join('\n')).toContain('participant:votes:switchoff')
    expect(v.problems.join('\n')).toContain('KarenzPartialError (2 item(s))')
    expect(v.problems.join('\n')).toContain('poll 42')
    expect(v.problems.join('\n')).toContain('poll 43')
    expect(v.problems.join('\n')).not.toContain('poll 41')
    expect(v.problems.join('\n')).not.toContain('poll 44')
  })

  it('an empty list when all is well', async () => {
    expect((await buildKarenzView(tenant, row(), deps())).problems).toEqual([])
  })

  it('an unreadable ledger is itself a problem, never an empty "all well"', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const v = await buildKarenzView(
      tenant,
      row(),
      deps({
        listSteps: async () => {
          throw new Error('connection refused')
        },
      }),
    )
    expect(v.problems.length).toBeGreaterThan(0)
    expect(JSON.stringify(v)).not.toContain('connection refused')
    expect(err).toHaveBeenCalled()
  })

  it('an unreadable item list is a problem too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const v = await buildKarenzView(
      tenant,
      row(),
      deps({
        listItems: async () => {
          throw new Error('boom')
        },
      }),
    )
    expect(v.problems.length).toBeGreaterThan(0)
  })
})

describe('retained downloads', () => {
  it('lists the sealed copies of THIS module, with the line count and the download link', async () => {
    const v = await buildKarenzView(
      tenant,
      row(),
      deps({ listRetained: async () => [listing('aaaaaaaa-0000-4000-8000-000000000001', 'votes'), listing('bbbbbbbb-0000-4000-8000-000000000002', 'elections', { retentionClass: 'RC-ELE' })] }),
    )
    expect(v.retained).toEqual([
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', label: retainedLabel('RC-GOV-RES'), lineCount: 7, href: '/api/settings/modules/retained?id=aaaaaaaa-0000-4000-8000-000000000001' },
    ])
  })

  it('an unreadable list is a problem, not an empty list', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const v = await buildKarenzView(
      tenant,
      row(),
      deps({
        listRetained: async () => {
          throw new Error('boom')
        },
      }),
    )
    expect(v.retained).toEqual([])
    expect(v.problems.length).toBeGreaterThan(0)
  })

  it('labels: known classes read in plain words, an unknown class falls back to its id, the basis follows', () => {
    expect(retainedLabel('RC-GOV-RES')).toMatch(/Beschl/)
    expect(retainedLabel('RC-ELE')).toMatch(/Wahl/)
    expect(retainedBasis('RC-ELE')).toBe('Protokollfrist')
    expect(retainedLabel('RC-ZZZ-NEW')).toContain('RC-ZZZ-NEW')
    expect(retainedBasis('RC-ZZZ-NEW')).toBe('RC-ZZZ-NEW')
  })
})

describe('no person in the view', () => {
  it('the view has exactly the documented keys, so no actor field can ride along', async () => {
    const v = await buildKarenzView(tenant, row(), deps({ listSteps: async () => [step('notice:switchoff', 'done')], noticeCounts: async () => ({ sent: 1, failed: 0 }) }))
    expect(Object.keys(v).sort()).toEqual(
      ['backupHref', 'canRestore', 'daysLeft', 'finalAt', 'karenzId', 'mail', 'mailFailed', 'problems', 'retained', 'state', 'switchedOffAt'].sort(),
    )
  })
})
