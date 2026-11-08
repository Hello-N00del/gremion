// @vitest-environment node
//
// Module Karenz (phase 2, Task 17): the deletion preview behind the red warning. Since the 30-day Karenz
// exists it carries the real semantics: graceDays 30, the final date, recoverable true, the module
// providers' counts as `deletes`, and as `retained` what the participants say they keep plus the sealed
// copies the module's extractors write. A count is never invented: a module without a provider, a
// provider that throws and a provider that returns nothing all degrade to ONE unknown-count item.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _clearKarenzParticipantsForTests, registerKarenzParticipant, type KarenzParticipant } from '$lib/server/module-karenz/participants'
import { _clearRetentionRegistriesForTests, registerRetentionExtractor } from '$lib/server/module-karenz/retained/extractors'
import type { TenantContext } from '$lib/server/tenant/context'
import { retainedLabel } from './karenz-view'
import { _clearDeletionPreviewProvidersForTests, previewSwitchOff, registerDeletionPreviewProvider } from './preview'

const tenant = { id: '11111111-1111-4111-8111-111111111111', slug: 'rat-a' } as unknown as TenantContext
const NOW = () => new Date('2026-11-10T22:30:00Z')

function participant(catalogueId: string, describe?: KarenzParticipant['describe']): KarenzParticipant {
  return {
    catalogueId,
    switchOff: async () => {},
    restore: async () => {},
    finalize: async () => ({ deleted: {} }),
    ...(describe ? { describe } : {}),
  }
}

beforeEach(() => {
  _clearDeletionPreviewProvidersForTests()
  _clearKarenzParticipantsForTests()
  _clearRetentionRegistriesForTests()
})
afterEach(() => vi.restoreAllMocks())

describe('previewSwitchOff: the real 30-day semantics', () => {
  it('returns graceDays 30, a finalDeletionAt 30 days ahead, recoverable true and one unknown-count item for a module without a provider', async () => {
    const p = await previewSwitchOff(tenant, 'votes', { now: NOW })
    expect(p.moduleId).toBe('votes')
    expect(p.moduleLabel).toBe('Abstimmungen')
    expect(p.confirmPhrase).toBe('Abstimmungen')
    expect(p.graceDays).toBe(30)
    expect(p.finalDeletionAt).toBe('2026-12-10')
    expect(p.recoverable).toBe(true)
    expect(p.retained).toEqual([])
    expect(p.deletes).toEqual([{ key: 'all', label: 'Abstimmungen-Daten', count: null, unit: '' }])
  })

  it("returns a registered provider's counts as deletes", async () => {
    registerDeletionPreviewProvider('votes', async () => [
      { key: 'open', label: 'Offene Abstimmungen', count: 3, unit: 'Abstimmungen' },
      { key: 'rooms', label: 'Chat-Raeume', count: 12, unit: 'Raeume' },
    ])
    const p = await previewSwitchOff(tenant, 'votes', { now: NOW })
    expect(p.deletes).toEqual([
      { key: 'open', label: 'Offene Abstimmungen', count: 3, unit: 'Abstimmungen' },
      { key: 'rooms', label: 'Chat-Raeume', count: 12, unit: 'Raeume' },
    ])
    expect(p.graceDays).toBe(30)
  })

  it('a provider that throws degrades to the unknown-count item and logs', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerDeletionPreviewProvider('votes', async () => {
      throw new Error('boom')
    })
    const p = await previewSwitchOff(tenant, 'votes', { now: NOW })
    expect(p.deletes).toEqual([{ key: 'all', label: 'Abstimmungen-Daten', count: null, unit: '' }])
    expect(p.graceDays).toBe(30)
    expect(err).toHaveBeenCalled()
  })

  it('a provider that returns an empty list also degrades to the unknown-count item (never an empty promise)', async () => {
    registerDeletionPreviewProvider('votes', async () => [])
    const p = await previewSwitchOff(tenant, 'votes', { now: NOW })
    expect(p.deletes).toHaveLength(1)
    expect(p.deletes[0]!.count).toBeNull()
  })

  it('refuses an id that is not council-switchable', async () => {
    await expect(previewSwitchOff(tenant, 'files')).rejects.toThrow(/not council-switchable/)
    await expect(previewSwitchOff(tenant, 'board')).rejects.toThrow(/not council-switchable/)
  })
})

describe('previewSwitchOff: what is kept', () => {
  it("takes the participant's deletes and retained items from describe, with the count on the label and the class as the basis", async () => {
    registerKarenzParticipant(
      participant('votes', async () => ({
        deletes: [{ label: 'Umfragen im Entwurf', count: 4 }],
        retained: [{ label: 'Beschluesse mit Terminbezug', count: 2, retentionClass: 'RC-GOV-RES' }, { label: 'Dateien bleiben in Nextcloud', count: 9 }],
      })),
    )
    const p = await previewSwitchOff(tenant, 'votes', { now: NOW })
    expect(p.deletes).toEqual([{ key: 'participant:0', label: 'Umfragen im Entwurf', count: 4, unit: '' }])
    expect(p.retained).toEqual([
      { key: 'participant:0', label: 'Beschluesse mit Terminbezug: 2', basis: 'Protokollfrist' },
      { key: 'participant:1', label: 'Dateien bleiben in Nextcloud: 9', basis: '' },
    ])
  })

  it('a describe that throws is logged and ignored: the provider counts stay, nothing is invented', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerDeletionPreviewProvider('votes', async () => [{ key: 'open', label: 'Offene Abstimmungen', count: 3, unit: 'Abstimmungen' }])
    registerKarenzParticipant(
      participant('votes', async () => {
        throw new Error('matrix down')
      }),
    )
    const p = await previewSwitchOff(tenant, 'votes', { now: NOW })
    expect(p.deletes).toEqual([{ key: 'open', label: 'Offene Abstimmungen', count: 3, unit: 'Abstimmungen' }])
    expect(p.retained).toEqual([])
    expect(err).toHaveBeenCalled()
  })

  it('a participant without describe adds nothing', async () => {
    registerKarenzParticipant(participant('votes'))
    const p = await previewSwitchOff(tenant, 'votes', { now: NOW })
    expect(p.retained).toEqual([])
    expect(p.deletes).toHaveLength(1)
  })

  it('the sealed copies the module\'s extractors write are named, once per extractor, with the class basis (elections: results, Protokollfrist)', async () => {
    const extract = async function* () {}
    registerRetentionExtractor({ id: 'elections.results', catalogueId: 'elections', retentionClass: 'RC-ELE', extract })
    registerRetentionExtractor({ id: 'votes.tallies', catalogueId: 'votes', retentionClass: 'RC-GOV-RES', extract })
    const p = await previewSwitchOff(tenant, 'elections', { now: NOW })
    expect(p.retained).toEqual([{ key: 'extractor:elections.results', label: retainedLabel('RC-ELE'), basis: 'Protokollfrist' }])
    expect(retainedLabel('RC-ELE')).toMatch(/^Wahlergebnisse/)
  })

  it('an extractor of an unknown class is named by its class, never by a made-up description', async () => {
    registerRetentionExtractor({ id: 'votes.x', catalogueId: 'votes', retentionClass: 'RC-ZZZ-NEW', extract: async function* () {} })
    const p = await previewSwitchOff(tenant, 'votes', { now: NOW })
    expect(p.retained).toHaveLength(1)
    expect(p.retained[0]!.label).toContain('RC-ZZZ-NEW')
    expect(p.retained[0]!.basis).toBe('RC-ZZZ-NEW')
  })
})
