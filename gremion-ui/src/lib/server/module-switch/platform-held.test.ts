// platformHeldOffForCurrentTenant must fail closed on an unexpected error: only "no tenant context" means
// "nothing held"; any other failure is logged with context and rethrown, so a settings write is never
// judged against an empty held list because something broke.
import { afterEach, describe, expect, it, vi } from 'vitest'

const real = vi.hoisted(() => ({ getTenant: (() => undefined) as () => unknown, mock: undefined as unknown as ReturnType<typeof vi.fn> }))
vi.mock('$lib/server/tenant/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/tenant/context')>()
  real.getTenant = actual.getTenant
  real.mock = vi.fn(actual.getTenant)
  return { ...actual, getTenant: real.mock }
})

import { _clearPlatformHeldForTests, platformHeldOffForCurrentTenant, rememberPlatformHeld } from './platform-held'

afterEach(() => {
  _clearPlatformHeldForTests()
  vi.restoreAllMocks()
})

describe('platformHeldOffForCurrentTenant', () => {
  it('returns the held modules of the current tenant', () => {
    real.mock.mockReturnValueOnce({ id: 'tenant-1' })
    rememberPlatformHeld('tenant-1', 'board', true)
    expect(platformHeldOffForCurrentTenant()).toEqual(['board'])
  })

  it('returns nothing outside a tenant scope: the real getTenant error is recognised', () => {
    // no mock override: the real accessor's own no-context error (pins the wording platform-held.ts matches on)
    expect(() => real.getTenant()).toThrow('No tenant context')
    expect(platformHeldOffForCurrentTenant()).toEqual([])
  })

  it('rethrows any other error and logs it with context', () => {
    const boom = new Error('tenant registry unreachable')
    real.mock.mockImplementationOnce(() => {
      throw boom
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => platformHeldOffForCurrentTenant()).toThrow('tenant registry unreachable')
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]?.[0])).toContain('[module-switch]')
  })

  it('rethrows a non-Error throw too', () => {
    real.mock.mockImplementationOnce(() => {
      throw 'plain string'
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => platformHeldOffForCurrentTenant()).toThrow('plain string')
  })
})
