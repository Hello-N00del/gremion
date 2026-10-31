// @vitest-environment node
//
// Module Karenz (phase 2, Task 8): switch-off guards. A module registers a guard for its catalogue id;
// the council switch service (Task 17) asks switchOffBlockedReason before it queues a disable. The
// first non-null reason wins, and a guard that throws blocks (fail closed).
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TenantContext } from '$lib/server/tenant/context'
import { _clearSwitchOffGuardsForTests, GUARD_FAILED_REASON, registerSwitchOffGuard, switchOffBlockedReason } from './guards'

const tenant = { id: '11111111-1111-4111-8111-111111111111', slug: 'rat-a' } as unknown as TenantContext

afterEach(() => {
  _clearSwitchOffGuardsForTests()
  vi.restoreAllMocks()
})

describe('switchOffBlockedReason', () => {
  it('returns null when no guard is registered for the module', async () => {
    expect(await switchOffBlockedReason(tenant, 'votes')).toBeNull()
  })

  it('returns the first non-null reason and does not call later guards', async () => {
    const later = vi.fn(async () => 'later')
    registerSwitchOffGuard('elections', async () => null)
    registerSwitchOffGuard('elections', async () => 'Eine Wahl laeuft noch')
    registerSwitchOffGuard('elections', later)
    expect(await switchOffBlockedReason(tenant, 'elections')).toBe('Eine Wahl laeuft noch')
    expect(later).not.toHaveBeenCalled()
  })

  it('a guard of another module is not asked', async () => {
    const other = vi.fn(async () => 'other')
    registerSwitchOffGuard('votes', other)
    expect(await switchOffBlockedReason(tenant, 'elections')).toBeNull()
    expect(other).not.toHaveBeenCalled()
  })

  it('passes the tenant to the guard', async () => {
    const g = vi.fn(async () => null)
    registerSwitchOffGuard('elections', g)
    await switchOffBlockedReason(tenant, 'elections')
    expect(g).toHaveBeenCalledWith(tenant)
  })

  it('a throwing guard blocks with a fixed reason and a logged error; a rejecting one the same', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerSwitchOffGuard('elections', (() => {
      throw new Error('helios down: secret-detail')
    }) as never)
    const sync = await switchOffBlockedReason(tenant, 'elections')
    expect(typeof sync).toBe('string')
    expect(sync).not.toContain('secret-detail')
    expect(err).toHaveBeenCalledTimes(1)
    expect(err.mock.calls.flat().join(' ')).toContain('helios down')

    _clearSwitchOffGuardsForTests()
    registerSwitchOffGuard('elections', async () => {
      throw new Error('rejected')
    })
    expect(await switchOffBlockedReason(tenant, 'elections')).toBe(sync)
    expect(err).toHaveBeenCalledTimes(2)
  })

  it('registering the same guard twice (a module loaded twice) asks it once', async () => {
    const g = vi.fn(async () => null)
    registerSwitchOffGuard('elections', g)
    registerSwitchOffGuard('elections', g)
    await switchOffBlockedReason(tenant, 'elections')
    expect(g).toHaveBeenCalledTimes(1)
  })

  it('a guard that answers neither null nor a reason text (undefined, an empty string) blocks like a failed one, never returns undefined as the reason', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerSwitchOffGuard('elections', (async () => undefined) as never)
    const forgot = await switchOffBlockedReason(tenant, 'elections')
    expect(forgot).toBe(GUARD_FAILED_REASON)
    expect(err).toHaveBeenCalledTimes(1)
    _clearSwitchOffGuardsForTests()
    registerSwitchOffGuard('elections', (async () => '') as never)
    expect(await switchOffBlockedReason(tenant, 'elections')).toBe(GUARD_FAILED_REASON)
  })

  it('a guard registered after a throwing one is still asked only when the earlier ones passed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const second = vi.fn(async () => 'second')
    registerSwitchOffGuard('elections', async () => {
      throw new Error('boom')
    })
    registerSwitchOffGuard('elections', second)
    expect(await switchOffBlockedReason(tenant, 'elections')).toEqual(expect.any(String))
    expect(second).not.toHaveBeenCalled()
  })
})
