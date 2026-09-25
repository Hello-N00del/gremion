// src/lib/server/tenant/registry.platform-domain.test.ts
// TASK-032 (TRD-410 [D R20-D5]): addTenantDomain hands the deployment's
// PLATFORM_DOMAIN to tenant-domain.ts (the reserved-host refusal needs it).
// Under kit 3, `$env/dynamic/private` exposes only vars declared through the
// kit env schema, so an undeclared PLATFORM_DOMAIN read through it is always
// undefined, and mocking that module in a test no longer reaches the code.
// This pins the process.env read end to end: the value set in the process
// environment is the value tenant-domain.ts receives.
import { afterEach, describe, expect, it, vi } from 'vitest'

const { tdAdd } = vi.hoisted(() => ({ tdAdd: vi.fn(async () => ({ host: 'x' })) }))
vi.mock('./control-db', () => ({ getControlDb: () => ({ __control: true }) }))
vi.mock('./tenant-domain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tenant-domain')>()),
  addTenantDomain: tdAdd,
}))

import { addTenantDomain } from './registry'

const saved = process.env.PLATFORM_DOMAIN

afterEach(() => {
  if (saved === undefined) delete process.env.PLATFORM_DOMAIN
  else process.env.PLATFORM_DOMAIN = saved
  tdAdd.mockClear()
})

describe('addTenantDomain platformDomain (process.env.PLATFORM_DOMAIN)', () => {
  it('passes the process PLATFORM_DOMAIN through to tenant-domain.ts', async () => {
    process.env.PLATFORM_DOMAIN = 'platform.example'
    await addTenantDomain('00000000-0000-4000-8000-000000000001', 'council.example')
    expect(tdAdd).toHaveBeenCalledTimes(1)
    const deps = tdAdd.mock.calls[0]?.[4] as { platformDomain: string } | undefined
    expect(deps?.platformDomain).toBe('platform.example')
  })

  it('passes an empty string when PLATFORM_DOMAIN is unset', async () => {
    delete process.env.PLATFORM_DOMAIN
    await addTenantDomain('00000000-0000-4000-8000-000000000001', 'council.example')
    const deps = tdAdd.mock.calls[0]?.[4] as { platformDomain: string } | undefined
    expect(deps?.platformDomain).toBe('')
  })
})
