import { describe, it, expect, vi, beforeEach } from 'vitest'

const privateEnv: Record<string, string | undefined> = {}
vi.mock('$env/dynamic/private', () => ({ env: privateEnv }))

// A real connection is never opened: the pool is lazy and postgres() is stubbed.
const postgresMock = vi.fn((_url: string, _opts?: unknown) => ({ stub: true }))
vi.mock('postgres', () => ({ default: (url: string, opts?: unknown) => postgresMock(url, opts) }))

describe('council-db', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    delete privateEnv.PLATFORM_MODULES_DATABASE_URL
    const mod = await import('./council-db')
    mod._resetCouncilDbForTests()
  })

  it('throws CouncilNotConfigured when the URL is unset', async () => {
    const { getCouncilDb, CouncilNotConfigured } = await import('./council-db')
    expect(() => getCouncilDb()).toThrow(CouncilNotConfigured)
    expect(() => getCouncilDb()).toThrow('PLATFORM_MODULES_DATABASE_URL not configured')
    expect(postgresMock).not.toHaveBeenCalled()
  })

  it('treats an empty URL (compose passes "" when the password is unset) as not configured', async () => {
    privateEnv.PLATFORM_MODULES_DATABASE_URL = ''
    const { getCouncilDb, CouncilNotConfigured } = await import('./council-db')
    expect(() => getCouncilDb()).toThrow(CouncilNotConfigured)
  })

  it('returns the same client twice and opens exactly one small pool', async () => {
    privateEnv.PLATFORM_MODULES_DATABASE_URL = 'postgresql://gremion_ui_modules:pw@postgres-blue:5432/gremion_platform'
    const { getCouncilDb } = await import('./council-db')
    const a = getCouncilDb()
    const b = getCouncilDb()
    expect(a).toBe(b)
    expect(postgresMock).toHaveBeenCalledTimes(1)
    expect(postgresMock.mock.calls[0]![1]).toMatchObject({ max: 2 })
  })
})
