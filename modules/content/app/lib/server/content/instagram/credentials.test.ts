// @vitest-environment node
// Unit tests for the Instagram credentials seam — the disabled-by-default gate.
// `$env/dynamic/private` and resolveSecret are mocked so no real env/file is read.
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The mutable env the unit under test reads through `$env/dynamic/private`, plus
// the resolveSecret stub — both hoisted so the vi.mock factories can close over them.
const { envMock, mockResolveSecret } = vi.hoisted(() => ({
  envMock: {} as Record<string, string | undefined>,
  mockResolveSecret: vi.fn((ref: string) => `resolved:${ref}`),
}))
vi.mock('$env/dynamic/private', () => ({ env: envMock }))
vi.mock('$lib/server/tenant/secrets', () => ({ resolveSecret: (ref: string) => mockResolveSecret(ref) }))

import { resolveInstagramCredentials, isInstagramConfigured } from './credentials'

describe('resolveInstagramCredentials', () => {
  beforeEach(() => {
    for (const k of Object.keys(envMock)) delete envMock[k]
    mockResolveSecret.mockClear()
  })

  it('returns null when CONTENT_INSTAGRAM_TOKEN_REF is unset (disabled today)', async () => {
    expect(await resolveInstagramCredentials()).toBeNull()
    expect(mockResolveSecret).not.toHaveBeenCalled()
  })

  it('returns null (disabled) when only the token ref is set but the ig-user id is missing', async () => {
    envMock.CONTENT_INSTAGRAM_TOKEN_REF = 'env:META_TOKEN'
    // No CONTENT_INSTAGRAM_IG_USER_ID → still not configured.
    expect(await resolveInstagramCredentials()).toBeNull()
  })

  it('resolves the access token via resolveSecret and pairs it with the ig-user id when both are set', async () => {
    envMock.CONTENT_INSTAGRAM_TOKEN_REF = 'env:META_TOKEN'
    envMock.CONTENT_INSTAGRAM_IG_USER_ID = '17841400000000000'
    const creds = await resolveInstagramCredentials()
    expect(mockResolveSecret).toHaveBeenCalledWith('env:META_TOKEN')
    expect(creds).toEqual({ accessToken: 'resolved:env:META_TOKEN', igUserId: '17841400000000000' })
  })
})

describe('isInstagramConfigured', () => {
  beforeEach(() => {
    for (const k of Object.keys(envMock)) delete envMock[k]
    mockResolveSecret.mockClear()
  })

  it('is false when nothing is configured (disabled-by-default)', async () => {
    expect(await isInstagramConfigured()).toBe(false)
  })

  it('is true once both the token ref and ig-user id are present', async () => {
    envMock.CONTENT_INSTAGRAM_TOKEN_REF = 'env:META_TOKEN'
    envMock.CONTENT_INSTAGRAM_IG_USER_ID = '17841400000000000'
    expect(await isInstagramConfigured()).toBe(true)
  })
})
