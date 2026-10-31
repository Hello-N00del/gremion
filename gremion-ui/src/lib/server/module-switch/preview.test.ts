// @vitest-environment node
//
// Karenz phase 1, Task 11: the deletion-preview contract (Interface I-3 for phase 2). Phase 1 only
// carries the contract: graceDays null, recoverable false, nothing retained; the providers are the
// seam phase 2 fills with real counters.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TenantContext } from '$lib/server/tenant/context'
import { _clearDeletionPreviewProvidersForTests, previewSwitchOff, registerDeletionPreviewProvider } from './preview'

const tenant = { id: '11111111-1111-4111-8111-111111111111', slug: 'rat-a' } as unknown as TenantContext

beforeEach(() => _clearDeletionPreviewProvidersForTests())
afterEach(() => vi.restoreAllMocks())

describe('previewSwitchOff', () => {
  it('returns graceDays null, recoverable false, retained [] and one unknown-count item for a module without a provider', async () => {
    const p = await previewSwitchOff(tenant, 'votes')
    expect(p.moduleId).toBe('votes')
    expect(p.moduleLabel).toBe('Abstimmungen')
    expect(p.confirmPhrase).toBe('Abstimmungen')
    expect(p.graceDays).toBeNull()
    expect(p.finalDeletionAt).toBeNull()
    expect(p.recoverable).toBe(false)
    expect(p.retained).toEqual([])
    expect(p.deletes).toEqual([{ key: 'all', label: 'Abstimmungen-Daten', count: null, unit: '' }])
  })

  it("returns a registered provider's counts", async () => {
    registerDeletionPreviewProvider('votes', async () => [{ key: 'open', label: 'Offene Abstimmungen', count: 3, unit: 'Abstimmungen' }])
    const p = await previewSwitchOff(tenant, 'votes')
    expect(p.deletes).toEqual([{ key: 'open', label: 'Offene Abstimmungen', count: 3, unit: 'Abstimmungen' }])
    expect(p.graceDays).toBeNull()
  })

  it('a provider that throws degrades to the unknown-count item and logs', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerDeletionPreviewProvider('votes', async () => {
      throw new Error('boom')
    })
    const p = await previewSwitchOff(tenant, 'votes')
    expect(p.deletes).toEqual([{ key: 'all', label: 'Abstimmungen-Daten', count: null, unit: '' }])
    expect(err).toHaveBeenCalled()
  })

  it('a provider that returns an empty list also degrades to the unknown-count item (never an empty promise)', async () => {
    registerDeletionPreviewProvider('votes', async () => [])
    const p = await previewSwitchOff(tenant, 'votes')
    expect(p.deletes).toHaveLength(1)
    expect(p.deletes[0]!.count).toBeNull()
  })

  it('refuses an id that is not council-switchable', async () => {
    await expect(previewSwitchOff(tenant, 'files')).rejects.toThrow(/not council-switchable/)
    await expect(previewSwitchOff(tenant, 'board')).rejects.toThrow(/not council-switchable/)
  })
})
